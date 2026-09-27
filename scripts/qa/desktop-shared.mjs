/**
 * desktop-shared.mjs —— 桌面 E2E 共享基建（run-desktop / run-desktop-full 共用）
 *
 * 从 run-desktop.mjs 抽取的进程编排与断言工具：qa-root 编排、E2E 环境注入、
 * 应用启动/关闭协议、页面态定时轮询、端口与孤儿进程检查、报告与截图落盘。
 * fail-closed 约定与契约 §8/§13 相同：任何业务请求前先完成带凭据握手，
 * 端口只来自就绪文件，退出后必须验证服务退出与端口释放。
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { _electron } from 'playwright';

import { FORBIDDEN_PORT, assertPathInsideRoot, assertPlannedPathInsideRoot, parseAndValidateBaseUrl } from './guard.mjs';

const execFileAsync = promisify(execFile);

export const QA_DIR = path.dirname(fileURLToPath(import.meta.url));
export const WORKTREE_ROOT = path.resolve(QA_DIR, '..', '..');
export const ELECTRON_MAIN = path.join(WORKTREE_ROOT, 'electron', 'main.js');
export const ELECTRON_BIN = path.join(
  WORKTREE_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'
);
export const READY_TIMEOUT_MS = 30000;
export const HTTP_TIMEOUT_MS = 10000;

/** 桌面入口通用参数（纯函数，供单测）：--keep 保留现场、--strict-csp 硬断言 */
export function parseDesktopArgs(argv) {
  const keep = argv.includes('--keep');
  const strictCsp = argv.includes('--strict-csp');
  const unknown = argv.filter((a) => a !== '--keep' && a !== '--strict-csp');
  return { keep, strictCsp, unknown };
}

/** 组装桌面应用的受控环境（纯函数，供单测）：E2E 钩子与 git 隔离全部指向 qa-root */
export function buildDesktopEnv({ qaRoot, runId }) {
  const gitHome = path.join(qaRoot, 'git-home');
  return {
    // 继承 PATH 等基础变量，但剥离可能劫持 git 上下文的变量
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'].includes(k))),
    GIT_LENS_USER_DATA: path.join(qaRoot, 'electron-user-data'),
    GIT_LENS_E2E_READY_FILE: path.join(qaRoot, 'artifacts', 'ready.json'),
    GIT_LENS_E2E_TOKEN_FILE: path.join(qaRoot, 'artifacts', 'token.txt'),
    GIT_LENS_TEST_MODE: '1',
    GIT_LENS_TEST_RUN_ID: runId,
    // web 语义的配置目录：desktop 服务实际读取 <userData>/git-lens-config（契约 §5），
    // 此处保留注入仅为对齐 web 侧习惯并供诊断对照
    GIT_LENS_CONFIG_DIR: path.join(qaRoot, 'config'),
    HOME: gitHome,
    XDG_CONFIG_HOME: gitHome,
    GIT_CONFIG_GLOBAL: path.join(gitHome, 'config'),
    GIT_CONFIG_NOSYSTEM: '1'
  };
}

/** 预写服务扫描目录配置：desktop 服务读 <userData>/git-lens-config，web 位置留档对照 */
export async function writeServiceScanConfig(qaRoot) {
  const configPayload = `${JSON.stringify({ customDirectories: [path.join(qaRoot, 'repos')] }, null, 2)}\n`;
  for (const dir of [
    path.join(qaRoot, 'electron-user-data', 'git-lens-config'),
    path.join(qaRoot, 'config')
  ]) {
    // 写前用计划路径守卫自我约束（目录与文件此时可能尚不存在）
    await assertPlannedPathInsideRoot(path.join(dir, 'config.json'), qaRoot);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'config.json'), configPayload, 'utf8');
  }
}

/** 结果收集器：各入口维护独立 results 数组并统一回显 */
export function createResults() {
  const results = [];
  return {
    results,
    /**
     * 记录一条场景结果并回显。
     * @param {'pass'|'fail'|'skip'} status
     */
    record(id, name, status, detail = '') {
      results.push({ id, name, status, detail });
      const mark = status === 'pass' ? '✓' : status === 'fail' ? '✗' : '–';
      console.log(`${mark} [${id}] ${name}${detail ? ` —— ${detail}` : ''}`);
    },
    summary() {
      const count = (status) => results.filter((r) => r.status === status).length;
      return { total: results.length, passed: count('pass'), failed: count('fail'), skipped: count('skip') };
    }
  };
}

export function tail(text, max = 1600) {
  const trimmed = (text || '').trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

/** 就绪文件形态：基础形态无 state 字段；服务退出时并入 state:"crashed" */
export function readReadyFile(readyFile) {
  try {
    return JSON.parse(fsSync.readFileSync(readyFile, 'utf8'));
  } catch {
    return null;
  }
}

/** 轮询直到 read() 返回真值或超时 */
export async function pollUntil(read, timeoutMs, { intervalMs = 200, describe } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`等待超时（${timeoutMs}ms）：${describe || '条件未满足'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * 以固定间隔在页面里求值断言函数，代替 waitForFunction 的 rAF 轮询：
 * 恢复遮罩的可见窗口只有 1-2 秒，且崩溃/重载期间 rAF 会被节流甚至暂停，
 * 定时轮询不受窗口可见性与上下文重建影响（导航期求值失败按未满足处理）。
 */
export async function pollPage(page, pageFunction, arg, timeoutMs, intervalMs = 150) {
  const startedAt = Date.now();
  for (;;) {
    let satisfied = false;
    try {
      satisfied = await page.evaluate(pageFunction, arg);
    } catch {
      // 页面正在导航/上下文重建时求值会抛错，视为本轮未满足
    }
    if (satisfied) return true;
    if (Date.now() - startedAt > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** 探测 127.0.0.1:port 是否已无监听（连接被拒 = 已释放） */
export function isPortClosed(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(true));
  });
}

/** 进程是否仍存活（kill 0 探测；权限不足视为存活） */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** 通过 ps 查找仍存活的本 worktree Electron 进程（含全部辅助进程） */
export async function findElectronProcesses() {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,command='], { maxBuffer: 4 * 1024 * 1024 });
    return stdout
      .split('\n')
      .filter((line) => line.includes('/node_modules/electron/dist/Electron.app/'))
      .map((line) => line.trim())
      .filter((line) => line.includes(WORKTREE_ROOT));
  } catch {
    return [];
  }
}

/** JSON API 请求（可选会话凭据）；非 JSON 响应时 body 为 null */
export async function requestJson(baseUrl, pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers['X-Git-Lens-Session'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(baseUrl + pathname, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // 非 JSON 响应由状态断言兜底
  }
  return { status: res.status, body: json };
}

/**
 * 启动桌面应用并等待首个窗口加载完成。就绪文件由调用方按需轮询
 * （full 入口需要在窗口出现前后分别采样）。
 */
export async function startDesktopApp({ qaRoot, runId }) {
  if (!fsSync.existsSync(ELECTRON_BIN)) {
    throw new Error(`未找到 Electron 可执行文件: ${ELECTRON_BIN}（请先 npm install 让 electron postinstall 下载二进制）`);
  }
  const env = buildDesktopEnv({ qaRoot, runId });
  const app = await _electron.launch({
    executablePath: ELECTRON_BIN,
    args: [ELECTRON_MAIN],
    env,
    cwd: WORKTREE_ROOT,
    timeout: READY_TIMEOUT_MS
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, env };
}

/** 安装 CSP console 收集器：区分 Electron 未打包开发提醒与真实违规 */
export function attachCspCollector(page) {
  const realViolations = [];
  const electronDevWarnings = [];
  page.on('console', (message) => {
    const text = message.text() || '';
    if (!/Content Security Policy|Content-Security-Policy|\bCSP\b/i.test(text)) return;
    const entry = { type: message.type(), text: text.slice(0, 500) };
    if (/Electron Security Warning/i.test(text)) {
      electronDevWarnings.push(entry);
    } else {
      realViolations.push(entry);
    }
  });
  return {
    /** @returns {{ realViolationCount: number, realViolations: unknown[], electronDevWarningCount: number }} */
    summarize() {
      return {
        realViolationCount: realViolations.length,
        realViolations,
        electronDevWarningCount: electronDevWarnings.length
      };
    }
  };
}

/** 关闭应用并执行退出协议验证：服务退出、端口释放、主进程退出、孤儿强杀 */
export async function closeAndVerify({ app, ready, closeTimeoutMs = 15000 }) {
  const closeStartedAt = Date.now();
  await app.close();
  const closeElapsed = Date.now() - closeStartedAt;
  const serviceGone = await pollUntil(() => !isPidAlive(ready.servicePid), closeTimeoutMs, {
    intervalMs: 250,
    describe: `服务进程 ${ready.servicePid} 退出`
  }).then(() => true).catch(() => false);
  const portClosed = await pollUntil(() => isPortClosed(ready.port), closeTimeoutMs, {
    intervalMs: 250,
    describe: `端口 ${ready.port} 释放`
  }).then(() => true).catch(() => false);
  const mainGone = !isPidAlive(ready.mainPid);
  // 主进程退出后 Electron 辅助进程应全部消失；兜底强杀防孤儿
  let orphans = await findElectronProcesses();
  for (const line of orphans) {
    const pid = Number(line.split(/\s+/)[0]);
    if (Number.isInteger(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
    }
  }
  if (orphans.length > 0) {
    console.error('[qa-desktop] 残留 Electron 进程（已强杀）:', orphans.slice(0, 5));
  }
  return {
    serviceGone, portClosed, mainGone, closeElapsed,
    orphanCount: orphans.length,
    ok: serviceGone && portClosed && mainGone && orphans.length === 0
  };
}

/** 截图到 qa-root/artifacts（文件名含场景编号，G4 视觉基线起点） */
export async function screenshotFile(page, qaRoot, scenarioId, name) {
  const file = path.join(qaRoot, 'artifacts', `g4-${scenarioId}-${name}.png`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

/**
 * 捕获完整窗口内容为 PNG（主进程 capturePage）。
 * 与 page.screenshot 的视口截图不同，capturePage 与实际窗口内容一致，
 * 页面缩放（zoom）放大内容时不会产生裁切，适合作视觉基线来源。
 */
export async function captureWindowPng(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents
    .capturePage()
    .then((img) => img.toPNG()));
}

/**
 * 视觉基线截图：先轮询断言目标视图的 DOM 标记已出现，断言失败不出图（抛错）；
 * 通过后以 capturePage 捕获完整窗口内容写入 artifacts。
 * @param {object} app - Playwright ElectronApp 句柄
 * @param {object} page - Playwright Page 句柄
 * @param {string} qaRoot
 * @param {string} id 场景编号（入文件名）
 * @param {string} name 场景名（入文件名）
 * @param {(arg: null) => boolean} assertPageFn 页面内断言函数（page.evaluate 语义）
 */
export async function captureBaseline(app, page, qaRoot, id, name, assertPageFn) {
  const ok = await pollPage(page, assertPageFn, null, 12000);
  if (!ok) {
    throw new Error(`视觉基线截图 g4-${id}-${name} 的视图断言未通过，拒绝出图`);
  }
  const file = path.join(qaRoot, 'artifacts', `g4-${id}-${name}.png`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, await captureWindowPng(app));
  return file;
}

/** 校验就绪文件：端口合法、≠9527，并返回规范化 baseUrl */
export function validateReady(ready) {
  if (!ready || !Number.isInteger(ready.port) || ready.port < 1) {
    throw new Error(`就绪文件端口非法: ${JSON.stringify(ready)}`);
  }
  if (ready.port === FORBIDDEN_PORT) {
    throw new Error(`服务端口为 ${FORBIDDEN_PORT}（主实例保留端口），拒绝继续`);
  }
  return { baseUrl: parseAndValidateBaseUrl(`http://127.0.0.1:${ready.port}`).baseUrl, port: ready.port };
}
