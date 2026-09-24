<div align="center">

# 🔍 Git Lens Web

**看清本地仓库的 Worktree、分支与代码差异。**

一个在浏览器中运行的本地 Git 工作台：发现闲置工作区，审查变更，再决定是否清理。

[快速开始](#快速开始) · [功能概览](#功能概览) · [使用指南](#使用指南) · [仓库发现范围](#仓库发现范围)

</div>

---

## 为什么使用它

多个分支和 Worktree 并行开发时，容易忘记哪些目录还有未提交改动、哪些分支已合并、哪些 Worktree 只剩 Git 元数据。Git Lens Web 将这些信息集中展示，并提供提交记录和 Diff 视图，帮助你在清理前先确认状态。

## 功能概览

| 模块 | 你可以做什么 |
| --- | --- |
| 📊 仓库总览 | 查看 Worktree 与本地分支数量、失联工作区和冗余分支提示；搜索仓库、分支和 Worktree，并收藏常用仓库。 |
| 🌳 Worktree 管理 | 区分主工作区与派生 Worktree，查看目录是否存在、未提交文件数及领先提交数；清理无效引用或移除指定 Worktree。 |
| 🌿 分支透视 | 识别主分支、被 Worktree 占用的分支、已合并分支，以及超过 30 天未活动的分支；按情况执行普通或强制删除。 |
| ⚡ 代码审查 | 对比两个 Worktree 的已提交、未提交或全量变更；选择同一个 Worktree 时审查本地未提交与未跟踪文件，并支持图片前后对比。 |
| 📋 提交记录 | 从 Worktree 条目打开提交记录，查看相对主干的提交、逐页加载，并复制提交 hash。 |

## 快速开始

**环境要求：**已安装 Git、npm，以及符合 `^20.19.0 || >=22.12.0` 的 Node.js（与仓库锁定依赖的版本要求一致）。

```bash
git clone YOUR_REPOSITORY_URL
cd git-lens-web
npm ci
npm start
```

将 `YOUR_REPOSITORY_URL` 换成 GitHub 页面「Code」菜单中的克隆地址。启动后打开 [http://127.0.0.1:9527](http://127.0.0.1:9527)。

如果 `9527` 已被占用，可指定端口：

```bash
PORT=8080 npm start
```

在 Windows PowerShell 中可使用 `$env:PORT=8080; npm start`。

服务只监听本机 `127.0.0.1`。从主目录或任意 Worktree 启动均可；**启动位置不影响仓库扫描范围**。

## 使用指南

1. **选择仓库**：在顶部下拉框中搜索仓库名或路径；常用仓库可加入星标。
2. **检查状态**：在「仓库总览与管理」查看 Worktree 的 Dirty、失联和领先提交状态，以及分支的合并与占用情况。
3. **审查变更**：点击 Worktree 的「未提交 Diff」「提交记录」或「与主干对比」，也可进入「Worktree 差异对比」自行选择 Base 和 Target。Diff 支持「仅未提交」「全量变更」「仅已提交」三种模式；Base 与 Target 相同时进入本地自审模式。
4. **按需清理**：确认内容后，再使用「一键 Prune 无效引用」、Worktree「移除」或分支「删除」。

> [!CAUTION]
> 清理操作会修改本地 Git 仓库。Worktree「移除」使用 `git worktree remove --force`；未合并分支的「删除」使用 `git branch -D`。操作前请核对目标路径、未提交改动和需要保留的提交。`Prune` 对应 `git worktree prune`，清理的是失效的 Worktree 元数据引用。

## 仓库发现范围

当前版本会从用户主目录下的以下位置查找**直接子目录**中的 Git 仓库：

```text
~/workspace/individualProjects/
~/workspace/studioProjects/
~/workspace/individualProjects/XxdDevTeam-worktrees/
```

扫描位置目前写在 [`src/server.js`](src/server.js) 的 `discoverRepos()` 中。如果页面没有显示你的仓库，请先检查仓库是否位于上述目录的直接子目录；如需扫描其他位置，可调整其中的 `baseDirs`。当前界面没有手动添加任意路径的入口。

## 项目结构

```text
public/index.html       浏览器界面与交互
src/server.js           本地 HTTP 服务、仓库发现与 API
src/git-inspector.js    Git 状态分析、Diff 与清理操作
```

前端使用原生 HTML、CSS 和 JavaScript，服务通过 `npm start` 启动，无需额外构建步骤。
