import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  FORBIDDEN_PORT,
  GUARD_ERROR_CODES,
  assertPathInsideRoot,
  assertPathNotUnderRealConfig,
  parseAndValidateBaseUrl,
  performHandshake
} from '../scripts/qa/guard.mjs';

/** 在 /tmp 下创建一次性根目录，测试结束自动清理（不触碰真实配置与 9527） */
async function makeTempRoot(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return root;
}

/** 启动仅用于握手单测的迷你 HTTP 服务（系统分配随机端口，用完即关） */
async function startHandshakeServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let { port } = server.address();
  // 撞上保留端口的概率约等于零，但 fail-closed 原则下宁可重绑也不能让单测触碰 9527
  if (port === FORBIDDEN_PORT) {
    await new Promise((resolve) => server.close(resolve));
    return startHandshakeServer(handler);
  }
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

test('守卫：合法 base-url（127.0.0.1 高位端口）被接受并规范化', () => {
  const result = parseAndValidateBaseUrl('http://127.0.0.1:9528');
  assert.deepEqual(result, { host: '127.0.0.1', port: 9528, baseUrl: 'http://127.0.0.1:9528' });
});

test('守卫：拒绝保留端口 9527', () => {
  assert.throws(() => parseAndValidateBaseUrl('http://127.0.0.1:9527'), (err) => {
    assert.equal(err.code, GUARD_ERROR_CODES.INVALID_BASE_URL);
    assert.match(err.message, /9527/);
    return true;
  });
});

test('守卫：拒绝 localhost 等非 127.0.0.1 主机名', () => {
  for (const url of [
    'http://localhost:9528',
    'http://LOCALHOST:9528',
    'http://example.com:8080',
    'http://0.0.0.0:9528',
    'http://[::1]:9528',
    'http://127.0.0.2:9528'
  ]) {
    assert.throws(() => parseAndValidateBaseUrl(url), (err) => {
      assert.equal(err.code, GUARD_ERROR_CODES.INVALID_BASE_URL);
      assert.match(err.message, /127\.0\.0\.1/);
      return true;
    }, `应拒绝: ${url}`);
  }
});

test('守卫：拒绝带路径、查询、hash、凭据的 base-url', () => {
  for (const url of [
    'http://127.0.0.1:9528/api',
    'http://127.0.0.1:9528/',
    'http://127.0.0.1:9528/api/projects',
    'http://127.0.0.1:9528?x=1',
    'http://127.0.0.1:9528#frag',
    'http://user@127.0.0.1:9528',
    'http://user:pass@127.0.0.1:9528'
  ]) {
    assert.throws(() => parseAndValidateBaseUrl(url), (err) => err.code === GUARD_ERROR_CODES.INVALID_BASE_URL,
      `应拒绝: ${url}`);
  }
});

test('守卫：拒绝缺端口、非法端口、非 http 协议与空值', () => {
  for (const url of [
    'http://127.0.0.1',
    'http://127.0.0.1:0',
    'http://127.0.0.1:99999',
    'http://127.0.0.1:abc',
    'https://127.0.0.1:9528',
    'ftp://127.0.0.1:9528',
    '9528',
    '',
    '   ',
    null,
    undefined
  ]) {
    assert.throws(() => parseAndValidateBaseUrl(url), (err) => err.code === GUARD_ERROR_CODES.INVALID_BASE_URL,
      `应拒绝: ${String(url)}`);
  }
  // 前后空白字符也会被拒绝（防止静默 trim 后放行形似合法的输入）
  assert.throws(() => parseAndValidateBaseUrl(' http://127.0.0.1:9528'), (err) => err.code === GUARD_ERROR_CODES.INVALID_BASE_URL);
  assert.throws(() => parseAndValidateBaseUrl('http://127.0.0.1:9528 '), (err) => err.code === GUARD_ERROR_CODES.INVALID_BASE_URL);
});

test('守卫：assertPathInsideRoot 接受 qa-root 内路径（含根自身）', async () => {
  const root = await makeTempRoot('qa-guard-inside-');
  try {
    const sub = path.join(root, 'config');
    await fs.mkdir(sub);
    const realSub = await assertPathInsideRoot(sub, root);
    assert.equal(realSub, await fs.realpath(sub));
    assert.equal(await assertPathInsideRoot(root, root), await fs.realpath(root));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('守卫：assertPathInsideRoot 拒绝空值与相对路径', async () => {
  const root = await makeTempRoot('qa-guard-rel-');
  try {
    await assert.rejects(() => assertPathInsideRoot('', root), (err) => err.code === GUARD_ERROR_CODES.PATH_ESCAPED);
    await assert.rejects(() => assertPathInsideRoot(null, root), (err) => err.code === GUARD_ERROR_CODES.PATH_ESCAPED);
    await assert.rejects(() => assertPathInsideRoot('config/sub', root), (err) => err.code === GUARD_ERROR_CODES.PATH_ESCAPED);
    // 相对路径 .. 逃逸形态同样拒绝
    await assert.rejects(() => assertPathInsideRoot(path.join(root, 'sub', '..', '..', 'outside'), root),
      (err) => err.code === GUARD_ERROR_CODES.PATH_ESCAPED);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('守卫：assertPathInsideRoot 拒绝 qa-root 外路径', async () => {
  const root = await makeTempRoot('qa-guard-outside-root-');
  const outside = await makeTempRoot('qa-guard-outside-target-');
  try {
    await assert.rejects(() => assertPathInsideRoot(outside, root), (err) => err.code === GUARD_ERROR_CODES.PATH_ESCAPED);
    // 待校验路径不存在时 fail-closed 拒绝
    await assert.rejects(() => assertPathInsideRoot(path.join(root, 'no-such-dir'), root),
      (err) => err.code === GUARD_ERROR_CODES.PATH_ESCAPED);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('守卫：assertPathInsideRoot 拒绝 symlink 逃逸（指向 /tmp 内外均拒绝）', async () => {
  const root = await makeTempRoot('qa-guard-symlink-');
  const outsideInTmp = await makeTempRoot('qa-guard-symlink-target-');
  try {
    const linkInTmp = path.join(root, 'escape-link-tmp');
    await fs.symlink(outsideInTmp, linkInTmp);
    await assert.rejects(() => assertPathInsideRoot(linkInTmp, root), (err) => err.code === GUARD_ERROR_CODES.PATH_ESCAPED);

    // 指向 /tmp 之外（用户主目录）的符号链接同样必须被拒
    const linkOutsideTmp = path.join(root, 'escape-link-home');
    await fs.symlink(os.homedir(), linkOutsideTmp);
    await assert.rejects(() => assertPathInsideRoot(linkOutsideTmp, root), (err) => err.code === GUARD_ERROR_CODES.PATH_ESCAPED);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outsideInTmp, { recursive: true, force: true });
  }
});

test('守卫：assertPathNotUnderRealConfig 拒绝真实配置目录及其子路径（注入假 home 验证）', async () => {
  const fakeHome = await makeTempRoot('qa-guard-fake-home-');
  const realConfig = path.join(fakeHome, '.config', 'git-lens-web');
  await fs.mkdir(realConfig, { recursive: true });
  const insideRealConfig = path.join(realConfig, 'merge-requests');
  await fs.mkdir(insideRealConfig);
  try {
    await assert.rejects(() => assertPathNotUnderRealConfig(realConfig, { home: fakeHome }),
      (err) => err.code === GUARD_ERROR_CODES.REAL_CONFIG_PATH);
    await assert.rejects(() => assertPathNotUnderRealConfig(insideRealConfig, { home: fakeHome }),
      (err) => err.code === GUARD_ERROR_CODES.REAL_CONFIG_PATH);

    // 经 symlink 指向真实配置也必须被拒
    const outside = await makeTempRoot('qa-guard-realconfig-other-');
    try {
      const link = path.join(outside, 'link-to-real-config');
      await fs.symlink(realConfig, link);
      await assert.rejects(() => assertPathNotUnderRealConfig(link, { home: fakeHome }),
        (err) => err.code === GUARD_ERROR_CODES.REAL_CONFIG_PATH);

      // 正常 qa-root 路径放行
      const qaConfig = path.join(outside, 'config');
      await fs.mkdir(qaConfig);
      assert.equal(await assertPathNotUnderRealConfig(qaConfig, { home: fakeHome }), await fs.realpath(qaConfig));
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(fakeHome, { recursive: true, force: true });
  }
});

test('守卫：performHandshake 接受 runId/configDir 完全一致的 200 响应', async () => {
  const root = await makeTempRoot('qa-guard-hs-ok-');
  const configDir = path.join(root, 'config');
  await fs.mkdir(configDir);
  const payload = { ok: true, runId: 'qa-run-1', configDir: await fs.realpath(configDir), host: '127.0.0.1', port: 19528, pid: process.pid };
  const server = await startHandshakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  try {
    const body = await performHandshake(server.baseUrl, { runId: 'qa-run-1', configDir });
    assert.equal(body.runId, 'qa-run-1');
    assert.equal(body.port, 19528);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('守卫：performHandshake 对 404 报「Runtime 契约未就绪」专用错误码', async () => {
  const root = await makeTempRoot('qa-guard-hs-404-');
  const configDir = path.join(root, 'config');
  await fs.mkdir(configDir);
  const server = await startHandshakeServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });
  try {
    await assert.rejects(() => performHandshake(server.baseUrl, { runId: 'qa-run-1', configDir }), (err) => {
      assert.equal(err.code, GUARD_ERROR_CODES.HANDSHAKE_NOT_READY);
      assert.match(err.message, /Runtime 契约未就绪/);
      return true;
    });
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('守卫：performHandshake 拒绝 runId/configDir 不一致（疑似误连其他实例）', async () => {
  const root = await makeTempRoot('qa-guard-hs-mismatch-');
  const configDir = path.join(root, 'config');
  await fs.mkdir(configDir);
  const realConfigDir = await fs.realpath(configDir);
  const server = await startHandshakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, runId: 'qa-other-run', configDir: '/tmp/some-other-config', host: '127.0.0.1', port: 19528, pid: 1 }));
  });
  try {
    await assert.rejects(() => performHandshake(server.baseUrl, { runId: 'qa-run-1', configDir }), (err) => {
      assert.equal(err.code, GUARD_ERROR_CODES.HANDSHAKE_MISMATCH);
      assert.match(err.message, /runId 不一致/);
      return true;
    });

    const server2 = await startHandshakeServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, runId: 'qa-run-1', configDir: '/tmp/some-other-config', host: '127.0.0.1', port: 19528, pid: 1 }));
    });
    try {
      await assert.rejects(() => performHandshake(server2.baseUrl, { runId: 'qa-run-1', configDir }), (err) => {
        assert.equal(err.code, GUARD_ERROR_CODES.HANDSHAKE_MISMATCH);
        assert.match(err.message, /configDir 不一致/);
        return true;
      });
    } finally {
      await server2.close();
    }
    assert.ok(realConfigDir);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('守卫：performHandshake 拒绝非 200/非 JSON/缺 ok 的响应', async () => {
  const root = await makeTempRoot('qa-guard-hs-bad-');
  const configDir = path.join(root, 'config');
  await fs.mkdir(configDir);

  const server500 = await startHandshakeServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('boom');
  });
  try {
    await assert.rejects(() => performHandshake(server500.baseUrl, { runId: 'r', configDir }),
      (err) => err.code === GUARD_ERROR_CODES.HANDSHAKE_BAD_STATUS);
  } finally {
    await server500.close();
  }

  const serverText = await startHandshakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('not json');
  });
  try {
    await assert.rejects(() => performHandshake(serverText.baseUrl, { runId: 'r', configDir }),
      (err) => err.code === GUARD_ERROR_CODES.HANDSHAKE_BAD_BODY);
  } finally {
    await serverText.close();
  }

  const serverNoOk = await startHandshakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ runId: 'r' }));
  });
  try {
    await assert.rejects(() => performHandshake(serverNoOk.baseUrl, { runId: 'r', configDir }),
      (err) => err.code === GUARD_ERROR_CODES.HANDSHAKE_BAD_BODY);
  } finally {
    await serverNoOk.close();
  }
  await fs.rm(root, { recursive: true, force: true });
});

test('守卫：performHandshake 入口处拒绝 9527 与非法 base-url（不发请求）', async () => {
  // 不需要真实服务：内部 base-url 守卫必须先于网络请求生效
  await assert.rejects(() => performHandshake(`http://127.0.0.1:${FORBIDDEN_PORT}`, { runId: 'r', configDir: os.tmpdir() }),
    (err) => err.code === GUARD_ERROR_CODES.INVALID_BASE_URL);
  await assert.rejects(() => performHandshake('http://localhost:9528', { runId: 'r', configDir: os.tmpdir() }),
    (err) => err.code === GUARD_ERROR_CODES.INVALID_BASE_URL);
});

test('守卫：performHandshake 缺少 runId/configDir 时拒绝', async () => {
  await assert.rejects(() => performHandshake('http://127.0.0.1:19528', { runId: '', configDir: os.tmpdir() }),
    (err) => err.code === GUARD_ERROR_CODES.MISSING_ARGUMENT);
  await assert.rejects(() => performHandshake('http://127.0.0.1:19528', { runId: 'r', configDir: '' }),
    (err) => err.code === GUARD_ERROR_CODES.MISSING_ARGUMENT);
});

test('守卫：performHandshake 对不可达服务报 HANDSHAKE_UNREACHABLE', async () => {
  // 使用保留给文档示例的高位端口上几乎必然无人监听的端口做「连接被拒」验证
  const server = await startHandshakeServer(() => {});
  const { port } = server;
  await server.close();
  await assert.rejects(() => performHandshake(`http://127.0.0.1:${port}`, { runId: 'r', configDir: os.tmpdir(), timeoutMs: 2000 }),
    (err) => err.code === GUARD_ERROR_CODES.HANDSHAKE_UNREACHABLE);
});
