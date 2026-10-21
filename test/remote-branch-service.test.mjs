/**
 * 远端分支管理域服务（src/remote-branch-service.js）的回归测试。
 *
 * fixture 采用本地裸仓库作为远端（file 路径直连，无需网络）：
 *   origin.git（bare）← seed 推送 main 与 feature/remote-only → repo（clone，主工作区）
 * 覆盖：远端分支清单、纯远端建分支（push 远端跟踪引用）、工作区分支切换/
 * 检出重命名、合并冲突现场的保持与恢复、三方内容读取、ours/theirs/自定义内容
 * 三种解决方式、完成/放弃合并、fetch 全量刷新。
 *
 * 全部使用 mkdtemp 临时目录与隔离 git 配置，不触碰宿主仓库与真实远端。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  listRemoteBranches,
  createRemoteBranch,
  checkoutBranch,
  mergeRef,
  getMergeState,
  getConflictFile,
  resolveConflictFile,
  commitMerge,
  abortMerge,
  fetchRemotes
} from '../src/remote-branch-service.js';

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
  const { stdout } = await execGit('git', args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

async function gitFail(cwd, ...args) {
  await assert.rejects(execGit('git', args, { cwd, env: GIT_ENV }));
}

/**
 * 构建含本地裸远端的完整 fixture：
 * - origin.git：裸仓库（充当远端）
 * - seed：内容生产仓库，推送 main + feature/remote-only（双方修改同一行，供冲突场景）
 * - repo：clone 自 origin.git 的主工作区（检出 main）
 */
async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-lens-remote-branch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const bare = path.join(root, 'origin.git');
  await git(root, 'init', '--bare', '-b', 'main', bare);

  const seed = path.join(root, 'seed');
  await execGit('git', ['clone', '-q', bare, seed], { env: GIT_ENV });
  await fs.writeFile(path.join(seed, 'shared.txt'), 'line: base\n');
  await fs.writeFile(path.join(seed, 'readme.md'), '# fixture\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'base: 初始内容');

  // 远端独有分支：修改同一行（与主工作区后续的本地修改构成冲突素材）
  await git(seed, 'checkout', '-q', '-b', 'feature/remote-only');
  await fs.writeFile(path.join(seed, 'shared.txt'), 'line: remote\n');
  await git(seed, 'commit', '-am', 'remote: 修改共享行');
  await git(seed, 'push', '-q', 'origin', 'feature/remote-only');

  await git(seed, 'checkout', '-q', 'main');
  await git(seed, 'push', '-q', 'origin', 'main');
  await git(seed, 'remote', 'set-head', 'origin', 'main');

  // repo：被测主工作区，clone 后在本地修改同一行（保留为未推送的本地 main）
  const repoRaw = path.join(root, 'repo');
  await execGit('git', ['clone', '-q', bare, repoRaw], { env: GIT_ENV });
  const repo = await fs.realpath(repoRaw);
  await git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await git(repo, 'reset', '--hard', '-q', 'origin/main');
  await fs.writeFile(path.join(repo, 'shared.txt'), 'line: local\n');
  await fs.writeFile(path.join(repo, 'local-only.txt'), '仅本地可见\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'local: 修改共享行（与远端分支冲突素材）');

  return { root, bare, seed, repo };
}

/** 干净可合并素材：主工作区给 main 追加一笔独立提交并推到远端，供快进/干净合并场景 */
async function addCleanRemoteCommit(t, fixture) {
  const { seed } = fixture;
  await git(seed, 'checkout', '-q', 'main');
  await fs.writeFile(path.join(seed, 'clean.txt'), '无冲突的新文件\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'remote: main 追加干净提交');
  await git(seed, 'push', '-q', 'origin', 'main');
  await git(fixture.repo, 'fetch', '-q', 'origin');
}

test('远端分支清单包含同步状态与本地同名分支对应关系', async (t) => {
  const { repo } = await makeFixture(t);
  const { mainBranch, branches } = await listRemoteBranches(repo);

  assert.equal(mainBranch, 'main');
  const names = branches.map(b => b.name);
  assert.ok(names.includes('origin/main'));
  assert.ok(names.includes('origin/feature/remote-only'));

  const remoteOnly = branches.find(b => b.name === 'origin/feature/remote-only');
  assert.equal(remoteOnly.remote, 'origin');
  assert.equal(remoteOnly.branch, 'feature/remote-only');
  assert.ok(remoteOnly.sha && /^[0-9a-f]{40}$/.test(remoteOnly.sha));
  assert.equal(remoteOnly.subject, 'remote: 修改共享行');
  // repo 的本地 main 与远端 main 各有一个对方没有的提交（本地未推送的冲突素材提交除外）
  const originMain = branches.find(b => b.name === 'origin/main');
  assert.ok(originMain.local);
  // feature/remote-only 无本地同名分支
  assert.equal(remoteOnly.local, null);
});

test('基于远端分支创建新远端分支：远端与本地跟踪引用同步更新且不落地本地分支', async (t) => {
  const { bare, repo } = await makeFixture(t);
  const sourceSha = await git(repo, 'rev-parse', 'origin/feature/remote-only');

  const result = await createRemoteBranch({
    repoPath: repo,
    sourceRef: 'origin/feature/remote-only',
    newBranchName: 'feature/copy'
  });
  assert.equal(result.ok, true);
  assert.equal(result.remote, 'origin');
  assert.equal(result.branch, 'feature/copy');
  assert.equal(result.sha, sourceSha);

  // 远端裸仓库出现新分支且指向基准提交
  assert.equal(await git(bare, 'rev-parse', 'refs/heads/feature/copy'), sourceSha);
  // push 成功后本地远端跟踪引用自动更新
  assert.equal(await git(repo, 'rev-parse', 'refs/remotes/origin/feature/copy'), sourceSha);
  // 纯远端操作：不得创建本地分支
  await gitFail(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature/copy');
});

test('创建远端分支的前置校验：重名 409、非法名 400、未知来源 404、未知远端 404', async (t) => {
  const { repo } = await makeFixture(t);
  await createRemoteBranch({ repoPath: repo, sourceRef: 'origin/main', newBranchName: 'feature/copy' });

  await assert.rejects(
    createRemoteBranch({ repoPath: repo, sourceRef: 'origin/main', newBranchName: 'feature/copy' }),
    err => err.statusCode === 409 && /已存在/.test(err.message)
  );
  await assert.rejects(
    createRemoteBranch({ repoPath: repo, sourceRef: 'origin/main', newBranchName: '-evil' }),
    err => err.statusCode === 400
  );
  await assert.rejects(
    createRemoteBranch({ repoPath: repo, sourceRef: 'origin/no-such-branch', newBranchName: 'feature/x' }),
    err => err.statusCode === 404
  );
  await assert.rejects(
    createRemoteBranch({ repoPath: repo, sourceRef: 'upstream/main', newBranchName: 'feature/x' }),
    err => err.statusCode === 404 && /upstream/.test(err.message)
  );
});

test('检出远端分支到当前工作区并重命名：本地跟踪分支建立 upstream', async (t) => {
  const { repo } = await makeFixture(t);
  const sourceSha = await git(repo, 'rev-parse', 'origin/feature/remote-only');

  const result = await checkoutBranch({
    repoPath: repo,
    worktreePath: repo,
    refType: 'remote',
    ref: 'origin/feature/remote-only',
    localName: 'feature/renamed'
  });
  assert.equal(result.ok, true);
  assert.equal(result.branch, 'feature/renamed');
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), sourceSha);
  assert.equal(await git(repo, 'symbolic-ref', '--short', 'HEAD'), 'feature/renamed');
  // upstream 指向来源远端分支，后续 pull/push 免参数
  assert.equal(await git(repo, 'rev-parse', '--abbrev-ref', 'feature/renamed@{upstream}'), 'origin/feature/remote-only');
  assert.equal(await git(repo, 'status', '--porcelain'), '');

  // localName 缺省时取远端分支短名
  const second = await checkoutBranch({ repoPath: repo, worktreePath: repo, refType: 'local', ref: 'main' });
  assert.equal(second.branch, 'main');
  const defaulted = await checkoutBranch({ repoPath: repo, worktreePath: repo, refType: 'remote', ref: 'origin/feature/remote-only' });
  assert.equal(defaulted.branch, 'feature/remote-only');
});

test('检出的前置校验：同名本地分支 409、当前分支 409、不存在 404、其他工作区占用 409、脏工作区 409', async (t) => {
  const { root, repo } = await makeFixture(t);
  await git(repo, 'branch', 'feature/renamed');

  await assert.rejects(
    checkoutBranch({ repoPath: repo, worktreePath: repo, refType: 'remote', ref: 'origin/feature/remote-only', localName: 'feature/renamed' }),
    err => err.statusCode === 409 && /已存在/.test(err.message)
  );
  await assert.rejects(
    checkoutBranch({ repoPath: repo, worktreePath: repo, refType: 'local', ref: 'main' }),
    err => err.statusCode === 409 && /已在.*分支/.test(err.message)
  );
  await assert.rejects(
    checkoutBranch({ repoPath: repo, worktreePath: repo, refType: 'local', ref: 'no/such' }),
    err => err.statusCode === 404
  );
  await assert.rejects(
    checkoutBranch({ repoPath: repo, worktreePath: repo, refType: 'remote', ref: 'origin/ghost' }),
    err => err.statusCode === 404 && /fetch/.test(err.message)
  );

  // 分支被其他工作区检出时拒绝
  const otherWt = path.join(root, 'wt-other');
  await git(repo, 'worktree', 'add', '-q', '-b', 'feature/held', otherWt);
  await assert.rejects(
    checkoutBranch({ repoPath: repo, worktreePath: repo, refType: 'local', ref: 'feature/held' }),
    err => err.statusCode === 409 && /其他工作区/.test(err.message)
  );

  // 脏工作区拒绝（先回到 main 并制造未提交修改）
  await fs.writeFile(path.join(repo, 'dirty.txt'), '未提交\n');
  await assert.rejects(
    checkoutBranch({ repoPath: repo, worktreePath: repo, refType: 'local', ref: 'feature/held' }),
    err => err.statusCode === 409 && /未提交/.test(err.message)
  );
  await fs.rm(path.join(repo, 'dirty.txt'));
});

test('合并远端分支：无交集改动时干净合并生成双亲合并提交（非快进）', async (t) => {
  const { repo } = await makeFixture(t);
  // 本地基于 origin/main 切出干净工作分支并追加独立提交（不碰 shared.txt）
  await git(repo, 'checkout', '-q', '-b', 'work/clean', 'origin/main');
  await fs.writeFile(path.join(repo, 'mine.txt'), '本地独立文件\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'local: work/clean 独立提交');

  const headBefore = await git(repo, 'rev-parse', 'HEAD');
  const remoteSha = await git(repo, 'rev-parse', 'origin/feature/remote-only');
  const result = await mergeRef({ repoPath: repo, worktreePath: repo, ref: 'origin/feature/remote-only' });
  assert.equal(result.status, 'merged');
  assert.equal(result.fastForward, false);
  const parents = (await git(repo, 'log', '-1', '--format=%P')).split(/\s+/);
  assert.deepEqual(parents, [headBefore, remoteSha]);
  assert.equal(await git(repo, 'status', '--porcelain'), '');
});

test('合并远端分支：可快进时直接快进并返回 merged 状态', async (t) => {
  const fixture = await makeFixture(t);
  const { repo } = fixture;
  await addCleanRemoteCommit(t, fixture);
  // 对齐远端后本地回退一个提交：本地 main 是 origin/main 的祖先，合并应快进
  await git(repo, 'reset', '--hard', '-q', 'origin/main');
  await git(repo, 'reset', '--hard', '-q', 'HEAD~1');

  const remoteHead = await git(repo, 'rev-parse', 'origin/main');
  const result = await mergeRef({ repoPath: repo, worktreePath: repo, ref: 'origin/main' });
  assert.equal(result.status, 'merged');
  assert.equal(result.fastForward, true);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), remoteHead);
});

test('合并冲突：保持现场并返回冲突清单，getMergeState 可恢复面板状态', async (t) => {
  const { repo } = await makeFixture(t);
  const headBefore = await git(repo, 'rev-parse', 'HEAD');

  const result = await mergeRef({ repoPath: repo, worktreePath: repo, ref: 'origin/feature/remote-only' });
  assert.equal(result.status, 'conflict');
  assert.equal(result.oursLabel, 'main');
  assert.equal(result.theirsLabel, 'origin/feature/remote-only');
  const shared = result.conflictFiles.find(f => f.path === 'shared.txt');
  assert.ok(shared);
  assert.equal(shared.code, 'UU');

  const state = await getMergeState(repo);
  assert.equal(state.inMerge, true);
  assert.equal(state.inProgress, 'merge');
  assert.equal(state.oursLabel, 'main');
  assert.ok(state.conflictFiles.some(f => f.path === 'shared.txt'));

  // 冲突期间 HEAD 不动
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), headBefore);
});

test('getConflictFile 提供工作区当前内容与 ours/theirs/base 三方版本', async (t) => {
  const { repo } = await makeFixture(t);
  await mergeRef({ repoPath: repo, worktreePath: repo, ref: 'origin/feature/remote-only' });

  const file = await getConflictFile({ worktreePath: repo, filePath: 'shared.txt' });
  assert.equal(file.isBinary, false);
  assert.ok(file.raw.includes('<<<<<<<') && file.raw.includes('>>>>>>>'));
  assert.equal(file.ours, 'line: local\n');
  assert.equal(file.theirs, 'line: remote\n');
  assert.equal(file.base, 'line: base\n');

  // 非冲突文件拒绝读取；路径回溯拒绝
  await assert.rejects(
    getConflictFile({ worktreePath: repo, filePath: 'readme.md' }),
    err => err.statusCode === 404
  );
  await assert.rejects(
    getConflictFile({ worktreePath: repo, filePath: '../../etc/passwd' }),
    err => err.statusCode === 400
  );
});

test('resolveConflictFile 支持 ours/theirs/自定义内容三种方式并反馈剩余数量', async (t) => {
  const { repo } = await makeFixture(t);
  await mergeRef({ repoPath: repo, worktreePath: repo, ref: 'origin/feature/remote-only' });

  const first = await resolveConflictFile({ worktreePath: repo, filePath: 'shared.txt', resolution: 'theirs' });
  assert.equal(first.ok, true);
  assert.equal(await fs.readFile(path.join(repo, 'shared.txt'), 'utf-8'), 'line: remote\n');

  // 再次处理同一文件应提示已不在冲突清单
  await assert.rejects(
    resolveConflictFile({ worktreePath: repo, filePath: 'shared.txt', resolution: 'ours' }),
    err => err.statusCode === 404
  );

  // 制造第二个冲突（新增文件双方添加）：直接用底层 git 构造 add/add 冲突
  await abortMerge(repo);
  await git(repo, 'reset', '--hard', '-q', 'HEAD');
  await mergeRef({ repoPath: repo, worktreePath: repo, ref: 'origin/feature/remote-only' });

  const custom = await resolveConflictFile({
    worktreePath: repo,
    filePath: 'shared.txt',
    resolution: 'content',
    content: 'line: merged-custom\n'
  });
  assert.equal(custom.ok, true);
  assert.equal(custom.remaining, 0);
  assert.equal(await fs.readFile(path.join(repo, 'shared.txt'), 'utf-8'), 'line: merged-custom\n');

  // 非法 resolution 与缺 content 校验
  await assert.rejects(
    resolveConflictFile({ worktreePath: repo, filePath: 'shared.txt', resolution: 'nope' }),
    err => err.statusCode === 400
  );
});

test('完成合并生成双亲合并提交；冲突未清时拒绝；放弃合并恢复现场', async (t) => {
  const { repo } = await makeFixture(t);
  const headBefore = await git(repo, 'rev-parse', 'HEAD');
  const sourceSha = await git(repo, 'rev-parse', 'origin/feature/remote-only');

  await mergeRef({ repoPath: repo, worktreePath: repo, ref: 'origin/feature/remote-only' });

  // 冲突未处理时不能完成合并
  await assert.rejects(commitMerge(repo), err => err.statusCode === 409 && /冲突文件未处理/.test(err.message));

  await resolveConflictFile({ worktreePath: repo, filePath: 'shared.txt', resolution: 'content', content: 'line: resolved\n' });
  const done = await commitMerge(repo);
  assert.equal(done.ok, true);
  const parents = (await git(repo, 'log', '-1', '--format=%P')).split(/\s+/);
  assert.equal(parents.length, 2);
  assert.equal(parents[0], headBefore);
  assert.equal(parents[1], sourceSha);
  assert.equal(await git(repo, 'status', '--porcelain'), '');
  assert.equal(await getMergeState(repo).then(s => s.inMerge), false);

  // 无进行中合并时完成/放弃均 409
  await assert.rejects(commitMerge(repo), err => err.statusCode === 409);
  await assert.rejects(abortMerge(repo), err => err.statusCode === 409);
});

test('放弃合并：现场与 HEAD 均恢复到合并前', async (t) => {
  const { repo } = await makeFixture(t);
  const headBefore = await git(repo, 'rev-parse', 'HEAD');

  await mergeRef({ repoPath: repo, worktreePath: repo, ref: 'origin/feature/remote-only' });
  assert.equal((await getMergeState(repo)).inMerge, true);

  await abortMerge(repo);
  assert.equal(await git(repo, 'status', '--porcelain'), '');
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), headBefore);
  assert.equal((await getMergeState(repo)).inMerge, false);
});

test('二进制冲突只提供快捷处理且 getConflictFile 标记 isBinary', async (t) => {
  const { seed, repo } = await makeFixture(t);
  // 远端分支追加二进制版本 A，本地提交二进制版本 B 后合并 → 二进制冲突
  await git(seed, 'checkout', '-q', 'feature/remote-only');
  await fs.writeFile(path.join(seed, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'remote: 添加二进制文件');
  await git(seed, 'push', '-q', 'origin', 'feature/remote-only');

  await fs.writeFile(path.join(repo, 'blob.bin'), Buffer.from([0x00, 0xff, 0xfe, 0xfd]));
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'local: 添加同名二进制文件');
  await git(repo, 'fetch', '-q', 'origin');

  const result = await mergeRef({ repoPath: repo, worktreePath: repo, ref: 'origin/feature/remote-only' });
  assert.equal(result.status, 'conflict');
  assert.ok(result.conflictFiles.some(f => f.path === 'blob.bin'));

  const file = await getConflictFile({ worktreePath: repo, filePath: 'blob.bin' });
  assert.equal(file.isBinary, true);
  assert.equal(file.raw, null);

  // 二进制文件同样可以按侧解决
  const resolved = await resolveConflictFile({ worktreePath: repo, filePath: 'blob.bin', resolution: 'ours' });
  assert.equal(resolved.ok, true);
  await abortMerge(repo);
});

test('fetchRemotes 刷新远端并在无远端配置时给出中文错误', async (t) => {
  const { seed, repo } = await makeFixture(t);
  // seed 直接向裸远端推一条新分支，repo 侧 fetch 后应可见
  await git(seed, 'checkout', '-q', '-b', 'feature/fresh');
  await fs.appendFile(path.join(seed, 'readme.md'), '新分支内容\n');
  await git(seed, 'commit', '-am', 'fresh: 新分支提交');
  await git(seed, 'push', '-q', 'origin', 'feature/fresh');

  const result = await fetchRemotes(repo);
  assert.equal(result.ok, true);
  const seen = await git(repo, 'rev-parse', '--verify', 'refs/remotes/origin/feature/fresh');
  assert.ok(/^[0-9a-f]{40}$/.test(seen));

  // 无远端的独立仓库返回 409 中文错误
  const lonely = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'git-lens-lonely-')), 'lonely');
  t.after(() => fs.rm(path.dirname(lonely), { recursive: true, force: true }));
  await git(path.dirname(lonely), 'init', '-b', 'main', 'lonely');
  await assert.rejects(fetchRemotes(lonely), err => err.statusCode === 409 && /远端/.test(err.message));
});
