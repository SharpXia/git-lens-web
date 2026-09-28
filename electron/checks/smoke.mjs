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
 *     关闭最后一个标签触发窗口退出协议与无孤儿校验。
 *
 * 运行：node electron/checks/smoke.mjs
 * 纯 GUI 项（菜单、原生对话框、窗口状态恢复的视觉表现）无法自动化，
 * 以文末「人工验证清单」输出。
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainJsPath = path.resolve(__dirname, '../main.js');
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
 */
function buildAppEnv(ctx) {
  return {
    ...process.env,
    GIT_LENS_USER_DATA: path.join(ctx.root, 'user-data'),
    GIT_LENS_E2E_READY_FILE: ctx.readyFile,
    GIT_LENS_E2E_TOKEN_FILE: ctx.tokenFile,
    GIT_LENS_TEST_MODE: '1',
    GIT_LENS_TEST_RUN_ID: ctx.runId,
    GIT_CONFIG_GLOBAL: path.join(ctx.root, 'gitconfig'),
    XDG_CONFIG_HOME: path.join(ctx.root, 'xdg-config'),
  };
}

/**
 * 启动一个 Electron 应用进程并收集其输出。
 * @param {{root: string, readyFile: string, tokenFile: string, runId: string}} ctx
 * @param {string} label - 日志标签
 * @param {string[]} [extraArgs] - 附加命令行参数（如 CDP 调试开关）
 * @returns {{child: import('node:child_process').ChildProcess, tail: () => string}}
 */
function launchApp(ctx, label, extraArgs = []) {
  const child = spawn(electronBinary, [mainJsPath, ...extraArgs], {
    env: buildAppEnv(ctx),
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
 * 建立到指定页面目标的 CDP WebSocket 连接（Node 内置 WebSocket），
 * 封装 Runtime.evaluate（returnByValue + awaitPromise）。
 * @param {number} cdpPort - 调试端口
 * @param {string} targetId - 页面目标 id
 */
function connectCdpPage(cdpPort, targetId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${cdpPort}/devtools/page/${targetId}`);
    let seq = 0;
    const pending = new Map();
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
      close: () => ws.close(),
    });
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rej(new Error(message.error.message));
        else res(message.result);
      }
    };
    ws.onerror = () => reject(new Error(`CDP WebSocket 连接失败：target ${targetId}`));
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

  const app = launchApp(ctx, 'tabs', ['--remote-debugging-port=0']);

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

  // 5. 标题按 page title 更新并同步到标签条（先等各页面加载出真实 title，
  //    避免读到加载中途的空标题）
  for (const id of creationOrder) {
    await waitFor(async () => {
      const title = await conns.get(id).evaluate('document.title');
      return typeof title === 'string' && title.includes('Git Lens') ? title : null;
    }, 10000);
  }
  const pageTitles = [];
  for (const id of creationOrder) {
    pageTitles.push(await conns.get(id).evaluate('document.title'));
  }
  const barTitles = (await tabbarDom.titles()) || [];
  const titlesOk = pageTitles.every((title) => typeof title === 'string' && title.includes('Git Lens'))
    && barTitles.length === 3
    && barTitles.every((title) => pageTitles.includes(title));
  assert('多标签场景：3 个标签标题均取自页面 title 并同步到标签条', titlesOk, JSON.stringify({ pageTitles, barTitles }));

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

  for (const conn of conns.values()) conn.close();

  // 8. 点击「×」关闭第 3 个标签 → 对应 CDP 目标消失（webContents 销毁）
  const closedId = creationOrder[2];
  await tabbarDom.clickClose(2);
  const destroyedThird = await waitFor(async () => {
    const list = await fetchCdpTargets(cdpPort);
    return appTargetsOf(list).length === 2 && !appTargetsOf(list).some((item) => item.id === closedId) ? true : null;
  }, 10000);
  assert('多标签场景：点击「×」后第 3 个标签视图销毁（CDP 目标消失）', destroyedThird === true, `closedTarget=${closedId}`);

  // 9. 逐个关闭剩余标签；关闭最后一个触发关窗退出协议
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

  // 10. 销毁回执：主进程日志逐标签记录 webContents 已销毁（isDestroyed 证据）
  const destroyedLogs = (app.tail().match(/webContents 已销毁/g) || []).length;
  assert('多标签场景：3 个标签 webContents 均确认销毁（destroyed 回执日志 ≥3）', destroyedLogs >= 3, `日志计数=${destroyedLogs}`);

  tabbar.close();
  const failedHere = results.some((item) => !item.ok && item.name.startsWith('多标签场景'));
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
    console.log('1. 应用菜单：刷新(Cmd+R)、返回/前进、缩放(Cmd+=/-/0)、复制/粘贴、帮助(关于/复制诊断信息) 均生效且作用于页面；');
    console.log('2. 「帮助 → 复制诊断信息」剪贴板内容完整（含 git 版本与服务状态）；');
    console.log('3. 原生目录选择对话框（页面添加扫描目录 / window.gitLens.chooseDirectory()）可选目录、取消返回空；');
    console.log('4. 服务崩溃恢复遮罩：深色中文文案、倒计时与「退出应用」按钮表现；恢复期间应用文档不导航（sessionStorage 保留），重启后同端口 reload；');
    console.log('5. 窗口拖动/缩放后重开位置尺寸恢复；外接显示器拔除后窗口自动回到可见区域；');
    console.log('6. 页面内外链点击经系统浏览器打开且不产生新应用窗口；');
    console.log('7. 未设置 GIT_LENS_DEVTOOLS 时 F12/Cmd+Shift+I 不唤起 devtools；设置后可用。');
    console.log('8. 多标签：⌘T/⌘W/Ctrl+Tab（及菜单「标签页」分组）行为正确；新建标签初始标题「新标签页」；');
    console.log('   标签标题过长时省略号截短；窗口缩放/最大化时标签条与内容区布局同步；服务崩溃时各标签呈现恢复遮罩。');
    process.exit(failed.length === 0 ? 0 : 1);
  }
}

main().catch((err) => {
  console.error(`[FAIL] 自验脚本自身异常：${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
