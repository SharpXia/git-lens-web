/**
 * desktop-shared.mjs —— 桌面 E2E 共享基建（run-desktop / run-desktop-full 共用）
 *
 * 从 run-desktop.mjs 抽取的进程编排与断言工具：qa-root 编排、E2E 环境注入、
 * 应用启动/关闭协议、页面态定时轮询、端口与孤儿进程检查、报告与截图落盘。
 * fail-closed 约定与契约 §8/§13 相同：任何业务请求前先完成带凭据握手，
 * 端口只来自就绪文件，退出后必须验证服务退出与端口释放。
 *
 * 页面访问通道（契约 §15 多标签架构）：应用页运行在各标签的 WebContentsView 里，
 * BrowserWindow 是无应用 preload 的空壳，`_electron` 的 firstWindow() 不再是应用页。
 * 应用以 `--remote-debugging-port=0` 启动，从 `<userData>/DevToolsActivePort` 读取
 * 调试端口，经页面级 CDP WebSocket（/json/list 枚举 + Runtime.evaluate）驱动各标签；
 * `_electron` 的 ElectronApp 句柄保留用于 app 级操作（close()/evaluate 主进程）。
 *
 * 弹框免疫（对齐 electron/checks/smoke.mjs 的 armDialogImmunity，双层机制）：
 * 每个 CDP 页面会话建立时即（1）用 Page.addScriptToEvaluateOnNewDocument 预置
 * window.alert/confirm/prompt 桩，后续新文档从源头不弹框；（2）订阅
 * Page.javascriptDialogOpening，弹框出现即自动 Page.handleJavaScriptDialog accept，
 * 覆盖桩注入前已加载文档的弹框窗口。背景：服务被 kill 的瞬间页面在途请求失败
 * 可能触发页面自身的阻塞式 alert，挂起渲染层全部 JS，恢复遮罩/自动重载/断言
 * 全部冻结——测试必须不被人肉弹框阻塞。事件兜底依赖会话存活，长会话须覆盖
 * 可能弹框的整个窗口期（见 run-desktop-full 崩溃场景的 ≥30s 覆盖提醒）。
 * 实测说明：playwright 的 `chromium.connectOverCDP` 在 Electron 44 下 browser 级
 * 会话初始化挂起（与 remote-debugging-pipe 是否在位无关），故按契约的 CDP 通道
 * 采用页面级直连（与 electron/checks/smoke.mjs 已验证方式一致）。
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

/**
 * 弹框免疫第一层（新文档桩）的注入源：把 alert/confirm/prompt 替换为无副作用
 * 桩（confirm 返回 false、prompt 返回 null，与用户取消语义一致），让
 * addScriptToEvaluateOnNewDocument 之后加载的每个新文档从源头不产生真实弹框。
 * 单独导出供单测钉死桩语义（三个函数齐全且返回值安全）。
 */
export const DIALOG_STUB_SOURCE =
  'window.alert = function () {}; window.confirm = function () { return false; }; window.prompt = function () { return null; };';

/** 桌面入口通用参数（纯函数，供单测）：--keep 保留现场、--strict-csp 硬断言 */
export function parseDesktopArgs(argv) {
  const keep = argv.includes('--keep');
  const strictCsp = argv.includes('--strict-csp');
  const unknown = argv.filter((a) => a !== '--keep' && a !== '--strict-csp');
  return { keep, strictCsp, unknown };
}

/**
 * 组装桌面应用的受控环境（纯函数，供单测）：E2E 钩子与 git 隔离全部指向 qa-root。
 * @param {object} options
 * @param {string} options.qaRoot 本轮 qa-root
 * @param {string} options.runId 测试轮次 id
 * @param {string} [options.suffix] 实例后缀：非空时 userData/E2E 文件改用带后缀的
 *   独立目录（如多标签场景的第二个实例），避免与主实例的单实例锁和就绪文件冲突
 */
export function buildDesktopEnv({ qaRoot, runId, suffix = '' } = {}) {
  const gitHome = path.join(qaRoot, 'git-home');
  const artifactsDir = path.join(qaRoot, suffix ? `artifacts-${suffix}` : 'artifacts');
  const userDataDir = path.join(qaRoot, suffix ? `electron-user-data-${suffix}` : 'electron-user-data');
  return {
    // 继承 PATH 等基础变量，但剥离可能劫持 git 上下文的变量
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'].includes(k))),
    GIT_LENS_USER_DATA: userDataDir,
    GIT_LENS_E2E_READY_FILE: path.join(artifactsDir, 'ready.json'),
    GIT_LENS_E2E_TOKEN_FILE: path.join(artifactsDir, 'token.txt'),
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

/** 预写服务扫描目录配置：desktop 服务读 GIT_LENS_CONFIG_DIR（<qaRoot>/config），旧布局留档对照 */
export async function writeServiceScanConfig(qaRoot) {
  for (const dir of [
    path.join(qaRoot, 'electron-user-data', 'git-lens-config'),
    path.join(qaRoot, 'config')
  ]) {
    await writeScanConfigInto(dir, qaRoot);
  }
}

/**
 * 向单个服务配置目录写入扫描目录配置（供带后缀的独立实例复用）。
 * @param {string} configDir 服务实际读取的配置目录（<userData>/git-lens-config）
 * @param {string} qaRoot 扫描目录取 <qaRoot>/repos
 */
export async function writeScanConfigInto(configDir, qaRoot) {
  const configPayload = `${JSON.stringify({ customDirectories: [path.join(qaRoot, 'repos')] }, null, 2)}\n`;
  // 写前用计划路径守卫自我约束（目录与文件此时可能尚不存在）
  await assertPlannedPathInsideRoot(path.join(configDir, 'config.json'), qaRoot);
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'config.json'), configPayload, 'utf8');
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

/** 固定延时（Promise 化 sleep） */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询直到异步 probe() 返回真值或超时（探测抛错按未满足处理，用于 /json/list 等可抖动探测） */
export async function pollUntilAsync(probe, timeoutMs, { intervalMs = 200, describe } = {}) {
  const startedAt = Date.now();
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // 探测期间错误（如目标列表瞬时不可得）视为尚未就绪
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`等待超时（${timeoutMs}ms）：${describe || '条件未满足'}`);
    }
    await sleep(intervalMs);
  }
}

/**
 * 解析 DevToolsActivePort 文件内容：首行为调试端口（纯函数，供单测）。
 * @param {string} raw 文件原始内容
 * @returns {number|null} 合法端口或 null
 */
export function parseDevToolsActivePort(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const port = Number.parseInt(raw.split('\n')[0].trim(), 10);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/** 读取 <userData>/DevToolsActivePort 首行的调试端口（契约 §15 E2E 通道） */
export function readDevToolsActivePort(userDataDir) {
  try {
    return parseDevToolsActivePort(fsSync.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8'));
  } catch {
    return null;
  }
}

/** 轮询等待 DevToolsActivePort 出现并返回调试端口 */
export async function waitForCdpPort(userDataDir, timeoutMs = 15000) {
  return pollUntil(() => readDevToolsActivePort(userDataDir), timeoutMs, {
    intervalMs: 150,
    describe: `<userData>/DevToolsActivePort 出现（CDP 调试端口）`
  });
}

/** 拉取 CDP 目标列表（/json/list） */
export async function fetchCdpTargets(cdpPort) {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`/json/list 返回 ${res.status}`);
  return res.json();
}

/** 按服务端口 URL 前缀过滤应用标签目标（纯函数，供单测）：排除 tabbar（file://）与空壳（about:blank） */
export function filterAppTargets(prefix, targets) {
  return (targets || []).filter((t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith(prefix));
}

/**
 * 构造 Runtime.evaluate 的表达式源（纯函数，供单测）：函数序列化 + JSON 实参，
 * 与 playwright page.evaluate 的「传函数 + 传参」书写习惯对齐，迁移场景代码零改动。
 * 字符串入参按「求值表达式」处理（无实参时原样求值，如 'document.readyState'）。
 */
export function buildEvaluateSource(pageFunction, arg) {
  const argLiteral = arg === undefined ? '' : JSON.stringify(arg);
  if (typeof pageFunction === 'function') {
    return `(${pageFunction.toString()})(${argLiteral})`;
  }
  const source = String(pageFunction);
  return argLiteral ? `(${source})(${argLiteral})` : source;
}

/**
 * 建立到指定页面目标的 CDP WebSocket 会话，暴露场景所需的 playwright Page 子集：
 * evaluate（函数 + 实参，awaitPromise）/ title / url / reload / waitForTimeout /
 * screenshot / on('console')。playwright `connectOverCDP` 在 Electron 44 下
 * browser 级会话初始化挂起（实测，与调试 pipe 是否在位无关），故按契约 §15 的
 * CDP 通道直连页面级端点（与 electron/checks/smoke.mjs 验证过的方式一致）。
 * @param {number} cdpPort 调试端口
 * @param {string} targetId 页面目标 id（来自 /json/list）
 * @param {string} [initialUrl] 目标初始 URL（导航期求值失败时 url() 回退用）
 */
export function connectCdpPage(cdpPort, targetId, { initialUrl = '' } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${cdpPort}/devtools/page/${targetId}`);
    let seq = 0;
    let settled = false;
    let closed = false;
    let lastUrl = initialUrl;
    const pending = new Map();
    const consoleListeners = [];
    // 弹框事件记录（第二层免疫的观测面）：捕获 javascriptDialogOpening 供场景
    // 核对（如 DEF-006 验收——服务中断改非阻断提示后，恢复窗口不应再出现弹框）
    const dialogEvents = [];

    const failAll = (err) => {
      for (const { rej } of pending.values()) rej(err);
      pending.clear();
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      if (closed) {
        rej(new Error(`CDP 会话已关闭（target ${targetId}）`));
        return;
      }
      const id = ++seq;
      pending.set(id, { res, rej });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        pending.delete(id);
        rej(err);
      }
    });
    const emitConsole = (entry) => {
      for (const listener of consoleListeners) {
        try { listener(entry); } catch { /* 收集器异常不影响会话 */ }
      }
    };

    ws.addEventListener('open', () => {
      const api = {
        targetId,
        /** 目标是否已关闭（连接断开或主动 close） */
        get isClosed() { return closed; },
        /** 在目标页面内求值：语义对齐 playwright page.evaluate（传函数 + 实参） */
        async evaluate(pageFunction, arg) {
          const result = await send('Runtime.evaluate', {
            expression: buildEvaluateSource(pageFunction, arg),
            returnByValue: true,
            awaitPromise: true
          });
          if (result && result.exceptionDetails) {
            const detail = result.exceptionDetails;
            throw new Error(detail.exception?.description || detail.text || '页面求值异常');
          }
          return result && result.result ? result.result.value : undefined;
        },
        async title() {
          return api.evaluate('document.title');
        },
        /** 当前 URL：导航期求值失败时回退到最近一次成功读取的地址 */
        async url() {
          try {
            const href = await api.evaluate('location.href');
            if (typeof href === 'string' && href) lastUrl = href;
          } catch {
            // 页面正在导航，回退缓存值
          }
          return lastUrl;
        },
        /** 重载页面并等待可交互（同目标导航，会话与 sessionStorage 均保持） */
        async reload() {
          await send('Page.reload', { ignoreCache: false });
          await api.waitForLoadState('domcontentloaded');
        },
        /** 等待加载状态：domcontentloaded→interactive、load→complete（定时轮询，不依赖 rAF） */
        async waitForLoadState(state) {
          const target = state === 'load' ? 'complete' : 'interactive';
          const startedAt = Date.now();
          for (;;) {
            let readyState = '';
            try {
              readyState = (await api.evaluate('document.readyState')) || '';
            } catch {
              // 导航期间求值失败按未就绪处理
            }
            if (readyState === 'complete' || (target === 'interactive' && readyState === 'interactive')) return;
            if (Date.now() - startedAt > HTTP_TIMEOUT_MS) {
              throw new Error(`waitForLoadState(${state}) 超时`);
            }
            await sleep(100);
          }
        },
        waitForTimeout: (ms) => sleep(ms),
        /** 截图为 PNG（CDP Page.captureScreenshot），options.path 存在时写入文件 */
        async screenshot(options = {}) {
          const shot = await send('Page.captureScreenshot', { format: 'png' });
          const buffer = Buffer.from(shot?.data || '', 'base64');
          if (options.path) {
            await fs.mkdir(path.dirname(options.path), { recursive: true });
            await fs.writeFile(options.path, buffer);
          }
          return buffer;
        },
        /** 订阅 console 消息（Runtime.consoleAPICalled + Log.entryAdded），回调收 {type,text} */
        on(event, listener) {
          if (event === 'console') consoleListeners.push(listener);
        },
        /**
         * 本会话捕获到的弹框事件快照（Page.javascriptDialogOpening 的
         * {type, message} 列表）。供场景核对阻塞式弹框是否出现（快照为副本，
         * 不清空原记录）。
         */
        dialogEvents() {
          return dialogEvents.slice();
        },
        close() {
          closed = true;
          try { ws.close(); } catch { /* 已关闭 */ }
        }
      };
      (async () => {
        // 先启用事件域再回报就绪：保证此后 console/日志事件不丢。
        // 初始化整体受 10s 硬超时约束——会话若永不就绪，宁可让连接失败可重试，
        // 也不能让启动器 await 在一个永不落定的 Promise 上
        const initDeadline = new Promise((_, rej) => {
          setTimeout(() => rej(new Error(`CDP 会话初始化超时：target ${targetId}`)), 10000);
        });
        await Promise.race([
          (async () => {
            await send('Runtime.enable');
            await send('Page.enable');
            await send('Log.enable');
            // 弹框免疫第一层：预置新文档桩（DIALOG_STUB_SOURCE），此后每个新
            // 文档从源头不产生真实弹框。必须在回报就绪前完成——会话就绪即可
            // 被场景驱动，免疫必须已挂
            await send('Page.addScriptToEvaluateOnNewDocument', { source: DIALOG_STUB_SOURCE });
          })(),
          initDeadline
        ]);
        settled = true;
        resolve(api);
      })().catch((err) => {
        settled = true;
        closed = true;
        try { ws.close(); } catch { /* 忽略 */ }
        reject(err);
      });
    });
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rej(new Error(message.error.message || 'CDP 命令失败'));
        else res(message.result);
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const parts = (message.params?.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || ''));
        emitConsole({ type: message.params?.type || 'log', text: parts.join(' ').slice(0, 2000) });
      } else if (message.method === 'Log.entryAdded') {
        const entry = message.params?.entry || {};
        emitConsole({ type: entry.level || 'error', text: String(entry.text || '').slice(0, 2000) });
      } else if (message.method === 'Page.javascriptDialogOpening') {
        // 弹框免疫第二层（事件兜底）：桩注入前已加载文档上的阻塞式弹框出现即
        // 自动 accept，防止 alert/confirm/prompt 挂起渲染层全部 JS（恢复遮罩、
        // 自动重载与断言都会被冻结）。accept 失败忽略——对话框可能已被同会话
        // 其他机制处理或目标已销毁。事件同时入记录，供场景核对（DEF-006 验收）
        dialogEvents.push({
          type: message.params?.type || '',
          message: String(message.params?.message || '').slice(0, 200)
        });
        void send('Page.handleJavaScriptDialog', { accept: true }).catch(() => { /* 兜底失败不影响会话 */ });
      }
    });
    ws.addEventListener('error', () => {
      if (!settled) {
        settled = true;
        reject(new Error(`CDP WebSocket 连接失败：target ${targetId}`));
      }
    });
    ws.addEventListener('close', () => {
      closed = true;
      failAll(new Error(`CDP 会话关闭（target ${targetId}）`));
      if (!settled) {
        settled = true;
        reject(new Error(`CDP WebSocket 在建立前关闭：target ${targetId}`));
      }
    });
  });
}

/**
 * 桌面 CDP 页面枢纽：枚举/定序/连接缓存/标签条就绪/console 尽早收集。
 * 定序约定（Shell 踩坑）：/json/list 顺序不代表创建顺序——每次标签操作后以
 * 「新出现的应用目标恰一个」锁定新目标，维护创建顺序列表。
 * @param {object} options
 * @param {number} options.cdpPort 调试端口
 * @param {string} [options.appPrefix] 应用标签 URL 前缀（`http://127.0.0.1:<port>/`）；
 *   服务端口来自就绪文件，调用方可在就绪后再赋值
 */
export function createDesktopPageHub({ cdpPort, appPrefix = '' }) {
  const conns = new Map();
  const hub = {
    cdpPort,
    appPrefix,
    /** 列出全部 page 目标（应用标签 + tabbar + 空壳） */
    async listPageTargets() {
      return (await fetchCdpTargets(cdpPort)).filter((t) => t.type === 'page');
    },
    /** 列出应用标签目标：按服务端口前缀过滤（appPrefix 未设置时返回空） */
    async listAppTargets() {
      if (!hub.appPrefix) return [];
      return filterAppTargets(hub.appPrefix, await fetchCdpTargets(cdpPort));
    },
    /** 列出标签条目标（file://…tabbar.html） */
    async listTabbarTargets() {
      return (await fetchCdpTargets(cdpPort))
        .filter((t) => t.type === 'page' && typeof t.url === 'string' && t.url.includes('tabbar.html'));
    },
    /** 等待应用目标数量达到 count（目标出现与就绪都要轮询） */
    async waitForAppTargets(count, timeoutMs = 15000) {
      return pollUntilAsync(async () => {
        const targets = await hub.listAppTargets();
        return targets.length >= count ? targets : null;
      }, timeoutMs, { intervalMs: 150, describe: `应用页面目标达到 ${count} 个` });
    },
    /** 操作一次后锁定唯一新增应用目标（「恰一个」约束，多于一个视为异常抛错） */
    async waitForNewAppTarget(knownIds, timeoutMs = 15000) {
      const known = new Set(knownIds);
      return pollUntilAsync(async () => {
        const fresh = (await hub.listAppTargets()).filter((t) => !known.has(t.id));
        return fresh.length === 1 ? fresh[0] : null;
      }, timeoutMs, { intervalMs: 150, describe: '新出现的应用页面目标恰一个' });
    },
    /** 取（并缓存）目标页会话；连接失败后移除缓存以便重试，断线会话自动重建 */
    pageFor(targetId, initialUrl = '') {
      const cached = conns.get(targetId);
      // 已建立后断线的会话（典型：跨源导航按站点隔离更换 renderer，页面级
      // WebSocket 随之关闭）必须重建——resolve 的 api 挂在 promise 的 apiRef
      // 属性上供同步检查 isClosed；否则调用方拿到的是永久求值失败的死会话，
      // 弹框免疫也随断线失效
      if (cached && cached.apiRef && cached.apiRef.isClosed) {
        conns.delete(targetId);
      }
      if (!conns.has(targetId)) {
        const promise = connectCdpPage(cdpPort, targetId, { initialUrl }).catch((err) => {
          conns.delete(targetId);
          throw err;
        });
        promise.apiRef = null;
        void promise.then((api) => { promise.apiRef = api; }, () => { /* 失败由调用方处理 */ });
        conns.set(targetId, promise);
      }
      return conns.get(targetId);
    },
    /**
     * 汇总全部已建立会话捕获到的弹框事件快照（含已断线会话的历史记录——
     * 跨源导航断开旧会话后，其崩溃窗口内的事件仍可被核对）。
     * 连接失败的会话跳过，不阻断调用方。
     */
    async dialogEvents() {
      const events = [];
      for (const promise of conns.values()) {
        try {
          events.push(...(await promise).dialogEvents());
        } catch {
          // 连接从未建立的会话无事件可收
        }
      }
      return events;
    },
    /** 等待标签条目标出现、脚本就绪且至少渲染 1 个标签，返回其会话 */
    async waitForTabbarReady(timeoutMs = 10000) {
      const target = await pollUntilAsync(async () => (await hub.listTabbarTargets())[0] || null, timeoutMs, {
        intervalMs: 150,
        describe: 'tabbar.html 目标出现'
      });
      const page = await hub.pageFor(target.id, target.url);
      await pollUntilAsync(
        () => page.evaluate('typeof window.gitLensTabbar === "object" && document.querySelectorAll(".tab").length >= 1'),
        timeoutMs,
        { intervalMs: 150, describe: '标签条脚本就绪并渲染出首个标签' }
      );
      return page;
    },
    /**
     * 后台尽早就挂后台收集：页面目标一出现（首次导航完成前）即连接挂载，
     * 尽量减少漏采首屏 CSP 违规。会话建立的同时也就位弹框免疫（桩 + 事件
     * 兜底内置在 connectCdpPage 初始化序列），收集器挂载越早，免疫的无保护
     * 窗口越小——这是把会话建立时机尽量提前的原因之一。
     */
    startConsoleWatch(registry, { intervalMs = 150 } = {}) {
      const watched = new Set();
      const timer = setInterval(() => {
        (async () => {
          for (const target of await hub.listPageTargets()) {
            if (watched.has(target.id)) continue;
            watched.add(target.id);
            try {
              if (registry) registry.attach(await hub.pageFor(target.id, target.url));
            } catch {
              // 目标可能在连接前销毁，移除标记以便后续目标重试
              watched.delete(target.id);
            }
          }
        })().catch(() => {});
      }, intervalMs);
      // 停止后必须让事件循环得以排空：定时器与 CDP 连接句柄不释放会挂住启动器进程
      hub.stopConsoleWatch = () => clearInterval(timer);
    },
    /** 断开全部会话、停掉后台收集（应用退出前后调用，均安全；整体 5s 兜底超时） */
    async dispose() {
      if (hub.stopConsoleWatch) hub.stopConsoleWatch();
      await Promise.race([
        Promise.all(Array.from(conns.values(), async (promise) => {
          try { (await promise).close(); } catch { /* 已随目标销毁 */ }
        })),
        sleep(5000)
      ]);
      conns.clear();
    }
  };
  return hub;
}

/**
 * 标签条 DOM 驱动：菜单加速键（⌘T/⌘W）CDP 触达不到，标签的新建/切换/关闭一律
 * 走标签条 chrome 页内的真实 DOM 点击（tabbar → IPC → 主进程完整链路）。
 * DOM 顺序即标签当前顺序（主进程按可重排的 tabs 数组顺序渲染）。
 * @param {object} page 标签条页会话（connectCdpPage 返回）
 */
export function createTabbarDriver(page) {
  return {
    /** 点击「+」新建标签（对应 ⌘T 语义） */
    clickNew: () => page.evaluate(() => { document.getElementById('new-tab').click(); }),
    /** 点击第 index 个标签（激活切换） */
    clickTab: (index) => page.evaluate((i) => { document.querySelectorAll('.tab')[i].click(); }, index),
    /** 点击第 index 个标签的「×」关闭（对应 ⌘W 语义） */
    clickClose: (index) => page.evaluate((i) => { document.querySelectorAll('.tab-close')[i].click(); }, index),
    /** 各标签标题（顺序与当前排列一致） */
    titles: () => page.evaluate(() => Array.from(document.querySelectorAll('.tab-title')).map((e) => e.textContent)),
    /** 激活标签下标（无激活项时为 -1；激活项带 .active 类） */
    activeIndex: () => page.evaluate(() => Array.from(document.querySelectorAll('.tab')).findIndex((e) => e.classList.contains('active'))),
    /** 标签总数 */
    count: () => page.evaluate(() => document.querySelectorAll('.tab').length)
  };
}

/**
 * 对全部应用标签视图设置缩放（多标签架构后 BrowserWindow.webContents 是空壳，
 * 缩放必须作用于各 WebContentsView 的 webContents）。
 */
export async function setAppZoom(app, appPrefix, factor) {
  await app.evaluate(({ webContents }, payload) => {
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed() && typeof wc.getURL() === 'string' && wc.getURL().startsWith(payload.prefix)) {
        wc.setZoomFactor(payload.factor);
      }
    }
  }, { prefix: appPrefix, factor });
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

/**
 * 通过 ps 查找仍存活的「本轮实例」Electron 进程（含全部辅助进程）。
 *
 * 匹配锚点为本轮实例的 userData 目录（mkdtemp 唯一）：主进程显式携带
 * --user-data-dir 启动参数时，Chromium 会把该开关传给全部辅助进程
 * （实测 Electron 44 / macOS：GPU/network/renderer helper 命令行均含
 * --user-data-dir=<目录>）。DEF-004 修复前按「worktree 根 + Electron.app 路径」
 * 匹配，范围是整个 worktree，会把用户手动试跑的同 worktree Electron 实例
 * 误判为本轮孤儿并强杀，故必须收窄到 userData 锚点。
 *
 * @param {object} scope 匹配范围（必填，缺失即抛错，防止回退到过宽匹配）
 * @param {string} scope.userDataDir 本轮实例 userData 目录。macOS 上 Chromium
 *   可能将其规范化（/tmp → /private/tmp），因此原始路径与 realpath 两种形态都参与匹配
 * @returns {Promise<string[]>} 命中的 ps 行（pid 为首字段）
 */
export async function findElectronProcesses({ userDataDir } = {}) {
  if (!userDataDir) {
    throw new Error('findElectronProcesses 必须传入 scope.userDataDir（收窄匹配范围，防止误杀同 worktree 无关实例）');
  }
  const anchors = new Set([`--user-data-dir=${userDataDir}`]);
  try {
    anchors.add(`--user-data-dir=${fsSync.realpathSync(userDataDir)}`);
  } catch {
    // 目录不存在时保留原始形态参与匹配即可
  }
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,command='], { maxBuffer: 4 * 1024 * 1024 });
    return stdout
      .split('\n')
      .filter((line) => line.includes('/node_modules/electron/dist/Electron.app/'))
      .filter((line) => [...anchors].some((anchor) => line.includes(anchor)))
      .map((line) => line.trim());
  } catch {
    return [];
  }
}

/** 孤儿稳定窗口扫描参数：间隔 250ms、连续 3 次数量持平（或归零）判定、上限 5 秒 */
export const ORPHAN_SCAN_INTERVAL_MS = 250;
export const ORPHAN_STABLE_CONFIRMATIONS = 3;
export const ORPHAN_WINDOW_TIMEOUT_MS = 5000;

/**
 * 以「稳定窗口」策略扫描孤儿进程（DEF-004）：主进程退出确认后，macOS 上辅助
 * 进程拆除滞后于主进程，立即扫描会把「正在退出」的 helper 误计为孤儿并强杀
 * （某轮误报孤儿=8，随后两轮同代码复跑孤儿=0，即拆除竞态而非泄漏）。改为轮询
 * 扫描：数量归零立即判定；数量仍在变化（升或降）说明拆除进行中，重置稳定计数；
 * 连续 stableConfirmations 次数量持平才判定收敛。超时兜底按当前扫描结果返回。
 * @param {() => Promise<string[]>} scan 单次扫描（findElectronProcesses 的调用形态）
 * @param {object} [options]
 * @param {number} [options.intervalMs] 扫描间隔
 * @param {number} [options.timeoutMs] 窗口上限
 * @param {number} [options.stableConfirmations] 判定收敛所需的连续持平扫描次数
 * @returns {Promise<{orphans: string[], stable: boolean, scans: number}>}
 *   orphans 为稳定窗口结束后的扫描结果；stable=false 表示超时截断（数量未收敛）
 */
export async function scanOrphansWithStableWindow(scan, {
  intervalMs = ORPHAN_SCAN_INTERVAL_MS,
  timeoutMs = ORPHAN_WINDOW_TIMEOUT_MS,
  stableConfirmations = ORPHAN_STABLE_CONFIRMATIONS
} = {}) {
  const startedAt = Date.now();
  let previous = null;
  let stableRuns = 0;
  let scans = 0;
  for (;;) {
    const current = await scan();
    scans += 1;
    if (current.length === 0) {
      return { orphans: current, stable: true, scans };
    }
    if (previous !== null && current.length === previous) {
      stableRuns += 1;
      if (stableRuns >= stableConfirmations) {
        return { orphans: current, stable: true, scans };
      }
    } else {
      // 数量上升（新 helper 出现）或下降（仍在拆除）都不算稳定
      stableRuns = 0;
    }
    previous = current.length;
    if (Date.now() - startedAt >= timeoutMs) {
      return { orphans: current, stable: false, scans };
    }
    await sleep(intervalMs);
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
 * 组装桌面应用启动参数（纯函数，供单测）：
 * - --remote-debugging-port=0：契约 §15 E2E 通道，port 0 = 内核自选，实际值从
 *   <userData>/DevToolsActivePort 读取；
 * - --user-data-dir：与 GIT_LENS_USER_DATA 同目录（main.js 的 setPath 为同值，行为不变）。
 *   必须显式放在浏览器命令行上：只有主进程携带该开关，Chromium 才会把它传给全部
 *   辅助进程（实测 Electron 44 / macOS），孤儿检查据此区分本轮实例与同 worktree
 *   其他 Electron 实例（DEF-004 匹配锚点）。
 * @param {object} env buildDesktopEnv 产出的环境
 * @returns {string[]} 启动参数数组
 */
export function buildDesktopLaunchArgs(env) {
  const args = [ELECTRON_MAIN, '--remote-debugging-port=0'];
  if (env && env.GIT_LENS_USER_DATA) {
    args.push(`--user-data-dir=${env.GIT_LENS_USER_DATA}`);
  }
  return args;
}

/**
 * 启动桌面应用：`_electron` 句柄仅用于 app 级操作（close()/evaluate 主进程/窗口数），
 * 应用页一律经 openDesktopChannel + hub 以 CDP 驱动（多标签架构，契约 §15）。
 * @param {object} options
 * @param {string} options.qaRoot
 * @param {string} options.runId
 * @param {object} [options.env] 预构环境（如带 suffix 的独立实例）；缺省按 qaRoot/runId 构建
 */
export async function startDesktopApp({ qaRoot, runId, env } = {}) {
  if (!fsSync.existsSync(ELECTRON_BIN)) {
    throw new Error(`未找到 Electron 可执行文件: ${ELECTRON_BIN}（请先 npm install 让 electron postinstall 下载二进制）`);
  }
  const resolvedEnv = env || buildDesktopEnv({ qaRoot, runId });
  const app = await _electron.launch({
    executablePath: ELECTRON_BIN,
    args: buildDesktopLaunchArgs(resolvedEnv),
    env: resolvedEnv,
    cwd: WORKTREE_ROOT,
    timeout: READY_TIMEOUT_MS
  });
  return { app, env: resolvedEnv };
}

/**
 * 启动一个与本轮 E2E 实例无关的 Electron 实例（DEF-004 回归自证用）：
 * 同 worktree 二进制、最小化应用（隐藏窗口加载 about:blank）、独立 mkdtemp userData。
 * 旧的孤儿匹配按「worktree 根 + Electron.app 路径」会把这类实例误判为本轮孤儿并
 * 强杀；修复后 i1 退出协议结束时它必须仍然存活（见 run-desktop 系列入口的 j2 场景）。
 * @param {object} options
 * @param {string} options.qaRoot 本轮 qa-root（最小应用与 mkdtemp userData 均建在其内，
 *   随 qaRoot 一起清理，不触碰真实用户目录）
 * @returns {Promise<{app: object, pid: number, userDataDir: string, kill: () => void}>}
 */
export async function createUnrelatedElectronInstance({ qaRoot } = {}) {
  if (!fsSync.existsSync(ELECTRON_BIN)) {
    throw new Error(`未找到 Electron 可执行文件: ${ELECTRON_BIN}`);
  }
  // 最小应用：package.json 不带 "type": "module"，main.js 按 CommonJS 运行
  const appDir = path.join(qaRoot, 'unrelated-app');
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(path.join(appDir, 'package.json'), `${JSON.stringify({ name: 'git-lens-qa-unrelated', main: 'main.js' }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(appDir, 'main.js'), [
    '// QA 无关实例（DEF-004 回归自证）：隐藏窗口加载 about:blank，不启动服务、不读写业务配置',
    "const { app, BrowserWindow } = require('electron');",
    'app.whenReady().then(() => {',
    '  const win = new BrowserWindow({ show: false });',
    "  win.loadURL('about:blank');",
    '});',
    ''
  ].join('\n'), 'utf8');
  // userData 用 mkdtemp 保证唯一：既与本轮实例隔离，也与其他轮次/手动实例隔离
  const userDataDir = await fs.mkdtemp(path.join(qaRoot, 'unrelated-ud-'));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'].includes(k))),
    // HOME/XDG 重定向到 fixture git-home，避免任何默认配置路径落到真实用户目录
    HOME: path.join(qaRoot, 'git-home'),
    XDG_CONFIG_HOME: path.join(qaRoot, 'git-home')
  };
  const app = await _electron.launch({
    executablePath: ELECTRON_BIN,
    args: [appDir, `--user-data-dir=${userDataDir}`],
    env,
    cwd: WORKTREE_ROOT,
    timeout: READY_TIMEOUT_MS
  });
  return {
    app,
    pid: app.process().pid,
    userDataDir,
    /** 强杀清理（测试实例，无需优雅退出） */
    kill() {
      try { app.process().kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  };
}

/**
 * 打开 CDP 页面通道：读调试端口 → 建 hub → 启动后台尽早就绪会话。
 * 无论是否传入 CSP registry，startConsoleWatch 都会启动——它同时承担弹框
 * 免疫的尽早就位（会话建立即挂桩 + 事件兜底），跳过会让页面目标在首次
 * 显式 pageFor 之前处于无保护窗口。应用目标枚举依赖服务端口，调用方在
 * 解析就绪文件后设置 `hub.appPrefix`。
 * @param {object} options
 * @param {object} options.env buildDesktopEnv 产出的环境（取 GIT_LENS_USER_DATA）
 * @param {object} [options.registry] CSP 收集注册表（传入即同时收集 CSP）
 * @param {number} [options.timeoutMs]
 */
export async function openDesktopChannel({ env, registry, timeoutMs = READY_TIMEOUT_MS } = {}) {
  const cdpPort = await waitForCdpPort(env.GIT_LENS_USER_DATA, timeoutMs);
  const hub = createDesktopPageHub({ cdpPort });
  hub.startConsoleWatch(registry);
  return hub;
}

/** 安装 CSP console 收集器：区分 Electron 未打包开发提醒与真实违规（entry 形态 {type,text}） */
export function attachCspCollector(page) {
  const realViolations = [];
  const electronDevWarnings = [];
  page.on('console', (entry) => {
    const text = entry?.text || '';
    if (!/Content Security Policy|Content-Security-Policy|\bCSP\b/i.test(text)) return;
    const record = { type: entry?.type || '', text: text.slice(0, 500) };
    if (/Electron Security Warning/i.test(text)) {
      electronDevWarnings.push(record);
    } else {
      realViolations.push(record);
    }
  });
  return {
    /** @returns {{ realViolationCount: number, realViolations: unknown[], electronDevWarningCount: number, electronDevWarnings: unknown[] }} */
    summarize() {
      return {
        realViolationCount: realViolations.length,
        realViolations,
        electronDevWarningCount: electronDevWarnings.length,
        electronDevWarnings
      };
    }
  };
}

/**
 * 多页面 CSP 收集注册表：应用标签、tabbar（file://，不在服务 CSP 响应头范围，
 * 仅作记录对照）与后续新建标签统一挂收集器，汇总真实违规与开发提醒计数。
 */
export function createCspRegistry() {
  const collectors = [];
  return {
    /** 为一个页面挂收集器（幂等性由调用方的目标集合保证） */
    attach(page) {
      collectors.push(attachCspCollector(page));
    },
    /** 汇总全部已挂页面 */
    summarize() {
      const realViolations = [];
      const electronDevWarnings = [];
      for (const collector of collectors) {
        const snap = collector.summarize();
        realViolations.push(...snap.realViolations);
        electronDevWarnings.push(...snap.electronDevWarnings);
      }
      return {
        realViolationCount: realViolations.length,
        realViolations,
        electronDevWarningCount: electronDevWarnings.length
      };
    }
  };
}

/**
 * 关闭应用并执行退出协议验证：服务退出、端口释放、主进程退出、孤儿强杀。
 * @param {object} options
 * @param {object} options.app playwright ElectronApp 句柄
 * @param {object} options.ready 就绪文件形态（port/servicePid/mainPid）
 * @param {number} [options.closeTimeoutMs] 服务退出与端口释放的等待上限
 * @param {string} options.userDataDir 本轮实例 userData 目录（孤儿匹配锚点，见 findElectronProcesses）
 */
export async function closeAndVerify({ app, ready, closeTimeoutMs = 15000, userDataDir }) {
  const closeStartedAt = Date.now();
  // app.close() 请求优雅退出；极端情况下优雅通道失效时强杀兜底，
  // 让退出协议验证继续进行（主进程退出项将如实反映优雅关闭失败）
  await Promise.race([
    app.close(),
    sleep(20000).then(() => {
      try { app.process().kill('SIGKILL'); } catch { /* 已退出 */ }
    })
  ]);
  const closeElapsed = Date.now() - closeStartedAt;
  const exit = await verifyAppExit({ ready, closeTimeoutMs, userDataDir });
  return { ...exit, closeElapsed, ok: exit.serviceGone && exit.portClosed && exit.mainGone && exit.orphanCount === 0 };
}

/**
 * 退出协议验证（不触发关闭；供 app.close() 与「关闭最后一个标签」两种退出路径共用）：
 * 服务退出、端口释放、主进程退出、孤儿强杀。
 * @param {object} options
 * @param {object} options.ready 就绪文件形态（port/servicePid/mainPid）
 * @param {number} [options.closeTimeoutMs] 服务退出与端口释放的等待上限
 * @param {number} [options.waitMainGoneMs] 先等待主进程退出的上限（外部触发退出的路径用）
 * @param {string} options.userDataDir 本轮实例 userData 目录（孤儿匹配锚点，见 findElectronProcesses）
 */
export async function verifyAppExit({ ready, closeTimeoutMs = 15000, waitMainGoneMs = 0, userDataDir }) {
  if (waitMainGoneMs > 0) {
    await pollUntil(() => !isPidAlive(ready.mainPid), waitMainGoneMs, {
      intervalMs: 250,
      describe: `主进程 ${ready.mainPid} 退出`
    }).catch(() => { /* 超时由下方 mainGone 断言兜底 */ });
  }
  const serviceGone = await pollUntil(() => !isPidAlive(ready.servicePid), closeTimeoutMs, {
    intervalMs: 250,
    describe: `服务进程 ${ready.servicePid} 退出`
  }).then(() => true).catch(() => false);
  const portClosed = await pollUntil(() => isPortClosed(ready.port), closeTimeoutMs, {
    intervalMs: 250,
    describe: `端口 ${ready.port} 释放`
  }).then(() => true).catch(() => false);
  const mainGone = !isPidAlive(ready.mainPid);
  // 主进程退出后 Electron 辅助进程应全部消失。DEF-004：拆除滞后于主进程退出是常态，
  // 必须经稳定窗口收敛后再判定（孤儿数 = 窗口结束后的数值），残留仍 SIGKILL 兜底防真泄漏
  const { orphans, stable } = await scanOrphansWithStableWindow(() => findElectronProcesses({ userDataDir }));
  for (const line of orphans) {
    const pid = Number(line.split(/\s+/)[0]);
    if (Number.isInteger(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
    }
  }
  if (orphans.length > 0) {
    console.error('[qa-desktop] 稳定窗口收敛后的残留 Electron 进程（已强杀）:', orphans.slice(0, 5));
  }
  return {
    serviceGone, portClosed, mainGone,
    orphanCount: orphans.length,
    orphanScanStable: stable
  };
}

/** 截图到 qa-root/artifacts（文件名含场景编号，G4 视觉基线起点）；page 为 CDP 页会话 */
export async function screenshotFile(page, qaRoot, scenarioId, name) {
  const file = path.join(qaRoot, 'artifacts', `g4-${scenarioId}-${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/**
 * 视觉基线截图：先轮询断言目标视图的 DOM 标记已出现，断言失败不出图（抛错）；
 * 通过后以 CDP 页截图捕获当前应用标签内容写入 artifacts。
 * 多标签架构后 BrowserWindow 的 capturePage 只能拍到空壳，视觉基线改为
 * 应用标签自身的 CDP 页截图（缩放内容随视口放大，不产生裁切）。
 * @param {object} page - 应用标签的 CDP 页会话
 * @param {string} qaRoot
 * @param {string} id 场景编号（入文件名）
 * @param {string} name 场景名（入文件名）
 * @param {(arg: null) => boolean} assertPageFn 页面内断言函数（page.evaluate 语义）
 */
export async function captureBaseline(page, qaRoot, id, name, assertPageFn) {
  const ok = await pollPage(page, assertPageFn, null, 12000);
  if (!ok) {
    throw new Error(`视觉基线截图 g4-${id}-${name} 的视图断言未通过，拒绝出图`);
  }
  const file = path.join(qaRoot, 'artifacts', `g4-${id}-${name}.png`);
  await page.screenshot({ path: file });
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
