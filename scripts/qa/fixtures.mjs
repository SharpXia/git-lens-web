/**
 * fixtures.mjs —— QA 隔离测试的 qa-root 与 Git fixture 生成器（契约 §8.1，计划书 §6.1）
 *
 * 职责：
 *   - 在系统临时目录 mkdtemp 出本轮 qa-root，并按契约布局建立子目录与 manifest.json；
 *   - 用子进程 git 命令在 <qaRoot>/repos 下构建覆盖全部验收场景的 fixture 仓库；
 *   - 全程自我约束：任何文件写入与 git 执行前都经 assertPathInsideRoot 确认位于 qa-root 内，
 *     git 作者与全局/系统配置经 GIT_CONFIG_GLOBAL/HOME 指向 <qaRoot>/git-home，不触碰宿主配置。
 *
 * 每轮运行生成全新 fixture，不复用上轮状态；清理由启动器（run.mjs）按 manifest 确认的
 * qa-root 执行，本模块不做删除。
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { assertPlannedPathInsideRoot, assertPathInsideRoot } from './guard.mjs';

const execFileAsync = promisify(execFile);

/** 源码 worktree 根目录（本文件位于 <root>/scripts/qa/ 下），只读访问用于 manifest.commits */
const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** qa-root 固定布局（契约 §8.1）；artifacts 仅用于产出报告，不属于 allowedPaths 的写白名单 */
const QA_SUBDIRS = ['repos', 'config', 'electron-user-data', 'git-home', 'artifacts'];

// 写入 <qaRoot>/git-home/config 的全局 git 配置：作者、默认分支、签名全部钉死，
// 避免 fixture 依赖宿主机全局配置（hooks、commit 签名、模板等）导致行为不可复现
const GIT_GLOBAL_CONFIG = [
  '[user]',
  '\tname = QA Runner',
  '\temail = qa-runner@example.invalid',
  '[init]',
  '\tdefaultBranch = main',
  '[commit]',
  '\tgpgsign = false',
  '[tag]',
  '\tgpgsign = false',
  '[core]',
  '\tautocrlf = false',
  '[advice]',
  '\tdetachedHead = false',
  ''
].join('\n');

// 最小 1x1 PNG（与 scripts/mr-diff-fixture.sh 相同字节）；latin1 保证逐字节一致
export const MINIMAL_PNG = Buffer.from(
  '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89' +
  '\x00\x00\x00\x0dIDATx\xda\x63\xfc\xcf\xc0P\x0f\x00\x04\x85\x01\x80\x84\xa9\x8c\x21\x00\x00\x00\x00IEND\xae\x42\x60\x82',
  'latin1'
);

// 含 NUL 字节的二进制素材，确保 git 将其判定为二进制文件
const BINARY_BLOB = Buffer.from([0x00, 0x01, 0xff, 0x00, 0x10, 0xde, 0xad, 0xbe, 0xef, 0x00]);

// stash 第 2 条的内容素材：真实冲突标记，供「含冲突标记的 stash」断言与 UI 转义审查使用
const CONFLICT_MARKER_CONTENT = [
  '<<<<<<< HEAD',
  'stash 前的工作区版本',
  '=======',
  '外部变更版本',
  '>>>>>>> external/change',
  ''
].join('\n');

/**
 * 生成契约 §8.1 要求格式的 run-id：`qa-<ISO 时间戳>-<随机后缀>`。
 * ISO 中的冒号/点替换为 '-'，避免进入路径与 URL 时需要额外转义。
 */
export function makeRunId(now = new Date()) {
  return `qa-${now.toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
}

/** git 子进程环境：HOME/全局/系统配置全部指向本轮 qa-root 的 git-home */
export function gitEnv(qaRoot) {
  const gitHome = path.join(qaRoot, 'git-home');
  const env = { ...process.env };
  // 剥离调用方环境中可能残留的 git 上下文变量，防止 fixture 写到意外位置
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) {
    delete env[key];
  }
  return {
    ...env,
    HOME: gitHome,
    XDG_CONFIG_HOME: gitHome,
    GIT_CONFIG_GLOBAL: path.join(gitHome, 'config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'QA Runner',
    GIT_AUTHOR_EMAIL: 'qa-runner@example.invalid',
    GIT_COMMITTER_NAME: 'QA Runner',
    GIT_COMMITTER_EMAIL: 'qa-runner@example.invalid',
    TZ: 'UTC',
    LC_ALL: 'C'
  };
}

/** 生成器自我约束：任何路径使用前必须经 realpath 确认位于 qa-root 内 */
async function assertInsideQaRoot(qaRoot, ...candidates) {
  for (const candidate of candidates) {
    await assertPathInsideRoot(candidate, qaRoot);
  }
}

/** 在 qa-root 内执行 git 命令（execFile 数组参数，杜绝 shell 拼接与特殊字符注入） */
async function git(qaRoot, cwd, ...args) {
  await assertInsideQaRoot(qaRoot, cwd);
  await execFileAsync('git', args, { cwd, env: gitEnv(qaRoot) });
}

/** 在 qa-root 内执行 git 命令并返回 stdout（用于构建后自检） */
async function gitOut(qaRoot, cwd, ...args) {
  await assertInsideQaRoot(qaRoot, cwd);
  const { stdout } = await execFileAsync('git', args, { cwd, env: gitEnv(qaRoot) });
  return stdout.trim();
}

/** 在 qa-root 内写文件（目标允许尚不存在；写前经计划路径守卫校验） */
async function writeFileInQaRoot(qaRoot, absolutePath, content) {
  await assertPlannedPathInsideRoot(absolutePath, qaRoot);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content);
}

/** 写入并提交单个文件（fixture 的最小原子操作） */
async function writeAndCommit(qaRoot, dir, relPath, content, message) {
  await writeFileInQaRoot(qaRoot, path.join(dir, relPath), content);
  await git(qaRoot, dir, 'add', '--', relPath);
  await git(qaRoot, dir, 'commit', '-q', '-m', message);
}

/** 以临时 worktree 制造「有独有提交但无 worktree」的分支，结束后移除临时目录 */
async function addBranchViaTempWorktree(qaRoot, repo, branchName, fileName, message) {
  const tmpWt = path.join(qaRoot, 'repos', `.tmp-wt-${branchName.replace(/\//g, '-')}`);
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', branchName, tmpWt);
  await writeAndCommit(qaRoot, tmpWt, fileName, `${branchName} 的独有提交内容。\n`, message);
  await git(qaRoot, repo, 'worktree', 'remove', tmpWt);
}

/** 读取当前源码 worktree 的分支与 HEAD（只读，写入 manifest.commits 供交付包追溯） */
async function sourceWorktreeCommits() {
  try {
    const { stdout: branch } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: WORKTREE_ROOT });
    const { stdout: sha } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: WORKTREE_ROOT });
    return { branch: branch.trim(), sha: sha.trim() };
  } catch {
    // 非 git 环境下允许为空，不应阻塞测试
    return { branch: '', sha: '' };
  }
}

async function systemGitVersion() {
  try {
    const { stdout } = await execFileAsync('git', ['--version']);
    return stdout.trim().replace(/^git version\s*/, '');
  } catch {
    return '';
  }
}

/** 读取 manifest.json（realpath 后必须位于 qa-root 内） */
export async function readManifest(qaRoot) {
  const manifestPath = path.join(qaRoot, 'manifest.json');
  await assertPathInsideRoot(manifestPath, qaRoot);
  return JSON.parse(await fs.readFile(manifestPath, 'utf8'));
}

/** 写入/覆盖 manifest.json（首次写入时文件尚不存在，用计划路径守卫） */
export async function writeManifest(qaRoot, manifest) {
  const manifestPath = path.join(qaRoot, 'manifest.json');
  await assertPlannedPathInsideRoot(manifestPath, qaRoot);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * 局部更新 manifest（当前仅 service 层需要握手后回填 port/pid，故只做一层合并）。
 * @param {{ service?: object }} patch
 */
export async function updateManifest(qaRoot, patch = {}) {
  const manifest = await readManifest(qaRoot);
  const next = {
    ...manifest,
    ...(patch.service ? { service: { ...manifest.service, ...patch.service } } : {})
  };
  await writeManifest(qaRoot, next);
  return next;
}

/**
 * 创建本轮 qa-root：mkdtemp → realpath → 建子目录 → 写 git 全局配置 → 写初始 manifest。
 * @param {string} runId makeRunId 生成的运行 ID
 * @returns {Promise<string>} realpath 后的 qa-root
 */
export async function createQaRoot(runId) {
  const rawRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'git-lens-qa-'));
  // macOS 上 /tmp 是 /private/tmp 的符号链接：统一以 realpath 为准，与 git porcelain 输出一致
  const qaRoot = await fs.realpath(rawRoot);
  for (const sub of QA_SUBDIRS) {
    await fs.mkdir(path.join(qaRoot, sub), { recursive: true });
  }
  await assertInsideQaRoot(qaRoot, path.join(qaRoot, 'config'), path.join(qaRoot, 'repos'));
  await fs.writeFile(path.join(qaRoot, 'git-home', 'config'), GIT_GLOBAL_CONFIG, 'utf8');

  await writeManifest(qaRoot, {
    runId,
    createdAt: new Date().toISOString(),
    qaRoot,
    allowedPaths: QA_SUBDIRS.filter((s) => s !== 'artifacts').map((s) => path.join(qaRoot, s)),
    service: { host: '127.0.0.1', port: 0, mode: 'browser', pid: 0 },
    electron: { userData: path.join(qaRoot, 'electron-user-data'), mainPid: 0 },
    versions: { node: process.version, git: await systemGitVersion(), electron: '' },
    commits: await sourceWorktreeCommits(),
    platform: { os: process.platform, arch: process.arch, release: os.release() }
  });
  return qaRoot;
}

/**
 * 构建 repo-main：干净基线 + 已合并/未合并/失联分支 + 干净/脏/stash worktree + 失联 worktree。
 */
async function buildRepoMain(qaRoot) {
  const repo = path.join(qaRoot, 'repos', 'repo-main');
  await fs.mkdir(repo, { recursive: true });
  await git(qaRoot, repo, 'init');
  await git(qaRoot, repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');

  // 干净主仓库基线：文本 + PNG 图片 + 二进制
  await writeAndCommit(qaRoot, repo, 'README.md', '# QA 主仓库 fixture\n\n干净基线素材。\n', 'main: 初始化 README');
  await writeAndCommit(qaRoot, repo, 'notes.txt', 'main 基础文本。\n', 'main: 添加 notes.txt');
  await writeAndCommit(qaRoot, repo, 'assets/logo.png', MINIMAL_PNG, 'main: 添加 PNG 图片');
  await writeAndCommit(qaRoot, repo, 'assets/blob.bin', BINARY_BLOB, 'main: 添加二进制文件');

  // 已合并分支：--no-ff 合并进 main，形成显式 merge commit
  await git(qaRoot, repo, 'checkout', '-q', '-b', 'feature/merged');
  await writeAndCommit(qaRoot, repo, 'merged.txt', '已被合并进 main 的内容。\n', 'merged: 独有提交');
  await git(qaRoot, repo, 'checkout', '-q', 'main');
  await git(qaRoot, repo, 'merge', '--no-ff', '-q', '-m', 'main: 合并 feature/merged（已合并分支素材）', 'feature/merged');

  // 未合并分支：1 个独有提交、无 worktree
  await addBranchViaTempWorktree(qaRoot, repo, 'feature/unmerged', 'unmerged.txt', 'unmerged: 独有提交');

  // 干净 worktree
  const wtClean = path.join(qaRoot, 'repos', 'wt-clean');
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', 'feature/clean-wt', wtClean);

  // 脏 worktree：已提交素材（图片/二进制字节追加，供 diff isImage/isBinary 与
  // raw-file 断言）+ 未提交修改 + staged 新文件 + untracked 文件并存
  const wtDirty = path.join(qaRoot, 'repos', 'wt-dirty');
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', 'feature/dirty-wt', wtDirty);
  await writeAndCommit(qaRoot, wtDirty, 'dirty-committed.txt', 'dirty 分支的已提交新文件。\n', 'dirty: 新增已提交文件并追加图片/二进制字节');
  await writeFileInQaRoot(qaRoot, path.join(wtDirty, 'assets/logo.png'), Buffer.concat([MINIMAL_PNG, Buffer.from([0x00, 0xff])]));
  await writeFileInQaRoot(qaRoot, path.join(wtDirty, 'assets/blob.bin'), Buffer.concat([BINARY_BLOB, Buffer.from([0xde, 0xad])]));
  await git(qaRoot, wtDirty, 'add', 'assets');
  await git(qaRoot, wtDirty, 'commit', '-q', '-m', 'dirty: 追加图片/二进制字节');
  await writeFileInQaRoot(qaRoot, path.join(wtDirty, 'notes.txt'), 'main 基础文本。\n脏 worktree 的未提交修改行。\n');
  await writeFileInQaRoot(qaRoot, path.join(wtDirty, 'staged-file.txt'), '已 git add 但未提交的文件。\n');
  await git(qaRoot, wtDirty, 'add', 'staged-file.txt');
  await writeFileInQaRoot(qaRoot, path.join(wtDirty, 'untracked-file.txt'), '未跟踪文件。\n');

  // 失联分支：worktree 登记在案但目录已删（prunable）
  const wtLost = path.join(qaRoot, 'repos', 'wt-lost');
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', 'feature/lost', wtLost);
  await writeAndCommit(qaRoot, wtLost, 'lost.txt', '失联分支的独有提交。\n', 'lost: 独有提交');
  await fs.rm(wtLost, { recursive: true, force: true });

  // 恶意提交信息 worktree：HEAD 提交主题即恶意负载，inspect 视图的 worktree 行会
  // 直接展示（经 escapeHtml），供 G3「恶意 Git 元数据渲染为纯文本」断言使用。
  // 两个 worktree 分别以 XSS 与路径逃逸负载作 HEAD（inspect 仅展示各 worktree 最新提交）
  const wtMalicious = path.join(qaRoot, 'repos', 'wt-malicious');
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', 'feature/malicious-wt', wtMalicious);
  await writeAndCommit(qaRoot, wtMalicious, 'malicious-1.txt', 'XSS 负载。\n', '<img src=x onerror=alert(1)>');
  const wtMalicious2 = path.join(qaRoot, 'repos', 'wt-malicious-2');
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', 'feature/malicious-wt-2', wtMalicious2);
  await writeAndCommit(qaRoot, wtMalicious2, 'malicious-2.txt', '路径逃逸与 script 注入负载。\n',
    '../../escape <script>alert(2)</script> 伪注入行');

  // G4 写操作矩阵素材：
  //   wt-cherry（干净）——cherry-pick 成功/冲突/revert 的目标 worktree；
  //   feature/cherry-source 提交 A（新增 cherry-file.txt）可干净 pick；
  //   feature/pick-conflict 基于 main 新增同路径文件——先 pick A 再 pick 它时
  //   形成 add/add 冲突（base 无此文件、ours 有 A 的版本、theirs 是冲突版本）；
  //   revert A 即可恢复 cherry-file.txt 缺失的原始状态
  const wtCherry = path.join(qaRoot, 'repos', 'wt-cherry');
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', 'feature/cherry-wt', wtCherry);
  const tmpCherrySource = path.join(qaRoot, 'repos', '.tmp-wt-cherry-source');
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', 'feature/cherry-source', tmpCherrySource);
  await writeAndCommit(qaRoot, tmpCherrySource, 'cherry-file.txt', 'source v1\n', 'cherry: 新增 cherry-file（可干净 pick）');
  await git(qaRoot, repo, 'worktree', 'remove', tmpCherrySource);
  const tmpPickConflict = path.join(qaRoot, 'repos', '.tmp-wt-pick-conflict');
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', 'feature/pick-conflict', tmpPickConflict);
  await writeAndCommit(qaRoot, tmpPickConflict, 'cherry-file.txt', 'conflict v2\n', 'conflict: 新增同路径不同内容（pick 必冲突）');
  await git(qaRoot, repo, 'worktree', 'remove', tmpPickConflict);

  // stash 矩阵专用：wt-stash-ops 为操作源（保持无 stash、干净），wt-stash-target 为
  // 「pop 到同仓库另一 worktree」的干净目标；两者均无独有提交（可作清理候选素材）
  const wtStashOps = path.join(qaRoot, 'repos', 'wt-stash-ops');
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', 'feature/stash-ops-wt', wtStashOps);
  const wtStashTarget = path.join(qaRoot, 'repos', 'wt-stash-target');
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', 'feature/stash-target-wt', wtStashTarget);
  // 「pop 到未绑定分支」的目标：分支存在但无 worktree（服务语义要求分支已存在）
  const tmpUnbound = path.join(qaRoot, 'repos', '.tmp-wt-unbound');
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', 'feature/stash-unbound', tmpUnbound);
  await git(qaRoot, repo, 'worktree', 'remove', tmpUnbound);

  // 长列表素材：35 个提交，供提交抽屉「加载更多」追加渲染断言（分页 limit 为 30）
  const wtManyCommits = path.join(qaRoot, 'repos', 'wt-many-commits');
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', 'feature/many-commits-wt', wtManyCommits);
  for (let i = 1; i <= 35; i++) {
    await writeAndCommit(qaRoot, wtManyCommits, `many/commit-${String(i).padStart(2, '0')}.txt`, `第 ${i} 个提交的内容。\n`, `many: 第 ${i} 个提交`);
  }

  // stash worktree：两条 stash，第 2 条内容含冲突标记
  const wtStash = path.join(qaRoot, 'repos', 'wt-stash');
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', 'feature/stash-wt', wtStash);
  await writeFileInQaRoot(qaRoot, path.join(wtStash, 'notes.txt'), 'main 基础文本。\nstash 第 1 条的正常修改。\n');
  await git(qaRoot, wtStash, 'stash', 'push', '-q', '-m', 'QA stash 1: 正常修改');
  await writeFileInQaRoot(qaRoot, path.join(wtStash, 'notes.txt'), `main 基础文本。\n${CONFLICT_MARKER_CONTENT}`);
  await git(qaRoot, wtStash, 'stash', 'push', '-q', '-m', 'QA stash 2: 含冲突标记');

  return {
    repo,
    branches: {
      main: 'main',
      merged: 'feature/merged',
      unmerged: 'feature/unmerged',
      lost: 'feature/lost',
      cleanWt: 'feature/clean-wt',
      dirtyWt: 'feature/dirty-wt',
      stashWt: 'feature/stash-wt',
      maliciousWt: 'feature/malicious-wt',
      maliciousWt2: 'feature/malicious-wt-2',
      cherryWt: 'feature/cherry-wt',
      cherrySource: 'feature/cherry-source',
      pickConflict: 'feature/pick-conflict',
      stashOpsWt: 'feature/stash-ops-wt',
      stashTargetWt: 'feature/stash-target-wt',
      manyCommitsWt: 'feature/many-commits-wt'
    },
    worktrees: {
      clean: wtClean, dirty: wtDirty, stash: wtStash, lost: wtLost,
      malicious: wtMalicious, malicious2: wtMalicious2,
      cherry: wtCherry, stashOps: wtStashOps, stashTarget: wtStashTarget, manyCommits: wtManyCommits
    }
  };
}

/**
 * 构建 repo-absorbed：被 cherry-pick 与 squash 吸收的开发分支，
 * 供「成果已经由载体进入主干」判定（git cherry 全为 '-' 的补丁等价素材）。
 */
async function buildRepoAbsorbed(qaRoot) {
  const repo = path.join(qaRoot, 'repos', 'repo-absorbed');
  await fs.mkdir(repo, { recursive: true });
  await git(qaRoot, repo, 'init');
  await git(qaRoot, repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await writeAndCommit(qaRoot, repo, 'README.md', '# 吸收判定素材仓库\n', 'main: 初始化');

  // cherry-pick 吸收：分支独有提交（新增 cherry-feature.txt）被 main 以相同补丁吸收。
  // 注意分叉后先给 main 追加一笔提交：若 cherry-pick 落点与分支父提交相同，
  // 会生成完全相同的提交对象（同 SHA）而退化成纯祖先，不再是补丁等价素材
  const wtCherry = path.join(qaRoot, 'repos', '.tmp-wt-cherry');
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', 'feature/cherry-picked', wtCherry);
  await writeAndCommit(qaRoot, wtCherry, 'cherry-feature.txt', 'cherry-pick 吸收素材内容。\n', 'cherry: 新增将被吸收的文件');
  const cherrySha = await gitOut(qaRoot, wtCherry, 'rev-parse', 'HEAD');
  await git(qaRoot, repo, 'worktree', 'remove', wtCherry);
  await writeAndCommit(qaRoot, repo, 'baseline-after.txt', 'main 在分叉后追加的基线提交。\n', 'main: 分叉后的基线提交');
  await git(qaRoot, repo, 'cherry-pick', cherrySha);

  // squash 吸收：分支独有提交被 squash 成 main 上的单个新提交（补丁等价、SHA 不同）
  const wtSquash = path.join(qaRoot, 'repos', '.tmp-wt-squash');
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', 'feature/squashed', wtSquash);
  await writeAndCommit(qaRoot, wtSquash, 'squash-feature.txt', 'squash 吸收素材内容。\n', 'squash: 新增将被吸收的文件');
  await git(qaRoot, repo, 'worktree', 'remove', wtSquash);
  await git(qaRoot, repo, 'merge', '--squash', 'feature/squashed');
  await git(qaRoot, repo, 'commit', '-q', '-m', 'main: squash 吸收 feature/squashed');

  return { repo, branches: { cherryPicked: 'feature/cherry-picked', squashed: 'feature/squashed' } };
}

/**
 * 构建 repo-mr：一对会互相冲突的本地 MR 分支（同 base、同文件同行的不同修改），
 * 外加一条可与 main 干净合并的对照分支。
 */
async function buildRepoMr(qaRoot) {
  const repo = path.join(qaRoot, 'repos', 'repo-mr');
  await fs.mkdir(repo, { recursive: true });
  await git(qaRoot, repo, 'init');
  await git(qaRoot, repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await writeAndCommit(qaRoot, repo, 'shared.txt', 'shared-choice: base\n', 'main: 添加共享冲突行文件');

  const wtAlpha = path.join(qaRoot, 'repos', '.tmp-wt-mr-alpha');
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', 'mr/alpha', wtAlpha);
  await writeAndCommit(qaRoot, wtAlpha, 'shared.txt', 'shared-choice: alpha\n', 'alpha: 修改共享行');
  await git(qaRoot, repo, 'worktree', 'remove', wtAlpha);

  // main 仍停在 base 提交，mr/beta 与 mr/alpha 同 base、同行不同值 —— 合并必冲突
  const wtBeta = path.join(qaRoot, 'repos', '.tmp-wt-mr-beta');
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', 'mr/beta', wtBeta);
  await writeAndCommit(qaRoot, wtBeta, 'shared.txt', 'shared-choice: beta\n', 'beta: 修改共享行');
  await git(qaRoot, repo, 'worktree', 'remove', wtBeta);

  const wtClean = path.join(qaRoot, 'repos', '.tmp-wt-mr-clean');
  await git(qaRoot, repo, 'worktree', 'add', '-q', '-b', 'mr/clean', wtClean);
  await writeAndCommit(qaRoot, wtClean, 'clean.txt', '无冲突的对照分支内容。\n', 'clean: 新增独立文件');
  await git(qaRoot, repo, 'worktree', 'remove', wtClean);

  return { repo, branches: { alpha: 'mr/alpha', beta: 'mr/beta', clean: 'mr/clean' } };
}

/**
 * 构建 repo-special：中文/空格/特殊字符路径、二进制与图片，以及恶意提交信息样本
 * （XSS、路径逃逸、超长文本、换行注入），供 G3 安全审查与 raw-file 断言使用。
 */
async function buildRepoSpecial(qaRoot) {
  const repo = path.join(qaRoot, 'repos', 'repo-special');
  await fs.mkdir(repo, { recursive: true });
  await git(qaRoot, repo, 'init');
  await git(qaRoot, repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');

  // 中文、空格与特殊字符（单双引号、&、<>）路径
  const files = {
    chinese: { path: 'docs/中文 文件.txt', content: '这是包含中文与空格路径的文件。\n' },
    singleQuote: { path: "weird/quote'single.txt", content: '单引号路径文件。\n' },
    doubleQuote: { path: 'weird/double"quote.txt', content: '双引号路径文件。\n' },
    ampersand: { path: 'weird/amp&ersand.txt', content: '与符号路径文件。\n' },
    angleBrackets: { path: 'weird/angle<>.txt', content: '尖括号路径文件。\n' }
  };
  for (const { path: relPath, content } of Object.values(files)) {
    await writeFileInQaRoot(qaRoot, path.join(repo, relPath), content);
  }
  await git(qaRoot, repo, 'add', '-A');
  await git(qaRoot, repo, 'commit', '-q', '-m', 'special: 添加中文、空格与特殊字符路径文件');

  // 恶意提交信息样本：每条一个文件，便于按文件定位对应提交
  await writeAndCommit(qaRoot, repo, 'reports/xss.txt', '<img src=x onerror=alert(1)>\n', '<img src=x onerror=alert(1)>');
  await writeAndCommit(qaRoot, repo, 'reports/traversal.txt', '尝试借提交信息越权读取仓库外路径。\n', '../../escape 读取仓库外文件');
  await writeAndCommit(
    qaRoot, repo, 'reports/long.txt',
    `超长提交信息样本正文。${'长'.repeat(2000)}\n`,
    `超长提交信息样本标题：${'长'.repeat(2000)}`
  );
  // 换行注入：主题行之后伪造多行「系统输出」，检验前端按纯文本/转义渲染
  await writeAndCommit(
    qaRoot, repo, 'reports/newline-injection.txt',
    '换行注入素材正文。\n',
    '换行注入样本标题\n伪造注入行1: fake-system-header\n<script>alert(2)</script>'
  );

  // 二进制与图片
  await writeAndCommit(qaRoot, repo, 'assets/pixel.png', MINIMAL_PNG, 'binary: 添加 PNG 图片');
  await writeAndCommit(qaRoot, repo, 'assets/blob.bin', BINARY_BLOB, 'binary: 添加二进制文件');

  return {
    repo,
    files: {
      ...files,
      png: { path: 'assets/pixel.png' },
      bin: { path: 'assets/blob.bin' }
    }
  };
}

/** 构建后自检：用 git 本身验证各场景素材的语义，任何不符立即抛错（fail-closed） */
async function verifyFixtures(qaRoot, fx) {
  const expect = (cond, message) => {
    if (!cond) throw new Error(`fixture 自检失败: ${message}`);
  };

  const main = fx.main;
  expect((await gitOut(qaRoot, main.repo, 'status', '--porcelain')) === '', 'repo-main 主工作区应干净');
  expect((await gitOut(qaRoot, main.repo, 'rev-list', '--count', 'main..feature/unmerged')) === '1',
    'feature/unmerged 应恰好 1 个独有提交');
  expect((await gitOut(qaRoot, main.repo, 'rev-list', '--count', 'main..feature/merged')) === '0',
    'feature/merged 应已全部进入 main');
  expect((await gitOut(qaRoot, main.repo, 'merge-base', '--is-ancestor', 'feature/merged', 'main')) === '',
    'feature/merged 应为 main 祖先');

  const dirtyStatus = await gitOut(qaRoot, main.worktrees.dirty, 'status', '--porcelain');
  expect(dirtyStatus.split('\n').filter(Boolean).length === 3, 'wt-dirty 应含未提交修改/staged/untracked 三类条目');

  // 恶意提交素材：两个 worktree 的 HEAD 主题必须精确等于负载字符串
  const xssSubject = await gitOut(qaRoot, main.worktrees.malicious, 'log', '-1', '--format=%s');
  expect(xssSubject === '<img src=x onerror=alert(1)>', 'wt-malicious HEAD 主题应为 XSS 负载');
  const escapeSubject = await gitOut(qaRoot, main.worktrees.malicious2, 'log', '-1', '--format=%s');
  expect(escapeSubject === '../../escape <script>alert(2)</script> 伪注入行', 'wt-malicious-2 HEAD 主题应为路径逃逸负载');

  // G4 素材：cherry 冲突对（同文件不同内容、同 base）、stash 矩阵 worktree 干净、长列表 35 提交
  expect((await gitOut(qaRoot, main.worktrees.cherry, 'status', '--porcelain')) === '', 'wt-cherry 应干净');
  const sourceFile = await gitOut(qaRoot, main.repo, 'show', 'feature/cherry-source:cherry-file.txt');
  const conflictFile = await gitOut(qaRoot, main.repo, 'show', 'feature/pick-conflict:cherry-file.txt');
  expect(sourceFile === 'source v1' && conflictFile === 'conflict v2', 'cherry 冲突对的同文件内容应不同');
  expect((await gitOut(qaRoot, main.worktrees.stashOps, 'stash', 'list')) === (await gitOut(qaRoot, main.worktrees.stash, 'stash', 'list')),
    'wt-stash-ops 初始不应有额外 stash（stash ref 仓库级共享，应恰为 wt-stash 的 2 条）');
  expect((await gitOut(qaRoot, main.worktrees.manyCommits, 'rev-list', '--count', 'HEAD')) !== ''
    && Number(await gitOut(qaRoot, main.worktrees.manyCommits, 'rev-list', '--count', 'HEAD')) > 35,
    'wt-many-commits 应有超过 35 个提交');

  const stashLines = (await gitOut(qaRoot, main.worktrees.stash, 'stash', 'list')).split('\n').filter(Boolean);
  expect(stashLines.length === 2, 'wt-stash 应有 2 条 stash');
  expect(stashLines.some((l) => l.includes('含冲突标记')), 'stash 素材应含「含冲突标记」条目');

  // 失联 worktree：git worktree list 应给出 prunable 标注（git >= 2.36）
  const wtList = await gitOut(qaRoot, main.repo, 'worktree', 'list', '--porcelain');
  expect(/prunable/.test(wtList), 'feature/lost 的 worktree 应被标记 prunable');

  // 吸收判定：两条分支相对 main 的补丁应全部等价（git cherry 输出全为 '-'）
  for (const branch of ['feature/cherry-picked', 'feature/squashed']) {
    const cherryOut = await gitOut(qaRoot, fx.absorbed.repo, 'cherry', 'main', branch);
    const lines = cherryOut.split('\n').filter(Boolean);
    expect(lines.length >= 1 && lines.every((l) => l.startsWith('-')), `${branch} 应被 main 完全吸收`);
  }

  // MR 冲突对：同 base、同文件首行不同值
  const alphaLine = (await gitOut(qaRoot, fx.mr.repo, 'show', 'mr/alpha:shared.txt')).split('\n')[0];
  const betaLine = (await gitOut(qaRoot, fx.mr.repo, 'show', 'mr/beta:shared.txt')).split('\n')[0];
  expect(alphaLine !== betaLine, 'mr/alpha 与 mr/beta 的共享行应不同（冲突素材）');

  // 特殊字符路径确实进入 git 对象库
  const angleContent = await gitOut(qaRoot, fx.special.repo, 'cat-file', '-p', `HEAD:${fx.special.files.angleBrackets.path}`);
  expect(angleContent === fx.special.files.angleBrackets.content.trim(), '尖括号路径文件应可从 git 读取');
}

/**
 * 构建全部 fixture 场景。
 * @param {string} qaRoot realpath 后的 qa-root
 * @returns {Promise<object>} fixture 描述符（仓库/worktree 路径、分支名、特殊文件内容），供冒烟套件断言
 */
export async function buildFixtures(qaRoot) {
  const main = await buildRepoMain(qaRoot);
  const absorbed = await buildRepoAbsorbed(qaRoot);
  const mr = await buildRepoMr(qaRoot);
  const special = await buildRepoSpecial(qaRoot);
  const chinese = await buildRepoChinese(qaRoot);
  const fx = { qaRoot, scanRoot: path.join(qaRoot, 'repos'), main, absorbed, mr, special, chinese };
  await verifyFixtures(qaRoot, fx);
  return fx;
}

/**
 * 构建中文与特殊字符命名的独立仓库：目录名含中文、空格、双引号与 &，
 * 供桌面/浏览器端「项目列表渲染不缺项」与转义渲染断言使用。
 */
async function buildRepoChinese(qaRoot) {
  const repo = path.join(qaRoot, 'repos', '中文 仓库"&特殊');
  await fs.mkdir(repo, { recursive: true });
  await git(qaRoot, repo, 'init');
  await git(qaRoot, repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await writeAndCommit(qaRoot, repo, 'README.md', '# 中文与特殊字符命名仓库\n', 'main: 初始化中文名仓库');
  await writeAndCommit(qaRoot, repo, 'docs/说明 文档.txt', '中文路径与空格素材。\n', 'docs: 添加中文说明文档');
  return { repo, name: path.basename(repo) };
}
