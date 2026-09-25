import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 归一化仓库绝对路径。
 *
 * 优先用 fs.realpath 解析符号链接（macOS 下 /tmp 实际是 /private/tmp，
 * 不归一化会导致同一仓库因路径写法不同而落到两个 MR 存储文件）；
 * realpath 失败（路径尚不存在等）时退回 path.resolve，保证调用方总能拿到绝对路径。
 * @param {string} repoPath - 仓库路径（绝对或相对均可）
 * @returns {Promise<string>} 归一化后的绝对路径
 */
export async function normalizeRepoPath(repoPath) {
  try {
    return await fs.realpath(repoPath);
  } catch {
    return path.resolve(repoPath);
  }
}

/**
 * 计算仓库对应的 MR 存储键：归一化路径的 SHA-256 十六进制。
 *
 * 用哈希而不是原始路径做文件名，避免路径里的斜杠、空格等字符破坏文件布局。
 * configDir 当前不参与键的计算，保留在签名里是为了与存储文件位置语义对齐
 * （键由"哪个配置目录 + 哪个仓库"共同定位），也为将来按配置目录隔离留余地。
 * @param {string} configDir - 配置根目录（见 server.js 的 CONFIG_DIR，由调用方传入）
 * @param {string} repoPath - 仓库路径
 * @returns {Promise<string>} 64 位十六进制字符串
 */
export async function getRepoKey(configDir, repoPath) {
  const normalized = await normalizeRepoPath(repoPath);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * 计算某仓库的 MR 存储文件完整路径：${configDir}/merge-requests/<repo-key>.json
 * @param {string} configDir - 配置根目录
 * @param {string} repoPath - 仓库路径
 * @returns {Promise<string>} 存储文件绝对路径
 */
export async function getStoreFilePath(configDir, repoPath) {
  const key = await getRepoKey(configDir, repoPath);
  return path.join(configDir, 'merge-requests', `${key}.json`);
}

/**
 * 读取指定仓库的 MR 记录列表。
 *
 * 容错策略：文件不存在、JSON 损坏、内容不是数组时一律返回 [] 且不抛错——
 * MR 存储属于辅助数据，损坏时不允许阻塞仓库浏览主流程。
 * @param {string} configDir - 配置根目录
 * @param {string} repoPath - 仓库路径
 * @returns {Promise<Array<object>>} MR 记录数组（可能为空）
 */
export async function loadMergeRequests(configDir, repoPath) {
  const file = await getStoreFilePath(configDir, repoPath);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    // 文件不存在（首次使用）或不可读，均视为没有 MR
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // JSON 损坏时返回空列表，下一次保存会整体覆盖重写，天然完成自愈
    return [];
  }
}

/**
 * 原子写入指定仓库的 MR 记录列表。
 *
 * 先 mkdir -p 保证目录存在，再写同目录临时文件、fs.rename 原子替换，
 * 避免写入中途崩溃留下半截 JSON；rename 失败时尽力清理临时文件。
 * MR 数据只落配置目录，绝不写入任何 git 跟踪的文件。
 * @param {string} configDir - 配置根目录
 * @param {string} repoPath - 仓库路径
 * @param {Array<object>} mergeRequests - MR 记录数组（整体覆盖写入）
 * @returns {Promise<void>}
 */
export async function saveMergeRequests(configDir, repoPath, mergeRequests) {
  if (!Array.isArray(mergeRequests)) {
    throw new Error('mergeRequests 必须是数组');
  }
  const dir = path.join(configDir, 'merge-requests');
  await fs.mkdir(dir, { recursive: true });
  const file = await getStoreFilePath(configDir, repoPath);
  // 临时文件放同一目录（保证 rename 同文件系统原子生效），带随机后缀避免并发互踩
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(mergeRequests, null, 2), 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    // 写入或替换失败时清理临时文件，不留垃圾；原始错误继续向外抛
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
