#!/usr/bin/env node
/**
 * run-desktop-full.mjs —— G4 功能与 UI 矩阵全量入口（契约 §8.3，`npm run test:desktop:full`）
 *
 * 在快速冒烟（run-desktop.mjs）之外覆盖计划书 §7 的功能矩阵：
 *   1. Diff 与提交视图：diff-refs 三组合 × 三模式 API 矩阵；UI 三组合渲染与模式按钮
 *      切换（data-action 迁移后的高回归风险点）；图片/二进制呈现；未提交改动视图；
 *      提交抽屉（列表/author+grep 过滤/「加载更多」追加后旧卡仍可交互且不重复绑定/
 *      详情展开/SHA 复制）；URL 会话恢复（reload 后同视图）。
 *   2. 写操作矩阵（API 触发，全部断言操作前后真实 git 状态）：
 *      stash（push/pop 原地/pop 到他 worktree/pop 到未绑定分支新 worktree/drop/
 *      discard）、cherry-pick（成功+冲突回滚）、revert、本地 MR 全生命周期
 *      （open→approve→merge --no-ff→重复创建 409；冲突 merge 409→自动 abort→
 *      cancel 终态）、分支清理（单项+批量）、worktree 清理（单项含删绑定分支+批量）、
 *      prune 失联 worktree。
 *   3. 原生 UI：缩放 1.0/1.25/1.5（无横向溢出断言+截图）、窄窗 960×600、
 *      视觉截图集（G4 视觉基线）。
 *   4. 崩溃恢复（含恢复页截图与选中仓库经 sessionStorage 恢复；Shell 重启固定加载
 *      根路径，深层 URL 态不保留——diff 选中态恢复由 reload 场景覆盖）。
 *   5. 多标签场景（契约 §15，独立第二实例，m1-m6）：经 tabbar 新建/切换/关闭、
 *      标题同步、sessionStorage 按标签隔离、就近激活、关闭全部标签触发退出协议、
 *      多标签下 strict CSP 真实违规为零。
 *   6. 跨启动标签恢复（契约 §15 第二次修订，独立第三实例，r1-r4）：同一 userData
 *      三轮启动，覆盖运行期防抖落盘与退出同步落盘（存档只含查询串）、二轮自动
 *      恢复（查询串重放到新端口、顺序/激活项一致、页面数据最新）、服务崩溃重启
 *      不破坏恢复态（等待窗口 30s，断言标签集合保持 + 查询串重放到重启后端口；
 *      弹框免疫长会话覆盖 ≥30s 崩溃窗口）、存档坏 JSON 按无存档容错回落单标签
 *      首页；恢复段 strict CSP 继续全程收集并硬断言（r5）。
 *   7. strict CSP 全程收集并硬断言真实违规为零。
 *
 * 弹框免疫：全部 CDP 页面会话内置双层处理（desktop-shared.mjs，对齐 Shell
 * smoke.mjs）：新文档预置 alert/confirm/prompt 桩 + javascriptDialogOpening
 * 自动 accept。e3/r3 同时核对崩溃窗口内不再出现弹框事件（DEF-006 非阻断
 * 提示验收）。
 *
 * 页面通道：多标签架构（§15）下 BrowserWindow 是空壳，应用页经 desktop-shared 的
 * 页面级 CDP 会话驱动；`_electron` 句柄仅用于 app 级操作（主进程 evaluate、close）。
 *
 * 用法：
 *   npm run test:desktop:full
 *   node scripts/qa/run-desktop-full.mjs --keep   # 成功时也保留 qa-root（供取视觉基线截图）
 *
 * 已知边界：原生目录选择对话框与焦点/菜单类断言留人工清单。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { GUARD_ERROR_CODES, assertPathInsideRoot, performHandshake } from './guard.mjs';
import { buildFixtures, createQaRoot, makeRunId, updateManifest } from './fixtures.mjs';
import {
  buildDesktopEnv,
  captureBaseline,
  closeAndVerify,
  createCspRegistry,
  createResults,
  createTabbarDriver,
  createUnrelatedElectronInstance,
  findElectronProcesses,
  isPidAlive,
  openDesktopChannel,
  parseDesktopArgs,
  pollPage,
  pollUntil,
  pollUntilAsync,
  readReadyFile,
  requestJson,
  setAppZoom,
  startDesktopApp,
  validateReady,
  verifyAppExit,
  writeScanConfigInto,
  writeServiceScanConfig
} from './desktop-shared.mjs';

const execFileAsync = promisify(execFile);
const RESTART_TIMEOUT_MS = 25000;

/** 安全解码查询串（异常时原样返回），供跨启动存档的查询串比对使用 */
function safeDecode(value) {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

/**
 * 在 fixture 仓库内执行只读 git 命令并返回 stdout（写操作一律走被测服务 API，
 * 这里仅用于操作前后真实 git 状态断言）。
 */
async function gitSnap(qaRoot, cwd, ...args) {
  await assertPathInsideRoot(cwd, qaRoot);
  const { stdout } = await execFileAsync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function main() {
  const { keep, strictCsp, unknown } = parseDesktopArgs(process.argv.slice(2));
  if (unknown.length > 0) {
    console.error(`[qa-desktop-full] 未知参数: ${unknown.join(' ')}（仅支持 --keep / --strict-csp）`);
    process.exitCode = 1;
    return;
  }
  const { record, results, summary } = createResults();
  const runId = makeRunId();
  const startedAt = new Date();
  let qaRoot = null;
  let app = null;
  let page = null;
  let hub = null;
  let cspRegistry = null;
  let mtabApp = null;
  let mtabHub = null;
  // 跨启动标签恢复场景（r1-r4）的独立第三实例（suffix 'restore'，独立 userData）
  let restoreApp = null;
  let restoreHub = null;
  // DEF-004 回归自证用的无关 Electron 实例（同 worktree 二进制、独立 userData）
  let unrelated = null;
  let ready = null;
  let baseUrl = null;
  let token = null;
  let fixture = null;
  let outcome = 'failed';
  let cspSummary = { realViolationCount: 0, realViolations: [], electronDevWarningCount: 0, strictMode: true };

  process.on('exit', () => {
    for (const liveApp of [app, mtabApp, restoreApp]) {
      if (liveApp) {
        try { liveApp.process().kill('SIGKILL'); } catch { /* 已退出 */ }
      }
    }
    if (unrelated) unrelated.kill();
  });
  process.on('SIGINT', () => {
    for (const liveApp of [app, mtabApp, restoreApp]) {
      if (liveApp) liveApp.process().kill('SIGKILL');
    }
    if (unrelated) unrelated.kill();
    process.exit(130);
  });

  const api = (pathname, options) => requestJson(baseUrl, pathname, { token, ...options });

  try {
    console.log(`[qa-desktop-full] run-id: ${runId}`);
    qaRoot = await createQaRoot(runId);
    console.log(`[qa-desktop-full] qa-root: ${qaRoot}`);
    fixture = await buildFixtures(qaRoot);
    await writeServiceScanConfig(qaRoot);
    console.log('[qa-desktop-full] fixture 与服务配置就绪');

    console.log('[qa-desktop-full] 启动桌面应用…');
    const launched = await startDesktopApp({ qaRoot, runId });
    app = launched.app;
    // CDP 通道尽早就位（调试端口文件早于就绪文件出现），console 收集同步启动，
    // 尽量覆盖首屏加载期的 CSP 违规
    cspRegistry = createCspRegistry();
    hub = await openDesktopChannel({ env: launched.env, registry: cspRegistry });
    const readyFile = launched.env.GIT_LENS_E2E_READY_FILE;
    ready = await pollUntil(() => {
      const value = readReadyFile(readyFile);
      return value && Number.isInteger(value.port) && value.port > 0 ? value : null;
    }, 30000, { describe: '就绪文件' });
    ({ baseUrl } = validateReady(ready));
    hub.appPrefix = `${baseUrl}/`;
    await updateManifest(qaRoot, { service: { port: ready.port, pid: ready.servicePid } });
    const [appTarget] = await hub.waitForAppTargets(1, 15000);
    page = await hub.pageFor(appTarget.id, appTarget.url);
    console.log(`[qa-desktop-full] CDP 通道就绪：cdpPort=${hub.cdpPort} 应用目标=${appTarget.url}`);
    await page.waitForTimeout(500);
    // 首屏基线：标题与仓库下拉就绪后才出图
    await captureBaseline(page, qaRoot, 'a', 'first-screen', () => {
      const h1 = document.querySelector('header h1');
      const options = document.querySelectorAll('#repoSelect option');
      const tabs = document.getElementById('tabOverview');
      return Boolean(h1 && tabs?.offsetParent) && options.length > 0;
    });

    token = (await fs.readFile(launched.env.GIT_LENS_E2E_TOKEN_FILE, 'utf8')).trim();

    // 握手（带凭据）：任何业务请求前的身份核验
    let handshake = null;
    try {
      handshake = await performHandshake(baseUrl, {
        runId,
        configDir: path.join(qaRoot, 'config'), // 契约 §5 第三次修订：= GIT_LENS_CONFIG_DIR 指向处
        headers: { 'X-Git-Lens-Session': token }
      });
    } catch (err) {
      if (err && err.code === GUARD_ERROR_CODES.HANDSHAKE_NOT_READY) {
        record('boot-handshake', '测试握手（带会话凭据）三方一致', 'skip', err.message);
      } else {
        throw err;
      }
    }
    if (handshake) {
      await assertPathInsideRoot(handshake.configDir, qaRoot);
      record('boot-handshake', '测试握手（带会话凭据）三方一致', 'pass', `port=${handshake.port}`);
    }

    const mainRepo = fixture.main.repo;
    const wt = fixture.main.worktrees;
    const br = fixture.main.branches;

    /** 等待 inspect 视图渲染完成 */
    const waitInspect = async (repoPath) => {
      await page.evaluate((p) => { window.selectRepo(p); }, repoPath);
      await pollPage(page, () => {
        const items = document.querySelectorAll('#wtList .list-item');
        return items.length > 0 && !document.querySelector('#wtList .loading');
      }, null, 20000);
    };
    /** 等待 diff 容器渲染完成（无 loading 且出现模式控件或空态提示） */
    const waitDiff = async () => {
      await pollPage(page, () => {
        const box = document.getElementById('diffResultsContainer');
        return Boolean(box) && !box.querySelector('.loading') && (box.querySelector('#diffModeControl') || box.textContent.includes('无任何文件差异') || box.textContent.includes('没有本地未提交'));
      }, null, 20000);
    };

    // ================= 1. Diff 视图 =================
    // Inspect 基线（总览视图）：worktree/分支列表渲染完成后出图
    await waitInspect(mainRepo);
    await captureBaseline(page, qaRoot, 'd', 'inspect-view', () => {
      const overviewVisible = document.getElementById('viewOverview')?.style.display !== 'none';
      const rows = document.querySelectorAll('#wtList .list-item').length;
      return overviewVisible && rows > 0;
    });
    // 进入 Diff 视图：后续 Diff 场景的渲染断言与截图都以「Diff 视图可见」为前提
    await page.evaluate(() => { window.switchTab('diff'); });
    await page.waitForTimeout(400);
    // 页面内「Diff 视图可见」断言必须自包含（assertPageFn 会被序列化进页面执行，
    // 不能引用 Node 侧闭包）；此处仅为可读性注释。
    // API 矩阵：三组合 × 三模式（结构 + 关键数值断言）
    const combos = [
      { name: 'worktree↔worktree', base: { type: 'worktree', value: wt.dirty }, target: { type: 'worktree', value: wt.clean } },
      { name: 'worktree↔branch', base: { type: 'worktree', value: wt.clean }, target: { type: 'branch', value: br.unmerged } },
      { name: 'branch↔branch', base: { type: 'branch', value: 'main' }, target: { type: 'branch', value: br.unmerged } }
    ];
    const modes = ['committed', 'all', 'uncommitted'];
    let matrixOk = true;
    const matrixDetail = [];
    for (const combo of combos) {
      for (const mode of modes) {
        const params = new URLSearchParams({
          path: mainRepo,
          sourceType: combo.base.type, source: combo.base.value,
          targetType: combo.target.type, target: combo.target.value,
          mode
        });
        const res = await api(`/api/diff-refs?${params}`);
        const diff = res.body?.diff;
        const ok = res.status === 200 && diff && Number.isInteger(diff.ahead) && Array.isArray(diff.files);
        if (!ok) matrixOk = false;
        matrixDetail.push(`${combo.name}/${mode}=HTTP${res.status},ahead=${diff?.ahead},files=${diff?.files?.length ?? 'x'}`);
      }
    }
    record('d1-diff-api-matrix', 'diff-refs 三组合 × 三模式 API 矩阵全部 200 且结构完整', matrixOk ? 'pass' : 'fail', matrixDetail.join('；'));

    // UI 三组合渲染（committed 模式）：身份串为 worktree:<path> / branch:<name>。
    // 语义为 target 相对 base 的变更，组合必须选「committed 模式下 target 确有差异」的分支对
    const uiCombos = [
      { name: 'ww', base: `worktree:${wt.dirty}`, target: `worktree:${wt.manyCommits}`, expectFile: 'many/commit-01.txt' },
      { name: 'wb', base: `worktree:${wt.clean}`, target: `branch:${br.unmerged}`, expectFile: 'unmerged.txt' },
      { name: 'bb', base: 'branch:main', target: `branch:${br.unmerged}`, expectFile: 'unmerged.txt' }
    ];
    let uiDiffOk = true;
    const uiDiffDetail = [];
    for (const combo of uiCombos) {
      await page.evaluate(({ base, target, mode }) => {
        document.getElementById('diffBaseSelect').value = base;
        document.getElementById('diffTargetSelect').value = target;
        window.fetchAndRenderRefDiff(mode, false);
      }, { base: combo.base, target: combo.target, mode: 'committed' });
      await waitDiff();
      const text = await page.evaluate(() => document.getElementById('diffResultsContainer').textContent);
      const ok = text.includes(combo.expectFile);
      if (!ok) uiDiffOk = false;
      uiDiffDetail.push(`${combo.name}:${ok ? '命中' : '未命中'}${combo.expectFile}`);
      if (combo.name === 'ww') {
        // Diff 视图基线（文本差异态）：视图可见 + 模式切换条出现 + 文件命中后才出图
        await captureBaseline(page, qaRoot, 'd', 'diff-text', () => {
          const view = document.getElementById('viewDiff');
          return Boolean(view) && view.style.display !== 'none' && Boolean(view.offsetParent)
            && Boolean(document.getElementById('diffModeControl'))
            && document.getElementById('diffResultsContainer').textContent.includes('many/commit-01.txt');
        });
      }
    }
    record('d2-diff-ui-combos', 'UI 三组合 committed 渲染命中预期文件', uiDiffOk ? 'pass' : 'fail', uiDiffDetail.join('；'));

    // 模式按钮切换（data-action 迁移后的高回归风险点）：active 类迁移 + 视图刷新。
    // 模式可用性由服务端 modesAvailable 决定，运行时动态挑选「非 active 且未 disabled」
    // 的按钮点击，断言 active 迁移且容器重新渲染
    await page.evaluate(({ base, target }) => {
      document.getElementById('diffBaseSelect').value = base;
      document.getElementById('diffTargetSelect').value = target;
      window.fetchAndRenderRefDiff('committed', false);
    }, { base: `worktree:${mainRepo}`, target: `worktree:${wt.dirty}` });
    await waitDiff();
    const beforeMode = await page.evaluate(() => ({
      active: document.querySelector('#diffModeControl .diff-mode-btn.active')?.dataset.mode,
      clickable: Array.from(document.querySelectorAll('#diffModeControl .diff-mode-btn'))
        .filter((b) => !b.classList.contains('disabled') && !b.classList.contains('active'))
        .map((b) => b.dataset.mode),
      text: document.getElementById('diffResultsContainer').textContent.slice(0, 200)
    }));
    // 优先切「全量变更」（若可用）：它同时包含 committed 与未提交内容，视图变化可断言
    const preferredMode = beforeMode.clickable.includes('all') ? 'all' : beforeMode.clickable[0];
    await page.evaluate((m) => {
      document.querySelector(`#diffModeControl [data-action="diff-mode"][data-mode="${m}"]`)?.click();
    }, preferredMode);
    const switched = await pollPage(page, (m) => {
      const active = document.querySelector('#diffModeControl .diff-mode-btn.active')?.dataset.mode;
      const text = document.getElementById('diffResultsContainer').textContent;
      return active === m && text.length > 0;
    }, preferredMode, 10000);
    const afterMode = await page.evaluate(() => ({
      active: document.querySelector('#diffModeControl .diff-mode-btn.active')?.dataset.mode,
      text: document.getElementById('diffResultsContainer').textContent.slice(0, 300)
    }));
    const modeOk = switched && beforeMode.active !== afterMode.active;
    record('d3-diff-mode-switch', '模式切换按钮 active 迁移且视图刷新（data-action 回归点）', modeOk ? 'pass' : 'fail',
      `${beforeMode.active}→${afterMode.active}（目标 ${preferredMode}，轮询命中=${switched}），可点击模式=[${beforeMode.clickable.join('/')}]`);

    // 图片/二进制呈现：repo-main 主工作区 → wt-dirty 的 committed 差异含 assets 追加
    // （该组合的 committed 模式服务端可用），raw-file 按 WORKTREE 直读校验 PNG 魔数
    await page.evaluate((p) => { window.selectRepo(p); }, mainRepo);
    await pollPage(page, () => document.querySelectorAll('#wtList .list-item').length > 0, null, 20000);
    const imgDiff = await api(`/api/diff-refs?${new URLSearchParams({
      path: mainRepo, sourceType: 'worktree', source: mainRepo, targetType: 'worktree', target: wt.dirty, mode: 'committed'
    })}`);
    const imgEntry = (imgDiff.body?.diff?.files || []).find((f) => f.filePath === 'assets/logo.png');
    const binEntry = (imgDiff.body?.diff?.files || []).find((f) => f.filePath === 'assets/blob.bin');
    const rawPng = await fetch(`${baseUrl}/api/raw-file?${new URLSearchParams({ repoPath: mainRepo, revision: 'WORKTREE', worktreePath: wt.dirty, filePath: 'assets/logo.png' })}`, { headers: { 'X-Git-Lens-Session': token } });
    const pngBytes = Buffer.from(await rawPng.arrayBuffer());
    const imgOk = Boolean(imgEntry?.isImage) && Boolean(binEntry?.isBinary) && rawPng.status === 200 && pngBytes.subarray(0, 4).toString('latin1') === '\x89PNG';
    record('d4-image-binary-diff', '图片/二进制 diff 标记与 raw-file 呈现（PNG 魔数校验）', imgOk ? 'pass' : 'fail',
      `logo isImage=${imgEntry?.isImage} blob isBinary=${binEntry?.isBinary} raw-file=${rawPng.status} bytes=${pngBytes.length}`);

    // 未提交改动视图（wt-dirty 的 uncommitted 模式含修改/staged/untracked 三类）
    await page.evaluate(({ base, target }) => {
      document.getElementById('diffBaseSelect').value = base;
      document.getElementById('diffTargetSelect').value = target;
      window.fetchAndRenderRefDiff('uncommitted', false);
    }, { base: `worktree:${wt.dirty}`, target: `worktree:${wt.dirty}` });
    await waitDiff();
    const uncommittedText = await page.evaluate(() => document.getElementById('diffResultsContainer').textContent);
    const uncommittedOk = ['notes.txt', 'staged-file.txt', 'untracked-file.txt'].every((f) => uncommittedText.includes(f));
    record('d5-uncommitted-view', '未提交改动视图含修改/staged/untracked 三类文件', uncommittedOk ? 'pass' : 'fail',
      uncommittedOk ? '' : uncommittedText.slice(0, 200));
    // Diff 视图基线（未提交态）：三类文件可见后才出图
    await captureBaseline(page, qaRoot, 'd', 'diff-uncommitted', () => {
      const view = document.getElementById('viewDiff');
      return Boolean(view) && view.style.display !== 'none' && Boolean(view.offsetParent)
        && ['notes.txt', 'staged-file.txt', 'untracked-file.txt'].every((f) => document.getElementById('diffResultsContainer').textContent.includes(f));
    });

    // ================= 2. 提交抽屉 =================
    // Inspect 视图在此前的基线出图（g4-d-inspect-view）；此处切回总览确保上下文一致
    await waitInspect(mainRepo);
    await page.evaluate(() => { window.switchTab('overview'); });
    await page.waitForTimeout(300);
    // 打开长列表 worktree（35 提交 > 分页 30）的提交抽屉
    await page.evaluate((wtPath) => {
      const row = Array.from(document.querySelectorAll('#wtList .list-item')).find((el) => el.textContent.includes('wt-many-commits'));
      row?.querySelector('[data-action="wt-open-commits"]')?.click();
    }, wt.manyCommits);
    await pollPage(page, () => {
      const drawer = document.getElementById('commitsDrawer');
      const cards = document.querySelectorAll('#commitsDrawerBody .commit-item');
      return drawer && drawer.style.display !== 'none' && cards.length >= 30;
    }, null, 20000);
    const drawerFirst = await page.evaluate(() => ({
      cards: document.querySelectorAll('#commitsDrawerBody .commit-item').length,
      uniqueHashes: new Set(Array.from(document.querySelectorAll('#commitsDrawerBody .commit-item')).map((c) => c.dataset.cIdx)).size,
      footerShown: document.getElementById('commitsDrawerFooter').style.display !== 'none'
    }));
    record('c1-commits-drawer-list', '提交抽屉打开渲染 30 条（分页 limit）且出现加载更多', drawerFirst.cards >= 30 && drawerFirst.footerShown ? 'pass' : 'fail',
      `cards=${drawerFirst.cards} footer=${drawerFirst.footerShown}`);

    // author/grep 过滤
    await page.evaluate(() => {
      document.getElementById('commitFilterGrep').value = '第 3';
      document.querySelector('[data-action="apply-commits-filters"]')?.click();
    });
    await pollPage(page, () => !document.querySelector('#commitsDrawerBody .loading'), null, 15000);
    const grepState = await page.evaluate(() => ({
      cards: Array.from(document.querySelectorAll('#commitsDrawerBody .commit-item')).map((c) => c.textContent),
      loading: Boolean(document.querySelector('#commitsDrawerBody .loading'))
    }));
    const grepOk = !grepState.loading && grepState.cards.length > 0 && grepState.cards.length < 30
      && grepState.cards.every((t) => t.includes('第 3'));
    record('c2-commits-filter', 'grep 过滤生效（字面「第 3」命中第 3/30-35 号提交共 7 条）', grepOk ? 'pass' : 'fail',
      `cards=${grepState.cards.length}`);
    await page.evaluate(() => {
      document.getElementById('commitFilterGrep').value = '';
      document.getElementById('commitFilterAuthor').value = 'QA Runner';
      document.querySelector('[data-action="apply-commits-filters"]')?.click();
    });
    await pollPage(page, () => !document.querySelector('#commitsDrawerBody .loading'), null, 15000);
    const authorCards = await page.evaluate(() => document.querySelectorAll('#commitsDrawerBody .commit-item').length);
    record('c2b-commits-filter-author', 'author 过滤（QA Runner）保留全部提交', authorCards >= 30 ? 'pass' : 'fail', `cards=${authorCards}`);

    // 加载更多：追加渲染后旧卡片仍可交互、无重复绑定（同一 hash 不重复出现）
    await page.evaluate(() => {
      document.getElementById('commitFilterAuthor').value = '';
      document.querySelector('[data-action="apply-commits-filters"]')?.click();
    });
    await pollPage(page, () => !document.querySelector('#commitsDrawerBody .loading'), null, 15000);
    await page.evaluate(() => document.getElementById('loadMoreCommitsBtn')?.click());
    await pollPage(page, () => document.querySelectorAll('#commitsDrawerBody .commit-item').length >= 35, null, 15000);
    const afterMore = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#commitsDrawerBody .commit-item'));
      // 唯一性以卡片头部展示的短 SHA 为准（data-c-idx 是批内序号，跨批会重置）
      const shortHashes = cards.map((c) => c.querySelector('.commit-hash')?.textContent);
      // 默认展开回归：提交抽屉的卡片只有展开态，点击卡片本身不得收起摘要
      const firstInitiallyExpanded = Boolean(cards[0]?.querySelector('.commit-detail'));
      cards[0]?.click();
      const firstRemainsExpanded = Boolean(cards[0]?.querySelector('.commit-detail'));
      return {
        count: cards.length,
        uniqueHashes: new Set(shortHashes).size,
        firstInitiallyExpanded,
        firstRemainsExpanded
      };
    });
    record('c3-load-more', '加载更多追加到 35 条且默认展开、点击卡片不收起', afterMore.count >= 35 && afterMore.uniqueHashes === afterMore.count
      && afterMore.firstInitiallyExpanded && afterMore.firstRemainsExpanded ? 'pass' : 'fail',
      `count=${afterMore.count} unique=${afterMore.uniqueHashes} 默认展开=${afterMore.firstInitiallyExpanded} 点击后仍展开=${afterMore.firstRemainsExpanded}`);

    // SHA 复制：页面按钮触发写剪贴板，主进程 clipboard 轮询读取（Electron 共享系统剪贴板）；
    // 剪贴板写入是异步系统调用，读取失败时重试数次。无头环境下 navigator.clipboard.writeText
    // 可能因焦点限制静默失败，且宿主机剪贴板可能有陈旧内容：先采样点击前基线，
    // 点击后「变为合法 SHA」为强断言；「未变化」降级为按钮可点且无异常（留人工复核）；
    // 「变化但非 SHA」才是真失败
    const clipboardBaseline = await app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => null);
    const copyState = await page.evaluate(() => {
      const first = document.querySelector('#commitsDrawerBody .commit-item [data-action="commit-copy-hash"]');
      first?.click();
      return { clicked: Boolean(first) };
    });
    let clipboardText = clipboardBaseline ?? '';
    for (let attempt = 0; attempt < 4 && !/^[0-9a-f]{7,40}$/i.test(clipboardText); attempt++) {
      await page.waitForTimeout(300);
      try {
        clipboardText = (await app.evaluate(({ clipboard }) => clipboard.readText())).trim();
      } catch (err) {
        clipboardText = `clipboard 读取失败: ${err.message}`;
      }
    }
    const shaLike = /^[0-9a-f]{7,40}$/i.test(clipboardText);
    const unchanged = clipboardText === (clipboardBaseline ?? '');
    record('c4-copy-sha', 'SHA 复制按钮写入系统剪贴板（页面按钮触发 + 主进程读取）',
      copyState.clicked && (shaLike || unchanged) ? (shaLike ? 'pass' : 'skip') : 'fail',
      shaLike
        ? `clipboard=${JSON.stringify(clipboardText.slice(0, 45))}`
        : unchanged
          ? `clicked=${copyState.clicked} 剪贴板未变化（无头焦点限制写入未生效，降级断言按钮已绑定且点击无异常），剪贴板内容留人工复核`
          : `clicked=${copyState.clicked} 剪贴板变化但非 SHA：${JSON.stringify(clipboardText.slice(0, 60))}`);
    // 提交抽屉基线：抽屉可见且分页卡片 ≥30 后才出图
    await captureBaseline(page, qaRoot, 'c', 'commits-drawer', () => {
      const drawer = document.getElementById('commitsDrawer');
      return Boolean(drawer) && drawer.style.display !== 'none'
        && document.querySelectorAll('#commitsDrawerBody .commit-item').length >= 30;
    });
    await page.evaluate(() => window.closeCommitsDrawer?.());

    // ================= 3. URL/会话恢复（reload 后同视图） =================
    // 恢复链要求 tab=diff：sessionStorage/URL 中记录 tab，reload 后才会自动应用 diff 态
    await waitInspect(mainRepo);
    await page.evaluate(() => { window.switchTab('diff'); });
    await page.waitForTimeout(400);
    const restoreCombo = { base: `worktree:${wt.dirty}`, target: `branch:${br.unmerged}` };
    await page.evaluate(({ base, target }) => {
      document.getElementById('diffBaseSelect').value = base;
      document.getElementById('diffTargetSelect').value = target;
      window.fetchAndRenderRefDiff('committed', true);
    }, restoreCombo);
    await waitDiff();
    const urlBeforeReload = await page.url();
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    // 恢复是异步链（loadProjects → inspect → populate → 应用 diff 态），轮询直到选中态匹配
    const restoredMatch = await pollPage(page, (expected) => {
      const box = document.getElementById('diffResultsContainer');
      const base = document.getElementById('diffBaseSelect')?.value;
      const target = document.getElementById('diffTargetSelect')?.value;
      const mode = document.querySelector('#diffModeControl .diff-mode-btn.active')?.dataset.mode;
      const repo = document.getElementById('repoSelect')?.value;
      return base === expected.base && target === expected.target && mode === 'committed' && repo === expected.repo
        && Boolean(box) && !box.querySelector('.loading');
    }, { base: restoreCombo.base, target: restoreCombo.target, repo: mainRepo }, 20000);
    const restored = await page.evaluate(() => ({
      url: location.href,
      base: document.getElementById('diffBaseSelect')?.value,
      target: document.getElementById('diffTargetSelect')?.value,
      mode: document.querySelector('#diffModeControl .diff-mode-btn.active')?.dataset.mode,
      repo: document.getElementById('repoSelect')?.value
    }));
    const restoreOk = restoredMatch && restored.url === urlBeforeReload;
    record('u1-url-restore', 'reload 后 URL 与 diff 选中态（仓库/base/target/mode）完整恢复', restoreOk ? 'pass' : 'fail',
      `url 相同=${restored.url === urlBeforeReload} base=${restored.base} target=${restored.target} mode=${restored.mode} repo=${restored.repo === mainRepo}`);

    // ================= 4. 原生 UI：缩放与窄窗 =================
    let zoomOk = true;
    const zoomDetail = [];
    for (const factor of [1.0, 1.25, 1.5]) {
      // 多标签架构：BrowserWindow.webContents 是空壳，缩放作用于应用标签视图
      await setAppZoom(app, hub.appPrefix, factor);
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => {
        const el = document.documentElement;
        const body = document.body;
        return {
          doc: el.scrollWidth - el.clientWidth,
          body: body.scrollWidth - body.clientWidth
        };
      });
      const ok = overflow.doc <= 2 && overflow.body <= 2;
      if (!ok) zoomOk = false;
      zoomDetail.push(`${factor}x 溢出=${overflow.doc}/${overflow.body}`);
      // 缩放基线：以 CDP 页截图捕获应用标签（内容随视口放大，无裁切），出图前断言 Diff 视图可见
      await captureBaseline(page, qaRoot, 'z', `zoom-${String(factor).replace('.', '_')}`, () => {
        const view = document.getElementById('viewDiff');
        return Boolean(view) && view.style.display !== 'none' && Boolean(view.offsetParent);
      });
    }
    record('z1-zoom-levels', '缩放 1.0/1.25/1.5 关键容器无横向溢出', zoomOk ? 'pass' : 'fail', zoomDetail.join('；'));

    // 上一个缩放档位的残留会让 innerWidth 按 zoom 缩小，窄窗断言前先复位 1.0；
    // 窗口尺寸调整仍走窗口级 setSize（空壳窗口尺寸即内容区尺寸）
    await setAppZoom(app, hub.appPrefix, 1.0);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(960, 600);
    });
    await page.waitForTimeout(400);
    const narrow = await page.evaluate(() => ({
      w: window.innerWidth, h: window.innerHeight,
      tabsVisible: Boolean(document.getElementById('tabOverview')?.offsetParent),
      footerVisible: Boolean(document.querySelector('footer.app-footer')?.offsetParent),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }));
    // 窄窗基线：断言关键元素可见且无溢出后，按应用标签 CDP 截图出图
    await captureBaseline(page, qaRoot, 'z', 'narrow-960x600', () => {
      const tabs = document.getElementById('tabOverview');
      const footer = document.querySelector('footer.app-footer');
      return Boolean(tabs?.offsetParent) && Boolean(footer?.offsetParent)
        && document.documentElement.scrollWidth - document.documentElement.clientWidth <= 2;
    });
    const narrowOk = narrow.w <= 962 && narrow.h <= 602 && narrow.tabsVisible && narrow.footerVisible && narrow.overflow <= 2;
    record('z2-narrow-window', '窄窗 960×600 关键元素可见且无布局崩坏', narrowOk ? 'pass' : 'fail', JSON.stringify(narrow));
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1280, 800);
    });
    await page.waitForTimeout(300);

    // ================= 5. 写操作矩阵（API 触发 + 前后 git 状态断言） =================
    // 注意 cherry 系列的顺序依赖：pick 成功 → 冲突 pick（409 回滚）→ revert 恢复。
    // revert 必须最后做：它会移除 cherry-file.txt，若先 revert 则冲突 pick 变成干净新增
    const stashBaseline = await gitSnap(qaRoot, wt.stashOps, 'stash', 'list');

    // W1a stash push + pop 原地
    await fs.writeFile(path.join(wt.stashOps, 'notes.txt'), 'main 基础文本。\nG4 stash 矩阵修改行。\n');
    await fs.writeFile(path.join(wt.stashOps, 'stash-new.txt'), 'stash 矩阵新增文件。\n');
    const pushRes = await api('/api/stash-action', { method: 'POST', body: { worktree: wt.stashOps, action: 'push', message: 'G4 stash 矩阵' } });
    const afterPush = {
      list: await gitSnap(qaRoot, wt.stashOps, 'stash', 'list'),
      status: await gitSnap(qaRoot, wt.stashOps, 'status', '--porcelain')
    };
    const w1aPushOk = pushRes.status === 200
      && afterPush.list.split('\n').length === stashBaseline.split('\n').filter(Boolean).length + 1
      && afterPush.list.includes('G4 stash 矩阵') && afterPush.status === '';
    // pop 原地
    const popRes = await api('/api/stash-action', { method: 'POST', body: { worktree: wt.stashOps, action: 'pop', stashRef: 'stash@{0}' } });
    const afterPop = {
      list: await gitSnap(qaRoot, wt.stashOps, 'stash', 'list'),
      status: await gitSnap(qaRoot, wt.stashOps, 'status', '--porcelain')
    };
    const w1aPopOk = popRes.status === 200 && afterPop.list === stashBaseline
      && afterPop.status.includes('notes.txt') && afterPop.status.includes('stash-new.txt');
    record('w1a-stash-push-pop', 'stash push（含消息）与 pop 原地恢复，git 状态前后一致', w1aPushOk && w1aPopOk ? 'pass' : 'fail',
      `push=${pushRes.status}/${w1aPushOk} pop=${popRes.status}/${w1aPopOk}`);

    // W1b pop 到同仓库另一 worktree：重新制造改动并 push，pop 到 wt-stash-target
    await fs.writeFile(path.join(wt.stashOps, 'stash-cross.txt'), '跨 worktree pop 素材。\n');
    await api('/api/stash-action', { method: 'POST', body: { worktree: wt.stashOps, action: 'push', message: 'G4 cross' } });
    const popCross = await api('/api/stash-action', { method: 'POST', body: { worktree: wt.stashOps, action: 'pop', stashRef: 'stash@{0}', targetWorktree: wt.stashTarget } });
    const afterCross = {
      opsStatus: await gitSnap(qaRoot, wt.stashOps, 'status', '--porcelain'),
      targetStatus: await gitSnap(qaRoot, wt.stashTarget, 'status', '--porcelain')
    };
    const w1bOk = popCross.status === 200 && afterCross.opsStatus === '' && afterCross.targetStatus.includes('stash-cross.txt');
    record('w1b-stash-pop-cross', 'pop 到同仓库另一 worktree：源干净、目标落地', w1bOk ? 'pass' : 'fail',
      `pop=${popCross.status} 源空=${afterCross.opsStatus === ''} 目标含文件=${afterCross.targetStatus.includes('stash-cross.txt')}`);

    // W1c pop 到未绑定分支的新 worktree（分支已在 fixture 预建、无 worktree）
    await fs.writeFile(path.join(wt.stashOps, 'stash-unbound.txt'), '未绑定分支素材。\n');
    await api('/api/stash-action', { method: 'POST', body: { worktree: wt.stashOps, action: 'push', message: 'G4 unbound' } });
    const unboundWt = path.join(qaRoot, 'repos', 'wt-stash-unbound');
    const popUnbound = await api('/api/stash-action', {
      method: 'POST',
      body: { worktree: wt.stashOps, action: 'pop', stashRef: 'stash@{0}', targetBranch: 'feature/stash-unbound', newWorktreePath: unboundWt }
    });
    let unboundStatus = '';
    try { unboundStatus = await gitSnap(qaRoot, unboundWt, 'status', '--porcelain'); } catch { /* worktree 未创建 */ }
    const unboundBranch = await gitSnap(qaRoot, mainRepo, 'branch', '--list', 'feature/stash-unbound');
    const w1cOk = popUnbound.status === 200 && unboundStatus.includes('stash-unbound.txt') && unboundBranch.includes('feature/stash-unbound');
    record('w1c-stash-pop-unbound', 'pop 到未绑定分支弹出新 worktree 并落地改动', w1cOk ? 'pass' : 'fail',
      `pop=${popUnbound.status} 新worktree状态含文件=${unboundStatus.includes('stash-unbound.txt')} 分支存在=${unboundBranch.includes('feature/stash-unbound')}`);

    // W1d drop 与 discard：drop 消耗一条 stash；discard 清空 target 的未提交内容
    await fs.writeFile(path.join(wt.stashOps, 'stash-drop.txt'), 'drop 素材。\n');
    await api('/api/stash-action', { method: 'POST', body: { worktree: wt.stashOps, action: 'push', message: 'G4 drop' } });
    const beforeDrop = await gitSnap(qaRoot, wt.stashOps, 'stash', 'list');
    const dropRes = await api('/api/stash-action', { method: 'POST', body: { worktree: wt.stashOps, action: 'drop', stashRef: 'stash@{0}' } });
    const afterDrop = await gitSnap(qaRoot, wt.stashOps, 'stash', 'list');
    const discardRes = await api('/api/stash-action', { method: 'POST', body: { worktree: wt.stashTarget, action: 'discard' } });
    const targetClean = await gitSnap(qaRoot, wt.stashTarget, 'status', '--porcelain');
    const w1dOk = dropRes.status === 200
      && beforeDrop.split('\n').filter(Boolean).length === afterDrop.split('\n').filter(Boolean).length + 1
      && discardRes.status === 200 && targetClean === '';
    record('w1d-stash-drop-discard', 'drop 消耗 stash 记录、discard 清空目标 worktree 未提交内容', w1dOk ? 'pass' : 'fail',
      `drop=${dropRes.status} discard=${discardRes.status} targetClean=${targetClean === ''}`);

    // W2 cherry-pick 成功（git 状态前后断言）。
    // 顺序依赖：pick 成功 → 冲突 pick（409 回滚）→ revert 恢复；revert 放最后，
    // 它会移除 cherry-file.txt，若先做则冲突 pick 会退化为干净新增
    const cherryHeadBefore = await gitSnap(qaRoot, wt.cherry, 'rev-parse', 'HEAD');
    const sourceSha = await gitSnap(qaRoot, mainRepo, 'rev-parse', 'feature/cherry-source');
    const pickRes = await api('/api/commit-action', { method: 'POST', body: { worktree: wt.cherry, action: 'cherry-pick', sha: sourceSha } });
    const afterPick = {
      head: await gitSnap(qaRoot, wt.cherry, 'rev-parse', 'HEAD'),
      file: await gitSnap(qaRoot, wt.cherry, 'show', 'HEAD:cherry-file.txt').catch(() => '(缺失)'),
      status: await gitSnap(qaRoot, wt.cherry, 'status', '--porcelain')
    };
    const w2PickOk = pickRes.status === 200 && afterPick.head !== cherryHeadBefore
      && afterPick.file === 'source v1' && afterPick.status === '';
    record('w2-cherry-pick-clean', 'cherry-pick 成功落地内容且 worktree 干净（git 状态断言）', w2PickOk ? 'pass' : 'fail',
      `pick=${pickRes.status}/${w2PickOk}`);

    // W3 cherry-pick 冲突：ours（source v1）与 theirs（conflict v2）同路径冲突，409 且现场自动回滚
    const conflictSha = await gitSnap(qaRoot, mainRepo, 'rev-parse', 'feature/pick-conflict');
    const pickConflict = await api('/api/commit-action', { method: 'POST', body: { worktree: wt.cherry, action: 'cherry-pick', sha: conflictSha } });
    const afterConflict = {
      status: await gitSnap(qaRoot, wt.cherry, 'status', '--porcelain'),
      cherryPickHead: await gitSnap(qaRoot, wt.cherry, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD').then(() => '存在').catch(() => '无'),
      head: await gitSnap(qaRoot, wt.cherry, 'rev-parse', 'HEAD')
    };
    const w3Ok = pickConflict.status === 409 && afterConflict.status === '' && afterConflict.cherryPickHead === '无'
      && afterConflict.head === afterPick.head;
    record('w3-cherry-conflict-rollback', '冲突 cherry-pick 返回 409 且现场自动回滚（status 干净、无 CHERRY_PICK_HEAD、HEAD 未动）', w3Ok ? 'pass' : 'fail',
      `HTTP=${pickConflict.status} status 空=${afterConflict.status === ''} CHERRY_PICK_HEAD=${afterConflict.cherryPickHead} HEAD 未动=${afterConflict.head === afterPick.head}`);

    // W2b revert：目标是 pick 在当前分支产生的新提交（cherry-pick 会生成新 SHA）
    const revertRes = await api('/api/commit-action', { method: 'POST', body: { worktree: wt.cherry, action: 'revert', sha: afterPick.head } });
    const afterRevert = {
      fileGone: await gitSnap(qaRoot, wt.cherry, 'cat-file', '-e', 'HEAD:cherry-file.txt').then(() => true).catch(() => false),
      status: await gitSnap(qaRoot, wt.cherry, 'status', '--porcelain')
    };
    const w2RevertOk = revertRes.status === 200 && !afterRevert.fileGone && afterRevert.status === '';
    record('w2b-revert-restore', 'revert 刚 pick 的提交恢复原状（文件消失、worktree 干净）', w2RevertOk ? 'pass' : 'fail',
      `revert=${revertRes.status}/${w2RevertOk}`);

    // W4 本地 MR 生命周期（成功路径）
    const mrTargetHeadBefore = await gitSnap(qaRoot, fixture.mr.repo, 'rev-parse', 'HEAD');
    const mrSourceHead = await gitSnap(qaRoot, fixture.mr.repo, 'rev-parse', fixture.mr.branches.clean);
    const mrCreate = await api('/api/merge-requests', {
      method: 'POST',
      body: { repoPath: fixture.mr.repo, sourceBranch: fixture.mr.branches.clean, targetBranch: 'main', title: 'G4: MR 生命周期验证', description: 'QA 自动创建' }
    });
    const mrId = mrCreate.body?.mergeRequest?.id;
    const mrCreateOk = mrCreate.status === 200 && Boolean(mrId) && mrCreate.body?.mergeRequest?.sourceHeadAtCreate === mrSourceHead;
    const mrApprove = mrId ? await api('/api/merge-requests/action', { method: 'POST', body: { repoPath: fixture.mr.repo, id: mrId, action: 'approve' } }) : { status: 0 };
    const mrMerge = mrId ? await api('/api/merge-requests/action', { method: 'POST', body: { repoPath: fixture.mr.repo, id: mrId, action: 'merge' } }) : { status: 0 };
    const mrMergedHead = await gitSnap(qaRoot, fixture.mr.repo, 'rev-parse', 'HEAD');
    const mrParents = mrMergedHead ? (await gitSnap(qaRoot, fixture.mr.repo, 'log', '-1', '--format=%P')).split(/\s+/) : [];
    const mrStatusAfter = mrId ? await api(`/api/merge-requests/${encodeURIComponent(mrId)}?repoPath=${encodeURIComponent(fixture.mr.repo)}`) : { body: {} };
    const w4Ok = mrCreateOk && mrApprove.status === 200 && mrMerge.status === 200
      && mrMergedHead !== mrTargetHeadBefore && mrParents.length === 2 && mrParents[1] === mrSourceHead
      && mrStatusAfter.body?.mergeRequest?.status === 'merged';
    record('w4-mr-merge-lifecycle', 'MR open→approve→merge(--no-ff)：目标 HEAD 第二父为 source head', w4Ok ? 'pass' : 'fail',
      `create=${mrCreate.status} approve=${mrApprove.status} merge=${mrMerge.status} 父数=${mrParents.length} 第二父正确=${mrParents[1] === mrSourceHead}`);

    // W5 冲突 MR：先合并 beta（main 的共享行变为 beta 版），alpha 再合并必冲突——
    // 创建→重复创建 409→approve→merge 409（自动 abort、MR 保持 open）→cancel 终态
    const mrBeta = await api('/api/merge-requests', {
      method: 'POST',
      body: { repoPath: fixture.mr.repo, sourceBranch: fixture.mr.branches.beta, targetBranch: 'main', title: 'G4: beta 先行合并' }
    });
    const betaId = mrBeta.body?.mergeRequest?.id;
    await api('/api/merge-requests/action', { method: 'POST', body: { repoPath: fixture.mr.repo, id: betaId, action: 'approve' } });
    const mrBetaMerge = await api('/api/merge-requests/action', { method: 'POST', body: { repoPath: fixture.mr.repo, id: betaId, action: 'merge' } });
    const betaMergedOk = mrBeta.status === 200 && mrBetaMerge.status === 200
      && (await gitSnap(qaRoot, fixture.mr.repo, 'show', 'main:shared.txt')) === 'shared-choice: beta';
    const mrAlpha = await api('/api/merge-requests', {
      method: 'POST',
      body: { repoPath: fixture.mr.repo, sourceBranch: fixture.mr.branches.alpha, targetBranch: 'main', title: 'G4: 冲突 MR' }
    });
    const alphaId = mrAlpha.body?.mergeRequest?.id;
    const mrDuplicate = await api('/api/merge-requests', {
      method: 'POST',
      body: { repoPath: fixture.mr.repo, sourceBranch: fixture.mr.branches.alpha, targetBranch: 'main', title: 'G4: 重复创建' }
    });
    const mrAlphaApprove = alphaId ? await api('/api/merge-requests/action', { method: 'POST', body: { repoPath: fixture.mr.repo, id: alphaId, action: 'approve' } }) : { status: 0 };
    const mrAlphaMerge = alphaId ? await api('/api/merge-requests/action', { method: 'POST', body: { repoPath: fixture.mr.repo, id: alphaId, action: 'merge' } }) : { status: 0 };
    const alphaAbort = {
      status: await gitSnap(qaRoot, fixture.mr.repo, 'status', '--porcelain'),
      mergeHead: await gitSnap(qaRoot, fixture.mr.repo, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').then(() => '存在').catch(() => '无')
    };
    const alphaDetail = alphaId ? await api(`/api/merge-requests/${encodeURIComponent(alphaId)}?repoPath=${encodeURIComponent(fixture.mr.repo)}`) : { body: {} };
    const mrCancel = alphaId ? await api('/api/merge-requests/action', { method: 'POST', body: { repoPath: fixture.mr.repo, id: alphaId, action: 'cancel' } }) : { status: 0 };
    const alphaFinal = alphaId ? await api(`/api/merge-requests/${encodeURIComponent(alphaId)}?repoPath=${encodeURIComponent(fixture.mr.repo)}`) : { body: {} };
    const w5Ok = betaMergedOk && mrAlpha.status === 200 && mrDuplicate.status === 409 && mrAlphaApprove.status === 200
      && mrAlphaMerge.status === 409 && alphaAbort.status === '' && alphaAbort.mergeHead === '无'
      && alphaDetail.body?.mergeRequest?.status === 'open' && mrCancel.status === 200
      && alphaFinal.body?.mergeRequest?.status === 'canceled';
    record('w5-mr-conflict-rollback', '冲突 MR merge 409→服务端 abort→MR 保持 open→cancel 终态；重复创建 409', w5Ok ? 'pass' : 'fail',
      `beta 先行=${betaMergedOk} create=${mrAlpha.status} 重复=${mrDuplicate.status} merge=${mrAlphaMerge.status} status空=${alphaAbort.status === ''} MERGE_HEAD=${alphaAbort.mergeHead} 终态=${alphaFinal.body?.mergeRequest?.status}`);

    // MR 列表 + 详情截图（G4 视觉基线）。列表按当前选中仓库过滤，需先切到 MR 所在仓库；
    // 预置一个 open MR（含标题/描述，alpha 已 cancel 可重建），列表含 open 与终态两类数据
    const mrOpenPreset = await api('/api/merge-requests', {
      method: 'POST',
      body: {
        repoPath: fixture.mr.repo, sourceBranch: fixture.mr.branches.alpha, targetBranch: 'main',
        title: 'G4: 待审阅的开放 MR', description: '视觉基线预置：open 状态样例，含完整描述文本与审阅按钮。'
      }
    });
    const mrOpenTitle = 'G4: 待审阅的开放 MR';
    const openPresetOk = mrOpenPreset.status === 200 && mrOpenPreset.body?.mergeRequest?.status === 'open';
    // 列表基线：先切到 MR 所在仓库并进入 MR 视图（列表按当前选中仓库过滤），
    // 再断言 MR 视图可见、列表含 open 预置行与 merged 终态行、无空态文案
    // （断言函数会被序列化进页面执行，标题用字面量、不得引用 Node 侧闭包）
    await waitInspect(fixture.mr.repo);
    await page.evaluate(() => { window.switchTab('mr'); });
    try {
      await captureBaseline(page, qaRoot, 'm', 'mr-list', () => {
        const view = document.getElementById('viewMr');
        const list = document.getElementById('mrList');
        return Boolean(view) && view.style.display !== 'none' && Boolean(list)
          && list.textContent.includes('G4: 待审阅的开放 MR')
          && list.textContent.includes('G4: MR 生命周期验证')
          && !list.textContent.includes('暂无 Merge Request');
      });
    } catch (err) {
      // 诊断信息：断言未过时输出列表实际内容与过滤状态，并强制刷新一次对比
      const diagBefore = await page.evaluate(() => ({
        viewMr: document.getElementById('viewMr')?.style.display,
        list: document.getElementById('mrList')?.textContent?.slice(0, 300),
        repo: document.getElementById('repoSelect')?.value
      }));
      await page.evaluate(() => window.refreshMergeRequests?.());
      await page.waitForTimeout(1200);
      // 页面进程内直接请求 API，并输出列表全量的命中布尔（不截断），区分「服务返回」与「渲染层」
      const apiFromPage = await page.evaluate(async (repo) => {
        const res = await fetch(`/api/merge-requests?repoPath=${encodeURIComponent(repo)}`);
        const d = await res.json();
        const items = (d.mergeRequests || []).map((m) => ({ status: m.status, title: m.title }));
        const listText = document.getElementById('mrList')?.textContent || '';
        return {
          apiCount: items.length,
          items,
          domCount: document.querySelectorAll('#mrList .list-item').length,
          domLength: listText.length,
          domHasOpen: listText.includes('G4: 待审阅的开放 MR'),
          domHasMerged: listText.includes('G4: MR 生命周期验证'),
          domHasEmptyHint: listText.includes('暂无 Merge Request')
        };
      }, fixture.mr.repo);
      record('m1-mr-list-shot', 'MR 列表基线截图', 'fail', `${err.message}；诊断=${JSON.stringify(apiFromPage)}`);
      throw err;
    }
    // 详情基线：打开预置 open MR 的详情抽屉，断言标题与描述渲染后才出图
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('#mrList .list-item'))
        .find((el) => el.textContent.includes('G4: 待审阅的开放 MR'));
      row?.querySelector('[data-action="mr-open-detail"]')?.click();
    });
    try {
      await captureBaseline(page, qaRoot, 'm', 'mr-detail', () => {
        const drawer = document.getElementById('mrDrawer');
        // 标题渲染在抽屉头（mrDrawerTitle），描述/状态渲染在 body
        const title = document.getElementById('mrDrawerTitle')?.textContent || '';
        const body = document.getElementById('mrDrawerBody');
        return Boolean(drawer) && drawer.style.display !== 'none'
          && title.includes('G4: 待审阅的开放 MR') && title.includes('MR #')
          && Boolean(body) && body.textContent.includes('视觉基线预置')
          && body.textContent.includes('开启');
      });
    } catch (err) {
      const diag = await page.evaluate(() => ({
        drawer: document.getElementById('mrDrawer')?.style.display,
        body: document.getElementById('mrDrawerBody')?.textContent?.slice(0, 200)
      }));
      record('m3-mr-detail-shot', 'MR 详情基线截图', 'fail', `${err.message}；诊断=${JSON.stringify(diag)}`);
      throw err;
    }
    await page.evaluate(() => window.closeMrDrawer?.());
    if (!openPresetOk) {
      record('m2-mr-preset', '预置 open MR（含标题/描述）供视觉基线', 'fail', `HTTP ${mrOpenPreset.status}`);
    }

    // W6 分支清理：单项删除已合入分支 + 批量清理已合入未绑定分支
    const mergedBefore = await gitSnap(qaRoot, mainRepo, 'branch', '--list', br.merged);
    const delOne = await api('/api/delete-branch', { method: 'POST', body: { repoPath: mainRepo, branchName: br.merged } });
    const mergedAfter = await gitSnap(qaRoot, mainRepo, 'branch', '--list', br.merged);
    // 批量：repo-mr 合并后的 mr/clean 已合入 main 且无 worktree，应出现在冗余候选
    const mrCandidates = await api(`/api/cleanup-candidates?path=${encodeURIComponent(fixture.mr.repo)}`);
    const redundantNames = (mrCandidates.body?.branches || []).map((b) => b.name);
    const batchDel = redundantNames.length > 0
      ? await api('/api/cleanup-redundant-branches', { method: 'POST', body: { repoPath: fixture.mr.repo, names: redundantNames } })
      : { status: 0 };
    const redundantAfter = await Promise.all(redundantNames.map((name) => gitSnap(qaRoot, fixture.mr.repo, 'branch', '--list', name)));
    const w6Ok = mergedBefore.includes(br.merged) && delOne.status === 200 && mergedAfter === ''
      && redundantNames.length > 0 && batchDel.status === 200 && redundantAfter.every((s) => s === '');
    record('w6-branch-cleanup', '分支清理：单项删除已合入分支 + 批量清理冗余分支（ref 级断言）', w6Ok ? 'pass' : 'fail',
      `单项=${delOne.status} 剩余=${mergedAfter === '' ? '无' : '有'} 批量=${batchDel.status} 清理数=${redundantNames.length}`);

    // W7 worktree 清理：单项移除（含删绑定分支）+ 批量清理已同步 worktree
    const rmOne = await api('/api/remove-worktree', {
      method: 'POST',
      body: { repoPath: mainRepo, worktreePath: wt.stashTarget, branchName: br.stashTargetWt, deleteBranch: true }
    });
    const targetGone = !(await fs.stat(wt.stashTarget).then(() => true).catch(() => false));
    const targetBranchGone = (await gitSnap(qaRoot, mainRepo, 'branch', '--list', br.stashTargetWt)) === '';
    const wtCandidates = await api(`/api/cleanup-candidates?path=${encodeURIComponent(mainRepo)}`);
    const syncedPaths = (wtCandidates.body?.worktrees || []).map((w) => w.path).filter((p) => p === wt.stashOps);
    const batchRm = syncedPaths.length > 0
      ? await api('/api/cleanup-synced-worktrees', { method: 'POST', body: { repoPath: mainRepo, paths: syncedPaths } })
      : { status: 0 };
    const opsGone = !(await fs.stat(wt.stashOps).then(() => true).catch(() => false));
    const w7Ok = rmOne.status === 200 && targetGone && targetBranchGone
      && syncedPaths.length === 1 && batchRm.status === 200 && opsGone;
    record('w7-worktree-cleanup', 'worktree 清理：单项移除含删绑定分支 + 批量清理已同步项（目录与 ref 断言）', w7Ok ? 'pass' : 'fail',
      `单项=${rmOne.status} 目录删=${targetGone} 分支删=${targetBranchGone} 批量=${batchRm.status} ops 目录删=${opsGone}`);

    // W8 prune 失联 worktree（fixture 的 wt-lost）
    const pruneRes = await api('/api/prune-worktrees', { method: 'POST', body: { repoPath: mainRepo } });
    const wtListAfterPrune = await gitSnap(qaRoot, mainRepo, 'worktree', 'list', '--porcelain');
    const w8Ok = pruneRes.status === 200 && !wtListAfterPrune.includes('wt-lost') && !/prunable/.test(wtListAfterPrune);
    record('w8-prune-lost', 'prune 清理失联 worktree（porcelain 列表无失联项）', w8Ok ? 'pass' : 'fail',
      `HTTP=${pruneRes.status} 列表仍含失联=${wtListAfterPrune.includes('wt-lost')}`);

    // ================= 6. 崩溃恢复（含恢复页截图 + 选中仓库恢复） =================
    // 先把选中仓库设为主仓库；selectRepo 对相同仓库是 no-op，先切走再切回
    // 保证 syncStateToUrl 真正把 repo 写入 sessionStorage（重启恢复的数据源）
    await page.evaluate((p) => { window.selectRepo(p); }, fixture.chinese.repo);
    await pollPage(page, () => document.getElementById('repoSelect')?.value === fixture.chinese.repo, null, 20000);
    await waitInspect(mainRepo);
    // 先切走再切回，保证 selectRepo 真正触发 syncStateToUrl 把 repo 写入 sessionStorage
    // （相同仓库的 selectRepo 是 no-op）；随后 dump 会话存储供恢复断言取证
    await page.evaluate((p) => { window.selectRepo(p); }, fixture.chinese.repo);
    await pollPage(page, () => document.getElementById('repoSelect')?.value === fixture.chinese.repo, null, 20000);
    await waitInspect(mainRepo);
    const sessionBeforeCrash = await page.evaluate(() => {
      const dump = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        dump[key] = (sessionStorage.getItem(key) || '').slice(0, 300);
      }
      return dump;
    });
    const repoBeforeCrash = await page.evaluate(() => document.getElementById('repoSelect')?.value);
    process.kill(ready.servicePid, 'SIGKILL');
    await pollUntil(() => {
      const value = readReadyFile(readyFile);
      return value && value.state === 'crashed' ? value : null;
    }, RESTART_TIMEOUT_MS, { describe: '就绪文件并入 state:crashed' }).catch(() => {});
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
    // 恢复遮罩基线：拍摄应用同文档遮罩态（深色主题变量样式由视觉审阅复核）
    try {
      await captureBaseline(page, qaRoot, 'e', 'recovery-page', () => {
        if (location.protocol === 'data:') return true;
        const overlay = document.getElementById('serviceStateOverlay');
        return (overlay && overlay.style.display !== 'none' && overlay.style.display !== '')
          || Boolean(document.getElementById('git-lens-recovery-fallback'))
          || (Boolean(document.body) && document.body.textContent.includes('本地服务正在恢复'));
      });
    } catch (err) {
      record('e1b-recovery-shot', '恢复页基线截图', 'fail', err.message);
    }
    record('e1-crash-recovery-page', '崩溃后恢复遮罩呈现并截图', recoveryShown ? 'pass' : 'fail',
      recoveryShown ? '' : '未观察到恢复遮罩');
    let restartedReady = null;
    try {
      restartedReady = await pollUntil(() => {
        const value = readReadyFile(readyFile);
        return value && !value.state && Number.isInteger(value.port) && value.servicePid !== ready.servicePid ? value : null;
      }, RESTART_TIMEOUT_MS, { describe: '服务自动重启' });
    } catch { /* e2 断言兜底 */ }
    ready = restartedReady || ready;
    const appBack = await pollPage(page, () => location.protocol === 'http:' && location.hostname === '127.0.0.1', null, 20000);
    // 选中仓库恢复依赖 sessionStorage（按 origin 隔离）：服务重启若换端口则为新 origin，
    // 旧会话存储不可见，页面回退默认仓库——这是产品真实边界，按端口是否变化分别断言
    const repoRestored = await pollPage(page, (expected) => document.getElementById('repoSelect')?.value === expected, mainRepo, 20000);
    const repoAfterCrash = await page.evaluate(() => document.getElementById('repoSelect')?.value);
    const sessionAfterCrash = await page.evaluate(() => {
      const dump = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        dump[key] = (sessionStorage.getItem(key) || '').slice(0, 300);
      }
      return dump;
    });
    const sameOrigin = restartedReady && restartedReady.port === ready.port;
    // 拆两项：应用页恢复（必须通过）与选中状态恢复。后者在崩溃前确有
    // sessionStorage（repo=主仓库），若重启后丢失即为真实缺陷——Shell 的恢复页
    // 是 data: URL，导航会触发 browsing context group swap，sessionStorage 被丢弃。
    record('e2a-crash-restart-app', '自动重启后切回应用页且数据可重载', appBack && restartedReady ? 'pass' : 'fail',
      `重启=${Boolean(restartedReady)} 应用页=${appBack}`);
    record('e2b-crash-session-restore', '崩溃重启后选中仓库经 sessionStorage 恢复（DEF-002 修复验收）',
      !sameOrigin ? 'skip' : (repoRestored ? 'pass' : 'fail'),
      repoRestored
        ? `选中仓库已恢复=${repoAfterCrash}（端口 ${restartedReady?.port} 与重启前一致，同源会话保持）`
        : `同端口=${sameOrigin}；崩溃前会话存储=${JSON.stringify(sessionBeforeCrash).slice(0, 240)}；恢复后=${JSON.stringify(sessionAfterCrash).slice(0, 240)}、实际选中=${repoAfterCrash}。DEF-002 修复已合入仍丢失，说明修复不完整，需立即上报`);
    void sameOrigin;
    // DEF-006 核对（e3）：服务中断已改非阻断失败提示，崩溃重启窗口内不应再出现
    // 阻塞式弹框（修复前「分析失败」alert 会挂起渲染层）。CDP 层免疫的事件兜底
    // 若被触发即说明页面仍有弹框路径——作为硬断言暴露，detail 带事件明细供定位
    const eDialogs = await hub.dialogEvents();
    record('e3-no-blocking-dialog', '崩溃恢复窗口无阻塞式弹框事件（DEF-006 非阻断提示验收）', eDialogs.length === 0 ? 'pass' : 'fail',
      eDialogs.length === 0
        ? 'CDP 会话未观察到 javascriptDialogOpening（免疫事件兜底未被触发）'
        : `捕获 ${eDialogs.length} 条：${JSON.stringify(eDialogs).slice(0, 240)}`);

    // ================= 7. strict CSP 与退出协议 =================
    cspSummary = { ...cspRegistry.summarize(), strictMode: strictCsp };
    record('h1-csp-strict', 'CSP 真实违规为零（--strict-csp 硬断言）', cspSummary.realViolationCount === 0 ? 'pass' : 'fail',
      `真实违规=${cspSummary.realViolationCount}，${JSON.stringify(cspSummary.realViolations).slice(0, 300)}；Electron 开发提醒=${cspSummary.electronDevWarningCount}（打包前固有，仅记录）`);

    // 场景 j：误杀防护自证（DEF-004 回归钉死）。另起一个与本轮无关的 Electron 实例
    // （同 worktree 二进制、独立 mkdtemp userData、仅加载 about:blank）——旧的孤儿
    // 匹配按「worktree 根 + Electron.app 路径」会把这类实例误判为本轮孤儿并强杀，
    // 修复后 i1 结束时它必须仍然存活
    unrelated = await createUnrelatedElectronInstance({ qaRoot });
    console.log(`[qa-desktop-full] 无关实例已启动 pid=${unrelated.pid} userData=${unrelated.userDataDir}`);

    // j1 正向对照：孤儿匹配锚点（本轮 userData）必须能命中运行中的本轮实例，
    // 防止匹配式失效后孤儿检查退化为「扫不到任何进程」的空洞通过
    const userDataDir = launched.env.GIT_LENS_USER_DATA;
    const scopeProbe = await findElectronProcesses({ userDataDir });
    record('j1-orphan-scope-probe', '孤儿匹配锚点可命中运行中的本轮实例（正向对照，≥1）', scopeProbe.length >= 1 ? 'pass' : 'fail',
      `锚点=${userDataDir} 命中=${scopeProbe.length}`);

    const exit = await closeAndVerify({ app, ready, userDataDir });
    app = null;
    await hub.dispose().catch(() => { /* 会话已随应用退出 */ });
    hub = null;
    record('i1-exit-protocol', 'app.close() 后服务退出、端口释放、主进程退出、无 Electron 孤儿', exit.ok ? 'pass' : 'fail',
      `服务退出=${exit.serviceGone} 端口释放=${exit.portClosed} 主进程退出=${exit.mainGone} 孤儿=${exit.orphanCount}（稳定窗口收敛=${exit.orphanScanStable}，close 耗时 ${exit.closeElapsed}ms）`);

    // j2 误杀防护断言：i1 的孤儿检查（含稳定窗口与兜底强杀）结束后，无关实例仍存活
    const unrelatedAlive = isPidAlive(unrelated.pid);
    record('j2-unrelated-instance-survives', '同 worktree 无关 Electron 实例在退出协议后仍存活（未被误杀）', unrelatedAlive ? 'pass' : 'fail',
      unrelatedAlive ? `pid=${unrelated.pid} 存活` : `pid=${unrelated.pid} 已被误杀（回退为过宽匹配即复现）`);

    // ================= 8. 多标签场景（契约 §15，独立第二实例） =================
    // 主实例已在 i1 验证 app.close() 应用级退出；多标签改用独立实例（独立 userData/
    // 就绪文件/凭据文件），避免两条退出路径互相干扰。m5 以「关闭最后一个标签」触发
    // 退出（⌘W 同语义路径），与 i1 互为补充。
    console.log('[qa-desktop-full] 启动多标签场景独立实例…');
    const mtabEnv = buildDesktopEnv({ qaRoot, runId, suffix: 'mtab' });
    await fs.mkdir(path.join(qaRoot, 'artifacts-mtab'), { recursive: true });
    await writeScanConfigInto(path.join(mtabEnv.GIT_LENS_USER_DATA, 'git-lens-config'), qaRoot);
    const mtabCspRegistry = createCspRegistry();
    mtabApp = (await startDesktopApp({ qaRoot, runId: `${runId}-mtab`, env: mtabEnv })).app;
    mtabHub = await openDesktopChannel({ env: mtabEnv, registry: mtabCspRegistry });
    const mtabReady = await pollUntil(() => {
      const value = readReadyFile(mtabEnv.GIT_LENS_E2E_READY_FILE);
      return value && Number.isInteger(value.port) && value.port > 0 ? value : null;
    }, 30000, { describe: '多标签实例就绪文件' });
    const mtabValid = validateReady(mtabReady);
    mtabHub.appPrefix = `${mtabValid.baseUrl}/`;
    const [mtabT1] = await mtabHub.waitForAppTargets(1, 15000);
    const mtabTabbar = await mtabHub.waitForTabbarReady(15000);
    const tabbar = createTabbarDriver(mtabTabbar);
    // 创建顺序列表：/json/list 顺序不代表创建顺序，以「恰一个新目标」逐个锁定
    const creationOrder = [mtabT1.id];

    // m1 经 tabbar「+」新建 2 个标签（共 3 个应用目标），全部同端口同源
    let m1Ok = true;
    try {
      for (let expected = 2; expected <= 3; expected += 1) {
        await tabbar.clickNew();
        const created = await mtabHub.waitForNewAppTarget(creationOrder, 15000);
        creationOrder.push(created.id);
      }
    } catch (err) {
      m1Ok = false;
    }
    const m1Targets = await mtabHub.listAppTargets();
    m1Ok = m1Ok && creationOrder.length === 3 && m1Targets.length === 3
      && creationOrder.every((id) => m1Targets.some((t) => t.id === id))
      && m1Targets.every((t) => t.url.startsWith(mtabHub.appPrefix));
    record('m1-multitab-create', '经 tabbar「+」新建 2 个标签，共 3 个应用目标且同端口同源', m1Ok ? 'pass' : 'fail',
      `目标数=${m1Targets.length} 创建次序=${creationOrder.join(' → ')}`);

    if (m1Ok) {
      const mtabPages = [];
      for (const id of creationOrder) mtabPages.push(await mtabHub.pageFor(id));

      // m2 标签标题随页面 title 更新并同步到标签条；最新创建的标签处于激活态（.active）。
      // 终态判别必须是「仓库感知」形态：首屏 HTML 的通用初始标题（`Git Lens · 本地仓库
      // 透镜与代码 Diff 审计`）同样含 "Git Lens"，曾让轮询在扫描完成前瞬间满足——
      // m1 刚建完标签就逐个轮询，落在窗口内的标签页标题快照是通用值，而其终态标题
      // 事件稍后到达标签条，两侧比对必然失配（连续两轮 m2 失败的根因）。故页面与
      // 标签条两侧都等 `<仓库> · <视图> | Git Lens` 形态后再取快照，保证双方均为终态
      const isSettledTitle = (t) => typeof t === 'string'
        && t.endsWith('| Git Lens') && !t.startsWith('Git Lens ·');
      const mtabPageTitles = [];
      for (const [index, tabPage] of mtabPages.entries()) {
        await pollUntilAsync(
          () => tabPage.title().then((t) => (isSettledTitle(t) ? t : null)),
          15000, { intervalMs: 200, describe: `标签 ${index + 1} 页面 title 到达仓库感知终态` }
        ).catch(() => { /* 超时由下方断言兜底 */ });
        mtabPageTitles.push(await tabPage.title());
      }
      // 标签条标题同样等全部到达终态再比对：page-title-updated → IPC → tabbar 渲染
      // 晚于页面 title 生效，直接读可能拿到上一态
      const mtabBarTitles = await pollUntilAsync(async () => {
        const titles = (await tabbar.titles()) || [];
        return titles.length === 3 && titles.every(isSettledTitle) ? titles : null;
      }, 15000, { intervalMs: 200, describe: '标签条 3 个标题均到达仓库感知终态' })
        .catch(async () => (await tabbar.titles()) || []);
      const mtabActiveIndex = await tabbar.activeIndex();
      // 激活下标断言依赖「最新创建的标签自动激活」；点击激活类断言（m3/m4/r1/r2）另见
      // 各自处的时序说明——tabbar 点击经 IPC 到主进程切激活是异步的，断言前先轮询
      const m2Ok = mtabPageTitles.every(isSettledTitle)
        && mtabBarTitles.length === 3
        && mtabPageTitles.every((t) => mtabBarTitles.includes(t))
        && mtabActiveIndex === 2;
      record('m2-multitab-titles', '标签条标题取自各页面 title 且新建标签处于激活态（.active）', m2Ok ? 'pass' : 'fail',
        `页标题=${JSON.stringify(mtabPageTitles)} 条标题=${JSON.stringify(mtabBarTitles)} 激活下标=${mtabActiveIndex}`);

      // m3 sessionStorage 按标签隔离：标签 A 选中仓库，标签 B 保持自身默认仓库；
      // 经 tabbar 切走再切回，A 的选中保持、B 不受影响（激活切换不销毁不重载视图）
      await tabbar.clickTab(1);
      await pollPage(mtabPages[1], () => Boolean(document.getElementById('repoSelect')?.value), null, 20000);
      const bDefaultRepo = await mtabPages[1].evaluate(() => document.getElementById('repoSelect')?.value || '');
      // A 的目标仓库避开 B 的默认仓库，保证「互不串」断言非空洞
      const repoForA = bDefaultRepo === fixture.main.repo ? fixture.chinese.repo : fixture.main.repo;
      await tabbar.clickTab(0);
      await mtabPages[0].waitForTimeout(400);
      await mtabPages[0].evaluate((p) => { window.selectRepo(p); }, repoForA);
      const aSelected = await pollPage(mtabPages[0], (p) => document.getElementById('repoSelect')?.value === p, repoForA, 20000);
      const aSessionRepo = await mtabPages[0].evaluate(() => {
        try { return JSON.parse(sessionStorage.getItem('git_lens_tab_state') || '{}').repo || ''; } catch { return '(解析失败)'; }
      });
      const bRepoBefore = await mtabPages[1].evaluate(() => document.getElementById('repoSelect')?.value || '');
      await tabbar.clickTab(1);
      await mtabPages[1].waitForTimeout(400);
      const bRepoAfter = await mtabPages[1].evaluate(() => document.getElementById('repoSelect')?.value || '');
      await tabbar.clickTab(0);
      await mtabPages[0].waitForTimeout(400);
      const aRepoBack = await mtabPages[0].evaluate(() => document.getElementById('repoSelect')?.value || '');
      const m3Ok = aSelected && aSessionRepo === repoForA
        && bRepoBefore !== repoForA && bRepoAfter !== repoForA
        && aRepoBack === repoForA;
      record('m3-multitab-session-isolation', 'sessionStorage 按标签隔离：A 选仓库经切换往返保持，B 默认仓库不串', m3Ok ? 'pass' : 'fail',
        `A 选中=${aRepoBack || '(空)'}（会话存储=${aSessionRepo || '(空)'}） B 前后=${bRepoBefore || '(空)'}/${bRepoAfter || '(空)'} A 目标=${repoForA}`);

      // m4 关闭中间标签：应用目标销毁（/json/list 消失）、其余标签存活、激活就近转移。
      // ⌘W 契约语义是关闭「当前」标签——先激活中间标签再点其 ×（真实用户路径），
      // 关闭后台标签不会转移激活（closeTab 仅在被关标签为激活态时就近激活）
      const closedMiddleId = creationOrder[1];
      await tabbar.clickTab(1);
      await mtabPages[1].waitForTimeout(300);
      await tabbar.clickClose(1);
      const m4Gone = await pollUntilAsync(async () => {
        const targets = await mtabHub.listAppTargets();
        return targets.length === 2 && targets.every((t) => t.id !== closedMiddleId) ? targets : null;
      }, 10000, { intervalMs: 150, describe: '被关标签的应用目标销毁' }).catch(() => null);
      const m4Active = await tabbar.activeIndex();
      // 存活标签此处早已加载完成，理论上无初始态窗口；仍用终态判别保持断言语义一致
      const survivorsOk = isSettledTitle(await mtabPages[0].evaluate(() => document.title))
        && isSettledTitle(await mtabPages[2].evaluate(() => document.title));
      const m4Ok = Boolean(m4Gone) && m4Active === 1 && survivorsOk;
      record('m4-multitab-close-middle', '关闭中间标签：目标销毁、其余标签存活、激活就近转移至右侧', m4Ok ? 'pass' : 'fail',
        `目标销毁=${Boolean(m4Gone)} 激活下标=${m4Active}（期望 1） 存活标签可求值=${survivorsOk}`);

      // m5 依次关闭剩余标签：最后一个触发关窗退出协议（服务退出/端口释放/无孤儿）
      await tabbar.clickClose(0);
      await pollUntilAsync(async () => (await mtabHub.listAppTargets()).length === 1, 10000, {
        intervalMs: 150, describe: '应用目标降至 1 个'
      }).catch(() => { /* 下方退出断言兜底 */ });
      await tabbar.clickClose(0);
      // 必须传原始就绪文件形态（含 mainPid/servicePid）：validateReady 只回 baseUrl/port，
      // pid 缺失会让退出校验变成空洞通过；userDataDir 为孤儿匹配锚点（仅匹配本实例）
      const mtabExit = await verifyAppExit({ ready: mtabReady, closeTimeoutMs: 20000, waitMainGoneMs: 20000, userDataDir: mtabEnv.GIT_LENS_USER_DATA });
      record('m5-multitab-exit-protocol', '依次关闭全部标签后应用退出：主进程退出、服务退出、端口释放、无孤儿',
        mtabExit.mainGone && mtabExit.serviceGone && mtabExit.portClosed && mtabExit.orphanCount === 0 ? 'pass' : 'fail',
        `主进程退出=${mtabExit.mainGone} 服务退出=${mtabExit.serviceGone} 端口释放=${mtabExit.portClosed} 孤儿=${mtabExit.orphanCount}（稳定窗口收敛=${mtabExit.orphanScanStable}）`);
    } else {
      // m1 未通过：不再执行依赖 3 标签的后续场景，记录 skip 并强杀实例防残留
      for (const [id, name] of [
        ['m2-multitab-titles', '标签条标题取自各页面 title 且新建标签处于激活态（.active）'],
        ['m3-multitab-session-isolation', 'sessionStorage 按标签隔离：A 选仓库经切换往返保持，B 默认仓库不串'],
        ['m4-multitab-close-middle', '关闭中间标签：目标销毁、其余标签存活、激活就近转移至右侧'],
        ['m5-multitab-exit-protocol', '依次关闭全部标签后应用退出：主进程退出、服务退出、端口释放、无孤儿']
      ]) {
        record(id, name, 'skip', '前置场景 m1 未通过，未执行');
      }
      try { mtabApp.process().kill('SIGKILL'); } catch { /* 已退出 */ }
      mtabApp = null;
    }
    const mtabCsp = mtabCspRegistry.summarize();
    record('m6-multitab-csp', '多标签下 CSP 真实违规为零（--strict-csp 硬断言）', mtabCsp.realViolationCount === 0 ? 'pass' : 'fail',
      `真实违规=${mtabCsp.realViolationCount}，${JSON.stringify(mtabCsp.realViolations).slice(0, 240)}；收集范围含 tabbar（file://，不在服务 CSP 响应头范围，仅记录对照）与空壳；Electron 开发提醒=${mtabCsp.electronDevWarningCount}`);
    if (mtabHub) {
      await mtabHub.dispose().catch(() => { /* 会话已随应用退出 */ });
      mtabHub = null;
    }

    // ================= 9. 跨启动标签恢复（契约 §15 第二次修订，独立第三实例，r1-r5） =================
    // m 段结束时 mtab 实例已按「关闭全部标签」路径退出（其 userData 存档为空标签集合）。
    // 恢复段改用独立第三实例（suffix 'restore'：独立 userData/就绪文件/凭据文件），
    // 从「无存档」的干净基线出发；三轮启动复用同一 userData——跨启动端口必然变化，
    // 恰好验证「只存查询串、恢复时重放到当前 origin」的核心语义。场景前状态 = 实例
    // 未启动；每轮结束走优雅退出（closeAndVerify 完整退出协议）衔接下一轮；r4 退出后
    // 清理存档文件恢复默认。r 段为最后一段，r4 回落单标签不影响任何后续场景。
    console.log('[qa-desktop-full] 启动跨启动恢复场景独立实例（r1 第一轮）…');
    const restoreEnv = buildDesktopEnv({ qaRoot, runId, suffix: 'restore' });
    await fs.mkdir(path.join(qaRoot, 'artifacts-restore'), { recursive: true });
    await writeScanConfigInto(path.join(restoreEnv.GIT_LENS_USER_DATA, 'git-lens-config'), qaRoot);
    const restoreTabStatePath = path.join(restoreEnv.GIT_LENS_USER_DATA, 'tab-state.json');
    const restoreCspRegistry = createCspRegistry();

    /** 读标签存档（<userData>/tab-state.json）；不存在或 JSON 损坏返回 null */
    const readRestoreTabState = async () => {
      try {
        return JSON.parse(await fs.readFile(restoreTabStatePath, 'utf8'));
      } catch {
        return null;
      }
    };

    /** 单轮启动前清掉上一轮 E2E 文件：防止就绪文件/DevToolsActivePort 被上一轮旧值空洞命中 */
    const resetRestoreE2eFiles = async () => {
      await fs.rm(restoreEnv.GIT_LENS_E2E_READY_FILE, { force: true });
      await fs.rm(restoreEnv.GIT_LENS_E2E_TOKEN_FILE, { force: true });
      await fs.rm(path.join(restoreEnv.GIT_LENS_USER_DATA, 'DevToolsActivePort'), { force: true });
    };

    /**
     * 启动一轮恢复实例并就绪 CDP 通道（同一 userData 跨启动，端口必然变化）。
     * 返回原始就绪形态（含 mainPid/servicePid，退出协议校验必需）与规范化 baseUrl/port。
     */
    const launchRestoreRound = async (roundLabel) => {
      await resetRestoreE2eFiles();
      restoreApp = (await startDesktopApp({ qaRoot, runId: `${runId}-restore`, env: restoreEnv })).app;
      restoreHub = await openDesktopChannel({ env: restoreEnv, registry: restoreCspRegistry });
      const ready = await pollUntil(() => {
        const value = readReadyFile(restoreEnv.GIT_LENS_E2E_READY_FILE);
        return value && Number.isInteger(value.port) && value.port > 0 ? value : null;
      }, 30000, { describe: `恢复实例就绪文件（${roundLabel}）` });
      const { baseUrl, port } = validateReady(ready);
      restoreHub.appPrefix = `${baseUrl}/`;
      return { ready, baseUrl, port };
    };

    /** 优雅退出当前轮恢复实例并验证退出协议（轮次衔接；失败即抛错走 launcher 失败） */
    const closeRestoreRound = async (ready, roundLabel) => {
      const exit = await closeAndVerify({ app: restoreApp, ready, userDataDir: restoreEnv.GIT_LENS_USER_DATA });
      restoreApp = null;
      await restoreHub.dispose().catch(() => { /* 会话已随应用退出 */ });
      restoreHub = null;
      if (!exit.ok) {
        throw new Error(`恢复实例${roundLabel}优雅退出协议未通过：${JSON.stringify(exit)}`);
      }
      return exit;
    };

    /** 取应用目标 URL 的查询串并解码（比对用，防编码形态差异） */
    const searchOf = (targetUrl) => {
      try {
        return safeDecode(new URL(targetUrl).search);
      } catch {
        return null;
      }
    };

    // ---- r1 建立状态：2 标签各选不同仓库 → 记录查询串 → 优雅退出验证退出前同步落盘 ----
    // 切库手段复用 m3：页面内 window.selectRepo（syncStateToUrl 把仓库写进 URL 查询串）
    const restoreRepoA = fixture.main.repo;
    const restoreRepoB = fixture.mr.repo;
    const { ready: r1Ready, port: r1Port } = await launchRestoreRound('r1');
    const [r1T1] = await restoreHub.waitForAppTargets(1, 15000);
    const r1Page1 = await restoreHub.pageFor(r1T1.id, r1T1.url);
    // 前置确认：无存档首启回落单标签，且 fixture 多仓库可发现（下拉 ≥2 项）
    const r1Discovered = await pollPage(r1Page1, () => document.querySelectorAll('#repoSelect option').length >= 2, null, 20000);
    await r1Page1.evaluate((p) => { window.selectRepo(p); }, restoreRepoA);
    const r1Repo1Set = await pollPage(r1Page1, (p) => document.getElementById('repoSelect')?.value === p, restoreRepoA, 20000);
    const r1Search1 = await r1Page1.evaluate('location.search');

    const r1Tabbar = await restoreHub.waitForTabbarReady(15000);
    const r1Tabs = createTabbarDriver(r1Tabbar);
    await r1Tabs.clickNew();
    const r1T2 = await restoreHub.waitForNewAppTarget([r1T1.id], 15000);
    const r1Page2 = await restoreHub.pageFor(r1T2.id, r1T2.url);
    await pollPage(r1Page2, () => document.querySelectorAll('#repoSelect option').length >= 2, null, 20000);
    await r1Page2.evaluate((p) => { window.selectRepo(p); }, restoreRepoB);
    const r1Repo2Set = await pollPage(r1Page2, (p) => document.getElementById('repoSelect')?.value === p, restoreRepoB, 20000);
    const r1Search2 = await r1Page2.evaluate('location.search');
    // 退出前把激活项切回标签 1，锁定存档 activeIndex 语义（经 tabbar DOM .active 确认）。
    // 防御性说明（上轮 r1b 曾观察到激活漂移：存档 activeIndex=1 与预期 0 不符，复跑
    // 转绿）：clickTab(0) 经 tabbar→IPC→主进程切激活是异步链路，轮询下方已覆盖切换
    // 收敛；若漂移可稳定复现，应按产品缺陷登记（激活切换竞态）排查，不得放宽期望值
    await r1Tabs.clickTab(0);
    const r1ActiveBack = await pollUntilAsync(
      async () => ((await r1Tabs.activeIndex()) === 0 ? true : null),
      5000, { intervalMs: 150, describe: '激活项经 tabbar 切回标签 1' }
    ).catch(() => false);
    const r1Searches = [safeDecode(r1Search1), safeDecode(r1Search2)];

    // 运行期防抖（500ms）落盘：不等退出就该能看到含两条查询串的存档
    // （probe 为异步读取，必须用 pollUntilAsync——pollUntil 只支持同步 read）
    const r1LiveArchive = await pollUntilAsync(async () => {
      const parsed = await readRestoreTabState();
      const tabs = parsed && Array.isArray(parsed.tabs) ? parsed.tabs : [];
      return tabs.length === 2 && tabs.every((t) => typeof t?.search === 'string' && t.search.startsWith('?')) ? parsed : null;
    }, 8000, { intervalMs: 250, describe: '运行期防抖落盘 tab-state.json（2 条查询串）' }).catch(() => null);
    record('r1a-multitab-setup', '恢复场景 r1a：两标签分别选中不同仓库且运行期防抖落盘（存档含 2 条查询串）',
      Boolean(r1Discovered && r1Repo1Set && r1Repo2Set && r1ActiveBack && r1LiveArchive) ? 'pass' : 'fail',
      `port=${r1Port} 查询串=[${r1Searches.map((s) => s.slice(0, 60)).join(' | ')}] 防抖存档=${r1LiveArchive ? '已落盘' : '未落盘'} 激活切回标签1=${Boolean(r1ActiveBack)}`);

    const r1Exit = await closeRestoreRound(r1Ready, 'r1');
    // 退出同步落盘终态：存档合法、只含查询串（无 http、每条 ? 开头）、activeIndex 合法且与第一轮一致
    const r1Archive = await readRestoreTabState();
    const r1ArchivedSearches = Array.isArray(r1Archive?.tabs) ? r1Archive.tabs.map((t) => safeDecode(t?.search || '')) : [];
    const r1ArchiveOk = Boolean(r1Archive)
      && r1Archive.version === 1
      && Number.isInteger(r1Archive.activeIndex)
      && r1Archive.activeIndex >= 0 && r1Archive.activeIndex < r1Archive.tabs.length
      && r1Archive.tabs.length === 2
      && r1Archive.tabs.every((t) => {
        const raw = typeof t?.search === 'string' ? t.search : '';
        // 只允许「?」开头的纯查询串：拒绝整串 URL 与协议相对形态（契约校验的写入侧镜像）
        return raw.startsWith('?') && !/https?:/i.test(raw) && !raw.includes('//');
      })
      && r1ArchivedSearches[0] === r1Searches[0] && r1ArchivedSearches[1] === r1Searches[1]
      && r1Archive.activeIndex === 0;
    record('r1b-exit-sync-archive', '恢复场景 r1b：优雅退出后存档同步落盘且只含查询串（无 http、? 开头、activeIndex 合法）',
      r1ArchiveOk && r1Exit.ok ? 'pass' : 'fail',
      `存档=${r1Archive ? JSON.stringify(r1Archive).slice(0, 260) : '缺失'} 退出协议=${r1Exit.ok}（close ${r1Exit.closeElapsed}ms）`);

    // ---- r2 跨启动恢复：同一 userData 重启 → 查询串重放到新端口、顺序/激活项一致、数据最新 ----
    console.log('[qa-desktop-full] 恢复实例第二轮启动（同 userData，验证自动恢复）…');
    const { ready: r2Ready, baseUrl: r2BaseUrl, port: r2Port } = await launchRestoreRound('r2');
    const r2Targets = await restoreHub.waitForAppTargets(2, 15000).catch(() => null);
    // 核心：每条存档查询串恰重放到一个标签，且 origin 为新一轮端口（端口不参与存档）
    const r2Matched = r1Searches.map((expected) => (r2Targets || []).filter((t) => searchOf(t.url) === expected));
    const r2ReplayOk = Boolean(r2Targets) && r2Targets.length === 2
      && r2Port !== r1Port
      && r2Matched.every((m) => m.length === 1)
      && r2Targets.every((t) => t.url.startsWith(`${r2BaseUrl}/`));
    // 顺序与激活项：标签条标题含仓库名（形如 `<仓库> · <视图> | Git Lens`），激活项经 .active 断言
    const r2Tabbar = await restoreHub.waitForTabbarReady(15000);
    const r2Tabs = createTabbarDriver(r2Tabbar);
    const r2Titles = await pollUntilAsync(async () => {
      const titles = await r2Tabs.titles();
      return Array.isArray(titles) && titles.length === 2 && titles.every((t) => t.includes('Git Lens')) ? titles : null;
    }, 15000, { describe: '恢复后标签条渲染 2 个标签' }).catch(() => null);
    const r2ActiveIndex = await r2Tabs.activeIndex();
    // 激活一致性断言读取的是存档恢复后的 .active（非点击链路）；上轮 r1b 激活漂移
    // （复跑转绿）的防御性说明见 r1 段 clickTab(0) 处，若再复现按缺陷登记处理
    const r2OrderOk = Boolean(r2Titles)
      && r2Titles[0].includes('repo-main') && r2Titles[1].includes('repo-mr')
      && r2ActiveIndex === (r1Archive?.activeIndex ?? -1);
    // 页面数据可加载（fresh）：每个恢复标签内 /api/projects 200 且选中仓库恢复
    let r2DataOk = Boolean(r2Matched[0][0] && r2Matched[1][0]);
    if (r2DataOk) {
      for (const [index, matched] of r2Matched.entries()) {
        const tabPage = await restoreHub.pageFor(matched[0].id, matched[0].url);
        const status = await tabPage.evaluate('fetch("/api/projects").then((r) => r.status)');
        const repoRestored = await pollPage(
          tabPage, (p) => document.getElementById('repoSelect')?.value === p,
          index === 0 ? restoreRepoA : restoreRepoB, 20000
        );
        if (status !== 200 || !repoRestored) r2DataOk = false;
      }
    }
    // 恢复后的标签条截图（G4 视觉基线）
    const r2ShotPath = path.join(qaRoot, 'artifacts', 'g4-r2-restored-tabbar.png');
    let r2ShotOk = true;
    try {
      await r2Tabbar.screenshot({ path: r2ShotPath });
    } catch (err) {
      r2ShotOk = false;
      console.error(`[qa-desktop-full] 恢复标签条截图失败：${err.message}`);
    }
    record('r2-cross-launch-restore', '恢复场景 r2：同 userData 重启自动恢复 2 标签——查询串重放到新端口、顺序/激活项一致、数据可加载',
      r2ReplayOk && r2OrderOk && r2DataOk ? 'pass' : 'fail',
      `port ${r1Port}→${r2Port} 查询串重放=${r2ReplayOk} 标题=${JSON.stringify(r2Titles)} 激活=${r2ActiveIndex}（存档 ${r1Archive?.activeIndex}） 数据fresh=${r2DataOk} 截图=${r2ShotOk ? r2ShotPath : '失败'}`);

    // ---- r3 崩溃不破坏：kill -9 服务 → 自动重启 → 2 标签仍在、查询串重放 ----
    // 弹框免疫长会话覆盖（Shell 提醒 ≥30s）：kill 瞬间旧文档在途请求失败是阻塞式
    // 弹框的风险窗口，事件兜底依赖会话存活。r2 期间 hub 已为两个应用页建立免疫
    // 会话（免疫内置在 connectCdpPage），kill 前经 pageFor 确认仍存活（断线会话
    // 自动重建），让免疫覆盖从 kill 到重启收敛的整个窗口
    for (const matched of r2Matched) {
      if (matched[0]) await restoreHub.pageFor(matched[0].id, matched[0].url).catch(() => { /* 重建失败由后续断言兜底 */ });
    }
    const r2ServicePid = r2Ready.servicePid;
    process.kill(r2ServicePid, 'SIGKILL');
    const r3Restarted = await pollUntil(() => {
      const value = readReadyFile(restoreEnv.GIT_LENS_E2E_READY_FILE);
      return value && !value.state && Number.isInteger(value.port) && value.servicePid !== r2ServicePid ? value : null;
    }, RESTART_TIMEOUT_MS, { describe: '恢复实例服务崩溃后自动重启' }).catch(() => null);
    // 重启端口可能与崩溃前不同：按新端口重设应用前缀再枚举（既有标签被迁移到新 origin）。
    // 换端口重放是跨源导航：Electron 按站点隔离为新标签换 renderer 进程，提交耗时
    // 数秒且随负载波动，等待窗口放宽到 30s（原 15s 在换端口轮次会偶发超时）
    let r3Targets = null;
    if (r3Restarted) {
      restoreHub.appPrefix = `http://127.0.0.1:${r3Restarted.port}/`;
      r3Targets = await restoreHub.waitForAppTargets(2, 30000).catch(() => null);
    }
    const r3Matched = r1Searches.map((expected) => (r3Targets || []).filter((t) => searchOf(t.url) === expected));
    // 断言加严（DEF-006 修复后的代码上）：无论重启端口是否复用，一律断言
    // 「标签集合保持（恰 2 个）+ 每条存档查询串恰重放到一个标签」——查询串重放
    // 由主进程按存档把查询串附加到当前 origin 实现，不依赖同源 sessionStorage，
    // 换端口轮次不再放宽为只断言 origin 迁移
    const r3QueriesUnchanged = r3Matched.every((m) => m.length === 1);
    const r3Ok = Boolean(r3Restarted && r3Targets)
      && r3Targets.length === 2
      && r3QueriesUnchanged
      && r3Targets.every((t) => t.url.startsWith(`http://127.0.0.1:${r3Restarted.port}/`));
    // DEF-006 核对：崩溃重启窗口内 CDP 层不应观察到阻塞式弹框事件
    //（修复前「分析失败」alert 会在此窗口弹出并挂起渲染层）
    const r3Dialogs = await restoreHub.dialogEvents();
    record('r3-crash-keeps-restored-tabs', '恢复场景 r3：服务被 kill -9 后自动重启，恢复态不破坏（2 标签保持、查询串重放到重启后端口）',
      r3Ok ? 'pass' : 'fail',
      `重启=${Boolean(r3Restarted)}（port ${r2Port}→${r3Restarted?.port}） 标签数=${r3Targets?.length ?? 0} 查询串重放=${r3QueriesUnchanged}（各条命中数=${JSON.stringify(r3Matched.map((m) => m.length))}） 弹框事件=${r3Dialogs.length}${r3Dialogs.length > 0 ? ` ${JSON.stringify(r3Dialogs).slice(0, 200)}` : ''}`);
    await closeRestoreRound(r3Restarted, 'r3');

    // ---- r4 容错：存档坏 JSON → 按无存档处理回落单标签首页；结束清理存档恢复默认 ----
    console.log('[qa-desktop-full] 恢复实例第三轮启动（坏档容错）…');
    await fs.writeFile(restoreTabStatePath, '{"version":1,"activeIndex":0,"tabs":[{"search":"?repo=%2Fbrok', 'utf8');
    const { ready: r4Ready, port: r4Port } = await launchRestoreRound('r4');
    const r4Targets = await restoreHub.waitForAppTargets(1, 15000).catch(() => null);
    let r4HomeOk = false;
    let r4Usable = false;
    let r4Search = '';
    if (r4Targets && r4Targets.length === 1) {
      const r4Page = await restoreHub.pageFor(r4Targets[0].id, r4Targets[0].url);
      // 回落首页 = 未按坏档恢复：坏档中的两条存档查询串不得重现。
      // 注意页面加载完仓库列表后会自动选中默认仓库并重写 URL（?repo=<默认仓库>），
      // 这是无存档启动的正常行为，「首页」以「坏档内容未被重放」为准
      r4Search = safeDecode(await r4Page.evaluate('location.search'));
      r4HomeOk = !r4Search.includes('repo-main') && !r4Search.includes('repo-mr');
      const r4Status = await r4Page.evaluate('fetch("/api/projects").then((r) => r.status)');
      const r4ReposLoaded = await pollPage(r4Page, () => document.querySelectorAll('#repoSelect option').length >= 2, null, 20000);
      r4Usable = r4Status === 200 && Boolean(r4ReposLoaded);
    }
    record('r4-corrupt-archive-fallback', '恢复场景 r4：存档坏 JSON 按无存档处理——单标签回落首页且页面可用',
      r4HomeOk && r4Usable ? 'pass' : 'fail',
      `port=${r4Port} 应用目标=${r4Targets?.length ?? 0} 存档查询串未重放=${r4HomeOk}（当前 search=${r4Search.slice(0, 80) || '(空)'}） 可用=${r4Usable}`);
    await closeRestoreRound(r4Ready, 'r4');
    // 清理该 userData 的存档文件恢复默认（无存档态）；qa-root 成功时整体删除，
    // 此处显式清理保证 --keep 保留现场时也不残留坏档
    await fs.rm(restoreTabStatePath, { force: true });

    // r5：恢复段三轮启动全程的 strict CSP 硬断言（镜像 m6 的多标签 CSP 收口）
    const restoreCsp = restoreCspRegistry.summarize();
    record('r5-restore-csp', '恢复场景 r5：三轮启动全程 CSP 真实违规为零（--strict-csp 硬断言）', restoreCsp.realViolationCount === 0 ? 'pass' : 'fail',
      `真实违规=${restoreCsp.realViolationCount}，${JSON.stringify(restoreCsp.realViolations).slice(0, 240)}；Electron 开发提醒=${restoreCsp.electronDevWarningCount}（打包前固有，仅记录）`);

    outcome = results.some((r) => r.status === 'fail') ? 'failed' : 'passed';
  } catch (err) {
    outcome = 'failed';
    record('launcher', '桌面全量启动器执行', 'fail', err.message);
  } finally {
    if (hub) {
      await hub.dispose().catch(() => { /* 会话已随应用退出 */ });
      hub = null;
    }
    if (mtabHub) {
      await mtabHub.dispose().catch(() => { /* 会话已随应用退出 */ });
      mtabHub = null;
    }
    if (app) {
      try { await app.close(); } catch { /* 已处理 */ }
      app = null;
    }
    if (mtabApp) {
      // 多标签实例可能仍存活（场景中断），强杀防残留
      try { mtabApp.process().kill('SIGKILL'); } catch { /* 已退出 */ }
      mtabApp = null;
    }
    if (restoreHub) {
      await restoreHub.dispose().catch(() => { /* 会话已随应用退出 */ });
      restoreHub = null;
    }
    if (restoreApp) {
      // 恢复实例可能仍存活（场景中断），强杀防残留
      try { restoreApp.process().kill('SIGKILL'); } catch { /* 已退出 */ }
      restoreApp = null;
    }
    if (unrelated) {
      // 无关实例完成自证后即清理，退出路径（含失败/异常）都不留残留进程
      unrelated.kill();
      unrelated = null;
    }

    if (qaRoot) {
      const report = {
        runId,
        status: outcome,
        qaRoot,
        kind: 'desktop-e2e-full',
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        app: ready ? { servicePid: ready.servicePid, mainPid: ready.mainPid, port: ready.port, baseUrl } : null,
        csp: cspSummary,
        summary: summary(),
        results
      };
      const reportPath = path.join(qaRoot, 'artifacts', 'report.json');
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`\n[qa-desktop-full] 结果: ${outcome}（通过 ${summary().passed} / 失败 ${summary().failed} / 跳过 ${summary().skipped}）`);
      if (outcome === 'passed' && !keep) {
        await fs.rm(qaRoot, { recursive: true, force: true });
        console.log('[qa-desktop-full] qa-root 已清理');
      } else {
        console.log(`[qa-desktop-full] qa-root 已保留: ${qaRoot}`);
        console.log('[qa-desktop-full] 视觉基线截图位于其 artifacts/ 目录（g4-*.png）');
      }
      process.exitCode = outcome === 'passed' ? 0 : 1;
    } else {
      console.error(`\n[qa-desktop-full] 结果: ${outcome}（qa-root 尚未创建）`);
      process.exitCode = 1;
    }
  }
}

process.on('unhandledRejection', (err) => {
  console.error(`[qa-desktop-full] 未捕获的异步错误: ${err?.message || err}`);
  process.exitCode = 1;
});

// 仅在直接执行本脚本时启动；被 import 时保持零副作用
const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main();
}
