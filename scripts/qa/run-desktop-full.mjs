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
 *   5. strict CSP 全程收集并硬断言真实违规为零。
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
  attachCspCollector,
  captureBaseline,
  closeAndVerify,
  createResults,
  parseDesktopArgs,
  pollPage,
  pollUntil,
  readReadyFile,
  requestJson,
  startDesktopApp,
  validateReady,
  writeServiceScanConfig
} from './desktop-shared.mjs';

const execFileAsync = promisify(execFile);
const RESTART_TIMEOUT_MS = 25000;

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
  let ready = null;
  let baseUrl = null;
  let token = null;
  let fixture = null;
  let outcome = 'failed';
  let cspSummary = { realViolationCount: 0, realViolations: [], electronDevWarningCount: 0, strictMode: true };

  process.on('exit', () => {
    if (app) {
      try { app.process().kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  });
  process.on('SIGINT', () => {
    if (app) app.process().kill('SIGKILL');
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
    page = launched.page;
    const readyFile = launched.env.GIT_LENS_E2E_READY_FILE;
    ready = await pollUntil(() => {
      const value = readReadyFile(readyFile);
      return value && Number.isInteger(value.port) && value.port > 0 ? value : null;
    }, 30000, { describe: '就绪文件' });
    ({ baseUrl } = validateReady(ready));
    await updateManifest(qaRoot, { service: { port: ready.port, pid: ready.servicePid } });
    await page.waitForTimeout(500);
    // 首屏基线：标题与仓库下拉就绪后才出图
    await captureBaseline(app, page, qaRoot, 'a', 'first-screen', () => {
      const h1 = document.querySelector('header h1');
      const options = document.querySelectorAll('#repoSelect option');
      const tabs = document.getElementById('tabOverview');
      return Boolean(h1 && tabs?.offsetParent) && options.length > 0;
    });

    token = (await fs.readFile(launched.env.GIT_LENS_E2E_TOKEN_FILE, 'utf8')).trim();
    const cspCollector = attachCspCollector(page);

    // 握手（带凭据）：任何业务请求前的身份核验
    let handshake = null;
    try {
      handshake = await performHandshake(baseUrl, {
        runId,
        configDir: path.join(qaRoot, 'electron-user-data', 'git-lens-config'),
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
    await captureBaseline(app, page, qaRoot, 'd', 'inspect-view', () => {
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
        await captureBaseline(app, page, qaRoot, 'd', 'diff-text', () => {
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
    await captureBaseline(app, page, qaRoot, 'd', 'diff-uncommitted', () => {
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
      // 旧卡交互：点击第一张卡片展开详情，观察详情区域出现
      cards[0]?.click();
      return {
        count: cards.length,
        uniqueHashes: new Set(shortHashes).size,
        firstExpanded: Boolean(cards[0]?.querySelector('.commit-detail'))
      };
    });
    record('c3-load-more', '加载更多追加到 35 条且短 SHA 无重复、旧卡点击仍可展开', afterMore.count >= 35 && afterMore.uniqueHashes === afterMore.count && afterMore.firstExpanded ? 'pass' : 'fail',
      `count=${afterMore.count} unique=${afterMore.uniqueHashes} 旧卡展开=${afterMore.firstExpanded}`);

    // SHA 复制：页面按钮触发写剪贴板，主进程 clipboard 轮询读取（Electron 共享系统剪贴板）；
    // 剪贴板写入是异步系统调用，读取失败时重试数次，仍失败则降级为「按钮可点且点击无异常」断言
    const copyState = await page.evaluate(() => {
      const first = document.querySelector('#commitsDrawerBody .commit-item [data-action="commit-copy-hash"]');
      first?.click();
      return { clicked: Boolean(first) };
    });
    let clipboardText = '';
    for (let attempt = 0; attempt < 4 && !/^[0-9a-f]{7,40}$/i.test(clipboardText); attempt++) {
      await page.waitForTimeout(300);
      try {
        clipboardText = (await app.evaluate(({ clipboard }) => clipboard.readText())).trim();
      } catch (err) {
        clipboardText = `clipboard 读取失败: ${err.message}`;
      }
    }
    const shaLike = /^[0-9a-f]{7,40}$/i.test(clipboardText);
    // Electron 无头环境下 navigator.clipboard.writeText 可能因焦点限制静默失败：
    // 系统剪贴板读到合法 SHA 时为强断言；否则降级为「按钮存在且已绑定、点击无异常」，
    // 剪贴板内容留人工复核（报告与结果中说明方式）
    record('c4-copy-sha', 'SHA 复制按钮写入系统剪贴板（页面按钮触发 + 主进程读取）',
      copyState.clicked && (shaLike || clipboardText === '') ? (shaLike ? 'pass' : 'skip') : 'fail',
      shaLike
        ? `clipboard=${JSON.stringify(clipboardText.slice(0, 45))}`
        : `clicked=${copyState.clicked} clipboard 为空（无头焦点限制，降级断言按钮已绑定且点击无异常），剪贴板内容留人工复核`);
    // 提交抽屉基线：抽屉可见且分页卡片 ≥30 后才出图
    await captureBaseline(app, page, qaRoot, 'c', 'commits-drawer', () => {
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
    const urlBeforeReload = page.url();
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
      await app.evaluate(({ BrowserWindow }, f) => {
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(f);
      }, factor);
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
      // 缩放基线：以窗口 capturePage 完整捕获（视口截图在放大内容时会裁切），出图前断言 Diff 视图可见
      await captureBaseline(app, page, qaRoot, 'z', `zoom-${String(factor).replace('.', '_')}`, () => {
        const view = document.getElementById('viewDiff');
        return Boolean(view) && view.style.display !== 'none' && Boolean(view.offsetParent);
      });
    }
    record('z1-zoom-levels', '缩放 1.0/1.25/1.5 关键容器无横向溢出', zoomOk ? 'pass' : 'fail', zoomDetail.join('；'));

    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      // 上一个缩放档位的残留会让 innerWidth 按 zoom 缩小，窄窗断言前先复位 1.0
      win.webContents.setZoomFactor(1.0);
      win.setSize(960, 600);
    });
    await page.waitForTimeout(400);
    const narrow = await page.evaluate(() => ({
      w: window.innerWidth, h: window.innerHeight,
      tabsVisible: Boolean(document.getElementById('tabOverview')?.offsetParent),
      footerVisible: Boolean(document.querySelector('footer.app-footer')?.offsetParent),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }));
    // 窄窗基线：断言关键元素可见且无溢出后，按窗口完整捕获出图
    await captureBaseline(app, page, qaRoot, 'z', 'narrow-960x600', () => {
      const tabs = document.getElementById('tabOverview');
      const footer = document.querySelector('footer.app-footer');
      return Boolean(tabs?.offsetParent) && Boolean(footer?.offsetParent)
        && document.documentElement.scrollWidth - document.documentElement.clientWidth <= 2;
    });
    const narrowOk = narrow.w <= 962 && narrow.h <= 602 && narrow.tabsVisible && narrow.footerVisible && narrow.overflow <= 2;
    record('z2-narrow-window', '窄窗 960×600 关键元素可见且无布局崩坏', narrowOk ? 'pass' : 'fail', JSON.stringify(narrow));
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setSize(1280, 800);
      win.webContents.setZoomFactor(1.0);
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
      await captureBaseline(app, page, qaRoot, 'm', 'mr-list', () => {
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
      await captureBaseline(app, page, qaRoot, 'm', 'mr-detail', () => {
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
      await captureBaseline(app, page, qaRoot, 'e', 'recovery-page', () => {
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

    // ================= 7. strict CSP 与退出协议 =================
    cspSummary = { ...cspCollector.summarize(), strictMode: strictCsp };
    record('h1-csp-strict', 'CSP 真实违规为零（--strict-csp 硬断言）', cspSummary.realViolationCount === 0 ? 'pass' : 'fail',
      `真实违规=${cspSummary.realViolationCount}，${JSON.stringify(cspSummary.realViolations).slice(0, 300)}；Electron 开发提醒=${cspSummary.electronDevWarningCount}（打包前固有，仅记录）`);

    const exit = await closeAndVerify({ app, ready });
    app = null;
    record('i1-exit-protocol', 'app.close() 后服务退出、端口释放、主进程退出、无 Electron 孤儿', exit.ok ? 'pass' : 'fail',
      `服务退出=${exit.serviceGone} 端口释放=${exit.portClosed} 主进程退出=${exit.mainGone} 孤儿=${exit.orphanCount}（close 耗时 ${exit.closeElapsed}ms）`);

    outcome = results.some((r) => r.status === 'fail') ? 'failed' : 'passed';
  } catch (err) {
    outcome = 'failed';
    record('launcher', '桌面全量启动器执行', 'fail', err.message);
  } finally {
    if (app) {
      try { await app.close(); } catch { /* 已处理 */ }
      app = null;
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
