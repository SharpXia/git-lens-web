/**
 * /api/raw-file WORKTREE 分支路径包含性校验（DEF-001，P1 安全缺陷修复）的测试。
 *
 * 缺陷：getFileContentBuffer 的 WORKTREE 分支曾用 path.resolve(worktreePath, filePath)
 * 直接读盘，`../../etc/passwd` 相对路径与绝对路径都能越出 Worktree 读任意文件。
 * 修复：解析结果必须位于 realpath 归一后的 worktreePath 内（防 `../`/绝对路径注入），
 * 且对实际路径再次 realpath 比对（防 symlink 逃逸）；越界返回 4xx 中文错误。
 *
 * 同时回归 git show 分支（revision 非 WORKTREE）行为不变。
 * 全部 fixture 在 /tmp 下 mkdtemp 自建，结束后统一清理。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getFileContentBuffer } from '../src/git-inspector.js';
import { createGitLensServer } from '../src/git-lens-server.js';

const execFileAsync = promisify(execFile);

/** 所有临时目录，测试结束后统一删除 */
const tempRoots = [];

after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  // 隔离证明：本测试进程内不允许残留任何监听中的 TCP 服务
  const active = process.getActiveResourcesInfo();
  assert.equal(
    active.filter(name => name === 'TCPServerWrap').length, 0,
    `测试结束后应无残留监听，实际活动资源：${[...new Set(active)].join(',')}`
  );
});

/**
 * 构造越界测试 fixture：
 * <root>/outside.txt        Worktree 外的敏感文件
 * <root>/wt/a.txt           Worktree 内的正常文件
 * <root>/wt/link-out        指向 Worktree 外的符号链接（逃逸样本）
 * <root>/wt/link-in         指向 Worktree 内 a.txt 的符号链接（不应误伤）
 * <root>/wt/sub/b.txt       子目录文件（验证嵌套路径放行）
 */
async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-lens-raw-file-'));
  tempRoots.push(root);
  const wt = path.join(root, 'wt');
  await fs.mkdir(path.join(wt, 'sub'), { recursive: true });
  await fs.writeFile(path.join(root, 'outside.txt'), 'worktree 外的敏感内容');
  await fs.writeFile(path.join(wt, 'a.txt'), 'worktree 内文件');
  await fs.writeFile(path.join(wt, 'sub', 'b.txt'), '子目录文件');
  await fs.symlink(path.join(root, 'outside.txt'), path.join(wt, 'link-out'));
  await fs.symlink('a.txt', path.join(wt, 'link-in'));
  return { root, wt };
}

test('WORKTREE：正常文件、子目录文件与指向内部文件的符号链接均可读取', async () => {
  const { wt } = await createFixture();

  const direct = await getFileContentBuffer(null, 'WORKTREE', 'a.txt', wt);
  assert.equal(direct.toString('utf-8'), 'worktree 内文件');

  const nested = await getFileContentBuffer(null, 'WORKTREE', 'sub/b.txt', wt);
  assert.equal(nested.toString('utf-8'), '子目录文件');

  const linkInside = await getFileContentBuffer(null, 'WORKTREE', 'link-in', wt);
  assert.equal(linkInside.toString('utf-8'), 'worktree 内文件');
});

test('WORKTREE：越界相对路径、绝对路径、symlink 逃逸均返回 400 中文错误', async () => {
  const { root, wt } = await createFixture();

  for (const [label, filePath] of [
    ['相对路径回溯', '../../outside.txt'],
    ['回溯到根再进入', `../${path.basename(root)}/outside.txt`],
    ['绝对路径', '/etc/hosts'],
    ['符号链接逃逸', 'link-out']
  ]) {
    try {
      const buffer = await getFileContentBuffer(null, 'WORKTREE', filePath, wt);
      assert.fail(`${label} 应被拒绝，实际返回：${buffer && buffer.toString('utf-8').slice(0, 40)}`);
    } catch (err) {
      assert.equal(err.statusCode, 400, `${label} 应返回 4xx，实际：${err.message}`);
      assert.match(err.message, /Worktree/, `${label} 的错误信息应为中文：${err.message}`);
    }
  }
});

test('WORKTREE：不存在的文件保持返回 null（由路由返回 404）', async () => {
  const { wt } = await createFixture();
  assert.equal(await getFileContentBuffer(null, 'WORKTREE', 'missing.txt', wt), null);
  // 路径合法但目标是目录时同样按读取失败处理
  assert.equal(await getFileContentBuffer(null, 'WORKTREE', 'sub', wt), null);
});

/**
 * 向工厂实例发送 GET /api/raw-file 请求并收集响应。
 */
function requestRawFile(port, params) {
  const query = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/api/raw-file?${query}` }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('HTTP 层：越界 filePath 返回 400 中文，正常 WORKTREE 读取返回 200', async () => {
  const { root, wt } = await createFixture();
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-lens-raw-file-config-'));
  tempRoots.push(configDir);
  const instance = createGitLensServer({ configDir, port: 0 });
  const { port } = await instance.ready;

  const traversal = await requestRawFile(port, {
    repoPath: root, revision: 'WORKTREE', worktreePath: wt, filePath: '../../outside.txt'
  });
  assert.equal(traversal.status, 400);
  assert.match(JSON.parse(traversal.body.toString('utf-8')).error, /Worktree/);

  const symlinkEscape = await requestRawFile(port, {
    repoPath: root, revision: 'WORKTREE', worktreePath: wt, filePath: 'link-out'
  });
  assert.equal(symlinkEscape.status, 400);

  const ok = await requestRawFile(port, {
    repoPath: root, revision: 'WORKTREE', worktreePath: wt, filePath: 'a.txt'
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.toString('utf-8'), 'worktree 内文件');
  await instance.close();
});

test('HTTP 层：git show 分支（revision=HEAD）行为不变，越界引用仍 404', async () => {
  // WORKTREE 分支的修复不应影响 git show 分支；用真实仓库回归两种取法
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-lens-raw-file-repo-'));
  tempRoots.push(root);
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: '测试用户', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: '测试用户', GIT_COMMITTER_EMAIL: 'test@example.com'
  };
  const git = (...args) => execFileAsync('git', args, { cwd: repo, env: gitEnv });
  await git('init', '-q', '-b', 'main');
  await fs.writeFile(path.join(repo, 'a.txt'), '已提交内容');
  await git('add', '.');
  await git('commit', '-q', '-m', '初始提交');

  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-lens-raw-file-config2-'));
  tempRoots.push(configDir);
  const instance = createGitLensServer({ configDir, port: 0 });
  const { port } = await instance.ready;

  const committed = await requestRawFile(port, { repoPath: repo, revision: 'HEAD', filePath: 'a.txt' });
  assert.equal(committed.status, 200);
  assert.equal(committed.body.toString('utf-8'), '已提交内容');

  // git 拒绝越界引用 → runGitRaw 失败 → null → 路由 404
  const traversal = await requestRawFile(port, { repoPath: repo, revision: 'HEAD', filePath: '../../outside.txt' });
  assert.equal(traversal.status, 404);
  await instance.close();
});
