import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { parseDesktopArgs, buildDesktopEnv, buildDesktopLaunchArgs, findElectronProcesses, scanOrphansWithStableWindow, ELECTRON_MAIN } from '../scripts/qa/desktop-shared.mjs';

const execFileAsync = promisify(execFile);
const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('桌面启动器参数解析：识别 --keep/--strict-csp 并收集未知参数', () => {
  assert.deepEqual(parseDesktopArgs([]), { keep: false, strictCsp: false, unknown: [] });
  assert.deepEqual(parseDesktopArgs(['--keep']), { keep: true, strictCsp: false, unknown: [] });
  assert.deepEqual(parseDesktopArgs(['--strict-csp', '--keep']), { keep: true, strictCsp: true, unknown: [] });
  const parsed = parseDesktopArgs(['--bogus']);
  assert.equal(parsed.unknown[0], '--bogus', '未知参数必须被收集而不是静默忽略');
});

test('桌面启动器环境构造：E2E 钩子、服务配置与 git 隔离全部指向 qa-root', () => {
  const qaRoot = path.join(os.tmpdir(), 'qa-desktop-env-fake');
  const env = buildDesktopEnv({ qaRoot, runId: 'qa-run-7' });

  // 契约 §13 E2E 钩子
  assert.equal(env.GIT_LENS_USER_DATA, path.join(qaRoot, 'electron-user-data'));
  assert.equal(env.GIT_LENS_E2E_READY_FILE, path.join(qaRoot, 'artifacts', 'ready.json'));
  assert.equal(env.GIT_LENS_E2E_TOKEN_FILE, path.join(qaRoot, 'artifacts', 'token.txt'));
  assert.equal(env.GIT_LENS_TEST_MODE, '1');
  assert.equal(env.GIT_LENS_TEST_RUN_ID, 'qa-run-7');

  // 契约 §5：desktop 服务读取 <userData>/git-lens-config；web 语义目录仅留档
  assert.equal(env.GIT_LENS_CONFIG_DIR, path.join(qaRoot, 'config'));

  // git 与 HOME 隔离：绝不指向真实用户目录
  assert.equal(env.HOME, path.join(qaRoot, 'git-home'));
  assert.equal(env.XDG_CONFIG_HOME, path.join(qaRoot, 'git-home'));
  assert.equal(env.GIT_CONFIG_GLOBAL, path.join(qaRoot, 'git-home', 'config'));
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');

  // 关键路径全部位于 qa-root 内（字符串前缀断言；路径构造均由 path.join 保证）
  for (const key of ['GIT_LENS_USER_DATA', 'GIT_LENS_E2E_READY_FILE', 'GIT_LENS_E2E_TOKEN_FILE', 'GIT_LENS_CONFIG_DIR', 'HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL']) {
    assert.ok(env[key].startsWith(qaRoot + path.sep), `${key} 必须位于 qa-root 内: ${env[key]}`);
    assert.ok(path.isAbsolute(env[key]), `${key} 必须是绝对路径`);
  }

  // 危险的 git 上下文变量必须被剥离
  const withGitDir = buildDesktopEnv({ qaRoot, runId: 'r' });
  assert.equal(withGitDir.GIT_DIR, undefined);
});

test('桌面启动器环境构造：suffix 产出独立实例目录（多标签第二实例隔离单实例锁与就绪文件）', () => {
  const qaRoot = path.join(os.tmpdir(), 'qa-desktop-env-fake');
  const env = buildDesktopEnv({ qaRoot, runId: 'qa-run-8', suffix: 'mtab' });

  assert.equal(env.GIT_LENS_USER_DATA, path.join(qaRoot, 'electron-user-data-mtab'), 'userData 带后缀');
  assert.equal(env.GIT_LENS_E2E_READY_FILE, path.join(qaRoot, 'artifacts-mtab', 'ready.json'), '就绪文件独立目录');
  assert.equal(env.GIT_LENS_E2E_TOKEN_FILE, path.join(qaRoot, 'artifacts-mtab', 'token.txt'), '凭据文件独立目录');
  // git 隔离与主实例共用同一 qa-root 内目录（fixture 仓库可直接复用）
  assert.equal(env.HOME, path.join(qaRoot, 'git-home'));
  assert.ok(env.GIT_LENS_USER_DATA.startsWith(qaRoot + path.sep));
});

test('桌面启动器入口：未知参数立即失败且不创建 qa-root', async () => {
  try {
    await execFileAsync(process.execPath, ['scripts/qa/run-desktop.mjs', '--bogus'], {
      cwd: WORKTREE_ROOT, timeout: 30000, encoding: 'utf8'
    });
    assert.fail('未知参数必须非 0 退出');
  } catch (err) {
    assert.notEqual(err.code, 0);
    const output = `${err.stdout || ''}\n${err.stderr || ''}`;
    assert.match(output, /未知参数/);
    assert.doesNotMatch(output, /qa-root:/, '参数校验必须发生在 qa-root 创建之前');
  }
});

test('桌面启动参数：显式携带 --user-data-dir 锚点（DEF-004，供 Chromium 传给全部 helper）', () => {
  const env = buildDesktopEnv({ qaRoot: path.join(os.tmpdir(), 'qa-desktop-env-fake'), runId: 'r' });
  const args = buildDesktopLaunchArgs(env);
  assert.equal(args[0], ELECTRON_MAIN, '首参数必须是被测应用主进程入口');
  assert.ok(args.includes('--remote-debugging-port=0'), '契约 §15 CDP 通道参数必须在位');
  assert.ok(
    args.includes(`--user-data-dir=${env.GIT_LENS_USER_DATA}`),
    '必须显式携带 --user-data-dir=<GIT_LENS_USER_DATA>：只有主进程命令行带该开关，Chromium 才会传给全部 helper'
  );
  // 未注入 userData 时不带锚点参数（不产生悬空路径）
  const bare = buildDesktopLaunchArgs({});
  assert.ok(!bare.some((a) => a.startsWith('--user-data-dir=')), '缺 env 时不得携带锚点参数');
});

test('孤儿进程匹配：scope.userDataDir 必填，缺失即抛错（防止回退到 worktree 级过宽匹配）', async () => {
  await assert.rejects(() => findElectronProcesses(), /userDataDir/, '无锚点调用必须失败');
  await assert.rejects(() => findElectronProcesses({}), /userDataDir/, '空 scope 调用必须失败');
});

test('孤儿进程匹配：锚点目录无对应进程时对真实 ps 返回空集', async () => {
  const unrelatedDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'qa-orphan-scope-'));
  try {
    const hits = await findElectronProcesses({ userDataDir: unrelatedDir });
    assert.deepEqual(hits, [], '无 Electron 进程携带该 userData 锚点时应返回空集');
  } finally {
    await fs.promises.rm(unrelatedDir, { recursive: true, force: true });
  }
});

test('孤儿稳定窗口：数量归零立即判定，不等待窗口超时（DEF-004 拆除竞态主路径）', async () => {
  const sequence = [['p1 helper', 'p2 helper'], []];
  let calls = 0;
  const result = await scanOrphansWithStableWindow(async () => sequence[Math.min(calls++, sequence.length - 1)], {
    intervalMs: 5, timeoutMs: 2000, stableConfirmations: 3
  });
  assert.equal(result.stable, true);
  assert.deepEqual(result.orphans, [], '归零即无孤儿，不得把拆除中的 helper 计为孤儿');
  assert.equal(result.scans, 2, '归零应在第二次扫描立即返回');
});

test('孤儿稳定窗口：连续持平达到确认次数才判定收敛（真实泄漏路径）', async () => {
  const lines = ['p1', 'p2'];
  let calls = 0;
  const result = await scanOrphansWithStableWindow(async () => lines, {
    intervalMs: 5, timeoutMs: 2000, stableConfirmations: 3
  });
  assert.equal(result.stable, true);
  assert.equal(result.orphans.length, 2, '孤儿数 = 稳定窗口结束后的数值');
  assert.equal(result.scans, 4, '第 2/3/4 次扫描构成连续 3 次持平后判定');
});

test('孤儿稳定窗口：数量仍在下降/上升时重置稳定计数，继续等待收敛', async () => {
  const sequence = [
    ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'],
    ['a1', 'a2', 'a3', 'a4', 'a5'],
    ['a1', 'a2'],
    ['a1', 'a2', 'a3'], // 上升：拆除未完成（或新 helper 出现），必须重置
    ['a1', 'a2', 'a3'],
    ['a1', 'a2', 'a3']
  ];
  let calls = 0;
  const result = await scanOrphansWithStableWindow(async () => sequence[calls++] || sequence[sequence.length - 1], {
    intervalMs: 5, timeoutMs: 2000, stableConfirmations: 3
  });
  assert.equal(result.stable, true);
  assert.deepEqual(result.orphans, ['a1', 'a2', 'a3']);
  assert.equal(result.scans, 7, '前 4 次数量持续变化重置计数，第 5/6/7 次构成连续 3 次持平');
});

test('孤儿稳定窗口：数量持续波动超时仍未收敛时按当前扫描结果截断（stable=false，交由强杀兜底）', async () => {
  let calls = 0;
  const result = await scanOrphansWithStableWindow(async () => (calls++ % 2 === 0 ? ['osc1', 'osc2'] : ['osc1']), {
    intervalMs: 5, timeoutMs: 40, stableConfirmations: 3
  });
  assert.equal(result.stable, false, '数量反复变化永不满足持平确认 → 超时截断');
  assert.ok(result.scans >= 2, '超时截断前应完成多轮扫描');
});
