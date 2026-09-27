/**
 * git 可执行文件路径注入（契约 §2.3）的测试。
 *
 * 解析优先级必须为：configureGitPath 显式传入 > GIT_LENS_GIT_PATH 环境变量 > 'git'；
 * 默认行为不变（未配置时全部调用走系统 'git'）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { configureGitPath, getGitPath } from '../src/git-inspector.js';
import { configureGitPath as configureMrGitPath, getGitPath as getMrGitPath } from '../src/merge-request-service.js';

const execFileAsync = promisify(execFile);

test('默认解析：未显式配置时使用 GIT_LENS_GIT_PATH 或回退 git', async () => {
  // 测试进程未注入 GIT_LENS_GIT_PATH，模块默认应解析为 'git'，行为与历史版本一致
  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module', '-e',
    'import { getGitPath } from "./src/git-inspector.js"; console.log(getGitPath());'
  ], { cwd: new URL('..', import.meta.url).pathname });
  assert.equal(stdout.trim(), 'git');
});

test('显式注入：configureGitPath 修改两个模块的 git 路径并可恢复', () => {
  const previous = getGitPath();
  const previousMr = getMrGitPath();
  try {
    assert.equal(configureGitPath('/custom/path/to/git'), '/custom/path/to/git');
    assert.equal(getGitPath(), '/custom/path/to/git');
    assert.equal(configureMrGitPath('/custom/path/to/git'), '/custom/path/to/git');
    assert.equal(getMrGitPath(), '/custom/path/to/git');

    // 空值不生效：保持当前配置不变
    assert.equal(configureGitPath(''), '/custom/path/to/git');
    assert.equal(configureGitPath(undefined), '/custom/path/to/git');
  } finally {
    // 恢复默认，避免影响同进程内的其他测试
    configureGitPath(previous);
    configureMrGitPath(previousMr);
  }
  assert.equal(getGitPath(), previous);
  assert.equal(getMrGitPath(), previousMr);
});

test('环境变量注入：子进程设置 GIT_LENS_GIT_PATH 后模块默认值跟随', async () => {
  const repoRoot = new URL('..', import.meta.url).pathname;
  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module', '-e',
    'import { getGitPath } from "./src/git-inspector.js";' +
    ' import { getGitPath as getMrGitPath } from "./src/merge-request-service.js";' +
    ' console.log(getGitPath() + "\\n" + getMrGitPath());'
  ], { cwd: repoRoot, env: { ...process.env, GIT_LENS_GIT_PATH: '/custom/from-env/git' } });
  const [inspectorPath, mrPath] = stdout.trim().split('\n');
  assert.equal(inspectorPath, '/custom/from-env/git');
  assert.equal(mrPath, '/custom/from-env/git');
});
