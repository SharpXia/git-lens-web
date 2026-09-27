import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getStashList, stashAction } from '../src/git-inspector.js';

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

async function git(cwd, ...args) {
  await execGit('git', args, { cwd, env: GIT_ENV });
}

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-lens-stash-action-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, 'init', '-b', 'main');
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'base\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'base');
  await git(repo, 'branch', 'feature');
  await git(repo, 'branch', 'other');
  return { root, repo };
}

test('stash 可恢复到指定 Worktree 或未绑定分支的新 Worktree', async (t) => {
  const { root, repo } = await makeFixture(t);
  const targetWorktree = path.join(root, 'target-worktree');
  const featureWorktree = path.join(root, 'feature-worktree');
  await git(repo, 'worktree', 'add', targetWorktree, 'feature');

  await fs.writeFile(path.join(repo, 'tracked.txt'), '来自 stash\n');
  await stashAction(repo, 'push', { message: '跨工作区恢复' });
  const stash = (await getStashList(repo))[0];
  assert.ok(stash);

  const restored = await stashAction(repo, 'pop', {
    stashRef: stash.ref,
    targetWorktree
  });
  assert.equal(restored.targetWorktree, await fs.realpath(targetWorktree));
  assert.equal(await fs.readFile(path.join(targetWorktree, 'tracked.txt'), 'utf8'), '来自 stash\n');

  await fs.writeFile(path.join(repo, 'tracked.txt'), '再次 stash\n');
  await stashAction(repo, 'push');
  const secondStash = (await getStashList(repo))[0];
  const created = await stashAction(repo, 'pop', {
    stashRef: secondStash.ref,
    targetBranch: 'other',
    newWorktreePath: featureWorktree
  });
  assert.equal(created.createdWorktree, true);
  assert.equal(await fs.readFile(path.join(featureWorktree, 'tracked.txt'), 'utf8'), '再次 stash\n');
});

test('一键处理未提交内容可按范围保留或删除文件', async (t) => {
  const { repo } = await makeFixture(t);
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'changed\n');
  await fs.writeFile(path.join(repo, 'untracked.txt'), 'untracked\n');

  await stashAction(repo, 'restore');
  assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), 'base\n');
  assert.equal(await fs.readFile(path.join(repo, 'untracked.txt'), 'utf8'), 'untracked\n');

  await stashAction(repo, 'clean');
  await assert.rejects(fs.access(path.join(repo, 'untracked.txt')));
});
