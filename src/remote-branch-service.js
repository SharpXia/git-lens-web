/**
 * remote-branch-service.js —— 分支管理域服务（本地分支 + 远端分支）。
 *
 * 覆盖六类能力，全部只经 execFile 参数数组调用 git（绝不拼接 shell 字符串）：
 *  1. 远端/本地分支清单（含相对主干的领先/落后、检出绑定与保护分支标记）
 *  2. 纯远端操作：基于现有远端分支 push 出一个新远端分支（不落地任何本地分支）
 *  3. 分支删除：删除非保护远端分支；删除本地分支（主分支/被检出/未合入三重保护）
 *  4. 工作区分支切换：检出本地分支，或检出远端分支为指定名称的本地跟踪分支
 *  5. 合并远端/本地分支到当前工作区，冲突保持现场交由 UI 快捷处理（ours/theirs/自定义编辑）
 *  6. 远端刷新（fetch --prune --all）与最近 fetch 时间读取
 *
 * 校验链与错误风格与 merge-request-service.js 一致：业务失败抛带 statusCode 的
 * 中文错误（400/404/409），server.js 路由统一按 err.statusCode || 500 捕获返回。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isGitRepo, getWorktrees, detectMainBranch } from './git-inspector.js';

const exec = promisify(execFile);

// git 可执行文件路径，解析优先级与 git-inspector.js 一致：
// configureGitPath 显式传入 > GIT_LENS_GIT_PATH 环境变量 > 'git'。
// 本模块的 runGit/tryGit 与既有模块互相独立，注入也要各自维护一份。
let gitExecutable = process.env.GIT_LENS_GIT_PATH || 'git';

/** 远端网络操作（fetch/push/ls-remote）超时毫秒数，与主工作区 Pull 的 120 秒口径一致 */
const REMOTE_TIMEOUT_MS = 120000;

/**
 * 配置本模块全部 git 调用使用的可执行文件路径。
 * @param {string} [gitPath] - git 可执行文件路径；为空时保持当前配置不变
 * @returns {string} 配置后的实际路径（供诊断接口展示）
 */
export function configureGitPath(gitPath) {
  if (typeof gitPath === 'string' && gitPath.trim() !== '') {
    gitExecutable = gitPath;
  }
  return gitExecutable;
}

/**
 * 读取本模块当前生效的 git 可执行文件路径。
 * @returns {string}
 */
export function getGitPath() {
  return gitExecutable;
}

/**
 * 构造带 statusCode 的业务错误对象（与仓库既有中文错误惯例一致，
 * server.js 路由统一按 err.statusCode || 500 捕获返回）。
 * @param {string} message - 中文错误信息
 * @param {number} statusCode - HTTP 状态码（400/404/409）
 * @returns {Error}
 */
function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * 执行 git 命令并返回 trim 后的 stdout，失败直接抛错。
 * @param {string} cwd - git 命令工作目录
 * @param {string[]} args - git 参数数组
 * @param {object} [options] - 额外 execFile 选项（timeout/env 等）
 * @returns {Promise<string>}
 */
async function runGit(cwd, args, options = {}) {
  const { stdout } = await exec(gitExecutable, args, { cwd, maxBuffer: 20 * 1024 * 1024, ...options });
  return stdout.trim();
}

/**
 * 执行 git 命令但把失败视为普通结果（不抛错），适合探测类命令：
 * rev-parse 验证不存在的引用、merge 冲突、ls-remote 网络失败等，退出码非 0 属正常分支。
 * @param {string} cwd - git 命令工作目录
 * @param {string[]} args - git 参数数组
 * @param {object} [options] - 额外 execFile 选项（timeout/env 等）
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, killed: boolean}>}
 */
async function tryGit(cwd, args, options = {}) {
  try {
    const { stdout, stderr } = await exec(gitExecutable, args, { cwd, maxBuffer: 20 * 1024 * 1024, ...options });
    return { ok: true, stdout: stdout || '', stderr: stderr || '', killed: false };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      killed: err.killed === true
    };
  }
}

/**
 * 提取 git 失败输出的关键摘要（优先 CONFLICT/error/fatal 行），供 409 错误信息使用。
 * 与 git-inspector.js 中 summarizeGitFailure 行为一致，本地复制一份避免跨模块私有依赖。
 * @param {string} rawMessage - 原始错误输出
 * @returns {string} 摘要（超 200 字符截断）
 */
function summarizeGitFailure(rawMessage) {
  const lines = String(rawMessage || '').split('\n').map(l => l.trim()).filter(Boolean);
  const keyLine = lines.find(l => /^(CONFLICT|error:|fatal:)/i.test(l));
  const summary = keyLine || lines[1] || lines[0] || '未知原因';
  return summary.length > 200 ? `${summary.slice(0, 200)}...` : summary;
}

/**
 * 校验仓库路径：必须存在且含 .git。路径不存在返回 404，不是 Git 仓库返回 400。
 * @param {string} repoPath - 仓库路径
 * @returns {Promise<string>} path.resolve 归一化后的仓库绝对路径
 */
async function resolveRepoPath(repoPath) {
  if (typeof repoPath !== 'string' || repoPath.trim() === '') {
    throw httpError('repoPath 参数必须为非空字符串', 400);
  }
  const normalized = path.resolve(repoPath);
  if (await isGitRepo(normalized)) {
    return normalized;
  }
  try {
    await fs.stat(normalized);
  } catch {
    throw httpError('指定的仓库路径不存在', 404);
  }
  throw httpError('指定的路径不是 Git 仓库', 400);
}

/**
 * 校验分支名/引用段字符串的合法性（不校验是否存在）。
 * 先做字符串前置校验防止参数被 git 当成选项，再用 check-ref-format 做权威校验。
 * @param {string} name - 分支名（可含 / 的多级名称）
 * @param {string} label - 错误信息中的角色标注
 * @param {string} cwd - git 命令工作目录
 */
async function validateRefFormat(name, label, cwd) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw httpError(`${label}必须为非空字符串`, 400);
  }
  // 以 '-' 开头或含空白/控制字符的名字会被 git 误解析为选项或直接非法，前置拒绝
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/')
    || /[\s\0]/.test(name) || name.includes('..') || name.length > 250) {
    throw httpError(`${label}「${name}」不是合法的分支名`, 400);
  }
  const result = await tryGit(cwd, ['check-ref-format', '--branch', name]);
  if (!result.ok) {
    throw httpError(`${label}「${name}」不是合法的分支名`, 400);
  }
}

/**
 * 校验 worktree 路径真实属于当前仓库且在磁盘上可用，返回 realpath 归一后的路径。
 * 校验链：绝对路径 400 → 目录 404 → 不属于本仓库或已失联 404。
 * @param {string} repoPath - 归一化后的仓库路径
 * @param {string} worktreePath - 待校验的 worktree 路径
 * @returns {Promise<{worktreePath: string, worktree: object}>}
 */
async function resolveWorktree(repoPath, worktreePath) {
  if (typeof worktreePath !== 'string' || worktreePath.trim() === '' || !path.isAbsolute(worktreePath)) {
    throw httpError('worktree 路径必须为非空的绝对路径', 400);
  }
  try {
    const stat = await fs.stat(worktreePath);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    throw httpError('指定的工作区路径不存在', 404);
  }
  const worktrees = await getWorktrees(repoPath);
  const targetReal = await toRealPathSafe(worktreePath);
  const entries = await Promise.all(worktrees.map(async wt => ({ wt, realPath: await toRealPathSafe(wt.path) })));
  const target = entries.find(entry => entry.realPath === targetReal)?.wt;
  if (!target || target.existsOnDisk === false || target.isPrunable) {
    throw httpError('指定的工作区不属于当前仓库或已失联', 404);
  }
  return { worktreePath: target.path, worktree: target };
}

/**
 * realpath 解析路径；目标不存在时回退 path.resolve（首次出现的路径无法 realpath）。
 * @param {string} targetPath - 待解析路径
 * @returns {Promise<string>}
 */
async function toRealPathSafe(targetPath) {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

/**
 * 目标路径是否位于 base 目录内（含 base 自身）。
 * @param {string} targetPath - realpath 归一后的待检路径
 * @param {string} baseReal - realpath 归一后的基座目录
 * @returns {boolean}
 */
function isPathInsideBase(targetPath, baseReal) {
  return targetPath === baseReal || targetPath.startsWith(baseReal + path.sep);
}

/**
 * 校验并归一冲突文件相对路径：拒绝绝对路径、`..` 回溯与符号链接逃逸，
 * 返回 realpath 基座下的绝对路径，供读写文件使用。
 * @param {string} worktreeReal - worktree realpath 基座
 * @param {string} filePath - 相对路径
 * @returns {Promise<string>} 基座内的绝对路径
 */
async function resolveConflictFilePath(worktreeReal, filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw httpError('filePath 必须为非空字符串', 400);
  }
  if (filePath.startsWith('/') || filePath.split(/[/\\]/).includes('..')) {
    throw httpError('filePath 必须是工作区内的相对路径', 400);
  }
  const absolute = path.resolve(worktreeReal, filePath);
  if (!isPathInsideBase(absolute, worktreeReal)) {
    throw httpError('filePath 解析后越出工作区边界，拒绝访问', 400);
  }
  // 已存在的文件若经符号链接指向工作区之外，同样拒绝（写入会跟随链接落盘到外部）
  try {
    const real = await fs.realpath(absolute);
    if (!isPathInsideBase(real, worktreeReal)) {
      throw httpError('filePath 经符号链接指向工作区之外的路径，拒绝访问', 400);
    }
  } catch (err) {
    if (err.statusCode) throw err;
    // 目标不存在（如 both deleted）：保持 resolve 后路径，由调用方按需创建
  }
  return absolute;
}

/**
 * 解析 `git status --porcelain -z` 输出，返回 { 路径: XY 状态码 } 映射。
 * -z 输出不加引号且以 NUL 分隔，天然兼容中文/空格/特殊字符路径；
 * 重命名类条目（X 或 Y 为 R/C）会额外携带一个原始路径字段，需成对消费。
 * @param {string} raw - status --porcelain -z 原始输出
 * @returns {Map<string, string>} 工作区相对路径 → 两列状态码（如 "UU"）
 */
function parseStatusPorcelainZ(raw) {
  const result = new Map();
  const fields = String(raw || '').split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const filePath = entry.slice(3);
    result.set(filePath, xy);
    if (xy.includes('R') || xy.includes('C')) {
      i += 1; // 跳过紧随其后的原始路径字段
    }
  }
  return result;
}

/** porcelain 两列状态码中代表「未合并冲突」的枚举（git 文档 short format 定义） */
const UNMERGED_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * 检测 worktree 的 merge/rebase/cherry-pick/revert 中间状态。
 * merge/cherry-pick/revert 留下 *_HEAD 引用（rev-parse 探测）；rebase 的
 * sequencer 是目录，经 rev-parse --git-path 定位后按文件系统存在性判断。
 * @param {string} wtPath - worktree 路径
 * @returns {Promise<string|null>} 中间状态名称，无残留时返回 null
 */
async function detectInProgressState(wtPath) {
  const headProbes = [
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert']
  ];
  for (const [ref, label] of headProbes) {
    const result = await tryGit(wtPath, ['rev-parse', '-q', '--verify', ref]);
    if (result.ok && result.stdout.trim()) {
      return label;
    }
  }
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    const result = await tryGit(wtPath, ['rev-parse', '--git-path', dir]);
    if (!result.ok || !result.stdout.trim()) continue;
    const dirPath = path.resolve(wtPath, result.stdout.trim());
    try {
      await fs.access(dirPath);
      return 'rebase';
    } catch {
      // 目录不存在，继续探测下一个
    }
  }
  return null;
}

/**
 * 解析 unmerged 路径的 -z 输出为路径数组。
 * @param {string} raw - git diff --name-only --diff-filter=U -z 原始输出
 * @returns {string[]}
 */
function parseUnmergedPaths(raw) {
  return String(raw || '').split('\0').filter(Boolean);
}

/**
 * 读取 name-rev 对 MERGE_HEAD 的可读名称，失败回退 MERGE_MSG 的引号内容，再回退短 SHA。
 * @param {string} wtPath - worktree 路径
 * @returns {Promise<string>}
 */
async function resolveMergeTheirsLabel(wtPath) {
  const headSha = (await tryGit(wtPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).stdout.trim();
  if (headSha) {
    const named = await tryGit(wtPath,
      ['name-rev', '--name-only', '--refs=refs/remotes/*', '--refs=refs/heads/*', headSha]);
    if (named.ok && named.stdout.trim()) {
      return named.stdout.trim().replace(/^remotes\//, '');
    }
  }
  const mergeMsg = await tryGit(wtPath, ['rev-parse', '--git-path', 'MERGE_MSG']);
  if (mergeMsg.ok && mergeMsg.stdout.trim()) {
    try {
      const msgPath = path.resolve(wtPath, mergeMsg.stdout.trim());
      const content = await fs.readFile(msgPath, 'utf-8');
      const quoted = content.match(/^Merge [^\n']*'([^']+)'/);
      if (quoted) return quoted[1];
    } catch {
      // MERGE_MSG 不可读时走短 SHA 兜底
    }
  }
  return headSha ? headSha.slice(0, 7) : '来源分支';
}

/** 冲突文件的 HTTP 展示语义（porcelain 未合并码 → 中文说明） */
const UNMERGED_CODE_LABELS = {
  UU: '双方修改',
  AA: '双方新增',
  DD: '双方删除',
  AU: '我方新增、对方删除',
  UA: '我方删除、对方新增',
  DU: '我方删除、对方修改',
  UD: '我方修改、对方删除'
};

/**
 * 读取本仓库最近一次成功 fetch 的时间（FETCH_HEAD 的修改时间）。
 * 从未 fetch 过（clone 后未拉取、无远端等）返回 null，供「合并前久未刷新提醒」使用。
 * rev-parse --git-path 自动把 worktree 路径归位到共享 .git 目录，FETCH_HEAD 为仓库级文件。
 * @param {string} repoPath - 仓库路径
 * @returns {Promise<string|null>} ISO 时间字符串；无法确定时返回 null
 */
export async function getLastFetchTime(repoPath) {
  const fetchHead = (await tryGit(repoPath, ['rev-parse', '--git-path', 'FETCH_HEAD'])).stdout.trim();
  if (!fetchHead) return null;
  try {
    const stat = await fs.stat(path.resolve(repoPath, fetchHead));
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * 解析一个远端的保护分支集合（不可删除的分支）。
 *
 * 保护语义与 GitHub 一致：远端 HEAD 符号引用（refs/remotes/<remote>/HEAD）指向的
 * 默认分支不可删除。未设置 HEAD 别名（add remote 后未 fetch 过）时退化为保护
 * 本地主干同名的远端分支，保证 origin/main 这类主干在任何情况下都不会被误删。
 * @param {string} normalizedRepo - 归一化仓库路径
 * @param {string} remote - 远端名
 * @returns {Promise<Set<string>>} 保护分支短名集合
 */
async function resolveProtectedRemoteBranches(normalizedRepo, remote) {
  const protectedSet = new Set();
  const headRef = (await tryGit(normalizedRepo, ['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`])).stdout.trim();
  if (headRef.startsWith(`refs/remotes/${remote}/`)) {
    protectedSet.add(headRef.slice(`refs/remotes/${remote}/`.length));
  } else {
    protectedSet.add(await detectMainBranch(normalizedRepo));
  }
  return protectedSet;
}

/**
 * 列出远端分支及每条的同步状态。
 *
 * 每条返回：名称（remote/branch 形式）、HEAD 提交元信息、相对主干的 ahead/behind
 * （ahead = 该远端分支独有提交数）、本地同名分支的对应关系
 * （ahead = 本地独有、behind = 远端独有），以及 isProtected（是否为该远端的
 * 默认分支/保护分支，保护分支不允许删除）。
 * 额外返回 lastFetchAt（仓库级最近一次 fetch 时间），供前端判断清单新鲜度。
 * @param {string} repoPath - 仓库路径
 * @returns {Promise<{mainBranch: string, lastFetchAt: string|null, branches: Array<object>}>}
 */
export async function listRemoteBranches(repoPath) {
  const normalizedRepo = await resolveRepoPath(repoPath);

  // refs/remotes 全量清单；跳过 origin/HEAD 这类符号别名与裸 remote 根引用
  const refFormat = '%(refname)|%(objectname)|%(committerdate:iso-strict)|%(authorname)|%(contents:subject)';
  const refOutput = await runGit(normalizedRepo, ['for-each-ref', 'refs/remotes', `--format=${refFormat}`, '--sort=-committerdate']);
  const rawRefs = refOutput.split('\n').filter(Boolean)
    .map(line => {
      const [refname = '', objectname = '', committerdate = '', authorname = '', ...subjectRest] = line.split('|');
      return { refname, objectname, committerdate, authorname, subject: subjectRest.join('|') };
    })
    .filter(ref => /^refs\/remotes\/[^/]+\/.+/.test(ref.refname) && !/\/HEAD$/.test(ref.refname));

  // 本地分支头 SHA 清单，用于计算同名分支的领先/落后
  const localOutput = await runGit(normalizedRepo, ['for-each-ref', 'refs/heads', '--format=%(refname:short)|%(objectname)']);
  const localHeads = new Map(
    localOutput.split('\n').filter(Boolean).map(line => {
      const idx = line.indexOf('|');
      return [line.slice(0, idx), line.slice(idx + 1)];
    })
  );

  const mainBranch = await detectMainBranch(normalizedRepo);
  const lastFetchAt = await getLastFetchTime(normalizedRepo);

  // 每个远端只探测一次保护分支集合，供删除入口决定是否展示/放行
  const remotesList = [...new Set(rawRefs.map(ref => ref.refname.split('/')[2]))];
  const protectedByRemote = new Map(
    await Promise.all(remotesList.map(async remote => [remote, await resolveProtectedRemoteBranches(normalizedRepo, remote)]))
  );

  // 每条远端分支的对比统计相互独立，可并发；rev-list 无共同祖先时会失败，按 null 降级
  const branches = await Promise.all(rawRefs.map(async (ref) => {
    const shortName = ref.refname.replace(/^refs\/remotes\//, '');
    const slashIdx = shortName.indexOf('/');
    const remote = shortName.slice(0, slashIdx);
    const branch = shortName.slice(slashIdx + 1);

    let ahead = null;
    let behind = null;
    const vsMain = await tryGit(normalizedRepo, ['rev-list', '--left-right', '--count', `${mainBranch}...${shortName}`]);
    if (vsMain.ok) {
      const [behindCount = '0', aheadCount = '0'] = vsMain.stdout.trim().split(/\s+/);
      ahead = Number(aheadCount) || 0;
      behind = Number(behindCount) || 0;
    }

    let local = null;
    const localSha = localHeads.get(branch);
    if (localSha) {
      const vsLocal = await tryGit(normalizedRepo, ['rev-list', '--left-right', '--count', `${branch}...${shortName}`]);
      if (vsLocal.ok) {
        const [localAhead = '0', localBehind = '0'] = vsLocal.stdout.trim().split(/\s+/);
        local = { ahead: Number(localAhead) || 0, behind: Number(localBehind) || 0, sha: localSha };
      } else {
        local = { ahead: null, behind: null, sha: localSha };
      }
    }

    return {
      name: shortName,
      remote,
      branch,
      sha: ref.objectname,
      committerDate: ref.committerdate,
      author: ref.authorname,
      subject: ref.subject,
      ahead,
      behind,
      local,
      isProtected: protectedByRemote.get(remote)?.has(branch) ?? false
    };
  }));

  return { mainBranch, lastFetchAt, branches };
}

/**
 * 删除远端分支（git push <remote> --delete <branch>）。
 *
 * 仅允许删除非保护分支：远端 HEAD 默认分支（或退化口径下的主干同名分支）直接 409。
 * 删除前经 ls-remote 核对远端真实存在该分支，避免拿过期跟踪引用发出必然失败的 push。
 * @param {object} params
 * @param {string} params.repoPath - 仓库路径
 * @param {string} params.ref - 「远端/分支」形式的远端分支名
 * @returns {Promise<{ok: boolean, remote: string, branch: string}>}
 */
export async function deleteRemoteBranch({ repoPath, ref }) {
  const normalizedRepo = await resolveRepoPath(repoPath);
  if (typeof ref !== 'string' || ref.indexOf('/') < 0) {
    throw httpError('ref 必须是「远端/分支」形式的远端分支名', 400);
  }
  const slashIdx = ref.indexOf('/');
  const remote = ref.slice(0, slashIdx);
  const remoteBranch = ref.slice(slashIdx + 1);
  if (!remoteBranch) {
    throw httpError('ref 必须是「远端/分支」形式的远端分支名', 400);
  }
  await validateRefFormat(remoteBranch, '远端分支名', normalizedRepo);

  const remotesOutput = await runGit(normalizedRepo, ['remote']);
  if (!remotesOutput.split('\n').filter(Boolean).includes(remote)) {
    throw httpError(`未找到名为「${remote}」的远端`, 404);
  }
  const protectedBranches = await resolveProtectedRemoteBranches(normalizedRepo, remote);
  if (protectedBranches.has(remoteBranch)) {
    throw httpError(`远端分支「${remote}/${remoteBranch}」是保护分支（远端默认分支），不允许删除`, 409);
  }

  // 本地跟踪引用可能过期（远端已删/改名），前置 ls-remote 核对真实存在
  const remoteProbe = await tryGit(normalizedRepo, ['ls-remote', '--heads', remote, remoteBranch], {
    timeout: REMOTE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  if (!remoteProbe.ok) {
    const reason = remoteProbe.killed ? '连接超时' : summarizeGitFailure(remoteProbe.stderr);
    throw httpError(`无法核对远端分支状态（${reason}），已取消删除`, 409);
  }
  if (!remoteProbe.stdout.trim()) {
    throw httpError(`远端上不存在分支「${remote}/${remoteBranch}」，请先刷新远端（fetch）后重试`, 404);
  }

  const pushResult = await tryGit(normalizedRepo, ['push', remote, '--delete', remoteBranch], {
    timeout: REMOTE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  if (!pushResult.ok) {
    throw httpError(`删除远端分支失败：${summarizeGitFailure(pushResult.stderr)}`, 409);
  }
  return { ok: true, remote, branch: remoteBranch };
}

/**
 * 列出本地分支及每条的检出/合入状态。
 *
 * 每条返回：分支名、HEAD 提交元信息、upstream 跟踪分支、相对主干的 ahead/behind
 * （ahead = 分支独有提交数，为 0 即已合入主干）、是否主分支，以及检出该分支的
 * 工作区信息（git 不允许两个工作区共享分支，有工作区占用时删除会被拒绝）。
 * @param {string} repoPath - 仓库路径
 * @returns {Promise<{mainBranch: string, branches: Array<object>}>}
 */
export async function listLocalBranches(repoPath) {
  const normalizedRepo = await resolveRepoPath(repoPath);

  // upstream:short 为空时该字段输出空串，split 后保持空串由调用方归一为 null
  const refFormat = '%(refname:short)|%(objectname)|%(committerdate:iso-strict)|%(authorname)|%(contents:subject)|%(upstream:short)';
  const refOutput = await runGit(normalizedRepo, ['for-each-ref', 'refs/heads', `--format=${refFormat}`, '--sort=-committerdate']);
  const rawRefs = refOutput.split('\n').filter(Boolean)
    .map(line => {
      const [name = '', objectname = '', committerdate = '', authorname = '', ...rest] = line.split('|');
      const upstream = rest.pop() || '';
      return { name, sha: objectname, committerdate, authorname, subject: rest.join('|'), upstream };
    });

  const mainBranch = await detectMainBranch(normalizedRepo);

  // 分支 → 检出它的工作区映射（detached HEAD 工作区 branch 为空不入映射）
  const worktrees = await getWorktrees(normalizedRepo);
  const holderByBranch = new Map();
  worktrees.forEach(wt => {
    if (wt.branch && wt.existsOnDisk !== false && wt.isPrunable !== true) {
      holderByBranch.set(wt.branch, wt);
    }
  });

  const branches = await Promise.all(rawRefs.map(async (ref) => {
    let ahead = null;
    let behind = null;
    const vsMain = await tryGit(normalizedRepo, ['rev-list', '--left-right', '--count', `${mainBranch}...${ref.name}`]);
    if (vsMain.ok) {
      const [behindCount = '0', aheadCount = '0'] = vsMain.stdout.trim().split(/\s+/);
      ahead = Number(aheadCount) || 0;
      behind = Number(behindCount) || 0;
    }
    const holder = holderByBranch.get(ref.name) || null;
    return {
      name: ref.name,
      sha: ref.sha,
      committerDate: ref.committerdate,
      author: ref.authorname,
      subject: ref.subject,
      upstream: ref.upstream || null,
      isMain: ref.name === mainBranch,
      ahead,
      behind,
      mergedIntoMain: ahead === 0,
      worktree: holder ? { path: holder.path, isMain: !!holder.isMain } : null
    };
  }));

  return { mainBranch, branches };
}

/**
 * 删除本地分支（git branch -d / -D）。
 *
 * 三重保护：
 *  1. 主分支不可删除；
 *  2. 正被任何工作区检出的分支不可删除（需先切换或移除对应工作区）；
 *  3. 非强制模式下有未合入主干提交的分支拒绝删除（409 引导二次确认）。
 * force=true 时跳过合入检查直接 -D 强删，由前端 confirm 二次确认后传入。
 * @param {object} params
 * @param {string} params.repoPath - 仓库路径
 * @param {string} params.branch - 本地分支名
 * @param {boolean} [params.force] - true 时强制删除未合入分支
 * @returns {Promise<{ok: boolean, branch: string}>}
 */
export async function deleteLocalBranch({ repoPath, branch, force = false }) {
  const normalizedRepo = await resolveRepoPath(repoPath);
  await validateRefFormat(branch, '分支名', normalizedRepo);

  const mainBranch = await detectMainBranch(normalizedRepo);
  if (branch === mainBranch) {
    throw httpError(`「${branch}」是主分支，不允许删除`, 409);
  }
  const exists = await tryGit(normalizedRepo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (!exists.ok) {
    throw httpError(`本地分支「${branch}」不存在`, 404);
  }
  // git 本身会拒绝删除被检出的分支，这里前置给出更明确的操作指引
  const worktrees = await getWorktrees(normalizedRepo);
  const holder = worktrees.find(wt => wt.branch === branch);
  if (holder) {
    throw httpError(`分支「${branch}」正被工作区检出（${holder.path}），请先切换该工作区的分支或移除工作区后再删除`, 409);
  }

  if (!force) {
    // -d 的安全语义前置显式化：未合入主干时引导用户走强删确认，而不是静默失败
    const branchSha = (await tryGit(normalizedRepo, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])).stdout.trim();
    const mainSha = (await tryGit(normalizedRepo, ['rev-parse', '--verify', `refs/heads/${mainBranch}^{commit}`])).stdout.trim();
    if (branchSha && mainSha) {
      const merged = await tryGit(normalizedRepo, ['merge-base', '--is-ancestor', branchSha, mainSha]);
      if (!merged.ok) {
        throw httpError(`分支「${branch}」有未合入主干的提交，普通删除会丢失这些提交；已确认要丢弃请使用强制删除`, 409);
      }
    }
  }

  const deleteResult = await tryGit(normalizedRepo, ['branch', force ? '-D' : '-d', branch]);
  if (!deleteResult.ok) {
    throw httpError(`删除本地分支失败：${summarizeGitFailure(deleteResult.stderr || deleteResult.stdout)}`, 409);
  }
  return { ok: true, branch };
}

/**
 * 基于现有远端分支创建新的远端分支（纯远端操作）。
 *
 * 通过 push 远端跟踪引用完成：`git push <remote> refs/remotes/<src>:refs/heads/<name>`，
 * 全程不创建任何本地分支、不触碰任何工作区。push 成功后 git 会同步更新本地
 * refs/remotes/<remote>/<name>，无需额外 fetch。
 * @param {object} params
 * @param {string} params.repoPath - 仓库路径
 * @param {string} params.sourceRef - 基准远端分支（remote/branch 形式，如 origin/main）
 * @param {string} params.newBranchName - 新远端分支名（remote 上的短名称）
 * @returns {Promise<{ok: boolean, remote: string, branch: string, sha: string}>}
 */
export async function createRemoteBranch({ repoPath, sourceRef, newBranchName }) {
  const normalizedRepo = await resolveRepoPath(repoPath);
  if (typeof sourceRef !== 'string' || sourceRef.indexOf('/') < 0) {
    throw httpError('sourceRef 必须是「远端/分支」形式的远端分支名', 400);
  }
  const slashIdx = sourceRef.indexOf('/');
  const remote = sourceRef.slice(0, slashIdx);
  const sourceBranch = sourceRef.slice(slashIdx + 1);
  if (!sourceBranch) {
    throw httpError('sourceRef 必须是「远端/分支」形式的远端分支名', 400);
  }
  await validateRefFormat(sourceBranch, '基准远端分支名', normalizedRepo);

  // 远端必须已在本地登记过（git remote 清单）
  const remotesOutput = await runGit(normalizedRepo, ['remote']);
  if (!remotesOutput.split('\n').filter(Boolean).includes(remote)) {
    throw httpError(`未找到名为「${remote}」的远端`, 404);
  }
  // 基准远端跟踪引用必须可解析（本地没有它的最新记录时提示先 fetch）
  const sourceSha = (await tryGit(normalizedRepo, ['rev-parse', '--verify', `refs/remotes/${remote}/${sourceBranch}`])).stdout.trim();
  if (!sourceSha) {
    throw httpError(`远端分支「${remote}/${sourceBranch}」在本地不可见，请先刷新远端（fetch）后重试`, 404);
  }
  await validateRefFormat(newBranchName, '新远端分支名', normalizedRepo);

  // 创建前用 ls-remote 核对远端没有同名分支：push 只在非快进时失败，
  // 若目标恰好可快进会静默覆盖已有分支，必须前置拦截
  const remoteProbe = await tryGit(normalizedRepo, ['ls-remote', '--heads', remote, newBranchName], {
    timeout: REMOTE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  if (!remoteProbe.ok) {
    const reason = remoteProbe.killed ? '连接超时' : summarizeGitFailure(remoteProbe.stderr);
    throw httpError(`无法核对远端分支状态（${reason}），已取消创建`, 409);
  }
  if (remoteProbe.stdout.trim()) {
    throw httpError(`远端已存在分支「${remote}/${newBranchName}」，不能重复创建`, 409);
  }

  const pushResult = await tryGit(normalizedRepo,
    ['push', remote, `refs/remotes/${remote}/${sourceBranch}:refs/heads/${newBranchName}`],
    { timeout: REMOTE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (!pushResult.ok) {
    throw httpError(`创建远端分支失败：${summarizeGitFailure(pushResult.stderr)}`, 409);
  }
  return { ok: true, remote, branch: newBranchName, sha: sourceSha };
}

/**
 * 在指定工作区执行分支切换 / 检出远端分支。
 *
 * refType 语义：
 * - local：检出已有本地分支（git checkout <branch>）；
 * - remote：以远端分支为起点创建新的本地跟踪分支并检出（git checkout -b <localName> <remote>/<branch>），
 *   localName 缺省为远端分支的短名称；同名本地分支已存在时拒绝并引导直接切换。
 *
 * 安全前置：工作区必须干净（未提交修改请先提交或 stash）、无 merge/rebase 等中间状态；
 * 目标分支已被其他工作区检出时拒绝（git 不允许两个工作区共享同一分支）。
 * @param {object} params
 * @param {string} params.repoPath - 仓库路径
 * @param {string} params.worktreePath - 目标工作区路径
 * @param {'local'|'remote'} params.refType - 引用类型
 * @param {string} params.ref - local 为本地分支名；remote 为「远端/分支」形式
 * @param {string} [params.localName] - remote 检出时新建的本地分支名
 * @returns {Promise<{ok: boolean, branch: string, head: string, previousBranch: string|null}>}
 */
export async function checkoutBranch({ repoPath, worktreePath, refType, ref, localName }) {
  const normalizedRepo = await resolveRepoPath(repoPath);
  const { worktreePath: wtPath } = await resolveWorktree(normalizedRepo, worktreePath);

  if (refType !== 'local' && refType !== 'remote') {
    throw httpError('refType 只允许 local 或 remote', 400);
  }

  // 工作区干净 + 无中间状态是切换的硬前置：脏工作区切换可能携带未预期改动
  const statusResult = await tryGit(wtPath, ['status', '--porcelain']);
  if (statusResult.stdout.trim()) {
    throw httpError('目标工作区存在未提交修改，请先提交或暂存（stash）后再切换分支', 409);
  }
  const inProgress = await detectInProgressState(wtPath);
  if (inProgress) {
    throw httpError(`目标工作区处于 ${inProgress} 中间状态，请先完成或中止后再切换分支`, 409);
  }

  const currentBranch = (await tryGit(wtPath, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim() || null;

  if (refType === 'local') {
    await validateRefFormat(ref, '目标分支', normalizedRepo);
    if (currentBranch === ref) {
      throw httpError(`当前已在该分支「${ref}」上，无需切换`, 409);
    }
    const exists = await tryGit(normalizedRepo, ['show-ref', '--verify', '--quiet', `refs/heads/${ref}`]);
    if (!exists.ok) {
      throw httpError(`本地分支「${ref}」不存在`, 404);
    }
    // git 会拒绝在同一仓库的两个工作区检出同一分支，这里前置给出更明确的指引。
    // realpath 比对需异步完成，先并发解析全部工作区路径再做同步查找
    const worktrees = await getWorktrees(normalizedRepo);
    const selfReal = await toRealPathSafe(wtPath);
    const holderEntries = await Promise.all(
      worktrees.map(async wt => ({ wt, realPath: await toRealPathSafe(wt.path) }))
    );
    const holder = holderEntries.find(entry => entry.wt.branch === ref && entry.realPath !== selfReal)?.wt;
    if (holder) {
      throw httpError(`分支「${ref}」已被其他工作区检出（${holder.path}），git 不允许两个工作区共享同一分支`, 409);
    }
    const checkoutResult = await tryGit(wtPath, ['checkout', ref]);
    if (!checkoutResult.ok) {
      throw httpError(`切换分支失败：${summarizeGitFailure(checkoutResult.stderr || checkoutResult.stdout)}`, 409);
    }
    const head = await runGit(wtPath, ['rev-parse', 'HEAD']);
    return { ok: true, branch: ref, head, previousBranch: currentBranch };
  }

  // remote 检出：远端/分支 形式校验 + 跟踪引用可解析
  if (typeof ref !== 'string' || ref.indexOf('/') < 0) {
    throw httpError('ref 必须是「远端/分支」形式的远端分支名', 400);
  }
  const slashIdx = ref.indexOf('/');
  const remote = ref.slice(0, slashIdx);
  const remoteBranch = ref.slice(slashIdx + 1);
  if (!remoteBranch) {
    throw httpError('ref 必须是「远端/分支」形式的远端分支名', 400);
  }
  const remotesOutput = await runGit(normalizedRepo, ['remote']);
  if (!remotesOutput.split('\n').filter(Boolean).includes(remote)) {
    throw httpError(`未找到名为「${remote}」的远端`, 404);
  }
  const remoteSha = (await tryGit(normalizedRepo, ['rev-parse', '--verify', `refs/remotes/${remote}/${remoteBranch}`])).stdout.trim();
  if (!remoteSha) {
    throw httpError(`远端分支「${remote}/${remoteBranch}」在本地不可见，请先刷新远端（fetch）后重试`, 404);
  }

  const targetLocalName = localName === undefined || localName === null || localName === ''
    ? remoteBranch
    : localName;
  await validateRefFormat(targetLocalName, '本地分支名', normalizedRepo);
  // 同名本地分支已存在时拒绝：-b 会直接报错，这里给出可操作的替代建议
  const localExists = await tryGit(normalizedRepo, ['show-ref', '--verify', '--quiet', `refs/heads/${targetLocalName}`]);
  if (localExists.ok) {
    throw httpError(`本地分支「${targetLocalName}」已存在，无法以该名称检出；可直接切换到它，或改用其他名称`, 409);
  }

  // 起点为远端跟踪分支时 git 默认建立 upstream（branch.autoSetupMerge），后续 pull/push 免参数
  const checkoutResult = await tryGit(wtPath, ['checkout', '-b', targetLocalName, `${remote}/${remoteBranch}`]);
  if (!checkoutResult.ok) {
    throw httpError(`检出远端分支失败：${summarizeGitFailure(checkoutResult.stderr || checkoutResult.stdout)}`, 409);
  }
  const head = await runGit(wtPath, ['rev-parse', 'HEAD']);
  return { ok: true, branch: targetLocalName, head, previousBranch: currentBranch };
}

/**
 * 把一个引用（远端分支或本地分支）合并进目标工作区当前分支。
 *
 * 成功路径：干净合并直接生成 merge commit（或快进），返回 status: 'merged'；
 * 冲突路径：保持 merge 现场（MERGE_HEAD + 冲突标记 + 未合并索引）交由
 * getMergeState / getConflictFile / resolveConflictFile 完成 UI 化处理，
 * 返回 status: 'conflict' 与冲突文件清单。
 * @param {object} params
 * @param {string} params.repoPath - 仓库路径
 * @param {string} params.worktreePath - 目标工作区路径
 * @param {string} params.ref - 合并来源：「远端/分支」形式或本地分支名
 * @returns {Promise<object>} { ok, status: 'merged'|'conflict', head?, fastForward?, conflictFiles?, oursLabel?, theirsLabel? }
 */
export async function mergeRef({ repoPath, worktreePath, ref }) {
  const normalizedRepo = await resolveRepoPath(repoPath);
  const { worktreePath: wtPath } = await resolveWorktree(normalizedRepo, worktreePath);
  if (typeof ref !== 'string' || ref.trim() === '' || ref.startsWith('-')) {
    throw httpError('ref 参数不合法', 400);
  }

  // 工作区干净 + 无中间状态（与 MR 合并前置语义一致）
  const statusResult = await tryGit(wtPath, ['status', '--porcelain']);
  if (statusResult.stdout.trim()) {
    throw httpError('目标工作区存在未提交修改，请先提交或暂存（stash）后再合并', 409);
  }
  const inProgress = await detectInProgressState(wtPath);
  if (inProgress) {
    throw httpError(`目标工作区处于 ${inProgress} 中间状态，请先完成或中止后再合并`, 409);
  }

  // ref 可为本地分支或远端跟踪分支，先解析为完整引用并验证存在
  const remotesList = (await runGit(normalizedRepo, ['remote'])).split('\n').filter(Boolean);
  let fullRef = null;
  if (ref.indexOf('/') > 0) {
    const remote = ref.slice(0, ref.indexOf('/'));
    if (remotesList.includes(remote)) {
      fullRef = `refs/remotes/${ref}`;
    }
  }
  if (!fullRef) {
    fullRef = `refs/heads/${ref}`;
  }
  const refSha = (await tryGit(normalizedRepo, ['rev-parse', '--verify', `${fullRef}^{commit}`])).stdout.trim();
  if (!refSha) {
    const hint = ref.indexOf('/') > 0 ? '，请先刷新远端（fetch）后重试' : '';
    throw httpError(`合并来源「${ref}」不存在${hint}`, 404);
  }

  // 当前分支已包含来源全量提交时无需合并（含来源是 HEAD 祖先的退化场景）
  const headSha = await runGit(wtPath, ['rev-parse', 'HEAD']);
  const alreadyContains = await tryGit(wtPath, ['merge-base', '--is-ancestor', refSha, headSha]);
  if (alreadyContains.ok) {
    throw httpError(`当前分支已包含「${ref}」的全部提交，无需合并`, 409);
  }
  const fastForward = (await tryGit(wtPath, ['merge-base', '--is-ancestor', headSha, refSha])).ok;

  const mergeResult = await tryGit(wtPath, ['merge', '--no-edit', ref]);
  if (mergeResult.ok) {
    const newHead = await runGit(wtPath, ['rev-parse', 'HEAD']);
    return { ok: true, status: 'merged', head: newHead, fastForward };
  }

  // 失败后区分两种形态：MERGE_HEAD 出现 = 内容冲突保持现场；否则为合并前置拒绝
  // （untracked 覆盖等），后者现场未受影响，直接 409 报因
  const mergeHead = await tryGit(wtPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (!mergeHead.ok || !mergeHead.stdout.trim()) {
    throw httpError(`合并失败（现场未受影响）：${summarizeGitFailure(mergeResult.stderr || mergeResult.stdout)}`, 409);
  }

  const unmergedOutput = await runGit(wtPath, ['diff', '--name-only', '--diff-filter=U', '-z']);
  const statusMap = parseStatusPorcelainZ((await tryGit(wtPath, ['status', '--porcelain', '-z'])).stdout);
  const conflictFiles = parseUnmergedPaths(unmergedOutput).map(filePath => ({
    path: filePath,
    code: statusMap.get(filePath) || 'UU',
    label: UNMERGED_CODE_LABELS[statusMap.get(filePath)] || '冲突'
  }));
  const oursLabel = (await tryGit(wtPath, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim() || '当前分支';
  // theirsLabel 直接使用本次合并的请求引用：同一提交可能同时被本地分支与远端分支
  // 指向（如检出重命名后），name-rev 解析出的名称不唯一且未必是用户合并的对象
  return { ok: true, status: 'conflict', conflictFiles, oursLabel, theirsLabel: ref };
}

/**
 * 读取目标工作区的合并进行状态，供 UI 在进入 Tab / 刷新时恢复冲突处理面板。
 * @param {string} worktreePath - 工作区路径
 * @returns {Promise<object>} {
 *   worktreePath, inProgress: 'merge'|'cherry-pick'|'revert'|'rebase'|null,
 *   inMerge: boolean, oursLabel, theirsLabel, conflictFiles: [{path, code, label}]
 * }
 */
export async function getMergeState(worktreePath) {
  if (typeof worktreePath !== 'string' || worktreePath.trim() === '' || !path.isAbsolute(worktreePath)) {
    throw httpError('worktree 路径必须为非空的绝对路径', 400);
  }
  try {
    const stat = await fs.stat(worktreePath);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    throw httpError('指定的工作区路径不存在', 404);
  }
  // 只要求是某个仓库的工作区，不要求属于特定 repoPath（UI 按当前仓库的工作区列表传入）
  if (!(await isGitRepo(worktreePath))) {
    throw httpError('指定路径不是 Git 仓库工作区', 400);
  }

  const inProgress = await detectInProgressState(worktreePath);
  const result = {
    worktreePath: await toRealPathSafe(worktreePath),
    inProgress,
    inMerge: inProgress === 'merge',
    oursLabel: null,
    theirsLabel: null,
    conflictFiles: []
  };
  if (!result.inMerge) {
    return result;
  }

  result.oursLabel = (await tryGit(worktreePath, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim() || '当前分支';
  result.theirsLabel = await resolveMergeTheirsLabel(worktreePath);
  const unmergedOutput = await runGit(worktreePath, ['diff', '--name-only', '--diff-filter=U', '-z']);
  const statusMap = parseStatusPorcelainZ((await tryGit(worktreePath, ['status', '--porcelain', '-z'])).stdout);
  result.conflictFiles = parseUnmergedPaths(unmergedOutput).map(filePath => ({
    path: filePath,
    code: statusMap.get(filePath) || 'UU',
    label: UNMERGED_CODE_LABELS[statusMap.get(filePath)] || '冲突'
  }));
  return result;
}

/**
 * 读取单个冲突文件的三方内容，供冲突编辑器渲染。
 *
 * raw 取工作区磁盘上的当前内容（含冲突标记）；ours/theirs/base 分别对应
 * 索引 stage 2/3/1，某一侧缺失（如双方新增无 base、修改删除缺一方）时为 null。
 * 含 NUL 字节判为二进制，只返回 ours/theirs 快捷处理，不给文本编辑。
 * @param {object} params
 * @param {string} params.worktreePath - 工作区路径
 * @param {string} params.filePath - 未合并文件的工作区相对路径
 * @returns {Promise<object>} { path, isBinary, raw, ours, theirs, base }
 */
export async function getConflictFile({ worktreePath, filePath }) {
  if (typeof worktreePath !== 'string' || worktreePath.trim() === '' || !path.isAbsolute(worktreePath)) {
    throw httpError('worktree 路径必须为非空的绝对路径', 400);
  }
  try {
    const stat = await fs.stat(worktreePath);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    throw httpError('指定的工作区路径不存在', 404);
  }
  const wtReal = await toRealPathSafe(worktreePath);
  const absolutePath = await resolveConflictFilePath(wtReal, filePath);

  // 只允许读取当前真正处于未合并状态的文件，避免该接口变成任意版本内容读取器
  const unmergedOutput = await runGit(wtReal, ['diff', '--name-only', '--diff-filter=U', '-z']);
  if (!parseUnmergedPaths(unmergedOutput).includes(filePath)) {
    throw httpError('该文件不在当前冲突清单中', 404);
  }

  const readStage = async (stage) => {
    const result = await tryGit(wtReal, ['show', `:${stage}:${filePath}`], { maxBuffer: 20 * 1024 * 1024 });
    return result.ok ? result.stdout : null;
  };
  const ours = await readStage(2);
  const theirs = await readStage(3);
  const base = await readStage(1);

  // 工作区文件可能尚未落盘（如 both deleted）；读不到按空串处理
  let raw = '';
  try {
    raw = await fs.readFile(absolutePath, 'utf-8');
  } catch {
    raw = '';
  }
  const isBinary = raw.includes('\0') || [ours, theirs, base].some(v => typeof v === 'string' && v.includes('\0'));

  return {
    path: filePath,
    isBinary,
    raw: isBinary ? null : raw,
    ours: isBinary ? null : ours,
    theirs: isBinary ? null : theirs,
    base: isBinary ? null : base
  };
}

/**
 * 处理单个冲突文件并标记已解决（git add）。
 *
 * resolution 语义：
 * - 'ours'：采用当前分支版本（索引 stage 2 → git checkout --ours -- path + add）；
 * - 'theirs'：采用合并来源版本（stage 3 → git checkout --theirs -- path + add）；
 * - 'content'：写入用户编辑后的完整文件内容（须不带冲突标记由用户自行保证）+ add。
 * @param {object} params
 * @param {string} params.worktreePath - 工作区路径
 * @param {string} params.filePath - 未合并文件的工作区相对路径
 * @param {'ours'|'theirs'|'content'} params.resolution - 解决方式
 * @param {string} [params.content] - resolution 为 content 时的完整文件内容
 * @returns {Promise<object>} { ok, path, resolution, remaining }
 */
export async function resolveConflictFile({ worktreePath, filePath, resolution, content }) {
  if (typeof worktreePath !== 'string' || worktreePath.trim() === '' || !path.isAbsolute(worktreePath)) {
    throw httpError('worktree 路径必须为非空的绝对路径', 400);
  }
  try {
    const stat = await fs.stat(worktreePath);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    throw httpError('指定的工作区路径不存在', 404);
  }
  const wtReal = await toRealPathSafe(worktreePath);
  const absolutePath = await resolveConflictFilePath(wtReal, filePath);

  if (!['ours', 'theirs', 'content'].includes(resolution)) {
    throw httpError('resolution 只允许 ours / theirs / content', 400);
  }

  // 每次处理都实时核对未合并清单：文件可能已被用户在别处解决，避免误覆盖
  const unmergedOutput = await runGit(wtReal, ['diff', '--name-only', '--diff-filter=U', '-z']);
  if (!parseUnmergedPaths(unmergedOutput).includes(filePath)) {
    throw httpError('该文件不在当前冲突清单中（可能已被处理）', 404);
  }

  if (resolution === 'ours' || resolution === 'theirs') {
    const side = resolution === 'ours' ? '--ours' : '--theirs';
    const checkoutResult = await tryGit(wtReal, ['checkout', side, '--', filePath]);
    if (!checkoutResult.ok) {
      throw httpError(
        `无法采用${resolution === 'ours' ? '当前分支' : '合并来源'}版本：${summarizeGitFailure(checkoutResult.stderr)}（该冲突类型可能缺少对应一侧的版本，请改用「自定义编辑」处理）`,
        409
      );
    }
    const addResult = await tryGit(wtReal, ['add', '--', filePath]);
    if (!addResult.ok) {
      throw httpError(`标记已解决失败：${summarizeGitFailure(addResult.stderr)}`, 409);
    }
  } else {
    if (typeof content !== 'string') {
      throw httpError('content 必须为字符串（编辑后的完整文件内容）', 400);
    }
    try {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, 'utf-8');
    } catch (err) {
      throw httpError(`写入冲突文件失败：${err.message}`, 409);
    }
    const addResult = await tryGit(wtReal, ['add', '--', filePath]);
    if (!addResult.ok) {
      throw httpError(`标记已解决失败：${summarizeGitFailure(addResult.stderr)}`, 409);
    }
  }

  const remainingOutput = await runGit(wtReal, ['diff', '--name-only', '--diff-filter=U', '-z']);
  return { ok: true, path: filePath, resolution, remaining: parseUnmergedPaths(remainingOutput).length };
}

/**
 * 完成合并：确认冲突已全部处理后生成 merge commit。
 * 使用 --no-edit 复用 git 预置的 MERGE_MSG（含来源分支信息）。
 * @param {string} worktreePath - 工作区路径
 * @returns {Promise<{ok: boolean, head: string}>}
 */
export async function commitMerge(worktreePath) {
  if (typeof worktreePath !== 'string' || worktreePath.trim() === '' || !path.isAbsolute(worktreePath)) {
    throw httpError('worktree 路径必须为非空的绝对路径', 400);
  }
  const mergeHead = await tryGit(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (!mergeHead.ok || !mergeHead.stdout.trim()) {
    throw httpError('当前没有进行中的合并', 409);
  }
  const unmergedOutput = await runGit(worktreePath, ['diff', '--name-only', '--diff-filter=U', '-z']);
  const remaining = parseUnmergedPaths(unmergedOutput);
  if (remaining.length > 0) {
    throw httpError(`仍有 ${remaining.length} 个冲突文件未处理，不能完成合并`, 409);
  }
  const commitResult = await tryGit(worktreePath, ['commit', '--no-edit']);
  if (!commitResult.ok) {
    throw httpError(`提交合并失败：${summarizeGitFailure(commitResult.stderr || commitResult.stdout)}`, 409);
  }
  const head = await runGit(worktreePath, ['rev-parse', 'HEAD']);
  return { ok: true, head };
}

/**
 * 放弃合并并恢复合并前现场（git merge --abort）。
 * abort 失败时提示用户手动处理，不静默吞掉残留状态。
 * @param {string} worktreePath - 工作区路径
 * @returns {Promise<{ok: boolean}>}
 */
export async function abortMerge(worktreePath) {
  if (typeof worktreePath !== 'string' || worktreePath.trim() === '' || !path.isAbsolute(worktreePath)) {
    throw httpError('worktree 路径必须为非空的绝对路径', 400);
  }
  const mergeHead = await tryGit(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (!mergeHead.ok || !mergeHead.stdout.trim()) {
    throw httpError('当前没有进行中的合并', 409);
  }
  const abortResult = await tryGit(worktreePath, ['merge', '--abort']);
  if (!abortResult.ok) {
    throw httpError(
      `放弃合并失败，工作区可能仍处于 merge 中间状态，请手动执行 git merge --abort（原因：${summarizeGitFailure(abortResult.stderr)}）`,
      409
    );
  }
  return { ok: true };
}

/**
 * 刷新全部远端（git fetch --prune --all）。
 *
 * 与主工作区 Pull 同一容错口径：git 层失败（网络/凭据/超时）不抛错，
 * 返回 ok:false 且保留原始输出供 UI 展示；只有仓库未配置远端时抛 409。
 * 非交互环境显式禁用终端凭据提示，避免网络命令挂起等待输入。
 * @param {string} repoPath - 仓库路径
 * @returns {Promise<{ok: boolean, output: string}>}
 */
export async function fetchRemotes(repoPath) {
  const normalizedRepo = await resolveRepoPath(repoPath);
  const remotesOutput = await runGit(normalizedRepo, ['remote']);
  if (!remotesOutput.trim()) {
    throw httpError('该仓库没有配置任何远端', 409);
  }
  const fetchResult = await tryGit(normalizedRepo, ['fetch', '--prune', '--all'], {
    timeout: REMOTE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  const output = `${fetchResult.stdout}${fetchResult.stderr}`.trim();
  if (!fetchResult.ok) {
    const reason = fetchResult.killed ? '\n刷新超时' : '';
    return { ok: false, output: `${output}${reason}` };
  }
  return { ok: true, output };
}
