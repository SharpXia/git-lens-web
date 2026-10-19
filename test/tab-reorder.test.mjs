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
  const consoleErrors = [];
  let passed = false;
  const archivePath = path.join(qaRoot, 'electron-user-data', 'tab-state.json');
  // 用不同查询串标识页面，避免标题相同时把项目身份与标签位置混淆。
  const searches = [fixture.main.repo, fixture.chinese.repo, fixture.mr.repo]
    .map((repo) => `?${new URLSearchParams({ repo })}`);
  await fs.writeFile(archivePath, JSON.stringify({ version: 1, activeIndex: 1, tabs: searches.map((search) => ({ search })) }));

  async function launch() {
    // 指定测试包时直接验证产物，仍沿用独立配置与就绪文件，避免触碰日常实例。
    const packagedExecutable = process.env.GIT_LENS_TEST_APP;
    const packagedEnv = { ...buildDesktopEnv({ qaRoot, runId }), GIT_LENS_DESKTOP_PREFERRED_PORT: process.env.GIT_LENS_TEST_PORT || '0' };
    const started = packagedExecutable ? {
      app: await _electron.launch({
        executablePath: packagedExecutable,
        args: ['--remote-debugging-port=0', `--user-data-dir=${packagedEnv.GIT_LENS_USER_DATA}`],
        env: packagedEnv,
      }),
      env: packagedEnv,
    } : await startDesktopApp({ qaRoot, runId, env: packagedEnv });
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
    bar.on('console', (entry) => { if (entry.type === 'error') consoleErrors.push(entry.text); });
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

  // 经 Chromium 输入通道产生可信指针事件，实际验证捕获、兼容 click 与跨元素松手。
  async function mouse(type, x, y, down = false) {
    if (type === 'mouseDown') {
      await app.evaluate(({ webContents }) => webContents.getAllWebContents()
        .find(item => item.getURL().includes('/tabbar.html')).focus());
      await pollUntilAsync(() => bar.evaluate(() => document.hasFocus()), 5000);
    }
    await app.evaluate(({ webContents }, input) => {
      const contents = webContents.getAllWebContents().find((item) => item.getURL().includes('/tabbar.html'));
      contents.sendInputEvent(input);
    }, { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: down ? ['leftbuttondown'] : [] });
    await bar.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  }

  async function startDrag(from) {
    const point = await bar.evaluate((from) => {
      const source = document.querySelectorAll('.tab')[from];
      source.scrollIntoView({ inline: 'nearest' });
      const rect = source.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, from);
    await mouse('mouseMove', point.x, point.y);
    await mouse('mouseDown', point.x, point.y, true);
    await mouse('mouseMove', point.x + 8, point.y, true);
    return point;
  }

  // target 为下标、#tabs 空白区（null）或栏内控件 id，覆盖整条栏的落位语义。
  async function drag(from, target, side = 'left', cancel = false) {
    await startDrag(from);
    const point = await bar.evaluate(({ target, side }) => {
      document.getElementById('tabs').scrollLeft = 0;
      const dest = target === null ? document.getElementById('tabs')
        : typeof target === 'string' ? document.getElementById(target)
          : document.querySelectorAll('.tab')[target];
      const rect = dest.getBoundingClientRect();
      return { x: side === 'left' ? rect.left + 2 : rect.right - 2, y: rect.top + rect.height / 2 };
    }, { target, side });
    await mouse('mouseMove', point.x, point.y, true);
    const indicatorVisible = await bar.evaluate(() => !document.getElementById('drop-indicator').hidden);
    if (cancel) await bar.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await mouse('mouseUp', point.x, point.y);
    const cleaned = await bar.evaluate(() => document.getElementById('drop-indicator').hidden && !document.body.classList.contains('tab-dragging') && pointerDrag === null && !document.getElementById('drag-preview'));
    return { indicatorVisible, cleaned };
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
      page.on('console', (entry) => { if (entry.type === 'error') consoleErrors.push(entry.text); });
      await page.evaluate((value) => { window.tabReorderMarker = value; sessionStorage.setItem('tabReorderMarker', value); }, search);
      return page;
    }));

    await t.test('页面身份、首屏内容与标签栏可用', async () => {
      assert.equal(await bar.title(), 'Git Lens 标签条');
      assert.equal(await bar.evaluate(() => document.querySelectorAll('[role="tab"]').length), 3);
      const identity = await pages[0].evaluate(() => ({
        url: location.href, title: document.title, text: document.body.innerText,
        overlay: Boolean(document.querySelector('vite-error-overlay, nextjs-portal')),
      }));
      assert.ok(identity.url.startsWith(hub.appPrefix));
      assert.ok(identity.title.includes('Git Lens'));
      assert.ok(identity.text.includes('仓库'));
      assert.equal(identity.overlay, false);
    });

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

    await t.test('普通点击和轻微移动仍切换标签，栏外松手取消排序', async () => {
      const point = await bar.evaluate(() => {
        const rect = document.querySelectorAll('.tab')[1].getBoundingClientRect();
        return { x: rect.left + 20, y: rect.top + rect.height / 2 };
      });
      await mouse('mouseDown', point.x, point.y, true);
      await mouse('mouseMove', point.x + 2, point.y, true);
      await mouse('mouseUp', point.x + 2, point.y);
      await expectOrder([b, c, a], c);
      await menu('switch-tab-1');
      await startDrag(2);
      await mouse('mouseMove', point.x, 60, true);
      await mouse('mouseUp', point.x, 60);
      await expectOrder([b, c, a], b);
      assert.equal(await bar.evaluate(() => pointerDrag === null && !document.body.classList.contains('tab-dragging')), true);
    });

    await t.test('取消与原位投放不改变顺序', async () => {
      assert.deepEqual(await drag(2, 0, 'left', true), { indicatorVisible: true, cleaned: true });
      await expectOrder([b, c, a], b);
      await drag(1, 2);
      await expectOrder([b, c, a], b);
    });

    await t.test('半透明标签预览跟随鼠标，移出标签栏仍可见，取消后不遮挡内容', async () => {
      const contentBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children
        .filter(view => view.webContents.getURL().startsWith('http:')).map(view => view.getBounds()));
      const point = await startDrag(2);
      const first = await bar.evaluate(() => {
        const preview = document.getElementById('drag-preview');
        const rect = preview.getBoundingClientRect();
        return { x: rect.x, y: rect.y, title: preview.querySelector('.tab-title').textContent,
          sourceTitle: document.querySelector('.tab.dragging .tab-title').textContent,
          hitTest: getComputedStyle(preview).pointerEvents, tabCount: document.querySelectorAll('[role="tab"]').length };
      });
      assert.equal(first.title, first.sourceTitle);
      assert.equal(first.hitTest, 'none');
      assert.equal(first.tabCount, 3);
      await mouse('mouseMove', point.x + 58, point.y + 80, true);
      const moved = await bar.evaluate(() => {
        const rect = document.getElementById('drag-preview').getBoundingClientRect();
        return { x: rect.x, y: rect.y, height: rect.height, viewportHeight: innerHeight };
      });
      assert.ok(Math.abs(moved.x - first.x - 50) < 2);
      assert.ok(Math.abs(moved.y - first.y - 80) < 2);
      assert.ok(moved.y > 38 && moved.y + moved.height <= moved.viewportHeight);
      assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children
        .filter(view => view.webContents.getURL().startsWith('http:')).map(view => view.getBounds())), contentBounds);
      const image = await app.evaluate(async ({ webContents }) => {
        const contents = webContents.getAllWebContents().find(item => item.getURL().includes('/tabbar.html'));
        return (await contents.capturePage({ x: 0, y: 0, width: 900, height: 180 })).toDataURL();
      });
      await fs.writeFile('/tmp/git-lens-tab-drag-preview.png', Buffer.from(image.split(',')[1], 'base64'));
      await bar.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await mouse('mouseUp', point.x + 58, point.y + 80);
      await expectOrder([b, c, a], b);
      assert.equal(await bar.evaluate(() => document.getElementById('drag-preview')), null);
      assert.equal(await app.evaluate(({ webContents, BrowserWindow }) => {
        const contents = webContents.getAllWebContents().find(item => item.getURL().includes('/tabbar.html'));
        return BrowserWindow.getAllWindows()[0].contentView.children.find(view => view.webContents === contents).getBounds().height;
      }), 38);
    });

    await t.test('指针取消、丢失捕获和窗口失焦均结束排序，后续仍可继续拖动', async () => {
      for (const reason of ['pointercancel', 'lostpointercapture', 'blur']) {
        const point = await startDrag(2);
        await bar.evaluate((reason) => {
          if (reason === 'blur') window.dispatchEvent(new Event('blur'));
          else if (reason === 'lostpointercapture') pointerDrag.item.releasePointerCapture(pointerDrag.id);
          else pointerDrag.item.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: pointerDrag.id }));
        }, reason);
        await mouse('mouseUp', point.x, point.y);
        await expectOrder([b, c, a], b);
        assert.equal(await bar.evaluate(() => pointerDrag === null && document.getElementById('drop-indicator').hidden && !document.getElementById('drag-preview')), true);
      }
    });

    await t.test('整条标签栏都是投放区：栏内空白松手按插入线落位（1.1.2 修复）', async () => {
      // 「+」上松手只排序，不触发兼容 click 新建标签。
      assert.deepEqual(await drag(0, 'new-tab'), { indicatorVisible: true, cleaned: true });
      await expectOrder([c, a, b], b);
      // 末标签拖回 darwin 红绿灯安全区（#bar 左侧留白）：按首位语义落位复原。
      assert.deepEqual(await drag(2, 'bar', 'left'), { indicatorVisible: true, cleaned: true });
      await expectOrder([b, c, a], b);
    });

    await t.test('全屏排序只处理指针，不启动原生拖放；退出全屏恢复标题栏拖动区', async () => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
      try {
        await pollUntilAsync(() => bar.evaluate(() => document.body.classList.contains('fullscreen')), 15000);
        const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
        assert.equal(await bar.evaluate(() => getComputedStyle(document.getElementById('bar')).webkitAppRegion), 'no-drag');
        await bar.evaluate(() => {
          window.nativeDragStartsForTest = 0;
          document.addEventListener('dragstart', () => window.nativeDragStartsForTest++);
        });
        assert.equal(await bar.evaluate(() => [...document.querySelectorAll('.tab')].every((item) => !item.draggable)), true);
        const point = await startDrag(2);
        await mouse('mouseMove', point.x - 50, point.y + 60, true);
        assert.equal(await bar.evaluate(() => document.getElementById('drag-preview').getBoundingClientRect().y > 38), true);
        await bar.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        await mouse('mouseUp', point.x - 50, point.y + 60);
        await drag(2, 0);
        await expectOrder([a, b, c], b);
        await drag(0, null, 'right');
        await expectOrder([b, c, a], b);
        assert.equal(await bar.evaluate(() => window.nativeDragStartsForTest), 0);
        assert.deepEqual(await app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          return { fullscreen: win.isFullScreen(), bounds: win.getBounds() };
        }), { fullscreen: true, bounds });
        await bar.screenshot({ path: '/tmp/git-lens-tab-fullscreen.png' });
        await pages[1].screenshot({ path: '/tmp/git-lens-tab-fullscreen-content.png' });
      } finally {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false));
        await pollUntilAsync(() => bar.evaluate(() => !document.body.classList.contains('fullscreen')), 15000);
      }
      assert.equal(await bar.evaluate(() => getComputedStyle(document.getElementById('bar')).webkitAppRegion), 'drag');
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
        ipcMain.emit('git-lens-tabbar:drag-state', { sender: content }, true);
      });
      await expectOrder([b, c, a], a);
      assert.equal(await bar.evaluate(() => innerHeight), 38);
      assert.equal(await bar.evaluate(() => {
        try { window.gitLensTabbar.setDragging('true'); return false; } catch { return true; }
      }), true);
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
      const point = await startDrag(0);
      await bar.evaluate(() => { window.dragSourceForTest = document.querySelector('.tab'); });
      const [target] = await hub.listAppTargets();
      const page = await hub.pageFor(target.id);
      await page.evaluate(() => { document.title = '拖动期间更新标题'; });
      await pollUntilAsync(() => bar.evaluate(() => Boolean(pendingState)), 5000);
      assert.equal(await bar.evaluate(() => window.dragSourceForTest.isConnected), true);
      await bar.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await mouse('mouseUp', point.x, point.y);
      assert.equal(await bar.evaluate(() => document.getElementById('tabs').textContent.includes('拖动期间更新标题')), true);
    });

    await t.test('溢出标签自动滚动；第十个标签移到首位后 ⌘0 跟随新位置', async () => {
      for (let count = 4; count <= 10; count++) {
        await bar.evaluate(() => window.gitLensTabbar.newTab());
        await pollUntilAsync(async () => (await snapshot()).ids.length === count, 5000);
      }
      const point = await startDrag(0);
      const edge = await bar.evaluate(() => {
        const tabs = document.getElementById('tabs');
        tabs.style.maxWidth = '360px';
        tabs.scrollLeft = 0;
        return tabs.getBoundingClientRect().right - 2;
      });
      await mouse('mouseMove', edge, point.y, true);
      await pollUntilAsync(() => bar.evaluate(() => document.getElementById('tabs').scrollLeft > 50), 5000);
      await bar.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await mouse('mouseUp', edge, point.y);
      await drag(9, 0);
      const ids = [10, 1, 2, 3, 4, 5, 6, 7, 8, 9];
      await expectOrder(ids, 10);
      await menu('switch-tab-0');
      await expectOrder(ids, 9);
      await menu('switch-tab-1');
      await expectOrder(ids, 10);
      const close = await bar.evaluate(() => {
        const rect = document.querySelector('.tab-close').getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await mouse('mouseDown', close.x, close.y, true);
      await mouse('mouseUp', close.x, close.y);
      await expectOrder(ids.slice(1), 1);
    });
    assert.deepEqual(consoleErrors, [], '标签栏与内容页不应出现控制台错误');
    passed = true;
  } finally {
    if (hub) await hub.dispose();
    if (app) await closeAndVerify({ app, ready, userDataDir: env.GIT_LENS_USER_DATA });
    if (passed) await fs.rm(qaRoot, { recursive: true, force: true });
    else console.error(`标签拖拽测试现场保留：${qaRoot}`);
  }
});
