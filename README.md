# Git Lens Web (本地 Git 仓库透镜与 Worktree/分支守卫)

专门用于监控和清理本地 Git 项目冗余、陈旧的分支与 Worktree，防止多 Agent 并行开发和历史残留污染工作区。

## 功能特性

- **多工作区自动发现**：自动扫描 `individualProjects`、`studioProjects` 与 `ExampleTeam-worktrees` 目录下的所有 Git 仓库。
- **Worktree 深度透视**：
  - 识别 Main 根工作区与派生 Worktree。
  - 自动探测**磁盘已失联但 Git 元数据仍残留**的幽灵 Worktree。
  - 实时检测 Worktree 是否含有未提交修改（Dirty 状态与文件计数）。
  - 支持一键执行 `git worktree prune` 与界面受控安全移除。
- **Worktree 提交记录入口**：每个 Worktree 条目提供「提交记录」按钮，右侧抽屉展示该分支相对主干（main/master 自动检测）的提交列表，支持渐进加载、hash 点击复制、空状态与错误重试。
- **分支健康与冗余告警**：
  - 区分主分支、普通分支与当前正在被某个 Worktree 挂载使用的分支（防止误删导致工作区断链）。
  - 标记**已合入主分支且无 Worktree 占用的安全可清理分支**。
  - 标记超过 30 天未更新的陈旧活动分支。
  - 提供安全删除与强制删除（`-D`）确认门禁。

## 快速启动

```bash
cd /Users/example/workspace/individualProjects/git-lens-web
npm start
# 服务将在 http://127.0.0.1:9527 启动
```

### 指定端口

端口通过环境变量 `PORT` 指定（默认 `9527`）：

```bash
PORT=8080 npm start
# 或
PORT=8080 node src/server.js
# 服务将在 http://127.0.0.1:8080 启动
```

也可以直接在任意 worktree 目录中启动（服务与运行目录无关，按仓库发现机制扫描工作区）：

```bash
cd /Users/example/workspace/individualProjects/git-lens-web-worktrees/git-lens-web-feat-worktree-commits-entry
PORT=8080 npm start
```

> 提示：若默认端口 9527 已被主工作区的常驻实例占用，验收分支功能时建议用其他端口（如 `PORT=9599`）另起实例，避免两个实例互相干扰。
