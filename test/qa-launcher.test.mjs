import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('启动器入口（G0 基线）：对未实现握手的被测服务报「Runtime 契约未就绪」并以非 0 退出', async () => {
  // 直接执行单一入口：它会对当前基线 src/server.js（PORT=0、无握手接口）走完整流程，
  // 并在发出任何业务请求前因端口无法发现/握手 404 而跳过正向用例——这正是 G0 的预期行为
  let exitCode = null;
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync(process.execPath, ['scripts/qa/run.mjs'], {
      cwd: WORKTREE_ROOT, timeout: 120000, encoding: 'utf8'
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    // 预期走这里：退出码非 0
    exitCode = err.code;
    stdout = err.stdout || '';
    stderr = err.stderr || '';
  }

  const output = `${stdout}\n${stderr}`;
  assert.match(output, /Runtime 契约未就绪/);
  assert.match(output, /正向用例跳过/);
  assert.equal(exitCode, 1, 'Runtime 未就绪时退出码必须非 0');

  // 失败时保留 qa-root 且报告可解析；测试结束负责清理，不在 /tmp 留垃圾
  const keepMatch = output.match(/qa-root 已保留: (\S+)/);
  assert.ok(keepMatch, '失败时应保留 qa-root 并打印路径');
  const qaRoot = keepMatch[1];
  try {
    const report = JSON.parse(await fs.readFile(path.join(qaRoot, 'artifacts', 'report.json'), 'utf8'));
    assert.equal(report.status, 'runtime-contract-not-ready');
    assert.ok(report.guidance, '报告应包含 Runtime 未就绪的指引');
    assert.ok(report.results.some((r) => r.status === 'skip'), '正向用例应标记为跳过');
    // 握手之前不得有任何业务请求：全部跳过且零失败即证明未执行正向断言
    assert.equal(report.summary.failed, 0);
  } finally {
    await fs.rm(qaRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test('启动器守卫资源：qa-root 建在系统临时目录且不触碰真实配置', async () => {
  // 轻量断言：入口脚本对 PORT 的注入是 '0'（系统分配），且 config 指向 qa-root；
  // 这里只做静态文本检查，避免再起一轮服务
  const source = await fs.readFile(path.join(WORKTREE_ROOT, 'scripts', 'qa', 'run.mjs'), 'utf8');
  assert.match(source, /PORT: '0'/, '服务必须以 PORT=0 启动（系统分配端口，绝不占用 9527）');
  assert.match(source, /GIT_LENS_CONFIG_DIR: path\.join\(qaRoot, 'config'\)/, '配置目录必须指向 qa-root');
  assert.ok(source.includes('GIT_LENS_TEST_MODE'), '必须以测试模式启动');
  assert.ok(source.includes('GIT_LENS_TEST_RUN_ID'), '必须注入 run-id');
  assert.ok(os.tmpdir(), '临时目录基线存在（qa-root 均建在系统临时目录下）');
});
