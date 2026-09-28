/**
 * 静态资源白名单路由（/app.js、/app.css，UI 内联脚本/样式外置配套）的测试。
 *
 * 规则：仅 pathname 精确相等命中白名单，/app.js/、/app.js%00、/app.js/../ 等变形
 * 一律 404；文件缺失 404；响应携带契约 §14 冻结 CSP；Host/Origin 边界与静态页一致；
 * desktop 模式下静态资源与静态页同样不校验会话凭据（凭据仅约束 /api/*，契约 §4.6）。
 *
 * public/** 归 UI 工作流所有，测试通过工厂 options.staticRoot 注入临时目录，
 * 不向 public/ 写入任何文件。
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

function request(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        text: () => Buffer.concat(chunks).toString('utf-8')
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 创建带 app.js/app.css 的临时静态根目录并启动实例。 */
async function startServer({ withFiles = true, extraOptions = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-lens-static-'));
  tempRoots.push(root);
  const configDir = path.join(root, 'config');
  const staticRoot = path.join(root, 'static');
  await fs.mkdir(staticRoot);
  if (withFiles) {
    await fs.writeFile(path.join(staticRoot, 'app.js'), 'console.log("git-lens-app");');
    await fs.writeFile(path.join(staticRoot, 'app.css'), 'body { color: initial; }');
  }
  const instance = createGitLensServer({ configDir, port: 0, staticRoot, ...extraOptions });
  const { port } = await instance.ready;
  return { instance, port };
}

test('静态资源：200 且 MIME 正确，内容一致并携带冻结 CSP', async t => {
  const { instance, port } = await startServer();
  t.after(() => instance.close());
  const expectedCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'";

  const js = await request(port, '/app.js');
  assert.equal(js.status, 200);
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(js.text(), 'console.log("git-lens-app");');
  assert.equal(js.headers['content-security-policy'], expectedCsp);

  const css = await request(port, '/app.css');
  assert.equal(css.status, 200);
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
  assert.equal(css.text(), 'body { color: initial; }');
  assert.equal(css.headers['content-security-policy'], expectedCsp);
  await instance.close();
});

test('静态资源：文件缺失返回 404（含 public 尚未提供 app.js 的形态）', async t => {
  const { instance, port } = await startServer({ withFiles: false });
  t.after(() => instance.close());
  const missing = await request(port, '/app.js');
  assert.equal(missing.status, 404);
  assert.equal((await request(port, '/app.css')).status, 404);
  await instance.close();
});

test('静态资源：路径变形一律 404，不得命中白名单', async t => {
  const { instance, port } = await startServer();
  t.after(() => instance.close());
  for (const requestPath of ['/app.js/', '/app.js%00', '/app.js%2e%2e/', '/app.js/../index.html', '/APP.JS', '/app.js/x', '//app.js']) {
    const res = await request(port, requestPath);
    assert.equal(res.status, 404, `${requestPath} 应返回 404，实际 ${res.status}`);
  }
  await instance.close();
});

test('静态资源：desktop 模式不校验凭据（与静态页策略一致），错误 Host 仍被拒绝', async t => {
  const { instance, port } = await startServer({
    extraOptions: { mode: 'desktop', sessionToken: 'secret-token' }
  });
  t.after(() => instance.close());

  // 凭据仅约束 /api/*（契约 §4.6）；静态资源与静态页保持同一策略，无 token 也可加载
  const noToken = await request(port, '/app.js');
  assert.equal(noToken.status, 200);
  assert.equal(noToken.text(), 'console.log("git-lens-app");');

  // 但 Host/Origin 访问边界对静态资源与所有响应一致生效
  const evilHost = await request(port, '/app.js', { Host: 'evil.example.com' });
  assert.equal(evilHost.status, 403);
  const evilOrigin = await request(port, '/app.js', { Origin: 'http://evil.example.com' });
  assert.equal(evilOrigin.status, 403);
  await instance.close();
});

test('静态资源：browser 模式带 Origin 的本机同源请求照常放行', async t => {
  const { instance, port } = await startServer();
  t.after(() => instance.close());
  const sameOrigin = await request(port, '/app.js', { Origin: `http://127.0.0.1:${port}` });
  assert.equal(sameOrigin.status, 200);
  await instance.close();
});
