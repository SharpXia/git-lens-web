#!/usr/bin/env node
/**
 * verify-mr-branch-diff.mjs —— 本地 MR + Branch Diff 的 HTTP 集成验证脚本（fail-closed 版）
 *
 * 用法:
 *   node scripts/verify-mr-branch-diff.mjs --base-url http://127.0.0.1:9530 \
 *        --config-dir /tmp/glwt-verify-config --run-id <run-id> [--stage <full|mr|diff|compat>]
 *
 * 前置条件:
 *   1. 被测服务必须以测试模式启动且实现 /api/test-handshake 握手接口（契约 §3），例如:
 *        PORT=9530 GIT_LENS_CONFIG_DIR=/tmp/glwt-verify-config \
 *        GIT_LENS_TEST_MODE=1 GIT_LENS_TEST_RUN_ID=<run-id> node src/server.js
 *      --run-id 必须与服务进程的 GIT_LENS_TEST_RUN_ID 完全一致。
 *   2. STAGE=mr/diff 依赖服务端已实现 /api/merge-requests* 与 /api/diff-refs 契约；
 *      在未合入新接口的基线（如 main）上运行时这两个阶段会失败并在 404 处给出
 *      「该接口尚未在当前基线实现」提示，属预期现象。STAGE=compat 在基线上即可全绿。
 *
 * fail-closed 守卫（契约 §8.2/§8.3，校验逻辑见 scripts/qa/guard.mjs）:
 *   - 任何业务请求之前必须先 GET /api/test-handshake 并核对 runId 与 configDir（realpath）
 *     完全一致；404 视为「Runtime 契约未就绪」，脚本直接失败并给出指引。
 *   - --base-url 仅接受 http://127.0.0.1:<端口> 字面形态（端口不得为 9527）；拒绝 localhost
 *     等域名形式、其他主机名、路径、查询、hash、凭据与尾斜杠。
 *   - --config-dir 必须显式提供且真实存在，其 realpath 不得位于 $HOME/.config/git-lens-web 下。
 *   - 未通过以上任一守卫时，在任何 HTTP 请求与 fixture 写入之前即失败退出。
 *
 * 隔离与清理策略:
 *   - fixture 仓库构建在系统临时目录的 mkdtemp 私有目录下，脚本退出时整体删除；
 *   - fixture 仓库路径以「追加」方式写入扫描目录配置：先 GET 现有配置，过滤掉已失效
 *     的路径后合并 POST（POST /api/scan-directories 是全量替换语义，直接追加会因
 *     残留的失效路径被 400 拒绝）；脚本结束时不清理该配置——config-dir 本就是脚本
 *     参数指定的私有目录；
 *   - MR 数据只允许落在 --config-dir 的 merge-requests/<sha256(repoPath)>.json，
 *     脚本会 stat 真实用户配置目录验证未被写入（只读不写）。
 *
 * 断言输出: 每条断言输出 ✓/✗ + 描述，结尾打印「共 N 项断言，失败 M 项」，M>0 退出码 1。
 */

import { spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  GUARD_ERROR_CODES,
  assertPathNotUnderRealConfig,
  parseAndValidateBaseUrl,
  performHandshake
} from './qa/guard.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SCRIPT = path.join(SCRIPT_DIR, 'mr-diff-fixture.sh');
const FETCH_TIMEOUT_MS = 10000;
const STAGES = ['full', 'mr', 'diff', 'compat'];

// ---------- 参数解析 ----------

/** 打印用法说明（导出仅为单测可见性，不承载逻辑） */
export function printUsage() {
  console.log(`用法: node scripts/verify-mr-branch-diff.mjs --base-url <url> --config-dir <dir> --run-id <run-id> [--stage <full|mr|diff|compat>]

  --base-url    被测服务地址（必填），仅接受 http://127.0.0.1:<端口> 字面形态，端口不得为 9527
  --config-dir  服务的 GIT_LENS_CONFIG_DIR（必填），必须已存在且不在 \$HOME/.config/git-lens-web 下
  --run-id      本轮测试运行 ID（必填），必须与服务进程的 GIT_LENS_TEST_RUN_ID 完全一致
  --stage       full=全部 | mr=MR 全链路 | diff=Branch Diff | compat=既有接口回归（默认 full）

示例:
  PORT=9530 GIT_LENS_CONFIG_DIR=/tmp/glwt-verify-config \\
    GIT_LENS_TEST_MODE=1 GIT_LENS_TEST_RUN_ID=qa-demo node src/server.js &
  node scripts/verify-mr-branch-diff.mjs --base-url http://127.0.0.1:9530 \\
       --config-dir /tmp/glwt-verify-config --run-id qa-demo --stage full`);
}

/** 解析命令行参数（导出供单测复用；不做 fail-closed 校验，校验见 validateInvocation） */
export function parseArgs(argv) {
  const args = { stage: 'full' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    switch (key) {
      case '--base-url':
        args.baseUrl = argv[++i];
        break;
      case '--config-dir':
        args.configDir = argv[++i];
        break;
      case '--run-id':
        args.runId = argv[++i];
        break;
      case '--stage':
        args.stage = argv[++i];
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`未知参数: ${key}`);
    }
  }
  return args;
}

// ---------- 调用参数 fail-closed 校验（导出供单测复用） ----------

/**
 * 校验一次调用的参数组合（不发起网络请求）。
 * @param {{ baseUrl?: string, configDir?: string, runId?: string, stage?: string }} args parseArgs 的结果
 * @param {{ home?: string }} [options] home 注入点，仅供单测使用；缺省取 os.homedir()
 * @returns {Promise<{ baseUrl: string, configDir: string, runId: string, stage: string }>}
 *   baseUrl 为规范化后的地址；configDir 为 realpath 后的配置目录
 */
export async function validateInvocation(args, { home = os.homedir() } = {}) {
  if (!args || !args.baseUrl) {
    throw new Error('缺少 --base-url 参数');
  }
  if (!args.runId) {
    throw new Error('缺少 --run-id 参数（必须与被测服务的 GIT_LENS_TEST_RUN_ID 完全一致）');
  }
  if (!args.configDir) {
    throw new Error('缺少 --config-dir 参数（fail-closed：必须显式提供，且与服务 GIT_LENS_CONFIG_DIR 指向同一目录）');
  }

  // 地址白名单：只认 127.0.0.1 字面量 + 非 9527 端口，其余形态在解析阶段即拒绝
  const { baseUrl } = parseAndValidateBaseUrl(args.baseUrl);

  if (!path.isAbsolute(args.configDir)) {
    throw new Error(`--config-dir 必须是绝对路径，实际: ${args.configDir}`);
  }
  const stat = await fs.promises.stat(args.configDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`--config-dir 不存在或不是目录（fail-closed 拒绝）: ${args.configDir}`);
  }
  // 真实配置保护：realpath 落在 $HOME/.config/git-lens-web 下（含经符号链接抵达）一律拒绝
  const realConfigDir = await assertPathNotUnderRealConfig(args.configDir, { home });

  return { baseUrl, configDir: realConfigDir, runId: args.runId, stage: args.stage || 'full' };
}

// ---------- 断言与 HTTP 工具 ----------

const stats = { total: 0, failed: 0 };

/** 输出一条断言结果；cond 为假时计入失败并附带补充信息 */
function check(desc, cond, extra = '') {
  stats.total += 1;
  if (cond) {
    console.log(`✓ ${desc}`);
  } else {
    stats.failed += 1;
    console.log(`✗ ${desc}${extra ? ` —— ${extra}` : ''}`);
  }
  return cond;
}

/**
 * 新接口在旧基线上 404 时的统一提示，避免误判为契约实现错误
 */
function notImplementedHint(pathname, status) {
  const isNewEndpoint = pathname.startsWith('/api/merge-requests') || pathname.startsWith('/api/diff-refs');
  if (isNewEndpoint && status === 404) {
    return '（该接口尚未在当前基线实现——若服务未合入本地 MR/Branch Diff 代码，此失败属预期）';
  }
  return '';
}

/** 带描述的 HTTP 状态断言，404 时自动追加新接口提示 */
function checkStatus(desc, res, expectedStatus, pathname) {
  const ok = res.status === expectedStatus;
  const extra = ok
    ? ''
    : `实际 HTTP ${res.status}${notImplementedHint(pathname, res.status)}${res.body?.error ? `：${res.body.error}` : ''}`;
  return check(desc, ok, extra);
}

/** 所有 fetch 统一 10s 超时；响应体非 JSON 时 body 为 null */
async function requestJson(baseUrl, pathname, { method = 'GET', body } = {}) {
  const res = await fetch(baseUrl + pathname, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // 非 JSON 响应（如 404 纯文本）按 null 处理，由状态断言兜底
  }
  return { status: res.status, body: json };
}

/** 本地 git 只读命令封装，用于与服务端返回交叉验证 */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// ---------- fixture 构建与扫描目录注册 ----------

let fixtureRootForCleanup = null;

function buildFixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'glwt-mr-fixture-'));
  fixtureRootForCleanup = parent;
  const res = spawnSync('bash', [FIXTURE_SCRIPT, parent], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`fixture 构建失败（退出码 ${res.status}）:\n${res.stderr}`);
  }
  const lines = res.stdout.trim().split('\n').filter(Boolean);
  const summary = JSON.parse(lines[lines.length - 1]);
  return summary;
}

function cleanupFixture() {
  if (fixtureRootForCleanup) {
    try {
      fs.rmSync(fixtureRootForCleanup, { recursive: true, force: true });
    } catch {
      // 退出清理失败不影响结果
    }
  }
}

/**
 * 以追加语义把 fixture 仓库加入扫描目录：先 GET 再合并 POST。
 * 过滤已失效路径的原因见文件头注释（POST 是全量替换语义）。
 */
async function registerScanDirectory(baseUrl, repoPath) {
  const current = await requestJson(baseUrl, '/api/scan-directories');
  const existing = Array.isArray(current.body?.customDirectories) ? current.body.customDirectories : [];
  const merged = [...new Set([...existing.filter((d) => fs.existsSync(d)), repoPath])];
  const res = await requestJson(baseUrl, '/api/scan-directories', { method: 'POST', body: { directories: merged } });
  checkStatus('把 fixture 仓库追加进扫描目录（合并写入，不覆盖有效既有配置）', res, 200, '/api/scan-directories');
  check(
    '扫描目录配置确认包含 fixture 仓库',
    Array.isArray(res.body?.customDirectories) && res.body.customDirectories.includes(repoPath),
    `实际: ${JSON.stringify(res.body?.customDirectories)}`
  );
}

// ---------- STAGE mr：MR 全链路 ----------

function mrCreateUrl() {
  return '/api/merge-requests';
}

function mrListUrl(repoPath, status) {
  const params = new URLSearchParams({ repoPath });
  if (status) params.set('status', status);
  return `/api/merge-requests?${params}`;
}

function mrDetailUrl(repoPath, id) {
  return `/api/merge-requests/${encodeURIComponent(id)}?repoPath=${encodeURIComponent(repoPath)}`;
}

function mrActionBody(repoPath, id, action, extra = {}) {
  return { repoPath, id, action, ...extra };
}

async function runStageMr(ctx) {
  const { baseUrl, configDir, fixture } = ctx;
  const repo = fixture.repo;
  const branches = fixture.branches;
  console.log('\n===== STAGE mr：MR 全链路 =====');

  // 创建：正常路径
  const sourceHead = git(repo, ['rev-parse', branches.mergeNoFF]);
  const targetHeadAtCreate = git(repo, ['rev-parse', 'main']);
  const createRes = await requestJson(baseUrl, mrCreateUrl(), {
    method: 'POST',
    body: {
      repoPath: repo,
      sourceBranch: branches.mergeNoFF,
      targetBranch: 'main',
      title: 'QA: --no-ff 合并成功路径',
      description: '验证脚本自动创建的 MR'
    }
  });
  checkStatus('创建 MR（feature/merged-no-ff → main）返回 200', createRes, 200, mrCreateUrl());
  const mr1 = createRes.body?.mergeRequest || {};
  check('创建响应包含非空 id', Boolean(mr1.id), `实际: ${JSON.stringify(mr1.id)}`);
  check('新 MR status=open', mr1.status === 'open', `实际: ${mr1.status}`);
  check('新 MR reviewStatus=pending', mr1.reviewStatus === 'pending', `实际: ${mr1.reviewStatus}`);
  check('sourceHeadAtCreate 与分支 HEAD 一致', mr1.sourceHeadAtCreate === sourceHead, `实际: ${mr1.sourceHeadAtCreate}`);
  check('targetHeadAtCreate 与 main HEAD 一致', mr1.targetHeadAtCreate === targetHeadAtCreate, `实际: ${mr1.targetHeadAtCreate}`);
  check('createdAt/updatedAt 存在', Boolean(mr1.createdAt) && Boolean(mr1.updatedAt));

  // 创建：异常路径
  const missingFieldRes = await requestJson(baseUrl, mrCreateUrl(), {
    method: 'POST',
    body: { repoPath: repo, sourceBranch: branches.normal, targetBranch: 'main' }
  });
  checkStatus('创建缺参（无 title）返回 400', missingFieldRes, 400, mrCreateUrl());

  const unknownBranchRes = await requestJson(baseUrl, mrCreateUrl(), {
    method: 'POST',
    body: { repoPath: repo, sourceBranch: 'feature/no-such-branch', targetBranch: 'main', title: 'QA: 分支不存在' }
  });
  checkStatus('创建时分支不存在返回 404', unknownBranchRes, 404, mrCreateUrl());

  const sameBranchRes = await requestJson(baseUrl, mrCreateUrl(), {
    method: 'POST',
    body: { repoPath: repo, sourceBranch: 'main', targetBranch: 'main', title: 'QA: source==target' }
  });
  checkStatus('创建 source==target 返回 400', sameBranchRes, 400, mrCreateUrl());

  const duplicateRes = await requestJson(baseUrl, mrCreateUrl(), {
    method: 'POST',
    body: {
      repoPath: repo,
      sourceBranch: branches.mergeNoFF,
      targetBranch: 'main',
      title: 'QA: 与 mr1 重复的 open MR'
    }
  });
  checkStatus('相同 source/target 已有 open MR 时重复创建返回 409', duplicateRes, 409, mrCreateUrl());

  // 列表与 status 过滤
  const openList = await requestJson(baseUrl, mrListUrl(repo, 'open'));
  checkStatus('MR 列表（status=open）返回 200', openList, 200, mrListUrl(repo, 'open'));
  check('列表结构包含 mergeRequests 数组', Array.isArray(openList.body?.mergeRequests));
  check(
    'open 列表包含刚创建的 MR',
    Array.isArray(openList.body?.mergeRequests) && openList.body.mergeRequests.some((m) => String(m.id) === String(mr1.id))
  );
  const mergedListEarly = await requestJson(baseUrl, mrListUrl(repo, 'merged'));
  check(
    'merged 过滤此时不含 mr1（尚未合并）',
    Array.isArray(mergedListEarly.body?.mergeRequests) &&
      !mergedListEarly.body.mergeRequests.some((m) => String(m.id) === String(mr1.id))
  );

  // 详情
  const detailRes = await requestJson(baseUrl, mrDetailUrl(repo, mr1.id));
  checkStatus('MR 详情返回 200', detailRes, 200, mrDetailUrl(repo, mr1.id));
  const detail = detailRes.body?.mergeRequest || {};
  check(
    '详情字段与创建入参一致',
    detail.repoPath === repo && detail.sourceBranch === branches.mergeNoFF &&
      detail.targetBranch === 'main' && detail.title === 'QA: --no-ff 合并成功路径'
  );
  // 不存在的 MR：用格式合法但从未使用过的 UUID（格式非法的 id 会被服务的参数校验层以 400 拒绝，
  // 那是另一条校验路径；这里验证的是"合法 id 但查无此 MR"的 404 语义）
  const bogusUuid = '00000000-0000-4000-8000-000000000000';
  const bogusDetail = await requestJson(baseUrl, mrDetailUrl(repo, bogusUuid));
  checkStatus('不存在的 MR 详情返回 404', bogusDetail, 404, mrDetailUrl(repo, bogusUuid));

  // 审阅：approve
  const approveRes = await requestJson(baseUrl, '/api/merge-requests/action', {
    method: 'POST',
    body: mrActionBody(repo, mr1.id, 'approve')
  });
  checkStatus('approve mr1 返回 200', approveRes, 200, '/api/merge-requests/action');
  check('approve 后 reviewStatus=approved', approveRes.body?.mergeRequest?.reviewStatus === 'approved', `实际: ${approveRes.body?.mergeRequest?.reviewStatus}`);

  // mr2：未 approve 直接 merge 应 409；随后 request_changes 与 cancel/终态
  const mr2Res = await requestJson(baseUrl, mrCreateUrl(), {
    method: 'POST',
    body: { repoPath: repo, sourceBranch: branches.deep, targetBranch: 'main', title: 'QA: 未 approve 直接合并应 409' }
  });
  checkStatus('创建 mr2（feature/deep/name → main）返回 200', mr2Res, 200, mrCreateUrl());
  const mr2 = mr2Res.body?.mergeRequest || {};

  const mergeWithoutApprove = await requestJson(baseUrl, '/api/merge-requests/action', {
    method: 'POST',
    body: mrActionBody(repo, mr2.id, 'merge')
  });
  checkStatus('未 approve 的 mr2 直接 merge 返回 409', mergeWithoutApprove, 409, '/api/merge-requests/action');
  const mr2AfterFail = await requestJson(baseUrl, mrDetailUrl(repo, mr2.id));
  check('merge 失败后 mr2 仍为 open', mr2AfterFail.body?.mergeRequest?.status === 'open', `实际: ${mr2AfterFail.body?.mergeRequest?.status}`);

  const requestChangesRes = await requestJson(baseUrl, '/api/merge-requests/action', {
    method: 'POST',
    body: mrActionBody(repo, mr2.id, 'request_changes', { reason: 'QA: 请补充说明' })
  });
  checkStatus('mr2 request_changes 返回 200', requestChangesRes, 200, '/api/merge-requests/action');
  check('request_changes 后 reviewStatus=changes_requested', requestChangesRes.body?.mergeRequest?.reviewStatus === 'changes_requested');

  const cancelRes = await requestJson(baseUrl, '/api/merge-requests/action', {
    method: 'POST',
    body: mrActionBody(repo, mr2.id, 'cancel')
  });
  checkStatus('mr2 cancel 返回 200', cancelRes, 200, '/api/merge-requests/action');
  check('cancel 后 status=canceled（终态）', cancelRes.body?.mergeRequest?.status === 'canceled', `实际: ${cancelRes.body?.mergeRequest?.status}`);
  const cancelAgain = await requestJson(baseUrl, '/api/merge-requests/action', {
    method: 'POST',
    body: mrActionBody(repo, mr2.id, 'approve')
  });
  checkStatus('mr2 终态后再操作（approve）返回 409', cancelAgain, 409, '/api/merge-requests/action');
  const canceledList = await requestJson(baseUrl, mrListUrl(repo, 'canceled'));
  check(
    'canceled 过滤包含 mr2',
    Array.isArray(canceledList.body?.mergeRequests) && canceledList.body.mergeRequests.some((m) => String(m.id) === String(mr2.id))
  );

  // mr2b：cancel 释放重复占用后可重新创建，走 reject 终态
  const mr2bRes = await requestJson(baseUrl, mrCreateUrl(), {
    method: 'POST',
    body: { repoPath: repo, sourceBranch: branches.deep, targetBranch: 'main', title: 'QA: reject 终态验证' }
  });
  checkStatus('canceled 后相同 source/target 可重新创建 mr2b', mr2bRes, 200, mrCreateUrl());
  const mr2b = mr2bRes.body?.mergeRequest || {};
  const rejectRes = await requestJson(baseUrl, '/api/merge-requests/action', {
    method: 'POST',
    body: mrActionBody(repo, mr2b.id, 'reject', { reason: 'QA: 不予合并' })
  });
  checkStatus('mr2b reject 返回 200', rejectRes, 200, '/api/merge-requests/action');
  check('reject 后 status=rejected 且 decisionReason 非空', rejectRes.body?.mergeRequest?.status === 'rejected' && Boolean(rejectRes.body?.mergeRequest?.decisionReason));
  const rejectThenMerge = await requestJson(baseUrl, '/api/merge-requests/action', {
    method: 'POST',
    body: mrActionBody(repo, mr2b.id, 'merge')
  });
  checkStatus('mr2b 终态后再操作（merge）返回 409', rejectThenMerge, 409, '/api/merge-requests/action');
  const rejectedList = await requestJson(baseUrl, mrListUrl(repo, 'rejected'));
  check(
    'rejected 过滤包含 mr2b',
    Array.isArray(rejectedList.body?.mergeRequests) && rejectedList.body.mergeRequests.some((m) => String(m.id) === String(mr2b.id))
  );

  // mr3：冲突分支合并失败 → 服务端自动 abort，MR 保持 open
  const mr3Res = await requestJson(baseUrl, mrCreateUrl(), {
    method: 'POST',
    body: { repoPath: repo, sourceBranch: branches.conflict, targetBranch: 'main', title: 'QA: 冲突合并应 409 并自动 abort' }
  });
  checkStatus('创建 mr3（feature/conflict → main）返回 200', mr3Res, 200, mrCreateUrl());
  const mr3 = mr3Res.body?.mergeRequest || {};
  await requestJson(baseUrl, '/api/merge-requests/action', { method: 'POST', body: mrActionBody(repo, mr3.id, 'approve') });
  const conflictMerge = await requestJson(baseUrl, '/api/merge-requests/action', {
    method: 'POST',
    body: mrActionBody(repo, mr3.id, 'merge')
  });
  checkStatus('冲突分支 mr3 merge 返回 409', conflictMerge, 409, '/api/merge-requests/action');
  const mr3After = await requestJson(baseUrl, mrDetailUrl(repo, mr3.id));
  check('冲突后 mr3 仍为 open', mr3After.body?.mergeRequest?.status === 'open', `实际: ${mr3After.body?.mergeRequest?.status}`);
  check('冲突自动 abort：target worktree git status --porcelain 为空', git(repo, ['status', '--porcelain']) === '');
  let mergeHeadAbent = true;
  try {
    git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    mergeHeadAbent = false;
  } catch {
    mergeHeadAbent = true;
  }
  check('冲突自动 abort：target worktree 无 MERGE_HEAD 残留', mergeHeadAbent);

  // mr4：dirty target 拒绝合并
  const mr4Res = await requestJson(baseUrl, mrCreateUrl(), {
    method: 'POST',
    body: { repoPath: repo, sourceBranch: branches.normal, targetBranch: branches.dirty, title: 'QA: dirty target 应 409' }
  });
  checkStatus('创建 mr4（feature/normal → feature/dirty）返回 200', mr4Res, 200, mrCreateUrl());
  const mr4 = mr4Res.body?.mergeRequest || {};
  await requestJson(baseUrl, '/api/merge-requests/action', { method: 'POST', body: mrActionBody(repo, mr4.id, 'approve') });
  const dirtyMerge = await requestJson(baseUrl, '/api/merge-requests/action', {
    method: 'POST',
    body: mrActionBody(repo, mr4.id, 'merge')
  });
  checkStatus('dirty target 的 mr4 merge 返回 409', dirtyMerge, 409, '/api/merge-requests/action');
  const mr4After = await requestJson(baseUrl, mrDetailUrl(repo, mr4.id));
  check('dirty target 拒绝后 mr4 仍为 open', mr4After.body?.mergeRequest?.status === 'open', `实际: ${mr4After.body?.mergeRequest?.status}`);

  // mr1 成功合并：--no-ff、mergedCommit 与 target worktree HEAD 一致、第二父为 source head
  const mergeRes = await requestJson(baseUrl, '/api/merge-requests/action', {
    method: 'POST',
    body: mrActionBody(repo, mr1.id, 'merge')
  });
  checkStatus('已 approve 的 mr1 merge 返回 200', mergeRes, 200, '/api/merge-requests/action');
  const merged = mergeRes.body?.mergeRequest || {};
  check('merge 后 mr1.status=merged', merged.status === 'merged', `实际: ${merged.status}`);
  check('mergedAt 非空', Boolean(merged.mergedAt));
  const newHead = git(repo, ['rev-parse', 'HEAD']);
  check('mergedCommit 与 target worktree rev-parse HEAD 一致', merged.mergedCommit === newHead, `服务端: ${merged.mergedCommit}，本地: ${newHead}`);
  const parents = git(repo, ['log', '-1', '--format=%P']).split(/\s+/);
  const noffHead = git(repo, ['rev-parse', branches.mergeNoFF]);
  check('main 顶端是 merge commit（两个父提交）', parents.length === 2, `实际父数: ${parents.length}`);
  check('merge commit 第二父为 source head（--no-ff 生效）', parents[1] === noffHead && noffHead === mr1.sourceHeadAtCreate, `第二父: ${parents[1]}`);
  check('合并成功后 target worktree 保持干净', git(repo, ['status', '--porcelain']) === '');
  const mergedList = await requestJson(baseUrl, mrListUrl(repo, 'merged'));
  check(
    'merged 过滤包含 mr1',
    Array.isArray(mergedList.body?.mergeRequests) && mergedList.body.mergeRequests.some((m) => String(m.id) === String(mr1.id))
  );
  const openListAfter = await requestJson(baseUrl, mrListUrl(repo, 'open'));
  check(
    'open 过滤不再包含 mr1',
    Array.isArray(openListAfter.body?.mergeRequests) && !openListAfter.body.mergeRequests.some((m) => String(m.id) === String(mr1.id))
  );

  // 配置隔离：MR 只写入 --config-dir 的 merge-requests/<sha256(repoPath)>.json
  const sha256 = crypto.createHash('sha256').update(repo).digest('hex');
  const storeFile = path.join(configDir, 'merge-requests', `${sha256}.json`);
  check('MR 数据写入 --config-dir 的 merge-requests/<sha256>.json', fs.existsSync(storeFile), `缺失: ${storeFile}`);
  if (fs.existsSync(storeFile)) {
    let storeText = '';
    let storeJson = null;
    try {
      storeText = fs.readFileSync(storeFile, 'utf8');
      storeJson = JSON.parse(storeText);
    } catch {
      // 解析失败由下方断言呈现
    }
    check('MR 存储文件可解析为 JSON 且包含 mr1 数据', Boolean(storeJson) && storeText.includes(String(mr1.id)) && storeText.includes(branches.mergeNoFF));
  }
  const homeStoreFile = path.join(os.homedir(), '.config', 'git-lens-web', 'merge-requests', `${sha256}.json`);
  check('真实用户配置目录未被写入本 fixture 的 MR 数据（只 stat，不写）', !fs.existsSync(homeStoreFile), `意外存在: ${homeStoreFile}`);
}

// ---------- STAGE diff：Branch Diff ----------

function diffRefsUrl(fixture, { sourceType, source, targetType, target, mode }) {
  const params = new URLSearchParams({ path: fixture.repo, sourceType, source, targetType, target });
  if (mode) params.set('mode', mode);
  return `/api/diff-refs?${params}`;
}

function hasFile(diff, filePath) {
  return Array.isArray(diff?.files) && diff.files.some((f) => f.filePath === filePath);
}

async function runStageDiff(ctx) {
  const { baseUrl, fixture } = ctx;
  const wt = fixture.worktrees;
  console.log('\n===== STAGE diff：Branch Diff =====');

  // worktree↔worktree：committed
  const wwCommitted = await requestJson(baseUrl, diffRefsUrl(fixture, {
    sourceType: 'worktree', source: wt.main, targetType: 'worktree', target: wt['feature/normal'], mode: 'committed'
  }));
  checkStatus('diff-refs worktree↔worktree committed 返回 200', wwCommitted, 200, '/api/diff-refs');
  const wwDiff = wwCommitted.body?.diff || {};
  check('diff.source.kind=worktree 且 diff.target.kind=worktree', wwDiff.source?.kind === 'worktree' && wwDiff.target?.kind === 'worktree', `实际: ${wwDiff.source?.kind}/${wwDiff.target?.kind}`);
  check('feature/normal 相对 main ahead=2', wwDiff.ahead === 2, `实际: ${wwDiff.ahead}`);
  check('committed 模式文件数 > 0', Array.isArray(wwDiff.files) && wwDiff.files.length > 0, `实际: ${wwDiff.files?.length}`);

  // worktree↔worktree：吸收判定（feature/absorbed 已被 cherry-pick 进 main）
  const wwAbsorbed = await requestJson(baseUrl, diffRefsUrl(fixture, {
    sourceType: 'worktree', source: wt.main, targetType: 'worktree', target: wt['feature/absorbed'], mode: 'committed'
  }));
  checkStatus('diff-refs 吸收分支（feature/absorbed）返回 200', wwAbsorbed, 200, '/api/diff-refs');
  const absorbedDiff = wwAbsorbed.body?.diff || {};
  check('被吸收分支 ahead=0', absorbedDiff.ahead === 0, `实际: ${absorbedDiff.ahead}`);
  check('被吸收分支 committed 文件为空', Array.isArray(absorbedDiff.files) && absorbedDiff.files.length === 0, `实际: ${absorbedDiff.files?.length}`);

  // worktree↔worktree：uncommitted / untracked（feature/dirty）
  const wwUncommitted = await requestJson(baseUrl, diffRefsUrl(fixture, {
    sourceType: 'worktree', source: wt.main, targetType: 'worktree', target: wt['feature/dirty'], mode: 'uncommitted'
  }));
  checkStatus('diff-refs worktree↔worktree uncommitted 返回 200', wwUncommitted, 200, '/api/diff-refs');
  const uncommittedDiff = wwUncommitted.body?.diff || {};
  check('uncommitted 模式包含 notes.txt 的未提交修改', hasFile(uncommittedDiff, 'notes.txt'));
  check('uncommitted 模式包含 untracked 文件 dirty-untracked.txt', hasFile(uncommittedDiff, 'dirty-untracked.txt'));

  const wwAll = await requestJson(baseUrl, diffRefsUrl(fixture, {
    sourceType: 'worktree', source: wt.main, targetType: 'worktree', target: wt['feature/dirty'], mode: 'all'
  }));
  checkStatus('diff-refs worktree↔worktree all 返回 200', wwAll, 200, '/api/diff-refs');
  const allDiff = wwAll.body?.diff || {};
  check('all 模式同样包含 untracked 文件', hasFile(allDiff, 'dirty-untracked.txt'));
  check('all 模式包含已提交文件 dirty-committed.txt', hasFile(allDiff, 'dirty-committed.txt'));

  // 图片/二进制标记（feature/dirty 的已提交改动含 logo.png 追加与 blob.bin 追加）
  const wwBinary = await requestJson(baseUrl, diffRefsUrl(fixture, {
    sourceType: 'worktree', source: wt.main, targetType: 'worktree', target: wt['feature/dirty'], mode: 'committed'
  }));
  checkStatus('diff-refs 图片/二进制素材 diff 返回 200', wwBinary, 200, '/api/diff-refs');
  const binaryDiff = wwBinary.body?.diff || {};
  const logoFile = (binaryDiff.files || []).find((f) => f.filePath === 'assets/logo.png');
  const binFile = (binaryDiff.files || []).find((f) => f.filePath === 'assets/blob.bin');
  check('logo.png 标记 isImage=true', Boolean(logoFile) && logoFile.isImage === true);
  check('logo.png 标记 isBinary=true', Boolean(logoFile) && logoFile.isBinary === true);
  check('blob.bin 标记 isBinary=true 且 isImage=false', Boolean(binFile) && binFile.isBinary === true && binFile.isImage === false);

  // branch↔branch：committed
  const bbNormal = await requestJson(baseUrl, diffRefsUrl(fixture, {
    sourceType: 'branch', source: 'main', targetType: 'branch', target: 'feature/normal', mode: 'committed'
  }));
  checkStatus('diff-refs branch↔branch（main vs feature/normal）返回 200', bbNormal, 200, '/api/diff-refs');
  const bbDiff = bbNormal.body?.diff || {};
  check('branch 模式 diff.source.kind=branch 且 diff.target.kind=branch', bbDiff.source?.kind === 'branch' && bbDiff.target?.kind === 'branch', `实际: ${bbDiff.source?.kind}/${bbDiff.target?.kind}`);
  check('branch↔branch ahead=2', bbDiff.ahead === 2, `实际: ${bbDiff.ahead}`);
  check('branch↔branch 文件数 > 0', Array.isArray(bbDiff.files) && bbDiff.files.length > 0);

  const bbDirty = await requestJson(baseUrl, diffRefsUrl(fixture, {
    sourceType: 'branch', source: 'main', targetType: 'branch', target: 'feature/dirty', mode: 'committed'
  }));
  checkStatus('diff-refs branch↔branch（main vs feature/dirty）返回 200', bbDirty, 200, '/api/diff-refs');
  const bbDirtyDiff = bbDirty.body?.diff || {};
  check('branch↔branch 包含已提交的 dirty-committed.txt', hasFile(bbDirtyDiff, 'dirty-committed.txt'));
  check('branch↔branch 不含 worktree 未提交内容（notes.txt 修改不出现）', !hasFile(bbDirtyDiff, 'notes.txt'));
  check('branch↔branch 不含 untracked 文件 dirty-untracked.txt', !hasFile(bbDirtyDiff, 'dirty-untracked.txt'));

  // 同名 branch↔branch：空结果
  const bbSame = await requestJson(baseUrl, diffRefsUrl(fixture, {
    sourceType: 'branch', source: 'main', targetType: 'branch', target: 'main', mode: 'committed'
  }));
  checkStatus('同名 branch↔branch 返回 200', bbSame, 200, '/api/diff-refs');
  check('同名 branch↔branch 文件为空', Array.isArray(bbSame.body?.diff?.files) && bbSame.body.diff.files.length === 0, `实际: ${bbSame.body?.diff?.files?.length}`);

  // branch↔worktree 与 worktree↔branch：方向与 ahead/behind 正确性
  const bw = await requestJson(baseUrl, diffRefsUrl(fixture, {
    sourceType: 'branch', source: 'main', targetType: 'worktree', target: wt['feature/normal'], mode: 'committed'
  }));
  checkStatus('diff-refs branch↔worktree 返回 200', bw, 200, '/api/diff-refs');
  const bwDiff = bw.body?.diff || {};
  check('branch↔worktree kind 标注正确（branch → worktree）', bwDiff.source?.kind === 'branch' && bwDiff.target?.kind === 'worktree', `实际: ${bwDiff.source?.kind}/${bwDiff.target?.kind}`);
  check('branch↔worktree（main → feature/normal）ahead=2', bwDiff.ahead === 2, `实际: ${bwDiff.ahead}`);

  const wb = await requestJson(baseUrl, diffRefsUrl(fixture, {
    sourceType: 'worktree', source: wt['feature/normal'], targetType: 'branch', target: 'main', mode: 'committed'
  }));
  checkStatus('diff-refs worktree↔branch 返回 200', wb, 200, '/api/diff-refs');
  const wbDiff = wb.body?.diff || {};
  check('worktree↔branch kind 标注正确（worktree → branch）', wbDiff.source?.kind === 'worktree' && wbDiff.target?.kind === 'branch', `实际: ${wbDiff.source?.kind}/${wbDiff.target?.kind}`);
  check('worktree↔branch（feature/normal → main）behind=2', wbDiff.behind === 2, `实际: ${wbDiff.behind}`);

  // 错误路径：不存在分支
  const missingBranch = await requestJson(baseUrl, diffRefsUrl(fixture, {
    sourceType: 'branch', source: 'main', targetType: 'branch', target: 'feature/no-such-branch', mode: 'committed'
  }));
  checkStatus('不存在的分支返回 404', missingBranch, 404, '/api/diff-refs');

  // 兼容回归：旧接口 /api/diff-worktrees 对两个 worktree 输入仍正常
  const compatParams = new URLSearchParams({ path: fixture.repo, source: wt.main, target: wt['feature/normal'], mode: 'committed' });
  const legacyDiff = await requestJson(baseUrl, `/api/diff-worktrees?${compatParams}`);
  checkStatus('/api/diff-worktrees 两个 worktree 输入仍返回 200', legacyDiff, 200, '/api/diff-worktrees');
  check('/api/diff-worktrees 返回的 diff.source.path 存在', Boolean(legacyDiff.body?.diff?.source?.path));
  check('/api/diff-worktrees ahead 仍为 2', legacyDiff.body?.diff?.ahead === 2, `实际: ${legacyDiff.body?.diff?.ahead}`);

  // 失联 worktree：删除 feature/absorbed 的 worktree 目录制造 prunable 状态（放在最后，避免影响其他断言）
  fs.rmSync(wt['feature/absorbed'], { recursive: true, force: true });
  const prunedDiff = await requestJson(baseUrl, diffRefsUrl(fixture, {
    sourceType: 'worktree', source: wt.main, targetType: 'worktree', target: wt['feature/absorbed'], mode: 'committed'
  }));
  check(
    '失联 worktree（prunable）返回 4xx 明确错误',
    prunedDiff.status >= 400 && prunedDiff.status < 500,
    `实际 HTTP ${prunedDiff.status}${notImplementedHint('/api/diff-refs', prunedDiff.status)}`
  );
  check('失联 worktree 错误信息非空', typeof prunedDiff.body?.error === 'string' && prunedDiff.body.error.length > 0);
}

// ---------- STAGE compat：既有接口回归冒烟 ----------

async function runStageCompat(ctx) {
  const { baseUrl, fixture } = ctx;
  const repo = fixture.repo;
  const wt = fixture.worktrees;
  console.log('\n===== STAGE compat：既有接口回归冒烟 =====');

  const inspect = await requestJson(baseUrl, `/api/inspect?path=${encodeURIComponent(repo)}`);
  checkStatus('/api/inspect 返回 200', inspect, 200, '/api/inspect');
  check('/api/inspect 含 worktrees/branches/mainBranch 关键字段',
    Array.isArray(inspect.body?.worktrees) && Array.isArray(inspect.body?.branches) && Boolean(inspect.body?.mainBranch));

  const commits = await requestJson(baseUrl, `/api/worktree-commits?worktree=${encodeURIComponent(repo)}&ref=feature/normal`);
  checkStatus('/api/worktree-commits（带 ref 参数）返回 200', commits, 200, '/api/worktree-commits');
  check('/api/worktree-commits 返回非空提交列表', Array.isArray(commits.body?.commits) && commits.body.commits.length >= 2, `实际: ${commits.body?.commits?.length}`);
  check('/api/worktree-commits 提交含 hash/subject 字段',
    Boolean(commits.body?.commits?.[0]?.hash) && typeof commits.body?.commits?.[0]?.subject === 'string');

  const aheadBehind = await requestJson(baseUrl, `/api/worktree-ahead-behind?worktree=${encodeURIComponent(wt['feature/normal'])}`);
  checkStatus('/api/worktree-ahead-behind 返回 200', aheadBehind, 200, '/api/worktree-ahead-behind');
  check('/api/worktree-ahead-behind ahead=2（feature/normal 领先 main）', aheadBehind.body?.ahead === 2, `实际: ${aheadBehind.body?.ahead}`);
  check('/api/worktree-ahead-behind behind 为数字', typeof aheadBehind.body?.behind === 'number');

  const uncommitted = await requestJson(baseUrl, `/api/uncommitted-diff?worktree=${encodeURIComponent(wt['feature/dirty'])}`);
  checkStatus('/api/uncommitted-diff 返回 200', uncommitted, 200, '/api/uncommitted-diff');
  const uncommittedFiles = uncommitted.body?.uncommitted?.files || [];
  check('/api/uncommitted-diff 包含未提交修改 notes.txt', uncommittedFiles.some((f) => f.filePath === 'notes.txt'));
  check('/api/uncommitted-diff 包含 untracked dirty-untracked.txt', uncommittedFiles.some((f) => f.filePath === 'dirty-untracked.txt'));
}

// ---------- 主流程 ----------

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`参数错误: ${err.message}\n`);
    printUsage();
    process.exit(1);
  }
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (!STAGES.includes(args.stage)) {
    console.error(`--stage 仅支持 ${STAGES.join(' | ')}，实际: ${args.stage}\n`);
    process.exit(1);
  }

  // fail-closed 第 1 步：参数与地址白名单校验（不发起任何网络请求、不写任何文件）
  let invocation;
  try {
    invocation = await validateInvocation(args);
  } catch (err) {
    console.error(`✗ 参数校验失败：${err.message}\n`);
    printUsage();
    process.exit(1);
  }
  const { baseUrl, configDir, runId } = invocation;
  console.log(`✓ 参数校验通过：base-url=${baseUrl} config-dir=${configDir} run-id=${runId}`);

  // fail-closed 第 2 步：握手优先于一切业务请求（契约 §8.3）；/api/projects 成功不构成身份验证
  try {
    const handshake = await performHandshake(baseUrl, { runId, configDir });
    console.log(`✓ 握手通过：runId=${handshake.runId} configDir=${handshake.configDir} port=${handshake.port} pid=${handshake.pid}`);
  } catch (err) {
    if (err && err.code === GUARD_ERROR_CODES.HANDSHAKE_NOT_READY) {
      console.error(`✗ ${err.message}`);
      console.error('  本脚本已改为 fail-closed 版本（契约 §8.3），握手接口可用前禁止用于桌面版验收。');
      console.error('  守卫负向用例不依赖服务，可直接运行: node --test test/verify-guard.test.mjs test/qa-guard.test.mjs');
    } else {
      console.error(`✗ 握手失败：${err.message}`);
      console.error('  请以测试模式启动被测服务，例如:');
      console.error('  PORT=9530 GIT_LENS_CONFIG_DIR=/tmp/glwt-verify-config GIT_LENS_TEST_MODE=1 \\');
      console.error('  GIT_LENS_TEST_RUN_ID=<run-id> node src/server.js');
    }
    process.exit(1);
  }

  // 握手通过后才允许构建 fixture 并发起业务请求
  let fixture;
  try {
    fixture = buildFixture();
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
  console.log(`✓ fixture 构建完成：${fixture.repo}`);

  const ctx = { baseUrl, configDir, runId, fixture };
  try {
    if (args.stage !== 'compat') {
      await registerScanDirectory(baseUrl, fixture.repo);
    }
    if (args.stage === 'full' || args.stage === 'mr') await runStageMr(ctx);
    if (args.stage === 'full' || args.stage === 'diff') await runStageDiff(ctx);
    if (args.stage === 'full' || args.stage === 'compat') await runStageCompat(ctx);
  } finally {
    cleanupFixture();
  }

  console.log(`\n共 ${stats.total} 项断言，失败 ${stats.failed} 项`);
  process.exit(stats.failed > 0 ? 1 : 0);
}

// 仅在直接执行本脚本时安装进程钩子并启动主流程；被单测 import 时保持零副作用，
// 否则 unhandledRejection 钩子会干扰 node --test 的失败上报
const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  process.on('exit', cleanupFixture);
  process.on('unhandledRejection', (err) => {
    console.error(`✗ 未捕获的异步错误: ${err?.message || err}`);
    process.exit(1);
  });
  main();
}
