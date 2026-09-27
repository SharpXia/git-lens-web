# Electron 桌面版 G0 契约冻结

> 状态：已冻结（G0）+ 2026-09-27 第一次修订（握手/端口回报/415 例外条款）。本文是 `codex/electron-*` 各工作流的唯一契约来源；修改必须由协调 Agent 提交并通知所有受影响工作流。基线 `main@1cc3e1f`，协调分支 `codex/electron-coordination`。

## 1. 支持平台矩阵（G0 冻结）

| 平台 | 架构 | 首版范围 | 验收状态 |
| --- | --- | --- | --- |
| macOS | arm64、x64 | 交付 | 当前开发机 macOS arm64 可真实验收 |
| Windows | x64 | 交付（以环境到位为前提） | 无真实安装环境，标记**未验收** |
| Linux | x64 | 交付（以环境到位为前提） | 无真实安装环境，标记**未验收** |

签名与公证：macOS 无开发者证书时按 ad-hoc 签名交付并在报告标注；Windows/Linux 同理按实际条件标注"未验收"。未验收平台不列入已交付范围（计划书 §1）。

## 2. 服务工厂契约（Runtime 工作流实现）

### 2.1 模块与导出

新增 `src/git-lens-server.js`，**导入时零副作用**（不创建 server、不监听、不读配置）：

```js
/**
 * 创建 Git Lens HTTP 服务实例。
 * @param {object} options
 * @param {string}   options.configDir            必填；配置目录（扫描目录与本地 MR 数据的根）
 * @param {string}  [options.host='127.0.0.1']    监听地址；桌面版与测试一律环回
 * @param {number}  [options.port=0]              0 = 系统分配随机端口
 * @param {'browser'|'desktop'} [options.mode='browser'] 访问边界模式，见 §4
 * @param {string|null} [options.sessionToken]    desktop 模式必填；browser 模式忽略
 * @param {() => Promise<string|null>} [options.chooseScanDirectory] 覆盖目录选择器；缺省用系统对话框实现
 * @param {string}  [options.gitPath]             git 可执行文件路径；缺省取 GIT_LENS_GIT_PATH，再缺省 'git'
 * @param {number}  [options.requestBodyLimit=2*1024*1024] JSON 请求体字节上限
 * @param {{ runId: string }} [options.handshake] 提供时启用 GET /api/test-handshake（仅测试注入）
 * @param {(level: 'info'|'warn'|'error', message: string) => void} [options.log]
 * @returns {{ server: http.Server, ready: Promise<{host: string, port: number}>, close: () => Promise<void> }}
 */
export function createGitLensServer(options) { ... }
```

- `ready` 在 `listen` 回调后 resolve，携带**实际**监听 host/port（`port: 0` 场景必须回真实端口）。
- `close()`：停止接受新连接 → 等待在途请求结束 → 3 秒超时后强制销毁；幂等，重复调用 resolve 同一结果。
- 端口占用（`EADDRINUSE`）使 `ready` reject，错误信息为可展示的中文。

### 2.2 CLI 入口兼容

`src/server.js` 改为薄 CLI：解析 `PORT`（默认 9527）、`GIT_LENS_CONFIG_DIR`（默认 `~/.config/git-lens-web`）、`GIT_LENS_GIT_PATH`，以 browser 模式调用工厂并监听。**`npm start` 对外语义不变**：默认 9527、真实配置目录、打印 `Git Lens Web running on http://127.0.0.1:9527`。禁止任何代码通过 `import` 现有 `server.js` 启动桌面服务。

**（第一次修订）端口回报格式**：`PORT=0` 时 CLI 必须在 ready 后立即向 stdout 打印同一格式行，携带实际分配端口：`Git Lens Web running on http://127.0.0.1:<实际端口>`。QA 启动器按该行（正则 `(?:127\.0\.0\.1|localhost):(\d+)`）解析端口，此格式为冻结接口。

### 2.3 git 路径注入

`src/git-inspector.js` 的 git 调用改为可注入 `gitPath`（默认值解析顺序：显式参数 > `GIT_LENS_GIT_PATH` > `'git'`），行为默认不变。`src/merge-request-service.js` 若直接调用 git，同样注入。

## 3. 测试模式与握手契约（Runtime 实现，QA 消费）

- 仅当进程环境 `GIT_LENS_TEST_MODE=1` 且工厂传入 `handshake.runId` 时，启用 `GET /api/test-handshake`；两个条件缺一返回 404（生产实例不可探测）。
- **（第一次修订）CLI 环境变量接线**：CLI 以 `GIT_LENS_TEST_MODE=1` 启动时，必须读取环境变量 `GIT_LENS_TEST_RUN_ID` 作为 `handshake.runId` 传入工厂（QA 启动器经 CLI spawn，无法直接传工厂参数）。未设置 `GIT_LENS_TEST_RUN_ID` 时握手保持关闭（404）。
- 响应 `200 {"ok":true,"runId":"<runId>","configDir":"<realpath 后的配置目录>","host":"127.0.0.1","port":<实际端口>,"pid":<进程号>}`；**`pid` 必须是服务进程自身的 pid**（QA 启动器以其与 spawn 子进程 pid 比对）。
- QA 启动器在**发出任何其他请求前**必须完成握手，并核对 `runId`、`configDir` 与本轮 manifest 完全一致；`/api/projects` 成功不构成身份验证。

## 4. 本地 API 访问边界契约

所有模式共同生效（G1 起）：

1. **Host 校验**：`Host` 头必须是 `127.0.0.1:<port>` 或 `localhost:<port>`（port 为本实例实际端口），其余拒绝 403（防 DNS rebinding）。
2. **Origin 校验**：携带 `Origin` 的请求仅接受 `http://127.0.0.1:<port>`、`http://localhost:<port>`；`Origin: null`、`file://`、其他站点一律 403。
3. **移除宽松 CORS**：不再发送 `Access-Control-Allow-Origin: *`；预检仅对本机同源来源放行。
4. **请求体限制**：JSON 请求体超过 `requestBodyLimit` 返回 413；非 JSON `Content-Type` 的 POST 返回 415。
5. **写接口**（POST）逐个保留既有参数校验；`/api/raw-file` 的工作区/仓库路径关系按 §7 复核（见 DEF-001）。

desktop 模式追加：

6. **会话凭据**：每个 /api 请求必须携带 `X-Git-Lens-Session: <token>`；缺失或不符一律 403。token 由 Electron 主进程生成（crypto 随机 ≥32 字节）、仅存主进程，通过 `webRequest.onBeforeSendHeaders`（session 级、仅该窗口来源）附加，**不暴露给页面全局**。
7. **加载方式冻结**：桌面窗口加载 `http://127.0.0.1:<随机端口>/`（同源相对 `/api`），不使用 `file://`。

browser 模式不要求凭据（无主进程可托管 token），但保留 1–5。

**（第一次修订）已批准偏差**：`/api/choose-scan-directory` 在缺失 `Content-Type` 头时放行（既有前端调用未带该头，public/** 归 UI 工作流）；显式提供非 JSON Content-Type 仍 415。UI 工作流为该调用补齐 `'Content-Type': 'application/json'` 后，此偏差在后续门禁中收紧。

## 5. 配置与迁移契约

- browser 模式：`GIT_LENS_CONFIG_DIR` 或 `~/.config/git-lens-web`，语义不变。
- desktop 模式：`<userData>/git-lens-config`（userData = Electron `app.getPath('userData')`）；目录结构沿用现有 `config.json` + 本地 MR 存储。
- `config.json` 冻结新增字段 `configVersion`：旧文件无该字段视为 `1`；桌面版写入 `2`。迁移动作 = 读取旧目录（只读预览 → 用户确认 → 复制）+ 原子写（临时文件 + rename）+ 保留 `<configDir>/migration.json`（记录 fromVersion/at/sourceDir/result）+ 失败保留 `.bak` 可重试。
- 测试时 `userData`、服务 configDir、`GIT_CONFIG_GLOBAL`、`HOME`/`XDG_CONFIG_HOME` 全部指向本轮 qa-root（计划书 §6.1）；禁止读取真实配置做断言。

## 6. preload / IPC 契约（Shell 实现，UI 消费）

preload 暴露且仅暴露以下对象（`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`）：

```js
window.gitLens = {
  isDesktop: true,
  getRuntimeInfo(),   // Promise<{ appVersion, electronVersion, platform, arch, configDir }>
  chooseDirectory(),  // Promise<string|null>，原生 dialog.showOpenDialog
  onServiceState(cb), // 订阅 'ready'|'restarting'|'crashed'|'stopped'，返回取消订阅函数
  openExternal(url),  // Promise<void>；仅 http/https，主进程校验后交系统浏览器
};
```

页面通过 `Boolean(window.gitLens?.isDesktop)` 判定桌面模式；所有 IPC 通道名前缀 `git-lens:`，preload 对参数做类型校验。UI 不得假设 `window.gitLens` 在浏览器模式存在。

## 7. Git 依赖与诊断契约（G2 落地）

- 环境变量 `GIT_LENS_GIT_PATH` 覆盖 git 路径（见 §2.3）。
- 新增 `GET /api/diagnostics`：`{"ok":true,"git":{"found":boolean,"path":string,"version":string|null},"configDir":string,"platform":string,"node":string}`。未找到 git 时 `found:false` 并给出中文修复建议文案由 Shell 呈现。

## 8. QA 协议与 manifest（QA 工作流实现）

### 8.1 qa-root 布局与 manifest 格式

按计划书 §6.1 布局。`manifest.json`：

```json
{
  "runId": "qa-<ISO 时间戳>-<随机后缀>",
  "createdAt": "ISO-8601",
  "qaRoot": "<realpath 后根目录>",
  "allowedPaths": ["<qaRoot>/repos", "<qaRoot>/config", "<qaRoot>/electron-user-data", "<qaRoot>/git-home"],
  "service": { "host": "127.0.0.1", "port": 0, "mode": "browser", "pid": 0 },
  "electron": { "userData": "<qaRoot>/electron-user-data", "mainPid": 0 },
  "versions": { "node": "", "git": "", "electron": "" },
  "commits": { "branch": "", "sha": "" },
  "platform": { "os": "darwin", "arch": "arm64", "release": "" }
}
```

`service.port` 在握手后回填实际值；`pid` 记录服务进程号。测试结束仅清理 manifest 确认的 qa-root。

### 8.2 fail-closed 守卫（任何写操作前强制通过）

1. base-url 仅接受 `http://127.0.0.1:<实际端口>` 字面形态（无路径、查询、尾斜杠、其他主机名），端口不得为 9527。
2. `configDir`、扫描目录、userData、git 写目标经 `realpath` 后必须位于 qa-root 内；拒绝符号链接逃逸、空值、`~/.config/git-lens-web`、仓库源码目录。
3. 握手（§3）成功且三方一致后才放行后续请求。
4. 启动扫描目录为空或仅含本轮 fixture 路径。
5. 守卫自身有单元测试：误传 9527、真实配置路径、`/tmp` 外路径、symlink 逃逸样本必须全部被拒。

### 8.3 验收命令入口

QA 提供单一入口（G0 起为 `npm run test:isolated`；G4 前扩展 `npm run test:desktop:isolated`）：自动建 qa-root、注入环境、启动服务/应用、执行测试、产出 `artifacts/report.json` 与截图。协调 Agent 只调用该入口或其明确定义的阶段参数。既有 `scripts/verify-mr-branch-diff.mjs` 已改造为 fail-closed 版本（强制握手、拒绝 9527、拒绝非环回、仅接受显式且与握手一致的 `--config-dir`、强制 `--run-id`）。

## 9. 文件所有权与本地环境分配

| 工作流 | 分支 | worktree | 独占文件 | 手工联调端口 | 手工配置目录 |
| --- | --- | --- | --- | --- | --- |
| 协调 | `codex/electron-coordination` | `~/.codex/worktrees/electron-coordination/git-lens-web` | 契约文档、`package.json`/lockfile、集成 | 9528 | `/tmp/git-lens-web-dev-9528` |
| Runtime | `codex/electron-runtime` | `~/workspace/individualProjects/glwt-electron/runtime` | `src/**` | 9529 | `/tmp/glwt-electron-runtime/config` |
| QA | `codex/electron-qa` | `~/workspace/individualProjects/glwt-electron/qa` | `test/**`、`scripts/**` | 9530 | `/tmp/glwt-electron-qa/config` |
| Shell | `codex/electron-shell` | `~/workspace/individualProjects/glwt-electron/shell` | `electron/**` | 9531 | `/tmp/glwt-electron-shell/config` |
| UI | `codex/electron-ui` | `~/workspace/individualProjects/glwt-electron/ui` | `public/**` | 9532 | `/tmp/glwt-electron-ui/config` |
| Release | `codex/electron-release` | `~/workspace/individualProjects/glwt-electron/release` | `assets/**`、打包配置、发布文档 | 9533 | `/tmp/glwt-electron-release/config` |

硬约束：9527 主实例与其真实配置任何工作流不得占用或读写；`package.json`/lockfile 只有协调分支可改（执行工作流需要新依赖时向协调 Agent 申请）；两个工作流不得同时编辑同一文件。

## 10. 缺陷记录与合并协议

- 缺陷登记在 `docs/proposals/electron-defects.md`（协调分支维护）：`DEF-<序号> | 级别 P0–P3 | 协调 HEAD | OS/arch | run-id | 复现步骤 | 预期/实际 | 证据 | 责任 worktree | 状态`。
- 合并顺序 Runtime → Shell → UI → QA → Release，全部 `merge --no-ff`；每次合并后在协调 HEAD 跑既有单元测试与隔离冒烟；冲突则 `merge --abort` 并回派原 Agent。
- 每个执行 Agent 的交付包：中文提交信息、提交 SHA、改动文件清单、契约差异、测试命令与原始结果、fixture run-id、已知问题（计划书 §4.2）。

## 11. 基线与工具链

- 基线提交：`main@1cc3e1f`（协调分支 2da6ca3 与其同源）。基线测试结果见 `electron-g0-baseline.md`。
- 工具链：Node v24.21.0、git 2.50.1（Apple Git-155）、macOS 25.4.0 arm64。
- Electron 版本在 Shell 开工时锁定并记入本文附录，lockfile 由协调分支冻结。
