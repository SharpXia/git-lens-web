import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 正向端到端：对仓库真实服务（PORT=0 + GIT_LENS_TEST_MODE=1 + GIT_LENS_TEST_RUN_ID）
 * 运行单一入口，断言退出码 0、22 项冒烟全过、qa-root 已清理。
 *
 * 本测试独立成文件：整轮包含 fixture 构建与服务全生命周期，耗时明显高于单元测试，
 * 便于需要时单独跳过或单独运行（node --test test/qa-launcher-e2e.test.mjs）。
 */
test('启动器正向端到端：对仓库真实服务跑完整隔离冒烟并全绿清理', async () => {
  let output = '';
  try {
    const result = await execFileAsync(process.execPath, ['scripts/qa/run.mjs'], {
      cwd: WORKTREE_ROOT, timeout: 300000, encoding: 'utf8'
    });
    output = `${result.stdout}\n${result.stderr}`;
  } catch (err) {
    // 失败时尽量清理保留的 qa-root，再把输出带回断言失败信息
    const keepMatch = `${err.stdout || ''}\n${err.stderr || ''}`.match(/qa-root 已保留: (\S+)/);
    if (keepMatch) await fs.rm(keepMatch[1], { recursive: true, force: true }).catch(() => {});
    assert.fail(`启动器应以 0 退出，实际 code=${err.code}\n${err.stdout || ''}\n${err.stderr || ''}`);
  }

  assert.match(output, /结果: passed/);
  // 冒烟套件逐项通过：22 项正向检查、零失败、零跳过（握手未就绪的 skip 不允许出现）
  assert.match(output, /通过 22 \/ 失败 0 \/ 跳过 0/);
  // 关键正向断言抽检：握手三方一致 + WORKTREE 越界读拒绝（DEF-001 修复回归）
  assert.match(output, /✓ \[handshake\] 测试握手 \/api\/test-handshake 三方一致/);
  assert.match(output, /✓ \[raw-file-traversal-worktree\].*返回 4xx/);
  // 成功时 qa-root 必须被清理，不得在 /tmp 留垃圾
  assert.match(output, /qa-root 已清理/);
  assert.doesNotMatch(output, /qa-root 已保留/);
});
