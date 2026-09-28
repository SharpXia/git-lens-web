#!/usr/bin/env node
/**
 * run.mjs —— QA 隔离测试单一入口（契约 §8.3，`npm run test:isolated`）
 *
 * 流程：
 *   1. mkdtemp 建本轮 qa-root（契约 §8.1 布局）并生成全部 Git fixture；
 *   2. 以 PORT=0、GIT_LENS_CONFIG_DIR/GIT_LENS_TEST_MODE/GIT_LENS_TEST_RUN_ID 注入环境
 *      spawn `node src/server.js`，从 stdout 解析实际监听端口；
 *   3. 发出任何业务请求前执行 /api/test-handshake 并核对 runId/configDir/port/pid；
 *   4. 执行冒烟套件（发现、扫描目录往返、inspect、stash、raw-file 与 traversal 拒绝）；
 *   5. 写 <qaRoot>/artifacts/report.json；成功时清理 qa-root，失败时保留现场并打印路径。
 *
 * fail-closed 保证：握手之前不发出任何业务请求；所有校验复用 scripts/qa/guard.mjs；
 * 服务进程退出后验证端口已释放；9527 与真实配置目录在任何分支下都不会被触碰。
 *
 * 用法：
 *   npm run test:isolated            # 常规入口
 *   node scripts/qa/run.mjs --keep   # 成功时也保留 qa-root（调试用）
 *   node scripts/qa/run.mjs --service-url http://127.0.0.1:9530
 *                                    # 测试专用：跳过 spawn，对显式地址执行握手与冒烟。
 *                                    # 该地址仍必须通过 base-url 守卫（127.0.0.1 + 非 9527）；
 *                                    # 外部服务生命周期不受本启动器管理，故跳过停止与端口验证。
 *
 * 退出码：0=全部通过；1=存在失败或 Runtime 契约未就绪（正向用例跳过）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { FORBIDDEN_PORT, GUARD_ERROR_CODES, parseAndValidateBaseUrl, performHandshake } from './guard.mjs';
import { buildFixtures, createQaRoot, makeRunId, updateManifest } from './fixtures.mjs';

const QA_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = path.resolve(QA_DIR, '..', '..');
const SERVER_ENTRY = path.join(WORKTREE_ROOT, 'src', 'server.js');
const PORT_DISCOVERY_TIMEOUT_MS = 20000;
// 服务打印「:0」占位端口后的宽限期：容忍先回显配置再打印真实端口的实现
const PORT_ZERO_GRACE_MS = 1500;
const HANDSHAKE_TIMEOUT_MS = 5000;
const SERVICE_KILL_TIMEOUT_MS = 5000;
const HTTP_TIMEOUT_MS = 10000;

const results = [];

/**
 * 记录一条检查结果并回显。
 * @param {'pass'|'fail'|'skip'} status
 */
function record(id, name, status, detail = '') {
  results.push({ id, name, status, detail });
  const mark = status === 'pass' ? '✓' : status === 'fail' ? '✗' : '–';
  console.log(`${mark} [${id}] ${name}${detail ? ` —— ${detail}` : ''}`);
}

function tail(text, max = 1200) {
  const trimmed = (text || '').trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

/** 从进程环境中剥离可能劫持 git 子进程上下文的变量 */
function sanitizedEnv() {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) {
    delete env[key];
  }
  return env;
}

/**
 * 启动被测服务：PORT=0（系统分配端口）+ 测试模式注入。
 * HOME/GIT_CONFIG_GLOBAL 同步指向 qa-root，隔离服务进程内部 git 子进程的作者与全局配置。
 */
function spawnService(qaRoot, runId) {
  return spawn(process.execPath, [SERVER_ENTRY], {
    cwd: WORKTREE_ROOT,
    env: {
      ...sanitizedEnv(),
      PORT: '0',
      GIT_LENS_CONFIG_DIR: path.join(qaRoot, 'config'),
      GIT_LENS_TEST_MODE: '1',
      GIT_LENS_TEST_RUN_ID: runId,
      HOME: path.join(qaRoot, 'git-home'),
      XDG_CONFIG_HOME: path.join(qaRoot, 'git-home'),
      GIT_CONFIG_GLOBAL: path.join(qaRoot, 'git-home', 'config'),
      GIT_CONFIG_NOSYSTEM: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

/**
 * 从服务 stdout 解析实际监听端口（契约 §3 握手前置条件）。
 * 端口永远不可能取自参数：PORT=0 时真实端口只能由服务自行报告。
 * @returns {Promise<{ port: number, line: string, stdout: string, stderr: string }>}
 *   port=0 表示服务只回显了占位端口（Runtime 未按契约报告实际端口）
 */
function discoverPort(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let zeroGraceTimer = null;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(zeroGraceTimer);
      fn(arg);
    };
    const timeout = setTimeout(
      () => settle(reject, new Error(`等待服务报告实际监听端口超时（${PORT_DISCOVERY_TIMEOUT_MS}ms）\n[stdout 尾部]\n${tail(stdout)}\n[stderr 尾部]\n${tail(stderr)}`)),
      PORT_DISCOVERY_TIMEOUT_MS
    );

    const scan = () => {
      for (const line of stdout.split('\n')) {
        const match = line.match(/(?:127\.0\.0\.1|localhost):(\d+)/);
        if (!match) continue;
        const port = Number(match[1]);
        if (port > 0) {
          settle(resolve, { port, line: line.trim(), stdout, stderr });
          return;
        }
        // 「:0」是配置回显而非实际端口：进入宽限期，等后续真实端口行
        if (!zeroGraceTimer) {
          zeroGraceTimer = setTimeout(
            () => settle(resolve, { port: 0, line: line.trim(), stdout, stderr }),
            PORT_ZERO_GRACE_MS
          );
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      scan();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => settle(reject, new Error(`服务进程启动失败: ${err.message}`)));
    child.on('exit', (code, signal) => {
      settle(reject, new Error(`服务进程在报告端口前退出（code=${code}, signal=${signal}）\n[stdout]\n${tail(stdout)}\n[stderr]\n${tail(stderr)}`));
    });
  });
}

/** 停止服务：SIGTERM → 超时 SIGKILL → 等待 exit 事件；幂等 */
async function stopService(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), SERVICE_KILL_TIMEOUT_MS))
  ]);
  if (timedOut) child.kill('SIGKILL');
  await exited;
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

/** JSON API 请求；非 JSON 响应时 body 为 null */
async function requestJson(baseUrl, pathname, { method = 'GET', body } = {}) {
  const res = await fetch(baseUrl + pathname, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
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

/** 二进制响应请求（/api/raw-file 用） */
async function requestRaw(baseUrl, pathname) {
  const res = await fetch(baseUrl + pathname, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes, contentType: res.headers.get('content-type') || '' };
}

/**
 * 冒烟套件定义：仅正向用例，握手通过后才执行。
 * 每项返回 { pass, detail }；抛异常视为 fail。
 */
function smokeChecks(ctx) {
  const { baseUrl, fixture } = ctx;
  const specialRepo = fixture.special.repo;
  const specialFiles = fixture.special.files;

  return [
    {
      id: 'projects-empty-before-scan',
      name: '启动扫描目录为空时 /api/projects 不发现任何仓库（契约 §8.2 第 4 条）',
      run: async () => {
        const res = await requestJson(baseUrl, '/api/projects');
        const pass = res.status === 200 && res.body?.ok === true && Array.isArray(res.body.repos) && res.body.repos.length === 0;
        return { pass, detail: pass ? '' : `HTTP ${res.status}，repos=${JSON.stringify(res.body?.repos)}` };
      }
    },
    {
      id: 'scan-get-initially-empty',
      name: 'GET /api/scan-directories 初始为空',
      run: async () => {
        const res = await requestJson(baseUrl, '/api/scan-directories');
        const pass = res.status === 200 && Array.isArray(res.body?.customDirectories) && res.body.customDirectories.length === 0;
        return { pass, detail: pass ? '' : `HTTP ${res.status}，customDirectories=${JSON.stringify(res.body?.customDirectories)}` };
      }
    },
    {
      id: 'scan-post-roundtrip',
      name: 'POST /api/scan-directories 注册本轮 repos 目录并往返一致',
      run: async () => {
        const post = await requestJson(baseUrl, '/api/scan-directories', { method: 'POST', body: { directories: [fixture.scanRoot] } });
        if (post.status !== 200 || !Array.isArray(post.body?.customDirectories)) {
          return { pass: false, detail: `POST HTTP ${post.status}，body=${JSON.stringify(post.body)}` };
        }
        const get = await requestJson(baseUrl, '/api/scan-directories');
        const pass = get.status === 200 && get.body?.customDirectories?.includes(fixture.scanRoot);
        return { pass, detail: pass ? '' : `GET HTTP ${get.status}，customDirectories=${JSON.stringify(get.body?.customDirectories)}` };
      }
    },
    {
      id: 'config-file-inside-qa-root',
      name: '扫描目录写入仅落在 <qaRoot>/config/config.json',
      run: async () => {
        const configFile = path.join(ctx.qaRoot, 'config', 'config.json');
        try {
          const raw = JSON.parse(await fs.readFile(configFile, 'utf8'));
          const pass = Array.isArray(raw.customDirectories) && raw.customDirectories.includes(fixture.scanRoot);
          return { pass, detail: pass ? '' : `内容: ${JSON.stringify(raw)}` };
        } catch (err) {
          return { pass: false, detail: `读取 ${configFile} 失败: ${err.message}` };
        }
      }
    },
    {
      id: 'projects-discovers-fixture',
      name: '/api/projects 能发现 fixture 主仓库',
      run: async () => {
        const res = await requestJson(baseUrl, '/api/projects');
        const repos = Array.isArray(res.body?.repos) ? res.body.repos : [];
        const mainRepo = repos.find((r) => r.path === fixture.main.repo);
        const pass = res.status === 200 && Boolean(mainRepo) && repos.length >= 4;
        return { pass, detail: pass ? `发现 ${repos.length} 个仓库（含 worktree）` : `HTTP ${res.status}，repos=${JSON.stringify(repos.map((r) => r.path))}` };
      }
    },
    {
      id: 'inspect-summary-fields',
      name: '/api/inspect 返回 summary 关键字段且规模正确',
      run: async () => {
        const res = await requestJson(baseUrl, `/api/inspect?path=${encodeURIComponent(fixture.main.repo)}`);
        const summary = res.body?.summary;
        if (res.status !== 200 || !summary) {
          return { pass: false, detail: `HTTP ${res.status}，body=${JSON.stringify(res.body).slice(0, 300)}` };
        }
        const numeric = ['totalWorktrees', 'staleWorktreesCount', 'totalBranches', 'redundantBranchesCount']
          .every((k) => typeof summary[k] === 'number');
        // worktree 规模：main + clean + dirty + stash + lost = 5；失联 1 个
        const pass = numeric && res.body?.mainBranch === 'main'
          && summary.totalWorktrees >= 5 && summary.staleWorktreesCount >= 1;
        return { pass, detail: pass ? JSON.stringify(summary) : `summary=${JSON.stringify(summary)} mainBranch=${res.body?.mainBranch}` };
      }
    },
    {
      id: 'inspect-lost-worktree',
      name: '/api/inspect 将失联 worktree（目录已删）标记为不存在',
      run: async () => {
        const res = await requestJson(baseUrl, `/api/inspect?path=${encodeURIComponent(fixture.main.repo)}`);
        const lost = (res.body?.worktrees || []).find((w) => w.branch === fixture.main.branches.lost);
        const pass = Boolean(lost) && lost.existsOnDisk === false;
        return { pass, detail: pass ? '' : `lost=${JSON.stringify(lost)}` };
      }
    },
    {
      id: 'inspect-dirty-clean-flag',
      name: '/api/inspect 的 isDirty 标注区分脏/净 worktree',
      run: async () => {
        const res = await requestJson(baseUrl, `/api/inspect?path=${encodeURIComponent(fixture.main.repo)}`);
        const worktrees = res.body?.worktrees || [];
        const dirty = worktrees.find((w) => w.branch === fixture.main.branches.dirtyWt);
        const clean = worktrees.find((w) => w.branch === fixture.main.branches.cleanWt);
        const pass = dirty?.isDirty === true && clean?.isDirty === false;
        return { pass, detail: pass ? '' : `dirty=${JSON.stringify(dirty?.isDirty)} clean=${JSON.stringify(clean?.isDirty)}` };
      }
    },
    {
      id: 'uncommitted-diff-dirty',
      name: '/api/uncommitted-diff 对脏 worktree 含未提交修改/staged/untracked 三类文件',
      run: async () => {
        const res = await requestJson(baseUrl, `/api/uncommitted-diff?worktree=${encodeURIComponent(fixture.main.worktrees.dirty)}`);
        const files = res.body?.uncommitted?.files || [];
        const paths = new Set(files.map((f) => f.filePath));
        const pass = res.status === 200
          && paths.has('notes.txt') && paths.has('staged-file.txt') && paths.has('untracked-file.txt');
        return { pass, detail: pass ? '' : `HTTP ${res.status}，files=${JSON.stringify([...paths])}` };
      }
    },
    {
      id: 'uncommitted-diff-clean',
      name: '/api/uncommitted-diff 对净 worktree 返回空列表',
      run: async () => {
        const res = await requestJson(baseUrl, `/api/uncommitted-diff?worktree=${encodeURIComponent(fixture.main.worktrees.clean)}`);
        const files = res.body?.uncommitted?.files;
        const pass = res.status === 200 && Array.isArray(files) && files.length === 0;
        return { pass, detail: pass ? '' : `HTTP ${res.status}，files=${JSON.stringify(files)}` };
      }
    },
    {
      id: 'stash-list-count',
      name: '/api/stash-list 返回 2 条 stash 且含「含冲突标记」条目',
      run: async () => {
        const res = await requestJson(baseUrl, `/api/stash-list?worktree=${encodeURIComponent(fixture.main.worktrees.stash)}`);
        const stashes = res.body?.stashes || [];
        const pass = res.status === 200 && stashes.length === 2
          && stashes.some((s) => (s.subject || '').includes('含冲突标记'));
        return { pass, detail: pass ? '' : `HTTP ${res.status}，stashes=${JSON.stringify(stashes.map((s) => s.subject))}` };
      }
    },
    {
      id: 'raw-file-chinese-space-path',
      name: '/api/raw-file 可读中文与空格路径文件且内容一致',
      run: async () => {
        const params = new URLSearchParams({ repoPath: specialRepo, revision: 'HEAD', filePath: specialFiles.chinese.path });
        const res = await requestRaw(baseUrl, `/api/raw-file?${params}`);
        const expected = Buffer.from(specialFiles.chinese.content, 'utf8');
        const pass = res.status === 200 && res.bytes.equals(expected);
        return { pass, detail: pass ? '' : `HTTP ${res.status}，字节长=${res.bytes.length}，期望=${expected.length}` };
      }
    },
    {
      id: 'raw-file-special-char-paths',
      name: '/api/raw-file 可读含引号/&/尖括号的特殊字符路径文件',
      run: async () => {
        const cases = [specialFiles.singleQuote, specialFiles.doubleQuote, specialFiles.ampersand, specialFiles.angleBrackets];
        for (const file of cases) {
          const params = new URLSearchParams({ repoPath: specialRepo, revision: 'HEAD', filePath: file.path });
          const res = await requestRaw(baseUrl, `/api/raw-file?${params}`);
          const expected = Buffer.from(file.content, 'utf8');
          if (res.status !== 200 || !res.bytes.equals(expected)) {
            return { pass: false, detail: `${file.path}: HTTP ${res.status}，字节长=${res.bytes.length}` };
          }
        }
        return { pass: true, detail: `${cases.length} 个特殊路径全部可读` };
      }
    },
    {
      id: 'raw-file-png-image',
      name: '/api/raw-file 可读 PNG 图片且 Content-Type 为 image/png',
      run: async () => {
        const params = new URLSearchParams({ repoPath: specialRepo, revision: 'HEAD', filePath: specialFiles.png.path });
        const res = await requestRaw(baseUrl, `/api/raw-file?${params}`);
        const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const pass = res.status === 200 && res.bytes.subarray(0, 4).equals(pngMagic) && res.contentType.includes('image/png');
        return { pass, detail: pass ? '' : `HTTP ${res.status}，content-type=${res.contentType}，字节长=${res.bytes.length}` };
      }
    },
    {
      id: 'raw-file-traversal-relative',
      name: '/api/raw-file 拒绝相对路径逃逸（filePath=../../etc/passwd 返回 4xx）',
      run: async () => {
        const params = new URLSearchParams({ repoPath: specialRepo, revision: 'HEAD', filePath: '../../etc/passwd' });
        const res = await requestRaw(baseUrl, `/api/raw-file?${params}`);
        const pass = res.status >= 400 && res.status < 500;
        return { pass, detail: pass ? `HTTP ${res.status}` : `实际 HTTP ${res.status}，字节长=${res.bytes.length}（越界读取疑似成功）` };
      }
    },
    {
      id: 'raw-file-traversal-absolute',
      name: '/api/raw-file 拒绝绝对路径（filePath=/etc/passwd 返回 4xx）',
      run: async () => {
        const params = new URLSearchParams({ repoPath: specialRepo, revision: 'HEAD', filePath: '/etc/passwd' });
        const res = await requestRaw(baseUrl, `/api/raw-file?${params}`);
        const pass = res.status >= 400 && res.status < 500;
        return { pass, detail: pass ? `HTTP ${res.status}` : `实际 HTTP ${res.status}，字节长=${res.bytes.length}（越界读取疑似成功）` };
      }
    },
    {
      id: 'raw-file-traversal-worktree',
      name: '/api/raw-file WORKTREE 模式拒绝相对路径逃逸（worktreePath + ../../ 返回 4xx）',
      run: async () => {
        const params = new URLSearchParams({
          repoPath: specialRepo,
          revision: 'WORKTREE',
          worktreePath: specialRepo,
          filePath: '../../etc/passwd'
        });
        const res = await requestRaw(baseUrl, `/api/raw-file?${params}`);
        const pass = res.status >= 400 && res.status < 500;
        return { pass, detail: pass ? `HTTP ${res.status}` : `实际 HTTP ${res.status}，字节长=${res.bytes.length}（WORKTREE 模式越界读取疑似成功）` };
      }
    }
  ];
}

/** 构建并写入 artifacts/report.json */
async function writeReport(qaRoot, report) {
  const reportPath = path.join(qaRoot, 'artifacts', 'report.json');
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return reportPath;
}

function buildReport({ runId, qaRoot, outcome, service, handshake, startedAt, guidance }) {
  const count = (status) => results.filter((r) => r.status === status).length;
  return {
    runId,
    status: outcome,
    qaRoot,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    service: service || null,
    handshake: handshake || null,
    guidance: guidance || null,
    summary: { total: results.length, passed: count('pass'), failed: count('fail'), skipped: count('skip') },
    results
  };
}

async function main() {
  // 参数解析：--keep 与测试专用的 --service-url（显式外部服务地址覆盖）
  const args = process.argv.slice(2);
  const keepQaRoot = args.includes('--keep');
  const serviceUrlFlag = args.indexOf('--service-url');
  const serviceUrlInput = serviceUrlFlag >= 0 ? args[serviceUrlFlag + 1] : undefined;
  if (serviceUrlFlag >= 0 && (!serviceUrlInput || serviceUrlInput.startsWith('--'))) {
    console.error('[qa] --service-url 需要显式的服务地址，例如: --service-url http://127.0.0.1:9530');
    process.exitCode = 1;
    return;
  }
  // fail-closed：外部服务地址在创建 qa-root、发起任何请求之前先过白名单守卫
  let externalService = null;
  if (serviceUrlInput) {
    try {
      externalService = parseAndValidateBaseUrl(serviceUrlInput);
    } catch (err) {
      console.error(`[qa] --service-url 校验失败：${err.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[qa] --service-url 生效：跳过 spawn，使用外部服务 ${externalService.baseUrl}`);
  }

  const runId = makeRunId();
  const startedAt = new Date();
  let qaRoot = null;
  let child = null;
  let knownPort = null;
  let outcome = 'failed';
  let guidance = null;
  let serviceMeta = null;
  let handshakeMeta = null;

  // 兜底：进程退出时强杀服务，杜绝残留监听（正常路径已在下方受控停止）
  process.on('exit', () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });
  process.on('SIGINT', () => {
    if (child) child.kill('SIGKILL');
    process.exit(130);
  });

  try {
    console.log(`[qa] run-id: ${runId}`);
    qaRoot = await createQaRoot(runId);
    console.log(`[qa] qa-root: ${qaRoot}`);
    const fixture = await buildFixtures(qaRoot);
    console.log('[qa] fixture 构建完成（干净/脏/失联/stash/吸收/冲突对/特殊字符/恶意提交信息）');

    let baseUrl;
    if (externalService) {
      // 外部服务模式：地址来自显式参数（已过守卫），生命周期由调用方管理
      baseUrl = externalService.baseUrl;
      knownPort = externalService.port;
      serviceMeta = { command: `外部服务 (--service-url ${baseUrl})`, pid: null, port: externalService.port, stdoutTail: '' };
      record('runtime-port-report', '服务从 stdout 报告实际监听端口（PORT=0 场景）', 'skip', '外部托管服务经 --service-url 注入，端口来自显式参数');
    } else {
      child = spawnService(qaRoot, runId);
      const discovery = await discoverPort(child);
      serviceMeta = { command: `node ${SERVER_ENTRY}`, pid: child.pid, port: discovery.port > 0 ? discovery.port : null, stdoutTail: tail(discovery.stdout, 400) };
      record(
        'runtime-port-report',
        '服务从 stdout 报告实际监听端口（PORT=0 场景）',
        discovery.port > 0 ? 'pass' : 'skip',
        discovery.port > 0 ? discovery.line : `仅回显占位端口: ${discovery.line}`
      );
      knownPort = discovery.port > 0 ? discovery.port : null;

      if (discovery.port === 0) {
        outcome = 'runtime-contract-not-ready';
        guidance = [
          'Runtime 契约未就绪，正向用例跳过：服务未按契约从 stdout 报告实际监听端口（PORT=0 时必须回填真实端口），',
          '或尚未实现 /api/test-handshake（契约 §2/§3）。请合入 codex/electron-runtime 的 G1 交付后重试：npm run test:isolated。',
          `守卫负向用例不依赖服务，可直接运行: node --test test/qa-guard.test.mjs test/verify-guard.test.mjs`
        ].join('\n  ');
        for (const check of smokeChecks({ baseUrl: '', fixture, qaRoot })) {
          record(check.id, check.name, 'skip', 'RUNTIME 契约未就绪，正向用例跳过');
        }
        return;
      }

      // base-url 来自 stdout 的端口，仍须过白名单守卫（防服务被诱导输出恶意形态）
      baseUrl = parseAndValidateBaseUrl(`http://127.0.0.1:${discovery.port}`).baseUrl;
    }

    let handshake;
    try {
      handshake = await performHandshake(baseUrl, {
        runId,
        configDir: path.join(qaRoot, 'config'),
        timeoutMs: HANDSHAKE_TIMEOUT_MS
      });
    } catch (err) {
      if (err && err.code === GUARD_ERROR_CODES.HANDSHAKE_NOT_READY) {
        outcome = 'runtime-contract-not-ready';
        record('handshake', '测试握手 /api/test-handshake', 'skip', err.message);
        guidance = [
          `Runtime 契约未就绪，正向用例跳过：${err.message}`,
          '请合入 codex/electron-runtime 的 G1 交付（服务工厂 + 测试握手，契约 §2/§3）后重试: npm run test:isolated。',
          '守卫负向用例不依赖服务，可直接运行: node --test test/qa-guard.test.mjs test/verify-guard.test.mjs'
        ].join('\n  ');
        for (const check of smokeChecks({ baseUrl, fixture, qaRoot })) {
          record(check.id, check.name, 'skip', 'RUNTIME 契约未就绪，正向用例跳过');
        }
        return;
      }
      throw err;
    }

    handshakeMeta = { runId: handshake.runId, configDir: handshake.configDir, host: handshake.host, port: handshake.port, pid: handshake.pid };
    record('handshake', '测试握手 /api/test-handshake 三方一致', 'pass', `runId=${handshake.runId} port=${handshake.port}`);
    await updateManifest(qaRoot, { service: { port: handshake.port, pid: child.pid } });

    // 握手交叉验证：pid/port 必须对得上本轮 spawn 的进程（防误连其他实例）
    record(
      'handshake-pid-match',
      '握手 pid 与本轮 spawn 的服务进程一致',
      handshake.pid === child.pid ? 'pass' : 'fail',
      `握手 pid=${handshake.pid}，spawn pid=${child.pid}`
    );
    record(
      'service-port-not-9527',
      '服务端口不为主实例保留端口 9527',
      handshake.port !== FORBIDDEN_PORT ? 'pass' : 'fail',
      `port=${handshake.port}`
    );
    if (handshake.pid !== child.pid) {
      throw new Error('握手 pid 与 spawn 进程不一致，疑似误连其他实例，立即停止');
    }

    // 正向冒烟套件
    for (const check of smokeChecks({ baseUrl, fixture, qaRoot })) {
      try {
        const { pass, detail } = await check.run();
        record(check.id, check.name, pass ? 'pass' : 'fail', detail);
      } catch (err) {
        record(check.id, check.name, 'fail', `异常: ${err.message}`);
      }
    }

    outcome = results.some((r) => r.status === 'fail') ? 'failed' : 'passed';
  } catch (err) {
    outcome = 'failed';
    record('launcher', '启动器执行', 'fail', err.message);
    guidance = '启动器异常退出，详见 report.json 与上方输出。';
  } finally {
    // 无论成败都受控停止服务并验证端口释放
    try {
      await stopService(child);
    } catch {
      // stopService 不抛；此处兜底
    }
    if (externalService) {
      // 外部服务由调用方管理生命周期，启动器不停止也不验证端口释放
      record('service-port-released', '测试结束服务已退出且端口已释放', 'skip', '外部托管服务生命周期不受本启动器管理，跳过停止与端口验证');
    } else if (knownPort !== null) {
      const closed = await isPortClosed(knownPort);
      record(
        'service-port-released',
        '测试结束服务已退出且端口已释放',
        closed ? 'pass' : 'fail',
        closed ? `127.0.0.1:${knownPort} 已无监听` : `127.0.0.1:${knownPort} 仍有监听`
      );
    } else {
      // 被信号终止的进程 exitCode 恒为 null，需一并展示 signalCode 才有诊断价值
      record('service-port-released', '测试结束服务已退出', 'skip', `服务进程已退出（exitCode=${child ? child.exitCode : 'n/a'}, signal=${child ? child.signalCode : 'n/a'}）；服务未报告实际端口，无法做连接级验证`);
    }
    serviceMeta = { ...(serviceMeta || {}), exitCode: child ? child.exitCode : null, signal: child ? child.signalCode : null };

    if (qaRoot) {
      const report = buildReport({ runId, qaRoot, outcome, service: serviceMeta, handshake: handshakeMeta, startedAt, guidance });
      const reportPath = await writeReport(qaRoot, report);
      console.log(`\n[qa] 结果: ${outcome}（通过 ${report.summary.passed} / 失败 ${report.summary.failed} / 跳过 ${report.summary.skipped}）`);

      if (outcome === 'passed' && !keepQaRoot) {
        await fs.rm(qaRoot, { recursive: true, force: true });
        console.log('[qa] qa-root 已清理');
      } else {
        console.log(`[qa] qa-root 已保留: ${qaRoot}`);
        console.log(`[qa] 报告: ${reportPath}`);
        if (guidance) {
          console.log('\n================================================================');
          console.log(guidance);
          console.log('================================================================');
        }
      }
      if (outcome === 'passed') {
        if (keepQaRoot) console.log('[qa] --keep 生效：qa-root 保留用于复查');
      }
      process.exitCode = outcome === 'passed' ? 0 : 1;
    } else {
      console.error(`\n[qa] 结果: ${outcome}（qa-root 尚未创建，无报告可写）`);
      process.exitCode = 1;
    }
  }
}

process.on('unhandledRejection', (err) => {
  console.error(`[qa] 未捕获的异步错误: ${err?.message || err}`);
  process.exitCode = 1;
});

main();
