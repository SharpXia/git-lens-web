# Electron 桌面版 G6 最终验收报告

> 日期：2026-09-27。协调分支 `codex/electron-coordination` @ `e78cc17`（合并序列：Runtime → Shell → UI → QA → Release，全部 `--no-ff`）。基线 `main@1cc3e1f`；主线在执行期间无新提交，无需回并。
> 执行模式：协调 Agent + 4 个常驻执行工作流（Runtime/Shell/UI/QA，Release 一轮制），全部在独立 worktree 与隔离环境进行。

## 1. 门禁结论

| 门禁 | 结论 | 关键证据 |
| --- | --- | --- |
| G0 契约与隔离 | ✅ 通过 | 契约冻结（electron-contracts.md，两次修订）；基线测试 41/41；QA fail-closed 守卫负向用例全绿（9527/真实配置/路径逃逸样本全部拒绝） |
| G1 Runtime | ✅ 通过 | 服务工厂零副作用、CLI 语义回归、随机端口、握手、Host/Origin/凭据拒绝；回归 65/65；测试握手三方一致 |
| G2 桌面壳 | ✅ 通过 | 单实例、服务监督（崩溃自动重启）、preload、窗口状态、退出协议；桌面冒烟 22/22；无孤儿进程 |
| G3 安全 | ✅ 通过 | CSP 头（契约 §14 逐字符）+ 页面零内联脚本/事件；`--strict-csp` 硬断言真实违规=0；DEF-001 路径穿越修复并复验；恶意 Git 元数据纯文本渲染断言通过；导航/新窗/权限全拦截 |
| G4 功能与 UI | ✅ 通过 | 桌面全量 E2E 30 pass / 0 fail / 1 skip（剪贴板降级为绑定断言）；写操作矩阵全部带 git 状态前后断言；视觉基线 12 张逐张审阅通过；回归 108/108 |
| G5 安装与升级（macOS） | ✅ 通过（含未验收项） | arm64 打包态实装 34/34 断言（asar/utilityProcess/preload/静态资源/Git 探测/退出协议）；x64 挂载+签名校验；见 §4 未验收清单 |
| G6 合并验收 | ✅ 本报告 | 缺陷 P0/P1/P2 清零；P3 一项留观（DEF-003）；证据可复核（命令见 §5） |

最终协调 HEAD 全量验收组合（2026-09-27 全部通过）：`node --test test/*.test.mjs` 108/108；`npm run test:isolated` 22/22；`node electron/checks/smoke.mjs` 22/22；`npm run test:desktop:isolated` 16 pass/0 fail/1 skip；`npm run test:desktop:full` 30 pass/0 fail/1 skip。

## 2. 交付物

- **桌面应用（Electron 44.4.5）**：`electron/` 主进程（单实例锁、utilityProcess 服务监督与崩溃恢复、凭据注入、导航/权限管控、原生菜单与目录选择、窗口状态持久化）、`preload.cjs`（契约 §6 受控 IPC）、E2E 钩子（契约 §13）。
- **服务层**：`src/git-lens-server.js` 工厂（可注入配置/凭据/目录选择器/gitPath/静态根，CSP、访问边界、握手、diagnostics、静态资源路由）；`src/server.js` 薄 CLI（`npm start` 语义不变，浏览器模式保留）。
- **页面**：`public/` 外置 `app.js`/`app.css`（CSP 合规）、桌面适配（运行时信息、外链、服务状态遮罩）、Git 元数据转义加固（92 处内联事件迁移为监听器/委托）。
- **QA 基建**：fail-closed 守卫模块与单测、fixture 生成器（含恶意元数据/特殊字符/写操作矩阵素材）、四个验收入口（`test:isolated` / `test:desktop:isolated` / `test:desktop:full` / 桌面壳 smoke）、视觉基线 12 张。
- **打包**：`electron-builder.yml` + 产物 4 件（v1.0.0）：
  | 产物 | 架构 | SHA-256 | 大小 |
  | --- | --- | --- | --- |
  | git-lens-web-1.0.0-mac-arm64.dmg | arm64 | 6f80c59885c605ad3c90731d712cc04412178ddce395dc656694cca6b888d4ae | 127,249,662 B |
  | git-lens-web-1.0.0-mac-arm64.zip | arm64 | 503dcc66994aca99c71e0a7dea8f7ad95d5a8a3d51d53aef3d8f0169335c5bb4 | 127,340,099 B |
  | git-lens-web-1.0.0-mac-x64.dmg | x64 | dafd5b395df31a84d6a015e6d533deb3da6b37e981824bccd3aa5bae4f40846c | 133,973,942 B |
  | git-lens-web-1.0.0-mac-x64.zip | x64 | eddf387ed61a71b395bb98db6458b8af00c6af4de38e478b7f3a6f3510a9ad5a | 134,094,664 B |
- **文档**：契约（含两次修订）、缺陷登记、发布与安装验证文档（electron-release.md）、基线记录、本报告。

## 3. 缺陷与修复轮次

| 编号 | 级别 | 轮次 | 结论 |
| --- | --- | --- | --- |
| DEF-001 | P1 raw-file 工作区路径穿越任意读 | 1 轮修复 + 复验 | 已关闭（5be6f8a，两道 realpath 包含性校验） |
| DEF-002 | P2 崩溃重启后 sessionStorage 丢失 | 1 轮修复 + 复验 | 已关闭（ee6e19c：页面遮罩主路径 + 主进程兜底注入 + 重启同端口复用） |
| DEF-003 | P3 mr-list 截图导航高亮不同步 | 留观 | 疑似 E2E 驱动方式所致；真实点击路径人工验证一次即可关闭 |

过程质量事件（如实记录）：QA 一轮调试中用宽匹配 `pkill -f 'src/server.js'` 误杀 9527 主实例一次，系统守护自动拉起恢复（约数十秒瞬断），真实配置零触碰；后续清理已改为精确路径匹配。另 UI/Runtime 各自披露过一次提交过程中的临时操作失误，均已当场纠正且最终历史干净。

## 4. 未验收范围（如实声明）

- **平台**：Windows x64 与 Linux x64 无真实安装环境，未验收；macOS x64 产物完成挂载与 ad-hoc 签名校验，未实机运行。
- **签名与分发**：无开发者证书，macOS 为 ad-hoc 签名（`codesign --verify --deep --strict` 通过）；公证、hardened runtime、auto-update 通道未启用；对外分发前需用户右键打开或 `xattr -cr`。
- **升级/回滚**：首版无升级路径；下一版升级验证协议已固化在 electron-release.md §7。
- **人工清单**（本机无头环境不可自动化，交付后人工复核）：菜单/快捷键实点、原生目录对话框选择与取消、真实剪贴板内容、多显示器与窗口越界夹紧、系统深浅色、焦点类断言、DEF-003 真实点击验证。
- **已知取舍**：崩溃重启遇端口被外部抢占时回退随机端口，该场景下会话状态不可避免丢失（记日志，生产概率极低）；`style-src 'unsafe-inline'` 保留（页面存在内联 style 属性，收紧需另行清理）。

## 5. 证据复核方式

在协调分支工作树执行（全部隔离运行，不触碰 9527 与真实配置）：

```bash
GIT_LENS_CONFIG_DIR=/tmp/glwt-verify/config node --test test/*.test.mjs   # 108 项
npm run test:isolated                    # web 冒烟 22 项
node electron/checks/smoke.mjs           # 桌面壳 22 断言
npm run test:desktop:isolated            # 桌面隔离 E2E
npm run test:desktop:full                # 桌面全量功能矩阵（含 --strict-csp）
npx electron-builder --mac               # 复现打包产物并比对 SHA-256
```

视觉基线与逐场景报告由各入口的 `--keep` 模式保留于 qa-root `artifacts/`。
