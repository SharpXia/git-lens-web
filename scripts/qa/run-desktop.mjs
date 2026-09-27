#!/usr/bin/env node
/**
 * run-desktop.mjs —— 桌面端隔离 E2E 单一入口（契约 §8.3/§13，`npm run test:desktop:isolated`）
 *
 * 流程：
 *   1. mkdtemp 建 qa-root（契约 §8.1 布局）并生成全部 Git fixture；
 *   2. 预写服务扫描目录配置（desktop 服务读取 <userData>/git-lens-config，另按
 *      web 惯例同步写 <qaRoot>/config 留档）；
 *   3. 经 playwright `_electron.launch` 启动桌面应用，环境注入 E2E 钩子
 *      （GIT_LENS_USER_DATA / GIT_LENS_E2E_READY_FILE / GIT_LENS_E2E_TOKEN_FILE /
 *      GIT_LENS_TEST_MODE=1 / GIT_LENS_TEST_RUN_ID），HOME/GIT 配置全部指向 qa-root；
 *   4. 轮询 ready 文件获取实际端口与服务 pid（禁止猜测端口）→ 读 token 文件 →
 *      带会话凭据握手核对（desktop 模式所有 /api 都要求 X-Git-Lens-Session）；
 *   5. 执行 G3/G4 场景断言（窗口就绪/桌面标识/仓库发现/Inspect 转义/崩溃恢复/
 *      凭据边界/导航管控/CSP 记录/退出协议），关键状态截图；
 *   6. 写 <qaRoot>/artifacts/report.json → app.close() → 断言服务退出、端口释放、
 *      无 Electron 孤儿进程 → 成功清理 qa-root，失败保留并打印路径。
 *
 * 已知边界（G4 人工清单）：headless 焦点/菜单断言不做；原生目录选择对话框自动化跳过。
 *
 * 用法：
 *   npm run test:desktop:isolated          # 常规入口
 *   node scripts/qa/run-desktop.mjs --keep       # 成功时也保留 qa-root（调试用）
 *   node scripts/qa/run-desktop.mjs --strict-csp # CSP 违规从「记录基线」切换为硬断言
 *                                                # （Runtime CSP 响应头合入后的 G3 验收开关）
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { _electron } from 'playwright';

import {
  FORBIDDEN_PORT,
  GUARD_ERROR_CODES,
  assertPathInsideRoot,
  assertPlannedPathInsideRoot,
  parseAndValidateBaseUrl,
  performHandshake
} from './guard.mjs';
import { buildFixtures, createQaRoot, makeRunId, updateManifest } from './fixtures.mjs';

const execFileAsync = promisify(execFile);

const QA_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = path.resolve(QA_DIR, '..', '..');
const ELECTRON_MAIN = path.join(WORKTREE_ROOT, 'electron', 'main.js');
const ELECTRON_BIN = path.join(
  WORKTREE_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'
);
const READY_TIMEOUT_MS = 30000;
const RESTART_TIMEOUT_MS = 25000;
const CLOSE_TIMEOUT_MS = 15000;
const HTTP_TIMEOUT_MS = 10000;

const results = [];

/**
 * 记录一条场景结果并回显。
 * @param {'pass'|'fail'|'skip'} status
 */
function record(id, name, status, detail = '') {
  results.push({ id, name, status, detail });
  const mark = status === 'pass' ? '✓' : status === 'fail' ? '✗' : '–';
  console.log(`${mark} [${id}] ${name}${detail ? ` —— ${detail}` : ''}`);
}

function tail(text, max = 1600) {
  const trimmed = (text || '').trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

/**
 * 解析桌面启动器参数（纯函数，供单测）。
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ keep: boolean, strictCsp: boolean, unknown: string[] }}
 */
export function parseDesktopArgs(argv) {
  const keep = argv.includes('--keep');
  const strictCsp = argv.includes('--strict-csp');
  const unknown = argv.filter((a) => a !== '--keep' && a !== '--strict-csp');
  return { keep, strictCsp, unknown };
}

/**
 * 组装桌面应用的受控环境（纯函数，供单测）。
 * userData/ready/token/服务配置全部指向 qa-root，HOME 与 git 全局配置同样隔离，
 * 绝不触碰真实用户配置（契约 §5/§13）。
 * @param {{ qaRoot: string, runId: string }} ctx
 */
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

/** 就绪文件形态：基础形态无 state 字段；服务退出时并入 state:"crashed" */
function readReadyFile(readyFile) {
  try {
    return JSON.parse(fsSync.readFileSync(readyFile, 'utf8'));
  } catch {
    return null;
  }
}

/** 轮询直到 read() 返回真值或超时 */
async function pollUntil(read, timeoutMs, { intervalMs = 200, describe } = {}) {
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
async function pollPage(page, pageFunction, arg, timeoutMs, intervalMs = 150) {
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
function isPortClosed(port) {
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
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** 通过 ps 查找仍存活的本 worktree Electron 进程（含全部辅助进程） */
async function findElectronProcesses() {
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
async function requestJson(baseUrl, pathname, { method = 'GET', token, body } = {}) {
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
 * 预写服务扫描目录配置。desktop 服务读取 <userData>/git-lens-config/config.json
 * （契约 §5），另按 web 惯例同步写 <qaRoot>/config/config.json 留档对照。
 */
async function writeServiceScanConfig(qaRoot) {
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

/** 截图并登记到 artifacts（文件名含场景编号，G4 视觉基线起点） */
async function screenshot(page, qaRoot, scenarioId, name) {
  const file = path.join(qaRoot, 'artifacts', `g4-${scenarioId}-${name}.png`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function main() {
  const { keep, strictCsp, unknown } = parseDesktopArgs(process.argv.slice(2));
  if (unknown.length > 0) {
    console.error(`[qa-desktop] 未知参数: ${unknown.join(' ')}（仅支持 --keep / --strict-csp）`);
    process.exitCode = 1;
    return;
  }
  const runId = makeRunId();
  const startedAt = new Date();
  let qaRoot = null;
  let electronApp = null;
  let latestReady = null;
  let outcome = 'failed';
  let guidance = null;
  let appMeta = null;
  let handshakeMeta = null;
  let cspRealViolations = [];
  let cspElectronDevWarnings = [];
  // 场景 h 产出；默认值保证异常路径下 report.csp 仍有完整形态
  let cspSummary = {
    realViolationCount: 0,
    realViolations: [],
    electronDevWarningCount: 0,
    strictMode: false
  };

  // 兜底：进程退出时若有 Electron 应用未关闭则强杀主进程，杜绝窗口/服务残留
  process.on('exit', () => {
    if (electronApp) {
      try {
        electronApp.process().kill('SIGKILL');
      } catch {
        // 进程已退出时忽略
      }
    }
  });
  process.on('SIGINT', () => {
    if (electronApp) electronApp.process().kill('SIGKILL');
    process.exit(130);
  });

  try {
    console.log(`[qa-desktop] run-id: ${runId}`);
    qaRoot = await createQaRoot(runId);
    console.log(`[qa-desktop] qa-root: ${qaRoot}`);
    const fixture = await buildFixtures(qaRoot);
    await writeServiceScanConfig(qaRoot);
    console.log('[qa-desktop] fixture 与服务配置就绪');

    if (!fsSync.existsSync(ELECTRON_BIN)) {
      throw new Error(`未找到 Electron 可执行文件: ${ELECTRON_BIN}（请先 npm install 让 electron postinstall 下载二进制）`);
    }

    const env = buildDesktopEnv({ qaRoot, runId });
    const readyFile = env.GIT_LENS_E2E_READY_FILE;
    const tokenFile = env.GIT_LENS_E2E_TOKEN_FILE;

    console.log('[qa-desktop] 启动桌面应用…');
    electronApp = await _electron.launch({
      executablePath: ELECTRON_BIN,
      args: [ELECTRON_MAIN],
      env,
      cwd: WORKTREE_ROOT,
      timeout: READY_TIMEOUT_MS
    });

    // 场景 a：等待 ready 文件（契约 §13，禁止猜端口）
    let ready = null;
    try {
      ready = await pollUntil(() => {
        const value = readReadyFile(readyFile);
        return value && Number.isInteger(value.port) && value.port > 0 ? value : null;
      }, READY_TIMEOUT_MS, { describe: `就绪文件 ${readyFile}` });
    } catch (err) {
      record('a1-ready-file', '就绪文件出现且字段完整', 'fail', err.message);
      throw new Error('应用未能产出就绪文件，无法继续（可能是主进程启动失败）');
    }
    latestReady = ready;
    await updateManifest(qaRoot, { service: { port: ready.port, pid: ready.servicePid } });

    const portOk = Number.isInteger(ready.port) && ready.port !== FORBIDDEN_PORT;
    record('a1-ready-file', '就绪文件出现且字段完整（port/servicePid/mainPid/runId）', 'pass',
      `port=${ready.port} servicePid=${ready.servicePid} mainPid=${ready.mainPid}`);
    record('a2-port-not-9527', '服务端口不为主实例保留端口 9527', portOk ? 'pass' : 'fail', `port=${ready.port}`);
    const baseUrl = parseAndValidateBaseUrl(`http://127.0.0.1:${ready.port}`).baseUrl;

    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);
    await screenshot(page, qaRoot, 'a', 'first-screen');

    const pageTitle = await page.title();
    const skeleton = await page.evaluate(() => ({
      hasHeader: Boolean(document.querySelector('header h1')),
      hasTabs: Boolean(document.getElementById('tabOverview')),
      hasFooter: Boolean(document.querySelector('footer.app-footer'))
    }));
    const a3 = pageTitle.includes('Git Lens') && skeleton.hasHeader && skeleton.hasTabs && skeleton.hasFooter;
    record('a3-page-loaded', '页面加载完成（title 与 DOM 骨架）', a3 ? 'pass' : 'fail',
      `title=${JSON.stringify(pageTitle)} skeleton=${JSON.stringify(skeleton)}`);

    // 读会话凭据：desktop 模式所有 /api（含握手）都要求 X-Git-Lens-Session（契约 §4）
    const token = (await fs.readFile(tokenFile, 'utf8')).trim();
    if (!token) throw new Error(`会话凭据文件为空: ${tokenFile}`);

    // 握手核对（带凭据）：runId/configDir 与本轮 qa-root 完全一致
    const desktopConfigDir = path.join(qaRoot, 'electron-user-data', 'git-lens-config');
    let handshake = null;
    try {
      handshake = await performHandshake(baseUrl, {
        runId,
        configDir: desktopConfigDir,
        headers: { 'X-Git-Lens-Session': token }
      });
    } catch (err) {
      if (err && err.code === GUARD_ERROR_CODES.HANDSHAKE_NOT_READY) {
        record('a4-handshake', '测试握手（带会话凭据）三方一致', 'skip', err.message);
      } else {
        throw err;
      }
    }
    if (handshake) {
      handshakeMeta = { runId: handshake.runId, configDir: handshake.configDir, host: handshake.host, port: handshake.port, pid: handshake.pid };
      // configDir 必须落在本轮 qa-root 内（desktop 配置目录 = <userData>/git-lens-config）
      await assertPathInsideRoot(handshake.configDir, qaRoot);
      record('a4-handshake', '测试握手（带会话凭据）三方一致', 'pass',
        `runId=${handshake.runId} configDir=${handshake.configDir} port=${handshake.port}`);
    }

    // CSP 违规收集：区分 Electron 未打包开发提醒与真实违规。默认宽松记录，
    // --strict-csp 时对真实违规硬断言（开发提醒在打包前无法消除，仅记录）
    page.on('console', (message) => {
      const text = message.text() || '';
      if (!/Content Security Policy|Content-Security-Policy|\bCSP\b/i.test(text)) return;
      const entry = { type: message.type(), text: text.slice(0, 500) };
      if (/Electron Security Warning/i.test(text)) {
        cspElectronDevWarnings.push(entry);
      } else {
        cspRealViolations.push(entry);
      }
    });

    // 场景 b：桌面标识（window.gitLens → getRuntimeInfo → 页脚渲染）
    const runtimeText = await page.evaluate(() => {
      const el = document.getElementById('desktopRuntimeInfo');
      return el ? { display: el.style.display, text: el.textContent } : null;
    });
    const b1 = runtimeText && runtimeText.display !== 'none'
      && /v\d/.test(runtimeText.text) && /Electron \d/.test(runtimeText.text)
      && /darwin/.test(runtimeText.text);
    record('b1-desktop-runtime', '页脚桌面运行时信息可见（appVersion/Electron/platform）', b1 ? 'pass' : 'fail',
      runtimeText ? JSON.stringify(runtimeText) : '元素不存在');
    await screenshot(page, qaRoot, 'b', 'desktop-runtime');

    // 场景 c：仓库发现（fixture 主仓库 + 中文特殊字符仓库不缺项）
    const repoPaths = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#repoSelect option')).map((opt) => opt.value)
    );
    const hasMain = repoPaths.includes(fixture.main.repo);
    const hasChinese = repoPaths.includes(fixture.chinese.repo);
    record('c1-repos-discovered', '项目列表渲染 fixture 主仓库与中文特殊字符仓库', hasMain && hasChinese ? 'pass' : 'fail',
      `选项数=${repoPaths.length} 主仓库=${hasMain} 中文仓库=${hasChinese}`);

    // 场景 d：Inspect 视图渲染 + 恶意提交信息纯文本转义（G3 安全验收）
    await page.evaluate((repoPath) => { window.selectRepo(repoPath); }, fixture.main.repo);
    await pollPage(page, () => {
      const items = document.querySelectorAll('#wtList .list-item');
      return items.length > 0 && !document.querySelector('#wtList .loading');
    }, null, 20000);
    const dState = await page.evaluate((expected) => {
      const wtText = document.getElementById('wtList').textContent;
      const brCount = document.querySelectorAll('#brList .list-item').length;
      const wtCount = document.querySelectorAll('#wtList .list-item').length;
      return {
        wtCount,
        brCount,
        mTotalWt: document.getElementById('mTotalWt')?.textContent,
        mTotalBr: document.getElementById('mTotalBr')?.textContent,
        xssAsText: wtText.includes('<img src=x onerror=alert(1)>'),
        escapeAsText: wtText.includes('../../escape'),
        injectedImg: document.querySelectorAll('img[onerror]').length,
        rawXssInHtml: document.body.innerHTML.includes('<img src=x'),
        rawScriptInHtml: document.body.innerHTML.includes('<script>alert(2)'),
        branchHit: expected.branches.every((b) => wtText.includes(b) || document.getElementById('brList').textContent.includes(b))
      };
    }, { branches: [fixture.main.branches.dirtyWt, fixture.main.branches.maliciousWt, fixture.main.branches.maliciousWt2, fixture.main.branches.lost] });
    const dOk = dState.wtCount >= 7 && dState.brCount > 0 && dState.mTotalWt === String(dState.wtCount)
      && dState.xssAsText && dState.escapeAsText
      && dState.injectedImg === 0 && !dState.rawXssInHtml && !dState.rawScriptInHtml && dState.branchHit;
    record('d1-inspect-render', 'Inspect 视图 worktree/分支列表渲染完整', dState.wtCount >= 7 && dState.brCount > 0 ? 'pass' : 'fail',
      `worktree=${dState.wtCount} branch=${dState.brCount} mTotalWt=${dState.mTotalWt}`);
    record('d2-malicious-plain-text', '恶意提交信息渲染为纯文本（无注入 img/script，文本完整）', dOk ? 'pass' : 'fail',
      `xss 文本=${dState.xssAsText} escape 文本=${dState.escapeAsText} 注入 img=${dState.injectedImg} 原始XSS=${dState.rawXssInHtml} 原始script=${dState.rawScriptInHtml}`);
    await screenshot(page, qaRoot, 'd', 'inspect-view');

    // 场景 f：凭据边界（无凭据 403 / 凭据 200；页面加载本身即注入头生效的证明）
    const noToken = await requestJson(baseUrl, '/api/projects');
    const withToken = await requestJson(baseUrl, '/api/projects', { token });
    const fOk = noToken.status === 403 && withToken.status === 200 && withToken.body?.ok === true;
    record('f1-credential-boundary', '无凭据直连 403、凭据请求 200（页面数据加载为注入头佐证）', fOk ? 'pass' : 'fail',
      `无凭据=${noToken.status} 带凭据=${withToken.status}`);

    // 场景 g：导航管控（拦截 window.open 与跨域 location 跳转；先在主进程替换
    // shell.openExternal 为记录函数，避免真打开系统浏览器）
    await electronApp.evaluate(({ shell }) => {
      globalThis.__qaOpenedExternal = [];
      shell.openExternal = (url) => {
        globalThis.__qaOpenedExternal.push(String(url));
        return Promise.resolve();
      };
    }, null);
    const windowsBefore = electronApp.windows().length;
    const urlBefore = page.url();
    await page.evaluate(() => {
      window.open('https://example.com/git-lens-e2e-window-open');
      location.href = 'https://example.com/git-lens-e2e-nav';
    });
    await page.waitForTimeout(800);
    const gState = {
      urlAfter: page.url(),
      windowCount: electronApp.windows().length,
      openedExternal: await electronApp.evaluate(() => globalThis.__qaOpenedExternal || [])
    };
    const sameOrigin = gState.urlAfter === urlBefore || gState.urlAfter.startsWith('http://127.0.0.1:');
    const gOk = sameOrigin && gState.windowCount === windowsBefore
      && gState.openedExternal.some((u) => u.includes('example.com'));
    record('g1-navigation-guard', '跨域导航/新窗口被拦截，窗口停留同源且无新窗口', gOk ? 'pass' : 'fail',
      `同源=${sameOrigin} 窗口数=${gState.windowCount} 外链转交=${JSON.stringify(gState.openedExternal)}`);

    // 场景 e：服务崩溃恢复（kill -9 服务进程 → 恢复遮罩 → 自动重启 → 数据可重载）
    const oldServicePid = latestReady.servicePid;
    process.kill(oldServicePid, 'SIGKILL');
    // 服务退出后主进程会按契约把 state:"crashed" 并入就绪文件
    let crashedReady = null;
    try {
      crashedReady = await pollUntil(() => {
        const value = readReadyFile(readyFile);
        return value && value.state === 'crashed' ? value : null;
      }, RESTART_TIMEOUT_MS, { describe: '就绪文件并入 state:crashed' });
    } catch {
      crashedReady = null;
    }
    record('e1-crash-detected', 'kill -9 服务进程后就绪文件标记 state:crashed', crashedReady ? 'pass' : 'fail',
      crashedReady ? '已捕获 crashed 形态' : '未在超时内观察到 crashed 形态');

    // 恢复遮罩：Shell 的实现是崩溃即把窗口整页切换为 data: URL 恢复页
    // （标题「本地服务正在恢复」+ 自动恢复倒计时），而不是 app 页内覆盖层
    const recoveryShown = await pollPage(page, () => {
      if (location.protocol === 'data:') return true;
      return Boolean(document.body) && document.body.textContent.includes('本地服务正在恢复');
    }, null, RESTART_TIMEOUT_MS);
    const recoveryUrl = page.url().slice(0, 60);
    record('e2-recovery-overlay', '页面出现服务恢复遮罩（崩溃 → 恢复页 → onServiceState 端到端）', recoveryShown ? 'pass' : 'fail',
      recoveryShown ? `恢复页已呈现（url 前缀=${recoveryUrl}…）` : '未在超时内观察到恢复页');
    await screenshot(page, qaRoot, 'e', 'recovery-overlay');

    // 自动重启成功：就绪文件回到基础形态（新 port/servicePid），遮罩消失且数据可重载
    let restarted = null;
    try {
      restarted = await pollUntil(() => {
        const value = readReadyFile(readyFile);
        return value && !value.state && Number.isInteger(value.port) && value.servicePid !== oldServicePid ? value : null;
      }, RESTART_TIMEOUT_MS, { describe: '就绪文件回到基础形态（新服务 pid）' });
    } catch {
      restarted = null;
    }
    record('e3-auto-restart', '服务自动重启并重写就绪文件（新 pid/端口）', restarted ? 'pass' : 'fail',
      restarted ? `新 port=${restarted.port} 新 servicePid=${restarted.servicePid}` : '超时未重启');
    latestReady = restarted || latestReady;

    if (restarted && restarted.port !== ready.port) {
      // 换端口场景：token 不变（契约 §13），新端口上凭据仍有效
      const afterRestart = await requestJson(`http://127.0.0.1:${restarted.port}`, '/api/projects', { token });
      record('e4-token-survives-restart', '重启换端口后凭据不变且请求 200', afterRestart.status === 200 ? 'pass' : 'fail',
        `HTTP ${afterRestart.status}`);
    } else if (restarted) {
      record('e4-token-survives-restart', '重启换端口后凭据不变且请求 200', 'skip', `端口未变化（${restarted.port}），凭据不变性由 f1 覆盖`);
    } else {
      record('e4-token-survives-restart', '重启换端口后凭据不变且请求 200', 'fail', '服务未重启，无从验证');
    }

    // 遮罩消失（恢复页切回应用页）+ 数据可重载
    let recovered = false;
    if (restarted) {
      const appPageBack = await pollPage(page, () =>
        location.protocol === 'http:' && location.hostname === '127.0.0.1', null, 20000);
      await page.evaluate((repoPath) => { window.selectRepo(repoPath); }, fixture.main.repo);
      const dataBack = await pollPage(page, () => {
        const items = document.querySelectorAll('#wtList .list-item');
        return items.length > 0 && !document.querySelector('#wtList .loading');
      }, null, 20000);
      recovered = appPageBack && dataBack;
    }
    record('e5-data-reloaded', '恢复页切回应用页且仓库数据可重载', recovered ? 'pass' : 'fail', recovered ? '' : '未切回应用页或数据未重载');

    // 场景 h：CSP 记录（默认宽松基线；--strict-csp 时对真实违规硬断言）
    cspSummary = {
      realViolationCount: cspRealViolations.length,
      realViolations: cspRealViolations,
      electronDevWarningCount: cspElectronDevWarnings.length,
      strictMode: strictCsp
    };
    if (strictCsp) {
      record('h1-csp-violations', 'CSP 真实违规为零（--strict-csp 硬断言）', cspRealViolations.length === 0 ? 'pass' : 'fail',
        `真实违规=${cspRealViolations.length}，${JSON.stringify(cspRealViolations).slice(0, 300)}；Electron 开发提醒=${cspElectronDevWarnings.length}（仅记录）`);
    } else {
      record('h1-csp-violations', 'CSP 违规记录基线（宽松模式，Runtime CSP 头合入后用 --strict-csp 硬断言）', 'pass',
        `真实违规=${cspRealViolations.length}，Electron 开发提醒=${cspElectronDevWarnings.length}`);
    }

    // 场景 i：退出协议
    appMeta = {
      mainPid: ready.mainPid,
      servicePid: latestReady.servicePid,
      port: latestReady.port,
      baseUrl: `http://127.0.0.1:${latestReady.port}`
    };
    const closeStartedAt = Date.now();
    await electronApp.close();
    electronApp = null;
    const closeElapsed = Date.now() - closeStartedAt;
    if (restarted || latestReady.servicePid) {
      const serviceGone = await pollUntil(() => !isPidAlive(latestReady.servicePid), CLOSE_TIMEOUT_MS, {
        intervalMs: 250,
        describe: `服务进程 ${latestReady.servicePid} 退出`
      }).then(() => true).catch(() => false);
      const portClosed = await pollUntil(() => isPortClosed(latestReady.port), CLOSE_TIMEOUT_MS, {
        intervalMs: 250,
        describe: `端口 ${latestReady.port} 释放`
      }).then(() => true).catch(() => false);
      const mainGone = !isPidAlive(ready.mainPid);
      const orphans = await findElectronProcesses();
      record('i1-exit-protocol', 'app.close() 后服务退出、端口释放、主进程退出、无 Electron 孤儿',
        serviceGone && portClosed && mainGone && orphans.length === 0 ? 'pass' : 'fail',
        `服务退出=${serviceGone} 端口释放=${portClosed} 主进程退出=${mainGone} 孤儿=${orphans.length}（close 耗时 ${closeElapsed}ms）`);
      if (orphans.length > 0) {
        console.error('[qa-desktop] 孤儿进程样本:', orphans.slice(0, 3));
      }
    }

    outcome = results.some((r) => r.status === 'fail') ? 'failed' : 'passed';
  } catch (err) {
    outcome = 'failed';
    record('launcher', '桌面启动器执行', 'fail', err.message);
    guidance = '桌面启动器异常退出，详见 report.json 与上方输出。';
  } finally {
    if (electronApp) {
      try {
        await electronApp.close();
      } catch {
        // 已在上方处理或进程已死
      }
      electronApp = null;
    }

    const orphans = await findElectronProcesses();
    if (orphans.length > 0) {
      console.error('[qa-desktop] 残留 Electron 进程:', orphans.slice(0, 5));
      for (const line of orphans) {
        const pid = Number(line.split(/\s+/)[0]);
        if (Number.isInteger(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
        }
      }
      record('i2-electron-orphans', '无残留 Electron 辅助进程（含主进程与全部 helper）', 'fail',
        '退出后仍发现残留进程，已强杀（样本见上方输出）');
    }

    if (qaRoot) {
      const count = (status) => results.filter((r) => r.status === status).length;
      const report = {
        runId,
        status: outcome,
        qaRoot,
        kind: 'desktop-e2e',
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        app: appMeta,
        handshake: handshakeMeta,
        csp: cspSummary,
        guidance: guidance || null,
        summary: { total: results.length, passed: count('pass'), failed: count('fail'), skipped: count('skip') },
        results
      };
      const reportPath = path.join(qaRoot, 'artifacts', 'report.json');
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`\n[qa-desktop] 结果: ${outcome}（通过 ${report.summary.passed} / 失败 ${report.summary.failed} / 跳过 ${report.summary.skipped}）`);

      if (outcome === 'passed' && !keep) {
        await fs.rm(qaRoot, { recursive: true, force: true });
        console.log('[qa-desktop] qa-root 已清理');
      } else {
        console.log(`[qa-desktop] qa-root 已保留: ${qaRoot}`);
        console.log(`[qa-desktop] 报告: ${reportPath}`);
        if (guidance) {
          console.log('\n================================================================');
          console.log(guidance);
          console.log('================================================================');
        }
      }
      process.exitCode = outcome === 'passed' ? 0 : 1;
    } else {
      console.error(`\n[qa-desktop] 结果: ${outcome}（qa-root 尚未创建，无报告可写）`);
      process.exitCode = 1;
    }
  }
}

process.on('unhandledRejection', (err) => {
  console.error(`[qa-desktop] 未捕获的异步错误: ${err?.message || err}`);
  process.exitCode = 1;
});

// 仅在直接执行本脚本时启动；被单测 import 时保持零副作用（否则会拉起整轮 E2E）
const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main();
}
