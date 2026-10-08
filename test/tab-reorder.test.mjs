import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron } from 'playwright';
import { buildFixtures, createQaRoot, makeRunId } from '../scripts/qa/fixtures.mjs';
import {
  startDesktopApp, openDesktopChannel, readReadyFile, validateReady,
  pollUntil, pollUntilAsync, writeServiceScanConfig, closeAndVerify,
  buildDesktopEnv,
} from '../scripts/qa/desktop-shared.mjs';

test('桌面标签拖拽：插入、取消、位置快捷键、页面状态与重启恢复', { timeout: 120000 }, async (t) => {
  const runId = makeRunId();
  const qaRoot = await createQaRoot(runId);
  const fixture = await buildFixtures(qaRoot);
  await writeServiceScanConfig(qaRoot);
  let app;
  let hub;
  let ready;
  let env;
  let bar;
  let passed = false;
  const archivePath = path.join(qaRoot, 'electron-user-data', 'tab-state.json');
  // 用不同查询串标识页面，避免标题相同时把项目身份与标签位置混淆。
  const searches = [fixture.main.repo, fixture.chinese.repo, fixture.mr.repo]
    .map((repo) => `?${new URLSearchParams({ repo })}`);
  await fs.writeFile(archivePath, JSON.stringify({ version: 1, activeIndex: 1, tabs: searches.map((search) => ({ search })) }));

  async function launch() {
    // 指定测试包时直接验证产物，仍沿用独立配置与就绪文件，避免触碰日常实例。
    const packagedExecutable = process.env.GIT_LENS_TEST_APP;
    const packagedEnv = { ...buildDesktopEnv({ qaRoot, runId }), GIT_LENS_DESKTOP_PREFERRED_PORT: '0' };
    const started = packagedExecutable ? {
      app: await _electron.launch({
        executablePath: packagedExecutable,
        args: ['--remote-debugging-port=0', `--user-data-dir=${packagedEnv.GIT_LENS_USER_DATA}`],
        env: packagedEnv,
      }),
      env: packagedEnv,
    } : await startDesktopApp({ qaRoot, runId });
    app = started.app;
    env = started.env;
    hub = await openDesktopChannel({ env });
    ready = await pollUntil(() => {
      const value = readReadyFile(env.GIT_LENS_E2E_READY_FILE);
      return value?.port > 0 && value.mainPid === app.process().pid ? value : null;
    }, 30000);
    hub.appPrefix = `${validateReady(ready).baseUrl}/`;
    await hub.waitForAppTargets(3, 15000);
    bar = await hub.waitForTabbarReady(15000);
    await pollUntilAsync(async () => (await snapshot()).ids.length === 3, 10000);
  }

  async function snapshot() {
    return bar.evaluate(() => ({
      ids: Array.from(document.querySelectorAll('.tab'), (el) => Number(el.dataset.tabId)),
      active: Number(document.querySelector('.tab.active')?.dataset.tabId),
    }));
  }

  async function expectOrder(ids, active) {
    await pollUntilAsync(async () => JSON.stringify(await snapshot()) === JSON.stringify({ ids, active }), 5000,
      { describe: `标签顺序 ${ids}，激活 ${active}` });
  }

  // 合成标准拖放事件，经过真实标签条、preload、IPC 和主进程，不直接改排序。
  async function drag(from, target, side = 'left', cancel = false) {
    return bar.evaluate(({ from, target, side, cancel }) => {
      const source = document.querySelectorAll('.tab')[from];
      const dest = target === null ? document.getElementById('tabs') : document.querySelectorAll('.tab')[target];
      const rect = dest.getBoundingClientRect();
      const clientX = side === 'left' ? rect.left + 2 : rect.right - 2;
      const dataTransfer = new DataTransfer();
      source.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
      dest.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientX }));
      const indicatorVisible = !document.getElementById('drop-indicator').hidden;
      if (!cancel) dest.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX }));
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
      return { indicatorVisible, cleaned: document.getElementById('drop-indicator').hidden && !document.body.classList.contains('tab-dragging') };
    }, { from, target, side, cancel });
  }

  async function menu(id) {
    await app.evaluate(({ Menu }, menuId) => {
      const item = Menu.getApplicationMenu().getMenuItemById(menuId);
      if (!item) throw new Error(`菜单不存在：${menuId}`);
      item.click();
    }, id);
  }

  try {
    await launch();
    const { ids: [a, b, c] } = await snapshot();
    await expectOrder([a, b, c], b);
    const targets = await hub.listAppTargets();
    const pages = await Promise.all(searches.map(async (search) => {
      const target = targets.find((item) => new URL(item.url).search === search);
      assert.ok(target, `应找到页面 ${search}`);
      const page = await hub.pageFor(target.id);
      await page.evaluate((value) => { window.tabReorderMarker = value; sessionStorage.setItem('tabReorderMarker', value); }, search);
      return page;
    }));

    await t.test('末尾拖到首位、首位拖到末尾和中间插入，激活项目保持', async () => {
      assert.deepEqual(await drag(2, 0), { indicatorVisible: true, cleaned: true });
      await expectOrder([c, a, b], b);
      await drag(0, null, 'right');
      await expectOrder([a, b, c], b);
      await drag(0, 2);
      await expectOrder([b, a, c], b);
      await drag(2, 1);
      await expectOrder([b, c, a], b);
    });

    await t.test('取消与原位投放不改变顺序', async () => {
      assert.deepEqual(await drag(2, 0, 'left', true), { indicatorVisible: true, cleaned: true });
      await expectOrder([b, c, a], b);
      await drag(1, 2);
      await expectOrder([b, c, a], b);
    });

    await t.test('⌘1–⌘3 按重排后的位置切换，页面未重载', async () => {
      for (const [index, id] of [b, c, a].entries()) {
        await menu(`switch-tab-${index + 1}`);
        await expectOrder([b, c, a], id);
      }
      await menu('switch-tab-0');
      await expectOrder([b, c, a], a);
      for (const [index, page] of pages.entries()) {
        assert.deepEqual(await page.evaluate(() => [window.tabReorderMarker, sessionStorage.getItem('tabReorderMarker')]), [searches[index], searches[index]]);
      }
    });

    await t.test('拒绝非法或失效的移动目标', async () => {
      assert.equal(await bar.evaluate(() => {
        try { window.gitLensTabbar.moveTab(1, '2'); return false; } catch { return true; }
      }), true);
      await bar.evaluate(({ a }) => {
        window.gitLensTabbar.moveTab(a, 999999);
        window.gitLensTabbar.moveTab(999999, null);
      }, { a });
      await expectOrder([b, c, a], a);
      await app.evaluate(({ ipcMain, webContents }) => {
        const content = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith('http:'));
        ipcMain.emit('git-lens-tabbar:move-tab', { sender: content }, 1, 2);
      });
      await expectOrder([b, c, a], a);
    });

    await t.test('排序和激活位置防抖保存，重启恢复相同项目顺序', async () => {
      const expectedSearches = [searches[1], searches[2], searches[0]];
      await pollUntilAsync(async () => {
        const archive = JSON.parse(await fs.readFile(archivePath, 'utf8'));
        return archive.activeIndex === 2 && JSON.stringify(archive.tabs.map((item) => item.search)) === JSON.stringify(expectedSearches);
      }, 5000);
      await hub.dispose();
      assert.equal((await closeAndVerify({ app, ready, userDataDir: env.GIT_LENS_USER_DATA })).ok, true);
      app = null;
      await launch();
      await expectOrder([1, 2, 3], 3);
      // 每次点击后从实际可见的 WebContentsView 读取项目，证明恢复的不只是存档文本。
      for (const [index, search] of expectedSearches.entries()) {
        await menu(`switch-tab-${index + 1}`);
        await expectOrder([1, 2, 3], index + 1);
        const actual = await app.evaluate(({ BrowserWindow }) => {
          const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) =>
            child.getVisible() && child.webContents.getURL().startsWith('http:'));
          return new URL(view.webContents.getURL()).search;
        });
        assert.equal(actual, search);
      }
    });

    await t.test('拖动期间收到标题更新仍可继续，取消后显示最新标题', async () => {
      await bar.evaluate(() => {
        const source = document.querySelector('.tab');
        source.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
        window.dragSourceForTest = source;
      });
      const [target] = await hub.listAppTargets();
      const page = await hub.pageFor(target.id);
      await page.evaluate(() => { document.title = '拖动期间更新标题'; });
      await pollUntilAsync(() => bar.evaluate(() => Boolean(pendingState)), 5000);
      assert.equal(await bar.evaluate(() => window.dragSourceForTest.isConnected), true);
      await bar.evaluate(() => {
        window.dragSourceForTest.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      });
      assert.equal(await bar.evaluate(() => document.getElementById('tabs').textContent.includes('拖动期间更新标题')), true);
    });

    await t.test('溢出标签自动滚动；第十个标签移到首位后 ⌘0 跟随新位置', async () => {
      for (let count = 4; count <= 10; count++) {
        await bar.evaluate(() => window.gitLensTabbar.newTab());
        await pollUntilAsync(async () => (await snapshot()).ids.length === count, 5000);
      }
      await bar.evaluate(() => {
        const tabs = document.getElementById('tabs');
        tabs.style.maxWidth = '360px';
        tabs.scrollLeft = 0;
        const source = tabs.firstElementChild;
        const dataTransfer = new DataTransfer();
        source.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
        tabs.dispatchEvent(new DragEvent('dragover', {
          bubbles: true, cancelable: true, dataTransfer, clientX: tabs.getBoundingClientRect().right - 2,
        }));
      });
      await pollUntilAsync(() => bar.evaluate(() => document.getElementById('tabs').scrollLeft > 50), 5000);
      await bar.evaluate(() => document.querySelector('.tab').dispatchEvent(new DragEvent('dragend', { bubbles: true })));
      await drag(9, 0);
      const ids = [10, 1, 2, 3, 4, 5, 6, 7, 8, 9];
      await expectOrder(ids, 10);
      await menu('switch-tab-0');
      await expectOrder(ids, 9);
      await menu('switch-tab-1');
      await expectOrder(ids, 10);
      await bar.evaluate(() => document.querySelector('.tab-close').click());
      await expectOrder(ids.slice(1), 1);
    });
    passed = true;
  } finally {
    if (hub) await hub.dispose();
    if (app) await closeAndVerify({ app, ready, userDataDir: env.GIT_LENS_USER_DATA });
    if (passed) await fs.rm(qaRoot, { recursive: true, force: true });
    else console.error(`标签拖拽测试现场保留：${qaRoot}`);
  }
});
