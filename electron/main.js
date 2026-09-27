/**
 * Git Lens Web 桌面版 Electron 主进程。
 *
 * 职责（计划书 §3 / 契约 §4、§6、§13）：
 *  - 单实例锁：第二次启动转为激活已有窗口；
 *  - 监督独立服务子进程（utilityProcess）：等待就绪、意外退出时指数退避自动重启
 *    （上限 3 次，成功后清零）、应用退出时请求优雅关闭并兜底 SIGKILL；
 *  - 生成仅存主进程的会话凭据，经 webRequest 仅对本机 /api 请求注入请求头；
 *  - 受限 BrowserWindow：contextIsolation + sandbox，加载 http://127.0.0.1:<随机端口>/，
 *    拦截跨源导航、新窗口与权限请求；
 *  - 原生能力 IPC（契约 §6）：运行时信息、目录选择、服务状态推送、外链打开；
 *  - 应用菜单：刷新、前进/后退、缩放、编辑、帮助（关于 + 复制诊断信息）、退出；
 *  - 窗口位置尺寸持久化，恢复时校验可见显示器并夹紧；
 *  - Git 依赖发现：不阻塞启动，结果经 runtime-info 提供给渲染层呈现修复建议。
 */

import {
  app,
  BrowserWindow,
  MessageChannelMain,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  screen,
  session,
  shell,
  utilityProcess,
} from 'electron';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 窗口默认与最小尺寸（G2 契约） */
const WINDOW_DEFAULT_WIDTH = 1280;
const WINDOW_DEFAULT_HEIGHT = 800;
const WINDOW_MIN_WIDTH = 960;
const WINDOW_MIN_HEIGHT = 600;

/** 服务自动重启上限（连续失败次数，成功就绪后清零） */
const SERVICE_RESTART_MAX_ATTEMPTS = 3;
/** 优雅关闭等待上限；超时先 SIGTERM 兜底再 SIGKILL（契约 §13 无孤儿要求） */
const SERVICE_CLOSE_TIMEOUT_MS = 5000;
const SERVICE_SIGKILL_GRACE_MS = 2000;

/** 窗口状态文件名（存放在 userData 下）与防抖保存间隔 */
const WINDOW_STATE_FILE = 'window-state.json';
const WINDOW_STATE_SAVE_DEBOUNCE_MS = 500;

/** 恢复兜底检查延迟：给页面自身遮罩（onServiceState 驱动）的接管窗口 */
const RECOVERY_FALLBACK_DELAY_MS = 1200;

/** 各平台 git 常见安装目录；GUI 启动的 PATH 通常不含 Homebrew，需要增补探测 */
const GIT_SEARCH_DIRS = {
  darwin: ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'],
  linux: ['/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/snap/bin'],
  win32: ['C:\\Program Files\\Git\\cmd', 'C:\\Program Files (x86)\\Git\\cmd', 'C:\\Git\\cmd'],
};

// 应用名先于任何窗口/菜单创建设置，macOS 菜单栏与 userData 默认名都依赖它
app.setName('Git Lens Web');

// ---- E2E 钩子（契约 §13）：全部可选，生产用户不设置时零影响 ----
// GIT_LENS_USER_DATA 必须先于任何 userData 读写重定向，因此固定放在模块顶部；
// 就绪文件/token 文件路径在此只做解析，实际写入发生在服务就绪之后。

const e2eUserDataDir = process.env.GIT_LENS_USER_DATA
  ? path.resolve(process.env.GIT_LENS_USER_DATA)
  : null;
if (e2eUserDataDir) {
  app.setPath('userData', e2eUserDataDir);
}

const e2eReadyFile = process.env.GIT_LENS_E2E_READY_FILE
  ? path.resolve(process.env.GIT_LENS_E2E_READY_FILE)
  : null;

// 测试专用：把会话凭据写入该文件供 E2E 启动器发起带凭据请求（冻结契约暂未包含，
// 属 Shell 提议的补充钩子，见交付报告；不设置时完全无影响）
const e2eTokenFile = process.env.GIT_LENS_E2E_TOKEN_FILE
  ? path.resolve(process.env.GIT_LENS_E2E_TOKEN_FILE)
  : null;

// ---- 运行期状态 ----

/** 仅存主进程的本地 API 会话凭据（契约 §4.6：crypto 随机 ≥32 字节，不暴露给页面） */
const sessionToken = crypto.randomBytes(32).toString('hex');

/** 主窗口；服务未就绪时可能尚未创建 */
let mainWindow = null;
/** 服务子进程句柄；退出后置 null */
let serviceProcess = null;
/** 最近一次已知的服务进程 pid（写诊断与 ready 文件用） */
let servicePid = null;
/** 服务实际监听端口（就绪消息回传） */
let servicePort = null;
/** 最近一次服务实际端口；崩溃重启时优先复用，保证页面同源 reload（DEF-002） */
let lastServicePort = null;
/** 服务状态：starting | ready | restarting | crashed | stopped */
let serviceState = 'starting';
/** 连续重启计数，重启成功后清零 */
let restartAttempts = 0;
let restartTimer = null;
/** 服务最近一次致命原因（fatal 消息或退出推断） */
let lastServiceFailure = null;
/** 应用页面是否完成过首次加载（区分首启与重启恢复） */
let appEverLoaded = false;
/** 是否进入退出流程（避免关闭协议与监督逻辑互相触发） */
let shuttingDown = false;
/** 恢复遮罩兜底注入的延迟定时器（页面自身遮罩未接管时才注入） */
let recoveryFallbackTimer = null;
/** 目录选择桥接的主进程侧端口（与当前服务进程配对） */
let serviceDialogPort = null;
/** Git 发现结果（found/path/version），不阻塞启动 */
let gitInfo = { found: false, path: null, version: null, source: null };

/** 输出主进程日志（测试环境经 stdout 采集） */
function log(message) {
  console.log(`[git-lens] ${message}`);
}

/** 可中断的延时 */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/** 判断 pid 对应进程是否仍然存活 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** 桌面模式服务配置目录：固定在 userData 下（契约 §5） */
function getServiceConfigDir() {
  return path.join(app.getPath('userData'), 'git-lens-config');
}

/** 当前应用页面源（服务实际端口就绪后才有意义） */
function appOrigin() {
  return `http://127.0.0.1:${servicePort}`;
}

/** 当前应用页面地址（加载与同源判断统一走这里） */
function appUrl() {
  return `${appOrigin()}/`;
}

/** 渲染层可见的服务状态（契约 §6 只有四种取值） */
function rendererServiceState() {
  return serviceState === 'starting' ? 'restarting' : serviceState;
}

/** 向所有窗口广播服务状态 */
function broadcastServiceState() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('git-lens:service-state', rendererServiceState());
    }
  }
}

// ---- E2E 就绪文件写入（契约 §13） ----

/**
 * 原子写入文本文件：先写同目录临时文件再 rename 替换。
 * @param {string} filePath - 目标文件路径
 * @param {string} content - 写入内容
 */
async function atomicWriteFile(filePath, content) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fsp.writeFile(tmpPath, content, 'utf-8');
  await fsp.rename(tmpPath, filePath);
}

/**
 * 写 E2E 就绪文件：`{port, servicePid, mainPid, runId}`，
 * 服务重启成功重写（恢复基础形态），服务退出时并入 `"state":"crashed"`。
 * 未设置 GIT_LENS_E2E_READY_FILE 时不产生任何文件。
 * @param {{state?: string}} [extra] - 并入的额外字段（如崩溃状态）
 */
async function writeE2eReadyFile(extra = {}) {
  if (!e2eReadyFile) return;
  const payload = {
    port: servicePort,
    servicePid,
    mainPid: process.pid,
    runId: process.env.GIT_LENS_TEST_RUN_ID || null,
    ...extra,
  };
  try {
    await atomicWriteFile(e2eReadyFile, `${JSON.stringify(payload, null, 2)}\n`);
  } catch (err) {
    log(`写入 E2E 就绪文件失败：${err.message}`);
  }
}

// ---- Git 依赖发现（契约 §7；不阻塞启动） ----

/**
 * 执行 `git --version` 探测候选路径。
 * @param {string} gitPath - git 可执行文件路径或 PATH 解析名
 * @returns {Promise<{found: boolean, path: string, version: string|null}>}
 */
async function probeGitExecutable(gitPath) {
  try {
    const { stdout } = await execFileAsync(gitPath, ['--version'], { timeout: 5000 });
    return { found: true, path: gitPath, version: String(stdout).trim() || null };
  } catch (err) {
    log(`探测 git（${gitPath}）失败：${err.message}`);
    return { found: false, path: gitPath, version: null };
  }
}

/**
 * 判断候选路径是否存在且可执行。
 * @param {string} candidate - 候选 git 路径
 */
async function isExecutableFile(candidate) {
  try {
    await fsp.access(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 发现系统 Git：显式环境变量 > 常见安装目录 > 增补 PATH。
 * 找不到时不阻塞启动，由渲染层配合诊断接口呈现中文修复建议。
 * @returns {Promise<object>} 含 found/path/version/source 的发现结果
 */
async function discoverGit() {
  const explicitPath = process.env.GIT_LENS_GIT_PATH;
  if (explicitPath) {
    const result = await probeGitExecutable(explicitPath);
    return { ...result, source: 'GIT_LENS_GIT_PATH 环境变量' };
  }
  for (const dir of GIT_SEARCH_DIRS[process.platform] || []) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git');
    if (!(await isExecutableFile(candidate))) continue;
    const result = await probeGitExecutable(candidate);
    if (result.found) return { ...result, source: '常见安装目录探测' };
  }
  // 兜底交给 PATH 解析；增补后的 PATH 同时注入服务子进程，保证两侧行为一致
  const result = await probeGitExecutable('git');
  return { ...result, source: 'PATH' };
}

/**
 * 构造服务子进程环境：透传现有环境（含 GIT_LENS_TEST_MODE / GIT_LENS_TEST_RUN_ID /
 * GIT_LENS_GIT_PATH），补充桌面配置目录与会话凭据，并增补 PATH 以便服务侧 git 可用。
 */
function buildServiceEnv() {
  const pathSeparator = process.platform === 'win32' ? ';' : ':';
  const extraDirs = GIT_SEARCH_DIRS[process.platform] || [];
  return {
    ...process.env,
    GIT_LENS_DESKTOP_CONFIG_DIR: getServiceConfigDir(),
    GIT_LENS_SESSION_TOKEN: sessionToken,
    PATH: [...extraDirs, process.env.PATH || ''].filter(Boolean).join(pathSeparator),
  };
}

// ---- 服务监督 ----

/**
 * 启动服务子进程并建立消息通道。
 * 每次启动新建目录选择 MessageChannel：旧通道随旧进程一起废弃。
 */
function startService() {
  const env = buildServiceEnv();
  // 崩溃重启时优先复用原端口：同端口让页面 reload 保持同源，sessionStorage
  // 不因跨源导航丢失（DEF-002 修复的另一半）；端口被抢占由服务侧回退随机端口
  if (lastServicePort) {
    env.GIT_LENS_DESKTOP_PREFERRED_PORT = String(lastServicePort);
  }
  const child = utilityProcess.fork(path.join(__dirname, 'service-main.js'), [], {
    serviceName: 'git-lens-service',
    env,
  });
  serviceProcess = child;
  child.on('message', (message) => onServiceMessage(child, message));
  child.on('exit', (exitCode) => onServiceExit(child, exitCode));

  const { port1, port2 } = new MessageChannelMain();
  port1.on('message', (event) => onServiceDialogRequest(event.data));
  port1.start();
  serviceDialogPort = port1;
  child.postMessage({ type: 'dialog-port' }, [port2]);
  // fork 返回时 child.pid 可能尚未就绪，真实 pid 以 ready 消息回传为准
  log('已启动服务子进程');
}

/**
 * 处理服务子进程消息。
 * @param {Electron.UtilityProcess} child - 消息来源进程
 * @param {object} message - 结构化消息（见 service-main.js 头注释）
 */
function onServiceMessage(child, message) {
  // 旧进程的迟到消息一律忽略，避免干扰新监督周期
  if (child !== serviceProcess || !message || typeof message !== 'object') return;
  // 实测 Electron 会静默吞掉消息回调里的异常（如引用错误），
  // 必须自行兜底记录，否则窗口创建等关键路径故障无任何痕迹
  try {
    switch (message.type) {
    case 'ready':
      onServiceReady(message);
      break;
    case 'fatal':
      lastServiceFailure = message.message;
      log(`服务启动失败：${message.message}`);
      break;
    case 'uncaught-error':
      lastServiceFailure = message.message;
      log(`服务子进程未捕获异常：${message.message}`);
      break;
    case 'log':
      if (message.level === 'error') console.error(`[service] ${message.message}`);
      else if (message.level === 'warn') console.warn(`[service] ${message.message}`);
      else console.log(`[service] ${message.message}`);
      break;
    default:
      break;
    }
  } catch (err) {
    log(`处理服务消息 ${message.type} 时发生异常：${err && err.stack ? err.stack : err}`);
  }
}

/**
 * 服务就绪：记录端口与 pid、注入凭据过滤、把应用文档带回窗口（首次创建，
 * 重启后同文档 reload），并按契约 §13 在重启成功时重写就绪文件。
 * @param {{port: number, pid: number}} message - ready 消息
 */
function onServiceReady(message) {
  const isFirstReady = !appEverLoaded;
  const previousPort = servicePort;
  servicePort = message.port;
  servicePid = message.pid;
  lastServicePort = message.port;
  serviceState = 'ready';
  restartAttempts = 0;
  lastServiceFailure = null;
  cancelRecoveryFallback();
  registerTokenFilter();
  broadcastServiceState();
  log(`本地服务已就绪：http://127.0.0.1:${servicePort}（pid ${servicePid}）`);
  ensureAppDocument(previousPort);
  if (!isFirstReady) {
    // 契约 §13：服务重启成功后按基础形态重写就绪文件
    void writeE2eReadyFile();
  }
}

/**
 * 服务子进程退出：主动关闭流程不介入，意外退出交给监督重启。
 * @param {Electron.UtilityProcess} child - 退出的进程
 * @param {number} exitCode - 退出码
 */
function onServiceExit(child, exitCode) {
  if (child !== serviceProcess) return;
  serviceProcess = null;
  if (serviceDialogPort) {
    serviceDialogPort.close();
    serviceDialogPort = null;
  }
  log(`服务子进程退出（exit code ${exitCode}）`);
  if (shuttingDown) return;
  scheduleRestart();
}

/**
 * 把应用文档带回主窗口（DEF-002 修复的关键路径）：
 * - 应用页已加载且端口未变：用 reload() 同文档同源重载——不交换 browsing
 *   context group，同源 sessionStorage 完整保留，用户选中状态不丢失；
 * - 端口变更（重启复用端口被抢占的罕见回退）：只能跨源导航，会话状态丢失，
 *   记日志说明；
 * - 窗口还在但只展示过首启恢复页：无会话状态可丢，直接换地址加载应用页；
 * - 窗口不存在：创建并加载应用页。
 * @param {number|null} previousPort - 重启前的服务端口（null 表示首次就绪）
 */
function ensureAppDocument(previousPort) {
  if (mainWindow && !mainWindow.isDestroyed() && appEverLoaded) {
    if (previousPort === null || previousPort === servicePort) {
      mainWindow.webContents.reload();
    } else {
      log(`服务端口由 ${previousPort} 变为 ${servicePort}，页面跨源导航，崩溃前的会话状态无法保留`);
      mainWindow.loadURL(appUrl());
    }
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(appUrl());
    return;
  }
  createMainWindow(appUrl());
}

/**
 * 意外退出后的监督决策：指数退避自动重启，连续失败达到上限后放弃并保持恢复页。
 */
function scheduleRestart() {
  const reason = lastServiceFailure || '服务进程意外退出';
  lastServiceFailure = null;
  // 契约 §13：服务退出即并入 state:crashed 重写就绪文件（重启成功后会被基础形态覆盖）
  void writeE2eReadyFile({ state: 'crashed' });
  if (restartAttempts >= SERVICE_RESTART_MAX_ATTEMPTS) {
    serviceState = 'crashed';
    broadcastServiceState();
    presentRecoveryUx('crashed', `${reason}；自动恢复已达上限（${SERVICE_RESTART_MAX_ATTEMPTS} 次）`, false);
    return;
  }
  restartAttempts += 1;
  const delayMs = 1000 * 2 ** (restartAttempts - 1);
  serviceState = 'restarting';
  broadcastServiceState();
  log(`将在 ${delayMs}ms 后进行第 ${restartAttempts}/${SERVICE_RESTART_MAX_ATTEMPTS} 次自动重启：${reason}`);
  presentRecoveryUx('restarting', reason, true);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startService();
  }, delayMs);
}

/**
 * 优雅关闭服务：请求 close → 等待退出 → 超时 SIGKILL 兜底，保证无孤儿服务。
 */
async function shutdownService() {
  cancelRecoveryFallback();
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const child = serviceProcess;
  const pid = servicePid;
  serviceProcess = null;
  if (!child) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    child.postMessage({ type: 'close' });
  } catch {
    // 进程已死时 postMessage 可能抛错，退出事件兜底
  }
  const exitedGracefully = await Promise.race([
    exited.then(() => true),
    delay(SERVICE_CLOSE_TIMEOUT_MS).then(() => false),
  ]);
  if (!exitedGracefully && pid && isPidAlive(pid)) {
    log(`服务未在 ${SERVICE_CLOSE_TIMEOUT_MS}ms 内退出，执行 SIGKILL`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 进程恰好退出时忽略
    }
    await Promise.race([exited, delay(SERVICE_SIGKILL_GRACE_MS)]);
  }
}

// ---- 目录选择桥接（服务进程 ↔ 主进程对话框） ----

/**
 * 响应服务进程的目录选择请求：弹出原生对话框并把结果回传到桥接端口。
 * @param {{type: string, id: number}} data - 服务进程请求
 */
async function onServiceDialogRequest(data) {
  if (!serviceDialogPort || !data || data.type !== 'choose-directory') return;
  let directory = null;
  let canceled = true;
  try {
    const result = await showDirectoryDialog();
    if (result) {
      directory = result;
      canceled = false;
    }
  } catch (err) {
    log(`目录选择对话框失败：${err.message}`);
  }
  try {
    serviceDialogPort.postMessage({ type: 'choose-directory-result', id: data.id, directory, canceled });
  } catch {
    // 服务进程可能已退出，端口随之失效
  }
}

/**
 * 弹出原生目录选择对话框（取消返回 null）。
 * @returns {Promise<string|null>}
 */
async function showDirectoryDialog() {
  const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const result = await dialog.showOpenDialog(owner, {
    title: '选择目录',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

// ---- 会话凭据注入（契约 §4.6） ----

/**
 * 仅对本机 /api 请求附加会话凭据头；其余 URL 一律不触碰。
 * 服务重启后端口可能变化，重新注册以覆盖新端口（Electron 单监听器语义为替换）。
 */
function registerTokenFilter() {
  if (!servicePort) return;
  const filter = {
    urls: [`http://127.0.0.1:${servicePort}/api/*`, `http://localhost:${servicePort}/api/*`],
  };
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    details.requestHeaders['X-Git-Lens-Session'] = sessionToken;
    callback({ requestHeaders: details.requestHeaders });
  });
}

// ---- 窗口管理与安全边界 ----

/**
 * 判断 URL 是否为当前应用同源地址。
 * @param {string} url - 待检 URL
 */
function isSameOriginAppUrl(url) {
  if (!servicePort || typeof url !== 'string') return false;
  return url === appOrigin() || url.startsWith(`${appOrigin()}/`);
}

/**
 * 校验并经系统浏览器打开外部链接；非 http/https 一律忽略。
 * @param {string} url - 待打开的 URL
 */
function openExternalIfHttp(url) {
  if (typeof url !== 'string') return;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
  shell.openExternal(url).catch((err) => log(`打开外部链接失败：${err.message}`));
}

/**
 * 判断输入事件是否为 devtools 快捷键（F12 / Cmd|Ctrl + Shift|Alt + I/C/J）。
 * @param {{key: string, control: boolean, meta: boolean, shift: boolean, alt: boolean}} input
 */
function isDevtoolsShortcut(input) {
  if (input.key === 'F12') return true;
  const modifier = input.control || input.meta;
  const secondary = input.shift || input.alt;
  const key = (input.key || '').toLowerCase();
  return modifier && secondary && ['i', 'c', 'j'].includes(key);
}

/**
 * 附加窗口安全边界：同源导航、拒绝新窗口、拒绝权限请求、
 * 拒绝 webview、非调试模式下拦截 devtools 快捷键。
 * @param {Electron.BrowserWindow} win - 目标窗口
 */
function attachWindowGuards(win) {
  const webContents = win.webContents;

  webContents.on('will-navigate', (event, url) => {
    if (isSameOriginAppUrl(url)) return;
    event.preventDefault();
    openExternalIfHttp(url);
  });

  webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfHttp(url);
    return { action: 'deny' };
  });

  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  // GIT_LENS_DEVTOOLS=1 时保留调试开关（不拦截快捷键，菜单中也不提供入口）
  webContents.on('before-input-event', (event, input) => {
    if (process.env.GIT_LENS_DEVTOOLS === '1') return;
    if (isDevtoolsShortcut(input)) event.preventDefault();
  });

  // 应用页面首次加载完成：记录标记（区分首启与重启恢复）并按契约 §13
  // 在「服务就绪且窗口完成首次加载」后写入就绪文件
  webContents.on('did-finish-load', () => {
    if (!isSameOriginAppUrl(webContents.getURL())) return;
    appEverLoaded = true;
    void writeE2eReadyFile();
  });

  // 加载失败与渲染进程异常退出必须有日志，否则恢复页之外的问题无从排查
  webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    // -3 (ABORTED) 是导航被取消的正常噪音（如加载中途切换页面）
    if (errorCode === -3) return;
    log(`页面加载失败（${errorDescription}，code ${errorCode}）：${validatedURL}`);
  });
  webContents.on('render-process-gone', (_event, details) => {
    log(`渲染进程异常退出：${details.reason}`);
  });
}

/**
 * 读取窗口状态文件；无有效数据时返回 null。
 */
function loadWindowState() {
  try {
    const raw = fs.readFileSync(path.join(app.getPath('userData'), WINDOW_STATE_FILE), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 判断窗口边界是否仍在某个可见显示器的工作区内
 *（两轴交叠 ≥100px，处理显示器被移除的场景）。
 * @param {{x: number, y: number, width: number, height: number}} bounds
 */
function isBoundsVisible(bounds) {
  const requiredOverlap = 100;
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapWidth = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapHeight = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapWidth >= requiredOverlap && overlapHeight >= requiredOverlap;
  });
}

/**
 * 从持久化状态恢复窗口几何；越界或损坏时返回 null 使用默认值居中。
 */
function restoredWindowBounds() {
  const raw = loadWindowState();
  if (!raw || typeof raw !== 'object') return null;
  const { x, y, width, height } = raw;
  const valid = [x, y, width, height].every((value) => Number.isFinite(value));
  const bounds = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(WINDOW_MIN_WIDTH, Math.round(width)),
    height: Math.max(WINDOW_MIN_HEIGHT, Math.round(height)),
  };
  if (!valid || !isBoundsVisible(bounds)) return null;
  return { bounds, isMaximized: Boolean(raw.isMaximized) };
}

/**
 * 防抖持久化窗口状态；关闭窗口时立即落盘。
 * @param {Electron.BrowserWindow} win - 目标窗口
 */
function trackWindowState(win) {
  let timer = null;
  const saveNow = () => {
    if (win.isDestroyed()) return;
    const payload = {
      // 最大化时记录还原后的几何，避免把最大化尺寸当成用户偏好
      ...win.getNormalBounds(),
      isMaximized: win.isMaximized(),
    };
    try {
      fs.writeFileSync(path.join(app.getPath('userData'), WINDOW_STATE_FILE), JSON.stringify(payload, null, 2));
    } catch (err) {
      log(`保存窗口状态失败：${err.message}`);
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(saveNow, WINDOW_STATE_SAVE_DEBOUNCE_MS);
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    saveNow();
  });
}

/**
 * 创建主窗口并加载地址（无地址时加载恢复页）。
 * @param {string} [initialUrl] - 初始加载地址；缺省时展示启动恢复页
 */
function createMainWindow(initialUrl) {
  const restored = restoredWindowBounds();
  mainWindow = new BrowserWindow({
    width: restored ? restored.bounds.width : WINDOW_DEFAULT_WIDTH,
    height: restored ? restored.bounds.height : WINDOW_DEFAULT_HEIGHT,
    ...(restored ? { x: restored.bounds.x, y: restored.bounds.y } : {}),
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    title: 'Git Lens Web',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (restored && restored.isMaximized) mainWindow.maximize();
  attachWindowGuards(mainWindow);
  trackWindowState(mainWindow);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadURL(initialUrl || buildRecoveryPageUrl('restarting', '本地服务正在启动', true));
}

/**
 * 恢复期 UX 入口（DEF-002 修复）：崩溃/重启期间绝不导航离开应用页文档。
 *
 * 页面自身已实现深色服务遮罩（public/app.js 的 #serviceStateOverlay，经
 * 契约 §6 onServiceState 即时驱动，配色取 app.css :root 变量），文档不销毁
 * 时它自然接管；这里只安排一次兜底检查——短暂宽限后页面遮罩仍不可见
 * （渲染层早退、页面脚本未就绪等），才向当前文档注入等价的深色遮罩。
 * 应用页尚未加载（首启即失败）时没有会话状态可丢，直接使用内联恢复页。
 * @param {'restarting'|'crashed'} state - 恢复状态
 * @param {string} reason - 失败原因（中文）
 * @param {boolean} autoRecover - 是否仍在自动恢复
 */
function presentRecoveryUx(state, reason, autoRecover) {
  cancelRecoveryFallback();
  recoveryFallbackTimer = setTimeout(() => {
    recoveryFallbackTimer = null;
    armRecoveryFallback(state, reason, autoRecover);
  }, RECOVERY_FALLBACK_DELAY_MS);
}

/** 取消尚未触发的兜底注入检查（服务已就绪或应用退出时） */
function cancelRecoveryFallback() {
  if (recoveryFallbackTimer) {
    clearTimeout(recoveryFallbackTimer);
    recoveryFallbackTimer = null;
  }
}

/**
 * 兜底检查：页面自身遮罩可见则不干预；否则按窗口状态选择注入遮罩或展示恢复页。
 */
async function armRecoveryFallback(state, reason, autoRecover) {
  if (mainWindow && !mainWindow.isDestroyed() && appEverLoaded) {
    let pageOverlayVisible = false;
    try {
      // 只读探测页面自身遮罩的显示状态，不触碰页面数据
      pageOverlayVisible = await mainWindow.webContents.executeJavaScript(
        `(function () { var el = document.getElementById('serviceStateOverlay'); return !!(el && el.style.display !== 'none'); })()`,
      );
    } catch {
      // 渲染层异常时按遮罩不可见处理，尝试注入兜底
    }
    if (pageOverlayVisible) return;
    injectRecoveryOverlay(state, reason, autoRecover);
    return;
  }
  showStandaloneRecoveryPage(state, reason, autoRecover);
}

/**
 * 向当前应用文档注入全屏深色恢复遮罩（主进程 executeJavaScript，不受页面
 * CSP 约束）。遮罩拦截指针与键盘输入，避免旧数据可交互；服务恢复后的
 * 同文档 reload 会自然清除注入内容。
 */
function injectRecoveryOverlay(state, reason, autoRecover) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.executeJavaScript(buildRecoveryOverlayScript(state, reason, autoRecover))
    .catch((err) => log(`注入恢复遮罩失败：${err && err.message ? err.message : err}`));
}

/**
 * 展示独立恢复页：仅用于应用页从未加载（首启失败）或窗口刚重建的场景，
 * 此时无任何会话状态可丢，data: URL 导航无副作用。
 * @param {'restarting'|'crashed'} state - 恢复页状态
 * @param {string} reason - 失败原因（中文）
 * @param {boolean} autoRecover - 是否仍在自动恢复
 */
function showStandaloneRecoveryPage(state, reason, autoRecover) {
  const url = buildRecoveryPageUrl(state, reason, autoRecover);
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow(url);
    return;
  }
  mainWindow.loadURL(url);
}

/** HTML 文本转义，恢复页内嵌原因时防注入 */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 恢复状态对应的标题与说明文案（与页面自身遮罩语义一致） */
function recoveryCopy(state, autoRecover) {
  return {
    heading: state === 'restarting' ? '本地服务正在恢复' : '本地服务已停止',
    description: autoRecover
      ? '本地服务出现异常，应用正在自动重启服务，恢复完成后将自动返回页面。'
      : '本地服务多次自动恢复失败，已停止重启。您可以退出应用后重新启动，若反复出现请通过「帮助 → 复制诊断信息」反馈问题。',
  };
}

/**
 * 构造注入当前文档的恢复遮罩脚本。
 * 配色取 public/app.css :root 既有变量值（--card-bg/--border/--text 系列与
 * .service-overlay 的遮罩底色），与应用深色主题一致；描述文案限宽并
 * word-break，避免词组中间断行。全部动态文案经 JSON.stringify 字面量化，
 * 不拼接 HTML，防注入。
 * @param {'restarting'|'crashed'} state - 恢复状态
 * @param {string} reason - 失败原因
 * @param {boolean} autoRecover - 是否显示自动恢复倒计时
 */
function buildRecoveryOverlayScript(state, reason, autoRecover) {
  const { heading, description } = recoveryCopy(state, autoRecover);
  const data = JSON.stringify({ heading, description, reason: reason || '', autoRecover: Boolean(autoRecover) });
  return `(function () {
  var data = ${data};
  var OVERLAY_ID = 'git-lens-recovery-fallback';
  if (window.__gitLensRecoveryTeardown) { try { window.__gitLensRecoveryTeardown(); } catch (e) {} }
  var old = document.getElementById(OVERLAY_ID);
  if (old) { old.remove(); }
  var overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;'
    + 'background:rgba(1,4,9,0.72);backdrop-filter:blur(2px);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;';
  var card = document.createElement('div');
  card.style.cssText = 'max-width:440px;margin:0 16px;padding:28px 32px;text-align:center;word-break:break-word;'
    + 'background:#161b22;border:1px solid #30363d;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.4);color:#c9d1d9;';
  var title = document.createElement('h2');
  title.textContent = data.heading;
  title.style.cssText = 'font-size:17px;margin:0 0 8px;color:#f0f6fc;';
  var desc = document.createElement('p');
  desc.textContent = data.description;
  desc.style.cssText = 'font-size:13px;line-height:1.7;margin:8px 0;color:#8b949e;word-break:break-word;';
  var reasonEl = document.createElement('p');
  reasonEl.textContent = data.reason;
  reasonEl.style.cssText = 'font-size:12px;margin:8px 0;color:#8b949e;word-break:break-word;';
  var countdown = document.createElement('p');
  countdown.style.cssText = 'font-size:13px;margin:14px 0 0;color:#58a6ff;';
  var button = document.createElement('button');
  button.textContent = '退出应用';
  button.style.cssText = 'margin-top:16px;padding:7px 22px;font-size:13px;border-radius:6px;cursor:pointer;'
    + 'background:transparent;border:1px solid #30363d;color:#c9d1d9;';
  button.addEventListener('click', function () { window.close(); });
  card.appendChild(title);
  card.appendChild(desc);
  if (data.reason) { card.appendChild(reasonEl); }
  card.appendChild(countdown);
  card.appendChild(button);
  overlay.appendChild(card);
  (document.body || document.documentElement).appendChild(overlay);

  // 阻断输入：不透明遮罩挡住指针，捕获阶段拦截键盘事件，焦点移入遮罩
  function blockEvent(e) { e.stopPropagation(); }
  document.addEventListener('keydown', blockEvent, true);
  document.addEventListener('keypress', blockEvent, true);
  overlay.tabIndex = -1;
  overlay.focus();

  var remain = 10;
  function render() {
    countdown.textContent = data.autoRecover ? (remain > 0 ? '自动恢复倒计时：' + remain + ' 秒' : '即将重试…') : '';
  }
  render();
  var timer = data.autoRecover ? setInterval(function () { remain = remain > 0 ? remain - 1 : 10; render(); }, 1000) : null;
  // 重复注入（状态切换）时清理旧副作用；页面 reload 后一切自然重置
  window.__gitLensRecoveryTeardown = function () {
    if (timer) { clearInterval(timer); }
    document.removeEventListener('keydown', blockEvent, true);
    document.removeEventListener('keypress', blockEvent, true);
    try { delete window.__gitLensRecoveryTeardown; } catch (e) {}
  };
})();`;
}

/**
 * 构造独立内联恢复页（data: URL，仅用于应用页未加载的兜底场景）。
 * 深色主题与应用一致（取 app.css :root 变量值）；文案容器限宽 + word-break。
 * @param {'restarting'|'crashed'} state - 恢复页状态
 * @param {string} reason - 失败原因
 * @param {boolean} autoRecover - 是否显示自动恢复倒计时
 */
function buildRecoveryPageUrl(state, reason, autoRecover) {
  const { heading, description } = recoveryCopy(state, autoRecover);
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Git Lens Web</title>
<style>
  /* 深色主题与应用一致：取 public/app.css :root 既有变量值 */
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #0d1117; color: #c9d1d9; }
  .card { max-width: 440px; margin: 0 16px; padding: 28px 32px; background: #161b22; border: 1px solid #30363d;
          border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.4); text-align: center; word-break: break-word; }
  h1 { font-size: 17px; margin: 0 0 8px; color: #f0f6fc; }
  p { font-size: 13px; line-height: 1.7; color: #8b949e; margin: 8px 0; word-break: break-word; }
  .reason { font-size: 12px; }
  .countdown { font-size: 13px; color: #58a6ff; margin-top: 14px; }
  button { margin-top: 16px; padding: 7px 22px; font-size: 13px; border: 1px solid #30363d;
           border-radius: 6px; background: transparent; color: #c9d1d9; cursor: pointer; }
  button:hover { background: #21262d; }
</style>
</head>
<body>
<div class="card">
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(description)}</p>
  ${reason ? `<p class="reason">${escapeHtml(reason)}</p>` : ''}
  <p class="countdown" id="countdown"></p>
  <button id="quit">退出应用</button>
</div>
<script>
  var remain = 10;
  var el = document.getElementById('countdown');
  function render() { el.textContent = ${autoRecover ? ' remain > 0 ? ("自动恢复倒计时：" + remain + " 秒") : "即将重试…"' : '""'}; }
  render();
  ${autoRecover ? 'setInterval(function(){ remain = remain > 0 ? remain - 1 : 10; render(); }, 1000);' : ''}
  document.getElementById('quit').addEventListener('click', function () { window.close(); });
</script>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// ---- 诊断信息（帮助菜单；/api/diagnostics 可能 404，按契约降级） ----

/**
 * 请求服务诊断接口。Runtime 尚未实现时按 404 优雅降级，
 * 不影响本地诊断信息的复制。
 */
async function fetchServiceDiagnostics() {
  if (!servicePort) return { available: false, reason: '本地服务未就绪' };
  try {
    const response = await fetch(`${appOrigin()}/api/diagnostics`, {
      headers: { 'X-Git-Lens-Session': sessionToken },
      signal: AbortSignal.timeout(2000),
    });
    if (response.status === 404) {
      return { available: false, reason: '服务尚未提供 /api/diagnostics 接口（404，契约 §7 预留）' };
    }
    if (!response.ok) return { available: false, reason: `诊断接口返回 ${response.status}` };
    return { available: true, ...(await response.json()) };
  } catch (err) {
    return { available: false, reason: `诊断接口请求失败：${err.message}` };
  }
}

/** 收集诊断信息并复制到剪贴板，弹窗确认 */
async function copyDiagnostics() {
  const apiDiagnostics = await fetchServiceDiagnostics();
  const payload = {
    copiedAt: new Date().toISOString(),
    app: {
      name: 'Git Lens Web',
      version: app.getVersion(),
      electron: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
    },
    configDir: getServiceConfigDir(),
    git: gitInfo,
    service: {
      state: rendererServiceState(),
      port: servicePort,
      pid: servicePid,
      restartAttempts,
    },
    apiDiagnostics,
  };
  clipboard.writeText(JSON.stringify(payload, null, 2));
  await dialog.showMessageBox({
    type: 'info',
    message: '诊断信息已复制到剪贴板',
    detail: '包含应用版本、Git 环境、服务状态与诊断接口结果，反馈问题时可直接粘贴。',
  });
}

/** 关于对话框 */
function showAboutDialog() {
  dialog.showMessageBox({
    type: 'info',
    title: '关于',
    message: 'Git Lens Web',
    detail: `本地 Git 仓库透镜\n版本 ${app.getVersion()}\nElectron ${process.versions.electron} · ${process.platform}/${process.arch}`,
  });
}

/**
 * 构建应用菜单：刷新、前进/后退、缩放（作用于 webContents）、编辑角色、
 * 帮助（关于 + 复制诊断信息）、退出；macOS 保留标准 appMenu。
 * 不提供 devtools 菜单项（保留 GIT_LENS_DEVTOOLS 调试开关）。
 */
function buildApplicationMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'forceReload', label: '强制刷新' },
        { type: 'separator' },
        { role: 'back', label: '返回' },
        { role: 'forward', label: '前进' },
        { type: 'separator' },
        { role: 'zoomIn', label: '放大', accelerator: 'CmdOrCtrl+=' },
        { role: 'zoomOut', label: '缩小', accelerator: 'CmdOrCtrl+-' },
        { role: 'resetZoom', label: '实际大小', accelerator: 'CmdOrCtrl+0' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      role: 'help',
      submenu: [
        { label: '关于 Git Lens Web', click: showAboutDialog },
        { label: '复制诊断信息', click: copyDiagnostics },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC（契约 §6；渲染层经 window.gitLens 访问） ----

/**
 * 注册全部 IPC 通道。通道名统一使用 git-lens: 前缀；
 * 参数校验在 preload 已做一层，这里对安全敏感项（外链）再做主进程校验。
 */
function registerIpc() {
  ipcMain.handle('git-lens:get-runtime-info', () => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    configDir: getServiceConfigDir(),
    // 契约 §6 冻结字段之外的扩展（派发授权的 Git 诊断通道）：供渲染层呈现修复建议
    git: gitInfo,
  }));

  ipcMain.handle('git-lens:choose-directory', () => showDirectoryDialog());

  ipcMain.on('git-lens:subscribe-service-state', (event) => {
    // 订阅即回发当前状态，避免页面错过最近一次变化
    event.sender.send('git-lens:service-state', rendererServiceState());
  });

  ipcMain.handle('git-lens:open-external', async (_event, url) => {
    openExternalIfHttp(url);
  });
}

// ---- 应用生命周期 ----

/**
 * 应用引导：Git 发现 → 权限拒绝 → IPC → 菜单 → 启动服务监督。
 * Git 发现不阻塞服务启动，仅影响诊断展示。
 */
async function bootstrap() {
  // 测试专用：会话凭据落盘供 E2E 启动器核验（未设置 GIT_LENS_E2E_TOKEN_FILE 时跳过）
  if (e2eTokenFile) {
    try {
      await atomicWriteFile(e2eTokenFile, `${sessionToken}\n`);
    } catch (err) {
      log(`写入 E2E 凭据文件失败：${err.message}`);
    }
  }

  gitInfo = await discoverGit();
  if (!gitInfo.found) {
    log('未找到可用的 git 可执行文件，仓库分析功能不可用；可在窗口内查看修复建议');
  } else {
    log(`已发现 git：${gitInfo.path}（${gitInfo.version || '未知版本'}）`);
  }

  // 一律拒绝渲染层权限请求（摄像头/定位/通知等，契约 §3.3）
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  registerIpc();
  buildApplicationMenu();
  startService();
}

// 单实例锁：抢锁失败说明已有实例在运行，直接退出（由已运行实例响应 second-instance）
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      // 已有实例窗口被关闭的场景：服务就绪则直接回应用页，否则进恢复流程
      createMainWindow(serviceState === 'ready' ? appUrl() : undefined);
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    bootstrap().catch((err) => {
      log(`应用启动失败：${err.message}`);
      dialog.showErrorBox('Git Lens Web 启动失败', `应用初始化出现错误：${err.message}`);
      app.quit();
    });
  });
}

// 所有窗口关闭即退出应用：单窗口工具语义直观，也支撑恢复页「退出应用」按钮
app.on('window-all-closed', () => {
  app.quit();
});

// 退出前先走服务关闭协议（请求 close → 等待 → 超时 SIGKILL），再继续退出
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  serviceState = 'stopped';
  broadcastServiceState();
  shutdownService().finally(() => app.quit());
});

// macOS 点击 Dock 图标时恢复窗口
app.on('activate', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow(serviceState === 'ready' ? appUrl() : undefined);
  } else {
    mainWindow.show();
  }
});
