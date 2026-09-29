/**
 * 旧应用名默认 userData 目录的一次性状态迁移（契约 §20）。
 *
 * 为什么需要：契约 §20 把应用名统一为「Git Lens」，Electron 默认 userData
 * 目录名随应用名变化，跨启动的窗口几何（window-state.json）与标签存档
 * （tab-state.json）若不搬运会"丢失"（数据实际留在旧目录，新目录读不到，
 * 表现为改名后窗口回到默认尺寸、标签不再恢复）。旧目录名由主进程注入
 * （main.js 的 LEGACY_USER_DATA_DIR_NAME）。服务配置因契约 §5 互通落在
 * ~/.config/git-lens-web，不受影响。
 *
 * 设计要点：
 *  - 保守搬运：只补缺复制，新目录已有同名文件时一律以新目录为准——新目录的
 *    数据来自更近的会话，覆盖回去反而造成回退；旧目录永不删除，改名属可逆
 *    操作，用户若回退旧版本应用仍能读到自己的状态；
 *  - 无迁移标记文件：迁移完成后再次启动时新目录已有同名文件，补缺条件天然
 *    不再成立，判断本身幂等，无需额外落盘标记；
 *  - 纯函数化：不感知 Electron，目录与文件名全部由调用方注入，主进程与冒烟
 *    自验共用同一实现（与 service-config-dir.js 的既有模式一致），保证单测
 *    覆盖与生产行为不漂移。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

/** 受迁移影响的跨启动状态文件清单（契约 §20 冻结） */
export const MIGRATABLE_STATE_FILES = ['window-state.json', 'tab-state.json'];

/**
 * 判断路径是否存在（不区分文件/目录）。
 * @param {string} target - 待检路径
 * @returns {Promise<boolean>}
 */
async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把旧目录中的状态文件补缺复制到新目录（不覆盖、不删除旧目录）。
 * 任何单文件失败只记录日志并跳过，绝不抛出——迁移失败最多元数据丢一轮
 * （回落默认几何/单标签首页），不能因此阻断应用启动。
 * @param {object} options
 * @param {string} options.legacyDir - 旧应用名对应的状态目录（可能不存在）
 * @param {string} options.currentDir - 当前应用名的状态目录
 * @param {string[]} [options.fileNames] - 迁移文件名清单，默认 MIGRATABLE_STATE_FILES
 * @param {(message: string) => void} [options.log] - 日志通道（主进程传 log，测试可注入收集）
 * @returns {Promise<{legacyExists: boolean, copied: string[], skipped: string[]}>}
 *   copied/skipped 为文件名列表；skipped 含「旧目录缺失该文件」与「新目录已
 *   存在同名文件」两种情形
 */
export async function migrateLegacyStateFiles({
  legacyDir,
  currentDir,
  fileNames = MIGRATABLE_STATE_FILES,
  log = () => {},
}) {
  let legacyEntries;
  try {
    legacyEntries = new Set(await fsp.readdir(legacyDir));
  } catch {
    // 旧目录不存在（全新安装或从未以旧应用名运行过）——无需迁移，
    // 也不新建任何目录，保持零副作用
    return { legacyExists: false, copied: [], skipped: [] };
  }
  const copied = [];
  const skipped = [];
  // 新目录可能尚不存在（改名后首次启动 Electron 尚未创建它），复制前按需创建
  let currentDirReady = false;
  for (const name of fileNames) {
    if (!legacyEntries.has(name)) {
      skipped.push(name);
      continue;
    }
    const target = path.join(currentDir, name);
    if (await pathExists(target)) {
      // 新目录已有同名文件：以新目录为准（数据更新），不覆盖
      skipped.push(name);
      continue;
    }
    if (!currentDirReady) {
      await fsp.mkdir(currentDir, { recursive: true });
      currentDirReady = true;
    }
    try {
      await fsp.copyFile(path.join(legacyDir, name), target);
      copied.push(name);
      log(`已从旧状态目录迁移 ${name}（${legacyDir} → ${currentDir}）`);
    } catch (err) {
      log(`迁移 ${name} 失败（忽略，不影响启动）：${err && err.message ? err.message : err}`);
      skipped.push(name);
    }
  }
  return { legacyExists: true, copied, skipped };
}
