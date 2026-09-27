/**
 * guard.mjs —— QA 隔离测试共享的 fail-closed 守卫模块（契约 §8.2）
 *
 * 设计原则：任何 HTTP 业务请求或文件写入发生之前，必须先通过本模块的校验；
 * 校验失败一律抛出携带中文原因的 GuardError，绝不「降级放行」。
 *
 * 守卫规则（对应 docs/proposals/electron-contracts.md §8.2）：
 *   1. base-url 仅接受 `http://127.0.0.1:<端口>`，端口不得为 9527；拒绝 localhost 等
 *      域名形式、其他主机名、代理、路径、查询、用户凭据与 hash。
 *   2. 路径（configDir、扫描目录、userData、git 写目标）经 realpath 后必须位于 qa-root
 *      内；拒绝空值、相对路径、qa-root 外路径与符号链接逃逸；拒绝 $HOME/.config/git-lens-web。
 *   3. 握手（契约 §3）成功且 runId/configDir 三方一致后才放行后续请求；
 *      `/api/projects` 成功不构成身份验证。
 *
 * 本模块只被测试基建（verify 脚本、qa 启动器、单测）引用，不进入生产代码路径。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 主实例保留端口：主仓库的生产语义实例固定占用，任何测试不得触碰 */
export const FORBIDDEN_PORT = 9527;

/** 真实用户配置目录相对 $HOME 的子路径：测试禁止读写 */
export const REAL_CONFIG_SUBPATH = path.join('.config', 'git-lens-web');

/** 握手接口路径（契约 §3）：仅 GIT_LENS_TEST_MODE=1 且注入 runId 时存在 */
export const HANDSHAKE_PATH = '/api/test-handshake';

/** 守卫错误：code 用于程序化分支（如 HANDSHAKE_NOT_READY 触发正向用例跳过），message 面向人 */
export class GuardError extends Error {
  /**
   * @param {string} code 机器可读错误码，取 GUARD_ERROR_CODES 之一
   * @param {string} message 中文原因说明
   */
  constructor(code, message) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
  }
}

/** 守卫错误码汇总，供调用方做 switch 分支而非匹配文案 */
export const GUARD_ERROR_CODES = {
  INVALID_BASE_URL: 'INVALID_BASE_URL',
  PATH_ESCAPED: 'PATH_ESCAPED',
  REAL_CONFIG_PATH: 'REAL_CONFIG_PATH',
  HANDSHAKE_NOT_READY: 'HANDSHAKE_NOT_READY',
  HANDSHAKE_UNREACHABLE: 'HANDSHAKE_UNREACHABLE',
  HANDSHAKE_BAD_STATUS: 'HANDSHAKE_BAD_STATUS',
  HANDSHAKE_MISMATCH: 'HANDSHAKE_MISMATCH',
  HANDSHAKE_BAD_BODY: 'HANDSHAKE_BAD_BODY',
  MISSING_ARGUMENT: 'MISSING_ARGUMENT'
};

/**
 * 解析并校验被测服务 base-url（纯同步函数，便于单测）。
 *
 * @param {string} input 形如 `http://127.0.0.1:9528` 的地址
 * @returns {{ host: '127.0.0.1', port: number, baseUrl: string }} 规范化后的地址（无尾斜杠）
 * @throws {GuardError} code=INVALID_BASE_URL，message 为中文拒绝原因
 */
export function parseAndValidateBaseUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new GuardError(GUARD_ERROR_CODES.INVALID_BASE_URL, 'base-url 不能为空');
  }
  if (input !== input.trim()) {
    throw new GuardError(GUARD_ERROR_CODES.INVALID_BASE_URL, 'base-url 不能包含前后空白字符');
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new GuardError(GUARD_ERROR_CODES.INVALID_BASE_URL, `base-url 不是合法 URL: ${input}`);
  }

  if (parsed.protocol !== 'http:') {
    throw new GuardError(
      GUARD_ERROR_CODES.INVALID_BASE_URL,
      `base-url 仅接受 http:// 协议，实际协议: ${parsed.protocol}//`
    );
  }
  // 只认 127.0.0.1 字面量：localhost 等域名会经 DNS/hosts 解析，存在被劫持或误指的可能
  if (parsed.hostname !== '127.0.0.1') {
    throw new GuardError(
      GUARD_ERROR_CODES.INVALID_BASE_URL,
      `base-url 仅接受 127.0.0.1 环回主机名，实际主机名: ${parsed.hostname}（localhost 等域名形式一律拒绝）`
    );
  }
  if (parsed.username || parsed.password) {
    throw new GuardError(GUARD_ERROR_CODES.INVALID_BASE_URL, 'base-url 不允许携带用户名或密码');
  }

  const port = Number(parsed.port);
  if (!parsed.port) {
    throw new GuardError(GUARD_ERROR_CODES.INVALID_BASE_URL, 'base-url 必须显式携带端口号');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new GuardError(GUARD_ERROR_CODES.INVALID_BASE_URL, `端口号必须是 1-65535 的整数，实际: ${parsed.port}`);
  }
  if (port === FORBIDDEN_PORT) {
    throw new GuardError(
      GUARD_ERROR_CODES.INVALID_BASE_URL,
      `端口 ${FORBIDDEN_PORT} 是主实例保留端口，测试禁止触碰（请用 PORT=0 或其他高位端口）`
    );
  }
  // URL 会把空路径归一化为 '/'，这里只放行无路径形态，显式写出 '/' 也视为带路径拒绝
  if (parsed.pathname !== '/') {
    throw new GuardError(
      GUARD_ERROR_CODES.INVALID_BASE_URL,
      `base-url 不允许携带路径前缀，实际路径: ${parsed.pathname}（请只提供 http://127.0.0.1:<端口>）`
    );
  }
  if (parsed.search) {
    throw new GuardError(GUARD_ERROR_CODES.INVALID_BASE_URL, `base-url 不允许携带查询参数，实际: ${parsed.search}`);
  }
  if (parsed.hash) {
    throw new GuardError(GUARD_ERROR_CODES.INVALID_BASE_URL, `base-url 不允许携带 hash，实际: ${parsed.hash}`);
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  // 原始输入精确比对兜底：URL 解析会把「http://127.0.0.1:<端口>/」的 href 归一化成与裸地址相同，
  // 因此以字面形式为准，只接受无尾斜杠、无端口前导零的规范写法
  if (input !== baseUrl) {
    throw new GuardError(
      GUARD_ERROR_CODES.INVALID_BASE_URL,
      `base-url 形态不在白名单内：${input}（仅接受 ${baseUrl}，不带尾斜杠/路径/查询）`
    );
  }

  return { host: '127.0.0.1', port, baseUrl };
}

/**
 * 校验候选路径经 realpath 后位于 qa-root 内（契约 §8.2 第 2 条）。
 *
 * realpath 会展开符号链接与 `..`，因此「symlink 指向 qa-root 外」「相对路径逃逸」
 * 都会在真实路径比较阶段被拒。候选路径不存在时同样拒绝（fail-closed）。
 *
 * @param {string} candidatePath 待校验的绝对路径（configDir、扫描目录、userData 等）
 * @param {string} qaRoot 本轮 qa-root 根目录（绝对路径）
 * @returns {Promise<string>} realpath 后的候选路径
 * @throws {GuardError} code=PATH_ESCAPED，message 为中文拒绝原因
 */
export async function assertPathInsideRoot(candidatePath, qaRoot) {
  if (typeof candidatePath !== 'string' || candidatePath.trim() === '') {
    throw new GuardError(GUARD_ERROR_CODES.PATH_ESCAPED, '待校验路径不能为空');
  }
  if (typeof qaRoot !== 'string' || qaRoot.trim() === '') {
    throw new GuardError(GUARD_ERROR_CODES.PATH_ESCAPED, 'qa-root 不能为空');
  }
  // 相对路径会依赖进程 cwd 解析，行为不可预测，直接拒绝
  if (!path.isAbsolute(candidatePath)) {
    throw new GuardError(GUARD_ERROR_CODES.PATH_ESCAPED, `待校验路径必须是绝对路径，实际: ${candidatePath}`);
  }
  if (!path.isAbsolute(qaRoot)) {
    throw new GuardError(GUARD_ERROR_CODES.PATH_ESCAPED, `qa-root 必须是绝对路径，实际: ${qaRoot}`);
  }

  const realCandidate = await fs.realpath(candidatePath).catch(() => {
    throw new GuardError(
      GUARD_ERROR_CODES.PATH_ESCAPED,
      `待校验路径不存在或无法解析（fail-closed 拒绝）: ${candidatePath}`
    );
  });
  const realRoot = await fs.realpath(qaRoot).catch(() => {
    throw new GuardError(GUARD_ERROR_CODES.PATH_ESCAPED, `qa-root 不存在或无法解析: ${qaRoot}`);
  });

  // candidate 等于 qa-root 本身（rel === ''）视为合法；越过根（../ 开头或绝对路径形态）一律拒绝
  const rel = path.relative(realRoot, realCandidate);
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
    throw new GuardError(
      GUARD_ERROR_CODES.PATH_ESCAPED,
      `路径逃逸 qa-root：${realCandidate} 不在 ${realRoot} 内（已拒绝符号链接或 .. 逃逸）`
    );
  }
  return realCandidate;
}

/**
 * 校验「计划写入」的候选路径位于 qa-root 内（目标允许尚不存在）。
 *
 * assertPathInsideRoot 要求目标已存在（realpath 直查），不适用于即将创建的
 * manifest/文件/目录。本函数自候选路径向上找到第一个真实存在的祖先做 realpath
 * 校验，再对未存在段做词法校验（禁止 `..`），兼顾 fail-closed 与创建前校验。
 *
 * @param {string} candidatePath 待创建目标的绝对路径
 * @param {string} qaRoot 本轮 qa-root 根目录（绝对路径）
 * @returns {Promise<string>} 规范化后的目标路径（已存在段为 realpath，未存在段为词法拼接）
 * @throws {GuardError} code=PATH_ESCAPED，message 为中文拒绝原因
 */
export async function assertPlannedPathInsideRoot(candidatePath, qaRoot) {
  if (typeof candidatePath !== 'string' || candidatePath.trim() === '') {
    throw new GuardError(GUARD_ERROR_CODES.PATH_ESCAPED, '待校验路径不能为空');
  }
  if (typeof qaRoot !== 'string' || qaRoot.trim() === '') {
    throw new GuardError(GUARD_ERROR_CODES.PATH_ESCAPED, 'qa-root 不能为空');
  }
  if (!path.isAbsolute(candidatePath)) {
    throw new GuardError(GUARD_ERROR_CODES.PATH_ESCAPED, `待校验路径必须是绝对路径，实际: ${candidatePath}`);
  }
  if (!path.isAbsolute(qaRoot)) {
    throw new GuardError(GUARD_ERROR_CODES.PATH_ESCAPED, `qa-root 必须是绝对路径，实际: ${qaRoot}`);
  }

  // 自上而下找第一个真实存在的祖先；逐级记录尚未存在的段名
  let existing = path.resolve(candidatePath);
  const unresolved = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- 段数有限（临时目录深度），无需并行
    const real = await fs.realpath(existing).catch((err) => {
      if (err && err.code === 'ENOENT') return null;
      throw new GuardError(GUARD_ERROR_CODES.PATH_ESCAPED, `路径无法解析（fail-closed 拒绝）: ${existing}（${err.message}）`);
    });
    if (real !== null) break;
    unresolved.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw new GuardError(GUARD_ERROR_CODES.PATH_ESCAPED, `路径整条链都不存在: ${candidatePath}`);
    }
    existing = parent;
  }
  const realRoot = await fs.realpath(qaRoot).catch(() => {
    throw new GuardError(GUARD_ERROR_CODES.PATH_ESCAPED, `qa-root 不存在或无法解析: ${qaRoot}`);
  });
  const realExisting = await fs.realpath(existing);

  // 已存在的祖先必须在 qa-root 内
  const rel = path.relative(realRoot, realExisting);
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
    throw new GuardError(
      GUARD_ERROR_CODES.PATH_ESCAPED,
      `路径逃逸 qa-root：${realExisting} 不在 ${realRoot} 内（已拒绝符号链接或 .. 逃逸）`
    );
  }
  // 未存在的段只允许普通名称，词法 `..` 直接拒绝
  if (unresolved.some((seg) => seg === '..')) {
    throw new GuardError(
      GUARD_ERROR_CODES.PATH_ESCAPED,
      `待创建路径包含 .. 逃逸段（fail-closed 拒绝）: ${candidatePath}`
    );
  }
  return path.join(realExisting, ...unresolved);
}

/**
 * 校验候选路径（realpath 后）不位于真实用户配置目录 `$HOME/.config/git-lens-web` 之下。
 *
 * @param {string} candidatePath 待校验的绝对路径
 * @param {{ home?: string }} [options] home 注入点，仅供单测使用；缺省取 os.homedir()
 * @returns {Promise<string>} realpath 后的候选路径
 * @throws {GuardError} code=REAL_CONFIG_PATH，message 为中文拒绝原因
 */
export async function assertPathNotUnderRealConfig(candidatePath, { home = os.homedir() } = {}) {
  if (typeof candidatePath !== 'string' || candidatePath.trim() === '') {
    throw new GuardError(GUARD_ERROR_CODES.REAL_CONFIG_PATH, '待校验路径不能为空');
  }
  if (!path.isAbsolute(candidatePath)) {
    throw new GuardError(GUARD_ERROR_CODES.REAL_CONFIG_PATH, `待校验路径必须是绝对路径，实际: ${candidatePath}`);
  }

  const realCandidate = await fs.realpath(candidatePath).catch(() => {
    throw new GuardError(
      GUARD_ERROR_CODES.REAL_CONFIG_PATH,
      `待校验路径不存在或无法解析（fail-closed 拒绝）: ${candidatePath}`
    );
  });

  // 真实配置目录可能不存在（未用过主实例），此时按字面路径比较即可
  const realConfigRoot = path.join(home, REAL_CONFIG_SUBPATH);
  const realConfigRootResolved = await fs.realpath(realConfigRoot).catch(() => realConfigRoot);

  const rel = path.relative(realConfigRootResolved, realCandidate);
  if (rel === '' || !(rel.startsWith('..') || path.isAbsolute(rel))) {
    throw new GuardError(
      GUARD_ERROR_CODES.REAL_CONFIG_PATH,
      `拒绝使用真实配置目录：${realCandidate} 位于 $HOME/${REAL_CONFIG_SUBPATH}（${realConfigRootResolved}）之下，测试配置必须指向本轮 qa-root`
    );
  }
  return realCandidate;
}

/**
 * 执行测试握手（契约 §3）：任何业务请求前调用，核对 runId、configDir、host 与端口。
 *
 * 入口处会先用 parseAndValidateBaseUrl 复核 baseUrl，保证即使调用方绕过参数校验，
 * 握手请求也只会发往 127.0.0.1 的非 9527 端口。
 *
 * @param {string} baseUrl 被测服务地址
 * @param {{ runId: string, configDir: string, timeoutMs?: number, headers?: Record<string, string> }} options
 *   headers：附加请求头。desktop 模式下所有 /api 请求（含握手）都要求
 *   X-Git-Lens-Session 会话凭据（契约 §4），桌面 E2E 启动器必须传入。
 * @returns {Promise<{ok: true, runId: string, configDir: string, host: string, port: number, pid: number}>}
 * @throws {GuardError} 404 → HANDSHAKE_NOT_READY（Runtime 契约未就绪，正向用例应跳过）；
 *                      网络/超时 → HANDSHAKE_UNREACHABLE；其余状态/字段不一致按码分类
 */
export async function performHandshake(baseUrl, { runId, configDir, timeoutMs = 5000, headers } = {}) {
  // 防御性复核：握手自身也必须经过 base-url 守卫，不允许直连任意地址
  const { baseUrl: normalized } = parseAndValidateBaseUrl(baseUrl);

  if (!runId || typeof runId !== 'string') {
    throw new GuardError(GUARD_ERROR_CODES.MISSING_ARGUMENT, '握手缺少 runId（必须与服务进程 GIT_LENS_TEST_RUN_ID 一致）');
  }
  if (!configDir || typeof configDir !== 'string') {
    throw new GuardError(GUARD_ERROR_CODES.MISSING_ARGUMENT, '握手缺少 configDir（必须与服务进程 GIT_LENS_CONFIG_DIR 一致）');
  }
  const realConfigDir = await fs.realpath(configDir).catch(() => {
    throw new GuardError(GUARD_ERROR_CODES.MISSING_ARGUMENT, `握手 configDir 不存在或无法解析: ${configDir}`);
  });

  let res;
  try {
    res = await fetch(normalized + HANDSHAKE_PATH, {
      headers: headers || undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    throw new GuardError(
      GUARD_ERROR_CODES.HANDSHAKE_UNREACHABLE,
      `握手请求失败：无法访问 ${normalized}${HANDSHAKE_PATH}（${err.message}）。请确认服务已以 GIT_LENS_TEST_MODE=1 启动且端口正确`
    );
  }

  if (res.status === 404) {
    throw new GuardError(
      GUARD_ERROR_CODES.HANDSHAKE_NOT_READY,
      `Runtime 契约未就绪：${HANDSHAKE_PATH} 返回 404（服务未实现测试握手接口，见契约 §3）。正向用例应跳过；负向守卫用例不受影响`
    );
  }
  if (res.status !== 200) {
    throw new GuardError(GUARD_ERROR_CODES.HANDSHAKE_BAD_STATUS, `握手返回非预期状态 HTTP ${res.status}（期望 200）`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new GuardError(GUARD_ERROR_CODES.HANDSHAKE_BAD_BODY, '握手响应不是合法 JSON');
  }
  if (!body || body.ok !== true) {
    throw new GuardError(GUARD_ERROR_CODES.HANDSHAKE_BAD_BODY, `握手响应缺少 ok:true（实际: ${JSON.stringify(body)}）`);
  }
  if (body.runId !== runId) {
    throw new GuardError(
      GUARD_ERROR_CODES.HANDSHAKE_MISMATCH,
      `握手 runId 不一致：服务返回 ${JSON.stringify(body.runId)}，期望 ${JSON.stringify(runId)}（疑似误连其他测试实例）`
    );
  }
  if (body.configDir !== realConfigDir) {
    throw new GuardError(
      GUARD_ERROR_CODES.HANDSHAKE_MISMATCH,
      `握手 configDir 不一致：服务返回 ${body.configDir}，期望 ${realConfigDir}（服务的 GIT_LENS_CONFIG_DIR 与本轮 qa-root 不符）`
    );
  }
  if (body.host !== '127.0.0.1') {
    throw new GuardError(GUARD_ERROR_CODES.HANDSHAKE_MISMATCH, `握手 host 不是 127.0.0.1（实际: ${body.host}）`);
  }
  if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
    throw new GuardError(GUARD_ERROR_CODES.HANDSHAKE_BAD_BODY, `握手端口非法: ${JSON.stringify(body.port)}`);
  }
  if (body.port === FORBIDDEN_PORT) {
    throw new GuardError(GUARD_ERROR_CODES.HANDSHAKE_MISMATCH, `握手端口为 ${FORBIDDEN_PORT}（主实例保留端口），拒绝继续`);
  }
  return body;
}
