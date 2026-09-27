import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getBranches, getWorktrees, annotateDeliveredViaBranches, annotateWorktreesFromBranches, annotateDeliveredViaWorktrees } from '../src/git-inspector.js';

/**
 * 传递吸收判定测试：模拟 PR squash 合并流程，
 * 验证「成果已经由载体分支进入主干」的识别与剪枝边界。
 */

let fixtureRoot = null;
let repoPath = null;

/** 执行 git 命令（统一注入测试身份与提交时间，避免依赖全局配置） */
function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: '测试', GIT_AUTHOR_EMAIL: 'test@test.local', GIT_COMMITTER_NAME: '测试', GIT_COMMITTER_EMAIL: 'test@test.local', ...env }
  }).toString();
}

/** 提交一个文件，date 形如 2026-09-26T00:01:00（同时控制 author/committer 时间保证剪枝语义稳定） */
function commit(repo, file, content, message, date) {
  fsSync.writeFileSync(path.join(repo, file), content);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date
  });
}

test.before(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'glwt-delivered-via-'));
  const repo = path.join(fixtureRoot, 'repo');
  fs.mkdir(repo);
  git(repo, ['init', '-q', '-b', 'main']);

  // 主干基线
  commit(repo, 'README.md', '# 基线\n', 'init: 基线', '2026-09-26T00:01:00');

  // 开发分支 A：从 main 分叉提交 f1/f2（未来的「过时快照」）
  git(repo, ['checkout', '-q', '-b', 'feature-base']);
  commit(repo, 'f1.txt', '功能一\n', 'feat: 功能一', '2026-09-26T00:02:00');
  commit(repo, 'f2.txt', '功能二\n', 'feat: 功能二', '2026-09-26T00:03:00');

  // 载体分支 carrier：基于 A 继续开发（包含 A 的全部提交 + 独有提交），
  // 并后续演化修改 A 的产出（模拟真实 PR 流程中的验收修复覆盖开发分支代码——
  // 唯有如此 A 的原始快照合并回 main 才会产生变化，merge-tree 判定失效，
  // 这正是传递吸收判定要覆盖的场景）
  git(repo, ['checkout', '-q', '-b', 'carrier']);
  commit(repo, 'c1.txt', '载体独有\n', 'feat: 载体独有提交', '2026-09-26T00:04:00');
  commit(repo, 'f1.txt', '功能一（已由后续修复演化）\n', 'fix: 演化功能一实现', '2026-09-26T00:04:30');

  // main 以 squash 方式吸收 carrier（模拟 GitHub PR squash merge）
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['merge', '--squash', 'carrier']);
  git(repo, ['commit', '-m', 'feat: squash 合入 carrier'], {
    GIT_AUTHOR_DATE: '2026-09-26T00:05:00',
    GIT_COMMITTER_DATE: '2026-09-26T00:05:00'
  });

  // 对照分支 U：squash 之后从 main 分叉的真实领先（无载体可达）
  git(repo, ['checkout', '-q', '-b', 'unrelated']);
  commit(repo, 'u1.txt', '真领先\n', 'feat: 真实独有提交', '2026-09-26T00:06:00');

  // 对照分支 D/ absorbed-early：早时间已被 cherry-pick 吸收的分支（验证时间剪枝不误标）
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['checkout', '-q', '-b', 'early-absorbed']);
  commit(repo, 'd1.txt', '早期内容\n', 'feat: 早期提交', '2026-09-26T00:06:30');
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['cherry-pick', 'early-absorbed'], {
    GIT_AUTHOR_DATE: '2026-09-26T00:07:00',
    GIT_COMMITTER_DATE: '2026-09-26T00:07:00'
  });

  repoPath = repo;
});

test.after(async () => {
  if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
});

test('载体分支：squash 吸收后四方判定通过（树等价），不被标记传递交付', async () => {
  const { branches } = await getBranches(repoPath);
  const carrier = branches.find(b => b.name === 'carrier');
  assert.equal(carrier.isMerged, true, 'carrier 应被四方判定吸收（树等价）');
  assert.equal(carrier.deliveredViaBranch, undefined, 'carrier 自身已吸收，无需传递标记');
  assert.equal(carrier.isSafeToDelete, true);
});

test('过时快照（分支面板）：分层防御保证交付结论——历史整合推断或传递判定二者必有其一', async () => {
  const { branches } = await getBranches(repoPath);
  const a = branches.find(b => b.name === 'feature-base');
  if (a.isMerged) {
    // 历史整合推断（findHistoricalIntegration）先行吸收：main 侧的 squash 提交
    // 覆盖了分支全部改动路径，分支面板显示「内容已合入主干」
    assert.equal(a.isSafeToDelete, true, '无 Worktree 引用时应安全可删');
  } else {
    // 历史整合推断未覆盖时（如产出被演化的时序不满足），传递判定兜底标记载体
    assert.equal(a.deliveredViaBranch, 'carrier', '应识别载体为 carrier');
    assert.equal(a.isSafeToDelete, true, '无 Worktree 引用的过时快照应安全可删');
    assert.match(a.redundancyReason, /carrier/);
    assert.match(a.redundancyReason, /过时快照/);
  }
});

test('真实领先：unrelated 分支无载体可达，不标记', async () => {
  const { branches } = await getBranches(repoPath);
  const u = branches.find(b => b.name === 'unrelated');
  assert.equal(u.isMerged, false);
  assert.equal(u.deliveredViaBranch, undefined, '真领先分支不能被误标');
  assert.equal(u.isSafeToDelete, false);
});

test('时间剪枝：早吸收分支晚于真领先分支的 tip 时，不产生误标', async () => {
  const { branches } = await getBranches(repoPath);
  // unrelated 的 tip（00:06:00）早于 early-absorbed 的 tip（00:06:30），
  // 但 unrelated ⊄ early-absorbed：时间剪枝通过后仍会被祖先判定拦下
  const u = branches.find(b => b.name === 'unrelated');
  assert.equal(u.deliveredViaBranch, undefined);
  const d = branches.find(b => b.name === 'early-absorbed');
  assert.equal(d.isMerged, true, 'early-absorbed 应被 cherry-pick 吸收判定吸收');
});

test('Worktree 绑定：过时快照被标记但不可标安全删除（先解绑再删）', async () => {
  const repo = repoPath;
  const wtPath = path.join(fixtureRoot, 'wt-feature-base');
  git(repo, ['worktree', 'add', wtPath, 'feature-base']);
  try {
    const { branches } = await getBranches(repo);
    const a = branches.find(b => b.name === 'feature-base');
    assert.equal(a.inUseByWorktree, true);
    assert.equal(a.isSafeToDelete, false, '有 Worktree 引用时不可标安全删除');
  } finally {
    git(repo, ['worktree', 'remove', '--force', wtPath]);
  }
});

test('worktree 面板兜底：hasCommittedDiff 的过时快照经 annotateDeliveredViaWorktrees 标记载体', async () => {
  const repo = repoPath;
  const wtPath = path.join(fixtureRoot, 'wt-feature-base2');
  git(repo, ['worktree', 'add', wtPath, 'feature-base']);
  try {
    const worktrees = await getWorktrees(repo);
    const { branches } = await getBranches(repo);
    const branch = branches.find(b => b.name === 'feature-base');
    // worktree 面板初始只按提交图计算，历史整合分支会暂时复现「领先」显示。
    const wt = worktrees.find(w => w.branch === 'feature-base');
    assert.equal(wt.hasCommittedDiff, true, '四方判定应视 feature-base 为领先（复现用户所见）');
    assert.equal(wt.deliveredViaBranch, undefined, '传播前未标记');

    annotateWorktreesFromBranches(worktrees, branches);
    if (branch.mergeType === 'historical') {
      assert.equal(wt.aheadCount, 0, '历史整合分支不应继续显示机械领先提交数');
      assert.equal(wt.hasCommittedDiff, false, '历史整合分支不应继续显示已提交差异');
      assert.equal(wt.isContentEqualToMain, true, '历史整合结论应同步到 Worktree');
    }
    await annotateDeliveredViaWorktrees(repo, worktrees, branches);
    if (branch.mergeType !== 'historical') {
      assert.equal(wt.deliveredViaBranch, 'carrier', '兜底探测应识别载体 carrier');
    }

    // 对照：真实领先的 worktree（unrelated）不得被标记
    git(repo, ['worktree', 'add', path.join(fixtureRoot, 'wt-unrelated'), 'unrelated']);
    try {
      const worktrees2 = await getWorktrees(repo);
      await annotateDeliveredViaWorktrees(repo, worktrees2, branches);
      const uwt = worktrees2.find(w => w.branch === 'unrelated');
      assert.equal(uwt.deliveredViaBranch, undefined, '真领先 worktree 不能被误标');
    } finally {
      git(repo, ['worktree', 'remove', '--force', path.join(fixtureRoot, 'wt-unrelated')]);
    }
  } finally {
    git(repo, ['worktree', 'remove', '--force', wtPath]);
  }
});

test('独立导出函数可单独驱动（不经过 getBranches 的注入路径）', async () => {
  const repo = repoPath;
  // 手工构造最小分支集：carrier 已吸收、feature-base 未吸收
  const branchList = [
    { name: 'main', isMain: true, isMerged: true, inUseByWorktree: false, committerTs: 100 },
    { name: 'carrier', isMain: false, isMerged: true, inUseByWorktree: false, committerTs: 90 },
    { name: 'feature-base', isMain: false, isMerged: false, inUseByWorktree: false, committerTs: 50 }
  ];
  await annotateDeliveredViaBranches(repo, branchList);
  assert.equal(branchList[2].deliveredViaBranch, 'carrier');

  // worktree 传播：按分支名匹配写入
  const worktrees = [{ branch: 'feature-base', path: '/tmp/x' }, { branch: 'main', path: '/tmp/m' }];
  annotateWorktreesFromBranches(worktrees, branchList);
  assert.equal(worktrees[0].deliveredViaBranch, 'carrier');
  assert.equal(worktrees[1].deliveredViaBranch, undefined);
});
