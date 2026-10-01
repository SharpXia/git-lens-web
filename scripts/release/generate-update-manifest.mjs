#!/usr/bin/env node
/** 两个架构在独立 job 构建，发布前按最终产物重新生成更新清单，避免单架构清单覆盖。 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 为最终签名产物生成 electron-updater 可读取的双架构更新清单。
 * @param {string} releaseDir - 产物目录
 * @param {string} version - 应用版本
 * @returns {Promise<object>} 已保存的清单
 */
export async function generateUpdateManifest(releaseDir, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('更新清单只接受正式版本号');
  const files = [];
  for (const arch of ['arm64', 'x64']) {
    for (const ext of ['zip', 'dmg']) {
      const url = `git-lens-web-${version}-mac-${arch}.${ext}`;
      const filePath = path.join(releaseDir, url);
      const { size } = await fs.stat(filePath);
      if (!size) throw new Error(`发布产物为空：${url}`);
      const hash = crypto.createHash('sha512');
      for await (const chunk of createReadStream(filePath)) hash.update(chunk);
      files.push({ url, sha512: hash.digest('base64'), size });
    }
  }
  const manifest = {
    version, files, path: files[0].url, sha512: files[0].sha512,
    releaseDate: new Date().toISOString(),
  };
  // JSON 是 YAML 的子集，无需给发布 job 安装额外依赖。
  await fs.writeFile(path.join(releaseDir, 'latest-mac.yml'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const releaseDir = path.resolve(process.argv[2] || 'release');
  const { version } = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  await generateUpdateManifest(releaseDir, version);
  console.log(`已生成 ${version} 的 macOS 双架构更新清单`);
}
