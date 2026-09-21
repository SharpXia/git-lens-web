# Git Lens Web (本地 Git 仓库透镜与 Worktree/分支守卫)

专门用于监控和清理本地 Git 项目冗余、陈旧的分支与 Worktree，防止多 Agent 并行开发和历史残留污染工作区。

## 功能特性

- **多工作区自动发现**：自动扫描 `individualProjects`、`studioProjects` 与 `XxdDevTeam-worktrees` 目录下的所有 Git 仓库。
- **Worktree 深度透视**：
  - 识别 Main 根工作区与派生 Worktree。
  - 自动探测**磁盘已失联但 Git 元数据仍残留**的幽灵 Worktree。
  - 实时检测 Worktree 是否含有未提交修改（Dirty 状态与文件计数）。
  - 支持一键执行 `git worktree prune` 与界面受控安全移除。
- **分支健康与冗余告警**：
  - 区分主分支、普通分支与当前正在被某个 Worktree 挂载使用的分支（防止误删导致工作区断链）。
  - 标记**已合入主分支且无 Worktree 占用的安全可清理分支**。
  - 标记超过 30 天未更新的陈旧活动分支。
  - 提供安全删除与强制删除（`-D`）确认门禁。

## 快速启动

```bash
cd /Users/xxd/workspace/individualProjects/git-lens-web
npm start
# 服务将在 http://127.0.0.1:9527 启动
```
