/**
 * 桌面模式服务配置目录解析（契约 §5 第三次修订「配置互通」）。
 *
 * 刻意抽成不依赖 Electron 的纯模块：主进程 main.js 与冒烟自验 smoke.mjs 共用
 * 同一实现。规则 2（真实用户默认共享 ~/.config/git-lens-web）无法在自验中整进程
 * 安全验证（会触碰真实用户配置），因此冒烟以注入参数直接调用本函数断言三条规则；
 * 共用实现保证单测覆盖与生产行为一致，不存在「测一套、跑一套」的偏差。
 */

import os from 'node:os';
import path from 'node:path';

/** GIT_LENS_USER_DATA 隔离场景（规则 3）下的配置子目录名，沿用旧版桌面布局 */
export const DESKTOP_CONFIG_SUBDIR = 'git-lens-config';

/**
 * 解析桌面模式服务配置目录，三条规则按序生效，先命中先返回：
 *  1. GIT_LENS_CONFIG_DIR 已设置 → 原样使用该目录（与浏览器版 web 完全同一配置，
 *     实现互通；E2E/QA 亦经此通道保持隔离）；
 *  2. 未设置 GIT_LENS_CONFIG_DIR 且未设置 GIT_LENS_USER_DATA（真实用户启动）
 *     → ~/.config/git-lens-web（与 web 共享同一配置目录，互通为默认行为）；
 *  3. 兜底（GIT_LENS_USER_DATA 隔离场景，如 E2E/smoke）→ <userData>/git-lens-config。
 *
 * @param {object} [inputs] - 解析输入，全部可注入以便测试隔离
 * @param {string|undefined} [inputs.configDirEnv] - GIT_LENS_CONFIG_DIR 环境变量值；
 *   与 web 端语义一致原样使用（不 expand ~、不基于 cwd 重写）
 * @param {string|null|undefined} [inputs.userDataEnv] - GIT_LENS_USER_DATA 环境变量值；
 *   主进程传入模块顶部已 resolve 的 e2eUserDataDir（null/undefined 表示未设置）
 * @param {string} [inputs.home] - 用户主目录；缺省 os.homedir()（测试可注入 mkdtemp，
 *   验证规则 2 时不触碰真实家目录）
 * @returns {string} 服务配置目录（规则 1 为原样值，规则 2/3 为拼接出的绝对路径）
 */
export function resolveServiceConfigDir({ configDirEnv, userDataEnv, home } = {}) {
  // 规则 1：显式指定即与 web 完全同一配置（web 端 CLI 同样原样使用该环境变量值）
  if (configDirEnv) return configDirEnv;
  // 规则 2：真实用户启动，默认与 web 共享 ~/.config/git-lens-web。
  // 跨平台统一为「家目录 + .config/git-lens-web」相对布局，Windows 亦如此，不走 AppData
  if (!userDataEnv) return path.join(home || os.homedir(), '.config', 'git-lens-web');
  // 规则 3：GIT_LENS_USER_DATA 隔离场景（E2E/smoke 等），配置收敛进 userData 内，
  // 保证测试数据绝不外溢到真实用户目录
  return path.join(path.resolve(userDataEnv), DESKTOP_CONFIG_SUBDIR);
}
