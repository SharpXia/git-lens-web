# GitHub macOS 发布准备

本项目通过 `.github/workflows/release.yml` 构建并发布 macOS 安装包。工作流在推送 `v*` tag 时运行，也可以从 GitHub Actions 手动运行。

## 正式发布需要的 GitHub secrets

正式发布要求同时具备 Developer ID Application 证书和 Apple 公证凭据。Apple Developer 订阅本身不会自动把证书或 App Store Connect 凭据写入 GitHub，需要由仓库维护者配置以下 secrets：

| Secret | 内容 |
| --- | --- |
| `MACOS_CERTIFICATE_BASE64` | 包含私钥的 Developer ID Application `.p12` 文件，经 base64 编码 |
| `MACOS_CERTIFICATE_PASSWORD` | `.p12` 导出密码；证书没有密码时可设为空值 |
| `APPLE_API_KEY_BASE64` | App Store Connect API key `.p8` 文件，经 base64 编码 |
| `APPLE_API_KEY_ID` | API key 的 Key ID |
| `APPLE_API_ISSUER` | App Store Connect API key 的 Issuer ID |

也可以不用 API key，而使用下列三项替代最后三项：

| Secret | 内容 |
| --- | --- |
| `APPLE_ID` | Apple ID 邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 该 Apple ID 的 app-specific password |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

推荐使用 API key。`.p12` 和 `.p8` 的原始文件、密码和私钥不要提交到仓库，也不要写入 workflow 文件。

## 配置凭据示例

在已经安装证书并取得 API key 的 Mac 上，可以这样准备编码文件并写入当前仓库：

```bash
base64 -i DeveloperIDApplication.p12 | gh secret set MACOS_CERTIFICATE_BASE64 -R SharpXia/git-lens-web
gh secret set MACOS_CERTIFICATE_PASSWORD -R SharpXia/git-lens-web
base64 -i AuthKey_ABC123.p8 | gh secret set APPLE_API_KEY_BASE64 -R SharpXia/git-lens-web
gh secret set APPLE_API_KEY_ID -R SharpXia/git-lens-web
gh secret set APPLE_API_ISSUER -R SharpXia/git-lens-web
```

证书可在“钥匙串访问”中导出为 `.p12`；App Store Connect API key 在用户与访问权限页面创建。导出证书时必须选择包含私钥的 Developer ID Application identity，而不是仅导出公钥证书。

## 构建与发布行为

- `macos-14` 构建 arm64，`macos-13` 构建 x64；两个 job 都执行 `npm ci` 和 Electron Builder。
- 正式凭据不完整时，tag 构建会在凭据检查阶段失败，不会创建 Release。
- 手动运行并勾选 `allow_adhoc` 时使用 `electron-builder.local.yml`，发布为 GitHub prerelease。该版本没有 Developer ID 签名或公证，只适合可信小范围验收。
- 发布 job 会生成 `SHA256SUMS.txt`，并将 DMG、zip、blockmap 与校验和一并上传。
- 工作流使用 GitHub Actions 临时目录保存 `.p12`、`.p8` 和构建模式文件；这些文件不会上传为 artifact。

## 本机复现

本机无 Apple 证书时使用 ad-hoc 配置：

```bash
npm ci
npx electron-builder --config electron-builder.local.yml --mac
```

正式 CI 使用默认的 `electron-builder.yml`。该配置不固定 `mac.identity`，由 electron-builder 从 `CSC_LINK` 导入的钥匙串中自动选择 Developer ID Application，并在完整公证凭据存在时调用 notarytool。
