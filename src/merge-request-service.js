import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isGitRepo, getWorktrees } from './git-inspector.js';
import { normalizeRepoPath, loadMergeRequests, saveMergeRequests } from './merge-request-store.js';

const exec = promisify(execFile);

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
 * 与 git-inspector.js 的 runGit 同一套模式：execFile 参数数组，绝不拼接 shell 字符串。
 * @param {string} cwd - git 命令工作目录
 * @param {string[]} args - git 参数数组
 * @returns {Promise<string>}
 */
async function runGit(cwd, args) {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * 执行 git 命令但把失败视为普通结果（不抛错），适合探测类命令：
 * 例如 rev-parse 验证不存在的引用、检查 merge 中间状态，退出码非 0 属正常分支。
 * @param {string} cwd - git 命令工作目录
 * @param {string[]} args - git 参数数组
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, message: string}>}
 */
async function tryGit(cwd, args) {
  try {
    const { stdout, stderr } = await exec('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 });
    return { ok: true, stdout: stdout || '', stderr: stderr || '', message: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      message: err.message || ''
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

/** MR 的合法生命周期状态：open 为活动态，其余三个为终态（终态不可再变更） */
const MR_STATUSES = new Set(['open', 'merged', 'rejected', 'canceled']);
/** mergeRequestAction 的 action 白名单 */
const MR_ACTIONS = new Set(['approve', 'request_changes', 'reject', 'cancel', 'merge']);
/** 标题最大长度（trim 后） */
const TITLE_MAX_LENGTH = 200;
/** UUID 格式校验（大小写均可） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 校验并归一化仓库路径：必须是存在且含 .git 的目录。
 * 路径不存在返回 404，存在但不是 Git 仓库返回 400；返回值写入 MR 记录。
 * @param {string} repoPath - 仓库路径
 * @returns {Promise<string>} realpath 归一化后的仓库绝对路径
 */
async function resolveRepoPath(repoPath) {
  if (typeof repoPath !== 'string' || repoPath.trim() === '') {
    throw httpError('repoPath 参数必须为非空字符串', 400);
  }
  const normalized = await normalizeRepoPath(repoPath);
  if (await isGitRepo(normalized)) {
    return normalized;
  }
  // 区分两种失败：路径根本不存在（404）与存在但不是 Git 仓库（400）
  try {
    await fs.stat(normalized);
  } catch {
    throw httpError('指定的仓库路径不存在', 404);
  }
  throw httpError('指定的路径不是 Git 仓库', 400);
}

/**
 * 校验分支名的字符串合法性与 git ref 格式（不校验是否存在）。
 * 先做字符串前置校验防止参数被 git 当成选项，再用 check-ref-format 做权威校验。
 * @param {string} branch - 分支名
 * @param {string} label - 错误信息中的角色标注（"源分支"/"目标分支"）
 * @param {string} cwd - git 命令工作目录
 */
async function validateBranchFormat(branch, label, cwd) {
  if (typeof branch !== 'string' || branch.trim() === '') {
    throw httpError(`${label}必须为非空字符串`, 400);
  }
  // 以 '-' 开头或含空白/控制字符的名字会被 git 误解析为选项或直接非法，前置拒绝
  if (branch.startsWith('-') || /[\s\0]/.test(branch) || branch.length > 250) {
    throw httpError(`${label}「${branch}」不是合法的分支名`, 400);
  }
  const result = await tryGit(cwd, ['check-ref-format', '--branch', branch]);
  if (!result.ok) {
    throw httpError(`${label}「${branch}」不是合法的分支名`, 400);
  }
}

/**
 * 校验本地分支确实存在（refs/heads 下可解析）。
 * @param {string} repoPath - 仓库路径
 * @param {string} branch - 分支名
 * @param {string} label - 错误信息中的角色标注（"源分支"/"目标分支"）
 */
async function ensureBranchExists(repoPath, branch, label) {
  // --quiet：分支不存在时退出码非 0 且不输出，属正常探测路径
  const result = await tryGit(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (!result.ok || !result.stdout.trim()) {
    throw httpError(`${label}「${branch}」不存在`, 404);
  }
}

/**
 * 校验 title/description 参数并返回规整后的值。
 * title 必须 trim 后非空且 ≤200 字符；description 允许空串，未传时按空串处理。
 * @param {unknown} title
 * @param {unknown} description
 * @returns {{title: string, description: string}}
 */
function validateTitleAndDescription(title, description) {
  if (typeof title !== 'string' || title.trim() === '') {
    throw httpError('title 必须为非空字符串', 400);
  }
  const trimmedTitle = title.trim();
  if (trimmedTitle.length > TITLE_MAX_LENGTH) {
    throw httpError(`title 长度不能超过 ${TITLE_MAX_LENGTH} 个字符`, 400);
  }
  // description 允许空串；调用方未传（undefined/null/非字符串）时按空串宽容处理
  const desc = typeof description === 'string' ? description : '';
  return { title: trimmedTitle, description: desc };
}

/**
 * 规整可选的 reason 参数：只接受字符串（或缺省），避免任意类型入库。
 * @param {unknown} reason
 * @returns {string} 规整后的字符串（缺省为 ''）
 */
function normalizeReason(reason) {
  if (reason === undefined || reason === null) return '';
  if (typeof reason !== 'string') {
    throw httpError('reason 参数必须为字符串', 400);
  }
  return reason.trim();
}

/**
 * 校验 id 为 UUID 格式。
 * @param {string} id
 */
function validateId(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw httpError('id 参数必须是合法的 UUID', 400);
  }
}

/**
 * 从存储中查找单条 MR，不存在时抛 404。
 * @param {Array<object>} mergeRequests - 已加载的 MR 列表
 * @param {string} id - MR 的 UUID
 * @returns {object}
 */
function findMergeRequest(mergeRequests, id) {
  const mr = mergeRequests.find(item => item && item.id === id);
  if (!mr) {
    throw httpError('指定的 MR 不存在', 404);
  }
  return mr;
}

/**
 * 探测目标 worktree 是否处于 merge / rebase / cherry-pick / revert 中间状态。
 *
 * merge/cherry-pick/revert 各自会留下 MERGE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD
 * 引用（rev-parse 探测，不存在时退出码非 0 属正常）；rebase 的 sequencer 是目录，
 * 通过 rev-parse --git-path 定位后用文件系统存在性判断。
 * @param {string} wtPath - 目标 worktree 路径
 * @returns {Promise<string|null>} 中间状态名称（如 'merge'），无残留时返回 null
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
    // --git-path 可能返回相对路径，相对 worktree 解析成绝对路径再判断存在性
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
 * 执行 merge 动作的全部前置检查与实际合并，成功返回合并后目标 worktree 的新 HEAD。
 * 任一前置不满足即抛 409/404，MR 保持 open 不动；合并冲突时自动 abort 清场。
 *
 * 注意：source worktree 里的未提交内容不参与合并——合并只作用于已提交的分支历史，
 * 这一点需要审阅界面提示用户自行确认 source 分支的提交是完整的。
 * @param {object} mr - MR 记录
 * @param {string} reason - 合并说明（可空）
 * @returns {Promise<string>} 合并后目标 worktree 的 HEAD 完整 SHA
 */
async function performMerge(mr, reason) {
  // 前置 1：审阅必须通过，未 approve（或被打回 changes_requested）一律拒绝
  if (mr.reviewStatus !== 'approved') {
    throw httpError(`审阅通过后才能合并（当前审阅状态：${mr.reviewStatus}）`, 409);
  }

  // 前置 2/3：source 与 target 分支仍存在（创建 MR 后可能被删除）
  await ensureBranchExists(mr.repoPath, mr.sourceBranch, '源分支');
  await ensureBranchExists(mr.repoPath, mr.targetBranch, '目标分支');

  // 前置 4：目标分支必须有实际检出它的本地 worktree——本地合并语义要求
  // 真实修改目标 worktree，没有 worktree 的分支无从下手
  const worktrees = await getWorktrees(mr.repoPath);
  const targetWt = worktrees.find(w => w.branch === mr.targetBranch);
  if (!targetWt) {
    throw httpError(`目标分支 ${mr.targetBranch} 没有对应的本地 Worktree，无法执行合并`, 409);
  }
  if (targetWt.existsOnDisk === false) {
    throw httpError(`目标分支 ${mr.targetBranch} 对应的 Worktree ${targetWt.path} 已不在磁盘上，请先清理失效 Worktree 后重试`, 409);
  }

  // 前置 5：目标 worktree 工作区必须干净，否则 merge 可能与未提交内容纠缠
  const statusResult = await tryGit(targetWt.path, ['status', '--porcelain']);
  if (statusResult.stdout.trim()) {
    throw httpError(`目标 Worktree ${targetWt.path} 存在未提交改动，请先提交或 stash 后再合并`, 409);
  }

  // 前置 6：无 merge/rebase/cherry-pick/revert 中间状态残留
  const inProgress = await detectInProgressState(targetWt.path);
  if (inProgress) {
    throw httpError(`目标 Worktree ${targetWt.path} 处于 ${inProgress} 中间状态，请先完成或中止后再合并`, 409);
  }

  // 前置 7：确认目标 worktree 当前检出的就是 target 分支（防 detached 或分支被切换）
  const symrefResult = await tryGit(targetWt.path, ['symbolic-ref', '--short', 'HEAD']);
  if (!symrefResult.ok) {
    throw httpError(`目标 Worktree ${targetWt.path} 无法确认当前分支（可能处于 detached HEAD 状态），请先检出 ${mr.targetBranch}`, 409);
  }
  const checkedOut = symrefResult.stdout.trim();
  if (checkedOut !== mr.targetBranch) {
    throw httpError(`目标 Worktree ${targetWt.path} 当前检出的是 ${checkedOut}，不是目标分支 ${mr.targetBranch}，请先切换分支`, 409);
  }

  // 执行合并：--no-ff 保证生成显式 merge commit（审阅痕迹可追溯），--no-edit 用默认合并信息
  try {
    await runGit(targetWt.path, ['merge', '--no-ff', '--no-edit', mr.sourceBranch]);
  } catch (mergeErr) {
    const mergeSummary = summarizeGitFailure(mergeErr.message);
    // 失败必须立即 abort 清场，绝不留下半完成的 merge 状态
    try {
      await runGit(targetWt.path, ['merge', '--abort']);
    } catch (abortErr) {
      // abort 失败不一定代表现场脏（合并可能尚未真正开始），核实后再决定是否提醒手动处理
      const residue = await detectInProgressState(targetWt.path);
      const dirtyProbe = await tryGit(targetWt.path, ['status', '--porcelain']);
      if (residue || dirtyProbe.stdout.trim()) {
        throw httpError(
          `合并失败：自动中止合并失败，Worktree 仍处于 merge 中间状态，请手动执行 git merge --abort` +
          `（abort 原始错误：${summarizeGitFailure(abortErr.message)}；合并错误：${mergeSummary}）`,
          409
        );
      }
      // 无残留时现场本就未受影响，按普通合并失败处理
      throw httpError(`合并失败（现场未受影响）：${mergeSummary}`, 409);
    }
    throw httpError(`合并失败（已自动中止合并并恢复现场）：${mergeSummary}`, 409);
  }

  // 合并成功，读取目标 worktree 新 HEAD 作为合并产物
  const newHead = await runGit(targetWt.path, ['rev-parse', 'HEAD']);
  return newHead;
}

/**
 * 列出指定仓库的 MR，可按 status 过滤，按 createdAt 倒序（最新在前）。
 * @param {object} params
 * @param {string} params.configDir - 配置根目录（由调用方传入，模块本身不读环境变量）
 * @param {string} params.repoPath - 仓库路径
 * @param {string} [params.status] - 可选过滤值：open/merged/rejected/canceled，非法值返回 400
 * @returns {Promise<{mergeRequests: Array<object>>}>}
 */
export async function listMergeRequests({ configDir, repoPath, status }) {
  if (configDir === undefined || configDir === null || configDir === '') {
    throw httpError('configDir 参数必须为非空字符串', 400);
  }
  const normalizedRepo = await resolveRepoPath(repoPath);
  // 未传 status 视为不过滤；传了就必须在白名单内，防止静默返回空列表误导前端
  const filterStatus = status === undefined || status === null || status === '' ? null : status;
  if (filterStatus !== null && !MR_STATUSES.has(filterStatus)) {
    throw httpError(`status 参数不合法，允许值：${[...MR_STATUSES].join('/')}`, 400);
  }
  const all = await loadMergeRequests(configDir, normalizedRepo);
  const filtered = filterStatus ? all.filter(mr => mr && mr.status === filterStatus) : all;
  // createdAt 为 ISO-8601 字符串，字典序即时间序；同毫秒时按 id 保证排序稳定
  const mergeRequests = filtered.slice().sort((a, b) => {
    const byTime = String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    return byTime !== 0 ? byTime : String(b.id || '').localeCompare(String(a.id || ''));
  });
  return { mergeRequests };
}

/**
 * 创建 MR：校验参数与分支存在性，读取两侧分支头 SHA 后落盘。
 *
 * 注意：MR 创建后合并的是 source 分支"当时的提交"，source worktree 的未提交
 * 内容不参与合并，审阅界面需向用户提示这一点。
 * @param {object} params
 * @param {string} params.configDir - 配置根目录
 * @param {string} params.repoPath - 仓库路径
 * @param {string} params.sourceBranch - 源分支名
 * @param {string} params.targetBranch - 目标分支名
 * @param {string} params.title - 标题（trim 后非空，≤200 字符）
 * @param {string} [params.description] - 描述（允许空串）
 * @returns {Promise<{mergeRequest: object}>}
 */
export async function createMergeRequest({ configDir, repoPath, sourceBranch, targetBranch, title, description }) {
  if (configDir === undefined || configDir === null || configDir === '') {
    throw httpError('configDir 参数必须为非空字符串', 400);
  }
  const normalizedRepo = await resolveRepoPath(repoPath);
  const { title: cleanTitle, description: cleanDescription } = validateTitleAndDescription(title, description);
  await validateBranchFormat(sourceBranch, '源分支', normalizedRepo);
  await validateBranchFormat(targetBranch, '目标分支', normalizedRepo);
  if (sourceBranch === targetBranch) {
    throw httpError('源分支与目标分支不能相同', 400);
  }
  await ensureBranchExists(normalizedRepo, sourceBranch, '源分支');
  await ensureBranchExists(normalizedRepo, targetBranch, '目标分支');

  const mergeRequests = await loadMergeRequests(configDir, normalizedRepo);
  // 同一 source+target 只允许一条 open MR，避免重复审阅入口
  const duplicated = mergeRequests.find(mr =>
    mr && mr.status === 'open' && mr.sourceBranch === sourceBranch && mr.targetBranch === targetBranch
  );
  if (duplicated) {
    throw httpError('已存在相同源分支与目标分支的开启 MR', 409);
  }

  // 记录创建时刻两侧分支的头 SHA，作为审阅时判断"MR 是否已过期"的基准
  const sourceHeadAtCreate = await runGit(normalizedRepo, ['rev-parse', `refs/heads/${sourceBranch}`]);
  const targetHeadAtCreate = await runGit(normalizedRepo, ['rev-parse', `refs/heads/${targetBranch}`]);
  const now = new Date().toISOString();
  const mergeRequest = {
    id: crypto.randomUUID(),
    repoPath: normalizedRepo,
    sourceBranch,
    targetBranch,
    title: cleanTitle,
    description: cleanDescription,
    status: 'open',
    reviewStatus: 'pending',
    createdAt: now,
    updatedAt: now,
    sourceHeadAtCreate,
    targetHeadAtCreate,
    mergedAt: null,
    mergedCommit: null,
    decisionReason: null
  };
  mergeRequests.push(mergeRequest);
  await saveMergeRequests(configDir, normalizedRepo, mergeRequests);
  return { mergeRequest };
}

/**
 * 获取单条 MR。
 * @param {object} params
 * @param {string} params.configDir - 配置根目录
 * @param {string} params.repoPath - 仓库路径
 * @param {string} params.id - MR 的 UUID
 * @returns {Promise<{mergeRequest: object}>}
 */
export async function getMergeRequest({ configDir, repoPath, id }) {
  if (configDir === undefined || configDir === null || configDir === '') {
    throw httpError('configDir 参数必须为非空字符串', 400);
  }
  const normalizedRepo = await resolveRepoPath(repoPath);
  validateId(id);
  const mergeRequests = await loadMergeRequests(configDir, normalizedRepo);
  return { mergeRequest: findMergeRequest(mergeRequests, id) };
}

/**
 * 对 MR 执行操作并持久化结果。
 *
 * 状态机：
 * - status：open → rejected（reject）/ canceled（cancel）/ merged（merge），终态不可再变更；
 * - reviewStatus：pending → approved（approve）/ changes_requested（request_changes），
 *   仅 open 期间可变；merge 要求 reviewStatus 必须为 approved。
 *
 * reason 的用法（均可空）：
 * - approve/request_changes：作为审阅备注存入 decisionReason；
 * - reject/cancel：作为决定原因写入 decisionReason（空串表示未填）；
 * - merge：作为合并说明写入 decisionReason。
 *
 * merge 动作会真实修改目标 worktree（git merge --no-ff）；source worktree 的
 * 未提交内容不参与合并，审阅界面需自行提示用户。merge 成功时返回对象额外带
 * { merge: { mergedCommit, targetHead } }，两者均为合并后目标 worktree 的新 HEAD。
 *
 * @param {object} params
 * @param {string} params.configDir - 配置根目录
 * @param {string} params.repoPath - 仓库路径
 * @param {string} params.id - MR 的 UUID
 * @param {string} params.action - 操作：approve | request_changes | reject | cancel | merge
 * @param {string} [params.reason] - 备注/原因/合并说明（可空）
 * @returns {Promise<{mergeRequest: object, merge?: {mergedCommit: string, targetHead: string}}>}
 */
export async function mergeRequestAction({ configDir, repoPath, id, action, reason }) {
  if (configDir === undefined || configDir === null || configDir === '') {
    throw httpError('configDir 参数必须为非空字符串', 400);
  }
  if (!MR_ACTIONS.has(action)) {
    throw httpError(`action 参数不合法，允许值：${[...MR_ACTIONS].join('/')}`, 400);
  }
  const normalizedRepo = await resolveRepoPath(repoPath);
  validateId(id);
  const cleanReason = normalizeReason(reason);

  const mergeRequests = await loadMergeRequests(configDir, normalizedRepo);
  const mr = findMergeRequest(mergeRequests, id);

  // 终态不可变更：merged/rejected/canceled 上执行任何 action 都是非法状态转换
  if (mr.status !== 'open') {
    throw httpError(`MR 已处于终态「${mr.status}」，不允许再执行任何操作`, 409);
  }

  const now = new Date().toISOString();
  switch (action) {
    case 'approve':
      mr.reviewStatus = 'approved';
      // 审阅备注：有 reason 才覆盖，避免无备注的 approve 抹掉历史备注
      if (cleanReason) mr.decisionReason = cleanReason;
      break;
    case 'request_changes':
      mr.reviewStatus = 'changes_requested';
      if (cleanReason) mr.decisionReason = cleanReason;
      break;
    case 'reject':
      mr.status = 'rejected';
      // 拒绝原因允许为空串，统一写入保证字段始终有明确语义
      mr.decisionReason = cleanReason;
      break;
    case 'cancel':
      mr.status = 'canceled';
      mr.decisionReason = cleanReason;
      break;
    case 'merge': {
      // 前置检查与真实合并都在 performMerge 内，任一失败时 mr 保持 open 不落盘
      const newHead = await performMerge(mr, cleanReason);
      mr.status = 'merged';
      mr.mergedAt = now;
      mr.mergedCommit = newHead;
      mr.decisionReason = cleanReason || null;
      break;
    }
    default:
      // 白名单已在前置校验兜底，理论上不可达
      throw httpError('action 参数不合法', 400);
  }
  mr.updatedAt = now;

  await saveMergeRequests(configDir, normalizedRepo, mergeRequests);
  const result = { mergeRequest: mr };
  if (action === 'merge') {
    // mergedCommit 与 targetHead 同为合并后目标 worktree 的 HEAD：前者写入记录，后者便于路由直接展示
    result.merge = { mergedCommit: mr.mergedCommit, targetHead: mr.mergedCommit };
  }
  return result;
}
