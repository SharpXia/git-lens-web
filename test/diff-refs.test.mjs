import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getRefDiff, getWorktreeDiff } from '../src/git-inspector.js';

const execGit = promisify(execFile);

// 隔离本机用户/系统 git 配置（hooks、签名、默认分支名等），保证 fixture 行为可复现
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: '测试用户',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: '测试用户',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  TZ: 'UTC',
  LC_ALL: 'C'
};

/** 在指定目录执行 git 命令（execFile 参数数组，禁止 shell 拼接） */
async function git(cwd, ...args) {
  await execGit('git', args, { cwd, env: GIT_ENV });
}

/** 归一化到真实路径，断言路径相等时统一用它，规避 macOS /tmp 符号链接差异 */
function realp(targetPath) {
  return fs.realpath(targetPath);
}

/** 在 /tmp 下创建一次性根目录，测试结束自动清理 */
async function makeTempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-lens-diff-refs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** 初始化一个以 main 为默认分支的空仓库（主工作区即仓库目录） */
async function initRepo(root, name) {
  const repoPath = path.join(root, name);
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, 'init');
  await git(repoPath, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', '测试用户');
  return repoPath;
}

/** 写文件（自动建父目录），内容支持 string 或 Buffer */
async function write(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

/** 全局递增的提交序号，用于生成互不相同且确定的提交时间戳 */
let commitTick = 0;

/** 生成唯一提交时间戳：测试执行极快，若不固定时间，
 * cherry-pick 场景中两次提交可能落在同一秒内产生完全相同 SHA 的提交，
 * 导致「吸收」场景退化为祖先关系 */
function nextCommitDate() {
  commitTick += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, commitTick)).toISOString();
}

/** 暂存全部改动并提交（带唯一时间戳，保证提交 SHA 唯一可复现） */
async function commitAll(cwd, message) {
  const date = nextCommitDate();
  await execGit('git', ['add', '-A'], { cwd, env: GIT_ENV });
  await execGit('git', ['commit', '-m', message], {
    cwd,
    env: { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  });
}

/** 基础 fixture：main 初始提交 a.txt/base.txt，并从 main 检出 feature 分支 worktree */
async function setupBasicFixture(t) {
  const root = await makeTempRoot(t);
  const repo = await initRepo(root, 'repo');
  await write(path.join(repo, 'a.txt'), 'line1\nline2\n');
  await write(path.join(repo, 'base.txt'), 'base\n');
  await commitAll(repo, '初始提交');

  const featWt = path.join(root, 'wt-feature');
  await git(repo, 'worktree', 'add', '-b', 'feature/x', featWt);
  return { root, repo, featWt, branch: 'feature/x' };
}

test('worktree↔worktree：committed/uncommitted/untracked 三种模式与自动回退', async (t) => {
  const { repo, featWt } = await setupBasicFixture(t);

  // 目标 worktree 先提交一个改动
  await write(path.join(featWt, 'a.txt'), 'line1\nline2-changed\nline3\n');
  await commitAll(featWt, '修改 a.txt');

  // 1) committed 模式：只含已提交文件
  const committed = await getWorktreeDiff(repo, repo, featWt, 'committed');
  assert.equal(committed.effectiveMode, 'committed');
  assert.equal(committed.ahead, 1);
  assert.equal(committed.behind, 0);
  assert.equal(committed.historyAhead, 1);
  assert.equal(committed.historyBehind, 0);
  assert.deepEqual(committed.files.map(f => f.filePath), ['a.txt']);
  assert.equal(committed.counts.committed, 1);
  assert.equal(committed.counts.uncommitted, 0);
  assert.match(committed.files[0].diffChunk, /diff --git a\/a\.txt b\/a\.txt/);
  assert.equal(committed.files[0].added, 2);
  assert.equal(committed.files[0].deleted, 1);

  // 2) 目标 worktree 弄脏 + 增加未跟踪文件（含一张图片，验证 untracked 图片标记）
  await write(path.join(featWt, 'base.txt'), 'base\nbase-local-edit\n');
  await write(path.join(featWt, 'untracked.txt'), '新增未跟踪\n');
  await write(path.join(featWt, 'new.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));

  const uncommitted = await getWorktreeDiff(repo, repo, featWt, 'uncommitted');
  assert.equal(uncommitted.effectiveMode, 'uncommitted');
  assert.deepEqual(uncommitted.files.map(f => f.filePath).sort(), ['base.txt', 'new.png', 'untracked.txt']);
  assert.equal(uncommitted.counts.committed, 1);
  const untrackedText = uncommitted.files.find(f => f.filePath === 'untracked.txt');
  assert.equal(untrackedText.status, '?');
  assert.match(untrackedText.diffChunk, /\+新增未跟踪/);
  const untrackedPng = uncommitted.files.find(f => f.filePath === 'new.png');
  assert.equal(untrackedPng.status, '?');
  assert.equal(untrackedPng.isImage, true);
  assert.equal(untrackedPng.isBinary, true);
  assert.match(untrackedPng.diffChunk, /^Binary file new\.png has been added/);

  // 3) all 模式：提交 + 未提交 + untracked 全量
  const all = await getWorktreeDiff(repo, repo, featWt, 'all');
  assert.equal(all.effectiveMode, 'all');
  assert.deepEqual(all.files.map(f => f.filePath).sort(), ['a.txt', 'base.txt', 'new.png', 'untracked.txt']);
  assert.equal(all.counts.uncommitted, 3);
  assert.equal(all.counts.committed, 1);
  assert.equal(all.counts.all, 4);

  // 4) 自动模式：存在未提交时默认 uncommitted
  const auto = await getWorktreeDiff(repo, repo, featWt);
  assert.equal(auto.effectiveMode, 'uncommitted');
});

test('worktree↔worktree：图片/二进制文件在 committed diff 中打标且无行数', async (t) => {
  const { repo, featWt } = await setupBasicFixture(t);

  // 标准 1x1 PNG 字节 + 含 NUL 的二进制文件
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  await write(path.join(featWt, 'pixel.png'), png1x1);
  await write(path.join(featWt, 'data.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
  await commitAll(featWt, '新增图片与二进制文件');

  const diff = await getWorktreeDiff(repo, repo, featWt, 'committed');
  assert.deepEqual(diff.files.map(f => f.filePath).sort(), ['data.bin', 'pixel.png']);

  const png = diff.files.find(f => f.filePath === 'pixel.png');
  assert.equal(png.isImage, true);
  assert.equal(png.isBinary, true);
  assert.equal(png.added, 0);
  assert.equal(png.deleted, 0);

  const bin = diff.files.find(f => f.filePath === 'data.bin');
  assert.equal(bin.isImage, false);
  assert.equal(bin.isBinary, true);
  assert.equal(bin.added, 0);
});

test('worktree↔worktree：同 Worktree 自审锁定 uncommitted', async (t) => {
  const { repo } = await setupBasicFixture(t);
  await write(path.join(repo, 'base.txt'), 'base\n本地改动\n');

  const same = await getWorktreeDiff(repo, repo, repo);
  assert.equal(same.isSameWorktree, true);
  assert.equal(same.effectiveMode, 'uncommitted');
  assert.deepEqual(same.modesAvailable, { uncommitted: true, all: false, committed: false });
  assert.deepEqual(same.counts, { uncommitted: 1, all: 1, committed: 0 });
  assert.deepEqual(same.files.map(f => f.filePath), ['base.txt']);
  // 自审路径同样返回带 kind 的 worktree 元数据
  for (const side of [same.source, same.target]) {
    assert.equal(side.kind, 'worktree');
    for (const key of ['path', 'branch', 'head', 'isMain', 'isDirty', 'lastCommit']) {
      assert.ok(key in side, `自审结果缺少字段 ${key}`);
    }
  }
  assert.equal(await realp(same.source.path), await realp(repo));
});

test('worktree↔worktree：cherry-pick 吸收后 ahead 归零且无 committed diff', async (t) => {
  const root = await makeTempRoot(t);
  const repo = await initRepo(root, 'repo');
  await write(path.join(repo, 'base.txt'), 'base\n');
  await commitAll(repo, '初始提交');

  const featWt = path.join(root, 'wt-absorbed');
  await git(repo, 'worktree', 'add', '-b', 'feature/absorbed', featWt);
  await write(path.join(featWt, 'license.txt'), 'MIT License\n');
  await commitAll(featWt, '新增 LICENSE');

  // 分支提交被 cherry-pick 进 main，随后 main 又前移一个与分支无关的提交：
  // 树不再一致，但分支改动已被吸收
  await git(repo, 'cherry-pick', 'feature/absorbed');
  await write(path.join(repo, 'other.txt'), 'main 独有\n');
  await commitAll(repo, 'main 独有提交');

  const diff = await getWorktreeDiff(repo, repo, featWt, 'committed');
  // 树不同（main 有 other.txt），提交历史上分支仍领先 1，但补丁已被吸收
  assert.equal(diff.isCommittedContentEqual, false);
  assert.equal(diff.historyAhead, 1);
  assert.equal(diff.ahead, 0);
  assert.deepEqual(diff.files, []);
  assert.equal(diff.counts.committed, 0);
  assert.equal(diff.modesAvailable.committed, false);
});

test('branch↔branch：只比较已提交内容且不读任何 Worktree 脏数据', async (t) => {
  const { repo, featWt, branch } = await setupBasicFixture(t);
  const branchSel = { kind: 'branch', value: branch };
  const mainSel = { kind: 'branch', value: 'main' };

  // 分支提交一个改动，然后弄脏它的 worktree 并加 untracked 文件
  await write(path.join(featWt, 'a.txt'), 'line1\nline2-changed\nline3\n');
  await commitAll(featWt, '分支提交修改 a.txt');
  await write(path.join(featWt, 'base.txt'), 'base\n未提交的本地改动\n');
  await write(path.join(featWt, 'untracked.txt'), '未跟踪\n');

  const committed = await getRefDiff(repo, mainSel, branchSel, 'committed');
  assert.equal(committed.effectiveMode, 'committed');
  assert.deepEqual(committed.files.map(f => f.filePath), ['a.txt']);
  assert.equal(committed.ahead, 1);
  // worktree 的脏内容绝不泄漏进 branch↔branch 结果
  assert.equal(committed.counts.uncommitted, 0);
  assert.equal(committed.modesAvailable.uncommitted, false);
  assert.ok(!committed.files.some(f => f.filePath === 'base.txt'));
  assert.ok(!committed.files.some(f => f.filePath === 'untracked.txt'));

  // branch 元数据：kind/branch/head/isMain/isDirty，无 path
  assert.equal(committed.source.kind, 'branch');
  assert.equal(committed.source.branch, 'main');
  assert.equal(committed.source.path, undefined);
  assert.match(committed.source.head, /^[0-9a-f]{40}$/);
  assert.equal(committed.target.kind, 'branch');
  assert.equal(committed.target.branch, branch);
  assert.equal(committed.target.isMain, false);
  assert.equal(committed.target.isDirty, false);
  assert.equal(committed.target.path, undefined);

  // all 与 committed 等价（都只含提交差异）
  const all = await getRefDiff(repo, mainSel, branchSel, 'all');
  assert.deepEqual(all.files.map(f => f.filePath), ['a.txt']);
  assert.equal(all.counts.all, all.counts.committed);
  assert.equal(all.counts.uncommitted, 0);

  // 默认模式：branch↔branch 无请求模式时默认 committed
  const auto = await getRefDiff(repo, mainSel, branchSel);
  assert.equal(auto.effectiveMode, 'committed');

  // 同名 branch↔branch：全零空结果
  const same = await getRefDiff(repo, branchSel, { kind: 'branch', value: branch });
  assert.equal(same.effectiveMode, 'committed');
  assert.equal(same.ahead, 0);
  assert.equal(same.behind, 0);
  assert.equal(same.historyAhead, 0);
  assert.equal(same.historyBehind, 0);
  assert.equal(same.isCommittedContentEqual, true);
  assert.deepEqual(same.files, []);
  assert.deepEqual(same.counts, { uncommitted: 0, all: 0, committed: 0 });
  assert.deepEqual(same.modesAvailable, { uncommitted: false, all: false, committed: false });

  // 不存在的分支返回 404 中文错误
  await assert.rejects(
    getRefDiff(repo, { kind: 'branch', value: 'no-such-branch' }, branchSel),
    (err) => err.statusCode === 404 && err.message.includes('分支 no-such-branch 不存在')
  );

  // 即使该分支的 worktree 已失联（目录被删、未 prune），branch↔branch 也不受影响，
  // 证明整条路径没有读取任何 Worktree
  await fs.rm(featWt, { recursive: true, force: true });
  const orphan = await getRefDiff(repo, mainSel, branchSel, 'committed');
  assert.deepEqual(orphan.files.map(f => f.filePath), ['a.txt']);
  assert.equal(orphan.counts.uncommitted, 0);
});

test('branch↔worktree 与 worktree↔branch：方向性与模式可用性', async (t) => {
  const { repo, featWt, branch } = await setupBasicFixture(t);

  // 分支提交 1 个 commit，worktree 再留一个未提交改动
  await write(path.join(featWt, 'a.txt'), 'line1\nline2-changed\nline3\n');
  await commitAll(featWt, '分支提交修改 a.txt');
  await write(path.join(featWt, 'base.txt'), 'base\n未提交的本地改动\n');

  // branch(source) → worktree(target)：committed 按 target 相对 source 的领先提交计算
  const bw = await getRefDiff(repo, { kind: 'branch', value: 'main' }, { kind: 'worktree', value: featWt }, 'committed');
  assert.equal(bw.source.kind, 'branch');
  assert.equal(bw.target.kind, 'worktree');
  assert.equal(bw.ahead, 1);
  assert.equal(bw.behind, 0);
  assert.deepEqual(bw.files.map(f => f.filePath), ['a.txt']);
  // target 是 worktree：uncommitted/all 语义保留
  const bwAuto = await getRefDiff(repo, { kind: 'branch', value: 'main' }, { kind: 'worktree', value: featWt });
  assert.equal(bwAuto.effectiveMode, 'uncommitted');
  assert.equal(bwAuto.modesAvailable.uncommitted, true);
  const bwAll = await getRefDiff(repo, { kind: 'branch', value: 'main' }, { kind: 'worktree', value: featWt }, 'all');
  assert.deepEqual(bwAll.files.map(f => f.filePath).sort(), ['a.txt', 'base.txt']);

  // worktree(source) → branch(target)：uncommitted 恒不可用，all=committed
  const wb = await getRefDiff(repo, { kind: 'worktree', value: repo }, { kind: 'branch', value: branch });
  assert.equal(wb.source.kind, 'worktree');
  assert.equal(wb.target.kind, 'branch');
  assert.equal(wb.ahead, 1);
  assert.deepEqual(wb.files.map(f => f.filePath), ['a.txt']);
  assert.equal(wb.modesAvailable.uncommitted, false);
  assert.equal(wb.counts.uncommitted, 0);
  assert.equal(wb.counts.all, wb.counts.committed);
  assert.equal(wb.effectiveMode, 'committed');

  // 请求 uncommitted 模式但 target 是分支：视同无效模式，回退 committed
  const wbUncommitted = await getRefDiff(
    repo, { kind: 'worktree', value: repo }, { kind: 'branch', value: branch }, 'uncommitted'
  );
  assert.equal(wbUncommitted.effectiveMode, 'committed');
  assert.deepEqual(wbUncommitted.files.map(f => f.filePath), ['a.txt']);

  // 反方向 branch(target)=main：main 相对 feature 无领先，文件为空
  const reverse = await getRefDiff(repo, { kind: 'worktree', value: featWt }, { kind: 'branch', value: 'main' });
  assert.equal(reverse.ahead, 0);
  assert.deepEqual(reverse.files, []);
  assert.equal(reverse.effectiveMode, 'committed');
});

test('失联 worktree：返回明确的 409 中文错误', async (t) => {
  const { repo, featWt } = await setupBasicFixture(t);

  // 删除 worktree 目录但尚未 git worktree prune：登记仍在、磁盘已失联
  await fs.rm(featWt, { recursive: true, force: true });
  await assert.rejects(
    getWorktreeDiff(repo, repo, featWt),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /Worktree 已失联/);
      return true;
    }
  );
  await assert.rejects(
    getRefDiff(repo, { kind: 'worktree', value: featWt }, { kind: 'worktree', value: repo }),
    (err) => err.statusCode === 409
  );
});

test('兼容回归：getWorktreeDiff 返回结构与旧字段逐项齐全', async (t) => {
  const { repo, featWt } = await setupBasicFixture(t);
  await write(path.join(featWt, 'a.txt'), 'line1\nline2-changed\nline3\n');
  await commitAll(featWt, '修改 a.txt');

  const diff = await getWorktreeDiff(repo, repo, featWt, 'committed');

  // source/target 元数据字段（含新增 kind）
  for (const side of [diff.source, diff.target]) {
    for (const key of ['kind', 'path', 'branch', 'head', 'isMain', 'isDirty', 'lastCommit']) {
      assert.ok(key in side, `元数据缺少字段 ${key}`);
    }
    assert.equal(side.kind, 'worktree');
    assert.ok(typeof side.head === 'string' && /^[0-9a-f]{40}$/.test(side.head));
    assert.ok(side.lastCommit && typeof side.lastCommit.subject === 'string');
  }
  assert.equal(diff.source.isMain, true);
  assert.equal(diff.source.branch, 'main');
  assert.equal(diff.target.branch, 'feature/x');
  assert.equal(await realp(diff.target.path), await realp(featWt));

  // 顶层字段
  for (const key of ['ahead', 'behind', 'historyAhead', 'historyBehind', 'isCommittedContentEqual',
    'effectiveMode', 'modesAvailable', 'counts', 'files']) {
    assert.ok(key in diff, `结果缺少顶层字段 ${key}`);
  }
  assert.deepEqual(Object.keys(diff.modesAvailable).sort(), ['all', 'committed', 'uncommitted']);
  assert.deepEqual(Object.keys(diff.counts).sort(), ['all', 'committed', 'uncommitted']);
  assert.equal(diff.isCommittedContentEqual, false);

  // 文件条目字段
  assert.equal(diff.files.length, 1);
  for (const key of ['filePath', 'status', 'added', 'deleted', 'isBinary', 'isImage', 'diffChunk']) {
    assert.ok(key in diff.files[0], `文件条目缺少字段 ${key}`);
  }
  assert.equal(diff.files[0].status, 'M');
  assert.match(diff.files[0].diffChunk, /diff --git a\/a\.txt b\/a\.txt/);
});

test('worktree 选择器按 realpath 匹配（模拟 macOS /tmp → /private/tmp）', async (t) => {
  const { repo, featWt } = await setupBasicFixture(t);
  await write(path.join(featWt, 'a.txt'), 'line1\nline2-changed\nline3\n');
  await commitAll(featWt, '修改 a.txt');

  // 用指向同一目录的符号链接别名作为选择器值，realpath 后应与登记路径匹配
  const alias = path.join(path.dirname(await realp(featWt)), 'alias-to-feature');
  await fs.symlink(await realp(featWt), alias, 'dir');
  t.after(() => fs.rm(alias, { force: true }));

  const diff = await getWorktreeDiff(repo, await realp(repo), alias, 'committed');
  assert.equal(diff.target.kind, 'worktree');
  assert.equal(diff.ahead, 1);
  assert.deepEqual(diff.files.map(f => f.filePath), ['a.txt']);
});

test('参数校验：kind 非法 400、value 空 400、worktree 未登记 404', async (t) => {
  const { repo, featWt } = await setupBasicFixture(t);

  // kind 非法
  await assert.rejects(
    getRefDiff(repo, { kind: 'tag', value: 'v1' }, { kind: 'branch', value: 'main' }),
    (err) => err.statusCode === 400 && /source 参数不合法/.test(err.message)
  );
  await assert.rejects(
    getRefDiff(repo, { kind: 'worktree', value: repo }, { kind: 'commit', value: 'abc' }),
    (err) => err.statusCode === 400 && /target 参数不合法/.test(err.message)
  );
  // 选择器缺对象 / value 为空
  await assert.rejects(
    getRefDiff(repo, null, { kind: 'branch', value: 'main' }),
    (err) => err.statusCode === 400
  );
  await assert.rejects(
    getRefDiff(repo, { kind: 'branch', value: '' }, { kind: 'branch', value: 'main' }),
    (err) => err.statusCode === 400
  );
  await assert.rejects(
    getRefDiff(repo, { kind: 'worktree', value: '   ' }, { kind: 'worktree', value: repo }),
    (err) => err.statusCode === 400
  );
  // worktree 路径未登记 404
  await assert.rejects(
    getWorktreeDiff(repo, path.join(os.tmpdir(), 'not-a-registered-worktree'), featWt),
    (err) => err.statusCode === 404 && err.message.includes('指定的 Worktree 路径不存在或未被 Git 登记')
  );
});
