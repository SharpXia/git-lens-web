# Git Lens Web 桌面版发布文档（macOS，Release 工作流 G5）

记录 v1.0.0 macOS 产物的构建方式、签名现状、安装/启动/退出/卸载验证证据，以及升级、回滚与未验收范围。对应计划书 §8（发布、回滚与维护）与契约 §12–§14。

- 发布对象：`Git Lens` v1.0.0（appId `com.sharpxia.git-lens-web`）
- 构建基线：协调分支 `codex/electron-release` @ `ec016d5`
- 构建环境：macOS 26.4（darwin 25.4.0）arm64 · Node v24.21.0 · Electron 44.4.5 · electron-builder 26.15.3（版本已由 `ec016d5` 冻结进 package-lock.json）
- 验证 fixture run-id：`release-install-1790531711408-vj3zzy`（34/34 断言通过）

## 1. 构建命令与复现

```bash
npm ci                 # 注意契约 §12：npm 可能跳过 postinstall，需确认 node_modules/electron/dist/Electron.app 存在
npx electron-builder --mac
```

- 产物输出到 `release/`（已在 .gitignore 忽略，不入库）。
- 无构建步骤、无原生模块：express/cors 为纯 JS 依赖，@electron/rebuild 空转，产物由 lockfile + Electron 官方二进制决定，可复现。
- 附带产物：`*.blockmap`（未来 delta 更新用）与 `latest-mac.yml`（auto-update 清单，当前未启用更新通道，仅留档）。

## 2. 打包配置要点（electron-builder.yml）

| 配置项 | 取值 | 说明 |
| --- | --- | --- |
| appId | `com.sharpxia.git-lens-web` | 反向域名约定，与项目域名归属一致 |
| productName | `Git Lens` | 安装后显示的应用名（窗口标题仍为「Git Lens Web」，由主进程设定） |
| files | `package.json`、`electron/main.js`、`electron/service-main.js`、`electron/preload.cjs`、`src/**`、`public/**` | 白名单式列举：`electron/checks/`（冒烟自验）、`test/`、`scripts/`、`docs/`、`assets/`、`*.md` 均未列入，不进包（计划书 §8：发行包不含测试 fixture 与临时物） |
| 生产依赖 | express、cors 及传递依赖 | 由 electron-builder 依据 package.json/lockfile 自动收集进 asar |
| 入口 | `extraMetadata.main: electron/main.js` | 仓库 package.json 未声明 `main` 字段（保持 CLI 直接运行 `src/server.js` 的形态），打包态入口经 extraMetadata 注入**打包内** package.json，不改仓库根文件 |
| mac.category | `public.app-category.developer-tools` | 面向开发者的本地 Git 仓库透镜，归 developer-tools；utilities 语义过泛，不采用 |
| mac.identity | `"-"` | ad-hoc 打包签名（见 §3） |
| mac.hardenedRuntime | `false` | 未公证无需加固运行时；ad-hoc + hardened runtime 会因库验证（无 TeamID）带来启动风险 |
| target | dmg + zip × arm64 + x64 | zip 为后续 auto-update 与脚本化分发的候选载体 |
| asar | 默认开启 | 打包态实测：主进程/服务子进程 ESM import、preload.cjs、public 静态资源读取在 asar 内全部正常（§5） |

## 3. 签名与 Gatekeeper 现状

**本机无 Apple 开发者证书，当前为 ad-hoc 签名，未公证。**

- 配置为 `mac.identity: "-"`：electron-builder 经 @electron/osx-sign 对整包执行 `codesign --sign -`，产物 `codesign -dv` 显示 `Signature=adhoc`、`TeamIdentifier=not set`、`Identifier=com.sharpxia.git-lens-web`，且 `codesign --verify --deep --strict` 通过（bundle seal 完整）。
- 实测偏差说明：任务书原建议 `mac.identity: null`，实测该取值是**完全跳过签名**——主二进制虽保留上游 linker-signed adhoc，但 electron-builder 改写 Info.plist 后 bundle 校验必失败（`code has no resources but signature indicates they must be present`），故改用 `"-"` 以满足「verify --deep --strict 通过」要求。
- `afterSign` 公证钩子未引入（notarize 未验收）：分发外部的用户首次打开会被 Gatekeeper 拦截，需**右键 → 打开**，或执行 `xattr -cr "/Applications/Git Lens.app"` 后再启动。在取得证书并完成公证验收前，产物仅限本机构建本机使用/可信小范围分发。
- 自动更新（auto-update）未启用（计划书 §8：仅签名渠道启用）：`latest-mac.yml` 为构建副产物，不构成更新通道；升级走手动下载覆盖（§7）。

## 4. 产物清单（SHA-256 / 大小）

| 产物 | 架构 | SHA-256 | 大小 |
| --- | --- | --- | --- |
| `release/git-lens-web-1.0.0-mac-arm64.dmg` | arm64 | `6f80c59885c605ad3c90731d712cc04412178ddce395dc656694cca6b888d4ae` | 127,249,662 B（121.4 MB） |
| `release/git-lens-web-1.0.0-mac-arm64.zip` | arm64 | `503dcc66994aca99c71e0a7dea8f7ad95d5a8a3d51d53aef3d8f0169335c5bb4` | 127,340,099 B（121.4 MB） |
| `release/git-lens-web-1.0.0-mac-x64.dmg` | x64 | `dafd5b395df31a84d6a015e6d533deb3da6b37e981824bccd3aa5bae4f40846c` | 133,973,942 B（127.8 MB） |
| `release/git-lens-web-1.0.0-mac-x64.zip` | x64 | `eddf387ed61a71b395bb98db6458b8af00c6af4de38e478b7f3a6f3510a9ad5a` | 134,094,664 B（127.9 MB） |

zip 产物均通过 `unzip -t` CRC 完整性校验。产物为 ad-hoc 签名，发布前建议在发布系统中登记本表指纹供下载方核对。

## 5. 安装 / 启动 / 退出 / 卸载验证记录（arm64 实机自动化）

验证脚本按 `electron/checks/smoke.mjs` 思路针对打包态改写（临时脚本，未入库；协议如下，结果为 run-id `release-install-1790531711408-vj3zzy`，**34/34 断言通过**）：

1. `hdiutil attach -readonly` 挂载 arm64 DMG 到 mkdtemp 挂载点；
2. `ditto` 复制 `Git Lens.app` 到 `<mkdtemp>/Applications` 试装目录（不碰真实 /Applications；**必须用 ditto**，Node `fsp.cp` 不保留 bundle 封装元数据，会导致 codesign 报 unsealed contents 且 Helper 启动异常——G5 实测发现，见 §9）；
3. 对试装副本执行 `codesign -dv`（Signature=adhoc、appId 正确）与 `--verify --deep --strict`（通过）;
4. 以 playwright `_electron.launch({ executablePath: <试装 .app 二进制> })` 启动打包态应用（契约 §14 工具），注入契约 §13 钩子：`GIT_LENS_USER_DATA`、`GIT_LENS_E2E_READY_FILE`、`GIT_LENS_E2E_TOKEN_FILE`、`GIT_LENS_TEST_MODE=1`、`GIT_LENS_TEST_RUN_ID`，`HOME`/`GIT_CONFIG_GLOBAL`/`XDG_CONFIG_HOME` 全部指向 mkdtemp，并将 `PATH` 截短为 GUI 常见值 `/usr/bin:/bin:/usr/sbin:/sbin` 以模拟 Finder 启动环境；
5. SIGTERM 主进程 → 断言服务退出、无孤儿、端口释放；
6. 删除试装 .app 与 mkdtemp（「卸载」），断言无残留。

逐项结果（关键证据摘要）：

| # | 断言 | 结果 | 证据摘要 |
| --- | --- | --- | --- |
| 1 | DMG 只读挂载/卸载 | PASS | 挂载点 `<mkdtemp>/mnt`，卷内含 `Git Lens.app` 与 Applications 软链 |
| 2 | 试装副本主程序存在 | PASS | `<mkdtemp>/Applications/Git Lens.app/Contents/MacOS/Git Lens` |
| 3 | codesign -dv ad-hoc | PASS | `Signature=adhoc`；`Identifier=com.sharpxia.git-lens-web` |
| 4 | codesign --verify --deep --strict | PASS | 校验通过（构建输出目录与 ditto 副本均通过） |
| 5 | 打包态可启动 | PASS | playwright 拉起 .app 二进制 |
| 6 | 就绪文件出现（asar 内 utilityProcess 启动服务） | PASS | `{"port":60532,"servicePid":72517,"mainPid":72511,"runId":"release-install-1790531711408-vj3zzy"}` |
| 7 | 端口 ≠ 9527 | PASS | port=60532 |
| 8 | 服务为独立进程 | PASS | servicePid≠mainPid；`ps` 显示服务宿主为 `…/Git Lens.app/Contents/Frameworks/Git Lens Helper.app/…`（打包内 Helper） |
| 9 | runId 透传一致 | PASS | 就绪文件与注入值一致 |
| 10 | 无凭据 403 / 错凭据 403 | PASS | `/api/projects` status=403（两次） |
| 11 | 凭据文件写出 / 带凭据 200 | PASS | token `ab524ed6…`；status=200 且 `ok:true` |
| 12 | test-handshake 三方一致 | PASS | runId/pid 一致，configDir 位于隔离 userData：`…/user-data/git-lens-config` |
| 13 | preload 在 asar 内加载（window.gitLens） | PASS | `{"hasGitLens":true,"isDesktop":true}`，四方法齐全（getRuntimeInfo/chooseDirectory/onServiceState/openExternal）——验证手段：playwright `page.evaluate` |
| 14 | getRuntimeInfo（主进程 ESM + IPC） | PASS | `appVersion:"1.0.0"`、`electronVersion:"44.4.5"`、configDir 在隔离 userData 内 |
| 15 | 打包环境 Git 发现（PATH 探测） | PASS | PATH 截短后命中 `/usr/bin/git`（`git version 2.50.1 (Apple Git-155)`），来源「常见安装目录探测」 |
| 16 | asar 内 public 静态资源 | PASS | `/app.js` 200（`text/javascript`）、`/app.css` 200、`/` 200 |
| 17 | CSP 响应头（契约 §14） | PASS | `default-src 'self'; script-src 'self'; …` |
| 18 | SIGTERM 退出协议 | PASS | 主进程 15s 内退出 → servicePid 72517 随之退出（无孤儿）→ 端口 60532 连接拒绝 |
| 19 | 卸载无残留 | PASS | LaunchAgents/LaunchDaemons 无 git-lens 项；/Applications 卸载前后一致（absent）；无孤儿进程；9527 监听快照前后一致（全程未触碰主实例） |

结论：打包态（asar）下 ESM import、utilityProcess、preload.cjs、public 静态资源读取、Git PATH 探测全部正常。

### x64 产物校验（未运行验收）

本机为 arm64，无法运行 x64 产物。已完成的校验：DMG 只读挂载成功、`ditto` 副本 `codesign -dv`（`Signature=adhoc`、`Format=app bundle with Mach-O thin (x86_64)`）、`codesign --verify --deep --strict` 通过、`lipo -archs` 确认主二进制为 x86_64、大小与指纹已登记（§4）。**x64 在 Intel/_rosetta 环境的启动与功能验收待补**。

## 6. 用户安装与卸载说明（当前签名形态）

- 安装：打开 DMG，将 `Git Lens.app` 拖入 Applications；首启因 ad-hoc 签名被 Gatekeeper 拦截时，右键 → 打开，或 `xattr -cr "/Applications/Git Lens.app"`。
- 用户数据位置：`~/Library/Application Support/Git Lens Web/`（窗口状态 `window-state.json`、扫描配置 `git-lens-config/`）。应用不写 LaunchAgents/LaunchDaemons、无后台项（§5 断言 19）。
- 卸载：删除 `/Applications/Git Lens.app`；如需清除配置再删除上述 userData 目录。日志仅记录必要诊断信息，不含仓库源码、Diff 与凭据。

## 7. 升级与回滚方案

**首版（v1.0.0）无升级路径**：不存在更早的正式版，无迁移可验证。auto-update 未启用（计划书 §8：仅签名渠道启用），升级方式为手动下载新版 DMG 覆盖安装。

自下一版本起的升级验证协议（验收前必须逐项执行）：

1. **备份**：记录旧版版本号与 userData（`~/Library/Application Support/Git Lens Web/`）快照（含 `git-lens-config/` 扫描配置与 `window-state.json`）；
2. **升级**：退出旧版（确认无残留进程）→ 覆盖安装新版 .app → 启动；
3. **迁移验证**（契约 §5）：扫描目录列表、收藏等配置在新版中完整可用；userData 内无重复或丢弃的配置文件；
4. **失败回滚**：退出新版 → 恢复备份的 userData → 重装旧版 .app（旧版 DMG 与 SHA-256 留档于发布系统）→ 验证旧版启动与配置完整；
5. 全程以契约 §13 钩子采集新版的 ready/凭据证据，确认迁移期间端口、凭据语义未漂移。

回滚约束（计划书 §8）：更新清单或包校验（SHA-256）失败时，不得替换当前可用版本。

## 8. 未验收清单

| 项 | 现状 | 解锁条件 |
| --- | --- | --- |
| macOS 公证（notarize） | 未做：ad-hoc 签名，Gatekeeper 拦截外部分发 | Apple Developer 账号 + Developer ID 证书 + notarytool 验收 |
| hardened runtime | 关闭（ad-hoc 下无意义且有库验证风险） | 与公证一并开启 |
| auto-update 更新通道 | 未启用；`latest-mac.yml` 仅留档 | 公证通过后按计划书 §8 仅对签名渠道启用，并验收清单校验失败不替换逻辑 |
| x64 运行验收 | 仅挂载/签名/体积校验，未实际运行 | Intel 或 x64 测试机 |
| Windows | 未构建未验收（SmartScreen 方案未定） | 证书 + 分发方案（计划书 §7/§8） |
| Linux | 未构建未验收 | 目标发行版安装与桌面启动验证 |
| 应用图标 | 使用 Electron 默认图标（构建日志明示 `default Electron icon is used`） | 补充正式图标至 `assets/`（TODO，不自造低质量图标） |
| GUI 人工项 | 菜单/对话框/窗口状态恢复等纯 GUI 表现未在打包态人工复验 | 沿用 smoke.mjs 的人工清单在打包态执行 |

## 9. 已知问题与风险

1. **`mac.identity: null` 会跳过签名而非 ad-hoc 签名**（G5 实测）：产物 bundle seal 断裂，`codesign --verify --deep --strict` 失败。已改用 `identity: "-"` 触发真实打包级 ad-hoc 签名，配置内有注释固化该结论。
2. **脚本化复制 .app 必须用 `ditto`**：Node `fsp.cp` 复制的 .app 出现 `unsealed contents present in the root directory of an embedded framework`，且 Helper 启动异常（就绪文件超时）。Finder 拖拽安装不受影响；任何脚本化分发/安装工具需使用 `ditto` 或 Finder 语义复制。
3. **ad-hoc 签名产物不可对外分发**：每台机器从可信渠道获取后仍需绕过 Gatekeeper；公证完成前不得作为正式对外渠道。
4. **默认图标**：当前为 Electron 默认图标，正式发布前必须替换（见 §8）。
5. 构建日志存在无害告警：`author is missed in the package.json`（mac 打包元数据建议项，不影响产物；package.json 为他人所有文件，不在本工作流修改范围）。
6. x64 产物与 macOS 旧版本（本机为 26.4）的实际运行兼容性未验证，发布说明中应向 Intel 用户明示。
