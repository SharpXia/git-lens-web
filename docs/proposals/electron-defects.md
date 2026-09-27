# Electron 桌面版缺陷登记

> 由协调 Agent 维护。登记格式见契约 §10。新缺陷追加于表尾；修复后状态改为"已关闭（修复提交 SHA）"，并注明复验轮次。

| 编号 | 级别 | 协调 HEAD | OS/arch | run-id / 证据 | 复现 | 预期 / 实际 | 责任 worktree | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DEF-001 | P1（安全边界失效：任意文件越界读取） | 2b86e69（基线即存在） | macOS arm64 | QA 冒烟负向断言 `raw-file-traversal-worktree`，fixture run-id `qa-2026-09-27T16-04-55-352Z-6489b6` | `GET /api/raw-file?repoPath=<repo>&revision=WORKTREE&worktreePath=<worktree>&filePath=../../etc/passwd` 返回 200 与文件内容 | 预期：filePath 解析后必须位于 worktreePath 内，越界返回 4xx / 实际：`path.resolve(worktreePath, filePath)` 直接读盘，无包含性校验 | Runtime（src/git-inspector.js `getFileContentBuffer`） | 已关闭（修复提交 5be6f8a；复验：协调 HEAD 冒烟 22/22 含 400 断言，2026-09-27） |
