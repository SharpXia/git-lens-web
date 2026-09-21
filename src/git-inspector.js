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
 * 解析并对比两个 Worktree 之间的 Diff
 * 优化点：使用三点语法 `base...target`，确保只显示 Target 领先于 Base 的自身新增改动，
 * 并支持按每个文件独立归类 diffChunk，支持前端独立展开/收起。
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
  const tripleDotRange = `${sourceRef}...${targetRef}`;

  // 1. 获取两者的提交相对位置：behind（落后 Base 提交数）与 ahead（领先 Base 提交数）
  let ahead = 0;
  let behind = 0;
  try {
    const revCounts = await runGit(repoPath, ['rev-list', '--left-right', '--count', tripleDotRange]);
    const parts = revCounts.trim().split(/\s+/).map(Number);
    if (parts.length >= 2) {
      behind = parts[0];
      ahead = parts[1];
    }
  } catch {
    // ignore
  }

  // 2. 使用三点语法获取 diff stat 摘要
  let statSummary = '';
  try {
    statSummary = await runGit(repoPath, ['diff', '--stat', tripleDotRange]);
  } catch {
    statSummary = '';
  }

  // 3. 获取完整 unified diff 内容 (base...target)
  let rawDiff = '';
  try {
    rawDiff = await runGit(repoPath, ['diff', '-p', '-U3', tripleDotRange]);
  } catch (err) {
    rawDiff = `获取 Diff 失败: ${err.message}`;
  }

  // 按文件拆分 diff 内容
  const fileDiffMap = splitDiffByFiles(rawDiff);

  // 4. 获取变更文件列表与增删行 (numstat)
  const files = [];
  try {
    const numstatOut = await runGit(repoPath, ['diff', '--numstat', tripleDotRange]);
    for (const line of numstatOut.split('\n')) {
      if (!line.trim()) continue;
      const [added, deleted, filePath] = line.split('\t');
      files.push({
        filePath,
        added: added === '-' ? 0 : parseInt(added, 10),
        deleted: deleted === '-' ? 0 : parseInt(deleted, 10),
        isBinary: added === '-' || deleted === '-',
        diffChunk: fileDiffMap[filePath] || ''
      });
    }
  } catch {
    // ignore
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
    statSummary,
    files,
    rawDiff
  };
}

/**
 * 获取单个 Worktree 本地未提交代码的 Diff (包含已暂存与未暂存修改)
 */
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
      files.push({
        filePath,
        status: 'M',
        added: added === '-' ? 0 : parseInt(added, 10),
        deleted: deleted === '-' ? 0 : parseInt(deleted, 10),
        isBinary: added === '-' || deleted === '-',
        diffChunk: fileDiffMap[filePath] || ''
      });
    }
  }

  // 4. 检查是否有新增加但尚未 git add 的未跟踪文件 (Untracked ??)
  try {
    const untrackedRaw = await runGit(worktreePath, ['ls-files', '--others', '--exclude-standard']);
    for (const f of untrackedRaw.split('\n')) {
      const filePath = f.trim();
      if (!filePath || processedFiles.has(filePath)) continue;
      processedFiles.add(filePath);
      
      // 读取新文件内容估算新增行数
      let addedLines = 0;
      let newContent = '';
      try {
        const full = path.join(worktreePath, filePath);
        const st = await fs.stat(full);
        if (st.size < 512 * 1024) { // 小于 512KB 读取
          const content = await fs.readFile(full, 'utf-8');
          const lines = content.split('\n');
          addedLines = lines.length;
          newContent = lines.map(l => '+' + l).join('\n');
        }
      } catch {}

      const customChunk = `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${addedLines} @@\n${newContent}\n`;

      files.push({
        filePath,
        status: '?',
        added: addedLines,
        deleted: 0,
        isBinary: false,
        diffChunk: customChunk
      });
    }
  } catch {}

  let totalAdded = 0;
  let totalDeleted = 0;
  files.forEach(f => {
    totalAdded += f.added || 0;
    totalDeleted += f.deleted || 0;
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
