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

  // 并发检查每个分支相比 Main 分支是否有领先提交 (ahead)
  const mainWt = worktrees.find(w => w.isMain);
  const mainRef = (mainWt && (mainWt.branch || mainWt.head)) || 'main';

  await Promise.all(worktrees.map(async (wt) => {
    if (wt.isMain) {
      wt.aheadCount = 0;
      wt.hasDiff = wt.isDirty;
      return;
    }
    const targetRef = wt.branch || wt.head;
    if (!targetRef) {
      wt.aheadCount = 0;
      wt.hasDiff = wt.isDirty;
      return;
    }
    try {
      const countStr = await runGit(repoPath, ['rev-list', '--count', `${mainRef}..${targetRef}`]);
      wt.aheadCount = parseInt(countStr.trim(), 10) || 0;
    } catch {
      wt.aheadCount = 0;
    }
    wt.hasDiff = wt.isDirty || wt.aheadCount > 0;
  }));

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
/**
 * 获取两个 Worktree 之间或目标工作区的 Diff，支持三种模式：
 * 1. 'uncommitted': 仅未提交以及 untracked
 * 2. 'all': 提交和未提交以及 untracked (全量)
 * 3. 'committed': 仅已提交 (忽略未提交及 untracked)
 *
 * 智能回退优先级：
 * 默认优先 'uncommitted'（如果有脏代码或新增未跟踪）；
 * 若无，fallback 到 'all'（如果有领先提交或文件差异）；
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

  // 2. 检查 Target 工作区自身的未提交/未跟踪改动
  const uncommittedData = await getUncommittedDiff(targetWt.path);
  const hasUncommitted = (uncommittedData.files && uncommittedData.files.length > 0);

  // 3. 计算【仅已提交】(committed) 的 diff
  let committedDiff = '';
  try {
    committedDiff = await runGit(repoPath, ['diff', '-p', '-U3', tripleDotRange]);
  } catch (err) {
    committedDiff = `获取 Diff 失败: ${err.message}`;
  }
  const committedFileMap = splitDiffByFiles(committedDiff);
  const committedFiles = [];
  try {
    const numstatOut = await runGit(repoPath, ['diff', '--numstat', tripleDotRange]);
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

  const hasCommitted = (committedFiles.length > 0 || ahead > 0);

  // 4. 计算【全量：已提交 + 未提交 + untracked】(all)
  // 获取 merge-base
  let baseMergeSha = '';
  try {
    const baseHead = await runGit(sourceWt.path, ['rev-parse', 'HEAD']);
    const targetHead = await runGit(targetWt.path, ['rev-parse', 'HEAD']);
    baseMergeSha = await runGit(targetWt.path, ['merge-base', baseHead, targetHead]);
  } catch {}

  let allFiles = [];
  if (baseMergeSha) {
    try {
      const allNumstat = await runGit(targetWt.path, ['diff', baseMergeSha, '--numstat']);
      const allDiffRaw = await runGit(targetWt.path, ['diff', baseMergeSha, '-p', '-U3']);
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
  } else {
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
    effectiveMode,
    modesAvailable: {
      uncommitted: hasUncommitted,
      all: (allFiles.length > 0 || hasUncommitted || hasCommitted),
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
