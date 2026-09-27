/**
 * 服务工厂（src/git-lens-server.js）与访问边界的回归测试。
 *
 * 覆盖：工厂导入零副作用、port:0 返回真实端口、close 幂等与 EADDRINUSE 中文报错、
 * 测试握手接口的开/关与 runId 一致性、Host/Origin/会话凭据各拒绝路径、
 * 413/415 请求体校验、browser 模式同源请求照常工作、CLI（npm start）语义不变。
 *
 * 全部测试使用 fs.mkdtemp 临时目录 + 私有 GIT_LENS_CONFIG_DIR + port 0（系统分配），
 * 绝不触碰 9527 端口与真实配置；结束后统一清理并断言无残留监听。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

import { createGitLensServer, chooseScanDirectory } from '../src/git-lens-server.js';

/** 仓库根目录（CLI 子进程的 cwd） */
const repoRoot = path.resolve(import.meta.dirname, '..');

/** 所有临时目录，测试结束后统一删除 */
const tempRoots = [];

after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  // 隔离证明：本测试进程内不允许残留任何监听中的 TCP 服务
  const active = process.getActiveResourcesInfo();
  assert.equal(
    active.filter(name => name === 'TCPServerWrap').length, 0,
    `测试结束后应无残留监听，实际活动资源：${[...new Set(active)].join(',')}`
  );
});

/** 创建本轮测试专用临时目录。 */
async function makeTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/**
 * 向指定端口发送 HTTP 请求并收集完整响应。
 * 未显式给 Host 头时 Node 会自动生成 Host: 127.0.0.1:<port>，与本机同源一致。
 * @param {number} port - 目标端口
 * @param {object} [options] - method/path/headers/body
 * @returns {Promise<{status: number, headers: object, body: Buffer, json: () => any}>}
 */
function request(port, { method = 'GET', path: requestPath = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: buffer,
          json: () => JSON.parse(buffer.toString('utf-8'))
        });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/**
 * 在随机端口启动一个 browser 模式服务实例并等待就绪。
 * @param {object} [extraOptions] - 追加工厂参数（mode/sessionToken/handshake 等）
 * @returns {Promise<{instance: object, port: number, cleanup: () => Promise<void>}>}
 */
async function startBrowserServer(extraOptions = {}) {
  const configDir = await makeTempDir('git-lens-factory-config-');
  const instance = createGitLensServer({ configDir, port: 0, ...extraOptions });
  const { port } = await instance.ready;
  return {
    instance,
    port,
    cleanup: async () => {
      await instance.close();
      // 临时目录由顶层 after 统一清理
    }
  };
}

test('工厂模块导入零副作用：不创建监听、不读配置', async () => {
  // 动态 import 触发模块加载；若模块像旧 server.js 一样在导入时监听，
  // 当前进程会出现 TCPServerWrap 资源
  const mod = await import('../src/git-lens-server.js');
  assert.equal(typeof mod.createGitLensServer, 'function');
  const active = process.getActiveResourcesInfo();
  assert.equal(
    active.filter(name => name === 'TCPServerWrap').length, 0,
    `导入工厂模块不应产生监听中的 TCP Server，实际活动资源：${[...new Set(active)].join(',')}`
  );
});

test('工厂参数校验：缺 configDir、非法 mode、desktop 缺 sessionToken 均拒绝', () => {
  assert.throws(() => createGitLensServer({}), /configDir 必须为非空字符串/);
  assert.throws(() => createGitLensServer({ configDir: '/tmp/x', mode: 'electron' }), /mode 只支持/);
  assert.throws(
    () => createGitLensServer({ configDir: '/tmp/x', mode: 'desktop' }),
    /desktop 模式必须提供 sessionToken/
  );
});

test('port:0 由系统分配随机端口，ready 返回真实 host/port', async t => {
  const { instance, port, cleanup } = await startBrowserServer();
  t.after(cleanup);
  assert.ok(Number.isInteger(port) && port > 0, `应返回真实端口，实际：${port}`);
  assert.notEqual(port, 9527, '随机端口不得命中主实例端口 9527');
  const probe = await request(port, { path: '/api/projects' });
  assert.equal(probe.status, 200);
  assert.equal(probe.json().ok, true);
  await instance.close();
});

test('EADDRINUSE 使 ready reject 且错误信息为中文', async t => {
  const first = await startBrowserServer();
  t.after(first.cleanup);
  const configDir = await makeTempDir('git-lens-factory-conflict-');
  const second = createGitLensServer({ configDir, port: first.port });
  await assert.rejects(
    second.ready,
    err => {
      assert.match(err.message, /端口 \d+ 已被占用/);
      return true;
    }
  );
  await second.close();
  await first.instance.close();
});

test('close 幂等：重复调用 resolve 同一结果，关闭后端口可立即重新绑定', async t => {
  const { instance, port, cleanup } = await startBrowserServer();
  t.after(cleanup);
  const firstClose = instance.close();
  await firstClose;
  await instance.close(); // 第二次调用必须正常 resolve，不得抛错或挂起
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(port, '127.0.0.1', resolve));
  await new Promise(resolve => probe.close(resolve));
});

test('browser 模式：静态首页与同源 API 照常工作，配置写入专用目录', async t => {
  const { instance, port, cleanup } = await startBrowserServer();
  t.after(cleanup);

  const home = await request(port, { path: '/' });
  assert.equal(home.status, 200);
  assert.match(home.headers['content-type'], /text\/html/);

  const save = await request(port, {
    method: 'POST',
    path: '/api/scan-directories',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directories: [os.tmpdir()] })
  });
  assert.equal(save.status, 200);
  assert.deepEqual(save.json().customDirectories, [path.resolve(os.tmpdir())]);
  await instance.close();
});

test('Host 校验：非本机主机名或端口不符一律 403', async t => {
  const { instance, port, cleanup } = await startBrowserServer();
  t.after(cleanup);

  const evilHost = await request(port, { path: '/api/projects', headers: { Host: 'evil.example.com' } });
  assert.equal(evilHost.status, 403);
  assert.match(evilHost.json().error, /Host 头不是本机地址/);

  const wrongPort = await request(port, { path: '/api/projects', headers: { Host: `127.0.0.1:${port + 1}` } });
  assert.equal(wrongPort.status, 403);

  const localhost = await request(port, { path: '/api/projects', headers: { Host: `localhost:${port}` } });
  assert.equal(localhost.status, 200);

  const loopback = await request(port, { path: '/api/projects', headers: { Host: `127.0.0.1:${port}` } });
  assert.equal(loopback.status, 200);
  await instance.close();
});

test('Origin 校验：跨站与 null 拒绝、本机来源放行、预检仅同源 204', async t => {
  const { instance, port, cleanup } = await startBrowserServer();
  t.after(cleanup);

  const crossSite = await request(port, { path: '/api/projects', headers: { Origin: 'http://evil.example.com' } });
  assert.equal(crossSite.status, 403);
  assert.match(crossSite.json().error, /请求来源不在本机允许列表内/);

  const nullOrigin = await request(port, { path: '/api/projects', headers: { Origin: 'null' } });
  assert.equal(nullOrigin.status, 403);

  const loopbackOrigin = await request(port, { path: '/api/projects', headers: { Origin: `http://127.0.0.1:${port}` } });
  assert.equal(loopbackOrigin.status, 200);

  const localhostOrigin = await request(port, { path: '/api/projects', headers: { Origin: `http://localhost:${port}` } });
  assert.equal(localhostOrigin.status, 200);

  // 不带 Origin 的同源调用照常放行
  const noOrigin = await request(port, { path: '/api/projects' });
  assert.equal(noOrigin.status, 200);

  // 宽松 CORS 已移除：普通响应不得再携带 Access-Control-Allow-Origin: *
  assert.notEqual(noOrigin.headers['access-control-allow-origin'], '*');

  const preflightAllowed = await request(port, {
    method: 'OPTIONS', path: '/api/projects', headers: { Origin: `http://127.0.0.1:${port}` }
  });
  assert.equal(preflightAllowed.status, 204);

  const preflightDenied = await request(port, {
    method: 'OPTIONS', path: '/api/projects', headers: { Origin: 'http://evil.example.com' }
  });
  assert.equal(preflightDenied.status, 403);
  await instance.close();
});

test('desktop 模式：/api 必须携带会话凭据，静态页不受限；browser 模式忽略凭据头', async t => {
  const desktop = await startBrowserServer({ mode: 'desktop', sessionToken: 'secret-token-123' });
  t.after(desktop.cleanup);

  const missing = await request(desktop.port, { path: '/api/projects' });
  assert.equal(missing.status, 403);
  assert.match(missing.json().error, /会话凭据/);

  const wrong = await request(desktop.port, { path: '/api/projects', headers: { 'X-Git-Lens-Session': 'bad' } });
  assert.equal(wrong.status, 403);

  const valid = await request(desktop.port, { path: '/api/projects', headers: { 'X-Git-Lens-Session': 'secret-token-123' } });
  assert.equal(valid.status, 200);

  // desktop 模式下凭据只约束 /api；静态首页无需 token
  const home = await request(desktop.port, { path: '/' });
  assert.equal(home.status, 200);
  await desktop.instance.close();

  // browser 模式忽略凭据头：带错误 token 也不影响同源访问
  const browser = await startBrowserServer();
  t.after(browser.cleanup);
  const withHeader = await request(browser.port, {
    path: '/api/projects', headers: { 'X-Git-Lens-Session': 'whatever' }
  });
  assert.equal(withHeader.status, 200);
  await browser.instance.close();
});

test('请求体校验：超限 413（中文）、非 JSON Content-Type 415', async t => {
  const { instance, port, cleanup } = await startBrowserServer({ requestBodyLimit: 32 });
  t.after(cleanup);

  const tooLarge = await request(port, {
    method: 'POST',
    path: '/api/scan-directories',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directories: ['x'.repeat(64)] })
  });
  assert.equal(tooLarge.status, 413);
  assert.match(tooLarge.json().error, /请求体超过大小限制/);

  const wrongType = await request(port, {
    method: 'POST',
    path: '/api/scan-directories',
    headers: { 'Content-Type': 'text/plain' },
    body: 'directories=/tmp'
  });
  assert.equal(wrongType.status, 415);
  assert.match(wrongType.json().error, /Content-Type 必须为 application\/json/);

  // 既有端点兼容：/api/choose-scan-directory 不消费请求体，允许不带 Content-Type 的 POST
  const dialog = await startBrowserServer({
    chooseScanDirectory: async () => null
  });
  t.after(dialog.cleanup);
  const noHeader = await request(dialog.port, { method: 'POST', path: '/api/choose-scan-directory' });
  assert.equal(noHeader.status, 200);
  assert.equal(noHeader.json().ok, true);
  await dialog.instance.close();
  await instance.close();
});

test('测试握手：test 模式 + runId 齐备才启用，缺一 404，响应字段齐全', async t => {
  const previous = process.env.GIT_LENS_TEST_MODE;
  process.env.GIT_LENS_TEST_MODE = '1';
  try {
    const configDir = await makeTempDir('git-lens-handshake-config-');
    const enabled = createGitLensServer({ configDir, port: 0, handshake: { runId: 'qa-run-001' } });
    t.after(() => enabled.close());
    const { port } = await enabled.ready;

    const handshake = await request(port, { path: '/api/test-handshake' });
    assert.equal(handshake.status, 200);
    const payload = handshake.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.runId, 'qa-run-001', 'runId 必须与工厂注入一致');
    assert.equal(payload.configDir, await fs.realpath(configDir), 'configDir 应为 realpath 后的目录');
    assert.equal(payload.host, '127.0.0.1');
    assert.equal(payload.port, port, 'port 必须是实际监听端口');
    assert.equal(payload.pid, process.pid);

    // 测试模式但工厂未注入 handshake：404
    const noHandshake = createGitLensServer({ configDir, port: 0 });
    t.after(() => noHandshake.close());
    const noHandshakePort = (await noHandshake.ready).port;
    assert.equal((await request(noHandshakePort, { path: '/api/test-handshake' })).status, 404);
    await noHandshake.close();
  } finally {
    if (previous === undefined) delete process.env.GIT_LENS_TEST_MODE;
    else process.env.GIT_LENS_TEST_MODE = previous;
  }

  // 有 handshake 但未开启测试模式：404（生产实例不可探测）
  const disabled = await startBrowserServer({ handshake: { runId: 'qa-run-002' } });
  t.after(disabled.cleanup);
  assert.equal((await request(disabled.port, { path: '/api/test-handshake' })).status, 404);
  await disabled.instance.close();
});

test('目录选择器注入：工厂优先使用注入实现而非系统对话框', async t => {
  const injected = await startBrowserServer({ chooseScanDirectory: async () => '/tmp/injected-dir' });
  t.after(injected.cleanup);
  const res = await request(injected.port, { method: 'POST', path: '/api/choose-scan-directory' });
  assert.equal(res.status, 200);
  assert.equal(res.json().directory, '/tmp/injected-dir');
  await injected.instance.close();
  // 缺省实现导出仍存在，供 CLI 与桌面壳复用
  assert.equal(typeof chooseScanDirectory, 'function');
});

test('CLI：PORT=0 时打印实际端口，同源 API 可用，默认消息格式不变', async t => {
  const root = await makeTempDir('git-lens-cli-smoke-');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: '0', GIT_LENS_CONFIG_DIR: path.join(root, 'config') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdoutChunks = [];
  child.stdout.on('data', chunk => stdoutChunks.push(chunk));
  child.stderr.on('data', chunk => stdoutChunks.push(chunk));
  t.after(() => new Promise(resolve => {
    // 信号终止的子进程 exitCode 为 null、signalCode 为 'SIGTERM'，两者都为空才算仍在运行，
    // 否则对已退出的进程等 'exit' 事件会永久挂起
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  }));

  let port = 0;
  for (let attempt = 0; attempt < 100 && !port; attempt += 1) {
    const text = Buffer.concat(stdoutChunks).toString('utf-8');
    const match = text.match(/Git Lens Web running on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) port = Number(match[1]);
    else await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(port > 0, `CLI 应打印实际监听端口，输出：${Buffer.concat(stdoutChunks).toString()}`);
  assert.notEqual(port, 9527);

  const projects = await request(port, { path: '/api/projects' });
  assert.equal(projects.status, 200);
  assert.equal(projects.json().ok, true);

  // 错误 Host 一样被 CLI 启动的实例拒绝（访问边界对两种启动方式一致生效）
  const rejected = await request(port, { path: '/api/projects', headers: { Host: 'evil.example.com' } });
  assert.equal(rejected.status, 403);

  // 先等子进程退出再结束测试，避免留下孤儿服务
  await new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  });
});
