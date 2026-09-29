/**
 * 主工作区 Pull 端点（POST /api/worktree-pull，契约 §19）回归测试。
 *
 * 覆盖：mkdtemp 自建裸仓库 origin + clone 工作仓库的快进拉取成功（changed=true、
 * HEAD 前进）、重复拉取已最新（changed=false）、本地分叉时 --ff-only 拒绝
 * （ok=false 且 output 含「无法快进」中文修复提示）、无上游分支提示、
 * 缺参/非仓库路径 400（中文）、desktop 模式无会话凭据 403。
 *
 * 全部测试使用 fs.mkdtemp 临时目录 + port 0（系统分配），
 * 绝不触碰 9527 端口与真实配置；结束后统一清理并断言无残留监听。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createGitLensServer } from '../src/git-lens-server.js';

const execGit = promisify(execFile);

/** 测试内 git 调用的隔离环境：屏蔽全局/系统配置，注入本地提交身份 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: '测试用户',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: '测试用户',
  GIT_COMMITTER_EMAIL: 'test@example.com'
};

async function git(cwd, ...args) {
  await execGit('git', args, { cwd, env: GIT_ENV });
}

/** 读取指定仓库当前 HEAD 提交哈希。 */
async function headOf(repoPath) {
  const { stdout } = await execGit('git', ['rev-parse', 'HEAD'], { cwd: repoPath, env: GIT_ENV });
  return stdout.trim();
}

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
 * 构建拉取测试三件套：seed（推新提交的源仓库）→ origin.git（裸仓库作远程）→
 * work（被拉取的工作仓库，clone 时自动配置 main 的上游）。
 */
async function makeFixture(t) {
  const root = await makeTempDir('git-lens-worktree-pull-');
  const seed = path.join(root, 'seed');
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');

  await git(root, 'init', '-b', 'main', 'seed');
  await fs.writeFile(path.join(seed, 'tracked.txt'), 'base\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'base');
  await git(root, 'clone', '--bare', seed, 'origin.git');
  await git(seed, 'remote', 'add', 'origin', origin);
  await git(root, 'clone', origin, 'work');

  return { root, seed, origin, work };
}

/** 在 seed 中追加一个提交并推送到 origin，模拟远端前进。 */
async function pushNewCommit(seed, fileName, content) {
  await fs.writeFile(path.join(seed, fileName), content);
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', `add ${fileName}`);
  await git(seed, 'push', 'origin', 'main');
}

/**
 * 在随机端口启动一个 browser 模式服务实例并等待就绪。
 * @param {string} configDir - 本实例专用配置目录
 * @param {object} [extraOptions] - 追加工厂参数（mode/sessionToken/log 等）
 */
async function startServer(configDir, extraOptions = {}) {
  const instance = createGitLensServer({ configDir, port: 0, ...extraOptions });
  const { port } = await instance.ready;
  return { instance, port };
}

/**
 * 向指定端口发送 HTTP 请求并收集完整响应。
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

/** POST /api/worktree-pull 的便捷封装（带 JSON Content-Type）。 */
function postPull(port, payload, headers = {}) {
  return request(port, {
    method: 'POST',
    path: '/api/worktree-pull',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload)
  });
}

test('快进拉取成功：origin 新提交后 ok=true、changed=true、HEAD 前进', async t => {
  const { seed, work } = await makeFixture(t);
  const configDir = await makeTempDir('glwt-pull-ff-config-');
  const { instance, port } = await startServer(configDir);
  t.after(() => instance.close());

  const headBefore = await headOf(work);
  await pushNewCommit(seed, 'feature.txt', '远端新内容\n');

  const res = await postPull(port, { worktree: work });
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.changed, true, '远端前进后拉取应判定为有变化');
  assert.equal(body.exitCode, 0);
  assert.equal(typeof body.output, 'string');

  // HEAD 前进且与 origin（seed 推送后的 HEAD）对齐
  const headAfter = await headOf(work);
  assert.notEqual(headAfter, headBefore);
  assert.equal(headAfter, await headOf(seed));
  assert.equal(await fs.readFile(path.join(work, 'feature.txt'), 'utf8'), '远端新内容\n');
});

test('已最新：远端无新提交时 changed=false 且 HEAD 不动', async t => {
  const { work } = await makeFixture(t);
  const configDir = await makeTempDir('glwt-pull-uptodate-config-');
  const { instance, port } = await startServer(configDir);
  t.after(() => instance.close());

  const headBefore = await headOf(work);
  const res = await postPull(port, { worktree: work });
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.changed, false, '无新提交时不应判定为有变化');
  assert.equal(body.exitCode, 0);
  assert.equal(await headOf(work), headBefore);
});

test('本地分叉：--ff-only 拒绝，ok=false 且 output 含中文修复提示', async t => {
  const { seed, work } = await makeFixture(t);
  const configDir = await makeTempDir('glwt-pull-diverged-config-');
  const { instance, port } = await startServer(configDir);
  t.after(() => instance.close());

  // 本地分叉：work 上先落一个自己的提交
  await fs.writeFile(path.join(work, 'local.txt'), '本地提交\n');
  await git(work, 'add', '.');
  await git(work, 'commit', '-m', 'local commit');
  const headBefore = await headOf(work);
  // 远端同时前进，形成真正的分叉（仅本地领先时 --ff-only 仍可成功）
  await pushNewCommit(seed, 'remote.txt', '远端前进\n');

  // git 层失败按 200 + ok:false 语义返回（契约 §19：仅缺参/非仓库为 400）
  const res = await postPull(port, { worktree: work });
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.changed, false);
  assert.notEqual(body.exitCode, 0, '分叉失败应保留 git 非零退出码');
  assert.match(body.output, /无法快进：请先手动合并或变基后再拉取/);

  // 拒绝后现场不变：HEAD 仍停在本地分叉提交上
  assert.equal(await headOf(work), headBefore);
});

test('无上游分支：ok=false 且 output 含「没有配置上游分支」提示', async t => {
  const { work } = await makeFixture(t);
  const configDir = await makeTempDir('glwt-pull-noupstream-config-');
  const { instance, port } = await startServer(configDir);
  t.after(() => instance.close());

  // 新建分支不设上游，pull 时 git 报 no tracking information
  await git(work, 'checkout', '-b', 'feature');

  const res = await postPull(port, { worktree: work });
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.match(body.output, /该分支没有配置上游分支/);
});

test('参数校验：缺参与非仓库路径返回 400 中文错误', async t => {
  const { root, work } = await makeFixture(t);
  const configDir = await makeTempDir('glwt-pull-invalid-config-');
  const { instance, port } = await startServer(configDir);
  t.after(() => instance.close());

  const missing = await postPull(port, {});
  assert.equal(missing.status, 400);
  assert.match(missing.json().error, /worktree 必须为非空字符串/);

  const blank = await postPull(port, { worktree: '   ' });
  assert.equal(blank.status, 400);
  assert.match(blank.json().error, /worktree 必须为非空字符串/);

  const nonString = await postPull(port, { worktree: 123 });
  assert.equal(nonString.status, 400);
  assert.match(nonString.json().error, /worktree 必须为非空字符串/);

  // 普通目录（存在但非仓库）与不存在路径统一 400 中文
  const plainDir = path.join(root, 'plain-dir');
  await fs.mkdir(plainDir);
  const notRepo = await postPull(port, { worktree: plainDir });
  assert.equal(notRepo.status, 400);
  assert.match(notRepo.json().error, /不是 Git 仓库/);

  const missingPath = await postPull(port, { worktree: path.join(root, 'no-such-dir') });
  assert.equal(missingPath.status, 400);
  assert.match(missingPath.json().error, /不是 Git 仓库/);

  // 对照：合法参数在同实例上仍正常工作，证明 400 只源于参数本身
  const okPull = await postPull(port, { worktree: work });
  assert.equal(okPull.status, 200);
  assert.equal(okPull.json().ok, true);
});

test('访问边界：desktop 模式无会话凭据 403，携带凭据恢复可达', async t => {
  const { work } = await makeFixture(t);
  const desktop = await startServer(await makeTempDir('glwt-pull-desktop-config-'), {
    mode: 'desktop', sessionToken: 'pull-secret-token'
  });
  t.after(() => desktop.instance.close());

  const noToken = await postPull(desktop.port, { worktree: work });
  assert.equal(noToken.status, 403);
  assert.match(noToken.json().error, /会话凭据/);

  // 正向对照：带凭据后进入业务层（此请求到达参数校验，返回 400 而非 403）
  const withToken = await postPull(desktop.port, { worktree: work }, {
    'X-Git-Lens-Session': 'pull-secret-token'
  });
  assert.equal(withToken.status, 200);
  assert.equal(withToken.json().ok, true);
});
