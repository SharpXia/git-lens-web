import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  isGitRepo,
  getWorktrees,
  getBranches,
  getCleanupCandidates,
  deleteBranch,
  removeWorktree,
  pruneWorktrees,
  checkBranchExists,
  checkWorktreeExists,
  getWorktreeDiff,
  getUncommittedDiff,
  getFileContentBuffer,
  getMimeType,
  getWorktreeCommits,
  getWorktreeAheadBehind,
  getCommitDetail,
  getCommitDiff,
  commitAction,
  getStashList,
  stashAction,
  getRefDiff,
  annotateWorktreesFromBranches,
  annotateDeliveredViaWorktrees
} from './git-inspector.js';
import {
  listMergeRequests,
  createMergeRequest,
  getMergeRequest,
  mergeRequestAction
} from './merge-request-service.js';

const PORT = process.env.PORT || 9527;
const HOME = os.homedir();
// 配置目录支持环境变量覆盖，便于测试实例与日常实例隔离数据。
const CONFIG_DIR = process.env.GIT_LENS_CONFIG_DIR || path.join(HOME, '.config', 'git-lens-web');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const execFileAsync = promisify(execFile);

/**
 * 调用服务所在电脑的系统目录选择器，取消选择时返回 null。
 * 浏览器的目录上传控件不会提供服务端可用的绝对路径，因此需要本机对话框。
 */
async function chooseScanDirectory() {
  let command;
  let args;
  if (process.platform === 'darwin') {
    command = 'osascript';
    args = ['-e', 'POSIX path of (choose folder with prompt "选择要扫描的 Workspace 目录")'];
  } else if (process.platform === 'win32') {
    command = 'powershell.exe';
    args = [
      '-NoProfile', '-STA', '-Command',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = "选择要扫描的 Workspace 目录"; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }'
    ];
  } else {
    command = 'zenity';
    args = ['--file-selection', '--directory', '--title=选择要扫描的 Workspace 目录'];
  }

  try {
    const { stdout } = await execFileAsync(command, args, { maxBuffer: 16 * 1024 });
    return stdout.trim() || null;
  } catch (err) {
    if (err.code === 1) return null;
    if (err.code === 'ENOENT' && process.platform === 'linux') {
      try {
        const { stdout } = await execFileAsync('kdialog', ['--getexistingdirectory', HOME, '--title', '选择要扫描的 Workspace 目录'], { maxBuffer: 16 * 1024 });
        return stdout.trim() || null;
      } catch (fallbackError) {
        if (fallbackError.code === 1) return null;
        if (fallbackError.code === 'ENOENT') {
          throw new Error('当前系统缺少目录选择器，请安装 zenity 或 kdialog，或使用手动输入路径。');
        }
        throw new Error(`打开目录选择器失败：${fallbackError.message}`);
      }
    }
    throw new Error(`打开目录选择器失败：${err.message}`);
  }
}

/**
 * 将用户输入的目录转换为绝对路径，支持使用 ~ 表示用户主目录。
 */
function normalizeScanDirectory(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const isHomeRelative = trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\');
  const expanded = isHomeRelative
    ? path.join(HOME, trimmed.slice(1).replace(/^[/\\]+/, ''))
    : trimmed;
  return path.resolve(expanded);
}

/**
 * 读取扫描目录配置。配置文件不存在时按首次使用处理。
 */
async function readScanConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const customDirectories = Array.isArray(parsed.customDirectories)
      ? parsed.customDirectories.map(normalizeScanDirectory).filter(Boolean)
      : [];
    return { customDirectories: [...new Set(customDirectories)] };
  } catch {
    return { customDirectories: [] };
  }
}

/**
 * 保存扫描目录配置，并保证配置目录存在。
 */
async function writeScanConfig(customDirectories) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify({ customDirectories }, null, 2) + '\n', 'utf-8');
}

/**
 * 返回当前用户的自定义目录，供接口和仓库发现逻辑共同使用。
 */
async function getScanConfig() {
  const { customDirectories } = await readScanConfig();
  return { customDirectories, scanDirectories: [...customDirectories] };
}

/**
 * 解析用于比较的真实路径，兼容 macOS 上 /var 与 /private/var 这类符号链接别名。
 */
async function getComparablePath(targetPath) {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

/**
 * 移除 Worktree 后可选删除它的绑定分支，供单项与批量入口复用。
 * 删除分支前再次核对绑定关系，避免页面数据过期时删除其它分支。
 */
async function removeWorktreeWithBranch(repoPath, worktreePath, force, branchName, shouldDeleteBranch) {
  if (shouldDeleteBranch) {
    if (!branchName) throw new Error('缺少待删除的绑定分支');
    const worktrees = await getWorktrees(repoPath);
    const comparableWorktreePath = await getComparablePath(worktreePath);
    let boundWorktree = null;
    for (const worktree of worktrees) {
      if (await getComparablePath(worktree.path) === comparableWorktreePath) {
        boundWorktree = worktree;
        break;
      }
    }
    if (!boundWorktree || boundWorktree.isMain || boundWorktree.branch !== branchName) {
      throw new Error('只能删除与该 Worktree 强绑定的非主分支');
    }
  }

  const result = await removeWorktree(repoPath, worktreePath, force);
  let branchDeleted = false;
  let branchDeleteError = null;
  if (shouldDeleteBranch && result.removed) {
    try {
      const branchResult = await deleteBranch(repoPath, branchName, true);
      branchDeleted = branchResult.deleted;
      if (!branchDeleted) branchDeleteError = '分支删除后仍然存在';
    } catch (err) {
      // Worktree 已经移除，无法回滚；把分支删除失败明确返回给前端。
      branchDeleteError = err.message;
    }
  }
  return {
    ...result,
    branchName: shouldDeleteBranch ? branchName : null,
    branchDeleted,
    branchDeleteError
  };
}

/**
 * 发现扫描目录中的 Git 仓库。目录本身是仓库时直接收录，否则只检查直接子目录。
 */
async function discoverRepos(scanDirectories = null) {
  if (!scanDirectories) scanDirectories = (await getScanConfig()).scanDirectories;
  const repos = [];
  const seenPaths = new Set();
  for (const base of scanDirectories) {
    try {
      if (await isGitRepo(base)) {
        const repoPath = path.resolve(base);
        if (!seenPaths.has(repoPath)) {
          seenPaths.add(repoPath);
          repos.push({ name: path.basename(repoPath), path: repoPath, group: path.basename(path.dirname(repoPath)) });
        }
        continue;
      }
      const entries = await fs.readdir(base, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory() && !ent.name.startsWith('.')) {
          const fullPath = path.join(base, ent.name);
          if (await isGitRepo(fullPath) && !seenPaths.has(path.resolve(fullPath))) {
            seenPaths.add(path.resolve(fullPath));
            repos.push({ name: ent.name, path: fullPath, group: path.basename(base) });
          }
        }
      }
    } catch {
      // 忽略不存在或暂时无法读取的目录
    }
  }
  return repos;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // 设置 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    // 系统对话框只接受本机页面的调用，避免其他网页触发目录选择器。
    if (pathname === '/api/choose-scan-directory' && req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: '只能从本机页面打开目录选择器' }));
      }
      const directory = await chooseScanDirectory();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, directory }));
    }

    // 1. API: 发现项目列表
    if (pathname === '/api/projects' && req.method === 'GET') {
      const repos = await discoverRepos();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, repos }));
    }

    // 1.5 API: 获取当前扫描目录配置
    if (pathname === '/api/scan-directories' && req.method === 'GET') {
      const config = await getScanConfig();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, ...config }));
    }

    // 2. API: 分析指定仓库状态
    if (pathname === '/api/inspect' && req.method === 'GET') {
      const repoPath = parsed.query.path;
      if (!repoPath || !(await isGitRepo(repoPath))) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Path is not a valid git repository' }));
      }

      const [worktrees, branchData] = await Promise.all([
        getWorktrees(repoPath),
        getBranches(repoPath)
      ]);

      // 传递吸收判定收尾：worktree 自身的四方判定没有全局分支视图。
      // 先同步分支侧结论（含历史整合推断覆盖的场景），再对 worktree 直接探测载体——
      // squash/PR 合并后的开发分支在分支面板常已显示合入，worktree 面板却仍显示领先
      annotateWorktreesFromBranches(worktrees, branchData.branches);
      await annotateDeliveredViaWorktrees(repoPath, worktrees, branchData.branches);

      const staleWorktrees = worktrees.filter(w => !w.isMain && (!w.existsOnDisk || w.isPrunable));
      const redundantBranches = branchData.branches.filter(b => b.redundancyReason);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        ok: true,
        repoPath,
        mainBranch: branchData.mainBranch,
        summary: {
          totalWorktrees: worktrees.length,
          staleWorktreesCount: staleWorktrees.length,
          totalBranches: branchData.branches.length,
          redundantBranchesCount: redundantBranches.length
        },
        worktrees,
        branches: branchData.branches
      }));
    }

    // 读取 POST Body 辅助函数
    const readJson = () => new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); }
        catch (e) { reject(e); }
      });
      req.on('error', reject);
    });

    // 1.6 API: 保存自定义扫描目录
    if (pathname === '/api/scan-directories' && req.method === 'POST') {
      const body = await readJson();
      if (!Array.isArray(body.directories)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: 'directories 必须是目录路径数组' }));
      }

      const normalizedDirectories = body.directories.map(normalizeScanDirectory);
      if (normalizedDirectories.some(dir => !dir)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: '目录路径不能为空' }));
      }

      const customDirectories = [...new Set(normalizedDirectories)];
      const invalidDirectories = [];
      for (const directory of customDirectories) {
        try {
          const stat = await fs.stat(directory);
          if (!stat.isDirectory()) invalidDirectories.push(directory);
        } catch {
          invalidDirectories.push(directory);
        }
      }

      if (invalidDirectories.length > 0) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          ok: false,
          error: '以下路径不存在或不是目录',
          invalidDirectories
        }));
      }

      await writeScanConfig(customDirectories);
      const config = await getScanConfig();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, ...config }));
    }

    // 3. API: 清理分支 (精细化判定，返回单项删除状态)
    if (pathname === '/api/delete-branch' && req.method === 'POST') {
      const { repoPath, branchName, force } = await readJson();
      if (!repoPath || !branchName) throw new Error('Missing repoPath or branchName');
      const result = await deleteBranch(repoPath, branchName, force);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...result }));
    }

    // 4. API: 移除 Worktree (精细化判定，返回单项移除状态)
    if (pathname === '/api/remove-worktree' && req.method === 'POST') {
      const { repoPath, worktreePath, force, branchName, deleteBranch: shouldDeleteBranch } = await readJson();
      if (!repoPath || !worktreePath) throw new Error('Missing repoPath or worktreePath');
      let result;
      try {
        result = await removeWorktreeWithBranch(repoPath, worktreePath, force, branchName, shouldDeleteBranch);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...result }));
    }

    // 4.1 批量清理预览：只返回已同步且干净的 Worktree、未绑定的已合入分支。
    if (pathname === '/api/cleanup-candidates' && req.method === 'GET') {
      const repoPath = parsed.query.path;
      if (!repoPath || !(await isGitRepo(repoPath))) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: '仓库路径无效' }));
      }
      const candidates = await getCleanupCandidates(repoPath);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, ...candidates }));
    }

    // 4.2 执行前重新核验每个候选；只处理用户在预览中确认的路径。
    if (pathname === '/api/cleanup-synced-worktrees' && req.method === 'POST') {
      const { repoPath, paths, deleteBoundBranches } = await readJson();
      if (!repoPath || !(await isGitRepo(repoPath)) || !Array.isArray(paths)
        || paths.length > 100 || paths.some(item => typeof item !== 'string' || !path.isAbsolute(item))) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: '清理参数无效' }));
      }
      const current = await getCleanupCandidates(repoPath);
      const results = [];
      for (const worktreePath of new Set(paths)) {
        try {
          const comparablePath = await getComparablePath(worktreePath);
          let candidate = null;
          for (const item of current.worktrees) {
            if (await getComparablePath(item.path) === comparablePath) {
              candidate = item;
              break;
            }
          }
          if (!candidate) {
            results.push({ path: worktreePath, removed: false, error: '状态已变化，不再符合安全清理条件' });
            continue;
          }
          const result = await removeWorktreeWithBranch(
            repoPath, candidate.path, false, candidate.branch, Boolean(deleteBoundBranches)
          );
          results.push({ path: worktreePath, ...result });
        } catch (err) {
          results.push({ path: worktreePath, removed: false, error: err.message });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, results }));
    }

    // 4.3 分支批量清理只接受预览中的名称，并逐项重新核验绑定与合入状态。
    if (pathname === '/api/cleanup-redundant-branches' && req.method === 'POST') {
      const { repoPath, names } = await readJson();
      if (!repoPath || !(await isGitRepo(repoPath)) || !Array.isArray(names)
        || names.length > 100 || names.some(item => typeof item !== 'string' || !item.trim())) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: '清理参数无效' }));
      }
      const current = await getCleanupCandidates(repoPath);
      const results = [];
      for (const branchName of new Set(names)) {
        try {
          const candidate = current.branches.find(item => item.name === branchName);
          if (!candidate) {
            results.push({ name: branchName, deleted: false, error: '状态已变化，不再符合安全清理条件' });
            continue;
          }
          const result = await deleteBranch(repoPath, branchName, true);
          results.push({ name: branchName, ...result });
        } catch (err) {
          results.push({ name: branchName, deleted: false, error: err.message });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, results }));
    }

    // 5. API: 单项检查分支状态
    if (pathname === '/api/check-branch' && req.method === 'GET') {
      const repoPath = parsed.query.path;
      const branchName = parsed.query.branch;
      if (!repoPath || !branchName) throw new Error('Missing repoPath or branchName');
      const exists = await checkBranchExists(repoPath, branchName);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, branchName, exists }));
    }

    // 6. API: 单项检查 Worktree 状态
    if (pathname === '/api/check-worktree' && req.method === 'GET') {
      const repoPath = parsed.query.path;
      const worktreePath = parsed.query.worktree;
      if (!repoPath || !worktreePath) throw new Error('Missing repoPath or worktreePath');
      const exists = await checkWorktreeExists(repoPath, worktreePath);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, worktreePath, exists }));
    }

    // 7. API: 获取两个 Worktree 之间的对比 Diff (支持 mode 参数: uncommitted | all | committed)
    if (pathname === '/api/diff-worktrees' && req.method === 'GET') {
      const repoPath = parsed.query.path;
      const source = parsed.query.source;
      const target = parsed.query.target;
      const mode = parsed.query.mode || null;
      if (!repoPath || !source || !target) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Missing path, source, or target parameter' }));
      }
      const diffData = await getWorktreeDiff(repoPath, source, target, mode);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, diff: diffData }));
    }

    // 8. API: 获取指定 Worktree 的提交记录
    if (pathname === '/api/worktree-commits' && req.method === 'GET') {
      const worktreePath = parsed.query.worktree;
      if (!worktreePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Missing worktree parameter' }));
      }
      try {
        const result = await getWorktreeCommits(worktreePath, {
          limit: parsed.query.limit,
          offset: parsed.query.offset,
          base: parsed.query.base,
          fullHistory: parsed.query.fullHistory,
          author: parsed.query.author,
          since: parsed.query.since,
          until: parsed.query.until,
          grep: parsed.query.grep,
          ref: parsed.query.ref
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      } catch (err) {
        const status = err.statusCode || 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // 8.1 API: 获取单条提交详情（元信息 + 逐文件统计）
    if (pathname === '/api/commit-detail' && req.method === 'GET') {
      const worktreePath = parsed.query.worktree;
      const sha = parsed.query.sha;
      if (!worktreePath || !sha) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Missing worktree or sha parameter' }));
      }
      try {
        const result = await getCommitDetail(worktreePath, sha);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      } catch (err) {
        const status = err.statusCode || 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // 8.2 API: 获取指定 Worktree 相对基准分支的领先/落后统计
    if (pathname === '/api/worktree-ahead-behind' && req.method === 'GET') {
      const worktreePath = parsed.query.worktree;
      if (!worktreePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Missing worktree parameter' }));
      }
      try {
        const result = await getWorktreeAheadBehind(worktreePath, { base: parsed.query.base, ref: parsed.query.ref });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      } catch (err) {
        const status = err.statusCode || 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // 8.3 API: 获取单条提交的逐文件文本 Diff（merge 对第一父、根提交用 --root，规则与 8.1 一致）
    if (pathname === '/api/commit-diff' && req.method === 'GET') {
      const worktreePath = parsed.query.worktree;
      const sha = parsed.query.sha;
      if (!worktreePath || !sha) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Missing worktree or sha parameter' }));
      }
      try {
        const result = await getCommitDiff(worktreePath, sha);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      } catch (err) {
        const status = err.statusCode || 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // 9. API: 获取指定 Worktree 的本地未提交改动 (Dirty/Uncommitted Diff)
    if (pathname === '/api/uncommitted-diff' && req.method === 'GET') {
      const worktreePath = parsed.query.worktree;
      if (!worktreePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Missing worktree parameter' }));
      }
      const uncommitted = await getUncommittedDiff(worktreePath);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, uncommitted }));
    }

    // 10. API: 对指定 Worktree 的当前分支执行 cherry-pick / revert 写操作。
    // 请求体 { worktree, action, sha }；所有业务校验（action 白名单/路径/sha）都在
    // commitAction 内完成并抛带 statusCode 的中文错误，冲突等失败时后端已自动回滚现场。
    if (pathname === '/api/commit-action' && req.method === 'POST') {
      const { worktree, action, sha } = await readJson();
      try {
        const result = await commitAction(worktree, action, sha);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      } catch (err) {
        const status = err.statusCode || 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // 11.1 API: 获取指定 Worktree 的 stash 列表
    if (pathname === '/api/stash-list' && req.method === 'GET') {
      const worktreePath = parsed.query.worktree;
      if (!worktreePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Missing worktree parameter' }));
      }
      try {
        const stashes = await getStashList(worktreePath);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, stashes }));
      } catch (err) {
        const status = err.statusCode || 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // 11.2 API: 对指定 Worktree 执行 stash 与未提交修改操作。
    // pop 可另选同仓库的目标 Worktree 或分支；未绑定的分支需指定新 Worktree 目录。
    if (pathname === '/api/stash-action' && req.method === 'POST') {
      const { worktree, action, message, stashRef, targetWorktree, targetBranch, newWorktreePath } = await readJson();
      try {
        const result = await stashAction(worktree, action, { message, stashRef, targetWorktree, targetBranch, newWorktreePath });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      } catch (err) {
        const status = err.statusCode || 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // 11.5 API: 本地 Merge Request 列表（可按 status 过滤）。
    // 业务校验（仓库路径/状态白名单）收敛在 listMergeRequests 内，err.statusCode 统一捕获。
    if (pathname === '/api/merge-requests' && req.method === 'GET') {
      try {
        const result = await listMergeRequests({
          configDir: CONFIG_DIR,
          repoPath: parsed.query.repoPath,
          status: parsed.query.status
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        const status = err.statusCode || 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // 11.6 API: 创建本地 Merge Request（重复 open MR 返回 409）
    if (pathname === '/api/merge-requests' && req.method === 'POST') {
      const { repoPath, sourceBranch, targetBranch, title, description } = await readJson();
      try {
        const result = await createMergeRequest({ configDir: CONFIG_DIR, repoPath, sourceBranch, targetBranch, title, description });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        const status = err.statusCode || 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // 11.7 API: 获取单条 Merge Request（id 为 UUID，非法格式返回 400，不存在返回 404）
    if (pathname.startsWith('/api/merge-requests/') && req.method === 'GET') {
      const mrId = pathname.slice('/api/merge-requests/'.length);
      try {
        const result = await getMergeRequest({ configDir: CONFIG_DIR, repoPath: parsed.query.repoPath, id: decodeURIComponent(mrId) });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        const status = err.statusCode || 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // 11.8 API: Merge Request 审阅/合并操作（approve/request_changes/reject/cancel/merge）。
    // 合并会真实修改目标分支的 Worktree（--no-ff），冲突时服务端已自动 merge --abort，MR 保持 open。
    if (pathname === '/api/merge-requests/action' && req.method === 'POST') {
      const { repoPath, id, action, reason } = await readJson();
      try {
        const result = await mergeRequestAction({ configDir: CONFIG_DIR, repoPath, id, action, reason });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        const status = err.statusCode || 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // 7.5 API: Worktree/Branch 通用 Diff。sourceType/targetType 取 worktree|branch，
    // source/target 按类型分别为 Worktree 路径或本地分支名；语义见 getRefDiff。
    if (pathname === '/api/diff-refs' && req.method === 'GET') {
      const repoPath = parsed.query.path;
      const sourceType = parsed.query.sourceType;
      const source = parsed.query.source;
      const targetType = parsed.query.targetType;
      const target = parsed.query.target;
      const mode = parsed.query.mode || null;
      if (!repoPath || !sourceType || !source || !targetType || !target) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: '缺少 path、sourceType、source、targetType 或 target 参数' }));
      }
      try {
        const diffData = await getRefDiff(repoPath, { kind: sourceType, value: source }, { kind: targetType, value: target }, mode);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, diff: diffData }));
      } catch (err) {
        const status = err.statusCode || 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // 8.5 API: 获取指定版本或工作区的原始文件二进制流 (如图片显示)
    if (pathname === '/api/raw-file' && req.method === 'GET') {
      const repoPath = parsed.query.repoPath;
      const revision = parsed.query.revision || 'HEAD';
      const filePath = parsed.query.filePath;
      const worktreePath = parsed.query.worktreePath || null;

      if (!filePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Missing filePath parameter' }));
      }

      const buffer = await getFileContentBuffer(repoPath, revision, filePath, worktreePath);
      if (!buffer) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('File not found in git revision or worktree');
      }

      const mime = getMimeType(filePath);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': buffer.length,
        'Cache-Control': 'no-cache'
      });
      return res.end(buffer);
    }

    // 9. API: Worktree Prune
    if (pathname === '/api/prune-worktrees' && req.method === 'POST') {
      const { repoPath } = await readJson();
      if (!repoPath) throw new Error('Missing repoPath');
      const out = await pruneWorktrees(repoPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, output: out }));
    }

    // 静态首页 HTML
    if (pathname === '/' || pathname === '/index.html') {
      const html = await fs.readFile(path.join(path.dirname(url.fileURLToPath(import.meta.url)), '../public/index.html'), 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      return res.end(html);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Git Lens Web running on http://127.0.0.1:${PORT}`);
});
