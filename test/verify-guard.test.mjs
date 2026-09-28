import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 引入即校验「零副作用」：verify 脚本被单测 import 时不得启动 main（不发请求、不退出进程）
import { parseArgs, printUsage, validateInvocation } from '../scripts/verify-mr-branch-diff.mjs';

/** 在 /tmp 下创建一次性目录，测试结束自动清理 */
async function makeTempRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('verify 脚本：导出 parseArgs/validateInvocation/printUsage 且 import 无副作用', () => {
  assert.equal(typeof parseArgs, 'function');
  assert.equal(typeof validateInvocation, 'function');
  assert.equal(typeof printUsage, 'function');
});

test('verify 脚本：parseArgs 解析四个参数并默认 stage=full', () => {
  const args = parseArgs(['--base-url', 'http://127.0.0.1:9530', '--config-dir', '/tmp/cfg', '--run-id', 'qa-1', '--stage', 'mr']);
  assert.deepEqual(args, { stage: 'mr', baseUrl: 'http://127.0.0.1:9530', configDir: '/tmp/cfg', runId: 'qa-1' });
  assert.equal(parseArgs([]).stage, 'full');
  assert.throws(() => parseArgs(['--no-such-flag']), /未知参数/);
});

test('verify 脚本：缺少 --run-id 时 fail-closed 拒绝', async () => {
  const configDir = await makeTempRoot('verify-guard-no-runid-');
  try {
    await assert.rejects(
      () => validateInvocation({ baseUrl: 'http://127.0.0.1:9530', configDir }),
      /--run-id/
    );
  } finally {
    await fs.rm(configDir, { recursive: true, force: true });
  }
});

test('verify 脚本：缺少 --config-dir 时 fail-closed 拒绝（不再允许缺省）', async () => {
  await assert.rejects(
    () => validateInvocation({ baseUrl: 'http://127.0.0.1:9530', runId: 'qa-1' }),
    /--config-dir/
  );
});

test('verify 脚本：缺少 --base-url 时 fail-closed 拒绝', async () => {
  await assert.rejects(
    () => validateInvocation({ runId: 'qa-1', configDir: os.tmpdir() }),
    /--base-url/
  );
});

test('verify 脚本：拒绝保留端口 9527 与非环回主机', async () => {
  const configDir = await makeTempRoot('verify-guard-url-');
  try {
    await assert.rejects(
      () => validateInvocation({ baseUrl: 'http://127.0.0.1:9527', configDir, runId: 'qa-1' }),
      /9527/
    );
    await assert.rejects(
      () => validateInvocation({ baseUrl: 'http://localhost:9530', configDir, runId: 'qa-1' }),
      /127\.0\.0\.1/
    );
    // 带路径与尾斜杠同样拒绝
    await assert.rejects(
      () => validateInvocation({ baseUrl: 'http://127.0.0.1:9530/api', configDir, runId: 'qa-1' }),
      /路径/
    );
    await assert.rejects(
      () => validateInvocation({ baseUrl: 'http://127.0.0.1:9530/', configDir, runId: 'qa-1' }),
      /白名单/
    );
  } finally {
    await fs.rm(configDir, { recursive: true, force: true });
  }
});

test('verify 脚本：拒绝相对路径、不存在的 config-dir', async () => {
  await assert.rejects(
    () => validateInvocation({ baseUrl: 'http://127.0.0.1:9530', configDir: 'relative/dir', runId: 'qa-1' }),
    /绝对路径/
  );
  await assert.rejects(
    () => validateInvocation({ baseUrl: 'http://127.0.0.1:9530', configDir: '/tmp/verify-guard-no-such-dir-xyz', runId: 'qa-1' }),
    /不存在/
  );
});

test('verify 脚本：拒绝位于真实配置目录（$HOME/.config/git-lens-web）下的 config-dir', async () => {
  // 注入假 home 构造「真实配置路径样本」，不读写本机真实配置
  const fakeHome = await makeTempRoot('verify-guard-fake-home-');
  const realConfig = path.join(fakeHome, '.config', 'git-lens-web');
  await fs.mkdir(realConfig, { recursive: true });
  const other = await makeTempRoot('verify-guard-valid-cfg-');
  try {
    await assert.rejects(
      () => validateInvocation({ baseUrl: 'http://127.0.0.1:9530', configDir: realConfig, runId: 'qa-1' }, { home: fakeHome }),
      /git-lens-web/
    );
    await assert.rejects(
      () => validateInvocation({ baseUrl: 'http://127.0.0.1:9530', configDir: path.join(realConfig, 'sub'), runId: 'qa-1' }, { home: fakeHome }),
      /git-lens-web/
    );
  } finally {
    await fs.rm(fakeHome, { recursive: true, force: true });
    await fs.rm(other, { recursive: true, force: true });
  }
});

test('verify 脚本：合法调用返回规范化 baseUrl 与 realpath 后的 configDir', async () => {
  const configDir = await makeTempRoot('verify-guard-valid-');
  try {
    const result = await validateInvocation(
      { baseUrl: 'http://127.0.0.1:9530', configDir, runId: 'qa-run-42', stage: 'compat' }
    );
    assert.equal(result.baseUrl, 'http://127.0.0.1:9530');
    assert.equal(result.configDir, await fs.realpath(configDir));
    assert.equal(result.runId, 'qa-run-42');
    assert.equal(result.stage, 'compat');
    // configDir 经 realpath 校验且不在真实配置之下（macOS /tmp 是 /private/tmp 的符号链接）
    assert.ok(path.isAbsolute(result.configDir));
  } finally {
    await fs.rm(configDir, { recursive: true, force: true });
  }
});
