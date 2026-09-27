import os from 'node:os';
import path from 'node:path';
import { createGitLensServer } from './git-lens-server.js';

/**
 * 浏览器模式 CLI 入口。职责仅限于读取环境变量并交给服务工厂启动；
 * 全部路由、监听与访问边界逻辑都在 src/git-lens-server.js 的工厂内。
 * `npm start` 对外语义不变：默认 9527、真实配置目录、打印运行地址。
 */

// PORT 允许 0（系统分配随机端口）；空值或非法值回退默认 9527，保持既有启动方式
const parsedPort = Number.parseInt(process.env.PORT ?? '', 10);
const PORT = Number.isInteger(parsedPort) ? parsedPort : 9527;
const HOME = os.homedir();
// 配置目录支持环境变量覆盖：测试实例与真实服务共用 $HOME，若不隔离，
// 测试期间对扫描目录的任何写入都会覆盖用户真实配置（2026-09-25 曾因此覆盖过用户配置）
const CONFIG_DIR = process.env.GIT_LENS_CONFIG_DIR || path.join(HOME, '.config', 'git-lens-web');
// git 路径支持环境变量注入（打包版可能需要绝对路径）；未设置时工厂按默认链解析到 'git'
const GIT_PATH = process.env.GIT_LENS_GIT_PATH || undefined;

const { ready } = createGitLensServer({
  configDir: CONFIG_DIR,
  host: '127.0.0.1',
  port: PORT,
  mode: 'browser',
  gitPath: GIT_PATH
});

try {
  const { host, port } = await ready;
  console.log(`Git Lens Web running on http://${host}:${port}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
