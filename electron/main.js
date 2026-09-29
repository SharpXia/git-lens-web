/**
 * Git Lens Web 桌面版 Electron 主进程。
 *
 * 职责（计划书 §3 / 契约 §4、§6、§13）：
 *  - 单实例锁：第二次启动转为激活已有窗口；
 *  - 监督独立服务子进程（utilityProcess）：等待就绪、意外退出时指数退避自动重启
 *    （上限 3 次，成功后清零）、应用退出时请求优雅关闭并兜底 SIGKILL；
 *  - 生成仅存主进程的会话凭据，经 webRequest 仅对本机 /api 请求注入请求头；
 *  - 多标签架构（契约 §15）：BrowserWindow 仅作空壳，顶部为自有 chrome 标签条
 *    （tabbar.html + 专用 preload），内容区为各标签对应的 WebContentsView 栈；
 *    每个标签复用应用 preload 与凭据注入（defaultSession 级过滤天然覆盖全部视图）；
 *  - 窗口 chrome 融合（契约 §17）：标签条兼任标题栏——darwin hiddenInset 红绿灯
 *    内嵌标签条、win/linux titleBarOverlay（真机未验收）；标签条拖拽区与两侧
 *    系统控件安全区；darwin 全屏时取消左侧安全区吸附靠左（§17.1.1）；
 *  - 标签快捷键（契约 §17.1 第四次修订）：⌘1…⌘9 与 ⌘0（第 10 个标签）显式列出
 *    全部 10 项菜单、越界无操作；⌘←/→ 不再切换标签，移交页面 keydown 处理
 *    （§17.1.2），标签循环保留在 Ctrl±Tab；
 *  - 原生能力 IPC（契约 §6）：运行时信息、目录选择、服务状态推送、外链打开；
 *  - 应用菜单：标签页（新建/关闭/切换）、编辑与视图操作（作用于激活标签）、
 *    帮助（关于 + 复制诊断信息）、退出；
 *  - 窗口位置尺寸持久化，恢复时校验可见显示器并夹紧；
 *  - 跨启动标签恢复（契约 §15 第二次修订）：各标签 URL 查询串存档
 *    （tab-state.json）防抖 + 退出同步落盘，服务就绪后重放到当前 origin
 *    恢复标签集合；只存查询串不存完整 URL，跨启动端口变化不影响恢复；
 *  - Git 依赖发现：不阻塞启动，结果经 runtime-info 提供给渲染层呈现修复建议。
 */

import {
  app,
  BrowserWindow,
  MessageChannelMain,
  Menu,
  WebContentsView,
  clipboard,
  dialog,
  ipcMain,
  screen,
  session,
  shell,
  utilityProcess,
  webContents,
} from 'electron';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { resolveServiceConfigDir } from './service-config-dir.js';
import { windowChromeOptions } from './window-chrome.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 窗口默认与最小尺寸（G2 契约） */
const WINDOW_DEFAULT_WIDTH = 1280;
const WINDOW_DEFAULT_HEIGHT = 800;
const WINDOW_MIN_WIDTH = 960;
const WINDOW_MIN_HEIGHT = 600;

/** 顶部标签条固定高度（契约 §15：Shell 自有 chrome UI，DIP） */
const TABBAR_HEIGHT = 38;
/** 新建标签的初始标题（契约 §15：加载完成前占位，页面 title 到达后覆盖） */
const INITIAL_TAB_TITLE = '新标签页';

/** 服务自动重启上限（连续失败次数，成功就绪后清零） */
const SERVICE_RESTART_MAX_ATTEMPTS = 3;
/** 优雅关闭等待上限；超时先 SIGTERM 兜底再 SIGKILL（契约 §13 无孤儿要求） */
const SERVICE_CLOSE_TIMEOUT_MS = 5000;
const SERVICE_SIGKILL_GRACE_MS = 2000;

/** 窗口状态文件名（存放在 userData 下）与防抖保存间隔 */
const WINDOW_STATE_FILE = 'window-state.json';
const WINDOW_STATE_SAVE_DEBOUNCE_MS = 500;

/** 标签状态文件名（契约 §15 第二次修订：跨启动标签恢复）与防抖保存间隔 */
const TAB_STATE_FILE = 'tab-state.json';
const TAB_STATE_SAVE_DEBOUNCE_MS = 500;
/** 单次存档允许的最大标签条目数，防异常膨胀的存档文件拖垮启动 */
const TAB_STATE_MAX_TABS = 50;

/** 恢复兜底检查延迟：给页面自身遮罩（onServiceState 驱动）的接管窗口 */
const RECOVERY_FALLBACK_DELAY_MS = 1200;

/** 跨源重放导航的提交判定等待与重试上限 */
const TAB_REPLAY_COMMIT_TIMEOUT_MS = 8000;
const TAB_REPLAY_MAX_RETRIES = 2;

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

/** 主窗口；服务未就绪时可能尚未创建。多标签架构下仅作空壳容器，自身不加载应用页 */
let mainWindow = null;
/** 顶部标签条视图（Shell 自有 chrome，加载 electron/tabbar.html）；随主窗口销毁重建 */
let tabbarView = null;
/** 内容标签集合：每个标签一个 WebContentsView（契约 §15） */
const tabs = [];
/** 当前激活标签 id；null 表示尚无标签 */
let activeTabId = null;
/** 标签 id 序列（仅用于内部标识与 tabbar IPC 回传，不外露） */
let nextTabSeq = 1;
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
/** 标签状态防抖保存定时器（契约 §15 第二次修订） */
let tabStateSaveTimer = null;
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

/**
 * 桌面模式服务配置目录解析（契约 §5 第三次修订「配置互通」），三条规则按序生效：
 *  1. GIT_LENS_CONFIG_DIR 已设置 → 用它（与浏览器版完全同一配置，web/桌面互通；
 *     E2E/QA 亦经此通道保持隔离）；
 *  2. 未设置且未设 GIT_LENS_USER_DATA（真实用户启动）→ ~/.config/git-lens-web
 *    （与 web 共享同一配置目录，互通为默认行为）；
 *  3. 兜底（GIT_LENS_USER_DATA 隔离场景，如 E2E/smoke）→ <userData>/git-lens-config。
 * 规则 2/3 的分支只依赖「是否设置了 GIT_LENS_USER_DATA」这一事实，直接使用模块
 * 顶部已解析的 e2eUserDataDir（setPath('userData') 在此之前已完成），不重复解析。
 * 解析实现抽为纯函数（service-config-dir.js）供冒烟自验注入式复用——规则 2 无法
 * 在自验中整进程安全验证，共用实现保证单测覆盖与生产行为一致。
 * @returns {string} 服务配置目录（规则 1 为与 web 一致的原样值，规则 2/3 为绝对路径）
 */
function getServiceConfigDir() {
  return resolveServiceConfigDir({
    configDirEnv: process.env.GIT_LENS_CONFIG_DIR,
    userDataEnv: e2eUserDataDir,
  });
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

/**
 * 向窗口与全部内容标签视图广播服务状态。
 * 多标签架构下应用页面运行在 WebContentsView 里（不在窗口自身 webContents），
 * 状态广播必须显式覆盖每个标签，否则页面内恢复遮罩（#serviceStateOverlay）收不到事件。
 */
function broadcastServiceState() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('git-lens:service-state', rendererServiceState());
    }
  }
  for (const tab of tabs) {
    if (!tab.view.webContents.isDestroyed()) {
      tab.view.webContents.send('git-lens:service-state', rendererServiceState());
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
 * 把应用文档带回内容标签（DEF-002 语义的多标签版）：
 * - 窗口不存在：先建空壳窗口（含标签条）；
 * - 尚无任何标签：按存档恢复标签集合（契约 §15 第二次修订，无有效存档时
 *   单标签加载应用首页）——契约 §15 就绪文件仍由该批视图中首个完成首次
 *   加载者触发；
 * - 已有标签且端口未变：逐标签同文档同源 reload——不交换 browsing context
 *   group，各标签独立的 sessionStorage 完整保留，用户选中状态不丢失；
 * - 端口变更（重启复用端口被抢占的罕见回退）：只能跨源导航，各标签页内会话
 *   状态丢失；「标签对应的项目」按各标签当前 URL 的查询串重放到新 origin 保住，
 *   查询串为空/非法的标签回落首页。
 * @param {number|null} previousPort - 重启前的服务端口（null 表示首次就绪）
 */
function ensureAppDocument(previousPort) {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  if (tabs.length === 0) {
    ensureInitialTab();
    return;
  }
  if (previousPort === null || previousPort === servicePort) {
    for (const tab of tabs) {
      if (isViewAlive(tab.view)) tab.view.webContents.reload();
    }
  } else {
    // 跨源导航必然丢失各标签 sessionStorage（DEF-002 已知取舍），但裸加载首页
    // 会把「标签-项目」映射一并丢掉（页面自动选中第一个仓库）。这里取各标签
    // 当前 URL 的查询串重放到新 origin。注意不能用 currentTabSearch：它以
    // 「当前」servicePort 判同源，此刻端口已更新，旧 URL 会被全部误判为无查询串；
    // 直接解析 URL 后走与存档恢复同一套查询串校验，两条路径行为保持一致。
    log(`服务端口由 ${previousPort} 变为 ${servicePort}，页面跨源导航，崩溃前的页内会话状态无法保留，各标签按查询串重放`);
    for (const tab of tabs) {
      if (!isViewAlive(tab.view)) continue;
      let search = '?';
      try {
        search = new URL(tab.view.webContents.getURL()).search || '?';
      } catch {
        // URL 解析失败按无查询串处理
      }
      const replay = normalizeArchivedSearch({ search });
      navigateTabWithRetry(tab, replay ? `${appOrigin()}/${replay}` : appUrl());
    }
  }
}

/**
 * 执行一次导航并做提交兜底（供跨源重放使用）：实测 Electron 44 下跨端口
 * loadURL 偶发长期 pending——CDP 目标 URL 长期为空、无 did-fail-load、
 * loadURL promise 也不 settle，等待无法自愈。因此以「限定时间内 getURL()
 * 是否已到达当前 origin」判定提交，未提交则 stop() 后重新 loadURL 重试，
 * 无论挂起根因是导航调度丢失还是端口竞态，都能收敛到重放目标。
 * @param {{id: number, view: Electron.WebContentsView, title: string}} tab - 目标标签
 * @param {string} target - 目标地址（当前 origin + 查询串）
 * @param {number} [attempt] - 已重试次数
 */
function navigateTabWithRetry(tab, target, attempt = 0) {
  if (!isViewAlive(tab.view)) return;
  const webContents = tab.view.webContents;
  log(`标签页（id=${tab.id}）跨源重放（第 ${attempt + 1} 次导航）→ ${target}`);
  // 拒绝（如并发导航取消的 ERR_ABORTED）不单独处理，交由提交检查统一判定
  webContents.loadURL(target).catch(() => {});
  setTimeout(() => {
    if (!isViewAlive(tab.view) || shuttingDown) return;
    if (isSameOriginAppUrl(webContents.getURL())) return; // 已提交到当前 origin
    if (attempt >= TAB_REPLAY_MAX_RETRIES) {
      log(`标签页（id=${tab.id}）跨源重放连续未提交，已达重试上限，保持页面遮罩态等待用户手动刷新`);
      return;
    }
    log(`标签页（id=${tab.id}）跨源重放 ${TAB_REPLAY_COMMIT_TIMEOUT_MS}ms 未提交，stop 后重试`);
    try {
      webContents.stop();
    } catch {
      // 视图恰好销毁时忽略
    }
    navigateTabWithRetry(tab, target, attempt + 1);
  }, TAB_REPLAY_COMMIT_TIMEOUT_MS);
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

// ---- 多标签视图管理（契约 §15） ----

/**
 * 判断视图及其 webContents 仍可用。
 * 视图随窗口销毁后访问其属性可能抛错，统一在此兜底。
 * @param {Electron.WebContentsView} [view] - 待检视图
 */
function isViewAlive(view) {
  if (!view) return false;
  try {
    return !view.webContents.isDestroyed();
  } catch {
    return false;
  }
}

/** 当前激活的标签对象；无标签时返回 null */
function getActiveTab() {
  return tabs.find((tab) => tab.id === activeTabId) || null;
}

/** 标签列表快照（推送 tabbar 用；只含渲染所需的三个字段） */
function tabsSnapshot() {
  return tabs.map((tab) => ({ id: tab.id, title: tab.title, active: tab.id === activeTabId }));
}

/**
 * 向标签条推送最新标签集合。
 * 标签条未就绪（加载中/已销毁）时静默跳过——其 did-finish-load 会主动拉取
 * 一次当前状态，不会永久失步。
 */
function pushTabbarState() {
  if (!isViewAlive(tabbarView)) return;
  tabbarView.webContents.send('git-lens-tabbar:state-changed', { tabs: tabsSnapshot(), activeId: activeTabId });
}

/** 判断 sender 是否为标签条视图本身（防止应用页面伪造标签条通道调用） */
function isTabbarSender(sender) {
  return Boolean(isViewAlive(tabbarView) && sender === tabbarView.webContents);
}

/**
 * 向标签条推送当前窗口全屏态（契约 §17.1.1：macOS 全屏时系统隐藏红绿灯，
 * 标签条需取消 78px 左侧安全区让标签吸附靠左，退出全屏恢复）。
 * 载荷固定为 `{ fullscreen: <Boolean> }`；标签条未就绪（加载中/已销毁）时
 * 静默跳过——其 did-finish-load 会同步一次当前全屏态，不会永久失步。
 */
function pushTabbarFullscreen() {
  if (!isViewAlive(tabbarView) || !mainWindow || mainWindow.isDestroyed()) return;
  tabbarView.webContents.send('git-lens-tabbar:fullscreen-changed', { fullscreen: mainWindow.isFullScreen() === true });
}

/**
 * 同步内容区所有视图 bounds（DIP）：标签条固定占顶部 TABBAR_HEIGHT，
 * 内容标签铺满其余区域。窗口 resize/最大化/全屏切换时由窗口事件驱动。
 */
function syncTabBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { width, height } = mainWindow.getContentBounds();
  const contentHeight = Math.max(0, height - TABBAR_HEIGHT);
  if (isViewAlive(tabbarView)) {
    tabbarView.setBounds({ x: 0, y: 0, width, height: TABBAR_HEIGHT });
  }
  for (const tab of tabs) {
    if (isViewAlive(tab.view)) {
      tab.view.setBounds({ x: 0, y: TABBAR_HEIGHT, width, height: contentHeight });
    }
  }
}

/**
 * 创建标签条视图：Shell 自有 chrome（tabbar.html，自足深色样式），经专用
 * preload 与主进程通信（通道前缀 git-lens-tabbar:）。
 * @returns {Electron.WebContentsView}
 */
function createTabbarView() {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'tabbar-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  view.setBackgroundColor('#010409');
  attachTabbarGuards(view);
  // 契约 §17：经 loadFile query 注入平台标识，标签条页面据此做红绿灯安全区 /
  // overlay 控件区的 CSS 分支（body[data-platform]）
  view.webContents.loadFile(path.join(__dirname, 'tabbar.html'), { query: { platform: process.platform } });
  // 加载完成（含崩溃重建后的重载）即回填当前标签集合与全屏态，避免状态失步
  view.webContents.on('did-finish-load', () => {
    pushTabbarState();
    // 契约 §17.1.1：标签条加载完成时同步当前全屏态（此前窗口若已进入全屏，
    // 事件推送会错过未就绪的标签条，这里兜底对齐）
    pushTabbarFullscreen();
  });
  return view;
}

/**
 * 标签条视图安全边界：chrome 页无导航需求，跨源导航与新窗口一律拒绝；
 * 渲染进程异常退出时记录日志并整体重建（契约 §15 健壮性要求）。
 * @param {Electron.WebContentsView} view - 标签条视图
 */
function attachTabbarGuards(view) {
  const webContents = view.webContents;

  webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  webContents.on('render-process-gone', (_event, details) => {
    if (shuttingDown) return;
    log(`标签条渲染进程异常退出（${details.reason}），正在重建`);
    rebuildTabbar();
  });
}

/** 重建标签条：新视图就位后再销毁旧视图，期间标签集合不受影响 */
function rebuildTabbar() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    tabbarView = null;
    return;
  }
  const previous = tabbarView;
  tabbarView = createTabbarView();
  if (previous) {
    mainWindow.contentView.removeChildView(previous);
    try {
      previous.webContents.close();
    } catch {
      // 旧视图可能已随崩溃销毁
    }
  }
  mainWindow.contentView.addChildView(tabbarView);
  syncTabBounds();
}

/**
 * 附加标签视图安全边界：与主窗口同规则（同源放行、外链交系统浏览器、
 * 拒新窗、拒 webview、非调试模式拦截 devtools 快捷键），另挂标题监听、
 * 就绪文件触发与崩溃处理。
 * @param {{id: number, view: Electron.WebContentsView, title: string}} tab - 目标标签
 */
function attachTabGuards(tab) {
  const webContents = tab.view.webContents;

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

  webContents.on('before-input-event', (event, input) => {
    if (process.env.GIT_LENS_DEVTOOLS === '1') return;
    if (isDevtoolsShortcut(input)) event.preventDefault();
  });

  // 标签标题取自页面 title（形如 `<仓库> · <视图> | Git Lens`），过长由 tabbar CSS 截短
  webContents.on('page-title-updated', (_event, title) => {
    if (typeof title === 'string' && title) tab.title = title;
    pushTabbarState();
  });

  // 契约 §13（经 §15 修订）：就绪文件以「首个内容视图完成首次加载」为准；
  // 空壳窗口自身不再触发。其余标签的加载（含恢复 reload）幂等重写同一基础形态
  webContents.on('did-finish-load', () => {
    if (!isSameOriginAppUrl(webContents.getURL())) return;
    appEverLoaded = true;
    void writeE2eReadyFile();
  });

  // 契约 §15 第二次修订：页面经 replaceState/pushState 把「当前项目与视图」写进
  // URL 查询串，主框架导航与页内导航（含 replaceState/pushState）都意味着标签
  // 入口可能已变化，统一交给防抖保存去取各标签当前查询串
  webContents.on('did-navigate', () => scheduleTabStateSave());
  webContents.on('did-navigate-in-page', () => scheduleTabStateSave());

  webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    // -3 (ABORTED) 是导航被取消的正常噪音（如加载中途切换页面）
    if (errorCode === -3) return;
    log(`标签页加载失败（${errorDescription}，code ${errorCode}）：${validatedURL}`);
  });

  // 契约 §15：单标签崩溃不做独立恢复，按服务不可用路径处理——复用既有状态
  // 广播通道（服务健康时页面遮罩不受影响），并重载该视图尝试自愈；服务本身
  // 不可用时交给服务恢复路径统一处理（重启成功后 reloadAll 带回全部标签）
  webContents.on('render-process-gone', (_event, details) => {
    log(`标签页（id=${tab.id}）渲染进程异常退出：${details.reason}`);
    if (shuttingDown || serviceState !== 'ready') return;
    broadcastServiceState();
    setTimeout(() => {
      if (!shuttingDown && isViewAlive(tab.view)) {
        tab.view.webContents.reload();
      }
    }, 300);
  });

  // 销毁回执：供自验与排障确认「关闭标签 = 无泄漏销毁」
  webContents.on('destroyed', () => {
    log(`标签页（id=${tab.id}）webContents 已销毁`);
  });
}

/**
 * 新建内容标签并加载应用首页（无仓库参数，契约 §15）。
 * webPreferences 与既有窗口一致（sandbox + contextIsolation + 同一 preload）；
 * 不指定 partition，视图挂在 defaultSession 上，§4.6 凭据注入过滤天然覆盖。
 * @param {string} [url] - 初始地址；缺省为应用首页
 * @returns {object|null} 新建标签；服务未就绪或窗口不存在时为 null
 */
function createTab(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  if (!servicePort) {
    log('服务尚未就绪，忽略新建标签请求');
    return null;
  }
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  // 深色底色与应用主题一致，避免加载间隙白闪
  view.setBackgroundColor('#0d1117');
  const tab = { id: nextTabSeq++, view, title: INITIAL_TAB_TITLE };
  attachTabGuards(tab);
  tabs.push(tab);
  mainWindow.contentView.addChildView(view);
  // 新标签按浏览器惯例立即激活（activateTab 负责隐藏旧激活视图）
  activateTab(tab.id);
  view.webContents.loadURL(url || appUrl());
  // 契约 §15 第二次修订：标签集合变化是存档保存触发点之一（防抖）
  scheduleTabStateSave();
  log(`已新建标签页（id=${tab.id}，共 ${tabs.length} 个）`);
  return tab;
}

/**
 * 激活指定标签：显隐切换 + 焦点移交，不销毁、不重载（契约 §15 交互冻结）。
 * @param {number} id - 目标标签 id
 */
function activateTab(id) {
  const tab = tabs.find((item) => item.id === id);
  if (!tab) return;
  const previous = getActiveTab();
  if (previous && previous !== tab && isViewAlive(previous.view)) {
    previous.view.setVisible(false);
  }
  tab.view.setVisible(true);
  activeTabId = id;
  syncTabBounds();
  if (isViewAlive(tab.view)) tab.view.webContents.focus();
  pushTabbarState();
  // 契约 §15 第二次修订：激活项变化写入存档（防抖，与 createTab 触发合并）
  scheduleTabStateSave();
}

/**
 * 关闭指定标签：移出视图树并销毁 webContents（无泄漏）。
 * 关闭最后一个标签等同关闭窗口（契约 §15），经 window-all-closed 走既有
 * 退出协议（before-quit → 服务 close → 等待退出 → 超时 SIGKILL）。
 * @param {number} id - 目标标签 id
 */
function closeTab(id) {
  const index = tabs.findIndex((item) => item.id === id);
  if (index === -1) return;
  const [tab] = tabs.splice(index, 1);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.contentView.removeChildView(tab.view);
  }
  try {
    // close() 触发 graceful 销毁；'destroyed' 事件回执供自验确认
    tab.view.webContents.close();
  } catch (err) {
    log(`关闭标签页（id=${id}）销毁异常：${err && err.message ? err.message : err}`);
  }
  if (activeTabId === id) {
    activeTabId = null;
    // 就近激活：优先原位置右侧标签，其次左侧（浏览器惯例）
    const neighbor = tabs[index] || tabs[index - 1] || null;
    if (neighbor) activateTab(neighbor.id);
    else pushTabbarState();
  } else {
    pushTabbarState();
  }
  log(`已关闭标签页（id=${id}，剩余 ${tabs.length} 个）`);
  // 契约 §15 第二次修订：标签集合变化是存档保存触发点之一（防抖）
  scheduleTabStateSave();
  if (tabs.length === 0) {
    log('已关闭最后一个标签页，按契约关闭窗口并退出应用');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  }
}

/**
 * 循环切换标签（Ctrl+Tab 下一个 / Ctrl+Shift+Tab 上一个，契约 §15）。
 * @param {1|-1} offset - 切换方向
 */
function cycleTab(offset) {
  if (tabs.length === 0) return;
  const currentIndex = Math.max(0, tabs.findIndex((item) => item.id === activeTabId));
  const next = tabs[(currentIndex + offset + tabs.length) % tabs.length];
  activateTab(next.id);
}

/**
 * 按下标激活标签（契约 §17.1 第四次修订：⌘1…⌘9 与 ⌘0=第 10 个标签）。
 * 实现通用支持 0–9 下标（对应 ⌘1–⌘9、⌘0），菜单显式列出全部 10 项；
 * 下标越界（超出当前标签数量）一律无操作。
 * @param {number} index - 目标标签下标（0 起）
 */
function activateTabIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index > 9) return;
  const tab = tabs[index];
  if (!tab) return;
  activateTab(tab.id);
}

/**
 * 确保至少存在一个内容标签；当前无标签时按存档恢复标签集合（契约 §15 第二次修订）：
 *  - 有效存档 → 按保存顺序把各查询串重放到当前 origin 逐个建标签，并激活
 *    存档记录的激活项（越界回落 0）；
 *  - 无存档/存档全部无效 → 维持现状：单标签加载首页。
 * 本路径只在「当前一个标签都没有」时进入（首启建首标签、窗口重开、崩溃重启
 * 时集合为空的兜底）；服务崩溃重启时已有标签走 ensureAppDocument 的同源
 * reload，两条路径互不干扰。就绪文件语义不变：首个内容视图（含恢复标签）
 * 完成首次加载时触发。
 */
function ensureInitialTab() {
  if (tabs.length > 0) return;
  const archive = loadTabState();
  if (archive && archive.searches.length > 0) {
    for (const search of archive.searches) {
      createTab(`${appOrigin()}/${search}`);
    }
    const activeIndex = Math.min(Math.max(archive.activeIndex, 0), tabs.length - 1);
    activateTab(tabs[activeIndex].id);
    log(`已按存档恢复 ${archive.searches.length} 个标签页（激活第 ${activeIndex + 1} 个）`);
  } else {
    createTab(appUrl());
  }
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
 * 附加主窗口（空壳）安全边界：同源导航、拒绝新窗口、拒绝权限请求、
 * 拒绝 webview、非调试模式下拦截 devtools 快捷键。
 * 多标签架构下窗口自身 webContents 平时空白未用（仅独立恢复页可能载入），
 * 这里保留同强度边界作纵深防御；就绪文件触发已移至内容标签视图。
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

// ---- 标签状态持久化（契约 §15 第二次修订：跨启动标签恢复） ----

/** 标签状态存档文件路径（userData 下，随 GIT_LENS_USER_DATA 天然隔离） */
function tabStateFilePath() {
  return path.join(app.getPath('userData'), TAB_STATE_FILE);
}

/**
 * 校验单条存档查询串：只接受以「?」开头的纯查询串，且必须能被 URL 解析
 * 原样回环（解析后 search 与原文一致）。显式拒绝包含 http 的整串 URL 与
 * 协议相对形态，防旧格式或脏数据把恢复导航带离当前 origin。
 * @param {unknown} entry - 存档中的单个标签条目
 * @returns {string|null} 合法查询串；不合法返回 null（该条目丢弃）
 */
function normalizeArchivedSearch(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const search = entry.search;
  if (typeof search !== 'string' || !search.startsWith('?')) return null;
  if (search.length > 2048 || /\s/.test(search)) return null;
  if (/https?:/i.test(search) || search.includes('//')) return null;
  try {
    // 挂在占位 origin 上解析即可，校验只关心查询串回环一致（与当前端口无关）
    const parsed = new URL(`http://127.0.0.1/${search}`);
    return parsed.search === search ? search : null;
  } catch {
    return null;
  }
}

/**
 * 读取标签状态存档。文件缺失/JSON 损坏/版本不符/结构异常一律按无存档处理
 * （返回 null，由调用方回落单标签首页）；单条非法条目丢弃，不拖垮整份存档。
 * @returns {{activeIndex: number, searches: string[]}|null} 有效存档；无存档为 null
 */
function loadTabState() {
  let raw;
  try {
    raw = fs.readFileSync(tabStateFilePath(), 'utf-8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return null;
  if (!Array.isArray(parsed.tabs) || !Number.isInteger(parsed.activeIndex)) return null;
  const searches = [];
  for (const entry of parsed.tabs.slice(0, TAB_STATE_MAX_TABS)) {
    const search = normalizeArchivedSearch(entry);
    if (search !== null) searches.push(search);
  }
  return { activeIndex: parsed.activeIndex, searches };
}

/**
 * 取单个标签当前 URL 的查询串（契约 §15：只存查询串、不存完整 URL，跨启动
 * 端口会变，恢复时重放到当前 origin）。视图销毁/导航尚未提交/非常规地址按
 * 无查询串处理，统一存「?」——「?」的语义是“开过一个无参首页标签”，恢复侧
 * 加载 `<origin>/?` 与加载首页等价，读写形态保持一致。
 * @param {{id: number, view: Electron.WebContentsView, title: string}} tab - 目标标签
 * @returns {string} 以「?」开头的查询串
 */
function currentTabSearch(tab) {
  if (isViewAlive(tab.view)) {
    try {
      const url = tab.view.webContents.getURL();
      if (isSameOriginAppUrl(url)) {
        const search = new URL(url).search;
        return search === '' ? '?' : search;
      }
    } catch {
      // URL 解析失败按无查询串处理
    }
  }
  return '?';
}

/**
 * 把当前标签集合序列化为存档结构；无标签时返回 null（同步落盘侧会改写为
 * 空存档覆盖旧数据，语义为“上次会话以无标签收尾”，下次启动回落单标签首页）。
 * @returns {{version: number, activeIndex: number, tabs: Array<{search: string}>}|null}
 */
function serializeTabState() {
  if (tabs.length === 0) return null;
  // 找不到激活项（理论不可达）时按第 0 个处理，避免产出负数下标
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId));
  return {
    version: 1,
    activeIndex,
    tabs: tabs.map((tab) => ({ search: currentTabSearch(tab) })),
  };
}

/** 防抖保存（同 window-state 模式）：500ms 内连续触发只落一次盘 */
function scheduleTabStateSave() {
  if (tabStateSaveTimer) clearTimeout(tabStateSaveTimer);
  tabStateSaveTimer = setTimeout(() => {
    tabStateSaveTimer = null;
    void saveTabStateNow();
  }, TAB_STATE_SAVE_DEBOUNCE_MS);
}

/** 取消尚未触发的防抖保存（同步落盘前调用，避免双写竞争） */
function cancelTabStateSaveTimer() {
  if (tabStateSaveTimer) {
    clearTimeout(tabStateSaveTimer);
    tabStateSaveTimer = null;
  }
}

/** 异步原子写入存档（防抖路径）：临时文件 + rename，避免写入中途留下半截 JSON */
async function saveTabStateNow() {
  const payload = serializeTabState();
  if (!payload) return;
  try {
    await atomicWriteFile(tabStateFilePath(), `${JSON.stringify(payload, null, 2)}\n`);
  } catch (err) {
    log(`保存标签状态失败：${err.message}`);
  }
}

/**
 * 同步（阻塞式）落盘存档，用于退出协议与窗口关闭等不能再等防抖的时机。
 * 无标签时也写一份空存档，覆盖上一轮会话的旧数据，保证读写语义一致。
 */
function saveTabStateSync() {
  cancelTabStateSaveTimer();
  const payload = serializeTabState() || { version: 1, activeIndex: 0, tabs: [] };
  const target = tabStateFilePath();
  const tmpPath = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmpPath, target);
  } catch (err) {
    log(`同步保存标签状态失败：${err.message}`);
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // 清理失败可忽略：临时文件带随机后缀，不会覆盖任何有效数据
    }
  }
}

/**
 * 创建主窗口空壳并装载标签条（契约 §15）。
 * 窗口自身 webContents 保持空白未用（仅独立恢复页可能载入），应用页一律
 * 运行在内容标签视图里；首个内容标签由 ensureAppDocument 在服务就绪后创建。
 */
function createMainWindow() {
  const restored = restoredWindowBounds();
  mainWindow = new BrowserWindow({
    width: restored ? restored.bounds.width : WINDOW_DEFAULT_WIDTH,
    height: restored ? restored.bounds.height : WINDOW_DEFAULT_HEIGHT,
    ...(restored ? { x: restored.bounds.x, y: restored.bounds.y } : {}),
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    title: 'Git Lens Web',
    show: true,
    backgroundColor: '#0d1117',
    // 契约 §17：窗口 chrome 融合——标签条兼任标题栏。darwin 用 hiddenInset 隐藏
    // 原生标题栏并把红绿灯压进 38px 标签条（trafficLightPosition 近似垂直居中）；
    // win/linux 用系统绘制的 titleBarOverlay（⚠️ 真机未验收，契约 §1 平台矩阵）。
    // 选项定义抽为 window-chrome.js 纯模块，冒烟自验 import 同一份定义断言防漂移
    ...windowChromeOptions(process.platform),
    // 空壳窗口不挂应用 preload：preload 只属于内容标签视图（契约 §6 暴露面不变）
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (restored && restored.isMaximized) mainWindow.maximize();
  attachWindowGuards(mainWindow);
  trackWindowState(mainWindow);
  // 关窗即同步落盘标签状态（同 window-state 的 close 时机）：「关闭最后一个
  // 标签 = 关窗退出」路径中 'closed' 会先于 before-quit 清空标签集合，必须趁
  // 集合还在时抓快照；app.quit() 关窗会再次走到这里，重复写入幂等无害
  mainWindow.on('close', () => {
    saveTabStateSync();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    tabbarView = null;
    // 内容视图随窗口一起销毁；清空集合，避免二次启动/激活路径引用已销毁视图
    tabs.length = 0;
    activeTabId = null;
  });
  // 标签条与全部内容标签的布局随窗口几何变化全量同步（resize/maximize/全屏）
  for (const event of ['resize', 'maximize', 'unmaximize']) {
    mainWindow.on(event, syncTabBounds);
  }
  // 契约 §17.1.1：全屏切换除同步布局外，还须把全屏态推给标签条——darwin 全屏
  // 时系统隐藏红绿灯，标签条取消左侧安全区吸附靠左，退出全屏恢复
  for (const event of ['enter-full-screen', 'leave-full-screen']) {
    mainWindow.on(event, () => {
      syncTabBounds();
      pushTabbarFullscreen();
    });
  }
  tabbarView = createTabbarView();
  mainWindow.contentView.addChildView(tabbarView);
  syncTabBounds();
}

/**
 * 按当前服务状态打开主窗口：服务就绪则按存档恢复标签集合进入应用
 * （ensureInitialTab，无有效存档时单标签首页）；未就绪（启动中/已崩溃）
 * 则向空壳窗口载入独立恢复页。
 */
function openWindowForCurrentServiceState() {
  createMainWindow();
  if (serviceState === 'ready') ensureInitialTab();
  else mainWindow.loadURL(buildRecoveryPageUrl('restarting', '本地服务正在启动', true));
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
 * 兜底检查：激活标签页自身遮罩可见则不干预；否则向全部内容标签注入遮罩
 * （每个标签独立运行页面，任一切换后都应呈现一致的恢复态）。
 * 应用页尚未加载（首启即失败）时没有会话状态可丢，仍走独立恢复页。
 */
async function armRecoveryFallback(state, reason, autoRecover) {
  if (mainWindow && !mainWindow.isDestroyed() && appEverLoaded && tabs.length > 0) {
    const active = getActiveTab();
    if (active && isViewAlive(active.view)) {
      let pageOverlayVisible = false;
      try {
        // 只读探测页面自身遮罩的显示状态，不触碰页面数据
        pageOverlayVisible = await active.view.webContents.executeJavaScript(
          `(function () { var el = document.getElementById('serviceStateOverlay'); return !!(el && el.style.display !== 'none'); })()`,
        );
      } catch {
        // 渲染层异常时按遮罩不可见处理，尝试注入兜底
      }
      if (pageOverlayVisible) return;
    }
    injectRecoveryOverlay(state, reason, autoRecover);
    return;
  }
  showStandaloneRecoveryPage(state, reason, autoRecover);
}

/**
 * 向全部内容标签注入全屏深色恢复遮罩（主进程 executeJavaScript，不受页面
 * CSP 约束）。遮罩拦截指针与键盘输入，避免旧数据可交互；服务恢复后的
 * 同文档 reload 会自然清除注入内容。
 */
function injectRecoveryOverlay(state, reason, autoRecover) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const script = buildRecoveryOverlayScript(state, reason, autoRecover);
  for (const tab of tabs) {
    if (!isViewAlive(tab.view)) continue;
    tab.view.webContents.executeJavaScript(script)
      .catch((err) => log(`注入恢复遮罩失败：${err && err.message ? err.message : err}`));
  }
}

/**
 * 展示独立恢复页：仅用于应用页从未加载（首启失败）的场景。恢复页加载进
 * 窗口自身的空壳 webContents（多标签架构下该 webContents 平时空白未用），
 * 不占用内容标签；服务就绪后首个内容标签创建并覆盖其上。
 * @param {'restarting'|'crashed'} state - 恢复页状态
 * @param {string} reason - 失败原因（中文）
 * @param {boolean} autoRecover - 是否显示自动恢复倒计时
 */
function showStandaloneRecoveryPage(state, reason, autoRecover) {
  const url = buildRecoveryPageUrl(state, reason, autoRecover);
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
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
  /* 契约 §17：恢复页 body 兼任拖拽区（原生标题栏已融合隐藏），窗口可拖动；
     交互按钮显式 no-drag，避免点击被窗口拖拽吞掉 */
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #0d1117; color: #c9d1d9;
         -webkit-app-region: drag; }
  .card { max-width: 440px; margin: 0 16px; padding: 28px 32px; background: #161b22; border: 1px solid #30363d;
          border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.4); text-align: center; word-break: break-word; }
  h1 { font-size: 17px; margin: 0 0 8px; color: #f0f6fc; }
  p { font-size: 13px; line-height: 1.7; color: #8b949e; margin: 8px 0; word-break: break-word; }
  .reason { font-size: 12px; }
  .countdown { font-size: 13px; color: #58a6ff; margin-top: 14px; }
  button { margin-top: 16px; padding: 7px 22px; font-size: 13px; border: 1px solid #30363d;
           border-radius: 6px; background: transparent; color: #c9d1d9; cursor: pointer;
           -webkit-app-region: no-drag; }
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
 * 构建应用菜单：标签页（新建/关闭/切换，契约 §15 交互冻结）、编辑与视图操作
 * （显式路由到激活标签）、帮助（关于 + 复制诊断信息）、退出；macOS 保留标准
 * appMenu。不提供 devtools 菜单项（保留 GIT_LENS_DEVTOOLS 调试开关）。
 */
function buildApplicationMenu() {
  const isMac = process.platform === 'darwin';

  /**
   * 把菜单动作包装为作用到目标标签视图的 click 处理器。
   * 多标签架构下 BrowserWindow 自身 webContents 是空壳，Electron 内建 role
   * 一律作用于窗口 webContents，因此编辑/视图操作必须以自定义 click 显式
   * 路由到真正持有焦点的标签视图（退回激活标签）。
   * @param {(target: Electron.WebContents) => void} action - 目标动作
   */
  const withTabTarget = (action) => () => {
    let target = null;
    try {
      const focused = webContents.getFocusedWebContents();
      if (focused && tabs.some((tab) => isViewAlive(tab.view) && tab.view.webContents === focused)) {
        target = focused;
      }
    } catch {
      // 焦点查询失败时退回激活标签
    }
    if (!target) {
      const active = getActiveTab();
      if (active && isViewAlive(active.view)) target = active.view.webContents;
    }
    if (target) action(target);
  };

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        // ⌘W 已划给「关闭标签页」；macOS 关闭窗口改绑 ⇧⌘W（role:close 默认
        // ⌘W 必须显式覆盖，否则两个菜单项争抢同一加速键，触发行为不确定）
        isMac
          ? { role: 'close', label: '关闭窗口', accelerator: 'Shift+CmdOrCtrl+W' }
          : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '标签页',
      submenu: [
        {
          label: '新建标签页',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) createTab(appUrl());
            else openWindowForCurrentServiceState();
          },
        },
        {
          label: '关闭标签页',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            if (activeTabId !== null) closeTab(activeTabId);
          },
        },
        { type: 'separator' },
        { label: '下一个标签页', accelerator: 'Ctrl+Tab', click: () => cycleTab(1) },
        { label: '上一个标签页', accelerator: 'Ctrl+Shift+Tab', click: () => cycleTab(-1) },
        { type: 'separator' },
        // 契约 §17.1 第四次修订：⌘1…⌘9 与 ⌘0（0=第 10 个标签）显式列出全部 10 项，
        // activateTabIndex 通用支持下标 0–9；下标越界（超出当前标签数量）一律无操作。
        // 稳定 id 供 E2E 经 Menu.getApplicationMenu().getMenuItemById(id).click()
        // 程序化触发（加速键本身无法自动化合成）。菜单变长可接受（Chrome 同款）。
        // 契约 §17.1.2：⌘←/→ 已不再切换窗口标签（循环保留在 Ctrl±Tab），改由
        // 页面 keydown 接管主视图切换，此处不再提供同名菜单加速键
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((number) => ({
          label: `切换到标签页 ${number}`,
          id: `switch-tab-${number}`,
          accelerator: `CmdOrCtrl+${number}`,
          click: () => activateTabIndex(number === 0 ? 9 : number - 1),
        })),
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: withTabTarget((wc) => wc.undo()) },
        { label: '重做', accelerator: 'Shift+CmdOrCtrl+Z', click: withTabTarget((wc) => wc.redo()) },
        { type: 'separator' },
        { label: '剪切', accelerator: 'CmdOrCtrl+X', click: withTabTarget((wc) => wc.cut()) },
        { label: '复制', accelerator: 'CmdOrCtrl+C', click: withTabTarget((wc) => wc.copy()) },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', click: withTabTarget((wc) => wc.paste()) },
        { label: '全选', accelerator: 'CmdOrCtrl+A', click: withTabTarget((wc) => wc.selectAll()) },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '刷新', accelerator: 'CmdOrCtrl+R', click: withTabTarget((wc) => wc.reload()) },
        { label: '强制刷新', accelerator: 'Shift+CmdOrCtrl+R', click: withTabTarget((wc) => wc.reloadIgnoringCache()) },
        { type: 'separator' },
        { label: '返回', accelerator: 'CmdOrCtrl+[', click: withTabTarget((wc) => wc.goBack()) },
        { label: '前进', accelerator: 'CmdOrCtrl+]', click: withTabTarget((wc) => wc.goForward()) },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: withTabTarget((wc) => wc.setZoomLevel(wc.getZoomLevel() + 0.5)) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: withTabTarget((wc) => wc.setZoomLevel(wc.getZoomLevel() - 0.5)) },
        // ⌘0 已划给「切换到标签页 0」（第 10 个标签，契约 §17.1 第四次修订）；
        // 同一加速键在原生菜单中由先注册者胜出，「实际大小」原 ⌘0 会静默失效，
        // 故改绑 ⇧⌘0（沿用本菜单 ⌘R/⇧⌘R 的同键位分层约定）
        { label: '实际大小', accelerator: 'Shift+CmdOrCtrl+0', click: withTabTarget((wc) => wc.setZoomLevel(0)) },
        { type: 'separator' },
        // 全屏是窗口级操作，内建 role 语义正确
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

  // ---- 标签条通道（契约 §15；仅接受标签条视图自身发起，防应用页面伪造） ----

  ipcMain.on('git-lens-tabbar:subscribe', (event) => {
    if (!isTabbarSender(event.sender)) return;
    // 订阅即回发当前标签集合，避免标签条错过最近一次变化
    pushTabbarState();
  });

  ipcMain.on('git-lens-tabbar:new-tab', (event) => {
    if (!isTabbarSender(event.sender)) return;
    if (mainWindow && !mainWindow.isDestroyed()) createTab(appUrl());
  });

  ipcMain.on('git-lens-tabbar:close-tab', (event, tabId) => {
    if (!isTabbarSender(event.sender)) return;
    if (!Number.isInteger(tabId) || tabId <= 0) return;
    closeTab(tabId);
  });

  ipcMain.on('git-lens-tabbar:activate-tab', (event, tabId) => {
    if (!isTabbarSender(event.sender)) return;
    if (!Number.isInteger(tabId) || tabId <= 0) return;
    activateTab(tabId);
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

  // 渲染层权限兜底拒绝保持不变（摄像头/定位/通知等，契约 §3.3），仅显式放行
  // clipboard-sanitized-write：页面复制按钮的 navigator.clipboard.writeText 所需
  // （契约 §17.2，计划书 §3.3「确有需求时按来源逐项开放」的落地项，DEF-007）。
  // clipboard-read 等其余权限继续拒绝；request 与 check 两个处理器都要放行——
  // Electron 不同版本对剪贴板写入可能走任一条通道，只放行其一仍会被静默拒绝
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'clipboard-sanitized-write');

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
      // 已有实例窗口被关闭的场景：服务就绪则带首个标签回应用页，否则进恢复流程
      openWindowForCurrentServiceState();
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
  // 契约 §15 第二次修订：退出前同步落盘一次标签状态（服务关闭是异步流程，
  // 必须在交出控制权前完成落盘）
  saveTabStateSync();
  event.preventDefault();
  serviceState = 'stopped';
  broadcastServiceState();
  shutdownService().finally(() => app.quit());
});

// macOS 点击 Dock 图标时恢复窗口
app.on('activate', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    openWindowForCurrentServiceState();
  } else {
    mainWindow.show();
  }
});
