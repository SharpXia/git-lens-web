/**
 * 本地 Merge Request 存储 / 状态机 / Git 合并服务的测试。
 *
 * 全部测试在 /tmp 下用 fs.mkdtemp 自建 fixture 仓库与私有配置目录，
 * 绝不触碰真实仓库与 ~/.config/git-lens-web；测试结束后统一递归清理。
 * 运行方式：node --test test/
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  loadMergeRequests,
  saveMergeRequests,
  getRepoKey,
  getStoreFilePath,
  normalizeRepoPath
} from '../src/merge-request-store.js';
import {
  listMergeRequests,
  createMergeRequest,
  getMergeRequest,
  mergeRequestAction
} from '../src/merge-request-service.js';

const exec = promisify(execFile);

/** 所有 fixture 根目录，测试结束后统一删除 */
const tempRoots = [];
after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/**
 * 在 fixture 仓库中执行 git 命令，失败时抛出带 stderr 的错误便于定位。
 * @param {string} cwd - git 命令工作目录
 * @param {string[]} args - git 参数数组
 * @returns {Promise<string>} trim 后的 stdout
 */
async function git(cwd, args) {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

/**
 * 探测某 git 命令是否失败（退出码非 0），用于验证引用不存在等预期失败。
 * @param {string} cwd - git 命令工作目录
 * @param {string[]} args - git 参数数组
 * @returns {Promise<boolean>} 失败返回 true
 */
async function gitFails(cwd, args) {
  try {
    await exec('git', args, { cwd });
    return false;
  } catch {
    return true;
  }
}

/**
 * 断言一个 Promise 抛出带指定 statusCode（及可选关键片段）的中文业务错误。
 * @param {Promise<unknown>} promise - 被测调用
 * @param {number} statusCode - 期望的 err.statusCode
 * @param {string} [messageIncludes] - 期望错误信息包含的片段
 */
async function assertHttpError(promise, statusCode, messageIncludes) {
  try {
    await promise;
    assert.fail(`应当抛出 statusCode=${statusCode} 的错误`);
  } catch (err) {
    assert.equal(err.statusCode, statusCode, `实际错误信息：${err.message}`);
    if (messageIncludes) {
      assert.ok(err.message.includes(messageIncludes), `错误信息应包含「${messageIncludes}」，实际：${err.message}`);
    }
  }
}

/**
 * 构造带冲突场景的 fixture 仓库：
 * - repo（main worktree，检出 main）：含初始提交 + 主干对 base.txt 的修改
 * - feature/ok：从初始提交分叉，只新增 feature.txt（与 main 可干净合并）
 * - feature/conflict：从初始提交分叉，改 base.txt（与 main 合并必冲突）
 * 同时返回其下的私有配置目录 configDir。
 * @returns {Promise<{root: string, repo: string, configDir: string}>}
 */
async function createFixtureRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-lens-mr-test-'));
  tempRoots.push(root);
  const repo = path.join(root, 'repo');
  const configDir = path.join(root, 'config');
  await fs.mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  // 仓库级提交者配置，避免依赖全局 git config
  await git(repo, ['config', 'user.name', '测试']);
  await git(repo, ['config', 'user.email', 'test@test.local']);

  await fs.writeFile(path.join(repo, 'base.txt'), 'base\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', '初始提交']);

  await git(repo, ['checkout', '-b', 'feature/ok']);
  await fs.writeFile(path.join(repo, 'feature.txt'), 'feature\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', '功能提交']);

  await git(repo, ['checkout', '-b', 'feature/conflict', 'main']);
  await fs.writeFile(path.join(repo, 'base.txt'), 'conflict\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', '冲突提交']);

  await git(repo, ['checkout', 'main']);
  await fs.writeFile(path.join(repo, 'base.txt'), 'main\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', '主干提交']);

  return { root, repo, configDir };
}

/**
 * 快捷创建一条 source→target 的 open MR 并返回其记录。
 * @param {string} configDir - 配置目录
 * @param {string} repo - 仓库路径
 * @param {string} sourceBranch - 源分支
 * @param {string} targetBranch - 目标分支
 * @returns {Promise<object>} 创建的 MR 记录
 */
async function createMr(configDir, repo, sourceBranch, targetBranch) {
  const { mergeRequest } = await createMergeRequest({
    configDir,
    repoPath: repo,
    sourceBranch,
    targetBranch,
    title: `合并 ${sourceBranch} 到 ${targetBranch}`,
    description: '测试描述'
  });
  return mergeRequest;
}

test('store：文件不存在时 load 返回空数组', async () => {
  const { repo, configDir } = await createFixtureRepo();
  assert.deepEqual(await loadMergeRequests(configDir, repo), []);
});

test('store：save 后 load 往返一致', async () => {
  const { repo, configDir } = await createFixtureRepo();
  const sample = [{ id: 'id-1', status: 'open', sourceBranch: 'a', targetBranch: 'b' }];
  await saveMergeRequests(configDir, repo, sample);
  assert.deepEqual(await loadMergeRequests(configDir, repo), sample);
});

test('store：同一仓库不同写法路径（原始路径与 realpath）落同一文件', async () => {
  const { repo, configDir } = await createFixtureRepo();
  // macOS 下 mkdtemp 得到的是 /var/folders/... 这类符号链接路径，realpath 为 /private/var/...
  const real = await fs.realpath(repo);
  assert.notEqual(repo, real, 'fixture 环境应存在两种路径写法，否则此测试无意义');
  assert.equal(await getRepoKey(configDir, repo), await getRepoKey(configDir, real));

  const sample = [{ id: 'id-1', status: 'open' }];
  await saveMergeRequests(configDir, repo, sample);
  // 用另一种写法读取，必须拿到同一份数据
  assert.deepEqual(await loadMergeRequests(configDir, real), sample);
  // 存储文件名即 repo-key
  const file = await getStoreFilePath(configDir, repo);
  assert.equal(file, path.join(configDir, 'merge-requests', `${await getRepoKey(configDir, repo)}.json`));
});

test('store：原子写入不留临时文件垃圾，JSON 损坏时容错返回空数组', async () => {
  const { repo, configDir } = await createFixtureRepo();
  await saveMergeRequests(configDir, repo, [{ id: 'id-1' }]);
  const dir = path.join(configDir, 'merge-requests');
  const files = await fs.readdir(dir);
  assert.equal(files.length, 1, `目录应只有一个 .json 文件，实际：${files.join(',')}`);
  assert.match(files[0], /\.json$/);

  // 手动把文件写坏，load 必须返回 [] 而不是抛错
  await fs.writeFile(path.join(dir, files[0]), '{broken-json', 'utf8');
  assert.deepEqual(await loadMergeRequests(configDir, repo), []);
});

test('创建：字段完整且路径归一化、分支头 SHA 正确', async () => {
  const { repo, configDir } = await createFixtureRepo();
  const { mergeRequest: mr } = await createMergeRequest({
    configDir,
    repoPath: repo,
    sourceBranch: 'feature/ok',
    targetBranch: 'main',
    title: '  新增本地合并功能  ',
    description: '描述文本'
  });
  assert.match(mr.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(mr.repoPath, await fs.realpath(repo), 'repoPath 应写为 realpath 归一化路径');
  assert.equal(mr.sourceBranch, 'feature/ok');
  assert.equal(mr.targetBranch, 'main');
  assert.equal(mr.title, '新增本地合并功能', 'title 应 trim 后入库');
  assert.equal(mr.description, '描述文本');
  assert.equal(mr.status, 'open');
  assert.equal(mr.reviewStatus, 'pending');
  assert.equal(mr.mergedAt, null);
  assert.equal(mr.mergedCommit, null);
  assert.equal(mr.decisionReason, null);
  assert.equal(mr.sourceHeadAtCreate, await git(repo, ['rev-parse', 'refs/heads/feature/ok']));
  assert.equal(mr.targetHeadAtCreate, await git(repo, ['rev-parse', 'refs/heads/main']));
  // ISO-8601 时间格式
  assert.match(mr.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(mr.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('创建：缺参 / 非法分支名 400，分支不存在 404，source==target 400', async () => {
  const { repo, configDir } = await createFixtureRepo();
  const base = { configDir, repoPath: repo, targetBranch: 'main', title: '标题', description: '' };

  await assertHttpError(createMergeRequest({ ...base, sourceBranch: undefined }), 400, '源分支');
  await assertHttpError(createMergeRequest({ ...base, sourceBranch: 'feature/ok', title: '' }), 400, 'title');
  await assertHttpError(
    createMergeRequest({ ...base, sourceBranch: 'feature/ok', title: 'x'.repeat(201) }),
    400,
    'title'
  );
  await assertHttpError(createMergeRequest({ ...base, sourceBranch: 'bad..name' }), 400, '不是合法的分支名');
  await assertHttpError(
    createMergeRequest({ ...base, sourceBranch: 'feature/ok', targetBranch: 'not-exist' }),
    404,
    '目标分支「not-exist」不存在'
  );
  await assertHttpError(
    createMergeRequest({ ...base, sourceBranch: 'nope', targetBranch: 'main' }),
    404,
    '源分支「nope」不存在'
  );
  await assertHttpError(
    createMergeRequest({ ...base, sourceBranch: 'main', targetBranch: 'main' }),
    400,
    '不能相同'
  );
});

test('创建：重复的 open MR 返回 409', async () => {
  const { repo, configDir } = await createFixtureRepo();
  await createMr(configDir, repo, 'feature/ok', 'main');
  await assertHttpError(
    createMergeRequest({ configDir, repoPath: repo, sourceBranch: 'feature/ok', targetBranch: 'main', title: '重复' }),
    409,
    '已存在相同源分支与目标分支的开启 MR'
  );
  // 但 source 相同、target 不同不受影响
  await git(repo, ['branch', 'release']);
  await createMr(configDir, repo, 'feature/ok', 'release');
});

test('创建：仓库路径不存在 404、不是 Git 仓库 400', async () => {
  const { root, repo, configDir } = await createFixtureRepo();
  await assertHttpError(
    createMergeRequest({ configDir, repoPath: path.join(root, 'missing'), sourceBranch: 'a', targetBranch: 'b', title: 't' }),
    404,
    '不存在'
  );
  await assertHttpError(
    createMergeRequest({ configDir, repoPath: root, sourceBranch: 'feature/ok', targetBranch: 'main', title: 't' }),
    400,
    '不是 Git 仓库'
  );
  assert.ok(repo, 'fixture 正常创建');
});

test('状态机：approve 与 request_changes 仅 open 期间可变', async () => {
  const { repo, configDir } = await createFixtureRepo();
  const mr = await createMr(configDir, repo, 'feature/ok', 'main');

  const approved = await mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'approve', reason: 'LGTM' });
  assert.equal(approved.mergeRequest.reviewStatus, 'approved');
  assert.equal(approved.mergeRequest.status, 'open');
  assert.equal(approved.mergeRequest.decisionReason, 'LGTM', 'approve 的 reason 应作为审阅备注');

  const changes = await mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'request_changes', reason: '请改一下' });
  assert.equal(changes.mergeRequest.reviewStatus, 'changes_requested');
  assert.equal(changes.mergeRequest.status, 'open');

  const reApproved = await mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'approve' });
  assert.equal(reApproved.mergeRequest.reviewStatus, 'approved');
  // 无备注的 approve 不应抹掉上一次（request_changes）留下的审阅备注
  assert.equal(reApproved.mergeRequest.decisionReason, '请改一下');
  // updatedAt 应随每次操作刷新
  assert.ok(reApproved.mergeRequest.updatedAt >= changes.mergeRequest.updatedAt);
});

test('状态机：reject 后为终态，再执行任何 action 返回 409', async () => {
  const { repo, configDir } = await createFixtureRepo();
  const mr = await createMr(configDir, repo, 'feature/ok', 'main');
  const rejected = await mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'reject', reason: '方案不妥' });
  assert.equal(rejected.mergeRequest.status, 'rejected');
  assert.equal(rejected.mergeRequest.decisionReason, '方案不妥');

  await assertHttpError(
    mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'approve' }),
    409,
    'rejected'
  );
  await assertHttpError(
    mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'merge' }),
    409,
    'rejected'
  );
});

test('状态机：cancel 后为终态，decisionReason 允许为空串', async () => {
  const { repo, configDir } = await createFixtureRepo();
  const mr = await createMr(configDir, repo, 'feature/ok', 'main');
  const canceled = await mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'cancel' });
  assert.equal(canceled.mergeRequest.status, 'canceled');
  assert.equal(canceled.mergeRequest.decisionReason, '');
  await assertHttpError(
    mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'reject' }),
    409,
    'canceled'
  );
});

test('状态机：未 approve 直接 merge 返回 409 且 MR 保持 open', async () => {
  const { repo, configDir } = await createFixtureRepo();
  const mr = await createMr(configDir, repo, 'feature/ok', 'main');
  await assertHttpError(
    mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'merge' }),
    409,
    '审阅通过后才能合并'
  );
  const { mergeRequest: current } = await getMergeRequest({ configDir, repoPath: repo, id: mr.id });
  assert.equal(current.status, 'open');
  assert.equal(current.reviewStatus, 'pending');
  // 打回到 changes_requested 同样不能合并
  await mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'request_changes' });
  await assertHttpError(
    mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'merge' }),
    409,
    '审阅通过后才能合并'
  );
});

test('merge：--no-ff 合并成功，mergedCommit 等于目标 worktree 新 HEAD 且第二父为 source head', async () => {
  const { repo, configDir } = await createFixtureRepo();
  const mr = await createMr(configDir, repo, 'feature/ok', 'main');
  await mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'approve' });
  const { mergeRequest: merged, merge } = await mergeRequestAction({
    configDir,
    repoPath: repo,
    id: mr.id,
    action: 'merge',
    reason: '合入主干'
  });

  assert.equal(merged.status, 'merged');
  assert.ok(merged.mergedAt, 'mergedAt 应写入时间');
  assert.equal(merged.decisionReason, '合入主干');
  const head = await git(repo, ['rev-parse', 'HEAD']);
  assert.equal(merged.mergedCommit, head);
  assert.equal(merge.mergedCommit, head);
  assert.equal(merge.targetHead, head);

  // 目标分支历史中出现显式 merge commit，且第二父为 source 分支头
  const secondParent = await git(repo, ['rev-parse', 'HEAD^2']);
  assert.equal(secondParent, await git(repo, ['rev-parse', 'refs/heads/feature/ok']));
  assert.match(await git(repo, ['log', '-1', '--format=%s']), /^Merge branch/);

  // source 分支未被删除、仍指向原提交；feature worktree 不受影响
  assert.equal(await git(repo, ['rev-parse', 'refs/heads/feature/ok']), secondParent);
  // merge 后再 action 返回 409（终态）
  await assertHttpError(
    mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'approve' }),
    409,
    'merged'
  );
});

test('merge：目标 worktree 有未提交改动时拒绝 409 且现场未变', async () => {
  const { repo, configDir } = await createFixtureRepo();
  const mr = await createMr(configDir, repo, 'feature/ok', 'main');
  await mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'approve' });
  await fs.writeFile(path.join(repo, 'dirty.txt'), '未提交内容\n');
  const headBefore = await git(repo, ['rev-parse', 'HEAD']);

  await assertHttpError(
    mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'merge' }),
    409,
    '未提交改动'
  );
  // 现场未变：HEAD 未动、MR 仍 open、脏文件还在
  assert.equal(await git(repo, ['rev-parse', 'HEAD']), headBefore);
  const { mergeRequest: current } = await getMergeRequest({ configDir, repoPath: repo, id: mr.id });
  assert.equal(current.status, 'open');
  assert.equal(await git(repo, ['status', '--porcelain']), '?? dirty.txt');
});

test('merge：冲突时返回 409，自动 abort 后 worktree 干净且无 MERGE_HEAD 残留', async () => {
  const { repo, configDir } = await createFixtureRepo();
  const mr = await createMr(configDir, repo, 'feature/conflict', 'main');
  await mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'approve' });
  const headBefore = await git(repo, ['rev-parse', 'HEAD']);

  await assertHttpError(
    mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'merge' }),
    409,
    '合并失败'
  );
  // MR 仍 open，审阅状态保持 approved
  const { mergeRequest: current } = await getMergeRequest({ configDir, repoPath: repo, id: mr.id });
  assert.equal(current.status, 'open');
  assert.equal(current.reviewStatus, 'approved');
  // worktree 干净（自动 abort 成功），HEAD 未动
  assert.equal(await git(repo, ['status', '--porcelain']), '', 'abort 后 worktree 应无任何残留改动');
  assert.equal(await git(repo, ['rev-parse', 'HEAD']), headBefore);
  // 无 MERGE_HEAD 残留
  assert.ok(await gitFails(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']), '不应残留 MERGE_HEAD');
  // 冲突消除后（让 source 侧 base.txt 与主干一致）可重新合并成功，且无需重新走审阅
  await git(repo, ['checkout', 'feature/conflict']);
  await fs.writeFile(path.join(repo, 'base.txt'), 'main\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', '对齐主干内容以解除冲突']);
  await git(repo, ['checkout', 'main']);
  const { mergeRequest: merged } = await mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'merge' });
  assert.equal(merged.status, 'merged');
});

test('merge：source 分支被删返回 404，target 分支被删也返回 404', async () => {
  const { repo, configDir } = await createFixtureRepo();

  // source 被删
  const mrA = await createMr(configDir, repo, 'feature/ok', 'main');
  await mergeRequestAction({ configDir, repoPath: repo, id: mrA.id, action: 'approve' });
  await git(repo, ['branch', '-D', 'feature/ok']);
  await assertHttpError(
    mergeRequestAction({ configDir, repoPath: repo, id: mrA.id, action: 'merge' }),
    404,
    '源分支「feature/ok」不存在'
  );

  // target 被删：target 分支不挂在任何 worktree 上，先建分支再删除
  await git(repo, ['branch', 'release']);
  const mrB = await createMr(configDir, repo, 'feature/conflict', 'release');
  await mergeRequestAction({ configDir, repoPath: repo, id: mrB.id, action: 'approve' });
  await git(repo, ['branch', '-D', 'release']);
  await assertHttpError(
    mergeRequestAction({ configDir, repoPath: repo, id: mrB.id, action: 'merge' }),
    404,
    '目标分支「release」不存在'
  );
});

test('merge：目标分支存在但没有本地 worktree 时返回 409', async () => {
  const { repo, configDir } = await createFixtureRepo();
  await git(repo, ['branch', 'no-worktree']);
  const mr = await createMr(configDir, repo, 'feature/ok', 'no-worktree');
  await mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'approve' });
  await assertHttpError(
    mergeRequestAction({ configDir, repoPath: repo, id: mr.id, action: 'merge' }),
    409,
    '没有对应的本地 Worktree'
  );
  const { mergeRequest: current } = await getMergeRequest({ configDir, repoPath: repo, id: mr.id });
  assert.equal(current.status, 'open', 'MR 应保持 open');
});

test('action 与 id 参数校验：非法 action 400、非法 UUID 400、MR 不存在 404', async () => {
  const { repo, configDir } = await createFixtureRepo();
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  await assertHttpError(
    mergeRequestAction({ configDir, repoPath: repo, id: uuid, action: 'rebase' }),
    400,
    'action 参数不合法'
  );
  await assertHttpError(
    mergeRequestAction({ configDir, repoPath: repo, id: 'not-a-uuid', action: 'approve' }),
    400,
    'UUID'
  );
  await assertHttpError(
    getMergeRequest({ configDir, repoPath: repo, id: uuid }),
    404,
    '不存在'
  );
});

test('列表与详情：status 过滤、倒序与 404', async () => {
  const { repo, configDir } = await createFixtureRepo();
  const mrA = await createMr(configDir, repo, 'feature/ok', 'main');
  const mrB = await createMr(configDir, repo, 'feature/conflict', 'main');

  const all = await listMergeRequests({ configDir, repoPath: repo });
  assert.equal(all.mergeRequests.length, 2);
  // 倒序：最新创建的在前
  assert.equal(all.mergeRequests[0].id, mrB.id);
  assert.equal(all.mergeRequests[1].id, mrA.id);

  await mergeRequestAction({ configDir, repoPath: repo, id: mrA.id, action: 'reject', reason: '不需要' });
  const open = await listMergeRequests({ configDir, repoPath: repo, status: 'open' });
  assert.deepEqual(open.mergeRequests.map(m => m.id), [mrB.id]);
  const rejected = await listMergeRequests({ configDir, repoPath: repo, status: 'rejected' });
  assert.deepEqual(rejected.mergeRequests.map(m => m.id), [mrA.id]);
  const merged = await listMergeRequests({ configDir, repoPath: repo, status: 'merged' });
  assert.equal(merged.mergeRequests.length, 0);

  await assertHttpError(
    listMergeRequests({ configDir, repoPath: repo, status: 'bogus' }),
    400,
    'status 参数不合法'
  );

  // 详情：正常获取与 404
  const detail = await getMergeRequest({ configDir, repoPath: repo, id: mrB.id });
  assert.equal(detail.mergeRequest.sourceBranch, 'feature/conflict');
  const unknownUuid = '00000000-0000-4000-8000-000000000000';
  await assertHttpError(
    getMergeRequest({ configDir, repoPath: repo, id: unknownUuid }),
    404,
    '不存在'
  );
  await assertHttpError(
    getMergeRequest({ configDir, repoPath: repo, id: 'bad' }),
    400,
    'UUID'
  );
});

test('服务层路径归一化：用符号链接写法创建的 MR 能用 realpath 写法读取', async () => {
  const { repo, configDir } = await createFixtureRepo();
  const real = await fs.realpath(repo);
  assert.notEqual(repo, real);
  const mr = await createMr(configDir, repo, 'feature/ok', 'main');
  // 换一种路径写法读取/操作，必须命中同一条记录
  const detail = await getMergeRequest({ configDir, repoPath: real, id: mr.id });
  assert.equal(detail.mergeRequest.id, mr.id);
  assert.equal(detail.mergeRequest.repoPath, real, '记录中的 repoPath 应为归一化路径');
  const listed = await listMergeRequests({ configDir, repoPath: real });
  assert.equal(listed.mergeRequests.length, 1);
  // normalizeRepoPath 对不存在的路径应回退 resolve 而不是抛错
  assert.equal(await normalizeRepoPath(path.join(os.tmpdir(), 'no-such-dir-xyz')), path.resolve(os.tmpdir(), 'no-such-dir-xyz'));
});
