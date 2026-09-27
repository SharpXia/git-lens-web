/**
 * GET /api/diagnostics（契约 §7）的测试。
 *
 * 覆盖三种 git 探测形态：git 存在（found:true + 版本）、git 不存在（found:false、
 * path/version 为 null、ok 仍为 true 不抛 500）、GIT_LENS_GIT_PATH 指向无效路径
 * （子进程环境变量形态）。另覆盖探测超时与响应字段结构。
 * 全部 fixture 在 /tmp 下 mkdtemp 自建，绝不触碰真实配置与 9527。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

import { configureGitPath, getGitPath, getGitDiagnostics } from '../src/git-inspector.js';
import { createGitLensServer } from '../src/git-lens-server.js';

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

function request(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), json: () => JSON.parse(Buffer.concat(chunks).toString('utf-8')) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 在随机端口启动 browser 模式实例。 */
async function startServer(extraOptions = {}) {
  const configDir = await makeTempDir('git-lens-diag-config-');
  const instance = createGitLensServer({ configDir, port: 0, ...extraOptions });
  const { port } = await instance.ready;
  return { instance, port, configDir };
}

test('diagnostics：git 存在时返回注入链路径与版本，configDir 为 realpath', async t => {
  const { instance, port, configDir } = await startServer();
  t.after(() => instance.close());

  const res = await request(port, '/api/diagnostics');
  assert.equal(res.status, 200);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.git.found, true);
  assert.equal(payload.git.path, getGitPath(), 'path 必须是业务调用同一解析链的最终 git 路径');
  assert.ok(payload.git.version && /\d+\.\d+/.test(payload.git.version), `版本应为可读字符串，实际：${payload.git.version}`);
  assert.ok(!/^git version/.test(payload.git.version), '版本不应重复 "git version" 前缀');
  assert.equal(payload.configDir, await fs.realpath(configDir));
  assert.equal(payload.platform, process.platform);
  assert.equal(payload.node, process.version);
  await instance.close();
});

test('diagnostics：git 路径不存在时 found:false、path/version 为 null、ok 仍为 true', async t => {
  const previous = getGitPath();
  try {
    configureGitPath(path.join(os.tmpdir(), 'no-such-git-binary-xyz'));
    const unit = await getGitDiagnostics();
    assert.deepEqual(unit, { found: false, path: null, version: null });

    // HTTP 层：诊断接口不因 git 缺失抛 500
    const { instance, port } = await startServer();
    t.after(() => instance.close());
    const res = await request(port, '/api/diagnostics');
    assert.equal(res.status, 200);
    const payload = res.json();
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.git, { found: false, path: null, version: null });
    await instance.close();
  } finally {
    configureGitPath(previous);
  }
});

test('diagnostics：GIT_LENS_GIT_PATH 指向无效路径时 CLI 实例同样降级不抛 500', async t => {
  const root = await makeTempDir('git-lens-diag-cli-');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: '0',
      GIT_LENS_CONFIG_DIR: path.join(root, 'config'),
      GIT_LENS_GIT_PATH: path.join(root, 'no-such', 'git'),
      GIT_LENS_TEST_MODE: '1',
      GIT_LENS_TEST_RUN_ID: 'diag-run-001'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdoutChunks = [];
  child.stdout.on('data', chunk => stdoutChunks.push(chunk));
  child.stderr.on('data', chunk => stdoutChunks.push(chunk));
  t.after(() => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  }));

  let port = 0;
  for (let attempt = 0; attempt < 200 && !port; attempt += 1) {
    const match = stdoutChunks.join('').match(/Git Lens Web running on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) port = Number(match[1]);
    else await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(port > 0, `CLI 应正常启动（git 缺失不阻断服务），输出：${stdoutChunks.join('')}`);

  const res = await request(port, '/api/diagnostics');
  assert.equal(res.status, 200);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.git, { found: false, path: null, version: null });
  await new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  });
});

test('diagnostics：git --version 超时按未找到处理（超时阈值可注入）', async () => {
  const previous = getGitPath();
  const slowBin = path.join(os.tmpdir(), `git-lens-slow-git-${process.pid}.sh`);
  tempRoots.push(slowBin);
  // 伪 git：只 sleep 不退出，验证探测超时路径
  await fs.writeFile(slowBin, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  try {
    configureGitPath(slowBin);
    const startedAt = Date.now();
    const unit = await getGitDiagnostics(300);
    const elapsed = Date.now() - startedAt;
    assert.deepEqual(unit, { found: false, path: null, version: null });
    assert.ok(elapsed < 2000, `超时应约 300ms 返回，实际 ${elapsed}ms`);
  } finally {
    configureGitPath(previous);
  }
});
