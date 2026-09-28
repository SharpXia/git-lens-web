# Electron 桌面版缺陷登记

> 由协调 Agent 维护。登记格式见契约 §10。新缺陷追加于表尾；修复后状态改为"已关闭（修复提交 SHA）"，并注明复验轮次。

| 编号 | 级别 | 协调 HEAD | OS/arch | run-id / 证据 | 复现 | 预期 / 实际 | 责任 worktree | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DEF-001 | P1（安全边界失效：任意文件越界读取） | 2b86e69（基线即存在） | macOS arm64 | QA 冒烟负向断言 `raw-file-traversal-worktree`，fixture run-id `qa-2026-09-27T16-04-55-352Z-6489b6` | `GET /api/raw-file?repoPath=<repo>&revision=WORKTREE&worktreePath=<worktree>&filePath=../../etc/passwd` 返回 200 与文件内容 | 预期：filePath 解析后必须位于 worktreePath 内，越界返回 4xx / 实际：`path.resolve(worktreePath, filePath)` 直接读盘，无包含性校验 | Runtime（src/git-inspector.js `getFileContentBuffer`） | 已关闭（修复提交 5be6f8a；复验：协调 HEAD 冒烟 22/22 含 400 断言，2026-09-27） |
| DEF-002 | P2（恢复失败：崩溃自动重启后页面会话状态丢失） | cff1dc5 | macOS arm64 | QA 桌面全量 E2E `test:desktop:full` 场景 e2b，qa-root `git-lens-qa-RHztp9`（--keep 轮） | 选中非默认仓库 → kill -9 服务 → 自动重启切回应用页 → 选中仓库回退默认值 | 预期：恢复后保持崩溃前选中仓库（sessionStorage `repo=repo-main`）/ 实际：恢复页为 data: URL，导航触发 browsing context group 交换丢弃 sessionStorage，重启后被默认值覆盖 | Shell（electron/main.js 恢复页机制） | 已关闭（修复提交 ee6e19c：页面遮罩主路径 + executeJavaScript 兜底 + 重启同端口复用；复验：协调 HEAD e78cc17 上 `test:desktop:full` 30/0/1，e2b 断言转绿，2026-09-27） |
| DEF-003 | P3（视觉：mr-list 截图中导航高亮与内容区不同步） | e78cc17 | macOS arm64 | 视觉基线 `g4-m-mr-list.png`（qa-root `git-lens-qa-h7XrsL`） | 视觉审阅发现：内容区为 MR 列表，导航高亮停在「Worktree 差异对比」 | 疑似 E2E 直接调用内部 switchTab 函数而非真实点击 tab 所致（G3 轮真实点击路径截图中 MR tab 高亮正确）；非阻断 | UI/QA 联合确认 | 审阅结论：留观项，不阻断交付；G4 人工清单中用真实点击验证一次即可关闭 |
