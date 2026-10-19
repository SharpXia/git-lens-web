import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { discoverGit, buildGitEnvironment } from '../electron/git-environment.js';

const execFileAsync = promisify(execFile);
const cltGit = '/Library/Developer/CommandLineTools/usr/bin/git';
const appleGit = '/usr/bin/git';
const brewGit = '/opt/homebrew/bin/git';

/** 模拟各候选的实际可执行状态，覆盖系统 Git 存在但被许可检查拦截的场景。 */
function probeOptions(candidates, extra = {}) {
  const calls = [];
  return {
    calls,
    options: {
      env: { PATH: '/original/bin', GIT_LENS_TEST_RUN_ID: 'git-probe-test' },
      platform: 'darwin',
      checkAccess: async (candidate) => {
        if (!Object.hasOwn(candidates, candidate)) throw new Error('路径不存在');
      },
      execute: async (candidate, args, options) => {
        calls.push(candidate);
        assert.deepEqual(args, ['--version']);
        assert.equal(options.timeout, 5000);
        const result = candidates[candidate];
        if (result instanceof Error) throw result;
        if (!result) throw new Error('命令不可用');
        return { stdout: result };
      },
      ...extra,
    },
  };
}

test('macOS：系统 Git 被 Xcode 许可检查拦截时改用已安装的 Command Line Tools', async () => {
  const { options, calls } = probeOptions({
    [appleGit]: new Error('You have not agreed to the Xcode license agreements.'),
    [cltGit]: 'git version 2.54.0 (Apple Git-157)\n',
  });
  const result = await discoverGit(options);
  assert.equal(result.found, true);
  assert.equal(result.path, cltGit);
  assert.equal(result.version, 'git version 2.54.0 (Apple Git-157)');
  assert.deepEqual(calls, [appleGit, cltGit]);
});

test('macOS：Homebrew 与系统 Git 可用时保持既有优先级', async () => {
  for (const [candidates, expected] of [
    [{ [brewGit]: 'git version 2.54.0', [appleGit]: 'git version 2.54.0', [cltGit]: 'git version 2.54.0' }, brewGit],
    [{ [appleGit]: 'git version 2.54.0', [cltGit]: 'git version 2.54.0' }, appleGit],
  ]) {
    const { options, calls } = probeOptions(candidates);
    assert.equal((await discoverGit(options)).path, expected);
    assert.deepEqual(calls, [expected]);
  }
});

test('显式配置：路径包含空格时按完整参数探测，失败后保留用户指定路径', async () => {
  const explicit = '/custom git/bin/git';
  for (const available of [true, false]) {
    const { options, calls } = probeOptions({
      [explicit]: available ? 'git version 2.54.0' : new Error('权限不足'),
      [appleGit]: 'git version 2.54.0',
    }, { env: { GIT_LENS_GIT_PATH: explicit } });
    const result = await discoverGit(options);
    assert.equal(result.found, available);
    assert.equal(result.path, explicit);
    assert.equal(result.source, 'GIT_LENS_GIT_PATH 环境变量');
    assert.deepEqual(calls, [explicit]);
  }
});

test('全部候选失败：继续探测 PATH 且不阻断启动', async () => {
  const { options, calls } = probeOptions({ [appleGit]: new Error('许可未确认') });
  const result = await discoverGit(options);
  assert.deepEqual(result, { found: false, path: 'git', version: null, source: 'PATH' });
  assert.deepEqual(calls, [appleGit, 'git']);
});

test('Linux：常见目录不可用时从 PATH 发现 Git，不探测 macOS 路径', async () => {
  const { options, calls } = probeOptions({ git: 'git version 2.54.0' }, { platform: 'linux' });
  const result = await discoverGit(options);
  assert.equal(result.found, true);
  assert.equal(result.source, 'PATH');
  assert.deepEqual(calls, ['git']);
});

test('服务环境：固定已发现的路径，并透传测试及会话配置', async () => {
  const { options } = probeOptions({
    [appleGit]: new Error('许可未确认'),
    [cltGit]: 'git version 2.54.0',
  });
  const result = await discoverGit(options);
  const original = { ...options.env };
  const env = buildGitEnvironment(result, options);
  assert.equal(env.GIT_LENS_GIT_PATH, cltGit);
  assert.equal(env.GIT_LENS_TEST_RUN_ID, original.GIT_LENS_TEST_RUN_ID);
  assert.ok(env.PATH.endsWith(':/original/bin'));
  assert.deepEqual(options.env, original);

  // 真实服务会导入这两个模块；验证它们收到固定路径，避免后台再次走失败的系统入口。
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e',
    'import { getGitPath } from "./src/git-inspector.js";' +
    'import { getGitPath as getMrGitPath } from "./src/merge-request-service.js";' +
    'console.log(JSON.stringify([getGitPath(), getMrGitPath()]));',
  ], { cwd: new URL('..', import.meta.url), env });
  assert.deepEqual(JSON.parse(stdout), [cltGit, cltGit]);
});

test('服务环境：探测失败时保留显式配置，未配置时不伪造可用路径', () => {
  const env = { GIT_LENS_GIT_PATH: '/unavailable/git', PATH: '/original/bin' };
  assert.equal(buildGitEnvironment({ found: false }, { env }).GIT_LENS_GIT_PATH, env.GIT_LENS_GIT_PATH);
  assert.equal(buildGitEnvironment({ found: false }, { env: {} }).GIT_LENS_GIT_PATH, undefined);
});

test('Windows：增补 PATH 使用分号且保留发现的 Git 绝对路径', () => {
  const gitPath = 'C:\\Program Files\\Git\\cmd\\git.exe';
  const env = buildGitEnvironment({ found: true, path: gitPath }, { env: { PATH: 'C:\\Windows' }, platform: 'win32' });
  assert.equal(env.GIT_LENS_GIT_PATH, gitPath);
  assert.ok(env.PATH.endsWith(';C:\\Windows'));
  assert.ok(!env.PATH.includes(cltGit));
});
