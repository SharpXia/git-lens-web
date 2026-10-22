/**
 * Worktree 管理扩展 API 的回归测试：创建 Worktree（已有分支 / 以起点新建分支 + 别名）、
 * 上锁/解锁、别名元数据读写、inspect 别名注入与远端分支清单的 lastFetchAt。
 *
 * 全部使用 mkdtemp 临时目录 + browser 模式服务工厂 + 本地裸远端，不触碰真实仓库。
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

async function startServer(t) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-lens-wt-mgmt-config-'));
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
  return { request, configDir };
}

/**
 * fixture：origin.git 裸远端 + repo 主工作区（检出 main）。
 * repo 预推 origin/main 与 origin/feature/from-remote（后者领先一个提交），
 * 本地另建一条未绑定分支 feature/free。
 */
async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-lens-wt-mgmt-'));
  tempRoots.push(root);

  const bare = path.join(root, 'origin.git');
  await git(root, 'init', '--bare', '-b', 'main', bare);
  const seed = path.join(root, 'seed');
  await execGit('git', ['clone', '-q', bare, seed], { env: GIT_ENV });
  await fs.writeFile(path.join(seed, 'base.txt'), 'base\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'base');
  await git(seed, 'checkout', '-qb', 'feature/from-remote');
  await fs.writeFile(path.join(seed, 'remote.txt'), '远端内容\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'remote: 独有提交');
  await git(seed, 'push', '-q', 'origin', 'feature/from-remote');
  await git(seed, 'checkout', '-q', 'main');
  await git(seed, 'push', '-q', 'origin', 'main');

  const repoRaw = path.join(root, 'repo');
  await execGit('git', ['clone', '-q', bare, repoRaw], { env: GIT_ENV });
  const repo = await fs.realpath(repoRaw);
  await git(repo, 'branch', 'feature/free');
  return { root, repo, bare };
}

test('创建 Worktree：检出已有未绑定分支', async (t) => {
  const { request } = await startServer(t);
  const { root, repo } = await makeFixture(t);
  const wtPath = path.join(root, 'wt-free');

  const res = await request('POST', '/api/create-worktree', {
    repoPath: repo, worktreePath: wtPath, branchMode: 'existing', branchName: 'feature/free'
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.branch, 'feature/free');
  assert.equal(await git(repo, 'rev-parse', 'feature/free'), await git(wtPath, 'rev-parse', 'HEAD'));

  // 分支被占用后再创建 → 409；目录非空 → 409
  const holder = await request('POST', '/api/create-worktree', {
    repoPath: repo, worktreePath: path.join(root, 'wt-again'), branchMode: 'existing', branchName: 'feature/free'
  });
  assert.equal(holder.status, 409);
  const nonEmpty = await request('POST', '/api/create-worktree', {
    repoPath: repo, worktreePath: repo, branchMode: 'existing', branchName: 'feature/free'
  });
  assert.equal(nonEmpty.status, 409);
});

test('创建 Worktree：以远端分支为起点新建分支并建立 upstream，可同时登记别名', async (t) => {
  const { request } = await startServer(t);
  const { root, repo } = await makeFixture(t);
  const wtPath = path.join(root, 'wt-new');

  const res = await request('POST', '/api/create-worktree', {
    repoPath: repo, worktreePath: wtPath, branchMode: 'new',
    branchName: 'feature/from-start', startPoint: 'origin/feature/from-remote', name: '远端起点工作区'
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.branch, 'feature/from-start');
  assert.equal(res.body.name, '远端起点工作区');
  assert.equal(await git(repo, 'rev-parse', 'feature/from-start'), await git(repo, 'rev-parse', 'origin/feature/from-remote'));
  assert.equal(await git(wtPath, 'rev-parse', '--abbrev-ref', 'feature/from-start@{upstream}'), 'origin/feature/from-remote');

  // 同名分支已存在 → 新建模式 409；不存在的起点 → 404；非法别名 → 400
  const dup = await request('POST', '/api/create-worktree', {
    repoPath: repo, worktreePath: path.join(root, 'wt-dup'), branchMode: 'new', branchName: 'feature/from-start'
  });
  assert.equal(dup.status, 409);
  const badStart = await request('POST', '/api/create-worktree', {
    repoPath: repo, worktreePath: path.join(root, 'wt-bad'), branchMode: 'new', branchName: 'feature/x', startPoint: 'origin/ghost'
  });
  assert.equal(badStart.status, 404);
  const badName = await request('POST', '/api/create-worktree', {
    repoPath: repo, worktreePath: path.join(root, 'wt-name'), branchMode: 'new', branchName: 'feature/y', name: '含\n换行'
  });
  assert.equal(badName.status, 400);
});

test('Worktree 上锁/解锁：porcelain 状态联动，重复操作 409', async (t) => {
  const { request } = await startServer(t);
  const { root, repo } = await makeFixture(t);
  const wtPath = path.join(root, 'wt-lock');
  await request('POST', '/api/create-worktree', {
    repoPath: repo, worktreePath: wtPath, branchMode: 'new', branchName: 'feature/lockme'
  });

  const lock = await request('POST', '/api/worktree-lock', { repoPath: repo, worktreePath: wtPath, lock: true, reason: '验收保护' });
  assert.equal(lock.status, 200);
  assert.equal(await git(repo, 'worktree', 'list', '--porcelain').then(out => out.includes('locked')), true);

  const relist = await request('POST', '/api/worktree-lock', { repoPath: repo, worktreePath: wtPath, lock: true });
  assert.equal(relist.status, 409);

  const unlock = await request('POST', '/api/worktree-lock', { repoPath: repo, worktreePath: wtPath, lock: false });
  assert.equal(unlock.status, 200);
  assert.equal(await git(repo, 'worktree', 'list', '--porcelain').then(out => out.includes('locked')), false);

  const unlockAgain = await request('POST', '/api/worktree-lock', { repoPath: repo, worktreePath: wtPath, lock: false });
  assert.equal(unlockAgain.status, 409);

  // 非本仓库的路径拒绝
  const foreign = await request('POST', '/api/worktree-lock', { repoPath: repo, worktreePath: path.join(root, 'nope'), lock: true });
  assert.equal(foreign.status, 404);
});

test('Worktree 别名：设置/清除与 inspect 注入', async (t) => {
  const { request, configDir } = await startServer(t);
  const { root, repo } = await makeFixture(t);
  const wtPath = path.join(root, 'wt-alias');
  await request('POST', '/api/create-worktree', {
    repoPath: repo, worktreePath: wtPath, branchMode: 'new', branchName: 'feature/alias'
  });
  const aliasRealPath = await fs.realpath(wtPath);

  const setRes = await request('POST', '/api/worktree-meta', { repoPath: repo, worktreePath: wtPath, name: '我的别名' });
  assert.equal(setRes.status, 200);
  assert.equal(setRes.body.name, '我的别名');

  const getRes = await request('GET', `/api/worktree-meta?path=${encodeURIComponent(repo)}`);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.meta[aliasRealPath]?.name, '我的别名');

  // inspect 注入别名（inspect 返回的 path 为 git porcelain 的 realpath 形态）
  const inspect = await request('GET', `/api/inspect?path=${encodeURIComponent(repo)}`);
  const named = inspect.body.worktrees.find(w => w.path === aliasRealPath);
  assert.equal(named?.name, '我的别名');

  // 清除（空名）
  const clear = await request('POST', '/api/worktree-meta', { repoPath: repo, worktreePath: wtPath, name: '' });
  assert.equal(clear.status, 200);
  const getAfter = await request('GET', `/api/worktree-meta?path=${encodeURIComponent(repo)}`);
  assert.equal(getAfter.body.meta[aliasRealPath], undefined);

  // 元数据落盘在 configDir
  const stored = JSON.parse(await fs.readFile(path.join(configDir, 'worktree-meta.json'), 'utf-8'));
  assert.equal(stored.version, 1);

  // 非本仓库路径拒绝 + 非法名称拒绝
  const foreign = await request('POST', '/api/worktree-meta', { repoPath: repo, worktreePath: path.join(root, 'nope'), name: 'x' });
  assert.equal(foreign.status, 404);
  const invalid = await request('POST', '/api/worktree-meta', { repoPath: repo, worktreePath: wtPath, name: 'a'.repeat(61) });
  assert.equal(invalid.status, 400);
});

test('远端分支清单携带 lastFetchAt：fetch 前为 null，fetch 后为 ISO 时间', async (t) => {
  const { request } = await startServer(t);
  const { repo } = await makeFixture(t);

  const before = await request('GET', `/api/remote-branches?path=${encodeURIComponent(repo)}`);
  assert.equal(before.status, 200);
  // clone 场景 FETCH_HEAD 可能已存在（git clone 不写 FETCH_HEAD），两种取值都合法，但 fetch 后必须为 ISO
  const after = await request('POST', '/api/fetch-remotes', { repoPath: repo });
  assert.equal(after.body.ok, true);
  const list = await request('GET', `/api/remote-branches?path=${encodeURIComponent(repo)}`);
  assert.ok(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(list.body.lastFetchAt || ''), `lastFetchAt 应为 ISO 时间，实际：${list.body.lastFetchAt}`);
});

test('Worktree 重命名：目录随别名移动、别名元数据迁移、upstream 保持', async (t) => {
  const { request } = await startServer(t);
  const { root, repo } = await makeFixture(t);
  const wtPath = path.join(root, 'wt-rename');
  await request('POST', '/api/create-worktree', {
    repoPath: repo, worktreePath: wtPath, branchMode: 'new',
    branchName: 'feature/from-start', startPoint: 'origin/feature/from-remote', name: '旧名'
  });

  const res = await request('POST', '/api/worktree-rename', { repoPath: repo, worktreePath: wtPath, name: '新名字' });
  assert.equal(res.status, 200);
  const newPath = res.body.worktreePath;
  assert.equal(res.body.moved, true);
  assert.equal(path.basename(newPath), '新名字');
  assert.ok(await fs.stat(newPath).then(() => true, () => false), '新目录应存在');
  assert.ok(await fs.stat(wtPath).then(() => false, () => true), '旧目录应不存在');
  // git 元数据随移动更新：分支/upstream/别名全部就位
  assert.equal(await git(newPath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/from-start');
  assert.equal(await git(newPath, 'rev-parse', '--abbrev-ref', 'feature/from-start@{upstream}'), 'origin/feature/from-remote');
  const meta = await request('GET', `/api/worktree-meta?path=${encodeURIComponent(repo)}`);
  assert.equal(meta.body.meta[await fs.realpath(newPath)]?.name, '新名字');
  // porcelain 登记新路径
  assert.ok((await git(repo, 'worktree', 'list', '--porcelain')).includes(newPath));

  // 目标目录已被占用 → 409；空名称 → 400
  const occupied = path.join(root, 'occupied');
  await fs.mkdir(occupied);
  const conflict = await request('POST', '/api/worktree-rename', {
    repoPath: repo, worktreePath: newPath, name: 'occupied'
  });
  assert.equal(conflict.status, 409);
  const empty = await request('POST', '/api/worktree-rename', { repoPath: repo, worktreePath: newPath, name: '' });
  assert.equal(empty.status, 400);
});

test('Worktree 重命名：已加锁工作区移动后恢复上锁', async (t) => {
  const { request } = await startServer(t);
  const { root, repo } = await makeFixture(t);
  const wtPath = path.join(root, 'wt-locked-rename');
  await request('POST', '/api/create-worktree', {
    repoPath: repo, worktreePath: wtPath, branchMode: 'new', branchName: 'feature/lock-rename'
  });
  await request('POST', '/api/worktree-lock', { repoPath: repo, worktreePath: wtPath, lock: true, reason: '保护现场' });

  const res = await request('POST', '/api/worktree-rename', { repoPath: repo, worktreePath: wtPath, name: '锁着改名' });
  assert.equal(res.status, 200);
  const newPath = res.body.worktreePath;
  // 与服务端同口径关闭 quotePath，否则中文原因在 porcelain 里被 C 风格转义
  const porcelain = await git(repo, '-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain');
  const segment = porcelain.split(/\n(?=worktree )/).find(seg => seg.includes('锁着改名')) || '';
  assert.ok(segment.includes('locked'), '移动后应恢复上锁');
  assert.ok(segment.includes('保护现场'), '锁原因应原样保留');
});

test('Worktree 重命名：主工作区拒绝移动目录', async (t) => {
  const { request } = await startServer(t);
  const { repo } = await makeFixture(t);
  const res = await request('POST', '/api/worktree-rename', { repoPath: repo, worktreePath: repo, name: '改名主仓库' });
  assert.equal(res.status, 409);
  assert.ok(/主工作区/.test(res.body.error));
});
