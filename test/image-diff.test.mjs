import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

import { createGitLensServer } from '../src/git-lens-server.js';

const execFileAsync = promisify(execFile);
const staticRoot = fileURLToPath(new URL('../public/', import.meta.url));
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: '测试用户',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: '测试用户',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  LC_ALL: 'C',
};

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync('git', args, { cwd, env: gitEnv });
  return stdout.trim();
}

async function writeImage(directory, name, width, color = 'red') {
  // 固有宽度区分三个版本，避免仅检查请求成功而漏掉左右两侧实际加载同一张图。
  await fs.writeFile(path.join(directory, name),
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="17"><rect width="100%" height="100%" fill="${color}"/></svg>\n`);
}

async function commitAll(directory, message) {
  await git(directory, 'add', '-A');
  await git(directory, 'commit', '-qm', message);
  return git(directory, 'rev-parse', 'HEAD');
}

async function createFixture(root) {
  const repo = path.join(root, 'repo');
  const target = path.join(root, 'target');
  await fs.mkdir(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'core.quotepath', 'false');
  await writeImage(repo, '修改 图片.svg', 11);
  await writeImage(repo, '工作区删除.svg', 13);
  await writeImage(repo, '提交删除.svg', 19);
  const baseHead = await commitAll(repo, '创建图片基准');
  await git(repo, 'worktree', 'add', '-q', '-b', 'feature/images', target);

  await writeImage(target, '修改 图片.svg', 23, 'blue');
  await writeImage(target, '已提交新增.svg', 61, 'blue');
  await fs.rm(path.join(target, '提交删除.svg'));
  const targetHead = await commitAll(target, '提交目标图片');

  for (const directory of [repo, target]) {
    await writeImage(directory, '修改 图片.svg', 37, 'green');
    await writeImage(directory, '未跟踪 & 新增.svg', 43, 'green');
    await writeImage(directory, '已暂存新增.svg', 53, 'green');
    await git(directory, 'add', '已暂存新增.svg');
    await fs.rm(path.join(directory, '工作区删除.svg'));
  }
  // 目标提交与磁盘内容再分开，确保仅已提交模式确实忽略工作区图片。
  await writeImage(target, '已提交新增.svg', 71, 'green');
  return { repo, target, baseHead, targetHead };
}

async function renderComparison(page, fixture, options) {
  const { repo, target } = fixture;
  const params = {
    path: repo,
    sourceType: 'worktree',
    source: repo,
    targetType: 'worktree',
    target,
    ...options,
  };
  const diff = await page.evaluate(async (params) => {
    const response = await fetch(`/api/diff-refs?${new URLSearchParams(params)}`);
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(`差异接口失败：${JSON.stringify(result)}`);
    currentRepo = params.path;
    activeTab = 'diff';
    document.getElementById('viewOverview').style.display = 'none';
    document.getElementById('viewDiff').style.display = 'block';
    renderDiffView(result.diff);
    toggleAllDiffs(true);
    return result.diff;
  }, params);
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('#diffResultsContainer .image-diff-preview-img')];
    return images.length > 0 && images.every(image => image.complete);
  });
  return diff;
}

async function expectImages(page, responses, filePath, { widths, baseRevision, targetRevision, worktreePath = null }) {
  const images = await page.evaluate((filePath) => {
    const card = [...document.querySelectorAll('#diffResultsContainer .file-diff-card')]
      .find(element => element.querySelector('.file-path')?.textContent === filePath);
    if (!card) throw new Error(`缺少图片差异卡片：${filePath}`);
    return [...card.querySelectorAll('.image-diff-preview-img')].map(image => ({
      url: image.src,
      width: image.naturalWidth,
      imageDisplay: getComputedStyle(image).display,
      placeholderDisplay: getComputedStyle(image.nextElementSibling).display,
    }));
  }, filePath);
  assert.equal(images.length, 2, `${filePath} 应包含左右两张图片`);
  assert.deepEqual(images.map(image => image.width), widths, `${filePath} 应显示对应版本的图片宽度`);
  for (const [index, image] of images.entries()) {
    const url = new URL(image.url);
    assert.equal(url.pathname, '/api/raw-file');
    assert.equal(url.searchParams.get('filePath'), filePath, '图片路径编码应保持完整');
    assert.equal(url.searchParams.get('revision'), index === 0 ? baseRevision : targetRevision);
    assert.equal(url.searchParams.get('worktreePath'), index === 1 ? worktreePath : null);
    const response = responses.findLast(item => item.url === image.url);
    assert.ok(response, `${filePath} 第 ${index + 1} 侧应经过真实图片接口`);
    assert.equal(response.status, widths[index] === 0 ? 404 : 200);
    assert.equal(image.imageDisplay, widths[index] === 0 ? 'none' : 'block');
    assert.equal(image.placeholderDisplay, widths[index] === 0 ? 'block' : 'none');
  }
}

test('图片差异：实际页面按比较模式加载旧图、新图以及新增和删除占位', { timeout: 120000 }, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/git-lens-image-diff-'));
  let instance;
  let browser;
  t.after(async () => {
    await browser?.close();
    await instance?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const fixture = await createFixture(root);
  instance = createGitLensServer({ configDir: path.join(root, 'config'), port: 0, staticRoot });
  const { port } = await instance.ready;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const responses = [];
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/api/raw-file') {
      responses.push({ url: response.url(), status: response.status() });
    }
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForLoadState('networkidle');

  async function expectWorkingImages(baseRevision, modifiedWidth, extras = []) {
    const expected = [
      ['修改 图片.svg', [modifiedWidth, 37]],
      ['未跟踪 & 新增.svg', [0, 43]],
      ['已暂存新增.svg', [0, 53]],
      ['工作区删除.svg', [13, 0]],
      ...extras,
    ];
    for (const [filePath, widths] of expected) {
      await expectImages(page, responses, filePath, {
        widths, baseRevision, targetRevision: 'WORKTREE', worktreePath: fixture.target,
      });
    }
  }

  await t.test('同一工作区自审：修改、新增和删除均显示正确版本', async () => {
    const diff = await renderComparison(page, fixture, { target: fixture.repo, mode: 'uncommitted' });
    assert.equal(diff.isSameWorktree, true);
    assert.equal(diff.source.head, diff.target.head);
    for (const [filePath, widths] of [
      ['修改 图片.svg', [11, 37]],
      ['未跟踪 & 新增.svg', [0, 43]],
      ['已暂存新增.svg', [0, 53]],
      ['工作区删除.svg', [13, 0]],
    ]) {
      await expectImages(page, responses, filePath, {
        widths, baseRevision: fixture.baseHead, targetRevision: 'WORKTREE', worktreePath: fixture.repo,
      });
    }
  });

  await t.test('仅未提交：基准使用目标 HEAD，且新图读取目标工作区', async () => {
    const diff = await renderComparison(page, fixture, { mode: 'uncommitted' });
    assert.notEqual(diff.source.head, diff.target.head);
    assert.equal(diff.baseRevision, fixture.targetHead);
    await expectWorkingImages(fixture.targetHead, 23, [['已提交新增.svg', [61, 71]]]);
  });

  await t.test('全量变更：基准使用共同祖先，且包含已提交和工作区新增图片', async () => {
    const diff = await renderComparison(page, fixture, { mode: 'all' });
    assert.equal(diff.effectiveMode, 'all');
    assert.equal(diff.baseRevision, fixture.baseHead);
    await expectWorkingImages(fixture.baseHead, 11, [
      ['已提交新增.svg', [0, 71]],
      ['提交删除.svg', [19, 0]],
    ]);
  });

  for (const targetType of ['worktree', 'branch']) {
    await t.test(`仅已提交：目标为 ${targetType} 时均忽略磁盘改动`, async () => {
      const diff = await renderComparison(page, fixture, {
        mode: 'committed', targetType, target: targetType === 'branch' ? 'feature/images' : fixture.target,
      });
      assert.equal(diff.effectiveMode, 'committed');
      assert.equal(diff.baseRevision, fixture.baseHead);
      assert.deepEqual(diff.files.map(file => file.filePath).sort(), ['修改 图片.svg', '已提交新增.svg', '提交删除.svg'].sort());
      for (const [filePath, widths] of [
        ['修改 图片.svg', [11, 23]],
        ['已提交新增.svg', [0, 61]],
        ['提交删除.svg', [19, 0]],
      ]) {
        await expectImages(page, responses, filePath, {
          widths, baseRevision: fixture.baseHead, targetRevision: fixture.targetHead,
        });
      }
    });
  }
});
