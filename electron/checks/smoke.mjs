/**
 * Git Lens Web 桌面壳冒烟自验脚本。
 *
 * 以完全受控的临时环境启动完整 Electron 应用（userData/就绪文件/测试模式
 * 全部指向 mkdtemp 临时目录，不触碰 9527 主实例与真实配置），逐项断言：
 *  1. E2E 就绪文件出现且端口 ≠ 9527（契约 §13）；
 *  2. 无凭据请求 /api/projects 被拒 403，带凭据返回 200（契约 §4.6）；
 *  3. /api/test-handshake 握手与 runId/servicePid 一致（契约 §3）；
 *  4. 服务进程被强杀后：就绪文件并入 state:"crashed" → 自动重启 → 新 servicePid 恢复服务；
 *  5. 二次启动（同 userData）被单实例锁拦截并退出，原实例不受影响；
 *  6. 主进程收到 SIGTERM 退出后：服务进程随之退出、端口释放；
 *  7. 主进程被 SIGKILL 强杀后：服务进程仍能自退出（防孤儿兜底）、端口释放；
 *  8. 多标签（契约 §15，场景三）：经 CDP 驱动真实标签条 UI 完成新建/切换/关闭，
 *     覆盖标题同步、sessionStorage 标签间隔离、凭据覆盖全部视图、
 *     关闭最后一个标签触发窗口退出协议与无孤儿校验；
 *  9. 配置互通解析（契约 §5 第三次修订，场景四）：解析纯函数注入断言三条规则
 *    （规则 2 真实用户场景无法整进程安全验证，以 home 注入 + 默认组装字符串断言
 *    代替，不触碰真实 ~/.config）、主进程委托共享实现的代码走查、以及
 *    「显式 GIT_LENS_CONFIG_DIR」「仅 GIT_LENS_USER_DATA」两条端到端链路的
 *    握手 configDir 落点与 config.json 不越界校验；
 * 10. 跨启动标签恢复（契约 §15 第二次修订，场景五）：同一 userData 三轮启动，
 *    覆盖预写扫描目录发现 fixture、运行期防抖落盘、退出同步落盘（仅查询串）、
 *    二轮自动恢复（顺序/激活项一致、查询串重放到新端口、页面数据最新）、
 *    服务崩溃重启不破坏恢复态、存档损坏按无存档容错回落单标签首页；
 * 11. 剪贴板真实写入（契约 §17.2 / DEF-007，场景五内）：经 CDP Input 真实鼠标
 *    点击 inspect 视图 worktree「复制」按钮（合成 click 无用户激活会被 Chromium
 *    在权限层直接拒绝）→ 断言按钮「已复制!」反馈仅在写入成功后出现 →
 *    经主进程 inspector（--inspect=0，无 Playwright electronApp 句柄时的等价
 *    evaluate 通道）读取 clipboard.readText() 断言与被复制文本一致；
 * 12. 窗口 chrome 融合（契约 §17/§17.1，场景六）：主进程与脚本 import 同一份
 *    window-chrome.js 纯函数逐字段断言 darwin/非 darwin 窗口选项，源码走查
 *    标签条拖拽区/平台安全区/平台 query 注入/恢复页 drag 区/全屏吸附 CSS/
 *    §17.1 快捷键菜单 id；场景三内另有标签条平台注入运行期断言与 CDP 截图落盘
 *    （固定 /tmp/glwt-smoke-tabbar.png，供协调者视觉审阅）。
 * 13. 全屏吸附与标签快捷键菜单（契约 §17.1.1/§17.1 第四次修订/§17.1.2，场景三内）：
 *    经主进程 inspector 驱动 BrowserWindow.setFullScreen 往返，轮询标签条
 *    body.fullscreen 类与 #bar 计算左内边距变化（78px↔0px）；运行期断言
 *    switch-tab-0..9 十项 id/加速键齐全、prev/next-tab-cmd-arrow 已移除、
 *    全菜单加速键无重复（⌘0 归属第 10 个标签，「实际大小」改绑 ⇧⌘0）。
 *
 * 运行：node electron/checks/smoke.mjs
 * 纯 GUI 项（菜单、原生对话框、窗口状态恢复的视觉表现）无法自动化，
 * 以文末「人工验证清单」输出。
 */

import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 场景四复用主进程同一份配置解析纯函数（契约 §5 第三次修订），注入参数断言三条规则
import { resolveServiceConfigDir } from '../service-config-dir.js';
// 场景六复用主进程同一份窗口 chrome 选项纯函数（契约 §17），逐字段断言防实现漂移
import { windowChromeOptions, TABBAR_HEIGHT_DIP } from '../window-chrome.js';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainJsPath = path.resolve(__dirname, '../main.js');
const mainJsSource = () => fs.readFileSync(mainJsPath, 'utf-8');
const projectRoot = path.resolve(__dirname, '../..');

/** Electron 可执行文件路径（npm 包在非 Electron 环境导出二进制路径字符串） */
let electronBinary;
try {
  electronBinary = require('electron');
} catch {
  electronBinary = null;
}

// ---- 断言记录 ----

const results = [];

/**
 * 记录并打印一条断言结果。
 * @param {string} name - 断言描述
 * @param {boolean} ok - 是否通过
 * @param {string} [detail] - 附加信息
 */
function assert(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * 带超时的轮询等待。
 * @param {() => Promise<any>} probe - 每次轮询执行，返回非 undefined/null 即成功
 * @param {number} timeoutMs - 总超时
 * @param {number} [intervalMs] - 轮询间隔
 */
async function waitFor(probe, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null) return value;
    } catch {
      // 轮询期间错误视为尚未就绪
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

/**
 * 读取并解析就绪文件；不存在或损坏时返回 null。
 * @param {string} filePath - 就绪文件路径
 */
function readReadyFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 环回 HTTP GET。
 * @param {number} port - 目标端口
 * @param {string} pathname - 请求路径
 * @param {Record<string, string>} [headers] - 附加请求头
 */
async function httpGet(port, pathname, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  return response;
}

// ---- 应用进程管理 ----

/**
 * 组装受控环境变量：userData/就绪文件/token 文件全部指向本轮临时目录，
 * Git 全局配置与 XDG 目录同样隔离，绝不触碰真实用户配置。
 * @param {{root: string, readyFile: string, tokenFile: string, runId: string}} ctx
 * @param {Record<string, string>} [extraEnv] - 额外环境变量覆盖（如场景四的
 *   GIT_LENS_CONFIG_DIR），置于最后保证优先生效
 */
function buildAppEnv(ctx, extraEnv = {}) {
  return {
    ...process.env,
    GIT_LENS_USER_DATA: path.join(ctx.root, 'user-data'),
    GIT_LENS_E2E_READY_FILE: ctx.readyFile,
    GIT_LENS_E2E_TOKEN_FILE: ctx.tokenFile,
    GIT_LENS_TEST_MODE: '1',
    GIT_LENS_TEST_RUN_ID: ctx.runId,
    GIT_CONFIG_GLOBAL: path.join(ctx.root, 'gitconfig'),
    XDG_CONFIG_HOME: path.join(ctx.root, 'xdg-config'),
    ...extraEnv,
  };
}

/**
 * 启动一个 Electron 应用进程并收集其输出。
 * @param {{root: string, readyFile: string, tokenFile: string, runId: string}} ctx
 * @param {string} label - 日志标签
 * @param {string[]} [extraArgs] - 附加命令行参数（如 CDP 调试开关）
 * @param {Record<string, string>} [extraEnv] - 附加环境变量覆盖（透传 buildAppEnv）
 * @returns {{child: import('node:child_process').ChildProcess, tail: () => string}}
 */
function launchApp(ctx, label, extraArgs = [], extraEnv = {}) {
  const child = spawn(electronBinary, [mainJsPath, ...extraArgs], {
    env: buildAppEnv(ctx, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  const collect = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) lines.push(`[${label}] ${line}`);
    }
    if (lines.length > 400) lines.splice(0, lines.length - 400);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return { child, tail: () => lines.join('\n') };
}

/**
 * 等待进程退出，超时返回 null（不杀进程，由调用方决定）。
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 */
function waitExit(child, timeoutMs) {
  // 进程可能在挂监听前就已退出，先查已缓存的结果
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

// ---- 场景一：主实例全链路 ----

/**
 * 启动主实例并执行：就绪文件、凭据边界、握手、崩溃恢复、单实例、优雅退出。
 * @param {{root: string, readyFile: string, tokenFile: string, runId: string}} ctx
 */
async function runPrimaryInstance(ctx) {
  const app = launchApp(ctx, 'app');

  // 1. 就绪文件出现且端口 ≠ 9527（契约 §13 + QA 守卫要求）
  const ready = await waitFor(() => {
    const data = readReadyFile(ctx.readyFile);
    return data && Number.isInteger(data.port) && Number.isInteger(data.servicePid) ? data : null;
  }, 30000);
  assert('E2E 就绪文件在 30s 内出现且字段完整', Boolean(ready), ready ? JSON.stringify(ready) : '超时未出现，应用输出：\n' + app.tail());
  if (!ready) {
    // 拿不到就绪文件，后续用例全部无法执行
    app.child.kill('SIGKILL');
    return;
  }
  assert('服务端口 ≠ 9527（不触碰主实例）', ready.port !== 9527, `port=${ready.port}`);
  assert('服务为独立进程（servicePid ≠ mainPid）', ready.servicePid !== ready.mainPid, `servicePid=${ready.servicePid} mainPid=${ready.mainPid}`);
  assert('就绪文件 runId 与注入值一致', ready.runId === ctx.runId, `runId=${ready.runId}`);

  // 2. 会话凭据边界
  await waitFor(async () => (await httpGet(ready.port, '/api/projects')).status !== 0, 10000);
  const noToken = await httpGet(ready.port, '/api/projects');
  assert('无凭据请求 /api/projects 被 403 拒绝', noToken.status === 403, `status=${noToken.status}`);

  let token = null;
  await waitFor(() => {
    try {
      token = fs.readFileSync(ctx.tokenFile, 'utf-8').trim();
      return token ? token : null;
    } catch {
      return null;
    }
  }, 10000);
  assert('E2E 凭据文件已写出（提议钩子）', Boolean(token), token ? `${token.slice(0, 8)}…` : '超时未出现');

  const withToken = await httpGet(ready.port, '/api/projects', { 'X-Git-Lens-Session': token || '' });
  const withTokenBody = withToken.ok ? await withToken.json() : null;
  assert('带凭据请求 /api/projects 返回 200', withToken.status === 200 && withTokenBody?.ok === true, `status=${withToken.status}`);

  const badToken = await httpGet(ready.port, '/api/projects', { 'X-Git-Lens-Session': 'wrong-token' });
  assert('错误凭据请求被 403 拒绝', badToken.status === 403, `status=${badToken.status}`);

  // 3. 测试握手（契约 §3：runId、configDir、pid 三方一致）
  // 服务回报的 configDir 经 realpath 规范化（macOS 上 /var → /private/var），
  // 本脚本根目录同样先做 realpath 再比较
  const rootReal = fs.realpathSync(ctx.root);
  const handshakeResponse = await httpGet(ready.port, '/api/test-handshake', { 'X-Git-Lens-Session': token || '' });
  const handshake = handshakeResponse.ok ? await handshakeResponse.json() : null;
  const handshakeOk = handshake?.ok === true
    && handshake?.runId === ctx.runId
    && handshake?.pid === ready.servicePid
    && typeof handshake?.configDir === 'string'
    && handshake.configDir.startsWith(rootReal);
  assert('test-handshake 握手 runId/pid/configDir 三方一致', handshakeOk, handshake ? JSON.stringify(handshake) : `status=${handshakeResponse.status}`);

  // 4. 服务崩溃 → state:"crashed" 落盘 → 自动重启 → 服务恢复
  const oldServicePid = ready.servicePid;
  try {
    process.kill(oldServicePid, 'SIGKILL');
  } catch {
    // 服务进程意外已死也继续走恢复断言
  }
  const crashedState = await waitFor(() => {
    const data = readReadyFile(ctx.readyFile);
    return data && data.state === 'crashed' ? data : null;
  }, 8000);
  assert('服务被强杀后就绪文件并入 state:"crashed"', Boolean(crashedState), crashedState ? '已捕获 crashed 快照' : '8s 内未观察到 crashed 状态');

  const recovered = await waitFor(() => {
    const data = readReadyFile(ctx.readyFile);
    return data && !data.state && Number.isInteger(data.servicePid) && data.servicePid !== oldServicePid ? data : null;
  }, 20000);
  assert('服务在 20s 内自动重启且 servicePid 更新', Boolean(recovered), recovered ? `新 servicePid=${recovered.servicePid} 新 port=${recovered.port}` : '超时');

  const afterRecovery = await httpGet(recovered ? recovered.port : ready.port, '/api/projects', { 'X-Git-Lens-Session': token || '' });
  assert('重启后的服务可正常响应 200', afterRecovery.status === 200, `status=${afterRecovery.status}`);

  // 5. 二次启动：单实例锁拦截，原实例不受影响
  const second = launchApp(ctx, 'second');
  const secondExit = await waitExit(second.child, 15000);
  assert('二次启动进程被单实例锁拦截并在 15s 内退出', secondExit !== null && secondExit.code === 0, secondExit ? `code=${secondExit.code} signal=${secondExit.signal}` : '超时未退出\n' + second.tail());
  const stillServing = await httpGet((recovered || ready).port, '/api/projects', { 'X-Git-Lens-Session': token || '' });
  assert('二次启动被拦截后原实例仍正常服务', stillServing.status === 200, `status=${stillServing.status}`);

  // 6. 优雅退出：主进程 SIGTERM → 服务随之退出 → 端口释放
  const servicePidBeforeQuit = (recovered || ready).servicePid;
  app.child.kill('SIGTERM');
  const appExit = await waitExit(app.child, 15000);
  assert('主进程在 SIGTERM 后 15s 内退出', appExit !== null, appExit ? `code=${appExit.code} signal=${appExit.signal}` : '超时\n' + app.tail());

  const serviceGone = await waitFor(() => {
    try {
      process.kill(servicePidBeforeQuit, 0);
      return false;
    } catch (err) {
      return err.code === 'ESRCH' ? true : null;
    }
  }, 10000);
  assert('主进程退出后服务进程随之退出（无孤儿）', serviceGone === true, serviceGone ? `servicePid=${servicePidBeforeQuit} 已退出` : '服务进程仍存活');

  const portFreed = await waitFor(async () => {
    try {
      await httpGet((recovered || ready).port, '/api/projects');
      return false;
    } catch {
      return true;
    }
  }, 8000);
  assert('服务端口已释放（连接被拒绝）', portFreed === true, `port=${(recovered || ready).port}`);

  return { lastPort: (recovered || ready).port };
}

// ---- 场景二：主进程被强杀后的孤儿防护 ----

/**
 * 再次启动应用（独立临时根目录，避免读到上一轮的就绪文件），
 * SIGKILL 主进程，验证服务进程自退出、端口释放。
 */
async function runHardKillOrphanCheck(ctx) {
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'glwt-smoke-hard-'));
  const ctx2 = {
    root: root2,
    readyFile: path.join(root2, 'ready.json'),
    tokenFile: path.join(root2, 'token.txt'),
    runId: `${ctx.runId}-hard`,
  };
  await fsp.mkdir(path.join(root2, 'user-data'), { recursive: true });
  await fsp.mkdir(path.join(root2, 'xdg-config'), { recursive: true });

  const app = launchApp(ctx2, 'app2');
  const ready = await waitFor(() => {
    const data = readReadyFile(ctx2.readyFile);
    return data && Number.isInteger(data.port) && Number.isInteger(data.servicePid) ? data : null;
  }, 30000);
  if (!ready) {
    assert('强杀场景：应用能再次正常启动', false, '就绪文件超时\n' + app.tail());
    return;
  }
  assert('强杀场景：应用能再次正常启动', true, `port=${ready.port} servicePid=${ready.servicePid}`);

  // 先确认服务确实存活，保证后续"自退出"断言不是空洞通过
  const serviceWasAlive = await waitFor(() => {
    try {
      process.kill(ready.servicePid, 0);
      return true;
    } catch {
      return null;
    }
  }, 5000);
  assert('强杀场景：服务进程在主进程被杀前存活', serviceWasAlive === true, `servicePid=${ready.servicePid}`);

  app.child.kill('SIGKILL');
  const appExit = await waitExit(app.child, 10000);
  assert('强杀场景：主进程被 SIGKILL 后立即退出', appExit !== null && appExit.signal === 'SIGKILL', appExit ? `code=${appExit.code} signal=${appExit.signal}` : '超时');

  const serviceGone = await waitFor(() => {
    try {
      process.kill(ready.servicePid, 0);
      return false;
    } catch (err) {
      return err.code === 'ESRCH' ? true : null;
    }
  }, 10000);
  assert('强杀场景：服务进程自退出（孤儿防护兜底生效）', serviceGone === true, serviceGone ? `servicePid=${ready.servicePid} 已退出` : `服务进程 ${ready.servicePid} 仍存活`);

  const portFreed = await waitFor(async () => {
    try {
      await httpGet(ready.port, '/api/projects');
      return false;
    } catch {
      return true;
    }
  }, 8000);
  assert('强杀场景：端口已释放', portFreed === true, `port=${ready.port}`);

  try {
    await fsp.rm(root2, { recursive: true, force: true });
  } catch {
    console.log(`强杀场景临时目录保留：${root2}`);
  }
}

// ---- 场景三：多标签生命周期（契约 §15，CDP 驱动真实 tabbar UI） ----

/**
 * 读取 DevToolsActivePort 文件首行的调试端口（契约 §15 E2E 通道）。
 * @param {string} userDataDir - 应用 userData 目录
 */
function readDevToolsPort(userDataDir) {
  try {
    const raw = fs.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf-8');
    const port = Number.parseInt(raw.split('\n')[0], 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * 拉取 CDP 目标列表（/json/list）。
 * @param {number} cdpPort - 调试端口
 */
async function fetchCdpTargets(cdpPort) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`json/list 返回 ${response.status}`);
  return response.json();
}

/**
 * 建立到指定 DevTools WebSocket 地址的 CDP 会话（Node 内置 WebSocket），
 * 封装 Runtime.evaluate（returnByValue + awaitPromise）、任意域命令发送
 * 与事件订阅（对话框免疫等场景使用）。应用页面目标与主进程 inspector
 * （--inspect 端口暴露同一套协议）共用本核心。
 * @param {string} wsUrl - 完整 ws:// 连接地址
 */
function connectDevtoolsWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const listeners = new Map();
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.onopen = () => resolve({
      /** 在目标页面内求值 JS 表达式并回传结果值 */
      evaluate: async (expression) => {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result && result.exceptionDetails) {
          throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        }
        return result && result.result ? result.result.value : undefined;
      },
      /** 发送任意 CDP 命令并回传结果 */
      send: (method, params = {}) => send(method, params),
      /** 订阅 CDP 事件（如 Page.javascriptDialogOpening） */
      on: (method, handler) => {
        if (!listeners.has(method)) listeners.set(method, new Set());
        listeners.get(method).add(handler);
      },
      close: () => ws.close(),
    });
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rej(new Error(message.error.message));
        else res(message.result);
      } else if (message.method && listeners.has(message.method)) {
        for (const handler of listeners.get(message.method)) handler(message.params || {});
      }
    };
    ws.onerror = () => reject(new Error(`CDP WebSocket 连接失败：${wsUrl}`));
  });
}

/**
 * 建立到指定页面目标的 CDP WebSocket 连接。
 * @param {number} cdpPort - 调试端口
 * @param {string} targetId - 页面目标 id
 */
function connectCdpPage(cdpPort, targetId) {
  return connectDevtoolsWs(`ws://127.0.0.1:${cdpPort}/devtools/page/${targetId}`);
}

/**
 * 主进程内读取剪贴板的表达式（契约 §17.2 验收「主进程 clipboard.readText()」）。
 * inspector 全局作用域没有 require（它是模块内变量），经 process.mainModule
 * 兜底取主模块的 require；主进程与页面同进程读取的是同一份系统剪贴板。
 */
const MAIN_CLIPBOARD_READ_EXPR = '(function () { var req = (typeof require === "function") ? require : process.mainModule.require; return req("electron").clipboard.readText(); })()';

/**
 * 主进程内驱动主窗口全屏往返的表达式（契约 §17.1.1 的 smoke 驱动通道）。
 * setFullScreen 为异步过渡，调用后由调用方在标签条 DOM 上轮询等待生效。
 * @param {boolean} on - true=进入全屏，false=退出全屏
 */
const mainSetFullScreenExpr = (on) => `(function () {
  var req = (typeof require === "function") ? require : process.mainModule.require;
  var win = req("electron").BrowserWindow.getAllWindows()[0];
  if (!win) return false;
  win.setFullScreen(${on ? 'true' : 'false'});
  return true;
})()`;

/**
 * 主进程内采集应用菜单快捷键快照的表达式（契约 §17.1 第四次修订/§17.1.2 的
 * 运行期断言通道）。MenuItem.accelerator 为字符串基元，String() 直接还原
 * 加速键原文；getMenuItemById 对不存在的 id 返回 null。
 */
const MENU_SNAPSHOT_EXPR = `(function () {
  var req = (typeof require === "function") ? require : process.mainModule.require;
  var menu = req("electron").Menu.getApplicationMenu();
  if (!menu) return null;
  var ids = [];
  for (var n = 1; n <= 9; n++) ids.push('switch-tab-' + n);
  ids.push('switch-tab-0');
  var snapshot = { switchTabs: {}, arrows: { prev: false, next: false }, duplicates: [] };
  ids.forEach(function (id) {
    var item = menu.getMenuItemById(id);
    snapshot.switchTabs[id] = item && item.accelerator ? String(item.accelerator) : null;
  });
  snapshot.arrows.prev = Boolean(menu.getMenuItemById('prev-tab-cmd-arrow'));
  snapshot.arrows.next = Boolean(menu.getMenuItemById('next-tab-cmd-arrow'));
  // 全菜单可见项加速键唯一性：同一加速键被两项注册时原生菜单只响应先注册者，
  // 另一项会静默失效（⌘0 归属冲突曾为此类隐患，此断言防回归）
  var seen = {};
  (function walk(items) {
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.submenu) { walk(item.submenu.items); continue; }
      if (item.accelerator) {
        var key = String(item.accelerator);
        if (seen[key]) snapshot.duplicates.push(key);
        else seen[key] = true;
      }
    }
  })(menu.items);
  return snapshot;
})()`;

/**
 * 等待主进程 inspector 监听并返回其 DevTools WebSocket 地址。
 * Electron 对 --inspect=0 的处理与 Node 一致（随机端口 + 监听行打到输出），
 * 据此解析地址，避免预选固定端口的占用竞态。
 * @param {{tail: () => string}} app - launchApp 返回的输出收集器
 * @param {number} [timeoutMs] - 总超时
 * @returns {Promise<string|null>} ws:// 地址；超时返回 null
 */
function waitMainInspectorUrl(app, timeoutMs = 15000) {
  return waitFor(() => {
    const match = app.tail().match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+)/);
    return match ? match[1] : null;
  }, timeoutMs, 200);
}

/**
 * 让页面会话对阻塞式对话框免疫（双机制）：
 *  1) 订阅 Page.javascriptDialogOpening，弹框出现即自动 accept——对「已加载
 *     文档」上弹出的 alert/confirm/prompt 立即生效；
 *  2) Page.addScriptToEvaluateOnNewDocument 预置 window.alert/confirm/prompt
 *     桩，让后续新文档从源头不弹框。
 * 背景（契约 §15 第二次修订交付后 QA 发现）：kill 服务瞬间页面在途请求失败
 * 会触发页面自身的阻塞式 alert（inspect 失败路径），挂起渲染层全部 JS，
 * 恢复遮罩/自动重载/断言全部冻结。测试必须不被人肉弹框阻塞；页面侧的产品
 * 修复由 UI 工作流另行处理（public/**，不在 Shell 范围）。
 * 注意：机制 1 依赖会话存活，调用方须让连接覆盖可能弹框的窗口期。
 * @param {{send: Function, on: Function}} conn - connectCdpPage 建立的页面会话
 */
async function armDialogImmunity(conn) {
  conn.on('Page.javascriptDialogOpening', () => {
    void conn.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {
      // 对话框可能已被同会话其他机制处理，忽略
    });
  });
  await conn.send('Page.enable');
  await conn.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.alert = function () {}; window.confirm = function () { return false; }; window.prompt = function () { return null; };',
  });
}

/**
 * 场景三：多标签（契约 §15）。
 *
 * 编程手段说明：Playwright `_electron` 不把 WebContentsView 暴露为 page，
 * 按契约 §15 的 E2E 通道以 `--remote-debugging-port=0` 启动，从
 * `<userData>/DevToolsActivePort` 读取调试端口，用内置 WebSocket 直连 CDP。
 * 标签的新建/切换/关闭均在「标签条 chrome 视图」内执行真实 DOM 点击
 * （+/×/标签项），走 tabbar → IPC → 主进程完整链路；标签内容断言则在
 * 对应应用视图内 evaluate 完成。
 * @param {{runId: string}} baseCtx - 复用主场景的 runId 前缀
 */
async function runMultiTabCheck(baseCtx) {
  const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'glwt-smoke-tabs-'));
  const ctx = {
    root: root3,
    readyFile: path.join(root3, 'ready.json'),
    tokenFile: path.join(root3, 'token.txt'),
    runId: `${baseCtx.runId}-tabs`,
  };
  await fsp.mkdir(path.join(ctx.root, 'user-data'), { recursive: true });
  await fsp.mkdir(path.join(ctx.root, 'xdg-config'), { recursive: true });
  const userDataDir = path.join(ctx.root, 'user-data');

  // 标题断言依赖「仓库感知终态」（与 QA m2 同款判别），须先给标签制造仓库上下文：
  // 预置一个最小 fixture 仓库。仅 GIT_LENS_USER_DATA 时服务配置目录按规则 3 落在
  // <userData>/git-lens-config（场景四已验证该解析），启动前预写扫描目录，
  // 页面仓库下拉即有项可选
  const fixturePath = createFixtureRepo(path.join(root3, 'fixtures'), 'fixture-smoke');
  const serviceConfigDir = path.join(userDataDir, 'git-lens-config');
  await fsp.mkdir(serviceConfigDir, { recursive: true });
  await fsp.writeFile(
    path.join(serviceConfigDir, 'config.json'),
    `${JSON.stringify({ customDirectories: [fixturePath] }, null, 2)}\n`,
    'utf-8',
  );

  // --inspect=0 为菜单运行期断言与全屏吸附驱动开主进程 inspector 通道
  // （等价 evaluate：契约 §17.1/§17.1.1 均要求驱动或读取主进程对象）
  const app = launchApp(ctx, 'tabs', ['--remote-debugging-port=0', '--inspect=0']);

  // 1. 就绪文件出现（由首个内容视图的首次加载触发，契约 §13 + §15）
  const ready = await waitFor(() => {
    const data = readReadyFile(ctx.readyFile);
    return data && Number.isInteger(data.port) && Number.isInteger(data.servicePid) ? data : null;
  }, 30000);
  assert('多标签场景：E2E 就绪文件在 30s 内出现（首个内容视图首次加载触发）', Boolean(ready), ready ? `port=${ready.port}` : '超时未出现，应用输出：\n' + app.tail());
  if (!ready) {
    app.child.kill('SIGKILL');
    return;
  }

  // 2. CDP 调试通道就绪
  const cdpPort = await waitFor(() => readDevToolsPort(userDataDir), 10000);
  assert('多标签场景：DevToolsActivePort 调试端口就绪（--remote-debugging-port=0）', Boolean(cdpPort), `cdpPort=${cdpPort}`);
  if (!cdpPort) {
    app.child.kill('SIGKILL');
    return;
  }

  const appPrefix = `http://127.0.0.1:${ready.port}`;
  const appTargetsOf = (list) => list.filter((item) => item.type === 'page' && item.url.startsWith(appPrefix));

  // 3. 启动后恰好 1 个应用页面目标（首个内容标签），且标签条 chrome 已加载
  const initial = await waitFor(async () => {
    const list = await fetchCdpTargets(cdpPort);
    return appTargetsOf(list).length === 1 ? list : null;
  }, 15000);
  assert('多标签场景：启动后恰好 1 个应用页面目标（首个内容标签，同端口）', Boolean(initial), initial ? appTargetsOf(initial).map((t) => t.url).join(', ') : '15s 内未就绪');
  if (!initial) {
    app.child.kill('SIGKILL');
    return;
  }
  // 目标出现次序即创建次序（后续新目标依次追加）
  const creationOrder = appTargetsOf(initial).map((item) => item.id);

  const tabbarTarget = (await fetchCdpTargets(cdpPort)).find((item) => item.type === 'page' && item.url.includes('tabbar.html'));
  assert('多标签场景：标签条 chrome 视图已加载（tabbar.html 目标存在）', Boolean(tabbarTarget), tabbarTarget ? tabbarTarget.url.slice(0, 80) : '未找到 tabbar 目标');
  if (!tabbarTarget) {
    app.child.kill('SIGKILL');
    return;
  }
  const tabbar = await connectCdpPage(cdpPort, tabbarTarget.id);

  // 等标签条脚本就绪并渲染出首个标签
  await waitFor(async () => {
    const ok = await tabbar.evaluate('(function () { return (typeof window.gitLensTabbar === "object" && document.querySelectorAll(".tab").length >= 1) ? true : null; })()');
    return ok === true ? true : null;
  }, 10000);

  /** 标签条 DOM 操作（真实 UI 点击路径） */
  const tabbarDom = {
    clickNew: () => tabbar.evaluate('document.getElementById("new-tab").click()'),
    clickClose: (index) => tabbar.evaluate(`document.querySelectorAll(".tab-close")[${index}].click()`),
    clickTab: (index) => tabbar.evaluate(`document.querySelectorAll(".tab")[${index}].click()`),
    titles: () => tabbar.evaluate('Array.from(document.querySelectorAll(".tab-title")).map(function (e) { return e.textContent; })'),
    activeIndex: () => tabbar.evaluate('Array.from(document.querySelectorAll(".tab")).findIndex(function (e) { return e.classList.contains("active"); })'),
  };

  /** 等待应用页加载出仓库选项（下拉列表已渲染 ≥1 项，场景三仅预置 1 个 fixture） */
  const waitForRepoOptions = (conn) => waitFor(async () => {
    const count = await conn.evaluate('document.querySelectorAll("#repoDropdownList .repo-item").length');
    return count >= 1 ? count : null;
  }, 15000);

  /** 在应用页内经真实仓库下拉（#repoTrigger + .repo-item 点击）切换到指定仓库 */
  const selectRepoViaUi = (conn, repoPath) => conn.evaluate(`(function () {
    var trigger = document.getElementById('repoTrigger');
    if (!trigger) { return false; }
    trigger.click();
    var items = document.querySelectorAll('#repoDropdownList .repo-item');
    for (var i = 0; i < items.length; i++) {
      if (items[i].dataset.repoPath === ${JSON.stringify(repoPath)}) { items[i].click(); return true; }
    }
    return false;
  })()`);

  // 4. 经「+」逐个新建标签，每建一个就发现新目标——保证 creationOrder 与
  //    创建顺序严格一致（/json/list 的数组顺序不保证反映创建顺序）
  for (let expected = 2; expected <= 3; expected += 1) {
    await tabbarDom.clickNew();
    const reached = await waitFor(async () => {
      const list = await fetchCdpTargets(cdpPort);
      for (const item of appTargetsOf(list)) {
        if (!creationOrder.includes(item.id)) creationOrder.push(item.id);
      }
      return creationOrder.length === expected ? true : null;
    }, 15000);
    if (reached !== true) break;
  }
  assert('多标签场景：经标签条「+」新建 2 个标签后共 3 个应用页面目标（同一端口）', creationOrder.length === 3, `创建次序=${creationOrder.join(' → ')}`);
  if (creationOrder.length !== 3) {
    app.child.kill('SIGKILL');
    return;
  }

  const conns = new Map();
  for (const id of creationOrder) {
    conns.set(id, await connectCdpPage(cdpPort, id));
  }

  // 5. 标题按 page title 更新并同步到标签条。终态判别与 QA m2 同款（仓库感知）：
  //    首屏 HTML 的通用初始标题「Git Lens · 本地仓库透镜与代码 Diff 审计」同样含
  //    "Git Lens"，仅 includes 判别会让轮询被瞬间满足——页面 title 的终态事件稍后
  //    才经 page-title-updated → IPC 到标签条，两侧快照可能失配。故页面与标签条
  //    两侧都等 `<仓库> · <视图> | Git Lens` 形态后再取快照。
  //    前提对齐 QA m1/m2：3 个标签先各经页面下拉切到 fixture 仓库（选择失败由
  //    下方终态等待超时与断言 detail 兜底暴露，不单列断言）
  const isSettledTitle = (title) => typeof title === 'string'
    && title.endsWith('| Git Lens') && !title.startsWith('Git Lens ·');
  for (const id of creationOrder) {
    const conn = conns.get(id);
    await waitForRepoOptions(conn);
    await selectRepoViaUi(conn, fixturePath);
    await waitFor(async () => {
      const title = await conn.evaluate('document.title');
      return isSettledTitle(title) ? title : null;
    }, 15000);
  }
  const pageTitles = [];
  for (const id of creationOrder) {
    pageTitles.push(await conns.get(id).evaluate('document.title'));
  }
  // 标签条标题同样等全部到达终态再比对：page-title-updated → IPC → tabbar 渲染
  // 晚于页面 title 生效，直接读可能拿到上一态
  const barTitles = await waitFor(async () => {
    const titles = (await tabbarDom.titles()) || [];
    return titles.length === 3 && titles.every(isSettledTitle) ? titles : null;
  }, 15000) || [];
  const titlesOk = pageTitles.every(isSettledTitle)
    && barTitles.length === 3
    && barTitles.every((title) => pageTitles.includes(title));
  assert('多标签场景：3 个标签标题均取自页面 title 并同步到标签条（仓库感知终态判别）', titlesOk, JSON.stringify({ pageTitles, barTitles }));

  // 6. sessionStorage 标签间隔离：各自写入标记互不串扰
  for (const [index, id] of creationOrder.entries()) {
    await conns.get(id).evaluate(`sessionStorage.setItem("glwt-smoke-tag", "tab-${index}")`);
  }
  const tags = [];
  for (const id of creationOrder) {
    tags.push(await conns.get(id).evaluate('sessionStorage.getItem("glwt-smoke-tag")'));
  }
  const tagsDistinct = new Set(tags).size === 3 && tags.every((tag, index) => tag === `tab-${index}`);
  assert('多标签场景：各标签 sessionStorage 互相独立（三标签标记互不串扰）', tagsDistinct, JSON.stringify(tags));

  // A 写入探针 → B 不可见 → 经标签条切走再切回 → A 数据仍在且激活态正确
  await conns.get(creationOrder[0]).evaluate('sessionStorage.setItem("glwt-smoke-probe", "A-内容")');
  const leakedToB = await conns.get(creationOrder[1]).evaluate('sessionStorage.getItem("glwt-smoke-probe")');
  await tabbarDom.clickTab(1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await tabbarDom.clickTab(0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const retained = await conns.get(creationOrder[0]).evaluate('sessionStorage.getItem("glwt-smoke-probe")');
  const activeIndex = await tabbarDom.activeIndex();
  assert('多标签场景：A 写入的 sessionStorage 对 B 不可见，切回 A 后仍保留且激活态正确', leakedToB === null && retained === 'A-内容' && activeIndex === 0, `B 读到 ${JSON.stringify(leakedToB)}，A 读到 ${JSON.stringify(retained)}，激活索引=${activeIndex}`);

  // 7. 凭据覆盖：在每个标签视图内发起 /api/projects（无显式凭据头，依赖 session 注入）
  const statuses = [];
  for (const id of creationOrder) {
    statuses.push(await conns.get(id).evaluate('fetch("/api/projects").then(function (r) { return r.status; })'));
  }
  assert('多标签场景：每个标签内 /api/projects 均 200（凭据过滤覆盖全部视图）', statuses.length === 3 && statuses.every((status) => status === 200), JSON.stringify(statuses));

  // 8. chrome 融合动态证据（契约 §17）：
  //    a) loadFile query 注入的平台标识已在标签条 body[data-platform] 生效（CSS 安全区分支的前提）；
  //    b) 对 tabbar 目标 Page.captureScreenshot 落固定 /tmp 路径，供协调者视觉审阅配色融合
  const platformAttr = await tabbar.evaluate('document.body.dataset.platform');
  assert('chrome 融合：标签条 body[data-platform] 与宿主平台一致（loadFile query 注入生效）', platformAttr === process.platform, `data-platform=${platformAttr} 宿主=${process.platform}`);
  const tabbarScreenshotPath = '/tmp/glwt-smoke-tabbar.png';
  let tabbarShotOk = false;
  try {
    // Page.captureScreenshot 无需先 Page.enable；标签条仅 38px 高，截图即窄条
    const shot = await tabbar.send('Page.captureScreenshot', { format: 'png' });
    await fsp.writeFile(tabbarScreenshotPath, Buffer.from(shot.data, 'base64'));
    tabbarShotOk = fs.existsSync(tabbarScreenshotPath) && fs.statSync(tabbarScreenshotPath).size > 0;
  } catch (err) {
    console.log(`标签条截图失败：${err && err.message ? err.message : err}`);
  }
  assert('chrome 融合：标签条 CDP 截图已落盘（含 3 个标签与平台安全区，供视觉审阅）', tabbarShotOk, `截图路径=${tabbarScreenshotPath}`);

  // 8c. 全屏吸附（契约 §17.1.1）：主进程 inspector 驱动 BrowserWindow.setFullScreen
  //     往返，在标签条 DOM 上轮询 body.fullscreen 类与 #bar 计算左内边距。
  //     setFullScreen 为异步（macOS 有系统全屏过渡），一律轮询等待而非立即断言；
  //     左内边距断言仅 darwin 有意义（非 darwin 无左安全区分支，只断言类切换）
  const isDarwin = process.platform === 'darwin';
  const expectedRestPadding = isDarwin ? '78px' : '0px';
  const readFullscreenState = () => tabbar.evaluate(`(function () {
    var bar = document.getElementById('bar');
    return {
      fullscreenClass: document.body.classList.contains('fullscreen'),
      paddingLeft: bar ? getComputedStyle(bar).paddingLeft : null,
    };
  })()`);
  const initialFs = await readFullscreenState();
  assert(
    'chrome 融合（全屏吸附）：非全屏初始态无 fullscreen 类且 darwin 左安全区 78px',
    Boolean(initialFs) && initialFs.fullscreenClass === false && (!isDarwin || initialFs.paddingLeft === '78px'),
    `平台=${process.platform} 状态=${JSON.stringify(initialFs)}`,
  );

  let inspector = null;
  try {
    const inspectorUrl = await waitMainInspectorUrl(app);
    if (inspectorUrl) inspector = await connectDevtoolsWs(inspectorUrl);
  } catch {
    inspector = null;
  }

  if (!inspector) {
    // inspector 是菜单运行期断言与全屏驱动的唯一通道，缺失即 fail，不给空洞通过
    assert('chrome 融合（菜单）：switch-tab-0..9 十项 id 齐全且加速键为 CmdOrCtrl+0..9（运行期 Menu 断言）', false, '主进程 inspector 未就绪（--inspect=0）');
    assert('chrome 融合（菜单）：prev/next-tab-cmd-arrow 已移除（⌘←/→ 移交页面，契约 §17.1.2）', false, '主进程 inspector 未就绪');
    assert('chrome 融合（菜单）：全菜单加速键无重复（无两项争抢同一加速键）', false, '主进程 inspector 未就绪');
    assert('chrome 融合（全屏吸附）：进入全屏后 body.fullscreen 生效且 darwin 左安全区取消（78px→0px）', false, '主进程 inspector 未就绪，无法驱动 setFullScreen');
    assert('chrome 融合（全屏吸附）：退出全屏后 fullscreen 类移除且 darwin 左安全区恢复', false, '主进程 inspector 未就绪');
  } else {
    // 菜单运行期断言（契约 §17.1 第四次修订/§17.1.2）：比静态走查更强的证据——
    // 直接读取真实构建出的应用菜单
    const menuSnapshot = await inspector.evaluate(MENU_SNAPSHOT_EXPR);
    const switchTabEntries = menuSnapshot ? Object.entries(menuSnapshot.switchTabs) : [];
    const switchTabsOk = switchTabEntries.length === 10
      && switchTabEntries.every(([id, accelerator]) => accelerator === `CmdOrCtrl+${id.slice(-1)}`);
    assert(
      'chrome 融合（菜单）：switch-tab-0..9 十项 id 齐全且加速键为 CmdOrCtrl+0..9（运行期 Menu 断言）',
      switchTabsOk,
      menuSnapshot ? JSON.stringify(menuSnapshot.switchTabs) : '菜单快照为空',
    );
    const arrowsGone = Boolean(menuSnapshot) && menuSnapshot.arrows.prev === false && menuSnapshot.arrows.next === false;
    assert(
      'chrome 融合（菜单）：prev/next-tab-cmd-arrow 已移除（⌘←/→ 移交页面，契约 §17.1.2）',
      arrowsGone,
      menuSnapshot ? `prev=${menuSnapshot.arrows.prev} next=${menuSnapshot.arrows.next}` : '菜单快照为空',
    );
    const noDuplicateAccelerators = Boolean(menuSnapshot) && menuSnapshot.duplicates.length === 0;
    assert(
      'chrome 融合（菜单）：全菜单加速键无重复（无两项争抢同一加速键）',
      noDuplicateAccelerators,
      menuSnapshot ? (menuSnapshot.duplicates.length ? `重复：${menuSnapshot.duplicates.join(', ')}` : '无重复') : '菜单快照为空',
    );

    // 全屏进入：驱动 → 轮询（类 + darwin 左内边距取消）
    const enterTriggered = await inspector.evaluate(mainSetFullScreenExpr(true));
    const entered = await waitFor(async () => {
      const state = await readFullscreenState();
      return state && state.fullscreenClass === true && (!isDarwin || state.paddingLeft === '0px') ? state : null;
    }, 10000);
    assert(
      'chrome 融合（全屏吸附）：进入全屏后 body.fullscreen 生效且 darwin 左安全区取消（78px→0px）',
      enterTriggered === true && Boolean(entered),
      `驱动=${enterTriggered} 终态=${JSON.stringify(entered)}`,
    );

    // 全屏退出：恢复断言（类移除 + 左安全区回到 78px），恢复完成后再继续关标签，
    // 避免退出协议与全屏过渡竞态
    const exitTriggered = await inspector.evaluate(mainSetFullScreenExpr(false));
    const exited = await waitFor(async () => {
      const state = await readFullscreenState();
      return state && state.fullscreenClass === false && (!isDarwin || state.paddingLeft === expectedRestPadding) ? state : null;
    }, 10000);
    assert(
      'chrome 融合（全屏吸附）：退出全屏后 fullscreen 类移除且 darwin 左安全区恢复',
      exitTriggered === true && Boolean(exited),
      `驱动=${exitTriggered} 终态=${JSON.stringify(exited)}`,
    );

    inspector.close();
  }

  for (const conn of conns.values()) conn.close();

  // 9. 点击「×」关闭第 3 个标签 → 对应 CDP 目标消失（webContents 销毁）
  const closedId = creationOrder[2];
  await tabbarDom.clickClose(2);
  const destroyedThird = await waitFor(async () => {
    const list = await fetchCdpTargets(cdpPort);
    return appTargetsOf(list).length === 2 && !appTargetsOf(list).some((item) => item.id === closedId) ? true : null;
  }, 10000);
  assert('多标签场景：点击「×」后第 3 个标签视图销毁（CDP 目标消失）', destroyedThird === true, `closedTarget=${closedId}`);

  // 10. 逐个关闭剩余标签；关闭最后一个触发关窗退出协议
  await tabbarDom.clickClose(0);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await tabbarDom.clickClose(0);
  const appExit = await waitExit(app.child, 20000);
  assert('多标签场景：关闭最后一个标签后窗口关闭、主进程 20s 内退出', appExit !== null, appExit ? `code=${appExit.code} signal=${appExit.signal}` : '超时\n' + app.tail());

  const serviceGone = await waitFor(() => {
    try {
      process.kill(ready.servicePid, 0);
      return false;
    } catch (err) {
      return err.code === 'ESRCH' ? true : null;
    }
  }, 10000);
  assert('多标签场景：服务进程随之退出（无孤儿）', serviceGone === true, serviceGone ? `servicePid=${ready.servicePid} 已退出` : `服务进程 ${ready.servicePid} 仍存活`);

  const portFreed = await waitFor(async () => {
    try {
      await httpGet(ready.port, '/api/projects');
      return false;
    } catch {
      return true;
    }
  }, 8000);
  assert('多标签场景：服务端口已释放', portFreed === true, `port=${ready.port}`);

  // 11. 销毁回执：主进程日志逐标签记录 webContents 已销毁（isDestroyed 证据）
  const destroyedLogs = (app.tail().match(/webContents 已销毁/g) || []).length;
  assert('多标签场景：3 个标签 webContents 均确认销毁（destroyed 回执日志 ≥3）', destroyedLogs >= 3, `日志计数=${destroyedLogs}`);

  tabbar.close();
  // chrome 融合前缀的运行期断言（平台注入/截图/全屏吸附/菜单）同属本场景，
  // 失败时同样保留临时目录供排查
  const failedHere = results.some((item) => !item.ok
    && (item.name.startsWith('多标签场景') || item.name.startsWith('chrome 融合')));
  if (!failedHere) {
    try {
      await fsp.rm(root3, { recursive: true, force: true });
      console.log('多标签场景临时目录已清理。');
    } catch {
      console.log(`多标签场景临时目录保留（清理失败）：${root3}`);
    }
  } else {
    console.log(`多标签场景存在失败项，临时目录保留供排查：${root3}`);
  }
}

// ---- 场景四：配置互通解析（契约 §5 第三次修订） ----

/**
 * 优雅终止应用进程：SIGTERM → 等待退出 → 超时 SIGKILL 兜底，保证无残留进程。
 * @param {{child: import('node:child_process').ChildProcess}} app
 */
async function terminateApp(app) {
  app.child.kill('SIGTERM');
  const exit = await waitExit(app.child, 15000);
  if (!exit) app.child.kill('SIGKILL');
}

/**
 * 递归收集目录树下全部名为 config.json 的文件（「配置不越界」断言用）。
 * @param {string} dir - 递归起点
 * @returns {Promise<string[]>} config.json 绝对路径列表
 */
async function collectConfigJsonFiles(dir) {
  const found = [];
  async function walk(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name === 'config.json') found.push(full);
    }
  }
  await walk(dir);
  return found;
}

/**
 * 等待应用就绪文件与 E2E 凭据文件均可用。
 * @param {{readyFile: string, tokenFile: string}} ctx
 * @returns {Promise<object|null>} 就绪文件内容；超时返回 null
 */
async function waitForReadyAndToken(ctx) {
  const ready = await waitFor(() => {
    const data = readReadyFile(ctx.readyFile);
    return data && Number.isInteger(data.port) && Number.isInteger(data.servicePid) ? data : null;
  }, 30000);
  if (!ready) return null;
  await waitFor(() => {
    try {
      return fs.readFileSync(ctx.tokenFile, 'utf-8').trim() || null;
    } catch {
      return null;
    }
  }, 10000);
  return ready;
}

/**
 * 场景四：配置互通解析（契约 §5 第三次修订）。
 *
 * 三条规则分两层验证：
 *  - 纯函数层（规则 1/2/3 全覆盖）：规则 2 的真实用户场景若整进程验证必然读写真实
 *    ~/.config/git-lens-web（纪律禁止），因此主进程把解析逻辑抽为
 *    resolveServiceConfigDir 纯函数，此处以注入参数直接断言三条规则，默认路径
 *    仅做字符串组装断言、不实际访问磁盘；
 *  - 端到端层（规则 1/3 全链路）：分别以「显式 GIT_LENS_CONFIG_DIR」与
 *    「仅 GIT_LENS_USER_DATA」启动真实应用（两者 userData 各自独立 mkdtemp，
 *    避免单实例锁互斥），经握手接口核对 configDir 落点，并写扫描目录验证
 *    config.json 不越界。
 * 全部路径位于 mkdtemp 私有目录，全程不触碰真实用户配置。
 * @param {{runId: string}} baseCtx - 复用主场景的 runId 前缀
 */
async function runSharedConfigCheck(baseCtx) {
  const rootPure = fs.mkdtempSync(path.join(os.tmpdir(), 'glwt-smoke-cfg-'));
  const dirA = path.join(rootPure, 'config-dir-a');        // 纯函数/场景 A 的显式配置目录
  const userDataU = path.join(rootPure, 'user-data-u');    // 纯函数规则 3 的注入 userData
  const fallbackConfigDir = path.join(userDataU, 'git-lens-config');
  const homeInjected = path.join(rootPure, 'home-injected'); // 纯函数规则 2 的注入 home
  for (const dir of [dirA, userDataU, homeInjected]) {
    await fsp.mkdir(dir, { recursive: true });
  }

  // 1. 纯函数规则 1：显式 GIT_LENS_CONFIG_DIR 优先于 GIT_LENS_USER_DATA 隔离
  const rule1 = resolveServiceConfigDir({ configDirEnv: dirA, userDataEnv: userDataU, home: homeInjected });
  assert(
    '配置互通（规则 1/纯函数）：显式 GIT_LENS_CONFIG_DIR 优先于 userData 隔离',
    rule1 === dirA,
    `返回 ${rule1}`,
  );

  // 2. 纯函数规则 2：无任何环境变量 → ~/.config/git-lens-web。
  //    注入 home=mkdtemp 验证相对布局；默认组装仅做字符串断言（不实际访问磁盘），
  //    间接覆盖「真实用户启动」分支而绝不触碰真实 ~/.config
  const rule2Injected = resolveServiceConfigDir({ configDirEnv: undefined, userDataEnv: null, home: homeInjected });
  const rule2Default = resolveServiceConfigDir({});
  const rule2Ok = rule2Injected === path.join(homeInjected, '.config', 'git-lens-web')
    && rule2Default === path.join(os.homedir(), '.config', 'git-lens-web');
  assert(
    '配置互通（规则 2/纯函数）：真实用户启动默认 ~/.config/git-lens-web（home 注入 + 真实组装字符串断言，不触盘）',
    rule2Ok,
    `注入 home → ${rule2Injected}；默认组装 → ${rule2Default}`,
  );

  // 3. 纯函数规则 3：GIT_LENS_USER_DATA 隔离 → <userData>/git-lens-config
  const rule3 = resolveServiceConfigDir({ configDirEnv: '', userDataEnv: userDataU, home: homeInjected });
  assert(
    '配置互通（规则 3/纯函数）：GIT_LENS_USER_DATA 隔离时回落 <userData>/git-lens-config',
    rule3 === fallbackConfigDir,
    `返回 ${rule3}`,
  );

  // 4. 代码走查（脚本化）：主进程解析委托同一纯函数、不再硬编码旧布局。
  //    规则 2 无法整进程 E2E，其生产保证依赖「主进程与纯函数共用实现」，此处钉死
  const source = mainJsSource();
  const delegates = source.includes('resolveServiceConfigDir({') && source.includes("from './service-config-dir.js'");
  const noHardcoded = !source.includes("path.join(app.getPath('userData'), 'git-lens-config')");
  assert(
    '配置互通（代码走查）：主进程 getServiceConfigDir 委托共享纯函数且不再硬编码旧 userData 布局',
    delegates && noHardcoded,
    `委托=${delegates} 无硬编码=${noHardcoded}`,
  );

  // 5. 场景 A（规则 1 端到端）：显式 GIT_LENS_CONFIG_DIR 启动，握手 configDir 指向该目录
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'glwt-smoke-cfga-'));
  const ctxA = {
    root: rootA,
    readyFile: path.join(rootA, 'ready.json'),
    tokenFile: path.join(rootA, 'token.txt'),
    runId: `${baseCtx.runId}-cfg-a`,
  };
  await fsp.mkdir(path.join(rootA, 'user-data'), { recursive: true });
  await fsp.mkdir(path.join(rootA, 'xdg-config'), { recursive: true });
  const explicitConfigDir = path.join(rootA, 'explicit-config');
  await fsp.mkdir(explicitConfigDir, { recursive: true });

  const appA = launchApp(ctxA, 'cfg-a', [], { GIT_LENS_CONFIG_DIR: explicitConfigDir });
  const readyA = await waitForReadyAndToken(ctxA);
  if (!readyA) {
    assert('配置互通（场景 A/规则 1）：显式 GIT_LENS_CONFIG_DIR 启动后握手 configDir 等于 realpath(该目录)', false, '就绪文件超时\n' + appA.tail());
  } else {
    const tokenA = fs.readFileSync(ctxA.tokenFile, 'utf-8').trim();
    const handshakeA = await httpGet(readyA.port, '/api/test-handshake', { 'X-Git-Lens-Session': tokenA });
    const bodyA = handshakeA.ok ? await handshakeA.json() : null;
    const explicitReal = fs.realpathSync(explicitConfigDir);
    assert(
      '配置互通（场景 A/规则 1）：显式 GIT_LENS_CONFIG_DIR 启动后握手 configDir 等于 realpath(该目录)',
      bodyA?.ok === true && bodyA?.configDir === explicitReal,
      bodyA ? `握手 configDir=${bodyA.configDir}` : `握手失败 status=${handshakeA.status}`,
    );
  }
  await terminateApp(appA);

  // 6-7. 场景 B（规则 3 端到端）：仅 GIT_LENS_USER_DATA，握手回落 <userData>/git-lens-config，
  //      且写扫描目录后 config.json 仅落在该目录内（不越界到 userData 根或其他位置）
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'glwt-smoke-cfgb-'));
  const ctxB = {
    root: rootB,
    readyFile: path.join(rootB, 'ready.json'),
    tokenFile: path.join(rootB, 'token.txt'),
    runId: `${baseCtx.runId}-cfg-b`,
  };
  await fsp.mkdir(path.join(rootB, 'user-data'), { recursive: true });
  await fsp.mkdir(path.join(rootB, 'xdg-config'), { recursive: true });
  const scanTarget = path.join(rootB, 'scan-target');
  await fsp.mkdir(scanTarget, { recursive: true });

  const appB = launchApp(ctxB, 'cfg-b');
  const readyB = await waitForReadyAndToken(ctxB);
  if (!readyB) {
    assert('配置互通（场景 B/规则 3）：仅 GIT_LENS_USER_DATA 时握手 configDir 等于 realpath(<userData>/git-lens-config)', false, '就绪文件超时\n' + appB.tail());
    assert('配置互通（场景 B）：写扫描目录后 config.json 仅落在 <userData>/git-lens-config（不越界）', false, '前置场景未就绪，跳过');
  } else {
    const tokenB = fs.readFileSync(ctxB.tokenFile, 'utf-8').trim();
    const handshakeB = await httpGet(readyB.port, '/api/test-handshake', { 'X-Git-Lens-Session': tokenB });
    const bodyB = handshakeB.ok ? await handshakeB.json() : null;
    const fallbackReal = fs.realpathSync(path.join(ctxB.root, 'user-data', 'git-lens-config'));
    assert(
      '配置互通（场景 B/规则 3）：仅 GIT_LENS_USER_DATA 时握手 configDir 等于 realpath(<userData>/git-lens-config)',
      bodyB?.ok === true && bodyB?.configDir === fallbackReal,
      bodyB ? `握手 configDir=${bodyB.configDir}` : `握手失败 status=${handshakeB.status}`,
    );

    // 经既有写接口写入扫描目录，随后核对 config.json 实际落点（含全树越界排查）
    const writeResponse = await fetch(`http://127.0.0.1:${readyB.port}/api/scan-directories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Git-Lens-Session': tokenB },
      body: JSON.stringify({ directories: [scanTarget] }),
      signal: AbortSignal.timeout(5000),
    });
    const writeOk = writeResponse.ok ? Boolean((await writeResponse.json()).ok) : false;
    const configJsonPath = path.join(ctxB.root, 'user-data', 'git-lens-config', 'config.json');
    const configJsonWritten = writeOk && await waitFor(async () => {
      try {
        const parsed = JSON.parse(await fsp.readFile(configJsonPath, 'utf-8'));
        return Array.isArray(parsed.customDirectories) ? true : null;
      } catch {
        return null;
      }
    }, 5000);
    const allConfigJson = await collectConfigJsonFiles(rootB);
    const noLeak = allConfigJson.length === 1 && allConfigJson[0] === configJsonPath;
    assert(
      '配置互通（场景 B）：写扫描目录后 config.json 仅落在 <userData>/git-lens-config（不越界）',
      writeOk && Boolean(configJsonWritten) && noLeak,
      `写入=${writeOk} 落点=${configJsonWritten ? configJsonPath : '未出现'} 全树命中=[${allConfigJson.join(', ')}]`,
    );
  }
  await terminateApp(appB);

  const failedHere = results.some((item) => !item.ok && item.name.startsWith('配置互通'));
  for (const dir of [rootPure, rootA, rootB]) {
    if (failedHere) {
      console.log(`配置互通场景存在失败项，临时目录保留供排查：${dir}`);
      break;
    }
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      console.log(`配置互通场景临时目录已清理：${path.basename(dir)}`);
    } catch {
      console.log(`配置互通场景临时目录保留（清理失败）：${dir}`);
    }
  }
}

// ---- 场景五：跨启动标签恢复（契约 §15 第二次修订） ----

/**
 * 用隔离环境创建最小 fixture 仓库（git init + 单次 commit）。
 * 提交身份以 -c 注入、GIT_CONFIG_GLOBAL 指向临时文件，不读写真实全局 git 配置。
 * @param {string} fixturesRoot - fixture 根目录（已存在）
 * @param {string} name - 仓库名（即目录名）
 * @returns {string} 仓库 realpath（macOS 上 /var 与 /private/var 差异以此为准）
 */
function createFixtureRepo(fixturesRoot, name) {
  const repoDir = path.join(fixturesRoot, name);
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'README.md'), `# ${name}\n`, 'utf-8');
  const git = (...args) => execFileSync('git', args, {
    cwd: repoDir,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(fixturesRoot, '.gitconfig-smoke') },
  });
  git('init');
  git('add', '-A');
  git('-c', 'user.name=glwt-smoke', '-c', 'user.email=glwt-smoke@example.invalid', 'commit', '-m', 'init');
  return fs.realpathSync(repoDir);
}

/** 安全解码查询串（异常时原样返回），供存档内容断言使用 */
function safeDecode(value) {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

/**
 * 场景五：跨启动标签恢复（契约 §15 第二次修订）。
 *
 * 三轮启动共用同一 userData（tab-state.json 随其天然隔离），端口跨启动变化
 * 恰好验证「只存查询串、恢复时重放到当前 origin」：
 *  a. 预置：mkdtemp 根下两个最小 fixture 仓库 + 预写
 *     <userData>/git-lens-config/config.json（customDirectories=[fixture 根]）；
 *  b. 第一轮：标签 1 经页面仓库下拉切到 fixture-a，标签条「+」新建标签 2 切到
 *     fixture-b，切回标签 1 后优雅退出，核对退出前落盘的存档内容；
 *  c. 第二轮：断言自动恢复 2 个标签（顺序/激活项与首轮一致、查询串重放到新
 *     端口、页面数据可拉取），再强杀服务验证崩溃重启不破坏恢复态；
 *  d. 第三轮：把存档写成半截 JSON，断言按无存档处理回落单标签首页且页面可用。
 * @param {{runId: string}} baseCtx - 复用主场景的 runId 前缀
 */
async function runTabRestoreCheck(baseCtx) {
  const root5 = fs.mkdtempSync(path.join(os.tmpdir(), 'glwt-smoke-restore-'));
  const ctx = {
    root: root5,
    readyFile: path.join(root5, 'ready.json'),
    tokenFile: path.join(root5, 'token.txt'),
    runId: `${baseCtx.runId}-restore`,
  };
  const userDataDir = path.join(ctx.root, 'user-data');
  await fsp.mkdir(userDataDir, { recursive: true });
  await fsp.mkdir(path.join(ctx.root, 'xdg-config'), { recursive: true });
  const tabStatePath = path.join(userDataDir, 'tab-state.json');

  // a. fixture 仓库与预写扫描目录配置（仅 GIT_LENS_USER_DATA 时服务配置目录
  //    按规则 3 落在 <userData>/git-lens-config，smoke 场景四已验证该解析）
  const fixturesRoot = path.join(root5, 'fixtures');
  fs.mkdirSync(fixturesRoot, { recursive: true });
  const fixtureA = createFixtureRepo(fixturesRoot, 'fixture-a');
  const fixtureB = createFixtureRepo(fixturesRoot, 'fixture-b');
  const serviceConfigDir = path.join(userDataDir, 'git-lens-config');
  await fsp.mkdir(serviceConfigDir, { recursive: true });
  await fsp.writeFile(
    path.join(serviceConfigDir, 'config.json'),
    `${JSON.stringify({ customDirectories: [fs.realpathSync(fixturesRoot)] }, null, 2)}\n`,
    'utf-8',
  );

  /** 单轮启动前清掉上一轮的 E2E 文件，避免 waitFor 读到旧值空洞通过 */
  const resetE2eFiles = async () => {
    await fsp.rm(ctx.readyFile, { force: true });
    await fsp.rm(ctx.tokenFile, { force: true });
    await fsp.rm(path.join(userDataDir, 'DevToolsActivePort'), { force: true });
  };

  /** 读标签存档；不存在/损坏返回 null */
  const readTabState = () => {
    try {
      return JSON.parse(fs.readFileSync(tabStatePath, 'utf-8'));
    } catch {
      return null;
    }
  };

  /** 等待应用页面目标数量达标并返回目标列表（按服务前缀过滤） */
  const waitForAppTargets = (cdpPort, prefix, count, timeoutMs) => waitFor(async () => {
    const list = await fetchCdpTargets(cdpPort);
    const apps = list.filter((item) => item.type === 'page' && item.url.startsWith(prefix));
    return apps.length === count ? apps : null;
  }, timeoutMs);

  /** 等待应用页加载出仓库选项（下拉列表已渲染 ≥2 项） */
  const waitForRepoOptions = (conn) => waitFor(async () => {
    const count = await conn.evaluate('document.querySelectorAll("#repoDropdownList .repo-item").length');
    return count >= 2 ? count : null;
  }, 15000);

  /** 在应用页内经真实仓库下拉（#repoTrigger + .repo-item 点击）切换到指定仓库 */
  const selectRepoViaUi = (conn, repoPath) => conn.evaluate(`(function () {
    var trigger = document.getElementById('repoTrigger');
    if (!trigger) { return false; }
    trigger.click();
    var items = document.querySelectorAll('#repoDropdownList .repo-item');
    for (var i = 0; i < items.length; i++) {
      if (items[i].dataset.repoPath === ${JSON.stringify(repoPath)}) { items[i].click(); return true; }
    }
    return false;
  })()`);

  /** 等待标签条标题依次包含期望仓库名（首页加载初期 title 是通用文案，不作为就绪信号） */
  const waitForTabbarRepoTitles = (tabbar, repoNames, timeoutMs) => waitFor(async () => {
    const titles = await tabbar.evaluate('Array.from(document.querySelectorAll(".tab-title")).map(function (e) { return e.textContent; })');
    return Array.isArray(titles) && titles.length === repoNames.length
      && repoNames.every((name, index) => typeof titles[index] === 'string' && titles[index].includes(name))
      ? titles : null;
  }, timeoutMs);

  /** 读取标签条当前激活下标 */
  const tabbarActiveIndex = (tabbar) => tabbar.evaluate('Array.from(document.querySelectorAll(".tab")).findIndex(function (e) { return e.classList.contains("active"); })');

  // ---- 第一轮：构造状态（两个标签分别指向 fixture-a / fixture-b，激活标签 1） ----
  await resetE2eFiles();
  // --inspect=0 为剪贴板断言开主进程 inspector 通道（见下方「剪贴板真实写入」块）
  const app1 = launchApp(ctx, 'restore-1', ['--remote-debugging-port=0', '--inspect=0']);
  const ready1 = await waitForReadyAndToken(ctx);
  assert('恢复场景：首轮启动就绪（30s 内）', Boolean(ready1), ready1 ? `port=${ready1.port}` : '就绪文件超时\n' + app1.tail());
  if (!ready1) {
    app1.child.kill('SIGKILL');
    return;
  }

  const token1 = fs.readFileSync(ctx.tokenFile, 'utf-8').trim();
  const projectsResp = await httpGet(ready1.port, '/api/projects', { 'X-Git-Lens-Session': token1 });
  const projectsBody = projectsResp.ok ? await projectsResp.json() : null;
  const discovered = ((projectsBody && Array.isArray(projectsBody.repos)) ? projectsBody.repos : []).map((item) => item.path);
  const discoveredOk = projectsBody?.ok === true && discovered.includes(fixtureA) && discovered.includes(fixtureB);
  assert('恢复场景：预写 config.json 生效——/api/projects 发现 fixture-a 与 fixture-b', discoveredOk, `repos=${JSON.stringify(discovered)}`);
  if (!discoveredOk) {
    app1.child.kill('SIGKILL');
    return;
  }

  const cdpPort1 = await waitFor(() => readDevToolsPort(userDataDir), 10000);
  const prefix1 = `http://127.0.0.1:${ready1.port}`;
  const targets1 = cdpPort1 ? await waitForAppTargets(cdpPort1, prefix1, 1, 15000) : null;
  assert('恢复场景：首轮启动为单标签（此前无存档，回落首页）', Boolean(targets1), targets1 ? targets1.map((t) => t.url).join(', ') : '15s 内未就绪');
  if (!cdpPort1 || !targets1) {
    app1.child.kill('SIGKILL');
    return;
  }

  const conn1 = await connectCdpPage(cdpPort1, targets1[0].id);
  await armDialogImmunity(conn1);
  await waitForRepoOptions(conn1);
  await selectRepoViaUi(conn1, fixtureA);
  const search1 = await waitFor(async () => {
    const value = await conn1.evaluate('location.search');
    return safeDecode(value).includes('fixture-a') ? value : null;
  }, 15000);
  assert('恢复场景：标签 1 经页面下拉切到 fixture-a（URL 出现 ?repo= 查询串）', Boolean(search1), `search=${search1}`);

  // ---- 剪贴板真实写入（契约 §17.2 / DEF-007，替代原「剪贴板降级」skip 项）----
  // 触发路径选择：inspect 视图 worktree item 的「复制」按钮，经 CDP Input 域
  // 真实鼠标点击。两个备选均不可行：
  //  - 直接调用页面 copy 通道：app.js 整体在 IIFE 内、copyText 未暴露全局；
  //  - 合成 DOM click()：不产生 transient user activation，writeText 会在
  //    Chromium 权限请求层被直接拒绝（探针实测），真实用户的鼠标点击天然
  //    带激活——故必须走 Input 真实输入管线，同时验证权限放行与页面时序。
  const copyBtnReady = await waitFor(async () => {
    const present = await conn1.evaluate('Boolean(document.querySelector("#wtList [data-action=wt-copy-path]"))');
    return present === true ? true : null;
  }, 30000);
  assert('恢复场景：inspect 视图渲染出 worktree「复制」按钮（剪贴板断言前置就绪）', copyBtnReady === true, copyBtnReady ? '按钮已渲染' : '30s 内未渲染，inspect 未完成');

  // 「已复制!」反馈仅存活 1500ms 后自动还原，轮询读 DOM 有错过窗口的竞态；
  // 先挂 MutationObserver 锁存瞬时反馈，再触发真实点击，断言无竞态
  let armed = false;
  let feedbackSeen = null;
  let clipRead = null;
  if (copyBtnReady === true) {
    armed = await conn1.evaluate(`(function () {
      var btn = document.querySelector('#wtList [data-action=wt-copy-path]');
      if (!btn) return false;
      var item = btn.closest('.list-item');
      var pathEl = item ? item.querySelector('.item-path-text') : null;
      window.__glwtCopyExpected = pathEl ? pathEl.textContent : null;
      window.__glwtCopyFeedbackSeen = false;
      var observer = new MutationObserver(function () {
        if (btn.textContent === '已复制!') window.__glwtCopyFeedbackSeen = true;
      });
      observer.observe(btn, { childList: true, characterData: true, subtree: true });
      return true;
    })()`);
    // 取按钮视口中心坐标并滚入视野，供 Input 真实鼠标点击
    const clickPoint = armed === true
      ? await conn1.evaluate(`(function () {
        var btn = document.querySelector('#wtList [data-action=wt-copy-path]');
        btn.scrollIntoView({ block: 'center' });
        var r = btn.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`)
      : null;
    if (armed === true && clickPoint) {
      await conn1.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickPoint.x, y: clickPoint.y });
      await conn1.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickPoint.x, y: clickPoint.y, button: 'left', clickCount: 1 });
      await conn1.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickPoint.x, y: clickPoint.y, button: 'left', clickCount: 1 });
      feedbackSeen = await waitFor(async () => {
        const seen = await conn1.evaluate('window.__glwtCopyFeedbackSeen === true');
        return seen === true ? true : null;
      }, 8000);

      // 主进程真实剪贴板读取：spawn 启动没有 Playwright electronApp 句柄，
      // 经 --inspect 暴露的主进程 inspector 通道等价完成（同一 DevTools 协议）
      try {
        const inspectorUrl = await waitMainInspectorUrl(app1);
        if (!inspectorUrl) throw new Error('15s 内未出现主进程 inspector 监听行');
        const inspector = await connectDevtoolsWs(inspectorUrl);
        clipRead = await waitFor(async () => {
          const expected = await conn1.evaluate('window.__glwtCopyExpected || null');
          const actual = await inspector.evaluate(MAIN_CLIPBOARD_READ_EXPR);
          return typeof expected === 'string' && actual === expected ? { expected, actual } : null;
        }, 8000);
        inspector.close();
      } catch (err) {
        clipRead = { error: err && err.message ? err.message : String(err) };
      }
    }
  }
  const feedbackOk = armed === true && feedbackSeen === true;
  assert('恢复场景：点击复制按钮后按钮反馈「已复制!」（写入成功后才提示，契约 §17.2 时序）', feedbackOk, feedbackOk ? '瞬时反馈已锁存' : `触发=${armed} 反馈=${feedbackSeen}`);
  const clipboardOk = Boolean(clipRead) && clipRead.expected === clipRead.actual;
  assert('恢复场景：主进程 clipboard.readText() 与被复制文本一致（权限放行 + 真实写入）', clipboardOk, clipboardOk ? `写入 ${clipRead.actual.length} 字符与页面展示路径一致` : JSON.stringify(clipRead));

  const tabbarTarget1 = (await fetchCdpTargets(cdpPort1)).find((item) => item.type === 'page' && item.url.includes('tabbar.html'));
  if (!tabbarTarget1) {
    conn1.close();
    app1.child.kill('SIGKILL');
    return;
  }
  const tabbar1 = await connectCdpPage(cdpPort1, tabbarTarget1.id);
  await tabbar1.evaluate('document.getElementById("new-tab").click()');
  const targets1b = await waitForAppTargets(cdpPort1, prefix1, 2, 15000);
  const newTarget = targets1b ? targets1b.find((item) => item.id !== targets1[0].id) : null;
  assert('恢复场景：经标签条「+」新建标签 2（新应用目标恰一个）', Boolean(newTarget), newTarget ? `新目标 ${newTarget.id.slice(0, 8)}…` : '未出现第 2 个应用目标');
  if (!newTarget) {
    conn1.close();
    tabbar1.close();
    app1.child.kill('SIGKILL');
    return;
  }

  const conn2 = await connectCdpPage(cdpPort1, newTarget.id);
  await armDialogImmunity(conn2);
  await waitForRepoOptions(conn2);
  await selectRepoViaUi(conn2, fixtureB);
  const search2 = await waitFor(async () => {
    const value = await conn2.evaluate('location.search');
    return safeDecode(value).includes('fixture-b') ? value : null;
  }, 15000);
  assert('恢复场景：标签 2 切到 fixture-b（两标签查询串各指向各自仓库）', Boolean(search2), `search=${search2}`);

  // 运行期防抖落盘：不等退出就该能看到含两个仓库查询串的存档
  const archivedLive = await waitFor(() => {
    const parsed = readTabState();
    return parsed && Array.isArray(parsed.tabs) && parsed.tabs.length === 2
      && safeDecode(parsed.tabs[0]?.search || '').includes('fixture-a')
      && safeDecode(parsed.tabs[1]?.search || '').includes('fixture-b')
      ? parsed : null;
  }, 8000);
  assert('恢复场景：运行期间防抖落盘 tab-state.json（2 个标签各含仓库查询串）', Boolean(archivedLive), archivedLive ? JSON.stringify(archivedLive) : '8s 内未出现有效存档');

  // 切回标签 1 作为退出时的激活项，锁定 activeIndex 语义
  await tabbar1.evaluate('document.querySelectorAll(".tab")[0].click()');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const active1 = await tabbarActiveIndex(tabbar1);
  assert('恢复场景：退出前激活项已切回标签 1（索引 0）', active1 === 0, `activeIndex=${active1}`);

  app1.child.kill('SIGTERM');
  const exit1 = await waitExit(app1.child, 15000);
  assert('恢复场景：首轮 SIGTERM 优雅退出（退出协议内同步落盘）', exit1 !== null, exit1 ? `code=${exit1.code} signal=${exit1.signal}` : '超时\n' + app1.tail());

  const serviceGone1 = await waitFor(() => {
    try {
      process.kill(ready1.servicePid, 0);
      return false;
    } catch (err) {
      return err.code === 'ESRCH' ? true : null;
    }
  }, 10000);
  assert('恢复场景：首轮退出后服务随之退出（无孤儿）', serviceGone1 === true, serviceGone1 ? `servicePid=${ready1.servicePid} 已退出` : '服务进程仍存活');

  const final1 = readTabState();
  const final1Ok = Boolean(final1)
    && final1.version === 1
    && Array.isArray(final1.tabs) && final1.tabs.length === 2
    && final1.activeIndex === 0
    && final1.tabs.every((item) => {
      const value = typeof item?.search === 'string' ? item.search : '';
      // 只允许「?」开头的纯查询串：拒绝整串 URL / 协议相对形态（契约校验规则的写入侧镜像）
      return value.startsWith('?') && !/https?:/i.test(value) && !value.includes('//');
    })
    && safeDecode(final1.tabs[0]?.search || '').includes('fixture-a')
    && safeDecode(final1.tabs[1]?.search || '').includes('fixture-b');
  assert('恢复场景：退出后存档仅含查询串（无 origin/端口）且顺序与激活项与首轮一致', final1Ok, JSON.stringify(final1));

  conn1.close();
  conn2.close();
  tabbar1.close();

  // ---- 第二轮：同 userData 启动，验证自动恢复与崩溃重启边界 ----
  await resetE2eFiles();
  const app2 = launchApp(ctx, 'restore-2', ['--remote-debugging-port=0']);
  const ready2 = await waitForReadyAndToken(ctx);
  const ready2Ok = Boolean(ready2) && ready2.port !== ready1.port;
  assert('恢复场景：第二轮启动就绪且端口变化（跨启动端口不参与存档）', ready2Ok, ready2 ? `port ${ready1.port} → ${ready2.port}` : '就绪超时\n' + app2.tail());
  if (!ready2) {
    app2.child.kill('SIGKILL');
    return;
  }

  const cdpPort2 = await waitFor(() => readDevToolsPort(userDataDir), 10000);
  const prefix2 = `http://127.0.0.1:${ready2.port}`;
  // 恢复标签并发加载页面（inspect 驱动 git 命令），高负载下提交慢，等待给足 30s
  const targets2 = cdpPort2 ? await waitForAppTargets(cdpPort2, prefix2, 2, 30000) : null;
  const targets2Ok = Boolean(targets2)
    && targets2.filter((item) => String(item.url).includes('fixture-a')).length === 1
    && targets2.filter((item) => String(item.url).includes('fixture-b')).length === 1;
  assert('恢复场景：第二轮自动恢复 2 个标签，查询串重放到当前 origin（新端口）', targets2Ok, targets2 ? JSON.stringify(targets2.map((item) => item.url)) : '15s 内未出现 2 个应用目标');
  if (!targets2) {
    app2.child.kill('SIGKILL');
    return;
  }

  const tabbarTarget2 = (await fetchCdpTargets(cdpPort2)).find((item) => item.type === 'page' && item.url.includes('tabbar.html'));
  const tabbar2 = tabbarTarget2 ? await connectCdpPage(cdpPort2, tabbarTarget2.id) : null;
  // 等到两个标签标题各自变成对应仓库名再断言顺序与激活项——恢复初期 title
  // 还是「新标签页」或首页通用文案，不能作为「已恢复完成」的信号
  const titles2 = tabbar2 ? await waitForTabbarRepoTitles(tabbar2, ['fixture-a', 'fixture-b'], 30000) : null;
  const active2 = tabbar2 ? await tabbarActiveIndex(tabbar2) : -1;
  const order2Ok = Boolean(titles2) && active2 === 0;
  assert('恢复场景：恢复后标签顺序与激活项与首轮一致（fixture-a 在前且激活）', order2Ok, `titles=${JSON.stringify(titles2)} activeIndex=${active2}`);

  // 为两个应用页建立长会话并启用对话框免疫，存活期覆盖整个崩溃重启窗口：
  // kill 服务瞬间页面在途请求失败可能弹出页面自身的阻塞式 alert 挂起渲染层，
  // 自动 accept 与新文档桩必须在 kill 发生前就挂上（会话关闭后事件兜底失效）
  const pageConns2 = [];
  for (const target of targets2) {
    const conn = await connectCdpPage(cdpPort2, target.id);
    await armDialogImmunity(conn);
    pageConns2.push(conn);
  }

  // 页面数据为最新：每个恢复标签内凭据注入可用、服务接口可拉取
  const dataStatuses = [];
  for (const conn of pageConns2) {
    dataStatuses.push(await conn.evaluate('fetch("/api/projects").then(function (r) { return r.status; })'));
  }
  assert('恢复场景：恢复后的页面数据为最新（各标签 /api/projects 均 200）', dataStatuses.length === 2 && dataStatuses.every((status) => status === 200), JSON.stringify(dataStatuses));

  // 崩溃重启：强杀服务 → 自动重启 → 已有标签走同源 reload，恢复态不被破坏
  const oldPid2 = ready2.servicePid;
  try {
    process.kill(oldPid2, 'SIGKILL');
  } catch {
    // 服务进程意外已死也继续走重启断言
  }
  const restarted2 = await waitFor(() => {
    const data = readReadyFile(ctx.readyFile);
    return data && !data.state && Number.isInteger(data.servicePid) && data.servicePid !== oldPid2 ? data : null;
  }, 20000);
  assert('恢复场景：服务被强杀后自动重启（新 servicePid）', Boolean(restarted2), restarted2 ? `新 servicePid=${restarted2.servicePid}` : '20s 内未重启');

  // 重启后端口可能复用成功（同源 reload）也可能被抢占回退随机端口（查询串
  // 重放到新 origin），两种结果都必须保住「2 个标签、各自查询串」。统计口径
  // 按重启后实际服务端口取全量应用目标（不断言端口不变）；内容断言加严为
  // fixture-a/fixture-b 各恰一个，钉死「标签-项目映射不串位」。
  const prefixAfterCrash = restarted2 ? `http://127.0.0.1:${restarted2.port}` : '';
  // 换端口重放是跨源导航：Electron 按站点隔离为新标签换 renderer 进程，
  // 提交耗时数秒且随负载波动，等待窗口给足 30s（断言语义不变）
  const targets2AfterCrash = restarted2 ? await waitForAppTargets(cdpPort2, prefixAfterCrash, 2, 30000) : null;
  const crashKeepOk = Boolean(targets2AfterCrash)
    && targets2AfterCrash.filter((item) => String(item.url).includes('fixture-a')).length === 1
    && targets2AfterCrash.filter((item) => String(item.url).includes('fixture-b')).length === 1;
  assert('恢复场景：崩溃重启不破坏恢复态（2 个标签保持、查询串不变）', crashKeepOk, targets2AfterCrash ? `${JSON.stringify(targets2AfterCrash.map((item) => item.url))}（重启后端口 ${restarted2.port}${restarted2.port === ready2.port ? '，复用原端口' : '，原端口被抢占回退后按查询串重放'}）` : '标签丢失或未恢复');

  // 崩溃窗口结束，长会话与对话框免疫完成使命
  for (const conn of pageConns2) conn.close();

  app2.child.kill('SIGTERM');
  const exit2 = await waitExit(app2.child, 15000);
  assert('恢复场景：第二轮优雅退出（供第三轮复用同一 userData）', exit2 !== null, exit2 ? `code=${exit2.code} signal=${exit2.signal}` : '超时\n' + app2.tail());
  if (tabbar2) tabbar2.close();

  // ---- 第三轮：存档损坏容错（半截 JSON → 按无存档处理） ----
  await resetE2eFiles();
  await fsp.writeFile(tabStatePath, '{"version":1,"activeIndex":0,"tabs":[{"search":"?repo=%2Fbrok', 'utf-8');
  const app3 = launchApp(ctx, 'restore-3', ['--remote-debugging-port=0']);
  const ready3 = await waitForReadyAndToken(ctx);
  if (!ready3) {
    assert('恢复场景：存档损坏时应用仍能正常启动', false, '就绪超时\n' + app3.tail());
    app3.child.kill('SIGKILL');
    return;
  }
  const cdpPort3 = await waitFor(() => readDevToolsPort(userDataDir), 10000);
  const prefix3 = `http://127.0.0.1:${ready3.port}`;
  const targets3 = cdpPort3 ? await waitForAppTargets(cdpPort3, prefix3, 1, 15000) : null;
  const status3 = targets3
    ? await (await connectCdpPage(cdpPort3, targets3[0].id)).evaluate('fetch("/api/projects").then(function (r) { return r.status; })')
    : 0;
  assert('恢复场景：存档损坏按无存档处理——单标签首页且页面可用', Boolean(targets3) && status3 === 200, `应用目标=${targets3 ? targets3.length : 0} status=${status3}`);
  await terminateApp(app3);

  const failedHere = results.some((item) => !item.ok && item.name.startsWith('恢复场景'));
  if (!failedHere) {
    try {
      await fsp.rm(root5, { recursive: true, force: true });
      console.log('跨启动恢复场景临时目录已清理。');
    } catch {
      console.log(`跨启动恢复场景临时目录保留（清理失败）：${root5}`);
    }
  } else {
    console.log(`跨启动恢复场景存在失败项，临时目录保留供排查：${root5}`);
  }
}

// ---- 场景六：窗口 chrome 融合（契约 §17/§17.1，纯函数断言 + 源码走查） ----

/**
 * 场景六：窗口 chrome 融合（契约 §17/§17.1）。
 *
 * 运行中的 BrowserWindow 构造参数与菜单 accelerator 无法从外部进程直接断言，
 * 按场景四既有模式分两层覆盖：
 *  - 纯函数层：主进程与冒烟脚本 import 同一份 window-chrome.js 的
 *    windowChromeOptions，逐字段断言 darwin（hiddenInset + trafficLightPosition）
 *    与 win32/linux（titleBarOverlay）两分支取值，钉死「实现与期望不漂移」；
 *  - 静态走查层：源码文本断言主窗口构造处展开该纯函数、标签条拖拽区与
 *    平台安全区 CSS、平台 query 注入链路、恢复页 drag 区、§17.1 快捷键
 *    菜单项 id 与越界守卫全部就位。
 * 运行期证据（平台注入实际生效、标签条截图）见场景三内「chrome 融合」断言。
 */
async function runWindowChromeCheck() {
  const source = mainJsSource();
  const tabbarSource = fs.readFileSync(path.resolve(__dirname, '../tabbar.html'), 'utf-8');

  // 1. 纯函数：darwin → hiddenInset + trafficLightPosition（红绿灯压进 38px 标签条内近似垂直居中）
  const darwinChrome = windowChromeOptions('darwin');
  const darwinOk = darwinChrome.titleBarStyle === 'hiddenInset'
    && Boolean(darwinChrome.trafficLightPosition)
    && darwinChrome.trafficLightPosition.x === 12
    && darwinChrome.trafficLightPosition.y === 13;
  assert('chrome 融合（纯函数）：darwin 为 hiddenInset + trafficLightPosition{x:12,y:13}', darwinOk, JSON.stringify(darwinChrome));

  // 2. 纯函数：win32/linux → titleBarOverlay（底色/前景色与标签条一致，高度同标签条 38px；⚠️ 真机未验收）
  const overlayWin = windowChromeOptions('win32');
  const overlayLinux = windowChromeOptions('linux');
  const overlayOk = Boolean(overlayWin.titleBarOverlay)
    && overlayWin.titleBarOverlay.color === '#010409'
    && overlayWin.titleBarOverlay.symbolColor === '#c9d1d9'
    && overlayWin.titleBarOverlay.height === TABBAR_HEIGHT_DIP
    && JSON.stringify(overlayLinux) === JSON.stringify(overlayWin);
  assert('chrome 融合（纯函数）：win32/linux 为 titleBarOverlay(#010409/#c9d1d9/38px) 且两平台一致', overlayOk, JSON.stringify(overlayWin));

  // 3. 走查：主窗口构造处确实展开共享纯函数（平台分支由 process.platform 决定）
  assert(
    'chrome 融合（走查）：createMainWindow 展开共享 windowChromeOptions(process.platform)',
    source.includes('...windowChromeOptions(process.platform)'),
    'main.js 构造参数接入点',
  );

  // 4. 走查：标签条拖拽区、交互元素 no-drag、darwin/非 darwin 安全区与全屏吸附 CSS（契约 §17/§17.1.1）
  const dragOk = tabbarSource.includes('-webkit-app-region: drag')
    && tabbarSource.includes('.tab, .tab-close, #new-tab { -webkit-app-region: no-drag; }')
    && tabbarSource.includes('body[data-platform="darwin"] #bar { padding-left: 78px; }')
    && tabbarSource.includes('body.fullscreen[data-platform="darwin"] #bar { padding-left: 0; }')
    && tabbarSource.includes('body:not([data-platform="darwin"]) #bar { padding-right: 140px; }');
  assert('chrome 融合（走查）：标签条 #bar 拖拽区、交互元素 no-drag、两侧平台安全区与全屏吸附 CSS 就位', dragOk);

  // 5. 走查：平台注入链路（loadFile query → 页面 body[data-platform]，运行期断言见场景三）
  const platformQueryOk = source.includes("loadFile(path.join(__dirname, 'tabbar.html'), { query: { platform: process.platform } })");
  assert('chrome 融合（走查）：tabbar.html 经 loadFile query 注入 process.platform', platformQueryOk);

  // 6. 走查：独立恢复页 body 为拖拽区、「退出应用」按钮 no-drag（契约 §17；main.js 内联样式恰两处）
  const recoveryOk = source.includes('-webkit-app-region: drag; }') && source.includes('-webkit-app-region: no-drag; }');
  assert('chrome 融合（走查）：恢复页 body 拖拽区且「退出应用」按钮 no-drag', recoveryOk);

  // 7. 走查：§17.1 第四次修订——switch-tab 全 10 项（1..9、0=第 10 个标签）显式
  //    列出、activateTabIndex 通用支持 0–9 且越界无操作；§17.1.2——⌘←/→ 菜单项
  //    已整项移除（移交页面 keydown，标签循环保留在 Ctrl±Tab）
  const hotkeysOk = source.includes('id: `switch-tab-${number}`')
    && source.includes('[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map')
    && source.includes('accelerator: `CmdOrCtrl+${number}`')
    && source.includes('activateTabIndex(number === 0 ? 9 : number - 1)')
    && source.includes('index > 9) return')
    && !source.includes('cmd-arrow')
    && source.includes("accelerator: 'Ctrl+Tab'")
    && source.includes("accelerator: 'Ctrl+Shift+Tab'")
    && source.includes('click: () => cycleTab(-1)')
    && source.includes('click: () => cycleTab(1)');
  assert('chrome 融合（走查）：标签快捷键菜单（switch-tab-0..9 全列 / ⌘←→ 已移除 / Ctrl±Tab 保留 / activateTabIndex 0–9 越界守卫）就位', hotkeysOk);

  // 8. 走查：⌘0 已划给 switch-tab-0（第 10 个标签），「实际大小」改绑 ⇧⌘0，
  //    菜单不再存在硬编码的 CmdOrCtrl+0 加速键（防两项争抢回归）
  const zoomOk = source.includes("accelerator: 'Shift+CmdOrCtrl+0'")
    && !source.includes("accelerator: 'CmdOrCtrl+0'");
  assert('chrome 融合（走查）：「实际大小」改绑 ⇧⌘0（⌘0 归属第 10 个标签，无重复加速键）', zoomOk);
}

// ---- 入口 ----

async function main() {
  console.log('=== Git Lens Web 桌面壳 G2 冒烟自验 ===');
  console.log(`主进程入口: ${mainJsPath}`);

  if (!electronBinary || !fs.existsSync(electronBinary)) {
    console.error('[FAIL] 未找到 Electron 可执行文件，无法启动桌面壳。');
    console.error('       请确认依赖已安装且二进制完整：ls node_modules/electron/dist/Electron.app');
    console.error('       缺失时执行：node node_modules/electron/install.js（契约 §12 已知坑）');
    process.exit(1);
  }
  console.log(`Electron 二进制: ${electronBinary}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glwt-smoke-'));
  const ctx = {
    root,
    readyFile: path.join(root, 'ready.json'),
    tokenFile: path.join(root, 'token.txt'),
    runId: `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
  for (const dir of ['user-data', 'xdg-config']) {
    await fsp.mkdir(path.join(root, dir), { recursive: true });
  }
  console.log(`隔离根目录: ${root}`);
  console.log(`fixture runId: ${ctx.runId}`);
  console.log('');

  try {
    await runPrimaryInstance(ctx);
    console.log('');
    await runHardKillOrphanCheck(ctx);
    console.log('');
    await runMultiTabCheck(ctx);
    console.log('');
    await runSharedConfigCheck(ctx);
    console.log('');
    await runTabRestoreCheck(ctx);
    console.log('');
    await runWindowChromeCheck();
  } finally {
    const failed = results.filter((item) => !item.ok);
    console.log('');
    console.log(`=== 断言结果：${results.length - failed.length}/${results.length} 通过 ===`);
    if (failed.length === 0) {
      try {
        await fsp.rm(root, { recursive: true, force: true });
        console.log('临时目录已清理。');
      } catch {
        console.log(`临时目录保留（清理失败）：${root}`);
      }
    } else {
      console.log(`存在失败项，临时目录保留供排查：${root}`);
    }
    console.log('');
    console.log('=== 人工验证清单（GUI 项，无法自动化） ===');
    console.log('1. 应用菜单：刷新(Cmd+R)、返回/前进、缩放(Cmd+=/-，实际大小 ⇧⌘0)、复制/粘贴、帮助(关于/复制诊断信息) 均生效且作用于页面；');
    console.log('2. 「帮助 → 复制诊断信息」剪贴板内容完整（含 git 版本与服务状态）；');
    console.log('3. 原生目录选择对话框（页面添加扫描目录 / window.gitLens.chooseDirectory()）可选目录、取消返回空；');
    console.log('4. 服务崩溃恢复遮罩：深色中文文案、倒计时与「退出应用」按钮表现；恢复期间应用文档不导航（sessionStorage 保留），重启后同端口 reload；');
    console.log('5. 窗口拖动/缩放后重开位置尺寸恢复；外接显示器拔除后窗口自动回到可见区域；');
    console.log('6. 页面内外链点击经系统浏览器打开且不产生新应用窗口；');
    console.log('7. 未设置 GIT_LENS_DEVTOOLS 时 F12/Cmd+Shift+I 不唤起 devtools；设置后可用。');
  console.log('8. 多标签：⌘T/⌘W/Ctrl+Tab（及菜单「标签页」分组）行为正确；新建标签初始标题「新标签页」；');
  console.log('   标签标题过长时省略号截短；窗口缩放/最大化时标签条与内容区布局同步；服务崩溃时各标签呈现恢复遮罩。');
  console.log('9. 跨启动标签恢复（真实使用路径）：正常使用数个标签后退出重开，标签集合/顺序/激活项恢复；');
  console.log('   macOS 关窗后经 Dock 重开同样恢复；删除/损坏 tab-state.json 后启动回落单标签首页。');
  console.log('10. 窗口 chrome 融合（契约 §17）：标签条空白区可拖动窗口、双击标签条缩放；红绿灯位于标签条内垂直居中且不遮挡首标签；');
  console.log('11. 标签快捷键（契约 §17.1 第四次修订/§17.1.2）：⌘1–⌘9、⌘0（第 10 个标签）按下标切换、超出当前标签数时无操作；⌘←/⌘→ 不再切换标签，由页面接管主视图切换（文本输入框内光标跳转不再被遮蔽）；Ctrl±Tab 循环切换保留；返回/前进仍为 ⌘[/⌘]；');
  console.log('12. 全屏吸附（契约 §17.1.1）：真实进出全屏（视图 → 全屏或 ⌃⌘F）时标签条吸附靠左（红绿灯安全区取消）、退出后恢复 78px 安全区；全屏过渡动画期间无布局跳动。');
    process.exit(failed.length === 0 ? 0 : 1);
  }
}

main().catch((err) => {
  console.error(`[FAIL] 自验脚本自身异常：${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
