import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// GUI 的 PATH 通常不含 Homebrew；macOS 的系统入口受 Xcode 许可状态影响，
// 失败后继续探测已安装的 Command Line Tools，避免要求用户修改系统工具链。
const GIT_SEARCH_DIRS = {
  darwin: ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/Library/Developer/CommandLineTools/usr/bin', '/bin', '/usr/sbin', '/sbin'],
  linux: ['/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/snap/bin'],
  win32: ['C:\\Program Files\\Git\\cmd', 'C:\\Program Files (x86)\\Git\\cmd', 'C:\\Git\\cmd'],
};

/**
 * 发现可运行的 Git；显式配置失败时保留结果，避免静默切换用户指定的工具。
 * @param {object} [options] - 可注入环境、平台、日志与探测依赖，便于隔离验证
 * @returns {Promise<{found: boolean, path: string, version: string|null, source: string}>} 发现结果
 */
export async function discoverGit({
  env = process.env,
  platform = process.platform,
  log = () => {},
  execute = execFileAsync,
  checkAccess = access,
} = {}) {
  async function probe(gitPath) {
    try {
      const { stdout } = await execute(gitPath, ['--version'], { timeout: 5000 });
      return { found: true, path: gitPath, version: String(stdout).trim() || null };
    } catch (err) {
      log(`探测 git（${gitPath}）失败：${err.message}`);
      return { found: false, path: gitPath, version: null };
    }
  }

  if (env.GIT_LENS_GIT_PATH) {
    return { ...await probe(env.GIT_LENS_GIT_PATH), source: 'GIT_LENS_GIT_PATH 环境变量' };
  }
  for (const dir of GIT_SEARCH_DIRS[platform] || []) {
    const candidate = path.join(dir, platform === 'win32' ? 'git.exe' : 'git');
    try {
      await checkAccess(candidate, constants.X_OK);
    } catch {
      continue;
    }
    const result = await probe(candidate);
    if (result.found) return { ...result, source: '常见安装目录探测' };
  }
  return { ...await probe('git'), source: 'PATH' };
}

/**
 * 将探测到的 Git 固定传给服务，确保诊断和业务调用使用同一可执行文件。
 * @param {object} gitInfo - discoverGit 的发现结果
 * @param {object} [options] - 原始环境与目标平台
 * @returns {object} 透传并补齐 Git 路径的服务环境
 */
export function buildGitEnvironment(gitInfo, { env = process.env, platform = process.platform } = {}) {
  const separator = platform === 'win32' ? ';' : ':';
  return {
    ...env,
    // 仅调整 PATH 会再次命中失败的 /usr/bin/git，必须传递已探测的完整路径。
    ...(gitInfo.found ? { GIT_LENS_GIT_PATH: gitInfo.path } : {}),
    PATH: [...(GIT_SEARCH_DIRS[platform] || []), env.PATH || ''].filter(Boolean).join(separator),
  };
}
