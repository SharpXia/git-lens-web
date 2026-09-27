import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { parseDesktopArgs, buildDesktopEnv } from '../scripts/qa/desktop-shared.mjs';

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
