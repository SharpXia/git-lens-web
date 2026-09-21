import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';

const exec = promisify(execFile);

/**
 * 执行 git 命令辅助函数
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

  return worktrees;
}

/**
 * 获取分支列表及冗余分析
 */
export async function getBranches(repoPath) {
  // 获取当前默认主分支 (main 或 master)
  let mainBranch = 'main';
  try {
    const symref = await runGit(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    mainBranch = symref.split('/').pop() || 'main';
  } catch {
    const branches = await runGit(repoPath, ['branch', '--list']);
    if (branches.includes('main')) mainBranch = 'main';
    else if (branches.includes('master')) mainBranch = 'master';
  }

  let mergedBranches = [];
  try {
    const mergedOut = await runGit(repoPath, ['branch', '--merged', mainBranch]);
    mergedBranches = mergedOut.split('\n').map(b => b.replace('*', '').trim()).filter(Boolean);
  } catch {
    // ignore
  }

  const worktrees = await getWorktrees(repoPath);
  const activeWorktreeBranches = new Set(worktrees.map(w => w.branch).filter(Boolean));

  const format = '%(refname:short)|%(authordate:relative)|%(authorname)|%(subject)|%(committerdate:iso8601)';
  const rawBranches = await runGit(repoPath, ['for-each-ref', '--format=' + format, 'refs/heads/']);

  const branchList = [];
  for (const line of rawBranches.split('\n')) {
    if (!line.trim()) continue;
    const [name, relativeTime, author, subject, isoDate] = line.split('|');

    const isMain = name === mainBranch || name === 'master' || name === 'dev';
    const isMerged = mergedBranches.includes(name);
    const inUseByWorktree = activeWorktreeBranches.has(name);

    const daysOld = Math.floor((Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24));
    const isStale = !isMain && daysOld > 30;

    let redundancyReason = null;
    if (!isMain) {
      if (isMerged && !inUseByWorktree) {
        redundancyReason = '已合并至主分支且无 Worktree 引用 (安全可删)';
      } else if (isStale && !inUseByWorktree) {
        redundancyReason = `超过 ${daysOld} 天未活动陈旧分支`;
      }
    }

    branchList.push({
      name,
      relativeTime,
      author,
      subject,
      daysOld,
      isMain,
      isMerged,
      inUseByWorktree,
      isStale,
      redundancyReason
    });
  }

  return { mainBranch, branches: branchList };
}

/**
 * 清理冗余分支
 */
export async function deleteBranch(repoPath, branchName, force = false) {
  const flag = force ? '-D' : '-d';
  await runGit(repoPath, ['branch', flag, branchName]);
  // 精确验证是否已删除
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
  // 精确验证是否已从 git worktree 登记中移除
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
 * 解析并对比两个 Worktree 之间的 Diff
 */
export async function getWorktreeDiff(repoPath, sourcePath, targetPath) {
  const worktrees = await getWorktrees(repoPath);
  const sourceWt = worktrees.find(w => path.resolve(w.path) === path.resolve(sourcePath));
  const targetWt = worktrees.find(w => path.resolve(w.path) === path.resolve(targetPath));

  if (!sourceWt || !targetWt) {
    throw new Error('指定的 Worktree 路径不存在或未被 Git 登记');
  }

  const sourceRef = sourceWt.branch || sourceWt.head || 'HEAD';
  const targetRef = targetWt.branch || targetWt.head || 'HEAD';

  // 1. 获取 diff stat 摘要
  let statSummary = '';
  try {
    statSummary = await runGit(repoPath, ['diff', '--stat', sourceRef, targetRef]);
  } catch {
    statSummary = '无法计算统计信息';
  }

  // 2. 获取变更文件列表与增删行 (numstat)
  const files = [];
  try {
    const numstatOut = await runGit(repoPath, ['diff', '--numstat', sourceRef, targetRef]);
    for (const line of numstatOut.split('\n')) {
      if (!line.trim()) continue;
      const [added, deleted, filePath] = line.split('\t');
      files.push({
        filePath,
        added: added === '-' ? 0 : parseInt(added, 10),
        deleted: deleted === '-' ? 0 : parseInt(deleted, 10),
        isBinary: added === '-' || deleted === '-'
      });
    }
  } catch {
    // ignore
  }

  // 3. 获取完整 unified diff 内容
  let rawDiff = '';
  try {
    rawDiff = await runGit(repoPath, ['diff', '-p', '-U3', sourceRef, targetRef]);
  } catch (err) {
    rawDiff = `获取 Diff 失败: ${err.message}`;
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
    statSummary,
    files,
    rawDiff
  };
}
