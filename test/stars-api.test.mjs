/**
 * 仓库星标持久化端点（GET/POST /api/stars，契约 §16）回归测试。
 *
 * 覆盖：空列表读取（文件不存在不落盘）、POST 增/删/去重/保序、stars.json 落盘格式、
 * 参数校验 400（中文）、损坏文件容错（GET 视为空、POST 可重建并记 warn）、
 * 跨 configDir 隔离与同 configDir 互通（模拟 web/桌面两实例）、
 * 访问边界（desktop 无凭据 403、跨源 Origin 403、请求体超限 413）。
 *
 * 全部测试使用 fs.mkdtemp 临时目录 + port 0（系统分配），
 * 绝不触碰 9527 端口与真实配置；结束后统一清理并断言无残留监听。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createGitLensServer } from '../src/git-lens-server.js';

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
 * 在随机端口启动一个 browser 模式服务实例并等待就绪。
 * @param {string} configDir - 本实例专用配置目录
 * @param {object} [extraOptions] - 追加工厂参数（mode/sessionToken/log 等）
 * @returns {Promise<{instance: object, port: number}>}
 */
async function startServer(configDir, extraOptions = {}) {
  const instance = createGitLensServer({ configDir, port: 0, ...extraOptions });
  const { port } = await instance.ready;
  return { instance, port };
}

/**
 * 向指定端口发送 HTTP 请求并收集完整响应。
 * @param {number} port - 目标端口
 * @param {object} [options] - method/path/headers/body
 * @returns {Promise<{status: number, headers: object, json: () => any}>}
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
          json: () => JSON.parse(buffer.toString('utf-8'))
        });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/** POST /api/stars 的便捷封装（带 JSON Content-Type）。 */
function postStar(port, payload, headers = {}) {
  return request(port, {
    method: 'POST',
    path: '/api/stars',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload)
  });
}

test('GET /api/stars：stars.json 不存在时返回空列表且不创建文件', async t => {
  const configDir = await makeTempDir('glwt-stars-empty-');
  const { instance, port } = await startServer(configDir);
  t.after(() => instance.close());

  const res = await request(port, { path: '/api/stars' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { ok: true, starred: [] });
  await assert.rejects(fs.access(path.join(configDir, 'stars.json')), 'GET 不应创建 stars.json');
});

test('POST /api/stars：加星保序、重复加星去重、取消删星', async t => {
  const configDir = await makeTempDir('glwt-stars-crud-');
  const { instance, port } = await startServer(configDir);
  t.after(() => instance.close());

  // 依次加两个星：保持插入顺序
  const first = await postStar(port, { repoPath: '/repos/alpha', starred: true });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json(), { ok: true, starred: ['/repos/alpha'] });

  const second = await postStar(port, { repoPath: '/repos/beta', starred: true });
  assert.deepEqual(second.json().starred, ['/repos/alpha', '/repos/beta']);

  // 重复加星去重：列表不变（幂等）
  const dup = await postStar(port, { repoPath: '/repos/alpha', starred: true });
  assert.deepEqual(dup.json().starred, ['/repos/alpha', '/repos/beta']);

  // 取消星标：仅移除目标项，其余保序
  const remove = await postStar(port, { repoPath: '/repos/alpha', starred: false });
  assert.deepEqual(remove.json().starred, ['/repos/beta']);

  // 取消不存在的星标：列表不变（幂等），状态码仍 200
  const removeMissing = await postStar(port, { repoPath: '/repos/gamma', starred: false });
  assert.equal(removeMissing.status, 200);
  assert.deepEqual(removeMissing.json().starred, ['/repos/beta']);

  // 落盘文件格式符合契约：{"version":1,"starred":[...]}，且无临时文件残留
  const raw = JSON.parse(await fs.readFile(path.join(configDir, 'stars.json'), 'utf-8'));
  assert.deepEqual(raw, { version: 1, starred: ['/repos/beta'] });
  const dirEntries = await fs.readdir(configDir);
  assert.ok(dirEntries.every(name => !name.includes('.tmp-')), `不应残留临时文件，实际：${dirEntries.join(',')}`);
});

test('POST /api/stars：参数非法返回 400 中文错误', async t => {
  const configDir = await makeTempDir('glwt-stars-invalid-');
  const { instance, port } = await startServer(configDir);
  t.after(() => instance.close());

  const missingRepo = await postStar(port, { starred: true });
  assert.equal(missingRepo.status, 400);
  assert.match(missingRepo.json().error, /repoPath 必须为非空字符串/);

  const emptyRepo = await postStar(port, { repoPath: '   ', starred: true });
  assert.equal(emptyRepo.status, 400);
  assert.match(emptyRepo.json().error, /repoPath 必须为非空字符串/);

  const badStarred = await postStar(port, { repoPath: '/repos/alpha', starred: 'yes' });
  assert.equal(badStarred.status, 400);
  assert.match(badStarred.json().error, /starred 必须为布尔值/);

  // 非法请求不产生落盘文件
  await assert.rejects(fs.access(path.join(configDir, 'stars.json')));
});

test('stars.json 损坏：GET 容错返回空列表并记 warn，POST 可重建', async t => {
  const configDir = await makeTempDir('glwt-stars-corrupt-');
  const warnings = [];
  const { instance, port } = await startServer(configDir, {
    log: (level, message) => { if (level === 'warn') warnings.push(message); }
  });
  t.after(() => instance.close());

  await fs.writeFile(path.join(configDir, 'stars.json'), '{ "starred": [broken', 'utf-8');

  const get = await request(port, { path: '/api/stars' });
  assert.equal(get.status, 200, '损坏文件不应使 GET 抛 500');
  assert.deepEqual(get.json(), { ok: true, starred: [] });
  assert.equal(warnings.length, 1, '损坏文件应记一条 warn 日志');
  assert.match(warnings[0], /stars\.json 读取失败/);

  // POST 可从损坏状态重建合法文件
  const post = await postStar(port, { repoPath: '/repos/recovered', starred: true });
  assert.equal(post.status, 200);
  assert.deepEqual(post.json().starred, ['/repos/recovered']);
  const raw = JSON.parse(await fs.readFile(path.join(configDir, 'stars.json'), 'utf-8'));
  assert.deepEqual(raw, { version: 1, starred: ['/repos/recovered'] });

  // 结构异常（JSON 合法但 starred 非数组）同样按空列表处理
  warnings.length = 0;
  await fs.writeFile(path.join(configDir, 'stars.json'), '{"starred":"oops"}', 'utf-8');
  const badShape = await request(port, { path: '/api/stars' });
  assert.equal(badShape.status, 200);
  assert.deepEqual(badShape.json().starred, []);
});

test('跨 configDir 隔离：两个实例互不可见；同 configDir 双实例数据互通', async t => {
  // 模拟 web（configDir A）与桌面（configDir B）两实例
  const dirA = await makeTempDir('glwt-stars-web-');
  const dirB = await makeTempDir('glwt-stars-desktop-');
  const web = await startServer(dirA);
  const desktop = await startServer(dirB);
  t.after(() => web.instance.close());
  t.after(() => desktop.instance.close());

  await postStar(web.port, { repoPath: '/repos/only-web', starred: true });

  const webList = await request(web.port, { path: '/api/stars' });
  assert.deepEqual(webList.json().starred, ['/repos/only-web']);

  const desktopList = await request(desktop.port, { path: '/api/stars' });
  assert.deepEqual(desktopList.json().starred, [], '不同 configDir 的星标必须互不干扰');

  // 互通场景：两个实例指向同一 configDir（契约 §5 共享配置目录）时数据共享
  const dirShared = await makeTempDir('glwt-stars-shared-');
  const s1 = await startServer(dirShared);
  const s2 = await startServer(dirShared);
  t.after(() => s1.instance.close());
  t.after(() => s2.instance.close());

  await postStar(s1.port, { repoPath: '/repos/shared', starred: true });
  const fromS2 = await request(s2.port, { path: '/api/stars' });
  assert.deepEqual(fromS2.json().starred, ['/repos/shared'], '同 configDir 的另一实例应读到同一份星标');
});

test('访问边界：desktop 无凭据 403、跨源 Origin 403、请求体超限 413', async t => {
  const desktop = await startServer(await makeTempDir('glwt-stars-boundary-'), {
    mode: 'desktop', sessionToken: 'star-secret-token'
  });
  t.after(() => desktop.instance.close());

  // desktop 模式：/api/stars 与其他 /api 一样必须携带会话凭据
  const noToken = await request(desktop.port, { path: '/api/stars' });
  assert.equal(noToken.status, 403);
  assert.match(noToken.json().error, /会话凭据/);

  const withToken = await request(desktop.port, {
    path: '/api/stars', headers: { 'X-Git-Lens-Session': 'star-secret-token' }
  });
  assert.equal(withToken.status, 200);

  // browser 模式：跨源 Origin 403、超限请求体 413
  const browser = await startServer(await makeTempDir('glwt-stars-browser-'), { requestBodyLimit: 32 });
  t.after(() => browser.instance.close());

  const crossOrigin = await postStar(browser.port, { repoPath: '/repos/x', starred: true }, {
    Origin: 'http://evil.example.com'
  });
  assert.equal(crossOrigin.status, 403);
  assert.match(crossOrigin.json().error, /请求来源不在本机允许列表内/);

  const tooLarge = await postStar(browser.port, { repoPath: `/repos/${'x'.repeat(64)}`, starred: true });
  assert.equal(tooLarge.status, 413);
  assert.match(tooLarge.json().error, /请求体超过大小限制/);
});
