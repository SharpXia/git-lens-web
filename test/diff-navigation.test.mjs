import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createQaRoot, makeRunId } from '../scripts/qa/fixtures.mjs';
import { performHandshake } from '../scripts/qa/guard.mjs';
import {
  startDesktopApp, openDesktopChannel, readReadyFile, validateReady,
  pollUntil, pollUntilAsync, closeAndVerify,
} from '../scripts/qa/desktop-shared.mjs';

const execFileAsync = promisify(execFile);

/** 在临时仓库内执行 Git，隔离作者配置和可能继承的仓库上下文。 */
async function git(cwd, ...args) {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: '测试用户', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: '测试用户', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  await execFileAsync('git', args, { cwd, env });
}

/** 创建跨文件、跨模式的真实差异，包含长行、中文、HTML 以及二进制文件。 */
async function createFixture(root) {
  const repos = path.join(root, 'repos');
  const repo = path.join(repos, '源码定位');
  const target = path.join(root, 'target');
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  const middle = Array.from({ length: 100 }, (_, i) => `const context${i} = ${i};`).join('\n');
  const before = `const version = 'before';\n${middle}\nconst context = 'LocateToken context';\nconst value = 'LocateToken old';\n`;
  await fs.writeFile(path.join(repo, 'src/m-modified.js'), before);
  await fs.writeFile(path.join(repo, 'src/d-deleted.js'), 'const removed = true;\n');
  await fs.writeFile(path.join(repo, 'src/append.js'), 'const existing = true;\n');
  await fs.writeFile(path.join(repo, 'style.css'), 'body { color: red; }\n');
  await fs.writeFile(path.join(repo, 'README.md'), '# 原说明\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', '创建定位测试基准');
  await git(repo, 'worktree', 'add', '-qb', 'feature/find', target);
  const after = before.replace("'before'", "'committed'").replace('LocateToken old', 'LocateToken new');
  await fs.writeFile(path.join(target, 'src/m-modified.js'), after);
  await fs.writeFile(path.join(target, 'src/append.js'), 'const existing = true;\nconst appended = true;\n');
  await fs.rm(path.join(target, 'src/d-deleted.js'));
  await fs.writeFile(path.join(target, 'src/z-added.js'), [
    "const tokens = 'LocateToken locateToken';",
    "const special = 'a.b[0]* + 中文定位 😀';",
    "const html = '<img src=x onerror=alert(1)>';",
    ...Array.from({ length: 80 }, (_, i) => `const added${i} = ${i};`),
    `const longLine = '${'长行内容 '.repeat(180)}横向定位词';`,
    '',
  ].join('\n'));
  await fs.writeFile(path.join(target, 'style.css'), 'body { color: blue; }\n');
  await fs.writeFile(path.join(target, 'README.md'), '# 新说明\n');
  await fs.writeFile(path.join(target, 'NOTES.TXT'), '说明文件\n');
  await fs.writeFile(path.join(target, 'manual.pdf'), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(target, 'asset.BIN'), Buffer.from([0, 3, 4]));
  await git(target, 'add', '.');
  await git(target, 'commit', '-qm', '添加源码文档与资源变更');
  await fs.writeFile(path.join(target, 'src/m-modified.js'), after.replace("'committed'", "'WorkingOnly'"));
  await fs.writeFile(path.join(target, 'src/a-untracked.js'), "const value = 'LocateToken untracked';\n");
  return { repo, repos, target };
}

test('桌面差异页：原生快捷键、源码定位、模式刷新与文件排序', { timeout: 90000 }, async t => {
  const runId = makeRunId();
  const root = await createQaRoot(runId);
  const artifactDir = process.env.GIT_LENS_DIFF_QA_DIR;
  let app;
  let hub;
  let env;
  let ready;
  let passed = false;
  let failures = 0;
  t.after(async () => {
    await hub?.dispose();
    if (app && ready) {
      const exit = await closeAndVerify({ app, ready, userDataDir: env.GIT_LENS_USER_DATA });
      assert.equal(exit.ok, true, 'App 退出后应释放服务、端口和辅助进程');
    } else {
      await app?.close();
    }
    if (passed && process.env.GIT_LENS_DIFF_KEEP_FIXTURE !== '1') await fs.rm(root, { recursive: true, force: true });
    else console.log(`桌面差异验证现场：${root}`);
  });
  const fixture = await createFixture(root);
  const configDir = path.join(root, 'config');
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ customDirectories: [fixture.repos] }));
  const params = new URLSearchParams({
    repo: fixture.repo, tab: 'diff', diffType: 'ref', diffBaseType: 'branch', base: 'main',
    diffTargetType: 'worktree', target: fixture.target, mode: 'all',
  });
  // 首次启动即恢复目标差异页，覆盖桌面 preload、会话凭据和标签状态恢复链路。
  await fs.writeFile(path.join(root, 'electron-user-data', 'tab-state.json'), JSON.stringify({
    version: 1, activeIndex: 0, tabs: [{ search: `?${params}` }],
  }));
  ({ app, env } = await startDesktopApp({ qaRoot: root, runId }));
  hub = await openDesktopChannel({ env });
  ready = await pollUntil(() => {
    const value = readReadyFile(env.GIT_LENS_E2E_READY_FILE);
    return value?.port > 0 && value.mainPid === app.process().pid ? value : null;
  }, 30000);
  const { baseUrl } = validateReady(ready);
  const token = (await fs.readFile(env.GIT_LENS_E2E_TOKEN_FILE, 'utf8')).trim();
  await performHandshake(baseUrl, { runId, configDir, headers: { 'X-Git-Lens-Session': token } });
  hub.appPrefix = `${baseUrl}/`;
  const [target] = await hub.waitForAppTargets(1);
  const page = await hub.pageFor(target.id, target.url);
  // 自动化只向目标 WebContents 投递输入，避免持续抢占用户当前窗口的系统焦点。
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].blur());
  const errors = [];
  page.on('console', message => {
    if (['error', 'warning', 'warn'].includes(message.type) && !/Electron Security Warning/.test(message.text)) errors.push(message.text);
  });
  await pollUntilAsync(() => page.evaluate(() => !!document.getElementById('diffFindToggle')), 15000);
  const originalLines = await page.evaluate(() => Array.from(document.querySelectorAll('#diffResultsContainer .diff-line'), el => el.textContent));

  async function state() {
    return page.evaluate(() => {
      const input = document.getElementById('diffFindInput');
      const active = document.querySelector('.diff-find-match.active');
      return {
        query: input?.value, focused: document.activeElement === input,
        visible: !!document.getElementById('diffFindPanel') && !document.getElementById('diffFindPanel').hidden,
        status: document.getElementById('diffFindStatus')?.textContent,
        invalid: input?.getAttribute('aria-invalid'),
        nextDisabled: document.querySelector('[data-action="diff-find-next"]')?.disabled,
        matches: document.querySelectorAll('.diff-find-match').length,
        activeText: active?.textContent,
        activeFile: active?.closest('.file-diff-card').querySelector('.file-path').textContent,
      };
    });
  }

  async function expectState(expected) {
    let actual;
    try {
      await pollUntilAsync(async () => {
        actual = await state();
        return Object.entries(expected).every(([key, value]) => actual[key] === value);
      }, 5000, { describe: `桌面查找状态 ${JSON.stringify(expected)}` });
    } catch (error) {
      throw new Error(`${error.message}；实际状态：${JSON.stringify(actual)}`);
    }
  }

  async function click(selector) {
    await page.evaluate(selector => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`缺少控件：${selector}`);
      element.click();
    }, selector);
  }

  // 经 Electron 原生输入链路发送按键，覆盖菜单加速键和 before-input-event 的真实影响。
  async function key(keyCode, modifiers = []) {
    await app.evaluate(({ webContents }, { prefix, keyCode, modifiers }) => {
      const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith(prefix));
      contents.focus();
      contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    }, { prefix: hub.appPrefix, keyCode, modifiers });
  }

  async function fill(query) {
    // 选区直接指向输入框，避免原生菜单全选动作的异步派发影响后续文字输入。
    await page.evaluate(() => {
      const input = document.getElementById('diffFindInput');
      input.focus();
      input.select();
    });
    await key('Backspace');
    await expectState({ query: '' });
    if (query) {
      await app.evaluate(({ webContents }, { prefix, query }) => {
        const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith(prefix));
        return contents.insertText(query);
      }, { prefix: hub.appPrefix, query });
    }
    await expectState({ query });
  }

  async function screenshot(name) {
    if (!artifactDir) return;
    await fs.mkdir(artifactDir, { recursive: true });
    const file = path.join(artifactDir, name);
    // 主窗口是空壳；截图必须来自实际承载 App 页面的 WebContentsView。
    const buffer = await page.screenshot({ path: file });
    assert.ok(buffer.length > 0, '桌面截图不可为空');
  }

  async function check(name, action) {
    await t.test(name, async () => {
      try { await action(); }
      catch (error) { failures += 1; throw error; }
    });
  }

  await check('真实 App 加载并按类别、后缀和状态排序，追加内容仍标记为 Modified', async () => {
    const identity = await page.evaluate(() => ({
      desktop: window.gitLens?.isDesktop, title: document.title,
      runtime: document.getElementById('desktopRuntimeInfo')?.textContent,
      paths: Array.from(document.querySelectorAll('#diffResultsContainer .file-path'), el => el.textContent),
      statuses: Array.from(document.querySelectorAll('#diffResultsContainer .file-status-badge'), el => el.textContent),
      expanded: document.querySelectorAll('.file-diff-card.expanded').length,
    }));
    assert.equal(identity.desktop, true);
    assert.ok(identity.title.includes('差异对比'));
    assert.ok(identity.runtime.includes('Electron'));
    assert.notEqual(ready.port, 9527);
    assert.deepEqual(identity.paths, [
      'style.css', 'src/z-added.js', 'src/append.js', 'src/m-modified.js', 'src/d-deleted.js',
      'src/a-untracked.js', 'README.md', 'manual.pdf', 'NOTES.TXT', 'asset.BIN',
    ]);
    assert.deepEqual(identity.statuses, [
      'MODIFIED', 'ADDED', 'MODIFIED', 'MODIFIED', 'DELETED', 'UNTRACKED', 'MODIFIED', 'ADDED', 'ADDED', 'ADDED',
    ]);
    assert.equal(identity.expanded, 0);
  });

  await check('原生 ⌘F/Ctrl+F 聚焦查找，跨折叠文件循环跳转并清理高亮', async () => {
    await key('F', ['meta']);
    await expectState({ visible: true, focused: true });
    await fill('locatetoken');
    await expectState({ status: '1 / 6', matches: 6, activeText: 'LocateToken', activeFile: 'src/z-added.js' });
    await key('Enter');
    await expectState({ status: '2 / 6' });
    await screenshot('diff-find-app.png');
    await key('Enter', ['shift']);
    await expectState({ status: '1 / 6' });
    await key('Enter', ['shift']);
    await expectState({ status: '6 / 6', activeFile: 'src/a-untracked.js' });
    await click('[data-action="diff-find-next"]');
    await expectState({ status: '1 / 6' });
    await click('[data-action="diff-find-prev"]');
    await expectState({ status: '6 / 6' });
    await key('Escape');
    await expectState({ visible: false, matches: 0 });
    assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('#diffResultsContainer .diff-line'), el => el.textContent)), originalLines);
    await key('F', ['control']);
    await expectState({ visible: true, focused: true, query: 'locatetoken' });
  });

  await check('字面量、中文、表情与 HTML 安全匹配，无匹配时禁用导航', async () => {
    for (const query of ['a.b[0]*', '中文定位', '😀', '<img src=x onerror=alert(1)>', '+']) {
      await fill(query);
      await expectState({ status: '1 / 1', activeText: query });
    }
    assert.equal(await page.evaluate(() => document.querySelectorAll('#diffResultsContainer .diff-line img').length), 0);
    await fill('new file mode');
    await expectState({ status: '无匹配', invalid: 'true', nextDisabled: true });
    await fill('');
    await expectState({ status: '输入关键词', invalid: 'false', matches: 0 });
  });

  await check('长行自动横向定位，命中行位于吸顶工具栏和文件标题下方', async () => {
    await fill('横向定位词');
    await expectState({ status: '1 / 1', focused: true });
    const geometry = await page.evaluate(() => {
      const mark = document.querySelector('.diff-find-match.active');
      return {
        left: mark.getBoundingClientRect().left, right: mark.getBoundingClientRect().right,
        top: mark.getBoundingClientRect().top, width: innerWidth,
        visibleTop: document.querySelector('.diff-tools-bar').getBoundingClientRect().bottom
          + mark.closest('.file-diff-card').querySelector('.file-header').getBoundingClientRect().height,
        scrollLeft: mark.closest('pre').scrollLeft,
      };
    });
    assert.ok(geometry.scrollLeft > 0);
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.width);
    assert.ok(geometry.top >= geometry.visibleTop);
  });

  await check('比较模式切换和刷新重建匹配，切换对象清理关键词', async () => {
    await fill('WorkingOnly');
    await expectState({ status: '1 / 1' });
    await click('[data-action="diff-mode"][data-mode="committed"]');
    await expectState({ query: 'WorkingOnly', status: '无匹配' });
    await click('[data-action="diff-mode"][data-mode="all"]');
    await expectState({ status: '1 / 1' });
    await click('#diffRefreshBtn');
    await pollUntilAsync(() => page.evaluate(() => !document.getElementById('diffRefreshBtn').disabled), 15000);
    await expectState({ query: 'WorkingOnly', status: '1 / 1' });
    await page.evaluate(async target => {
      document.getElementById('diffBaseSelect').value = `worktree:${target}`;
      await fetchAndRenderRefDiff('uncommitted');
    }, fixture.target);
    await expectState({ visible: false });
    await click('#diffFindToggle');
    await expectState({ query: '' });
  });

  await check('调整真实 App 窗口尺寸，并确认弹窗和抽屉内不触发背景查找', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700));
    await fill('locatetoken');
    await key('Enter');
    await expectState({ status: '1 / 1' });
    const layout = await page.evaluate(() => {
      const panel = document.getElementById('diffFindPanel').getBoundingClientRect();
      return { left: panel.left, right: panel.right, width: innerWidth };
    });
    assert.ok(layout.left >= 0 && layout.right <= layout.width);
    await screenshot('diff-find-app-small.png');
    await key('Escape');
    await expectState({ visible: false });
    await click('#scanDirectoryBtn');
    await key('F', ['meta']);
    await expectState({ visible: false });
    await key('Escape');
    await page.evaluate(target => openCommitsDrawer(target, true), fixture.target);
    await key('F', ['meta']);
    await expectState({ visible: false });
    assert.equal(await page.evaluate(() => commitsDrawerState.isOpen), true);
    await key('Escape');
    await click('#tabOverview');
    await key('F', ['meta']);
    await expectState({ visible: false });
    assert.deepEqual(errors, []);
  });

  // 恢复完整比较页，保留现场时可直接供开发 App 手动验收。
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
  await page.evaluate(async ({ repo, target }) => {
    switchTab('diff');
    document.getElementById('diffBaseSelect').value = 'branch:main';
    document.getElementById('diffTargetSelect').value = `worktree:${target}`;
    await fetchAndRenderRefDiff('all', true);
  }, fixture);
  if (artifactDir) {
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, 'preview.json'), JSON.stringify({
      root, repo: fixture.repo, target: fixture.target,
      configDir, userDataDir: env.GIT_LENS_USER_DATA,
    }, null, 2));
  }
  passed = failures === 0;
});
