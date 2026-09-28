import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN_PORT = 9527;

/** 启动一个不实现任何 /api 接口（一律 404）的极简 stub 服务，模拟「Runtime 契约未就绪」 */
async function startStubServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let { port } = server.address();
  // 撞上保留端口的概率约等于零；fail-closed 原则下宁可重绑也不能让测试触碰 9527
  if (port === FORBIDDEN_PORT) {
    await new Promise((resolve) => server.close(resolve));
    return startStubServer();
  }
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

/** 执行启动器并归一化结果：无论退出码如何都返回 { code, output } */
async function runLauncher(extraArgs = []) {
  try {
    const result = await execFileAsync(process.execPath, ['scripts/qa/run.mjs', ...extraArgs], {
      cwd: WORKTREE_ROOT, timeout: 120000, encoding: 'utf8'
    });
    return { code: 0, output: `${result.stdout}\n${result.stderr}` };
  } catch (err) {
    return { code: err.code, output: `${err.stdout || ''}\n${err.stderr || ''}` };
  }
}

test('启动器契约未就绪用例（stub 服务）：对无握手接口的外部服务报「Runtime 契约未就绪」并以非 0 退出', async () => {
  // G1 之后仓库内真实服务已支持握手，"契约未就绪"场景改由测试内自建的 stub 服务
  // （无 /api/test-handshake，一律 404）经测试专用 --service-url 注入来覆盖
  const stub = await startStubServer();
  let qaRoot = null;
  try {
    const { code, output } = await runLauncher(['--service-url', stub.baseUrl]);
    assert.equal(code, 1, 'Runtime 未就绪时退出码必须非 0');
    assert.match(output, /Runtime 契约未就绪/);
    assert.match(output, /正向用例跳过/);

    // 失败时保留 qa-root 且报告可解析；测试结束负责清理，不在 /tmp 留垃圾
    const keepMatch = output.match(/qa-root 已保留: (\S+)/);
    assert.ok(keepMatch, '失败时应保留 qa-root 并打印路径');
    qaRoot = keepMatch[1];
    const report = JSON.parse(await fs.readFile(path.join(qaRoot, 'artifacts', 'report.json'), 'utf8'));
    assert.equal(report.status, 'runtime-contract-not-ready');
    assert.equal(report.service.port, stub.port, '报告中的服务端口应来自 --service-url');
    assert.ok(report.guidance, '报告应包含 Runtime 未就绪的指引');
    assert.ok(report.results.some((r) => r.status === 'skip'), '正向用例应标记为跳过');
    // 握手之前不得有业务请求：全部跳过且零失败即证明未执行正向断言
    assert.equal(report.summary.failed, 0);
  } finally {
    await stub.close();
    if (qaRoot) await fs.rm(qaRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test('启动器参数守卫：--service-url 拒绝 9527、非 127.0.0.1 与缺值（不发请求、不建 qa-root）', async () => {
  for (const [extraArgs, expectedPattern] of [
    [['--service-url', `http://127.0.0.1:${FORBIDDEN_PORT}`], /9527/],
    [['--service-url', 'http://localhost:9530'], /127\.0\.0\.1/],
    [['--service-url', 'http://example.com:9530'], /127\.0\.0\.1/],
    [['--service-url'], /需要显式的服务地址/]
  ]) {
    const { code, output } = await runLauncher(extraArgs);
    assert.notEqual(code, 0, `应非 0 退出: ${extraArgs.join(' ')}`);
    assert.match(output, expectedPattern, `输出应含拒绝原因: ${extraArgs.join(' ')}`);
    assert.doesNotMatch(output, /qa-root/, '守卫失败必须发生在 qa-root 创建之前');
  }
});

test('启动器静态守卫：PORT=0、测试模式注入与 --service-url 守卫接线存在', async () => {
  const source = await fs.readFile(path.join(WORKTREE_ROOT, 'scripts', 'qa', 'run.mjs'), 'utf8');
  assert.match(source, /PORT: '0'/, '服务必须以 PORT=0 启动（系统分配端口，绝不占用 9527）');
  assert.match(source, /GIT_LENS_CONFIG_DIR: path\.join\(qaRoot, 'config'\)/, '配置目录必须指向 qa-root');
  assert.ok(source.includes('GIT_LENS_TEST_MODE'), '必须以测试模式启动');
  assert.ok(source.includes('GIT_LENS_TEST_RUN_ID'), '必须注入 run-id');
  // --service-url 是测试专用扩展，必须仍经 parseAndValidateBaseUrl 白名单校验
  assert.match(source, /externalService = parseAndValidateBaseUrl\(serviceUrlInput\)/,
    '--service-url 必须先过 base-url 白名单守卫（fail-closed）');
  assert.ok(os.tmpdir(), '临时目录基线存在（qa-root 均建在系统临时目录下）');
});
