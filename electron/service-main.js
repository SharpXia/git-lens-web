/**
 * Git Lens 桌面版服务子进程入口。
 *
 * 由 Electron 主进程经 `utilityProcess.fork` 启动（实测支持 ESM 入口与 MessagePort
 * 传递，选型依据见 G2 交付报告；`child_process.fork` 仅作兼容性备选，不采用）。
 *
 * 职责：
 *  1. 以 `mode: 'desktop'`、随机端口（port: 0）启动服务工厂 `src/git-lens-server.js`；
 *  2. 就绪后向主进程回传 `{ type: 'ready', host, port, pid }`；
 *  3. 收到关闭请求时调用工厂 `close()` 优雅退出，配合主进程的退出协议；
 *  4. 未捕获异常上报主进程后退出，由主进程监督并展示恢复页；
 *  5. 经 MessagePort 桥接主进程原生目录选择对话框，桥接不可用时回退为工厂
 *     自带的系统对话框实现。
 *
 * 与主进程的全部约定通过环境变量与结构化消息传递：
 *  - 环境变量：GIT_LENS_DESKTOP_CONFIG_DIR（必填）、GIT_LENS_SESSION_TOKEN（必填）、
 *    GIT_LENS_GIT_PATH / GIT_LENS_TEST_MODE / GIT_LENS_TEST_RUN_ID（可选，原样透传）；
 *  - 子 → 父消息：`{type:'ready'|'fatal'|'uncaught-error'|'stopped'|'log', ...}`；
 *  - 父 → 子消息：`{type:'close'}`，或携带 MessagePort 的 `{type:'dialog-port'}`。
 */

// 本模块只能被 Electron 主进程经 utilityProcess 启动；直接用 node 运行属于误用
const parentPort = process.parentPort;
if (!parentPort) {
  console.error('Git Lens 服务子进程必须由 Electron 主进程通过 utilityProcess 启动');
  process.exit(1);
}

import { createGitLensServer, chooseScanDirectory as systemChooseScanDirectory } from '../src/git-lens-server.js';

/** 工厂实例；启动成功后供优雅关闭使用 */
let server = null;
/** 是否已进入关闭流程（关闭请求与退出钩子可能并发触发） */
let closing = false;

// ---- 目录选择桥接：把 /api/choose-scan-directory 转到主进程原生对话框 ----

let dialogPort = null;
let dialogSeq = 0;
const pendingDialogs = new Map();

/**
 * 请求主进程弹出原生目录选择对话框。
 * 桥接端口尚未建立时回退为工厂自带的系统对话框实现（osascript 等），
 * 保证桌面化早期页面仍可走既有 HTTP 接口完成目录选择。
 * @returns {Promise<string|null>} 用户选择的目录绝对路径；取消返回 null
 */
function chooseDirectoryViaBridge() {
  if (!dialogPort) return systemChooseScanDirectory();
  return new Promise((resolve, reject) => {
    const id = ++dialogSeq;
    pendingDialogs.set(id, { resolve, reject });
    dialogPort.postMessage({ type: 'choose-directory', id });
  });
}

/**
 * 接管主进程转交的 MessagePort，建立目录选择桥接。
 * 端口关闭（主进程异常退出）时清空桥接并拒绝在途请求，后续调用回退系统对话框。
 * @param {Electron.MessagePortMain} port - 主进程 MessageChannel 的远端端口
 */
function attachDialogPort(port) {
  dialogPort = port;
  port.on('message', (event) => {
    const message = event.data;
    if (!message || message.type !== 'choose-directory-result') return;
    const pending = pendingDialogs.get(message.id);
    if (!pending) return;
    pendingDialogs.delete(message.id);
    if (message.canceled) pending.resolve(null);
    else pending.resolve(typeof message.directory === 'string' ? message.directory : null);
  });
  // MessagePort 需要显式 start 才会开始投递消息
  port.start();
  port.on('close', () => {
    dialogPort = null;
    const error = new Error('目录选择桥接已断开：主进程不可用');
    for (const pending of pendingDialogs.values()) pending.reject(error);
    pendingDialogs.clear();
  });
}

/** 向主进程发送结构化消息 */
function send(message) {
  parentPort.postMessage(message);
}

/** 上报启动期致命错误，由主进程展示恢复页并决定是否重启 */
function reportFatal(err) {
  send({ type: 'fatal', message: err && err.message ? err.message : String(err) });
}

/** 收到关闭请求：调用工厂 close()（停止接新连接 → 等在途请求 → 超时强销）后退出 */
async function gracefulClose() {
  if (closing) return;
  closing = true;
  try {
    if (server) await server.close();
  } catch {
    // 工厂 close() 幂等且内部兜底，到这里仍失败也必须退出，避免僵死进程
  }
  send({ type: 'stopped' });
  process.exit(0);
}

parentPort.on('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'dialog-port' && Array.isArray(event.ports) && event.ports.length > 0) {
    attachDialogPort(event.ports[0]);
  } else if (message.type === 'close') {
    gracefulClose();
  }
});

/**
 * 解析主进程注入的偏好端口（崩溃重启时复用原端口，保证页面同源 reload，
 * sessionStorage 不因跨源导航丢失——DEF-002 修复的一部分）。
 * 非法值一律忽略并回退随机端口。
 * @param {string|undefined} value - GIT_LENS_DESKTOP_PREFERRED_PORT 环境变量
 * @returns {number|null}
 */
function parsePreferredPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return port;
}

/**
 * 读取环境并启动服务工厂。
 * handshake 仅在 GIT_LENS_TEST_MODE=1 且提供 runId 时注入（契约 §3，
 * 双条件缺一不可，生产实例不可探测）。
 */
async function main() {
  const configDir = process.env.GIT_LENS_DESKTOP_CONFIG_DIR;
  const sessionToken = process.env.GIT_LENS_SESSION_TOKEN;
  if (!configDir) throw new Error('服务子进程缺少 GIT_LENS_DESKTOP_CONFIG_DIR 环境变量，无法确定配置目录');
  if (!sessionToken) throw new Error('服务子进程缺少 GIT_LENS_SESSION_TOKEN 环境变量，desktop 模式必须提供会话凭据');

  const testRunId = process.env.GIT_LENS_TEST_MODE === '1' ? (process.env.GIT_LENS_TEST_RUN_ID || '') : '';
  const factoryOptions = (port) => ({
    configDir,
    host: '127.0.0.1',
    port,
    mode: 'desktop',
    sessionToken,
    chooseScanDirectory: chooseDirectoryViaBridge,
    handshake: testRunId ? { runId: testRunId } : null,
    // 服务日志统一转交主进程输出，便于打包后归集到诊断信息
    log: (level, message) => send({ type: 'log', level, message }),
  });

  // 优先复用崩溃前的端口；被其他进程抢占（或复用失败）时回退系统分配随机端口
  const preferredPort = parsePreferredPort(process.env.GIT_LENS_DESKTOP_PREFERRED_PORT);
  if (preferredPort && preferredPort !== 9527) {
    try {
      const preferred = createGitLensServer(factoryOptions(preferredPort));
      const address = await preferred.ready;
      server = preferred;
      send({ type: 'ready', host: address.host, port: address.port, pid: process.pid });
      return;
    } catch (err) {
      send({ type: 'log', level: 'warn', message: `复用原端口 ${preferredPort} 失败（${err && err.message ? err.message : err}），回退系统分配端口` });
    }
  }

  const instance = createGitLensServer(factoryOptions(0));
  server = instance;

  const { host, port } = await instance.ready;
  send({ type: 'ready', host, port, pid: process.pid });
}

// 未捕获异常上报主进程后退出（退出事件驱动主进程的监督与自动重启）
process.on('uncaughtException', (err) => {
  try {
    send({ type: 'uncaught-error', message: err && err.stack ? err.stack : String(err) });
  } catch {
    // 上报失败也无法恢复，直接退出
  }
  process.exit(1);
});

// 未处理的 Promise 拒绝只记录不上抛：服务内部请求处理已逐请求兜底，
// 单次异步失败不应拖垮整个服务进程
process.on('unhandledRejection', (reason) => {
  send({ type: 'log', level: 'error', message: '服务子进程出现未处理的 Promise 拒绝：' + (reason && reason.stack ? reason.stack : String(reason)) });
});

// 主进程断开（含被强杀）时自退出，防止孤儿服务继续占用端口
parentPort.on('close', () => {
  process.exit(0);
});

main().catch((err) => {
  reportFatal(err);
  process.exit(1);
});
