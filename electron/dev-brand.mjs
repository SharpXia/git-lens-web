#!/usr/bin/env node
/**
 * 开发模式品牌补丁（契约 §20）。
 *
 * 为什么需要：dev 模式直接运行 node_modules 内的 Electron.app，macOS 菜单栏、
 * Dock 与程序切换器显示的名字取自该 app bundle 的 Info.plist
 * （CFBundleName / CFBundleDisplayName），默认为「Electron」，与打包版
 * productName「Git Lens」不一致，造成开发与交付品牌分裂。本脚本幂等修补
 * 这两个键为「Git Lens」；npm install 重置 node_modules 后需重跑本脚本。
 * 打包版不依赖此补丁（electron-builder 产物自带正确品牌）。
 *
 * 用法：node electron/dev-brand.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** node_modules 内 Electron.app 的 Info.plist（dev 模式真实运行的 bundle） */
const infoPlistPath = path.resolve(__dirname, '../node_modules/electron/dist/Electron.app/Contents/Info.plist');
const BRAND_NAME = 'Git Lens';
const BRAND_KEYS = ['CFBundleName', 'CFBundleDisplayName'];

function main() {
  if (process.platform !== 'darwin') {
    console.error('此补丁仅适用于 macOS：非 darwin 平台没有 Electron.app 的 Info.plist，');
    console.error('dev 模式应用名由系统任务栏/窗口管理器按其他机制决定，无需修补。');
    console.error('如需与打包版一致的应用名，请用 electron-builder 打包后使用。');
    process.exit(1);
  }
  if (!fs.existsSync(infoPlistPath)) {
    console.error(`未找到 Electron 的 Info.plist：${infoPlistPath}`);
    console.error('请先安装依赖并确保 Electron 二进制完整：');
    console.error('  npm install && node node_modules/electron/install.js（契约 §12 已知坑）');
    process.exit(1);
  }
  for (const key of BRAND_KEYS) {
    // plutil -replace 天然幂等：键存在则改值、不存在则创建，重复执行无副作用
    execFileSync('plutil', ['-replace', key, '-string', BRAND_NAME, infoPlistPath]);
  }
  console.log(`开发模式应用名已设为 ${BRAND_NAME}（重装依赖后需重跑：node electron/dev-brand.mjs）`);
}

// 仅直接执行时生效；被 import（如冒烟自验静态走查）时不产生任何副作用
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
