import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: '测试用户',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: '测试用户',
  GIT_COMMITTER_EMAIL: 'test@example.com'
};

/** 在隔离仓库执行 Git 命令。 */
async function git(cwd, ...args) {
  const { stdout } = await execFileAsync('git', args, { cwd, env: gitEnv });
  return stdout.trim();
}

/** 先获取空闲端口，再用独立配置启动测试服务。 */
async function startServer(t, root) {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...gitEnv, PORT: String(port), GIT_LENS_CONFIG_DIR: path.join(root, 'config') },
    stdio: 'ignore'
  });
  t.after(() => server.kill());
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return baseUrl;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('测试服务未能启动');
}

/** 请求测试 API 并解析 JSON。 */
async function api(baseUrl, route, body) {
  const response = await fetch(baseUrl + route, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
}

test('批量清理仅处理已同步干净 Worktree 和未绑定的已合入分支', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'git-lens-bulk-cleanup-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(repo, 'base.txt'), '基线\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', '初始提交');
  await git(repo, 'branch', 'old-synced');

  const synced = path.join(root, 'synced');
  const keep = path.join(root, 'keep');
  const dirty = path.join(root, 'dirty');
  const ahead = path.join(root, 'ahead');
  await git(repo, 'worktree', 'add', '-q', '-b', 'synced-branch', synced);
  await git(repo, 'worktree', 'add', '-q', '-b', 'keep-branch', keep);
  await git(repo, 'worktree', 'add', '-q', '-b', 'dirty-branch', dirty);
  await fs.writeFile(path.join(dirty, 'local.txt'), '未提交\n');
  await git(repo, 'worktree', 'add', '-q', '-b', 'ahead-branch', ahead);
  await fs.writeFile(path.join(ahead, 'feature.txt'), '独有内容\n');
  await git(ahead, 'add', '.');
  await git(ahead, 'commit', '-q', '-m', '新增功能');

  const baseUrl = await startServer(t, root);
  const preview = await api(baseUrl, `/api/cleanup-candidates?path=${encodeURIComponent(repo)}`);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.data.worktrees.map(item => item.path).sort(), [keep, synced].sort());
  assert.deepEqual(preview.data.branches.map(item => item.name), ['old-synced']);

  const removed = await api(baseUrl, '/api/cleanup-synced-worktrees', {
    repoPath: repo, paths: [synced, dirty, ahead, repo], deleteBoundBranches: true
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.results.find(item => item.path === synced).removed, true);
  assert.equal(removed.data.results.find(item => item.path === synced).branchDeleted, true);
  for (const target of [dirty, ahead, repo]) {
    assert.equal(removed.data.results.find(item => item.path === target).removed, false);
  }
  assert.equal(await git(repo, 'branch', '--list', 'synced-branch'), '');
  assert.equal((await fs.stat(dirty)).isDirectory(), true);
  assert.equal((await fs.stat(ahead)).isDirectory(), true);

  const withoutBranch = await api(baseUrl, '/api/cleanup-synced-worktrees', {
    repoPath: repo, paths: [keep], deleteBoundBranches: false
  });
  assert.equal(withoutBranch.data.results[0].removed, true);
  assert.equal(await git(repo, 'branch', '--list', 'keep-branch'), 'keep-branch');

  const branches = await api(baseUrl, '/api/cleanup-redundant-branches', {
    repoPath: repo, names: ['old-synced', 'keep-branch', 'dirty-branch', 'ahead-branch', 'main']
  });
  assert.equal(branches.status, 200);
  for (const name of ['old-synced', 'keep-branch']) {
    assert.equal(branches.data.results.find(item => item.name === name).deleted, true);
  }
  for (const name of ['dirty-branch', 'ahead-branch', 'main']) {
    assert.equal(branches.data.results.find(item => item.name === name).deleted, false);
  }
});
