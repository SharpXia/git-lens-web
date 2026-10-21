/**
 * 远端分支管理 API 路由（src/git-lens-server.js 第 13 组）的回归测试。
 *
 * 用 browser 模式服务工厂 + 本地裸远端 fixture，逐条验证路由接线与
 * statusCode 透传（400/404/409），并覆盖一条完整的「合并 → 冲突 → 解决 → 完成」
 * API 链路。全部使用 mkdtemp 临时目录与 port 0，不触碰真实配置与端口。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGitLensServer } from '../src/git-lens-server.js';

const execGit = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: '测试用户',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: '测试用户',
  GIT_COMMITTER_EMAIL: 'test@example.com'
};

const tempRoots = [];

after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  const active = process.getActiveResourcesInfo();
  assert.equal(
    active.filter(name => name === 'TCPServerWrap').length, 0,
    '测试结束后应无残留监听'
  );
});

async function git(cwd, ...args) {
  const { stdout } = await execGit('git', args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

/** 启动 browser 模式服务并返回请求辅助函数 */
async function startServer(t) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-lens-remote-api-config-'));
  tempRoots.push(configDir);
  const instance = createGitLensServer({ configDir, port: 0 });
  const { port } = await instance.ready;
  t.after(() => instance.close());
  const request = async (method, apiPath, body = null) => {
    const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json() };
  };
  return { request };
}

/**
 * 构建与 service 测试同构的 fixture：origin.git 裸远端 + seed 内容仓库 + repo 被测工作区。
 * repo 的本地 main 与远端 feature/remote-only 对同一行做了不同修改（冲突素材）。
 */
async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-lens-remote-api-'));
  tempRoots.push(root);

  const bare = path.join(root, 'origin.git');
  await git(root, 'init', '--bare', '-b', 'main', bare);
  const seed = path.join(root, 'seed');
  await execGit('git', ['clone', '-q', bare, seed], { env: GIT_ENV });
  await fs.writeFile(path.join(seed, 'shared.txt'), 'line: base\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'base: 初始内容');
  await git(seed, 'checkout', '-q', '-b', 'feature/remote-only');
  await fs.writeFile(path.join(seed, 'shared.txt'), 'line: remote\n');
  await git(seed, 'commit', '-am', 'remote: 修改共享行');
  await git(seed, 'push', '-q', 'origin', 'feature/remote-only');
  await git(seed, 'checkout', '-q', 'main');
  await git(seed, 'push', '-q', 'origin', 'main');

  const repoRaw = path.join(root, 'repo');
  await execGit('git', ['clone', '-q', bare, repoRaw], { env: GIT_ENV });
  const repo = await fs.realpath(repoRaw);
  await fs.writeFile(path.join(repo, 'shared.txt'), 'line: local\n');
  await git(repo, 'commit', '-am', 'local: 修改共享行');

  return { root, repo, bare };
}

test('GET /api/remote-branches 返回远端分支清单', async (t) => {
  const { request } = await startServer(t);
  const { repo } = await makeFixture(t);

  const res = await request('GET', `/api/remote-branches?path=${encodeURIComponent(repo)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.mainBranch, 'main');
  assert.ok(res.body.branches.some(b => b.name === 'origin/feature/remote-only'));

  // 无效仓库路径按既有惯例返回 400 中文错误
  const bad = await request('GET', `/api/remote-branches?path=${encodeURIComponent('/definitely/not/a/repo')}`);
  assert.equal(bad.status, 404);
});

test('POST /api/create-remote-branch 校验链与成功路径', async (t) => {
  const { request } = await startServer(t);
  const { repo, bare } = await makeFixture(t);

  const ok = await request('POST', '/api/create-remote-branch', {
    repoPath: repo, sourceRef: 'origin/main', newBranchName: 'feature/api-copy'
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(await git(bare, 'rev-parse', 'refs/heads/feature/api-copy'),
    await git(repo, 'rev-parse', 'origin/main'));

  const dup = await request('POST', '/api/create-remote-branch', {
    repoPath: repo, sourceRef: 'origin/main', newBranchName: 'feature/api-copy'
  });
  assert.equal(dup.status, 409);
  const invalid = await request('POST', '/api/create-remote-branch', {
    repoPath: repo, sourceRef: 'origin/main', newBranchName: '-evil'
  });
  assert.equal(invalid.status, 400);
});

test('POST /api/checkout-branch 校验与检出远端分支重命名', async (t) => {
  const { request } = await startServer(t);
  const { repo } = await makeFixture(t);

  const badType = await request('POST', '/api/checkout-branch', {
    repoPath: repo, worktree: repo, refType: 'weird', ref: 'x'
  });
  assert.equal(badType.status, 400);

  const ok = await request('POST', '/api/checkout-branch', {
    repoPath: repo, worktree: repo, refType: 'remote', ref: 'origin/feature/remote-only', localName: 'feature/api-renamed'
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.branch, 'feature/api-renamed');
  assert.equal(await git(repo, 'symbolic-ref', '--short', 'HEAD'), 'feature/api-renamed');

  const missing = await request('POST', '/api/checkout-branch', {
    repoPath: repo, worktree: repo, refType: 'local', ref: 'no/such'
  });
  assert.equal(missing.status, 404);
});

test('合并冲突 API 链路：merge-ref → merge-state → conflict-file → resolve → commit', async (t) => {
  const { request } = await startServer(t);
  const { repo } = await makeFixture(t);

  // 合并触发冲突：路由返回 200 + status conflict 与冲突清单
  const merged = await request('POST', '/api/merge-ref', { repoPath: repo, worktree: repo, ref: 'origin/feature/remote-only' });
  assert.equal(merged.status, 200);
  assert.equal(merged.body.status, 'conflict');
  assert.ok(merged.body.conflictFiles.some(f => f.path === 'shared.txt' && f.code === 'UU'));
  assert.equal(merged.body.oursLabel, 'main');

  // merge-state 恢复面板状态
  const state = await request('GET', `/api/merge-state?worktree=${encodeURIComponent(repo)}`);
  assert.equal(state.status, 200);
  assert.equal(state.body.inMerge, true);
  assert.equal(state.body.theirsLabel, 'origin/feature/remote-only');

  // 冲突文件三方内容
  const file = await request('GET', `/api/merge-conflict-file?worktree=${encodeURIComponent(repo)}&filePath=${encodeURIComponent('shared.txt')}`);
  assert.equal(file.status, 200);
  assert.equal(file.body.ours, 'line: local\n');
  assert.equal(file.body.theirs, 'line: remote\n');
  assert.equal(file.body.base, 'line: base\n');

  // 快捷解决 + 完成合并
  const resolved = await request('POST', '/api/merge-resolve', {
    worktree: repo, filePath: 'shared.txt', resolution: 'content', content: 'line: api-resolved\n'
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.remaining, 0);

  const done = await request('POST', '/api/merge-commit', { worktree: repo });
  assert.equal(done.status, 200);
  const parents = (await git(repo, 'log', '-1', '--format=%P')).split(/\s+/);
  assert.equal(parents.length, 2);
  assert.equal(await fs.readFile(path.join(repo, 'shared.txt'), 'utf-8'), 'line: api-resolved\n');

  // 无进行中合并后再次 commit/abort 均 409
  const again = await request('POST', '/api/merge-commit', { worktree: repo });
  assert.equal(again.status, 409);
});

test('放弃合并路由：merge-abort 恢复现场', async (t) => {
  const { request } = await startServer(t);
  const { repo } = await makeFixture(t);
  const headBefore = await git(repo, 'rev-parse', 'HEAD');

  await request('POST', '/api/merge-ref', { repoPath: repo, worktree: repo, ref: 'origin/feature/remote-only' });
  const aborted = await request('POST', '/api/merge-abort', { worktree: repo });
  assert.equal(aborted.status, 200);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(await git(repo, 'status', '--porcelain'), '');
});

test('POST /api/merge-resolve 参数校验：非法 resolution 400、路径回溯 400、非冲突文件 404', async (t) => {
  const { request } = await startServer(t);
  const { repo } = await makeFixture(t);
  await request('POST', '/api/merge-ref', { repoPath: repo, worktree: repo, ref: 'origin/feature/remote-only' });

  const badResolution = await request('POST', '/api/merge-resolve', {
    worktree: repo, filePath: 'shared.txt', resolution: 'both'
  });
  assert.equal(badResolution.status, 400);

  const traversal = await request('POST', '/api/merge-resolve', {
    worktree: repo, filePath: '../escape.txt', resolution: 'content', content: 'x'
  });
  assert.equal(traversal.status, 400);

  const notConflicted = await request('POST', '/api/merge-resolve', {
    worktree: repo, filePath: 'nonexistent.txt', resolution: 'ours'
  });
  assert.equal(notConflicted.status, 404);

  await request('POST', '/api/merge-abort', { worktree: repo });
});

test('POST /api/fetch-remotes 刷新远端并把网络失败按 200 + ok:false 返回', async (t) => {
  const { request } = await startServer(t);
  const { repo } = await makeFixture(t);

  const ok = await request('POST', '/api/fetch-remotes', { repoPath: repo });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);

  // 无远端的目录 → 409 中文错误
  const lonelyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-lens-remote-api-lonely-'));
  const lonely = path.join(lonelyDir, 'lonely');
  await git(lonelyDir, 'init', '-b', 'main', 'lonely');
  const noRemote = await request('POST', '/api/fetch-remotes', { repoPath: lonely });
  assert.equal(noRemote.status, 409);
});
