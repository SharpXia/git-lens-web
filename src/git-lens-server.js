import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  isGitRepo,
  getWorktrees,
  getBranches,
  getCleanupCandidates,
  deleteBranch,
  removeWorktree,
  pruneWorktrees,
  checkBranchExists,
  checkWorktreeExists,
  getWorktreeDiff,
  getUncommittedDiff,
  getFileContentBuffer,
  getMimeType,
  getWorktreeCommits,
  getWorktreeAheadBehind,
  getCommitDetail,
  getCommitDiff,
  commitAction,
  getStashList,
  stashAction,
  getRefDiff,
  annotateWorktreesFromBranches,
  annotateDeliveredViaWorktrees,
  configureGitPath as configureInspectorGitPath,
  getGitDiagnostics
} from './git-inspector.js';
import {
  listMergeRequests,
  createMergeRequest,
  getMergeRequest,
  mergeRequestAction,
  configureGitPath as configureMrGitPath
} from './merge-request-service.js';

const execFileAsync = promisify(execFile);

/** JSON 请求体默认字节上限：2MB，与契约 §2.1 保持一致 */
const DEFAULT_REQUEST_BODY_LIMIT = 2 * 1024 * 1024;

/** 关闭服务时等待在途请求的最长时间，超时后强制销毁全部连接 */
const CLOSE_GRACE_PERIOD_MS = 3000;

// CSP 策略（契约 §14 G3 冻结）：静态页与 API 同源响应统一携带，逐字符冻结，
// 修改必须先经协调 Agent 修订契约。script-src 'self' 禁止内联脚本，
// style-src 暂保留 'unsafe-inline'，object/frame/form 一律锁死。
const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'";

/** 静态资源精确白名单：pathname 相等匹配，天然免疫目录遍历与编码变形 */
const STATIC_FILE_WHITELIST = {
  '/app.js': { file: 'app.js', contentType: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', contentType: 'text/css; charset=utf-8' }
};

/**
 * 调用服务所在电脑的系统目录选择器，取消选择时返回 null。
 * 浏览器的目录上传控件不会提供服务端可用的绝对路径，因此需要本机对话框。
 * @returns {Promise<string|null>} 用户选择的目录绝对路径；取消或用户关闭对话框返回 null
 */
export async function chooseScanDirectory() {
  let command;
  let args;
  if (process.platform === 'darwin') {
    command = 'osascript';
    args = ['-e', 'POSIX path of (choose folder with prompt "选择要扫描的 Workspace 目录")'];
  } else if (process.platform === 'win32') {
    command = 'powershell.exe';
    args = [
      '-NoProfile', '-STA', '-Command',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = "选择要扫描的 Workspace 目录"; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }'
    ];
  } else {
    command = 'zenity';
    args = ['--file-selection', '--directory', '--title=选择要扫描的 Workspace 目录'];
  }

  try {
    const { stdout } = await execFileAsync(command, args, { maxBuffer: 16 * 1024 });
    return stdout.trim() || null;
  } catch (err) {
    if (err.code === 1) return null;
    if (err.code === 'ENOENT' && process.platform === 'linux') {
      try {
        const { stdout } = await execFileAsync('kdialog', ['--getexistingdirectory', os.homedir(), '--title', '选择要扫描的 Workspace 目录'], { maxBuffer: 16 * 1024 });
        return stdout.trim() || null;
      } catch (fallbackError) {
        if (fallbackError.code === 1) return null;
        if (fallbackError.code === 'ENOENT') {
          throw new Error('当前系统缺少目录选择器，请安装 zenity 或 kdialog，或使用手动输入路径。');
        }
        throw new Error(`打开目录选择器失败：${fallbackError.message}`);
      }
    }
    throw new Error(`打开目录选择器失败：${err.message}`);
  }
}

/**
 * 将用户输入的目录转换为绝对路径，支持使用 ~ 表示用户主目录。
 * @param {unknown} value - 用户输入的目录字符串
 * @returns {string|null} 归一化后的绝对路径；空值或非字符串返回 null
 */
function normalizeScanDirectory(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const isHomeRelative = trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\');
  const expanded = isHomeRelative
    ? path.join(os.homedir(), trimmed.slice(1).replace(/^[/\\]+/, ''))
    : trimmed;
  return path.resolve(expanded);
}

/**
 * 解析用于比较的真实路径，兼容 macOS 上 /var 与 /private/var 这类符号链接别名。
 * @param {string} targetPath - 待解析路径
 * @returns {Promise<string>} realpath 结果；路径不存在时回退 path.resolve
 */
async function getComparablePath(targetPath) {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

/**
 * 移除 Worktree 后可选删除它的绑定分支，供单项与批量入口复用。
 * 删除分支前再次核对绑定关系，避免页面数据过期时删除其它分支。
 * @param {string} repoPath - 仓库路径
 * @param {string} worktreePath - Worktree 路径
 * @param {boolean} force - 是否强制移除
 * @param {string|null} branchName - 绑定分支名
 * @param {boolean} shouldDeleteBranch - 是否连带删除绑定分支
 */
async function removeWorktreeWithBranch(repoPath, worktreePath, force, branchName, shouldDeleteBranch) {
  if (shouldDeleteBranch) {
    if (!branchName) throw new Error('缺少待删除的绑定分支');
    const worktrees = await getWorktrees(repoPath);
    const comparableWorktreePath = await getComparablePath(worktreePath);
    let boundWorktree = null;
    for (const worktree of worktrees) {
      if (await getComparablePath(worktree.path) === comparableWorktreePath) {
        boundWorktree = worktree;
        break;
      }
    }
    if (!boundWorktree || boundWorktree.isMain || boundWorktree.branch !== branchName) {
      throw new Error('只能删除与该 Worktree 强绑定的非主分支');
    }
  }

  const result = await removeWorktree(repoPath, worktreePath, force);
  let branchDeleted = false;
  let branchDeleteError = null;
  if (shouldDeleteBranch && result.removed) {
    try {
      const branchResult = await deleteBranch(repoPath, branchName, true);
      branchDeleted = branchResult.deleted;
      if (!branchDeleted) branchDeleteError = '分支删除后仍然存在';
    } catch (err) {
      // Worktree 已经移除，无法回滚；把分支删除失败明确返回给前端。
      branchDeleteError = err.message;
    }
  }
  return {
    ...result,
    branchName: shouldDeleteBranch ? branchName : null,
    branchDeleted,
    branchDeleteError
  };
}

/**
 * 构造带 statusCode 的错误对象，供顶层统一按状态码返回中文错误。
 * @param {string} message - 中文错误信息
 * @param {number} statusCode - HTTP 状态码
 * @returns {Error}
 */
function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * 以常数时间比较两个会话凭据字符串，避免逐字节比较造成的时序侧信道。
 * @param {string} actual - 请求携带的凭据
 * @param {string} expected - 服务实例持有的凭据
 * @returns {boolean} 两者一致时返回 true
 */
function timingSafeEqual(actual, expected) {
  const a = Buffer.from(String(actual), 'utf-8');
  const b = Buffer.from(String(expected), 'utf-8');
  if (a.length !== b.length) {
    // 长度不同时仍执行一次比较，保持耗时与命中场景接近
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * 校验工厂参数并填充默认值。
 * @param {object} options - createGitLensServer 的原始参数
 * @returns {object} 归一化后的配置
 */
function normalizeOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('创建 Git Lens 服务失败：必须传入 options 配置对象');
  }
  const configDir = options.configDir;
  if (typeof configDir !== 'string' || configDir.trim() === '') {
    throw new TypeError('创建 Git Lens 服务失败：configDir 必须为非空字符串');
  }

  const mode = options.mode || 'browser';
  if (mode !== 'browser' && mode !== 'desktop') {
    throw new TypeError(`创建 Git Lens 服务失败：mode 只支持 'browser' 或 'desktop'，收到「${mode}」`);
  }

  const sessionToken = options.sessionToken || null;
  if (mode === 'desktop' && !sessionToken) {
    throw new TypeError('创建 Git Lens 服务失败：desktop 模式必须提供 sessionToken 会话凭据');
  }

  const port = options.port === undefined || options.port === null ? 0 : options.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError(`创建 Git Lens 服务失败：port 必须为 0-65535 的整数，收到「${options.port}」`);
  }

  const requestBodyLimit = options.requestBodyLimit === undefined || options.requestBodyLimit === null
    ? DEFAULT_REQUEST_BODY_LIMIT
    : options.requestBodyLimit;
  if (!Number.isInteger(requestBodyLimit) || requestBodyLimit <= 0) {
    throw new TypeError(`创建 Git Lens 服务失败：requestBodyLimit 必须为正整数，收到「${options.requestBodyLimit}」`);
  }

  const handshake = options.handshake && typeof options.handshake === 'object' ? options.handshake : null;
  if (handshake && (typeof handshake.runId !== 'string' || handshake.runId === '')) {
    throw new TypeError('创建 Git Lens 服务失败：handshake.runId 必须为非空字符串');
  }

  return {
    configDir,
    host: options.host || '127.0.0.1',
    port,
    mode,
    sessionToken,
    chooseScanDirectory: typeof options.chooseScanDirectory === 'function' ? options.chooseScanDirectory : chooseScanDirectory,
    requestBodyLimit,
    // 静态根目录：默认与 index.html 同源（public/）；测试可注入临时目录
    staticRoot: typeof options.staticRoot === 'string' && options.staticRoot.trim() !== ''
      ? options.staticRoot
      : path.join(path.dirname(url.fileURLToPath(import.meta.url)), '../public'),
    handshake,
    log: typeof options.log === 'function' ? options.log : null
  };
}

/**
 * 创建 Git Lens HTTP 服务实例。本模块导入时零副作用（不创建 server、不监听、不读配置），
 * 所有副作用都发生在 createGitLensServer 调用之后，供 CLI 与 Electron 主进程复用。
 * @param {object} options
 * @param {string}   options.configDir            必填；配置目录（扫描目录与本地 MR 数据的根）
 * @param {string}  [options.host='127.0.0.1']    监听地址；桌面版与测试一律环回
 * @param {number}  [options.port=0]              0 = 系统分配随机端口
 * @param {'browser'|'desktop'} [options.mode='browser'] 访问边界模式，见契约 §4
 * @param {string|null} [options.sessionToken]    desktop 模式必填；browser 模式忽略
 * @param {() => Promise<string|null>} [options.chooseScanDirectory] 覆盖目录选择器；缺省用系统对话框实现
 * @param {string}  [options.gitPath]             git 可执行文件路径；缺省取 GIT_LENS_GIT_PATH，再缺省 'git'
 * @param {number}  [options.requestBodyLimit=2*1024*1024] JSON 请求体字节上限
 * @param {{ runId: string }} [options.handshake] 提供时启用 GET /api/test-handshake（仅测试注入）
 * @param {string}  [options.staticRoot]          静态资源根目录（index.html/app.js/app.css）；缺省为仓库 public/
 * @param {(level: 'info'|'warn'|'error', message: string) => void} [options.log]
 * @returns {{ server: http.Server, ready: Promise<{host: string, port: number}>, close: () => Promise<void> }}
 */
export function createGitLensServer(options) {
  const config = normalizeOptions(options);
  const configDir = config.configDir;
  const configFilePath = path.join(configDir, 'config.json');

  // 显式传入 gitPath 时注入两块 Git 调用模块；未传入时保持模块默认
  // （GIT_LENS_GIT_PATH 环境变量 > 'git'），行为与既有部署完全一致。
  if (options.gitPath) {
    configureInspectorGitPath(options.gitPath);
    configureMrGitPath(options.gitPath);
  }

  const log = (level, message) => {
    if (config.log) {
      config.log(level, message);
      return;
    }
    if (level === 'error') console.error(message);
    else if (level === 'warn') console.warn(message);
    else console.log(message);
  };

  /**
   * 读取扫描目录配置。配置文件不存在时按首次使用处理。
   * @returns {Promise<{customDirectories: string[]}>}
   */
  async function readScanConfig() {
    try {
      const raw = await fs.readFile(configFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const customDirectories = Array.isArray(parsed.customDirectories)
        ? parsed.customDirectories.map(normalizeScanDirectory).filter(Boolean)
        : [];
      return { customDirectories: [...new Set(customDirectories)] };
    } catch {
      return { customDirectories: [] };
    }
  }

  /**
   * 保存扫描目录配置，并保证配置目录存在。
   * @param {string[]} customDirectories - 归一化后的目录列表
   */
  async function writeScanConfig(customDirectories) {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configFilePath, JSON.stringify({ customDirectories }, null, 2) + '\n', 'utf-8');
  }

  /**
   * 返回当前用户的自定义目录，供接口和仓库发现逻辑共同使用。
   */
  async function getScanConfig() {
    const { customDirectories } = await readScanConfig();
    return { customDirectories, scanDirectories: [...customDirectories] };
  }

  // 星标持久化（契约 §16）：stars.json 与 config.json 同目录落位，
  // 路径在工厂内按本实例 configDir 解析（configDir 为工厂级常量、模块级无缓存），
  // 因此 web 与桌面共享同一 configDir 时星标自动互通，隔离目录互不可见。
  const starsFilePath = path.join(configDir, 'stars.json');

  /**
   * 读取星标列表。文件不存在按空列表处理（首次使用）；JSON 损坏或结构异常
   * 同样视为空列表且不抛错（记 warn 日志），避免一个坏文件拖垮整个页面。
   * @returns {Promise<string[]>} 去重后的仓库绝对路径列表（保持插入顺序）
   */
  async function readStars() {
    try {
      const raw = await fs.readFile(starsFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.starred)) return [];
      // 读取即归一化：过滤非字符串项并去重，容忍历史脏数据
      return [...new Set(parsed.starred.filter(item => typeof item === 'string' && item.trim() !== ''))];
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log('warn', `stars.json 读取失败，已按空星标列表处理：${err.message}`);
      }
      return [];
    }
  }

  /**
   * 原子写入星标列表：先写同目录临时文件再 rename 替换，避免写入中途
   * 崩溃留下半截 JSON；rename 失败时尽力清理临时文件。
   * @param {string[]} starred - 去重后的仓库绝对路径列表
   */
  async function writeStars(starred) {
    await fs.mkdir(configDir, { recursive: true });
    // 临时文件与目标同目录，保证 rename 在同一文件系统上原子生效；随机后缀避免并发互踩
    const tmp = `${starsFilePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(tmp, JSON.stringify({ version: 1, starred }, null, 2) + '\n', 'utf-8');
      await fs.rename(tmp, starsFilePath);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * 发现扫描目录中的 Git 仓库。目录本身是仓库时直接收录，否则只检查直接子目录。
   * @param {string[]|null} [scanDirectories] - 扫描目录列表；缺省读配置
   */
  async function discoverRepos(scanDirectories = null) {
    if (!scanDirectories) scanDirectories = (await getScanConfig()).scanDirectories;
    const repos = [];
    const seenPaths = new Set();
    for (const base of scanDirectories) {
      try {
        if (await isGitRepo(base)) {
          const repoPath = path.resolve(base);
          if (!seenPaths.has(repoPath)) {
            seenPaths.add(repoPath);
            repos.push({ name: path.basename(repoPath), path: repoPath, group: path.basename(path.dirname(repoPath)) });
          }
          continue;
        }
        const entries = await fs.readdir(base, { withFileTypes: true });
        for (const ent of entries) {
          if (ent.isDirectory() && !ent.name.startsWith('.')) {
            const fullPath = path.join(base, ent.name);
            if (await isGitRepo(fullPath) && !seenPaths.has(path.resolve(fullPath))) {
              seenPaths.add(path.resolve(fullPath));
              repos.push({ name: ent.name, path: fullPath, group: path.basename(base) });
            }
          }
        }
      } catch {
        // 忽略不存在或暂时无法读取的目录
      }
    }
    return repos;
  }

  /**
   * 发送 JSON 响应（统一 charset）。
   * @param {http.ServerResponse} res
   * @param {number} statusCode
   * @param {object} payload
   */
  function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }

  /**
   * 解析 realpath 后的配置目录。首次使用时目录可能尚未创建，创建后取 realpath，
   * 保证握手与诊断接口始终返回规范路径。
   * @returns {Promise<string>}
   */
  async function resolveRealConfigDir() {
    try {
      return await fs.realpath(configDir);
    } catch {
      await fs.mkdir(configDir, { recursive: true });
      return fs.realpath(configDir);
    }
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      // handler 自身不应抛错；兜底防止未捕获异常拖垮整个进程
      log('error', `请求处理发生未预期错误：${err && err.stack ? err.stack : err}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: '服务器内部错误' });
      else res.destroy();
    });
  });

  // 监听后回填的实际地址；port:0 场景由 listen 回调写入真实端口，
  // 访问边界校验（Host/Origin）依赖这个值，不能使用调用方传入的占位端口。
  let actualHost = config.host;
  let actualPort = config.port;

  const ready = new Promise((resolve, reject) => {
    let settled = false;
    server.once('error', err => {
      if (settled) return;
      settled = true;
      // 端口占用是最常见的启动失败，给出可直接展示给用户的中文提示
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${config.port} 已被占用，无法启动 Git Lens Web 服务，请更换端口或先停止占用该端口的进程`));
      } else {
        reject(new Error(`Git Lens Web 服务监听 ${config.host}:${config.port} 失败：${err.code || err.message}`));
      }
    });
    server.listen(config.port, config.host, () => {
      settled = true;
      const address = server.address();
      actualHost = config.host;
      actualPort = address.port;
      resolve({ host: actualHost, port: actualPort });
    });
  });

  ready.catch(err => {
    // 监听失败已通过 ready reject 交给调用方处理；这里兜底记录，避免无人 await 时被吞掉
    log('error', err.message);
  });

  /**
   * 关闭服务：停止接受新连接 → 等待在途请求结束 → 超时后强制销毁全部连接。
   * 幂等：重复调用 resolve 同一结果。
   * @returns {Promise<void>}
   */
  let closing = null;
  function close() {
    if (closing) return closing;
    closing = new Promise(resolve => {
      server.close(() => resolve());
      // 宽限期到点后强制销毁残余连接（如浏览器持有的 keep-alive 长连接），
      // unref 保证等待方全部退出时进程不被这个定时器拖住
      const timer = setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
      }, CLOSE_GRACE_PERIOD_MS);
      timer.unref();
    });
    return closing;
  }

  /**
   * 逐请求入口：先执行访问边界校验（Host/Origin/会话凭据/请求体类型），
   * 再进入既有路由。所有拒绝路径返回中文错误。
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function handleRequest(req, res) {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;

    // CSP（契约 §14 G3 冻结）：本实例发出的所有响应统一携带，含静态页、API、静态资源与拒绝响应
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);

    // ---- 访问边界（契约 §4）：所有请求统一执行，先于任何业务逻辑 ----

    // 1. Host 校验：防 DNS rebinding。只接受本机主机名 + 本实例实际端口。
    const hostHeader = String(req.headers.host || '').toLowerCase();
    const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    if (!allowedHosts.includes(hostHeader)) {
      return sendJson(res, 403, { ok: false, error: '拒绝访问：Host 头不是本机地址，疑似 DNS rebinding 或跨机访问' });
    }

    // 2. Origin 校验：携带 Origin 的请求仅接受本机同源来源；
    //    Origin: null（sandboxed iframe/重定向）与其他站点一律拒绝。
    const origin = req.headers.origin;
    const allowedOrigins = [`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`];
    const originAllowed = origin !== undefined && allowedOrigins.includes(origin);
    if (origin !== undefined && !originAllowed) {
      return sendJson(res, 403, { ok: false, error: '拒绝访问：请求来源不在本机允许列表内' });
    }

    // 3. CORS 收紧：不再发送 Access-Control-Allow-Origin: *。
    //    预检仅对本机同源来源放行（此时 originAllowed 为真），其余已被上面的 Origin 校验拒绝。
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Git-Lens-Session',
        Vary: 'Origin'
      });
      return res.end();
    }

    // 4. desktop 模式会话凭据：每个 /api 请求必须携带主进程注入的 token。
    //    browser 模式无主进程托管凭据，忽略该头。
    if (config.mode === 'desktop' && pathname.startsWith('/api/')) {
      const token = req.headers['x-git-lens-session'];
      if (typeof token !== 'string' || !timingSafeEqual(token, config.sessionToken)) {
        return sendJson(res, 403, { ok: false, error: '拒绝访问：缺少或会话凭据不匹配' });
      }
    }

    // 5. 请求体类型检查：/api 的 POST 必须是 JSON。
    //    （契约 §4 第一次修订）choose-scan-directory 的例外已收紧：UI 已为该调用
    //    补齐 'Content-Type': 'application/json'，现在与其他 /api POST 一律同规则。
    if (req.method === 'POST' && pathname.startsWith('/api/')) {
      const contentType = String(req.headers['content-type'] || '').trim().toLowerCase();
      if (!contentType.startsWith('application/json')) {
        return sendJson(res, 415, { ok: false, error: '不支持的请求格式：Content-Type 必须为 application/json' });
      }
    }

    try {
      /**
       * 读取 JSON 请求体；超过 requestBodyLimit 时抛 413（中文错误）。
       * 超限后丢弃后续数据并等请求自然结束再响应，保证拒绝响应可靠送达。
       */
      const readJson = () => new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let oversized = false;
        req.on('data', chunk => {
          size += chunk.length;
          if (size > config.requestBodyLimit) {
            oversized = true;
            chunks.length = 0;
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          if (oversized) {
            reject(httpError(`请求体超过大小限制（最大 ${config.requestBodyLimit} 字节）`, 413));
            return;
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          try { resolve(raw ? JSON.parse(raw) : {}); }
          catch (e) { reject(e); }
        });
        req.on('error', reject);
      });

      // 测试模式握手接口：两个条件（测试模式环境变量 + 工厂注入 runId）缺一不可，
      // 生产实例不可探测；不满足时按未知路径处理返回 404。
      if (pathname === '/api/test-handshake' && req.method === 'GET') {
        if (config.handshake && process.env.GIT_LENS_TEST_MODE === '1') {
          return sendJson(res, 200, {
            ok: true,
            runId: config.handshake.runId,
            configDir: await resolveRealConfigDir(),
            host: actualHost,
            port: actualPort,
            pid: process.pid
          });
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not Found');
      }

      // 12. API: Git 环境诊断（契约 §7）。探测走与业务调用同一解析链的最终 git 路径，
      // git 缺失/超时时 found:false 且 ok 仍为 true——诊断接口自身绝不能因环境损坏而 500。
      if (pathname === '/api/diagnostics' && req.method === 'GET') {
        const git = await getGitDiagnostics();
        return sendJson(res, 200, {
          ok: true,
          git,
          configDir: await resolveRealConfigDir(),
          platform: process.platform,
          node: process.version
        });
      }

      // 1. API: 发现项目列表
      if (pathname === '/api/projects' && req.method === 'GET') {
        const repos = await discoverRepos();
        return sendJson(res, 200, { ok: true, repos });
      }

      // 1.5 API: 获取当前扫描目录配置
      if (pathname === '/api/scan-directories' && req.method === 'GET') {
        const config = await getScanConfig();
        return sendJson(res, 200, { ok: true, ...config });
      }

      // 2. API: 分析指定仓库状态
      if (pathname === '/api/inspect' && req.method === 'GET') {
        const repoPath = parsed.query.path;
        if (!repoPath || !(await isGitRepo(repoPath))) {
          return sendJson(res, 400, { ok: false, error: 'Path is not a valid git repository' });
        }

        const [worktrees, branchData] = await Promise.all([
          getWorktrees(repoPath),
          getBranches(repoPath)
        ]);

        // 传递吸收判定收尾：worktree 自身的四方判定没有全局分支视图。
        // 先同步分支侧结论（含历史整合推断覆盖的场景），再对 worktree 直接探测载体——
        // squash/PR 合并后的开发分支在分支面板常已显示合入，worktree 面板却仍显示领先
        annotateWorktreesFromBranches(worktrees, branchData.branches);
        await annotateDeliveredViaWorktrees(repoPath, worktrees, branchData.branches);

        const staleWorktrees = worktrees.filter(w => !w.isMain && (!w.existsOnDisk || w.isPrunable));
        const redundantBranches = branchData.branches.filter(b => b.redundancyReason);

        return sendJson(res, 200, {
          ok: true,
          repoPath,
          mainBranch: branchData.mainBranch,
          summary: {
            totalWorktrees: worktrees.length,
            staleWorktreesCount: staleWorktrees.length,
            totalBranches: branchData.branches.length,
            redundantBranchesCount: redundantBranches.length
          },
          worktrees,
          branches: branchData.branches
        });
      }

      // 1.6 API: 保存自定义扫描目录
      if (pathname === '/api/scan-directories' && req.method === 'POST') {
        const body = await readJson();
        if (!Array.isArray(body.directories)) {
          return sendJson(res, 400, { ok: false, error: 'directories 必须是目录路径数组' });
        }

        const normalizedDirectories = body.directories.map(normalizeScanDirectory);
        if (normalizedDirectories.some(dir => !dir)) {
          return sendJson(res, 400, { ok: false, error: '目录路径不能为空' });
        }

        const customDirectories = [...new Set(normalizedDirectories)];
        const invalidDirectories = [];
        for (const directory of customDirectories) {
          try {
            const stat = await fs.stat(directory);
            if (!stat.isDirectory()) invalidDirectories.push(directory);
          } catch {
            invalidDirectories.push(directory);
          }
        }

        if (invalidDirectories.length > 0) {
          return sendJson(res, 400, {
            ok: false,
            error: '以下路径不存在或不是目录',
            invalidDirectories
          });
        }

        await writeScanConfig(customDirectories);
        const config = await getScanConfig();
        return sendJson(res, 200, { ok: true, ...config });
      }

      // 1.7 API: 仓库星标持久化（契约 §16）。GET 供页面启动拉取唯一事实源；
      // POST 为单项增删（幂等：重复加星去重、取消不存在的星不动列表）。
      // Host/Origin/会话凭据/请求体限制由入口统一执行，此处无特例。
      if (pathname === '/api/stars' && req.method === 'GET') {
        const starred = await readStars();
        return sendJson(res, 200, { ok: true, starred });
      }

      if (pathname === '/api/stars' && req.method === 'POST') {
        const { repoPath, starred } = await readJson();
        if (typeof repoPath !== 'string' || repoPath.trim() === '') {
          return sendJson(res, 400, { ok: false, error: 'repoPath 必须为非空字符串' });
        }
        if (typeof starred !== 'boolean') {
          return sendJson(res, 400, { ok: false, error: 'starred 必须为布尔值' });
        }
        let stars = await readStars();
        if (starred) {
          if (!stars.includes(repoPath)) stars = [...stars, repoPath];
        } else {
          stars = stars.filter(item => item !== repoPath);
        }
        await writeStars(stars);
        return sendJson(res, 200, { ok: true, starred: stars });
      }

      // 系统对话框只接受本机页面的调用（Origin 已在全局边界校验中限制）。
      if (pathname === '/api/choose-scan-directory' && req.method === 'POST') {
        const directory = await config.chooseScanDirectory();
        return sendJson(res, 200, { ok: true, directory });
      }

      // 3. API: 清理分支 (精细化判定，返回单项删除状态)
      if (pathname === '/api/delete-branch' && req.method === 'POST') {
        const { repoPath, branchName, force } = await readJson();
        if (!repoPath || !branchName) throw new Error('Missing repoPath or branchName');
        const result = await deleteBranch(repoPath, branchName, force);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...result }));
      }

      // 4. API: 移除 Worktree (精细化判定，返回单项移除状态)
      if (pathname === '/api/remove-worktree' && req.method === 'POST') {
        const { repoPath, worktreePath, force, branchName, deleteBranch: shouldDeleteBranch } = await readJson();
        if (!repoPath || !worktreePath) throw new Error('Missing repoPath or worktreePath');
        let result;
        try {
          result = await removeWorktreeWithBranch(repoPath, worktreePath, force, branchName, shouldDeleteBranch);
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...result }));
      }

      // 4.1 批量清理预览：只返回已同步且干净的 Worktree、未绑定的已合入分支。
      if (pathname === '/api/cleanup-candidates' && req.method === 'GET') {
        const repoPath = parsed.query.path;
        if (!repoPath || !(await isGitRepo(repoPath))) {
          return sendJson(res, 400, { ok: false, error: '仓库路径无效' });
        }
        const candidates = await getCleanupCandidates(repoPath);
        return sendJson(res, 200, { ok: true, ...candidates });
      }

      // 4.2 执行前重新核验每个候选；只处理用户在预览中确认的路径。
      if (pathname === '/api/cleanup-synced-worktrees' && req.method === 'POST') {
        const { repoPath, paths, deleteBoundBranches } = await readJson();
        if (!repoPath || !(await isGitRepo(repoPath)) || !Array.isArray(paths)
          || paths.length > 100 || paths.some(item => typeof item !== 'string' || !path.isAbsolute(item))) {
          return sendJson(res, 400, { ok: false, error: '清理参数无效' });
        }
        const current = await getCleanupCandidates(repoPath);
        const results = [];
        for (const worktreePath of new Set(paths)) {
          try {
            const comparablePath = await getComparablePath(worktreePath);
            let candidate = null;
            for (const item of current.worktrees) {
              if (await getComparablePath(item.path) === comparablePath) {
                candidate = item;
                break;
              }
            }
            if (!candidate) {
              results.push({ path: worktreePath, removed: false, error: '状态已变化，不再符合安全清理条件' });
              continue;
            }
            const result = await removeWorktreeWithBranch(
              repoPath, candidate.path, false, candidate.branch, Boolean(deleteBoundBranches)
            );
            results.push({ path: worktreePath, ...result });
          } catch (err) {
            results.push({ path: worktreePath, removed: false, error: err.message });
          }
        }
        return sendJson(res, 200, { ok: true, results });
      }

      // 4.3 分支批量清理只接受预览中的名称，并逐项重新核验绑定与合入状态。
      if (pathname === '/api/cleanup-redundant-branches' && req.method === 'POST') {
        const { repoPath, names } = await readJson();
        if (!repoPath || !(await isGitRepo(repoPath)) || !Array.isArray(names)
          || names.length > 100 || names.some(item => typeof item !== 'string' || !item.trim())) {
          return sendJson(res, 400, { ok: false, error: '清理参数无效' });
        }
        const current = await getCleanupCandidates(repoPath);
        const results = [];
        for (const branchName of new Set(names)) {
          try {
            const candidate = current.branches.find(item => item.name === branchName);
            if (!candidate) {
              results.push({ name: branchName, deleted: false, error: '状态已变化，不再符合安全清理条件' });
              continue;
            }
            const result = await deleteBranch(repoPath, branchName, true);
            results.push({ name: branchName, ...result });
          } catch (err) {
            results.push({ name: branchName, deleted: false, error: err.message });
          }
        }
        return sendJson(res, 200, { ok: true, results });
      }

      // 5. API: 单项检查分支状态
      if (pathname === '/api/check-branch' && req.method === 'GET') {
        const repoPath = parsed.query.path;
        const branchName = parsed.query.branch;
        if (!repoPath || !branchName) throw new Error('Missing repoPath or branchName');
        const exists = await checkBranchExists(repoPath, branchName);
        return sendJson(res, 200, { ok: true, branchName, exists });
      }

      // 6. API: 单项检查 Worktree 状态
      if (pathname === '/api/check-worktree' && req.method === 'GET') {
        const repoPath = parsed.query.path;
        const worktreePath = parsed.query.worktree;
        if (!repoPath || !worktreePath) throw new Error('Missing repoPath or worktreePath');
        const exists = await checkWorktreeExists(repoPath, worktreePath);
        return sendJson(res, 200, { ok: true, worktreePath, exists });
      }

      // 7. API: 获取两个 Worktree 之间的对比 Diff (支持 mode 参数: uncommitted | all | committed)
      if (pathname === '/api/diff-worktrees' && req.method === 'GET') {
        const repoPath = parsed.query.path;
        const source = parsed.query.source;
        const target = parsed.query.target;
        const mode = parsed.query.mode || null;
        if (!repoPath || !source || !target) {
          return sendJson(res, 400, { ok: false, error: 'Missing path, source, or target parameter' });
        }
        const diffData = await getWorktreeDiff(repoPath, source, target, mode);
        return sendJson(res, 200, { ok: true, diff: diffData });
      }

      // 8. API: 获取指定 Worktree 的提交记录
      if (pathname === '/api/worktree-commits' && req.method === 'GET') {
        const worktreePath = parsed.query.worktree;
        if (!worktreePath) {
          return sendJson(res, 400, { ok: false, error: 'Missing worktree parameter' });
        }
        try {
          const result = await getWorktreeCommits(worktreePath, {
            limit: parsed.query.limit,
            offset: parsed.query.offset,
            base: parsed.query.base,
            fullHistory: parsed.query.fullHistory,
            author: parsed.query.author,
            since: parsed.query.since,
            until: parsed.query.until,
            grep: parsed.query.grep,
            ref: parsed.query.ref
          });
          return sendJson(res, 200, result);
        } catch (err) {
          const status = err.statusCode || 500;
          return sendJson(res, status, { ok: false, error: err.message });
        }
      }

      // 8.1 API: 获取单条提交详情（元信息 + 逐文件统计）
      if (pathname === '/api/commit-detail' && req.method === 'GET') {
        const worktreePath = parsed.query.worktree;
        const sha = parsed.query.sha;
        if (!worktreePath || !sha) {
          return sendJson(res, 400, { ok: false, error: 'Missing worktree or sha parameter' });
        }
        try {
          const result = await getCommitDetail(worktreePath, sha);
          return sendJson(res, 200, result);
        } catch (err) {
          const status = err.statusCode || 500;
          return sendJson(res, status, { ok: false, error: err.message });
        }
      }

      // 8.2 API: 获取指定 Worktree 相对基准分支的领先/落后统计
      if (pathname === '/api/worktree-ahead-behind' && req.method === 'GET') {
        const worktreePath = parsed.query.worktree;
        if (!worktreePath) {
          return sendJson(res, 400, { ok: false, error: 'Missing worktree parameter' });
        }
        try {
          const result = await getWorktreeAheadBehind(worktreePath, { base: parsed.query.base, ref: parsed.query.ref });
          return sendJson(res, 200, result);
        } catch (err) {
          const status = err.statusCode || 500;
          return sendJson(res, status, { ok: false, error: err.message });
        }
      }

      // 8.3 API: 获取单条提交的逐文件文本 Diff（merge 对第一父、根提交用 --root，规则与 8.1 一致）
      if (pathname === '/api/commit-diff' && req.method === 'GET') {
        const worktreePath = parsed.query.worktree;
        const sha = parsed.query.sha;
        if (!worktreePath || !sha) {
          return sendJson(res, 400, { ok: false, error: 'Missing worktree or sha parameter' });
        }
        try {
          const result = await getCommitDiff(worktreePath, sha);
          return sendJson(res, 200, result);
        } catch (err) {
          const status = err.statusCode || 500;
          return sendJson(res, status, { ok: false, error: err.message });
        }
      }

      // 9. API: 获取指定 Worktree 的本地未提交改动 (Dirty/Uncommitted Diff)
      if (pathname === '/api/uncommitted-diff' && req.method === 'GET') {
        const worktreePath = parsed.query.worktree;
        if (!worktreePath) {
          return sendJson(res, 400, { ok: false, error: 'Missing worktree parameter' });
        }
        const uncommitted = await getUncommittedDiff(worktreePath);
        return sendJson(res, 200, { ok: true, uncommitted });
      }

      // 10. API: 对指定 Worktree 的当前分支执行 cherry-pick / revert 写操作。
      // 请求体 { worktree, action, sha }；所有业务校验（action 白名单/路径/sha）都在
      // commitAction 内完成并抛带 statusCode 的中文错误，冲突等失败时后端已自动回滚现场。
      if (pathname === '/api/commit-action' && req.method === 'POST') {
        const { worktree, action, sha } = await readJson();
        try {
          const result = await commitAction(worktree, action, sha);
          return sendJson(res, 200, result);
        } catch (err) {
          const status = err.statusCode || 500;
          return sendJson(res, status, { ok: false, error: err.message });
        }
      }

      // 11.1 API: 获取指定 Worktree 的 stash 列表
      if (pathname === '/api/stash-list' && req.method === 'GET') {
        const worktreePath = parsed.query.worktree;
        if (!worktreePath) {
          return sendJson(res, 400, { ok: false, error: 'Missing worktree parameter' });
        }
        try {
          const stashes = await getStashList(worktreePath);
          return sendJson(res, 200, { ok: true, stashes });
        } catch (err) {
          const status = err.statusCode || 500;
          return sendJson(res, status, { ok: false, error: err.message });
        }
      }

      // 11.2 API: 对指定 Worktree 执行 stash 与未提交修改操作。
      // pop 可另选同仓库的目标 Worktree 或分支；未绑定的分支需指定新 Worktree 目录。
      if (pathname === '/api/stash-action' && req.method === 'POST') {
        const { worktree, action, message, stashRef, targetWorktree, targetBranch, newWorktreePath } = await readJson();
        try {
          const result = await stashAction(worktree, action, { message, stashRef, targetWorktree, targetBranch, newWorktreePath });
          return sendJson(res, 200, result);
        } catch (err) {
          const status = err.statusCode || 500;
          return sendJson(res, status, { ok: false, error: err.message });
        }
      }

      // 11.5 API: 本地 Merge Request 列表（可按 status 过滤）。
      // 业务校验（仓库路径/状态白名单）收敛在 listMergeRequests 内，err.statusCode 统一捕获。
      if (pathname === '/api/merge-requests' && req.method === 'GET') {
        try {
          const result = await listMergeRequests({
            configDir,
            repoPath: parsed.query.repoPath,
            status: parsed.query.status
          });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          const status = err.statusCode || 500;
          return sendJson(res, status, { ok: false, error: err.message });
        }
      }

      // 11.6 API: 创建本地 Merge Request（重复 open MR 返回 409）
      if (pathname === '/api/merge-requests' && req.method === 'POST') {
        const { repoPath, sourceBranch, targetBranch, title, description } = await readJson();
        try {
          const result = await createMergeRequest({ configDir, repoPath, sourceBranch, targetBranch, title, description });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          const status = err.statusCode || 500;
          return sendJson(res, status, { ok: false, error: err.message });
        }
      }

      // 11.7 API: 获取单条 Merge Request（id 为 UUID，非法格式返回 400，不存在返回 404）
      if (pathname.startsWith('/api/merge-requests/') && req.method === 'GET') {
        const mrId = pathname.slice('/api/merge-requests/'.length);
        try {
          const result = await getMergeRequest({ configDir, repoPath: parsed.query.repoPath, id: decodeURIComponent(mrId) });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          const status = err.statusCode || 500;
          return sendJson(res, status, { ok: false, error: err.message });
        }
      }

      // 11.8 API: Merge Request 审阅/合并操作（approve/request_changes/reject/cancel/merge）。
      // 合并会真实修改目标分支的 Worktree（--no-ff），冲突时服务端已自动 merge --abort，MR 保持 open。
      if (pathname === '/api/merge-requests/action' && req.method === 'POST') {
        const { repoPath, id, action, reason } = await readJson();
        try {
          const result = await mergeRequestAction({ configDir, repoPath, id, action, reason });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          const status = err.statusCode || 500;
          return sendJson(res, status, { ok: false, error: err.message });
        }
      }

      // 7.5 API: Worktree/Branch 通用 Diff。sourceType/targetType 取 worktree|branch，
      // source/target 按类型分别为 Worktree 路径或本地分支名；语义见 getRefDiff。
      if (pathname === '/api/diff-refs' && req.method === 'GET') {
        const repoPath = parsed.query.path;
        const sourceType = parsed.query.sourceType;
        const source = parsed.query.source;
        const targetType = parsed.query.targetType;
        const target = parsed.query.target;
        const mode = parsed.query.mode || null;
        if (!repoPath || !sourceType || !source || !targetType || !target) {
          return sendJson(res, 400, { ok: false, error: '缺少 path、sourceType、source、targetType 或 target 参数' });
        }
        try {
          const diffData = await getRefDiff(repoPath, { kind: sourceType, value: source }, { kind: targetType, value: target }, mode);
          return sendJson(res, 200, { ok: true, diff: diffData });
        } catch (err) {
          const status = err.statusCode || 500;
          return sendJson(res, status, { ok: false, error: err.message });
        }
      }

      // 8.5 API: 获取指定版本或工作区的原始文件二进制流 (如图片显示)
      if (pathname === '/api/raw-file' && req.method === 'GET') {
        const repoPath = parsed.query.repoPath;
        const revision = parsed.query.revision || 'HEAD';
        const filePath = parsed.query.filePath;
        const worktreePath = parsed.query.worktreePath || null;

        if (!filePath) {
          return sendJson(res, 400, { ok: false, error: 'Missing filePath parameter' });
        }

        const buffer = await getFileContentBuffer(repoPath, revision, filePath, worktreePath);
        if (!buffer) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('File not found in git revision or worktree');
        }

        const mime = getMimeType(filePath);
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': buffer.length,
          'Cache-Control': 'no-cache'
        });
        return res.end(buffer);
      }

      // 9. API: Worktree Prune
      if (pathname === '/api/prune-worktrees' && req.method === 'POST') {
        const { repoPath } = await readJson();
        if (!repoPath) throw new Error('Missing repoPath');
        const out = await pruneWorktrees(repoPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, output: out }));
      }

      // 静态资源白名单（UI 已将内联脚本/样式外置）：仅 pathname 精确相等命中，
      // /app.js/、/app.js%00、/app.js/../ 等一切变形都不匹配白名单自然落入 404；
      // 文件缺失同样 404。凭据策略与静态页一致（desktop 模式不校验 token）。
      if (req.method === 'GET' && STATIC_FILE_WHITELIST[pathname]) {
        const entry = STATIC_FILE_WHITELIST[pathname];
        try {
          const content = await fs.readFile(path.join(config.staticRoot, entry.file));
          res.writeHead(200, {
            'Content-Type': entry.contentType,
            'Cache-Control': 'no-cache'
          });
          return res.end(content);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('Not Found');
        }
      }

      // 静态首页 HTML
      if (pathname === '/' || pathname === '/index.html') {
        const html = await fs.readFile(path.join(config.staticRoot, 'index.html'), 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        return res.end(html);
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (err) {
      // 业务错误可能携带 statusCode（413/409 等）；无标记时按内部错误处理
      const status = err && err.statusCode ? err.statusCode : 500;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, status, { ok: false, error: err.message });
    }
  }

  return { server, ready, close };
}
