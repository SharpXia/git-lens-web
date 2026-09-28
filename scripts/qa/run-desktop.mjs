#!/usr/bin/env node
/**
 * run-desktop.mjs —— 桌面端隔离 E2E 快速冒烟入口（契约 §8.3/§13/§15，`npm run test:desktop:isolated`）
 *
 * 流程：mkdtemp qa-root → fixture → 预写扫描目录配置 → 注入 E2E 钩子环境启动应用
 * （含 --remote-debugging-port=0）→ 就绪文件取端口（禁止猜端口）→ CDP 通道读取调试
 * 端口并枚举应用标签页 → 带凭据握手 → 17 项冒烟场景（就绪/桌面标识/仓库发现/
 * Inspect 转义/凭据边界/导航管控/崩溃恢复/CSP 记录/退出协议）→ report.json + 截图 →
 * 成功清理 qa-root，失败保留。
 *
 * 页面通道：多标签架构（§15）下 BrowserWindow 是空壳，应用页经
 * desktop-shared 的页面级 CDP 会话驱动；`_electron` 句柄仅用于 app 级操作。
 *
 * G4 功能矩阵全量场景见 run-desktop-full.mjs（`npm run test:desktop:full`），
 * 两者共享 scripts/qa/desktop-shared.mjs 基建。
 *
 * 用法：
 *   npm run test:desktop:isolated          # 常规入口
 *   node scripts/qa/run-desktop.mjs --keep       # 成功时也保留 qa-root（调试用）
 *   node scripts/qa/run-desktop.mjs --strict-csp # CSP 违规从「记录基线」切换为硬断言
 *
 * 已知边界（G4 人工清单）：headless 焦点/菜单断言不做；原生目录选择对话框自动化跳过。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { GUARD_ERROR_CODES, assertPathInsideRoot, performHandshake } from './guard.mjs';
import { buildFixtures, createQaRoot, makeRunId, updateManifest } from './fixtures.mjs';
import {
  closeAndVerify,
  createCspRegistry,
  createResults,
  openDesktopChannel,
  parseDesktopArgs,
  pollPage,
  pollUntil,
  readReadyFile,
  requestJson,
  screenshotFile,
  startDesktopApp,
  validateReady,
  writeServiceScanConfig
} from './desktop-shared.mjs';

const READY_TIMEOUT_MS = 30000;
const RESTART_TIMEOUT_MS = 25000;

async function main() {
  const { keep, strictCsp, unknown } = parseDesktopArgs(process.argv.slice(2));
  if (unknown.length > 0) {
    console.error(`[qa-desktop] 未知参数: ${unknown.join(' ')}（仅支持 --keep / --strict-csp）`);
    process.exitCode = 1;
    return;
  }
  const { record, results, summary } = createResults();
  const runId = makeRunId();
  const startedAt = new Date();
  let qaRoot = null;
  let app = null;
  let hub = null;
  let latestReady = null;
  let outcome = 'failed';
  let guidance = null;
  let appMeta = null;
  let handshakeMeta = null;
  let cspSummary = { realViolationCount: 0, realViolations: [], electronDevWarningCount: 0, strictMode: strictCsp };

  // 兜底：进程退出时若有 Electron 应用未关闭则强杀主进程，杜绝窗口/服务残留
  process.on('exit', () => {
    if (app) {
      try { app.process().kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  });
  process.on('SIGINT', () => {
    if (app) app.process().kill('SIGKILL');
    process.exit(130);
  });

  try {
    console.log(`[qa-desktop] run-id: ${runId}`);
    qaRoot = await createQaRoot(runId);
    console.log(`[qa-desktop] qa-root: ${qaRoot}`);
    const fixture = await buildFixtures(qaRoot);
    await writeServiceScanConfig(qaRoot);
    console.log('[qa-desktop] fixture 与服务配置就绪');

    console.log('[qa-desktop] 启动桌面应用…');
    const launched = await startDesktopApp({ qaRoot, runId });
    app = launched.app;
    // CDP 通道尽早就位（调试端口文件早于就绪文件出现），console 收集同步启动，
    // 尽量覆盖首屏加载期的 CSP 违规
    const cspRegistry = createCspRegistry();
    hub = await openDesktopChannel({ env: launched.env, registry: cspRegistry });
    const readyFile = launched.env.GIT_LENS_E2E_READY_FILE;
    const tokenFile = launched.env.GIT_LENS_E2E_TOKEN_FILE;

    // 场景 a：等待 ready 文件（契约 §13，禁止猜端口）
    let ready = null;
    try {
      ready = await pollUntil(() => {
        const value = readReadyFile(readyFile);
        return value && Number.isInteger(value.port) && value.port > 0 ? value : null;
      }, READY_TIMEOUT_MS, { describe: `就绪文件 ${readyFile}` });
    } catch (err) {
      record('a1-ready-file', '就绪文件出现且字段完整（port/servicePid/mainPid/runId）', 'fail', err.message);
      throw new Error('应用未能产出就绪文件，无法继续（可能是主进程启动失败）');
    }
    latestReady = ready;
    const { baseUrl, port } = validateReady(ready);
    await updateManifest(qaRoot, { service: { port: ready.port, pid: ready.servicePid } });
    record('a1-ready-file', '就绪文件出现且字段完整（port/servicePid/mainPid/runId）', 'pass',
      `port=${ready.port} servicePid=${ready.servicePid} mainPid=${ready.mainPid}`);
    record('a2-port-not-9527', '服务端口不为主实例保留端口 9527', port !== 9527 ? 'pass' : 'fail', `port=${port}`);

    // 页面通道：按服务端口前缀枚举应用标签目标（排除 tabbar file:// 与空壳 about:blank）
    hub.appPrefix = `${baseUrl}/`;
    const [appTarget] = await hub.waitForAppTargets(1, 15000);
    const page = await hub.pageFor(appTarget.id, appTarget.url);
    console.log(`[qa-desktop] CDP 通道就绪：cdpPort=${hub.cdpPort} 应用目标=${appTarget.url}`);

    await page.waitForTimeout(500);
    await screenshotFile(page, qaRoot, 'a', 'first-screen');

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
    await screenshotFile(page, qaRoot, 'b', 'desktop-runtime');

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
    await screenshotFile(page, qaRoot, 'd', 'inspect-view');

    // 场景 f：凭据边界（无凭据 403 / 凭据 200；页面加载本身即注入头生效的证明）
    const noToken = await requestJson(baseUrl, '/api/projects');
    const withToken = await requestJson(baseUrl, '/api/projects', { token });
    const fOk = noToken.status === 403 && withToken.status === 200 && withToken.body?.ok === true;
    record('f1-credential-boundary', '无凭据直连 403、凭据请求 200（页面数据加载为注入头佐证）', fOk ? 'pass' : 'fail',
      `无凭据=${noToken.status} 带凭据=${withToken.status}`);

    // 场景 g：导航管控（拦截 window.open 与跨域 location 跳转；先在主进程替换
    // shell.openExternal 为记录函数，避免真打开系统浏览器）
    await app.evaluate(({ shell }) => {
      globalThis.__qaOpenedExternal = [];
      shell.openExternal = (url) => {
        globalThis.__qaOpenedExternal.push(String(url));
        return Promise.resolve();
      };
    }, null);
    const windowsBefore = app.windows().length;
    const urlBefore = await page.url();
    await page.evaluate(() => {
      window.open('https://example.com/git-lens-e2e-window-open');
      location.href = 'https://example.com/git-lens-e2e-nav';
    });
    await page.waitForTimeout(800);
    const gState = {
      urlAfter: await page.url(),
      windowCount: app.windows().length,
      openedExternal: await app.evaluate(() => globalThis.__qaOpenedExternal || [])
    };
    const sameOrigin = gState.urlAfter === urlBefore || gState.urlAfter.startsWith('http://127.0.0.1:');
    const gOk = sameOrigin && gState.windowCount === windowsBefore
      && gState.openedExternal.some((u) => u.includes('example.com'));
    record('g1-navigation-guard', '跨域导航/新窗口被拦截，窗口停留同源且无新窗口', gOk ? 'pass' : 'fail',
      `同源=${sameOrigin} 窗口数=${gState.windowCount} 外链转交=${JSON.stringify(gState.openedExternal)}`);

    // 场景 e：服务崩溃恢复（kill -9 服务进程 → 恢复页 → 自动重启 → 数据可重载）
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

    // 恢复遮罩（DEF-002 修复后形态）：主路径为应用页自带 #serviceStateOverlay 遮罩，
    // 兜底为主进程注入的 #git-lens-recovery-fallback；页面保持同文档，不再丢会话状态。
    // data: 分支仅为兼容旧实现的形态兜底
    const recoveryShown = await pollPage(page, () => {
      if (location.protocol === 'data:') return true;
      const overlay = document.getElementById('serviceStateOverlay');
      if (overlay && overlay.style.display !== 'none' && overlay.style.display !== '') return true;
      return Boolean(document.getElementById('git-lens-recovery-fallback'))
        || (Boolean(document.body) && document.body.textContent.includes('本地服务正在恢复'));
    }, null, RESTART_TIMEOUT_MS);
    const overlayKind = await page.evaluate(() => {
      if (location.protocol === 'data:') return 'data: 恢复页（旧实现）';
      const overlay = document.getElementById('serviceStateOverlay');
      if (overlay && overlay.style.display !== 'none' && overlay.style.display !== '') return '应用遮罩 #serviceStateOverlay';
      if (document.getElementById('git-lens-recovery-fallback')) return '兜底遮罩 #git-lens-recovery-fallback';
      return '未观察到';
    });
    record('e2-recovery-overlay', '页面出现服务恢复遮罩（崩溃 → 遮罩 → onServiceState 端到端）', recoveryShown ? 'pass' : 'fail',
      recoveryShown ? `遮罩形态=${overlayKind}` : '未在超时内观察到恢复遮罩');
    await screenshotFile(page, qaRoot, 'e', 'recovery-overlay').catch(() => {});

    // 自动重启成功：就绪文件回到基础形态（新 port/servicePid），恢复后数据可重载
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

    // 场景 h：CSP 记录（默认宽松基线；--strict-csp 时对真实违规硬断言）。
    // 收集范围 = 全部 CDP 页面目标（应用标签 + tabbar file:// + 空壳），真实违规
    // 与 Electron 开发提醒分开计数
    cspSummary = { ...cspRegistry.summarize(), strictMode: strictCsp };
    if (strictCsp) {
      record('h1-csp-violations', 'CSP 真实违规为零（--strict-csp 硬断言）', cspSummary.realViolationCount === 0 ? 'pass' : 'fail',
        `真实违规=${cspSummary.realViolationCount}，${JSON.stringify(cspSummary.realViolations).slice(0, 300)}；Electron 开发提醒=${cspSummary.electronDevWarningCount}（仅记录）`);
    } else {
      record('h1-csp-violations', 'CSP 违规记录基线（宽松模式，Runtime CSP 头合入后用 --strict-csp 硬断言）', 'pass',
        `真实违规=${cspSummary.realViolationCount}，Electron 开发提醒=${cspSummary.electronDevWarningCount}`);
    }

    // 场景 i：退出协议
    appMeta = {
      mainPid: ready.mainPid,
      servicePid: latestReady.servicePid,
      port: latestReady.port,
      baseUrl: `http://127.0.0.1:${latestReady.port}`
    };
    const exit = await closeAndVerify({ app, ready: latestReady });
    app = null;
    record('i1-exit-protocol', 'app.close() 后服务退出、端口释放、主进程退出、无 Electron 孤儿', exit.ok ? 'pass' : 'fail',
      `服务退出=${exit.serviceGone} 端口释放=${exit.portClosed} 主进程退出=${exit.mainGone} 孤儿=${exit.orphanCount}（close 耗时 ${exit.closeElapsed}ms）`);

    outcome = results.some((r) => r.status === 'fail') ? 'failed' : 'passed';
  } catch (err) {
    outcome = 'failed';
    record('launcher', '桌面启动器执行', 'fail', err.message);
    guidance = '桌面启动器异常退出，详见 report.json 与上方输出。';
  } finally {
    if (hub) {
      await hub.dispose().catch(() => { /* 会话已随应用退出 */ });
    }
    if (app) {
      try {
        await app.close();
      } catch {
        // 已在上方处理或进程已死
      }
      app = null;
    }

    if (qaRoot) {
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
        summary: summary(),
        results
      };
      const reportPath = path.join(qaRoot, 'artifacts', 'report.json');
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`\n[qa-desktop] 结果: ${outcome}（通过 ${summary().passed} / 失败 ${summary().failed} / 跳过 ${summary().skipped}）`);

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
