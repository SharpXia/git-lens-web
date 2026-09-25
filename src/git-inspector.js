import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';

const exec = promisify(execFile);

/**
 * 执行 git 命令辅助函数 (返回字符串)
 */
async function runGit(cwd, args) {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    throw new Error(`Git error in ${cwd}: ${err.message}`);
  }
}

/**
 * 执行 git 命令辅助函数 (返回二进制 Buffer)
 */
function runGitRaw(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.toString() || err.message));
      resolve(stdout);
    });
  });
}

/**
 * 执行 Git 命令并保留退出状态，适合检查“有冲突”这类预期失败结果。
 */
function runGitResult(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: stdout || '',
        stderr: stderr || ''
      });
    });
  });
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);

export function isImageFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif'
};

export function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

/**
 * 获取 Git 提交或工作区中的文件二进制 Buffer
 */
export async function getFileContentBuffer(repoPath, revision, filePath, worktreePath = null) {
  // 如果指定了 worktreePath 且 revision 是 'WORKTREE'，直接从磁盘读取工作区最新文件
  if (revision === 'WORKTREE' && worktreePath) {
    const full = path.resolve(worktreePath, filePath);
    try {
      return await fs.readFile(full);
    } catch {
      return null;
    }
  }

  // 否则通过 git show 从对应版本获取
  try {
    const targetCwd = worktreePath || repoPath;
    const buf = await runGitRaw(targetCwd, ['show', `${revision}:${filePath}`]);
    return buf;
  } catch {
    return null;
  }
}

/**
 * 检查路径是否是有效的 Git 仓库
 */
export async function isGitRepo(targetPath) {
  try {
    const gitDir = path.join(targetPath, '.git');
    const stat = await fs.stat(gitDir);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

/**
 * 检查指定分支是否存在于本地
 */
export async function checkBranchExists(repoPath, branchName) {
  try {
    const branches = await runGit(repoPath, ['branch', '--list', branchName]);
    const list = branches.split('\n').map(b => b.replace('*', '').trim()).filter(Boolean);
    return list.includes(branchName);
  } catch {
    return false;
  }
}

/**
 * 检查指定 Worktree 是否仍登记在仓库中
 */
export async function checkWorktreeExists(repoPath, worktreePath) {
  try {
    const output = await runGit(repoPath, ['worktree', 'list', '--porcelain']);
    const lines = output.split('\n');
    const targetNorm = path.resolve(worktreePath);
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        const p = path.resolve(line.slice(9).trim());
        if (p === targetNorm) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 获取 Worktrees 详情列表
 */
export async function getWorktrees(repoPath) {
  const output = await runGit(repoPath, ['worktree', 'list', '--porcelain']);
  if (!output) return [];

  const lines = output.split('\n');
  const worktrees = [];
  let current = {};

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current);
      current = { path: line.slice(9).trim(), isMain: false, isLocked: false };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).replace('refs/heads/', '').trim();
    } else if (line.startsWith('bare')) {
      current.bare = true;
    } else if (line.startsWith('locked')) {
      current.isLocked = true;
    } else if (line.startsWith('prunable')) {
      current.isPrunable = true;
    }
  }
  if (current.path) worktrees.push(current);

  // 第一条通常为主工作区
  if (worktrees.length > 0) {
    worktrees[0].isMain = true;
  }

  // 检查每个 worktree 的存在性和最后提交时间
  for (const wt of worktrees) {
    try {
      const stat = await fs.stat(wt.path);
      wt.existsOnDisk = true;
      wt.mtime = stat.mtime;

      // 提取最后提交信息
      const log = await runGit(wt.path, ['log', '-1', '--format=%cr|%an|%s']);
      if (log) {
        const [relativeTime, author, subject] = log.split('|');
        wt.lastCommit = { relativeTime, author, subject };
      }

      // 检查工作区 dirty 状态
      const status = await runGit(wt.path, ['status', '--porcelain']);
      wt.isDirty = status.length > 0;
      wt.dirtyCount = status ? status.split('\n').filter(Boolean).length : 0;
    } catch {
      wt.existsOnDisk = false;
      wt.isPrunable = true;
    }
  }

  // 并发检查每个分支与 Main 的提交历史及最终文件内容。
  const mainWt = worktrees.find(w => w.isMain);
  const mainRef = (mainWt && (mainWt.branch || mainWt.head)) || 'main';
  let mainTree = null;
  try {
    mainTree = await runGit(repoPath, ['rev-parse', `${mainRef}^{tree}`]);
  } catch {
    // 主分支引用不可解析时，保留历史计数作为降级结果。
  }

  await Promise.all(worktrees.map(async (wt) => {
    if (wt.isMain) {
      wt.aheadCount = 0;
      wt.historyAheadCount = 0;
      wt.isContentEqualToMain = true;
      wt.hasDiff = wt.isDirty;
      return;
    }
    const targetRef = wt.branch || wt.head;
    if (!targetRef) {
      wt.aheadCount = 0;
      wt.historyAheadCount = 0;
      wt.hasDiff = wt.isDirty;
      return;
    }
    try {
      const countStr = await runGit(repoPath, ['rev-list', '--count', `${mainRef}..${targetRef}`]);
      wt.historyAheadCount = parseInt(countStr.trim(), 10) || 0;
    } catch {
      wt.historyAheadCount = 0;
    }
    // 内容等价判定（与提交抽屉徽章同一套 getBranchMergeStatus 四方判定）：
    // 只做树一致比较会把「revert 抵消后主干已前移」「提交被 cherry-pick 进主干」
    // 误判为仍有领先改动（树因主干其他提交而不同）。
    // 真实案例 2026-09-25：append-verification-line 误显领先 2、add-mit-license 误显领先 1
    let isMerged = false;
    if (wt.historyAheadCount === 0) {
      // 无领先提交即祖先关系（或与主干一致），不存在独有改动
      isMerged = true;
    } else if (mainTree) {
      try {
        const mergeStatus = await getBranchMergeStatus(repoPath, mainRef, targetRef);
        isMerged = mergeStatus.isMerged;
      } catch {
        isMerged = false;
      }
    }
    wt.isContentEqualToMain = isMerged;
    // 分支改动已被主干吸收时，不存在属于它的已提交差异；
    // 主干引用不可解析（mainTree 为空）时不做有差异的断言
    wt.hasCommittedDiff = Boolean(mainTree) && !isMerged && wt.historyAheadCount > 0;
    // squash/revert/cherry-pick 吸收后提交 SHA 不同但无实际差异；只有确有独有改动时才显示领先
    wt.aheadCount = isMerged ? 0 : wt.historyAheadCount;
    wt.hasDiff = wt.isDirty || wt.hasCommittedDiff || wt.aheadCount > 0;
  }));

  return worktrees;
}

/**
 * 获取当前主工作区对应的比较分支。
 * 同一仓库可能长期在版本分支开发，origin/HEAD 未必是当前要观察的主干。
 */
async function detectMainBranch(repoPath, worktrees = null) {
  const mainWorktree = (worktrees || await getWorktrees(repoPath)).find(wt => wt.isMain && wt.branch);
  if (mainWorktree) return mainWorktree.branch;

  let mainBranch = 'main';
  try {
    const symref = await runGit(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    mainBranch = symref.split('/').pop() || 'main';
  } catch {
    const branches = await runGit(repoPath, ['branch', '--list']);
    if (branches.includes('main')) mainBranch = 'main';
    else if (branches.includes('master')) mainBranch = 'master';
  }
  return mainBranch;
}

/**
 * 分析分支是否已经可以安全地从本地引用中移除。
 *
 * 仅依赖 `branch --merged` 会漏掉经过协调分支、cherry-pick 或 squash 合入的改动。
 * 这里同时检查提交祖先关系、最终树内容和补丁等价性，避免把已完整合入的并行分支
 * 误标成“未合并”。
 */
export async function getBranchMergeStatus(repoPath, mainBranch, branchName) {
  let isDirectlyMerged = false;
  try {
    await runGit(repoPath, ['merge-base', '--is-ancestor', branchName, mainBranch]);
    isDirectlyMerged = true;
  } catch {
    // 非祖先关系并不代表改动未合入，继续检查内容和补丁。
  }

  let isTreeEqual = false;
  try {
    const [mainTree, branchTree] = await Promise.all([
      runGit(repoPath, ['rev-parse', `${mainBranch}^{tree}`]),
      runGit(repoPath, ['rev-parse', `${branchName}^{tree}`])
    ]);
    isTreeEqual = mainTree === branchTree;
  } catch {
    // 引用失效或仓库状态异常时按未合入处理。
  }

  let isPatchEquivalent = false;
  try {
    const cherryOutput = await runGit(repoPath, ['cherry', mainBranch, branchName]);
    const cherryLines = cherryOutput.split('\n').map(line => line.trim()).filter(Boolean);
    const mergeCommits = await runGit(repoPath, ['rev-list', '--merges', `${mainBranch}..${branchName}`]);
    // `-` 表示该提交的补丁已在主分支中，`+` 才是仍未被吸收的独有补丁。
    // `git cherry` 不展开 merge commit；存在未进入主分支的 merge commit 时，不能只凭空输出误判。
    isPatchEquivalent = !mergeCommits && cherryLines.every(line => !line.startsWith('+'));
  } catch {
    // 没有共同基线或引用不可解析时，不能仅凭补丁结果判定安全。
  }

  let isMergeTreeEqual = false;
  try {
    // 三方合并会把主分支作为当前结果，能识别多次提交被 squash 或协调分支汇总的情况。
    // 只有合并无冲突且结果树与主分支完全一致时，才视为分支改动已全部被吸收。
    const mergeResult = await runGitResult(repoPath, ['merge-tree', '--write-tree', mainBranch, branchName]);
    if (mergeResult.ok) {
      const mergeTree = mergeResult.stdout.trim().split(/\s+/)[0];
      const mainTree = await runGit(repoPath, ['rev-parse', `${mainBranch}^{tree}`]);
      isMergeTreeEqual = Boolean(mergeTree) && mergeTree === mainTree;
    }
  } catch {
    // 老版本 Git 不支持 merge-tree --write-tree 时，保留前面的判断结果。
  }

  const isMergedByContent = isTreeEqual || isPatchEquivalent || isMergeTreeEqual;
  const isMerged = isDirectlyMerged || isMergedByContent;
  let mergeType = 'unmerged';
  if (isDirectlyMerged) mergeType = 'direct';
  else if (isTreeEqual) mergeType = 'tree';
  else if (isMergeTreeEqual) mergeType = 'merge-tree';
  else if (isPatchEquivalent) mergeType = 'patch';

  return {
    isMerged,
    isDirectlyMerged,
    isMergedByContent,
    isTreeEqual,
    isPatchEquivalent,
    isMergeTreeEqual,
    mergeType
  };
}

/**
 * 比较分支相对共同基线改过的文件，给未合入分支提供可核查的内容证据。
 * @param {string} repoPath 仓库路径
 * @param {string} mainBranch 当前主工作区分支
 * @param {string} branchName 待检查分支
 * @returns {Promise<object|null>} 改动文件数量、一致数量及仍有差异的路径
 */
async function compareBranchChangedFiles(repoPath, mainBranch, branchName) {
  try {
    const base = await runGit(repoPath, ['merge-base', mainBranch, branchName]);
    const changedRaw = await runGitRaw(repoPath, ['diff', '--name-only', '-z', base, branchName]);
    const changedPaths = changedRaw.toString('utf8').split('\0').filter(Boolean);
    if (!changedPaths.length) return { changedCount: 0, equalCount: 0, differentPaths: [] };

    const differentRaw = await runGitRaw(repoPath, [
      'diff', '--name-only', '-z', mainBranch, branchName, '--', ...changedPaths
    ]);
    const differentPaths = differentRaw.toString('utf8').split('\0').filter(Boolean);
    return {
      changedCount: changedPaths.length,
      equalCount: changedPaths.length - differentPaths.length,
      differentPaths
    };
  } catch {
    return null;
  }
}

/**
 * 读取一段提交范围内每个普通提交直接改过的路径。
 * 已经通过正常 merge 进入主分支的分支会由祖先关系判断；这里跳过 merge commit，
 * 避免把合并两个大型分支时产生的全量路径误当成某个分支的整合证据。
 */
async function getCommitPathLog(repoPath, range) {
  const output = await runGit(repoPath, ['log', '--no-merges', '--format=%H|%ct', '--name-only', '--no-renames', range]);
  const commits = [];
  const bySha = new Map();
  let current = null;
  for (const line of output.split('\n')) {
    const header = line.match(/^([0-9a-f]{40})\|(\d+)$/);
    if (header) {
      current = bySha.get(header[1]);
      if (!current) {
        current = { sha: header[1], timestamp: Number(header[2]), paths: new Set() };
        bySha.set(header[1], current);
        commits.push(current);
      }
      continue;
    }
    if (current && line.trim()) current.paths.add(line.trim());
  }
  return commits;
}

/**
 * 判断当前主分支是否存在“历史整合提交”：该提交覆盖了分支全部改动路径，
 * 且当前仍有差异的路径都能由整合提交或其后的主分支提交解释。它用于识别
 * squash/协调合入后的正常演进，避免把后续修订误报成未合入。
 */
async function findHistoricalIntegration(repoPath, mainBranch, branchName, historyCache) {
  try {
    const base = await runGit(repoPath, ['merge-base', mainBranch, branchName]);
    const changedPaths = (await runGit(repoPath, ['diff', '--name-only', base, branchName]))
      .split('\n').map(p => p.trim()).filter(Boolean);
    if (!changedPaths.length) return null;

    let history = historyCache.get(base);
    if (!history) {
      history = await getCommitPathLog(repoPath, `${base}..${mainBranch}`);
      historyCache.set(base, history);
    }
    const branchTipTimestamp = Number(await runGit(repoPath, ['show', '-s', '--format=%ct', branchName]));

    const branchPathSet = new Set(changedPaths);
    const currentDifferencePaths = (await runGit(repoPath, ['diff', '--name-only', mainBranch, branchName]))
      .split('\n').map(p => p.trim()).filter(filePath => filePath && branchPathSet.has(filePath));

    // history 按 git log 默认顺序排列为“新到旧”。从旧到新寻找第一个覆盖
    // 分支改动的提交，后续演进只统计它之后的主分支提交，避免把主分支中与
    // 该分支无关的文件差异算进来。
    for (let candidateIndex = history.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const commit = history[candidateIndex];
      if (commit.timestamp < branchTipTimestamp) continue;
      if (!changedPaths.every(filePath => commit.paths.has(filePath))) continue;

      const laterEvolutionPaths = new Set();
      for (let laterIndex = 0; laterIndex < candidateIndex; laterIndex += 1) {
        for (const filePath of history[laterIndex].paths) {
          if (branchPathSet.has(filePath)) laterEvolutionPaths.add(filePath);
        }
      }
      const explainedPaths = currentDifferencePaths.filter(filePath =>
        commit.paths.has(filePath) || laterEvolutionPaths.has(filePath)
      );
      const unexplainedPaths = currentDifferencePaths.filter(filePath => !explainedPaths.includes(filePath));
      return {
        integrationCommit: commit.sha,
        changedPaths,
        currentDifferencePaths,
        explainedPaths,
        unexplainedPaths,
        laterEvolutionPaths: [...laterEvolutionPaths]
      };
    }
  } catch {
    // 历史不完整、引用失效或 Git 版本能力不足时不提供推断结果。
  }
  return null;
}

/**
 * 获取分支列表及冗余分析
 */
export async function getBranches(repoPath) {
  const worktrees = await getWorktrees(repoPath);
  const mainBranch = await detectMainBranch(repoPath, worktrees);
  const historyCache = new Map();

  let mergedBranches = [];
  try {
    const mergedOut = await runGit(repoPath, ['branch', '--merged', mainBranch]);
    mergedBranches = mergedOut.split('\n').map(b => b.replace('*', '').trim()).filter(Boolean);
  } catch {
    // ignore
  }

  const activeWorktreeBranches = new Set(worktrees.map(w => w.branch).filter(Boolean));

  const format = '%(refname:short)|%(authordate:relative)|%(authorname)|%(subject)|%(committerdate:iso8601)';
  const rawBranches = await runGit(repoPath, ['for-each-ref', '--format=' + format, 'refs/heads/']);

  const branchRecords = [];
  for (const line of rawBranches.split('\n')) {
    if (!line.trim()) continue;
    const [name, relativeTime, author, subject, isoDate] = line.split('|');

    const isMain = name === mainBranch || name === 'master' || name === 'dev';
    branchRecords.push({ name, relativeTime, author, subject, isoDate, isMain });
  }

  const branchList = await Promise.all(branchRecords.map(async ({ name, relativeTime, author, subject, isoDate, isMain }) => {
    const directMergedByGit = mergedBranches.includes(name);
    const mergeStatus = isMain
      ? {
        isMerged: true,
        isDirectlyMerged: true,
        isMergedByContent: true,
        isTreeEqual: true,
        isPatchEquivalent: true,
        isMergeTreeEqual: true,
        mergeType: 'direct'
      }
      : await getBranchMergeStatus(repoPath, mainBranch, name);
    // 保留 `branch --merged` 作为兼容性证据；祖先检查是同一语义的更明确实现。
    const isMerged = directMergedByGit || mergeStatus.isMerged;
    const isDirectlyMerged = directMergedByGit || mergeStatus.isDirectlyMerged;
    const inUseByWorktree = activeWorktreeBranches.has(name);
    let contentComparison = null;
    let historicalIntegration = null;
    if (!isMain && !isMerged) {
      contentComparison = await compareBranchChangedFiles(repoPath, mainBranch, name);
      historicalIntegration = await findHistoricalIntegration(repoPath, mainBranch, name, historyCache);
    }
    const isHistoricallyMerged = Boolean(
      historicalIntegration && historicalIntegration.unexplainedPaths.length === 0
    );
    const effectiveIsMerged = isMerged || isHistoricallyMerged;
    const effectiveIsDirectlyMerged = isDirectlyMerged;

    const daysOld = Math.floor((Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24));
    const isStale = !isMain && daysOld > 30;
    const isSafeToDelete = !isMain && effectiveIsMerged && !inUseByWorktree;
    const isStaleOnly = isStale && !isSafeToDelete && !inUseByWorktree;

    let redundancyReason = null;
    if (!isMain) {
      if (isSafeToDelete) {
        if (effectiveIsDirectlyMerged) {
          redundancyReason = '已合并至主分支且无 Worktree 引用 (安全可删)';
        } else if (mergeStatus.isTreeEqual || mergeStatus.isMergeTreeEqual) {
          redundancyReason = '分支改动已通过协调分支合入，合并结果与主分支一致 (安全可删)';
        } else if (isHistoricallyMerged) {
          redundancyReason = `历史整合提交 ${historicalIntegration.integrationCommit.slice(0, 8)} 已覆盖分支改动路径，当前差异均可由后续主分支演进解释 (安全可删)`;
        } else {
          redundancyReason = '分支提交补丁已等价合入主分支，且无 Worktree 引用 (安全可删)';
        }
      } else if (isStaleOnly) {
        redundancyReason = `超过 ${daysOld} 天未活动陈旧分支`;
      }
    }

    return {
      name,
      relativeTime,
      author,
      subject,
      daysOld,
      isMain,
      isMerged: effectiveIsMerged,
      isDirectlyMerged: effectiveIsDirectlyMerged,
      isMergedByContent: mergeStatus.isMergedByContent || isHistoricallyMerged,
      isTreeEqual: mergeStatus.isTreeEqual,
      isPatchEquivalent: mergeStatus.isPatchEquivalent,
      isMergeTreeEqual: mergeStatus.isMergeTreeEqual,
      mergeType: isHistoricallyMerged ? 'historical' : (isDirectlyMerged ? 'direct' : mergeStatus.mergeType),
      contentComparison,
      historicalIntegration,
      inUseByWorktree,
      isStale,
      isSafeToDelete,
      isStaleOnly,
      redundancyReason
    };
  }));

  return { mainBranch, branches: branchList };
}

/**
 * 清理冗余分支
 */
export async function deleteBranch(repoPath, branchName, force = false) {
  // 内容已合入但提交祖先关系不成立时，Git 的 `-d` 仍会拒绝删除。
  // 先重新核验这类分支，再使用 `-D`，避免依赖过期页面状态或误删未合入分支。
  let effectiveForce = Boolean(force);
  if (!effectiveForce) {
    const worktrees = await getWorktrees(repoPath);
    const mainBranch = await detectMainBranch(repoPath, worktrees);
    const mergeStatus = await getBranchMergeStatus(repoPath, mainBranch, branchName);
    effectiveForce = mergeStatus.isMergedByContent && !mergeStatus.isDirectlyMerged;
    if (!effectiveForce) {
      const historicalIntegration = await findHistoricalIntegration(repoPath, mainBranch, branchName, new Map());
      effectiveForce = Boolean(
        historicalIntegration && historicalIntegration.unexplainedPaths.length === 0
      );
    }
  }
  const flag = effectiveForce ? '-D' : '-d';
  await runGit(repoPath, ['branch', flag, branchName]);
  const stillExists = await checkBranchExists(repoPath, branchName);
  return { deleted: !stillExists, branchName };
}

/**
 * 移除 Worktree
 */
export async function removeWorktree(repoPath, worktreePath, force = false) {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktreePath);
  await runGit(repoPath, args);
  const stillExists = await checkWorktreeExists(repoPath, worktreePath);
  return { removed: !stillExists, worktreePath };
}

/**
 * 执行 worktree prune (清理无效的元数据引用)
 */
export async function pruneWorktrees(repoPath) {
  return await runGit(repoPath, ['worktree', 'prune']);
}

/**
 * 将 unified diff 拆分为按文件归类的映射表
 */
function splitDiffByFiles(rawDiff) {
  const fileDiffs = {};
  if (!rawDiff) return fileDiffs;

  const chunks = rawDiff.split(/^(?=diff --git )/m);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const m = chunk.match(/^diff --git a\/(.+?) b\/(.+?)(?:\r?\n|$)/m);
    if (m) {
      const filePath = m[2];
      fileDiffs[filePath] = chunk;
    }
  }
  return fileDiffs;
}

/**
 * 获取两个 Worktree 之间或目标工作区的 Diff，支持三种模式：
 * 1. 'uncommitted': 仅未提交以及 untracked
 * 2. 'all': 提交和未提交以及 untracked (全量)
 * 3. 'committed': 仅已提交 (忽略未提交及 untracked)
 *
 * 智能回退优先级：
 * 默认优先 'uncommitted'（如果有脏代码或新增未跟踪）；
 * 若无，fallback 到 'all'（如果有实际文件差异）；
 * 最低优先级为 'committed'。
 */
export async function getWorktreeDiff(repoPath, sourcePath, targetPath, requestedMode = null) {
  const worktrees = await getWorktrees(repoPath);
  const sourceWt = worktrees.find(w => path.resolve(w.path) === path.resolve(sourcePath));
  const targetWt = worktrees.find(w => path.resolve(w.path) === path.resolve(targetPath));

  if (!sourceWt || !targetWt) {
    throw new Error('指定的 Worktree 路径不存在或未被 Git 登记');
  }

  const isSameWorktree = path.resolve(sourceWt.path) === path.resolve(targetWt.path);

  // 特殊场景：分支自己和自己 diff（工作区自审查模式）
  // 此时仅允许且锁定【仅未提交以及未跟踪】模式，其它模式不可用
  if (isSameWorktree) {
    const uncommittedData = await getUncommittedDiff(targetWt.path);
    const uncommittedFiles = uncommittedData.files || [];
    return {
      isSameWorktree: true,
      source: {
        path: sourceWt.path,
        branch: sourceWt.branch || 'HEAD',
        head: sourceWt.head,
        isMain: sourceWt.isMain,
        isDirty: sourceWt.isDirty,
        lastCommit: sourceWt.lastCommit
      },
      target: {
        path: targetWt.path,
        branch: targetWt.branch || 'HEAD',
        head: targetWt.head,
        isMain: targetWt.isMain,
        isDirty: targetWt.isDirty,
        lastCommit: targetWt.lastCommit
      },
      ahead: 0,
      behind: 0,
      effectiveMode: 'uncommitted',
      modesAvailable: {
        uncommitted: true,
        all: false,
        committed: false
      },
      counts: {
        uncommitted: uncommittedFiles.length,
        all: uncommittedFiles.length,
        committed: 0
      },
      files: uncommittedFiles
    };
  }

  const sourceRef = sourceWt.branch || sourceWt.head || 'HEAD';
  const targetRef = targetWt.branch || targetWt.head || 'HEAD';

  // 1. 提交计数只描述历史关系；squash 后 SHA 会不同，但最终文件内容可能完全一致。
  let historyAhead = 0;
  let historyBehind = 0;
  try {
    const revCounts = await runGit(repoPath, ['rev-list', '--left-right', '--count', `${sourceRef}...${targetRef}`]);
    const parts = revCounts.trim().split(/\s+/).map(Number);
    if (parts.length >= 2) {
      historyBehind = parts[0];
      historyAhead = parts[1];
    }
  } catch {
    // ignore
  }
  const sourceTree = await runGit(repoPath, ['rev-parse', `${sourceRef}^{tree}`]);
  const targetTree = await runGit(repoPath, ['rev-parse', `${targetRef}^{tree}`]);
  const isCommittedContentEqual = sourceTree === targetTree;

  // 独有改动判定：树一致只是最严格的一种。Target 的提交被 cherry-pick 进 Source、
  // revert 相互抵消、或合并结果与 Source 一致时，树仍会因 Source 其他提交而不同，
  // 但 Target 已没有需要展示的独有改动——其 Diff 内容在 Source 里已经存在。
  // 与 worktree 列表/提交抽屉徽章复用同一套 getBranchMergeStatus 四方判定。
  // 真实案例 2026-09-25：add-mit-license 的 LICENSE 已 cherry-pick 进 main，
  // Diff 详情页仍把 merge-base..branch 的 LICENSE 当 Target 改动展示
  let isTargetAbsorbedBySource = isCommittedContentEqual;
  if (!isCommittedContentEqual && historyAhead > 0) {
    try {
      const mergeStatus = await getBranchMergeStatus(repoPath, sourceRef, targetRef);
      isTargetAbsorbedBySource = mergeStatus.isMerged;
    } catch {
      // 判定失败时保持 false，退回原来的树比较行为
    }
  }
  const ahead = isTargetAbsorbedBySource ? 0 : historyAhead;
  const behind = isCommittedContentEqual ? 0 : historyBehind;

  // 文件 Diff 只展示 Target 一侧的提交。Target 没有领先提交、或改动已被 Source
  // 吸收（cherry-pick/revert 抵消/squash）时，不产生属于 Target 的文件 Diff。
  const hasTargetCommittedChanges = historyAhead > 0 && !isTargetAbsorbedBySource;
  let targetDiffBase = targetRef;
  if (hasTargetCommittedChanges) {
    try {
      // 分叉场景以共同祖先为基准，避免把 Main 独有提交混入 Target Diff。
      targetDiffBase = await runGit(repoPath, ['merge-base', sourceRef, targetRef]);
    } catch {
      // 无共同祖先时没有三点语义可用，退回 Source 作为比较基准。
      targetDiffBase = sourceRef;
    }
  }

  // 2. 检查 Target 工作区自身的未提交/未跟踪改动
  const uncommittedData = await getUncommittedDiff(targetWt.path);
  const hasUncommitted = (uncommittedData.files && uncommittedData.files.length > 0);

  // 3. 计算【仅已提交】(committed) 的 diff
  let committedDiff = '';
  if (hasTargetCommittedChanges) {
    try {
      committedDiff = await runGit(repoPath, ['diff', '-p', '-U3', targetDiffBase, targetRef]);
    } catch (err) {
      committedDiff = `获取 Diff 失败: ${err.message}`;
    }
  }
  const committedFileMap = splitDiffByFiles(committedDiff);
  const committedFiles = [];
  try {
    const numstatOut = hasTargetCommittedChanges
      ? await runGit(repoPath, ['diff', '--numstat', targetDiffBase, targetRef])
      : '';
    for (const line of numstatOut.split('\n')) {
      if (!line.trim()) continue;
      const [added, deleted, filePath] = line.split('\t');
      const isImg = isImageFile(filePath);
      const isBin = isImg || added === '-' || deleted === '-';
      committedFiles.push({
        filePath,
        status: 'M',
        added: isBin ? 0 : (added === '-' ? 0 : parseInt(added, 10)),
        deleted: isBin ? 0 : (deleted === '-' ? 0 : parseInt(deleted, 10)),
        isBinary: isBin,
        isImage: isImg,
        diffChunk: committedFileMap[filePath] || ''
      });
    }
  } catch {}

  const hasCommitted = committedFiles.length > 0;

  // 4. 计算【全量：已提交 + 未提交 + untracked】(all)。
  // 领先分支以共同祖先为基准；落后分支以自身 HEAD 为基准，只保留本地未提交修改。
  let allFiles = [];
  try {
      const allNumstat = await runGit(targetWt.path, ['diff', targetDiffBase, '--numstat']);
      const allDiffRaw = await runGit(targetWt.path, ['diff', targetDiffBase, '-p', '-U3']);
      const allDiffMap = splitDiffByFiles(allDiffRaw);
      const seenAll = new Set();

      for (const line of allNumstat.split('\n')) {
        if (!line.trim()) continue;
        const [added, deleted, filePath] = line.split('\t');
        seenAll.add(filePath);
        const isImg = isImageFile(filePath);
        const isBin = isImg || added === '-' || deleted === '-';
        allFiles.push({
          filePath,
          status: 'M',
          added: isBin ? 0 : (added === '-' ? 0 : parseInt(added, 10)),
          deleted: isBin ? 0 : (deleted === '-' ? 0 : parseInt(deleted, 10)),
          isBinary: isBin,
          isImage: isImg,
          diffChunk: allDiffMap[filePath] || ''
        });
      }

      // 把 untracked 补入 allFiles
      if (uncommittedData.files) {
        for (const uf of uncommittedData.files) {
          if (uf.status === '?' && !seenAll.has(uf.filePath)) {
            allFiles.push(uf);
          }
        }
      }
  } catch {
    allFiles = committedFiles;
  }

  // 5. 决定有效模式 (有效优先级策略)
  // 用户指定了有效模式则优先遵从；若未指定或自动判断：
  // 优先级 1: uncommitted (仅未提交以及 untracked，如果有的话)
  // 优先级 2: all (提交和未提交以及 untracked)
  // 优先级 3: committed (仅含已提交)
  let effectiveMode = requestedMode;
  if (!effectiveMode || !['uncommitted', 'all', 'committed'].includes(effectiveMode)) {
    if (hasUncommitted) {
      effectiveMode = 'uncommitted';
    } else if (hasCommitted || allFiles.length > 0) {
      effectiveMode = 'all';
    } else {
      effectiveMode = 'committed';
    }
  }

  // 根据 effectiveMode 选定输出的 files 列表
  let activeFiles = [];
  if (effectiveMode === 'uncommitted') {
    activeFiles = uncommittedData.files || [];
  } else if (effectiveMode === 'all') {
    activeFiles = allFiles;
  } else {
    activeFiles = committedFiles;
  }

  return {
    source: {
      path: sourceWt.path,
      branch: sourceWt.branch || 'HEAD',
      head: sourceWt.head,
      isMain: sourceWt.isMain,
      isDirty: sourceWt.isDirty,
      lastCommit: sourceWt.lastCommit
    },
    target: {
      path: targetWt.path,
      branch: targetWt.branch || 'HEAD',
      head: targetWt.head,
      isMain: targetWt.isMain,
      isDirty: targetWt.isDirty,
      lastCommit: targetWt.lastCommit
    },
    ahead,
    behind,
    historyAhead,
    historyBehind,
    isCommittedContentEqual,
    effectiveMode,
    modesAvailable: {
      uncommitted: hasUncommitted,
      all: allFiles.length > 0,
      committed: hasCommitted
    },
    counts: {
      uncommitted: (uncommittedData.files || []).length,
      all: allFiles.length,
      committed: committedFiles.length
    },
    files: activeFiles
  };
}

export async function getUncommittedDiff(worktreePath) {
  try {
    const stat = await fs.stat(worktreePath);
    if (!stat.isDirectory()) throw new Error('Worktree 路径不存在');
  } catch {
    throw new Error('Worktree 路径不存在或不可读');
  }

  // 1. 获取工作区状态简报
  const statusOutput = await runGit(worktreePath, ['status', '--porcelain']);
  const statusLines = statusOutput.split('\n').filter(Boolean);

  // 2. 获取暂存区 + 工作区的统计 numstat 对比 HEAD
  let numstatOut = '';
  try {
    numstatOut = await runGit(worktreePath, ['diff', 'HEAD', '--numstat']);
  } catch {}

  // 3. 获取暂存区 + 工作区的完整 diff 对比 HEAD
  let rawDiff = '';
  try {
    rawDiff = await runGit(worktreePath, ['diff', 'HEAD', '-p', '-U3']);
  } catch (err) {
    rawDiff = `获取未提交 Diff 失败: ${err.message}`;
  }

  // 按文件拆分 diff 内容
  const fileDiffMap = splitDiffByFiles(rawDiff);

  const files = [];
  const processedFiles = new Set();

  if (numstatOut) {
    for (const line of numstatOut.split('\n')) {
      if (!line.trim()) continue;
      const [added, deleted, filePath] = line.split('\t');
      processedFiles.add(filePath);
      const isImg = isImageFile(filePath);
      const isBin = isImg || added === '-' || deleted === '-';
      files.push({
        filePath,
        status: 'M',
        added: isBin ? 0 : (added === '-' ? 0 : parseInt(added, 10)),
        deleted: isBin ? 0 : (deleted === '-' ? 0 : parseInt(deleted, 10)),
        isBinary: isBin,
        isImage: isImg,
        diffChunk: fileDiffMap[filePath] || ''
      });
    }
  }

  // 4. 检查是否有新增加但尚未 git add 的未跟踪文件 (Untracked ??)
  // 排除 verification/ 目录（测试验收/截图等过程文件）及常见的本地构建或工具链临时目录
  const IGNORED_UNTRACKED_PREFIXES = ['verification/', '.verification/', '.playwright/', '.cypress/'];

  try {
    const untrackedRaw = await runGit(worktreePath, ['ls-files', '--others', '--exclude-standard']);
    for (const f of untrackedRaw.split('\n')) {
      const filePath = f.trim();
      if (!filePath || processedFiles.has(filePath)) continue;
      if (IGNORED_UNTRACKED_PREFIXES.some(prefix => filePath.startsWith(prefix))) continue;
      processedFiles.add(filePath);
      
      const isImg = isImageFile(filePath);
      let addedLines = 0;
      let newContent = '';
      let isBin = isImg;

      if (!isImg) {
        try {
          const full = path.join(worktreePath, filePath);
          const st = await fs.stat(full);
          if (st.size < 512 * 1024) { // 小于 512KB 读取
            const content = await fs.readFile(full, 'utf-8');
            if (content.includes('\0')) {
              isBin = true;
            } else {
              const lines = content.split('\n');
              addedLines = lines.length;
              newContent = lines.map(l => '+' + l).join('\n');
            }
          } else {
            isBin = true;
          }
        } catch {}
      }

      const customChunk = (isImg || isBin)
        ? `Binary file ${filePath} has been added\n`
        : `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${addedLines} @@\n${newContent}\n`;

      files.push({
        filePath,
        status: '?',
        added: (isImg || isBin) ? 0 : addedLines,
        deleted: 0,
        isBinary: isImg || isBin,
        isImage: isImg,
        diffChunk: customChunk
      });
    }
  } catch {}

  let totalAdded = 0;
  let totalDeleted = 0;
  files.forEach(f => {
    if (!f.isBinary) {
      totalAdded += f.added || 0;
      totalDeleted += f.deleted || 0;
    }
  });

  return {
    worktreePath,
    totalFiles: files.length,
    totalAdded,
    totalDeleted,
    statusCount: statusLines.length,
    files
  };
}

/**
 * 获取指定 worktree 的提交记录
 * @param {string} worktreePath - worktree 绝对路径
 * @param {object} options
 * @param {number} [options.limit=30] - 返回条数 (1-100)
 * @param {number} [options.offset=0] - 偏移量
 * @param {string} [options.base] - 基准分支 (不传则自动检测 main/master)
 * @param {string} [options.author] - 按作者过滤 (直通 git --author)
 * @param {string} [options.since] - 起始时间过滤 (直通 git --since, ISO 日期或日期时间)
 * @param {string} [options.until] - 结束时间过滤 (直通 git --until, ISO 日期或日期时间)
 * @param {string} [options.grep] - 按提交说明关键词过滤 (字面匹配, 不作正则解析)
 * @param {string} [options.ref] - 分支查看模式：以该引用（分支名）为提交列表顶点，
 *        取代 worktree 当前分支；用于分支列表直接查看任意分支的提交记录
 */
export async function getWorktreeCommits(worktreePath, options = {}) {
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 30, 1), 100);
  const offset = Math.max(parseInt(options.offset, 10) || 0, 0);
  const requestedFullHistory = options.fullHistory === true
    || options.fullHistory === 'true'
    || options.fullHistory === '1';

  // 0. 路径安全校验: 必须为存在的绝对路径目录 (防止 ENOENT 透传为 500)
  if (!worktreePath || !path.isAbsolute(worktreePath)) {
    throw Object.assign(new Error('worktree 路径必须为绝对路径'), { statusCode: 400 });
  }
  if (options.base && (!/^[a-zA-Z0-9_/.-]+$/.test(options.base) || options.base.includes('..'))) {
    throw Object.assign(new Error('base 参数包含非法字符'), { statusCode: 400 });
  }
  // ref 参数（分支查看模式）：提供时以该引用为提交列表的顶点，取代从 worktree
  // porcelain 解析出的当前分支，用于分支列表直接查看任意分支的提交记录；
  // 白名单与 base 相同，杜绝选项注入与 `..` 范围拼接
  if (options.ref && (!/^[a-zA-Z0-9_/.-]+$/.test(options.ref) || options.ref.includes('..'))) {
    throw Object.assign(new Error('ref 参数包含非法字符'), { statusCode: 400 });
  }

  // 过滤参数白名单校验: 全部可选, 缺省时行为与原来完全一致。
  // author/grep 为自由文本, 原始值禁止换行/NUL(防注入), trim 后禁止空值/超长/'-' 开头(防 flag 注入)。
  // since/until 限定为数值范围合法的 ISO 日期或日期时间, 避免任意字符串透传给 git 解析。
  const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})([ T](\d{2}):(\d{2})(:(\d{2}))?)?$/;
  const commitFilters = {};

  if (options.author !== undefined && options.author !== null) {
    if (typeof options.author !== 'string' || /[\n\r\0]/.test(options.author)) {
      throw Object.assign(new Error('author 参数不合法'), { statusCode: 400 });
    }
    const author = options.author.trim();
    if (author.length < 1 || author.length > 200 || author.startsWith('-')) {
      throw Object.assign(new Error('author 参数不合法'), { statusCode: 400 });
    }
    commitFilters.author = author;
  }

  if (options.grep !== undefined && options.grep !== null) {
    if (typeof options.grep !== 'string' || /[\n\r\0]/.test(options.grep)) {
      throw Object.assign(new Error('grep 参数不合法'), { statusCode: 400 });
    }
    const grep = options.grep.trim();
    if (grep.length < 1 || grep.length > 200 || grep.startsWith('-')) {
      throw Object.assign(new Error('grep 参数不合法'), { statusCode: 400 });
    }
    commitFilters.grep = grep;
  }

  for (const [key, rawValue] of [['since', options.since], ['until', options.until]]) {
    if (rawValue === undefined || rawValue === null) continue;
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    const match = typeof rawValue === 'string' ? ISO_DATETIME_RE.exec(value) : null;
    let valid = false;
    if (match) {
      // 纯格式正则放得过宽(如 2026-13-99), 必须再校验各段数值范围
      const [, , month, day, , hour, minute, , second] = match;
      valid = Number(month) >= 1 && Number(month) <= 12
        && Number(day) >= 1 && Number(day) <= 31
        && (hour === undefined
          || (Number(hour) <= 23 && Number(minute) <= 59 && (second === undefined || Number(second) <= 59)));
    }
    if (!valid) {
      throw Object.assign(new Error(`${key} 参数不合法`), { statusCode: 400 });
    }
    commitFilters[key] = value;
  }

  // 把过滤参数转成 rev-list 与 log 共用的 flag: 两处必须一致,
  // 否则 totalCommits(计数) 与分页/hasMore(列表) 会错位。
  // grep 固定加 --fixed-strings, 按字面匹配, 避免用户输入被当作正则导致 git 报错。
  const filterFlags = [];
  if (commitFilters.author) filterFlags.push(`--author=${commitFilters.author}`);
  if (commitFilters.grep) filterFlags.push(`--grep=${commitFilters.grep}`, '--fixed-strings');
  if (commitFilters.since) filterFlags.push(`--since=${commitFilters.since}`);
  if (commitFilters.until) filterFlags.push(`--until=${commitFilters.until}`);

  try {
    const stat = await fs.stat(worktreePath);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    throw Object.assign(new Error('指定的 worktree 路径不存在'), { statusCode: 404 });
  }

  // 1. 验证 worktreePath 是否存在于 git worktree list 中
  const wtOutput = await runGit(worktreePath, ['worktree', 'list', '--porcelain']);
  if (!wtOutput) {
    throw new Error('无法读取 Worktree 列表');
  }

  const lines = wtOutput.split('\n');
  let currentPath = '';
  let branch = '';
  let head = '';
  let worktreeIndex = -1;
  let mainBranch = '';

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      worktreeIndex += 1;
      currentPath = line.slice(9).trim();
    } else if (line.startsWith('HEAD ')) {
      if (path.resolve(currentPath) === path.resolve(worktreePath)) {
        head = line.slice(5).trim();
      }
    } else if (line.startsWith('branch ')) {
      const parsedBranch = line.slice(7).replace('refs/heads/', '').trim();
      if (worktreeIndex === 0) {
        mainBranch = parsedBranch;
      }
      if (path.resolve(currentPath) === path.resolve(worktreePath)) {
        branch = parsedBranch;
      }
    }
  }

  if (!head) {
    head = (await runGit(worktreePath, ['rev-parse', 'HEAD'])) || '';
  }

  // 分支查看模式：以指定 ref 为顶点，覆盖 porcelain 解析出的分支与 HEAD。
  // ref 为仓库级引用，在任何 worktree 路径下都可解析；无法解析时返回 404 而非空列表，
  // 避免把不存在的分支误显示成「没有提交」
  if (options.ref) {
    try {
      head = await runGit(worktreePath, ['rev-parse', '--verify', `${options.ref}^{commit}`]);
      branch = options.ref;
    } catch {
      throw Object.assign(new Error('指定的分支不存在'), { statusCode: 404 });
    }
  }
  const tipRef = options.ref || 'HEAD';

  // 2. 基准分支检测
  let base = options.base;
  if (!base) {
    // 优先使用当前仓库主工作区的分支，避免远程默认分支与本地主干不一致。
    if (mainBranch) {
      base = mainBranch;
    } else {
      try {
        const symref = await runGit(worktreePath, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
        base = symref.split('/').pop() || 'main';
      } catch {
        try {
          const branches = await runGit(worktreePath, ['branch', '--list']);
          if (branches.includes('main')) base = 'main';
          else if (branches.includes('master')) base = 'master';
          else base = 'main';
        } catch {
          base = 'main';
        }
      }
    }
  }

  // 主干默认展示完整历史；其他分支只有用户主动请求时才展示完整历史。
  const isBaseWorktree = Boolean(branch && branch === base);
  const isFullHistory = isBaseWorktree || requestedFullHistory;

  // 3. 计算提交范围。功能分支只取相对主干新增的提交，主干取全历史。
  // 非主干找不到基准时保持空结果，不能退回 tipRef，否则会误显示整条历史。
  let baseRef = base;
  let baseAvailable = true;
  let revRange = isFullHistory ? tipRef : null;
  if (!isFullHistory) {
    const baseCandidates = [base, base.startsWith('origin/') ? null : `origin/${base}`].filter(Boolean);
    baseAvailable = false;
    for (const candidate of baseCandidates) {
      try {
        await runGit(worktreePath, ['rev-parse', '--verify', candidate]);
        baseRef = candidate;
        baseAvailable = true;
        break;
      } catch {
        // 继续尝试本地或远程的另一个同名基准引用。
      }
    }
    if (baseAvailable) revRange = `${baseRef}..${tipRef}`;
  }

  // 4. 获取提交总数
  let totalCommits = 0;
  if (revRange) {
    try {
      const countOutput = await runGit(worktreePath, ['rev-list', '--count', ...filterFlags, revRange]);
      totalCommits = parseInt(countOutput, 10) || 0;
    } catch {
      totalCommits = 0;
    }
  }

  // 5. 获取提交列表
  const delimiter = '---COMMIT_END_X---';
  const format = `%H%n%h%n%an%n%ae%n%aI%n%cr%n%s%n%b%n${delimiter}`;
  let rawLogs = '';
  if (revRange) {
    try {
      rawLogs = await runGit(worktreePath, [
        'log',
        ...filterFlags,
        revRange,
        `--format=${format}`,
        `--skip=${offset}`,
        `--max-count=${limit}`
      ]);
    } catch {
      rawLogs = '';
    }
  }

  const commits = [];
  if (rawLogs.trim()) {
    const rawChunks = rawLogs.split(delimiter);
    for (const chunk of rawChunks) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      const [cHash, shortHash, author, authorEmail, date, relativeTime, subject, ...bodyLines] = trimmed.split('\n');
      commits.push({
        hash: cHash || '',
        shortHash: shortHash || (cHash ? cHash.slice(0, 7) : ''),
        author: author || '',
        authorEmail: authorEmail || '',
        date: date || '',
        relativeTime: relativeTime || '',
        subject: subject || '',
        body: bodyLines.join('\n').trim()
      });
    }
  }

  return {
    ok: true,
    worktreePath,
    branch: branch || 'HEAD',
    head,
    base,
    baseAvailable,
    isFullHistory,
    isMainHistory: isBaseWorktree,
    totalCommits,
    returnedCount: commits.length,
    hasMore: offset + commits.length < totalCommits,
    commits
  };
}

/**
 * 获取指定 worktree 相对基准分支的领先/落后提交数
 * @param {string} worktreePath - worktree 绝对路径
 * @param {object} options
 * @param {string} [options.base] - 基准分支 (不传则自动检测: 优先主工作区分支，回退 origin/HEAD 指向，再回退 main/master)
 * @param {string} [options.ref] - 分支查看模式：统计该引用（而非 worktree 当前 HEAD）相对基准的领先/落后
 * @returns {Promise<object>} 基准可解析时 baseAvailable=true 且 ahead/behind 为数字；
 *          基准不可解析时不抛错，返回 baseAvailable=false 且 ahead/behind 为 null，由前端隐藏徽章
 */
export async function getWorktreeAheadBehind(worktreePath, options = {}) {
  // 0. 路径与 base/ref 参数校验，风格与 getWorktreeCommits 保持一致 (防止 ENOENT 透传为 500)
  if (!worktreePath || !path.isAbsolute(worktreePath)) {
    throw Object.assign(new Error('worktree 路径必须为绝对路径'), { statusCode: 400 });
  }
  if (options.base && (!/^[a-zA-Z0-9_/.-]+$/.test(options.base) || options.base.includes('..'))) {
    throw Object.assign(new Error('base 参数包含非法字符'), { statusCode: 400 });
  }
  if (options.ref && (!/^[a-zA-Z0-9_/.-]+$/.test(options.ref) || options.ref.includes('..'))) {
    throw Object.assign(new Error('ref 参数包含非法字符'), { statusCode: 400 });
  }
  try {
    const stat = await fs.stat(worktreePath);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    throw Object.assign(new Error('指定的 worktree 路径不存在'), { statusCode: 404 });
  }

  // 1. 解析当前 worktree 分支与主工作区分支 (worktreeIndex===0 为主工作区)；
  //    detached HEAD 时 porcelain 输出无 branch 行，worktreeBranch 保持 'HEAD'
  const wtOutput = await runGit(worktreePath, ['worktree', 'list', '--porcelain']);
  if (!wtOutput) {
    throw new Error('无法读取 Worktree 列表');
  }

  const lines = wtOutput.split('\n');
  const wtEntries = [];
  let entry = null;
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      if (entry) wtEntries.push(entry);
      entry = { wtPath: line.slice(9).trim(), branch: 'HEAD' };
    } else if (entry && line.startsWith('branch ')) {
      entry.branch = line.slice(7).replace('refs/heads/', '').trim();
    }
  }
  if (entry) wtEntries.push(entry);

  // macOS 下 /tmp 是 /private/tmp 的符号链接，porcelain 输出的是注册时的真实路径，
  // 直接用 path.resolve 比较会失配并把正常分支误判为 detached HEAD，须统一 realpath 后再比
  let targetRealPath = worktreePath;
  try {
    targetRealPath = await fs.realpath(worktreePath);
  } catch {}

  let worktreeBranch = 'HEAD';
  let mainBranch = '';
  for (let i = 0; i < wtEntries.length; i++) {
    let realPath = wtEntries[i].wtPath;
    try {
      realPath = await fs.realpath(realPath);
    } catch {}
    if (i === 0 && wtEntries[i].branch !== 'HEAD') {
      mainBranch = wtEntries[i].branch;
    }
    if (realPath === targetRealPath) {
      worktreeBranch = wtEntries[i].branch;
    }
  }

  // 分支查看模式：统计指定 ref 而非 worktree 当前 HEAD。
  // ref 为仓库级引用，在任何 worktree 路径下都可解析；无法解析时 404 而非返回全零计数
  const targetRef = options.ref || 'HEAD';
  if (options.ref) {
    try {
      await runGit(worktreePath, ['rev-parse', '--verify', `${options.ref}^{commit}`]);
      worktreeBranch = options.ref;
    } catch {
      throw Object.assign(new Error('指定的分支不存在'), { statusCode: 404 });
    }
  }

  // 2. 基准分支检测：与 getWorktreeCommits 相同的回退链
  let base = options.base;
  if (!base) {
    // 优先使用当前仓库主工作区的分支，避免远程默认分支与本地主干不一致。
    if (mainBranch) {
      base = mainBranch;
    } else {
      try {
        const symref = await runGit(worktreePath, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
        base = symref.split('/').pop() || 'main';
      } catch {
        try {
          const branches = await runGit(worktreePath, ['branch', '--list']);
          if (branches.includes('main')) base = 'main';
          else if (branches.includes('master')) base = 'master';
          else base = 'main';
        } catch {
          base = 'main';
        }
      }
    }
  }

  // 3. 解析基准引用：依次尝试 base 与（非 origin/ 前缀时）origin/base，均失败时降级返回而非抛 500
  const baseCandidates = [base, base.startsWith('origin/') ? null : `origin/${base}`].filter(Boolean);
  let baseRef = null;
  for (const candidate of baseCandidates) {
    try {
      await runGit(worktreePath, ['rev-parse', '--verify', candidate]);
      baseRef = candidate;
      break;
    } catch {
      // 继续尝试本地或远程的另一个同名基准引用
    }
  }

  if (!baseRef) {
    return {
      ok: true,
      worktreePath,
      baseBranch: base,
      worktreeBranch,
      baseAvailable: false,
      ahead: null,
      behind: null
    };
  }

  // 4. 统计领先/落后：rev-list --left-right --count 输出第一列为 base 侧 (behind 落后数)，
  //    第二列为目标引用侧 (ahead 领先数)，顺序不能弄反
  const countOutput = await runGit(worktreePath, ['rev-list', '--left-right', '--count', `${baseRef}...${targetRef}`]);
  const [behind, ahead] = countOutput.split(/\s+/).map(v => parseInt(v, 10) || 0);

  const result = {
    ok: true,
    worktreePath,
    baseBranch: base,
    worktreeBranch,
    baseAvailable: true,
    ahead,
    behind
  };

  // 5. 内容等价判定：机械计数会把「原提交 + revert 抵消提交」显示成领先 N，
  //    复用分支列表的 getBranchMergeStatus（祖先/树一致/git cherry 补丁等价/merge-tree
  //    四方判定）判断目标引用改动是否已被基准吸收，供前端展示「与基准无差异」。
  //    detached HEAD 时 targetRef 为 HEAD，merge-base/cherry/rev-parse 同样可解析。
  try {
    const mergeStatus = await getBranchMergeStatus(worktreePath, baseRef, targetRef);
    result.contentEquivalent = mergeStatus.isMerged;
    result.mergeType = mergeStatus.mergeType;
  } catch {
    // 判定失败时省略这两个字段，前端回退为纯计数展示
  }

  return result;
}


/**
 * 获取指定提交的详情（元信息 + 逐文件变更统计）
 * @param {string} worktreePath - worktree 绝对路径
 * @param {string} sha - 提交 SHA（7-40 位十六进制）
 * @returns {Promise<object>} 含 hash/author/body/parents/isMerge/filesChanged/insertions/deletions/files 等字段
 */
export async function getCommitDetail(worktreePath, sha) {
  // 校验顺序与错误风格保持和 getWorktreeCommits 一致：路径 -> 目录存在性
  if (!worktreePath || !path.isAbsolute(worktreePath)) {
    throw Object.assign(new Error('worktree 路径必须为绝对路径'), { statusCode: 400 });
  }
  // sha 只放行十六进制，杜绝把 git 选项或任意字符串当作参数拼进去
  if (!sha || !/^[0-9a-fA-F]{7,40}$/.test(sha)) {
    throw Object.assign(new Error('sha 参数不合法'), { statusCode: 400 });
  }
  try {
    const stat = await fs.stat(worktreePath);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    throw Object.assign(new Error('指定的 worktree 路径不存在'), { statusCode: 404 });
  }

  // 校验提交确实存在，同时把短 SHA / tag 对象统一解析为完整提交 SHA
  let resolvedSha = '';
  try {
    resolvedSha = await runGit(worktreePath, ['rev-parse', '--verify', `${sha}^{commit}`]);
  } catch {
    throw Object.assign(new Error('指定的提交不存在'), { statusCode: 404 });
  }

  // 元信息：%P 后接 %b 再接自定义分隔符，保证正文含空行/多段时按行切分不串位
  const metaDelimiter = '---COMMIT_DETAIL_END_X---';
  const metaFormat = `%H%n%h%n%an%n%ae%n%aI%n%cr%n%s%n%P%n%b%n${metaDelimiter}`;
  const metaOutput = await runGit(worktreePath, ['show', '-s', `--format=${metaFormat}`, resolvedSha]);
  const metaLines = metaOutput.split(metaDelimiter)[0].split('\n');
  const [cHash, shortHash, author, authorEmail, date, relativeTime, subject, parentLine] = metaLines;
  // 第 8 行之后到分隔符之间的内容是完整正文（格式化时末尾多出一个换行，trim 掉）
  const body = metaLines.slice(8).join('\n').trim();
  const parents = (parentLine || '').split(/\s+/).filter(Boolean);
  const isMerge = parents.length >= 2;

  // 文件统计：--root 保证根提交（首次提交）也产出统计。
  // 注意：方案对 merge 的契约是"对第一父提交做 diff"，但实测 git 2.50 下
  // diff-tree --first-parent 对 merge 无输出、-m --first-parent 又不去重，
  // 因此对 merge 改用显式区间 <sha>^1 <sha>，与该契约等价且跨版本行为稳定。
  const diffArgs = ['diff-tree', '--root', '--numstat', '--stat'];
  if (isMerge) {
    diffArgs.push(`${resolvedSha}^1`, resolvedSha);
  } else {
    diffArgs.push(resolvedSha);
  }
  let statOutput = '';
  try {
    statOutput = await runGit(worktreePath, diffArgs);
  } catch {
    // 统计失败不阻断详情返回，降级为空统计
    statOutput = '';
  }

  // 输出布局：可选的 commit SHA 行 -> 逐文件 numstat 行(add\tdelete\tpath) -> --stat 汇总块
  const files = [];
  let summary = null;
  const numstatRe = /^(\d+|-)\t(\d+|-)\t(.+)$/;
  const summaryRe = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;
  for (const line of statOutput.split('\n')) {
    if (!line) continue;
    const numstatMatch = line.match(numstatRe);
    if (numstatMatch) {
      // added/deleted 为 '-' 表示二进制文件，计数记 0 并打 isBinary 标记
      const isBinary = numstatMatch[1] === '-' || numstatMatch[2] === '-';
      files.push({
        filePath: numstatMatch[3],
        added: isBinary ? 0 : (parseInt(numstatMatch[1], 10) || 0),
        deleted: isBinary ? 0 : (parseInt(numstatMatch[2], 10) || 0),
        isBinary
      });
      continue;
    }
    const summaryMatch = line.match(summaryRe);
    if (summaryMatch) {
      summary = {
        filesChanged: parseInt(summaryMatch[1], 10) || 0,
        insertions: summaryMatch[2] === undefined ? 0 : (parseInt(summaryMatch[2], 10) || 0),
        deletions: summaryMatch[3] === undefined ? 0 : (parseInt(summaryMatch[3], 10) || 0)
      };
    }
  }

  // 汇总以 --stat 汇总行为准（git 自己处理了二进制文件），解析失败时用 numstat 求和兜底
  const filesChanged = summary ? summary.filesChanged : files.length;
  const insertions = summary ? summary.insertions : files.reduce((sum, f) => sum + f.added, 0);
  const deletions = summary ? summary.deletions : files.reduce((sum, f) => sum + f.deleted, 0);

  return {
    ok: true,
    worktreePath,
    hash: cHash || resolvedSha,
    shortHash: shortHash || (cHash ? cHash.slice(0, 7) : ''),
    author: author || '',
    authorEmail: authorEmail || '',
    date: date || '',
    relativeTime: relativeTime || '',
    subject: subject || '',
    body,
    parents,
    isMerge,
    filesChanged,
    insertions,
    deletions,
    files
  };
}

/**
 * 获取单条提交的逐文件文本 Diff（供提交详情面板的「查看 Diff」使用）。
 * 校验顺序与 merge/根提交的 diff 策略和 getCommitDetail 完全一致：
 * - 普通/根提交用 `diff-tree --root`（--root 保证首次提交也有输出）
 * - merge 提交用显式区间 <sha>^1 <sha>，等价于"对第一父提交做 diff"，
 *   原因同 getCommitDetail：diff-tree --first-parent 对 merge 无输出且跨版本行为不稳
 */
export async function getCommitDiff(worktreePath, sha) {
  // 校验顺序与错误风格和 getCommitDetail 一致：绝对路径 400 -> sha 正则 400 -> 目录 404 -> 提交 404
  if (!worktreePath || !path.isAbsolute(worktreePath)) {
    throw Object.assign(new Error('worktree 路径必须为绝对路径'), { statusCode: 400 });
  }
  // sha 只放行十六进制，杜绝把 git 选项或任意字符串当作参数拼进去
  if (!sha || !/^[0-9a-fA-F]{7,40}$/.test(sha)) {
    throw Object.assign(new Error('sha 参数不合法'), { statusCode: 400 });
  }
  try {
    const stat = await fs.stat(worktreePath);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    throw Object.assign(new Error('指定的 worktree 路径不存在'), { statusCode: 404 });
  }

  let resolvedSha = '';
  try {
    resolvedSha = await runGit(worktreePath, ['rev-parse', '--verify', `${sha}^{commit}`]);
  } catch {
    throw Object.assign(new Error('指定的提交不存在'), { statusCode: 404 });
  }

  // 父提交数量决定 diff 策略：0 个为根提交，>=2 个为 merge 提交
  const parentLine = await runGit(worktreePath, ['show', '-s', '--format=%P', resolvedSha]);
  const isMerge = (parentLine || '').trim().split(/\s+/).filter(Boolean).length >= 2;

  // core.quotepath=false 让 numstat 与 diff --git 头对非 ASCII 文件名都不加引号，
  // 保证按文件路径把 diff 拆分结果和 numstat 统计对得上
  const quotedPathArgs = ['-c', 'core.quotepath=false'];
  const rangeArgs = isMerge ? [`${resolvedSha}^1`, resolvedSha] : ['--root', resolvedSha];

  // 完整 unified diff，-U3 上下文与既有 formatDiffLines 渲染管线保持一致
  let rawDiff = '';
  try {
    rawDiff = await runGit(worktreePath, [...quotedPathArgs, 'diff-tree', '-p', '-U3', ...rangeArgs]);
  } catch {
    // diff 获取失败时按无文本差异处理，保持 200 与空列表，不阻断面板展示
    rawDiff = '';
  }
  if (!rawDiff.trim()) {
    // 空提交或无实际变化：仍返回 200，files 为空数组
    return { ok: true, worktreePath, sha: resolvedSha, isMerge, files: [] };
  }

  // 逐文件 +/- 行数统计（merge 时同样对第一父的区间取）
  let numstatOutput = '';
  try {
    numstatOutput = await runGit(worktreePath, [...quotedPathArgs, 'diff-tree', '--numstat', ...rangeArgs]);
  } catch {
    // 统计失败不阻断 diff 展示，降级为按 diff 拆分结果补齐
    numstatOutput = '';
  }

  const fileDiffMap = splitDiffByFiles(rawDiff);
  const files = [];
  const seenPaths = new Set();
  // numstat 行格式：added\tdeleted\tpath，'-' 表示二进制文件
  const numstatRe = /^(\d+|-)\t(\d+|-)\t(.+)$/;
  for (const line of numstatOutput.split('\n')) {
    if (!line) continue;
    const match = line.match(numstatRe);
    if (!match) continue;
    const filePath = match[3];
    seenPaths.add(filePath);
    const isBinary = match[1] === '-' || match[2] === '-';
    files.push({
      filePath,
      added: isBinary ? 0 : (parseInt(match[1], 10) || 0),
      deleted: isBinary ? 0 : (parseInt(match[2], 10) || 0),
      isBinary,
      isImage: isImageFile(filePath),
      // 二进制文件的 diff 段只有 "Binary files differ" 头，没有可渲染文本，按契约给空串
      diffChunk: isBinary ? '' : (fileDiffMap[filePath] || '')
    });
  }

  // numstat 失败或个别文件缺失统计时，按 diff 拆分结果补齐条目，保证文件不丢
  for (const filePath of Object.keys(fileDiffMap)) {
    if (seenPaths.has(filePath)) continue;
    files.push({
      filePath,
      added: 0,
      deleted: 0,
      isBinary: false,
      isImage: isImageFile(filePath),
      diffChunk: fileDiffMap[filePath]
    });
  }

  return {
    ok: true,
    worktreePath,
    sha: resolvedSha,
    isMerge,
    files
  };
}

/**
 * 从 runGit 抛出的错误信息中提取一句话失败摘要。
 * promisify(execFile) 失败时的 err.message 形如
 * "Command failed: git cherry-pick xxx\n<git stderr 多行输出>"，
 * 优先取 CONFLICT/error:/fatal: 开头的关键行；取不到时回退为第二条非空行
 * （第一条通常是命令回显）。超长摘要截断到 200 字符，避免刷爆前端 alert。
 * @param {string} rawMessage - runGit 抛出的原始错误信息
 * @returns {string} 单行中文场景友好的失败摘要
 */
function summarizeGitFailure(rawMessage) {
  const lines = String(rawMessage || '').split('\n').map(l => l.trim()).filter(Boolean);
  const keyLine = lines.find(l => /^(CONFLICT|error:|fatal:)/i.test(l));
  const summary = keyLine || lines[1] || lines[0] || '未知原因';
  return summary.length > 200 ? `${summary.slice(0, 200)}...` : summary;
}

/**
 * 对指定 worktree 的当前分支执行 cherry-pick 或 revert 写操作。
 *
 * 校验链与 getCommitDetail 完全一致：action 白名单 400 -> 绝对路径 400 ->
 * sha 正则 400 -> 目录 404 -> rev-parse 验证 404。
 *
 * 执行失败（含冲突）时必须现场回滚：cherry-pick 失败执行 `git cherry-pick --abort`，
 * revert 失败执行 `git revert --abort`，本工具绝不留下半完成的 sequencer 状态；
 * 回滚抛 409 中文错误（含失败原因摘要），abort 自身失败且工作区仍有残留时
 * 在错误信息中额外提醒用户手动处理。
 * @param {string} worktreePath - worktree 绝对路径（写操作作用于其当前分支）
 * @param {string} action - 仅允许 'cherry-pick' | 'revert'
 * @param {string} sha - 目标提交 SHA（7-40 位十六进制，接受短 SHA）
 * @returns {Promise<object>} { ok, action, sha: 完整 SHA, newHead: 操作后的 HEAD }
 */
export async function commitAction(worktreePath, action, sha) {
  // action 白名单前置：两种写操作之外一律拒绝，防止任意 git 子命令被拼进参数
  if (action !== 'cherry-pick' && action !== 'revert') {
    throw Object.assign(new Error('action 参数不合法'), { statusCode: 400 });
  }
  // 以下校验顺序与错误风格和 getCommitDetail 保持一致
  if (!worktreePath || !path.isAbsolute(worktreePath)) {
    throw Object.assign(new Error('worktree 路径必须为绝对路径'), { statusCode: 400 });
  }
  // sha 只放行十六进制，杜绝把 git 选项或任意字符串当作参数拼进去
  if (!sha || !/^[0-9a-fA-F]{7,40}$/.test(sha)) {
    throw Object.assign(new Error('sha 参数不合法'), { statusCode: 400 });
  }
  try {
    const stat = await fs.stat(worktreePath);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    throw Object.assign(new Error('指定的 worktree 路径不存在'), { statusCode: 404 });
  }

  // 校验提交确实存在，同时把短 SHA 统一解析为完整提交 SHA
  let resolvedSha = '';
  try {
    resolvedSha = await runGit(worktreePath, ['rev-parse', '--verify', `${sha}^{commit}`]);
  } catch {
    throw Object.assign(new Error('指定的提交不存在'), { statusCode: 404 });
  }

  const isCherryPick = action === 'cherry-pick';

  // 语义前置校验：cherry-pick 一个已在目标分支历史中的提交、或 revert 一个不在
  // 目标分支历史中的提交，都是用户对作用目标的误判（典型场景：在提交来源 worktree
  // 上 pick 自己的提交），直接 409 中文提示，避免落到 git 层的空提交/报错
  let isAncestor = false;
  try {
    await runGit(worktreePath, ['merge-base', '--is-ancestor', resolvedSha, 'HEAD']);
    isAncestor = true;
  } catch {
    // 退出码非 0 即非祖先，按 false 处理
  }
  if (isCherryPick && isAncestor) {
    throw Object.assign(new Error('该提交已在目标分支上，无需 Cherry-pick（如需应用到其他分支，请在目标工作区选择器中切换目标）'), { statusCode: 409 });
  }
  if (!isCherryPick && !isAncestor) {
    throw Object.assign(new Error('该提交不在目标分支历史中，无法 Revert（Revert 只能撤销当前分支上已存在的提交）'), { statusCode: 409 });
  }

  // revert 用 --no-edit 跳过交互式编辑器；abort 参数与执行参数一一对应
  const actionArgs = isCherryPick
    ? ['cherry-pick', resolvedSha]
    : ['revert', '--no-edit', resolvedSha];
  const abortArgs = isCherryPick
    ? ['cherry-pick', '--abort']
    : ['revert', '--abort'];

  try {
    await runGit(worktreePath, actionArgs);
  } catch (err) {
    // 执行失败（含冲突）时现场回滚，把仓库恢复到操作前的干净状态
    let rollbackNote = '已恢复仓库原状';
    try {
      await runGit(worktreePath, abortArgs);
    } catch {
      // abort 失败不代表现场一定脏（如无进行中的 sequencer），再核实工作区是否真有残留，
      // 只有确实残留未恢复改动时才提醒用户手动处理，避免误报
      let dirty = true;
      try {
        dirty = (await runGit(worktreePath, ['status', '--porcelain'])).length > 0;
      } catch {}
      if (dirty) {
        rollbackNote = `自动回滚（git ${abortArgs.join(' ')}）失败，工作区仍有未恢复的改动，请手动执行 git ${abortArgs.join(' ')} 或手工还原现场`;
      }
    }
    throw Object.assign(
      new Error(`${action} 执行失败（${rollbackNote}）：${summarizeGitFailure(err.message)}`),
      { statusCode: 409 }
    );
  }

  const newHead = await runGit(worktreePath, ['rev-parse', 'HEAD']);
  return { ok: true, action, sha: resolvedSha, newHead };
}

/**
 * 获取指定 worktree 的 stash 列表
 * @param {string} worktreePath - worktree 绝对路径
 * @returns {Promise<Array<{ref: string, shortHash: string, relativeTime: string, subject: string}>>}
 */
export async function getStashList(worktreePath) {
  if (!worktreePath || !path.isAbsolute(worktreePath)) {
    throw Object.assign(new Error('worktree 路径必须为绝对路径'), { statusCode: 400 });
  }
  try {
    const stat = await fs.stat(worktreePath);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    throw Object.assign(new Error('指定的 worktree 路径不存在'), { statusCode: 404 });
  }
  // %gd=stash@{n} 引用名, %h=短哈希, %cr=相对时间, %gs=stash 备注（含自定 message）
  const output = await runGit(worktreePath, ['stash', 'list', '--format=%gd|%h|%cr|%gs']);
  if (!output) return [];
  return output.split('\n').filter(Boolean).map(line => {
    const [ref = '', shortHash = '', relativeTime = '', ...rest] = line.split('|');
    return { ref, shortHash, relativeTime, subject: rest.join('|') };
  });
}

/**
 * 对指定 worktree 执行 stash 相关写操作。
 *
 * 校验链与 commitAction 一致：action 白名单 400 -> 绝对路径 400 -> 目录 404。
 * action 语义：
 * - push：git stash push -u（含未跟踪文件），message 可选；无本地改动时返回 409
 * - pop：git stash pop [stash@{n}]；冲突时 git 会保留该 stash，返回 409 并说明
 * - drop：git stash drop stash@{n}，stashRef 必须匹配 stash@{数字}
 * - discard：restore --staged + restore + clean -fd，丢弃全部未提交修改（含未跟踪文件），不可恢复
 * @param {string} worktreePath - worktree 绝对路径
 * @param {string} action - 仅允许 'push' | 'pop' | 'drop' | 'discard'
 * @param {object} [extra]
 * @param {string} [extra.message] - push 的可选备注（禁换行/NUL、禁 '-' 开头、≤200 字符）
 * @param {string} [extra.stashRef] - pop/drop 的目标 stash 引用（格式 stash@{n}）
 * @returns {Promise<object>} { ok, action, ... }
 */
export async function stashAction(worktreePath, action, extra = {}) {
  if (!['push', 'pop', 'drop', 'discard'].includes(action)) {
    throw Object.assign(new Error('action 参数不合法'), { statusCode: 400 });
  }
  if (!worktreePath || !path.isAbsolute(worktreePath)) {
    throw Object.assign(new Error('worktree 路径必须为绝对路径'), { statusCode: 400 });
  }
  try {
    const stat = await fs.stat(worktreePath);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    throw Object.assign(new Error('指定的 worktree 路径不存在'), { statusCode: 404 });
  }

  // pop/drop 的目标 stash 引用白名单：只允许 stash@{数字}，杜绝任意 ref 或选项注入
  const STASH_REF_RE = /^stash@\{\d+\}$/;
  if ((action === 'pop' || action === 'drop') && extra.stashRef !== undefined && extra.stashRef !== null && extra.stashRef !== '') {
    if (!STASH_REF_RE.test(extra.stashRef)) {
      throw Object.assign(new Error('stashRef 参数不合法'), { statusCode: 400 });
    }
  }

  if (action === 'push') {
    // 无本地改动时 git stash push 只打印 "No local changes to save" 且退出码为 0，
    // 无法从异常感知空操作，必须先自查工作区状态
    const dirty = await runGit(worktreePath, ['status', '--porcelain']);
    if (!dirty) {
      throw Object.assign(new Error('没有可暂存的本地改动'), { statusCode: 409 });
    }
    const args = ['stash', 'push', '-u'];
    if (extra.message !== undefined && extra.message !== null && String(extra.message).trim() !== '') {
      const message = String(extra.message);
      // 备注为自由文本：禁换行/NUL 防注入，禁 '-' 开头防被当作 git 选项
      if (/[\n\r\0]/.test(message) || message.trim().startsWith('-') || message.length > 200) {
        throw Object.assign(new Error('message 参数不合法'), { statusCode: 400 });
      }
      args.push('-m', message.trim());
    }
    try {
      await runGit(worktreePath, args);
    } catch (err) {
      // 无本地改动时 git 报 "No local changes to save"，转成 409 中文提示
      throw Object.assign(new Error(`Stash 失败：${summarizeGitFailure(err.message)}`), { statusCode: 409 });
    }
    return { ok: true, action };
  }

  if (action === 'pop') {
    const args = ['stash', 'pop'];
    if (extra.stashRef) args.push(extra.stashRef);
    try {
      await runGit(worktreePath, args);
    } catch (err) {
      // pop 冲突时 git 不会删除该 stash，现场保留在冲突状态由用户解决
      throw Object.assign(
        new Error(`Stash pop 失败（发生冲突时该 stash 仍会保留在列表中，可手工解决后再 drop）：${summarizeGitFailure(err.message)}`),
        { statusCode: 409 }
      );
    }
    return { ok: true, action };
  }

  if (action === 'drop') {
    if (!extra.stashRef) {
      throw Object.assign(new Error('drop 操作必须指定 stashRef'), { statusCode: 400 });
    }
    try {
      await runGit(worktreePath, ['stash', 'drop', extra.stashRef]);
    } catch (err) {
      throw Object.assign(new Error(`Stash drop 失败：${summarizeGitFailure(err.message)}`), { statusCode: 409 });
    }
    return { ok: true, action };
  }

  // discard：不可恢复，前端必须二次确认后才允许触发
  await runGit(worktreePath, ['restore', '--staged', '.']);
  await runGit(worktreePath, ['restore', '.']);
  await runGit(worktreePath, ['clean', '-fd']);
  return { ok: true, action };
}
