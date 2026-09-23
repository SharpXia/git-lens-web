import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import os from 'node:os';
import {
  isGitRepo,
  getWorktrees,
  getBranches,
  deleteBranch,
  removeWorktree,
  pruneWorktrees,
  checkBranchExists,
  checkWorktreeExists,
  getWorktreeDiff,
  getUncommittedDiff,
  getFileContentBuffer,
  getMimeType
} from './git-inspector.js';

const PORT = process.env.PORT || 9527;
const HOME = os.homedir();

/**
 * 递归发现候选 Git 仓库 (默认只搜 workspace 下 2 层深度)
 */
async function discoverRepos() {
  const baseDirs = [
    path.join(HOME, 'workspace/individualProjects'),
    path.join(HOME, 'workspace/studioProjects'),
    path.join(HOME, 'workspace/individualProjects/ExampleTeam-worktrees')
  ];

  const repos = [];
  for (const base of baseDirs) {
    try {
      const entries = await fs.readdir(base, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory() && !ent.name.startsWith('.')) {
          const fullPath = path.join(base, ent.name);
          if (await isGitRepo(fullPath)) {
            repos.push({ name: ent.name, path: fullPath, group: path.basename(base) });
          }
        }
      }
    } catch {
      // ignore missing dir
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
    // 1. API: 发现项目列表
    if (pathname === '/api/projects' && req.method === 'GET') {
      const repos = await discoverRepos();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, repos }));
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
      const { repoPath, worktreePath, force } = await readJson();
      if (!repoPath || !worktreePath) throw new Error('Missing repoPath or worktreePath');
      const result = await removeWorktree(repoPath, worktreePath, force);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...result }));
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

    // 8. API: 获取指定 Worktree 的本地未提交改动 (Dirty/Uncommitted Diff)
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
