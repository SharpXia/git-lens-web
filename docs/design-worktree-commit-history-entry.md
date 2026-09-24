# Worktree 提交记录入口 — 方案设计文档

> 版本: v1.0 | 日期: 2026-09-23 | 状态: **已废弃（备选方案）**
>
> 本文档为「Worktree 提交记录入口」早期的 Tab 式备选设计，**已停止推进**。
> 权威方案见 [`proposals/worktree-commits-entry.md`](proposals/worktree-commits-entry.md)（抽屉式，后端已实现）。
> 本文中有价值的设计点（§4.2 ahead/behind、§4.3 单提交 Diff、§8 边界情况）
> 已并入权威方案 §7 后续迭代规划，仅供追溯。

---

## 1. 背景与目标

当前 git-lens-web 已具备 worktree 列表总览（Overview Tab）和跨 worktree Diff 对比（Diff Tab）两大功能，但缺少对**单个 worktree 提交历史**的查看能力。用户只能看到每个 worktree 的最近一次提交摘要（`lastCommit`），无法回溯该 worktree 分支上的完整提交链路。

**目标**: 为每个 worktree 新增一个"查看提交记录"入口，点击后展示该 worktree 对应分支的 commit history 列表，支持分页加载、提交详情展开、以及与主干的 ahead/behind 对比。

---

## 2. UI 交互原型

### 2.1 入口位置

在 Overview Tab 的 worktree 列表项（`.list-item`）中，现有操作按钮区域新增一个 **"提交记录"** 按钮：

```
┌─────────────────────────────────────────────────────────────────┐
│ 📁 my-feature-worktree                               [main]    │
│    分支: feature/my-feature                                     │
│    /Users/xxd/workspace/.../my-feature-worktree       [📋 Copy] │
│    3 hours ago · 张三 · feat: add user authentication           │
│                                                                 │
│  [未提交 Diff]  [与主干对比]  [📜 提交记录]  [移除]              │
└─────────────────────────────────────────────────────────────────┘
```

按钮样式复用现有 `.action-btn` 类，图标使用 📜 或 SVG commit-log icon。

### 2.2 提交记录视图

点击"提交记录"后，切换至新增的第三 Tab **"Commits"**（与 Overview / Diff 并列），或通过 Modal/Drawer 展示。推荐方案：**新增 Tab**，理由如下：

- 与现有 Tab 切换模式一致，无需引入新的 UI 范式
- 提交记录信息量大，Tab 全页展示空间更充裕
- 用户可在查看提交后直接切换 Diff Tab 进行对比

#### Tab 视图布局

```
┌─────────────────────────────────────────────────────────────────┐
│  [Overview]  [Diff]  [Commits ●]                                │
├─────────────────────────────────────────────────────────────────┤
│  Worktree: my-feature-worktree (feature/my-feature)    [× 关闭] │
│  Ahead of main: 12 commits  |  Behind: 3 commits               │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ● abc1234  feat: add user authentication          3h ago │  │
│  │   张三 <zhangsan@example.com>                             │  │
│  │   3 files changed, +42 -17                                │  │
│  │                                              [展开 ▼]     │  │
│  ├───────────────────────────────────────────────────────────┤  │
│  │ ● def5678  fix: resolve login edge case           1d ago │  │
│  │   张三 <zhangsan@example.com>                             │  │
│  │   1 file changed, +5 -2                                   │  │
│  │                                              [展开 ▼]     │  │
│  ├───────────────────────────────────────────────────────────┤  │
│  │ ● ghi9012  chore: update dependencies             2d ago │  │
│  │   ...                                                     │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│              [加载更多 (next 20)]                                │
└─────────────────────────────────────────────────────────────────┘
```

#### 展开态（Commit Detail）

点击"展开"后，在 commit 条目下方展开详情面板：

```
│  ● abc1234  feat: add user authentication          3h ago     │
│    张三 <zhangsan@example.com>                                 │
│    3 files changed, +42 -17                                   │
│    ┌─────────────────────────────────────────────────────┐    │
│    │  Commit: abc1234567890abcdef                         │    │
│    │  Parent: def567890abcdef1234                         │    │
│    │  Date:   2026-09-23 14:30:00 +0800                   │    │
│    │                                                      │    │
│    │  Files changed:                                      │    │
│    │    M  src/auth/login.js         +30 -12              │    │
│    │    A  src/auth/token.js         +10 -0               │    │
│    │    M  tests/auth.test.js        +2 -5                │    │
│    │                                                      │    │
│    │  [查看 Diff]                                          │    │
│    └─────────────────────────────────────────────────────┘    │
│                                                 [收起 ▲]      │
```

### 2.3 交互流程

```
用户点击 worktree 项的 [提交记录] 按钮
  │
  ├─→ 记录选中 worktree path → 存入全局状态 selectedCommitWorktree
  ├─→ 切换 activeTab = 'commits'
  ├─→ 调用 GET /api/commits?worktree=<path>&limit=20&offset=0
  ├─→ 调用 GET /api/commits/ahead-behind?worktree=<path>&base=<mainBranch>
  │
  ├─→ 渲染 Commits Tab:
  │     ├─ 顶部: worktree 信息 + ahead/behind 统计
  │     ├─ 列表: commit 条目（默认收起）
  │     └─ 底部: "加载更多" 按钮（offset += 20）
  │
  ├─→ 用户点击 [展开]:
  │     └─ 若 commit 详情未缓存，调用 GET /api/commits/<sha>?worktree=<path>
  │        （也可在 list 接口中直接返回完整信息，减少请求数）
  │
  └─→ 用户点击 [查看 Diff]:
        └─ 跳转到 Diff Tab，预设 source=该 commit 的 parent，target=该 commit
           （需新增 API: GET /api/commit-diff?worktree=<path>&sha=<commitSha>）
```

---

## 3. 视图状态管理

### 3.1 新增全局状态变量

在现有全局状态基础上，新增以下变量：

```javascript
// 现有状态
let activeTab = 'overview';  // 新增 'commits' 取值
// 'overview' | 'diff' | 'commits'

// 新增状态
let selectedCommitWorktree = null;  // 当前查看提交记录的 worktree 对象引用
let commitHistory = [];             // 当前已加载的 commit 列表
let commitOffset = 0;               // 当前分页偏移量
let commitHasMore = true;           // 是否还有更多提交
let commitLoading = false;          // 加载中标志
let commitAheadBehind = null;       // { ahead: number, behind: number }
let expandedCommits = new Set();    // 已展开的 commit SHA 集合
```

### 3.2 Tab 切换扩展

`switchTab(tab)` 函数需扩展支持 `'commits'`：

```javascript
function switchTab(tab) {
  activeTab = tab;
  document.getElementById('viewOverview').style.display = tab === 'overview' ? 'block' : 'none';
  document.getElementById('viewDiff').style.display = tab === 'diff' ? 'block' : 'none';
  document.getElementById('viewCommits').style.display = tab === 'commits' ? 'block' : 'none';
  // 更新 tab 按钮高亮 ...
}
```

### 3.3 状态生命周期

| 事件 | 状态变化 |
|------|---------|
| 点击 worktree 的 [提交记录] | `selectedCommitWorktree = wt`; `commitHistory = []`; `commitOffset = 0`; `commitHasMore = true`; `expandedCommits.clear()`; 切换至 commits tab; 触发首次加载 |
| 切换 worktree 仓库 (`selectRepo`) | 重置所有 commit 状态; 若当前在 commits tab，切回 overview |
| 点击 "加载更多" | `commitOffset += 20`; 追加加载 |
| 点击 [展开] | `expandedCommits.add(sha)`; 渲染详情 |
| 点击 [收起] | `expandedCommits.delete(sha)`; 折叠详情 |
| 点击 [× 关闭] | 切回 overview tab; 保留缓存数据（便于回看） |

---

## 4. 后端 API 契约

### 4.1 获取提交列表

```
GET /api/commits?worktree=<worktreePath>&limit=<n>&offset=<n>
```

**参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| worktree | string | 是 | worktree 的绝对路径 |
| limit | number | 否 | 每页条数，默认 20，最大 100 |
| offset | number | 否 | 偏移量，默认 0 |

**响应:**

```jsonc
{
  "ok": true,
  "worktreePath": "/Users/xxd/workspace/.../my-feature-worktree",
  "branch": "feature/my-feature",
  "commits": [
    {
      "sha": "abc1234567890abcdef1234567890abcdef123456",
      "shortSha": "abc1234",
      "subject": "feat: add user authentication",
      "body": "",
      "author": {
        "name": "张三",
        "email": "zhangsan@example.com",
        "date": "2026-09-23T14:30:00+08:00"
      },
      "relativeTime": "3 hours ago",
      "parentShas": ["def567890abcdef1234567890abcdef12345678"],
      "isMerge": false,
      "filesChanged": 3,
      "insertions": 42,
      "deletions": 17
    }
    // ... more commits
  ],
  "hasMore": true,
  "totalReturned": 20
}
```

**底层 Git 命令:**

```bash
# 提交列表（含 stat 统计）
git -C <worktreePath> log \
  --format="%H|%h|%s|%b|%an|%ae|%aI|%P" \
  --numstat \
  --skip=<offset> \
  -n <limit>

# 相对时间通过 JS 端计算（Date.now - author.date）
```

解析策略：
- 使用 `--format` 的固定分隔符 `|` 拆分字段
- `--numstat` 输出跟在每个 commit 后面，用于统计 filesChanged/insertions/deletions
- `body` 字段可能含换行，使用特殊终止符（如 `%x00` NUL 分隔）或改用 `--format=...%x00` 来安全解析

**替代方案（更安全的解析）:**

```bash
git -C <worktreePath> log \
  --format="COMMIT_START%x00%H%x00%h%x00%s%x00%an%x00%ae%x00%aI%x00%P%x00" \
  --numstat \
  --skip=<offset> \
  -n <limit>
```

以 NUL (`\0`) 作为字段分隔符，以 `COMMIT_START` 作为 commit 边界标记，避免 subject/body 中的特殊字符干扰解析。

### 4.2 获取 Ahead/Behind 统计

```
GET /api/commits/ahead-behind?worktree=<worktreePath>&base=<mainBranch>
```

**参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| worktree | string | 是 | worktree 路径 |
| base | string | 否 | 对比基准分支，默认使用仓库 mainBranch |

**响应:**

```jsonc
{
  "ok": true,
  "ahead": 12,
  "behind": 3,
  "baseBranch": "main",
  "worktreeBranch": "feature/my-feature"
}
```

**底层 Git 命令:**

```bash
git -C <worktreePath> rev-list --left-right --count <baseBranch>...HEAD
# 输出: "3\t12" （behind\tahead）
```

### 4.3 获取单个 Commit 的 Diff（可选，按需加载）

```
GET /api/commit-diff?worktree=<worktreePath>&sha=<commitSha>
```

**响应:**

```jsonc
{
  "ok": true,
  "sha": "abc1234567890abcdef",
  "subject": "feat: add user authentication",
  "files": [
    {
      "filePath": "src/auth/login.js",
      "status": "M",
      "added": 30,
      "deleted": 12,
      "isBinary": false,
      "diffChunk": "@@ -10,3 +10,15 @@\n..."
    }
  ],
  "rawDiff": "diff --git a/src/auth/login.js ..."
}
```

**底层 Git 命令:**

```bash
git -C <worktreePath> diff-tree -p --numstat -U3 <sha>
```

### 4.4 错误响应

所有新 API 遵循现有错误格式：

```jsonc
{
  "ok": false,
  "error": "Worktree path does not exist or is not a git repository"
}
```

HTTP 状态码：400（参数错误）、404（worktree 不存在）、500（git 命令执行失败）。

---

## 5. 后端 git-inspector.js 新增函数

### 5.1 getCommits(worktreePath, options)

```javascript
/**
 * @param {string} worktreePath - worktree 绝对路径
 * @param {object} options
 * @param {number} options.limit - 每页条数 (default 20)
 * @param {number} options.offset - 偏移量 (default 0)
 * @returns {Promise<{commits: Array, hasMore: boolean}>}
 */
async function getCommits(worktreePath, { limit = 20, offset = 0 } = {}) {
  // 1. git log --format="..." --numstat --skip=offset -n (limit+1)
  //    多取 1 条用于判断 hasMore
  // 2. 解析 NUL 分隔的输出
  // 3. 统计每个 commit 的 numstat 行
  // 4. 返回 commits 数组（最多 limit 条）+ hasMore 标志
}
```

### 5.2 getAheadBehind(worktreePath, baseBranch)

```javascript
/**
 * @param {string} worktreePath
 * @param {string} baseBranch - 如 "main"
 * @returns {Promise<{ahead: number, behind: number}>}
 */
async function getAheadBehind(worktreePath, baseBranch) {
  // git rev-list --left-right --count main...HEAD
  // 解析 "behind\tahead" 输出
}
```

### 5.3 getCommitDiff(worktreePath, sha)

```javascript
/**
 * @param {string} worktreePath
 * @param {string} sha - 完整 commit SHA
 * @returns {Promise<{files: Array, rawDiff: string}>}
 */
async function getCommitDiff(worktreePath, sha) {
  // git diff-tree -p --numstat -U3 <sha>
  // 复用现有 diff 解析逻辑（参考 getWorktreeDiff 中的 parseDiffOutput）
}
```

---

## 6. 组件架构

### 6.1 新增 HTML 结构

```html
<!-- 新增 Commits Tab 按钮 -->
<button class="tab-btn" onclick="switchTab('commits')">Commits</button>

<!-- 新增 Commits 视图容器 -->
<div id="viewCommits" style="display:none">
  <!-- 顶部信息栏 -->
  <div id="commitsHeader" class="commits-header">
    <!-- worktree 名称、分支、ahead/behind 统计 -->
  </div>

  <!-- 提交列表容器 -->
  <div id="commitsList" class="commits-list">
    <!-- 由 renderCommitsList() 动态填充 -->
  </div>

  <!-- 加载更多 -->
  <div id="commitsLoadMore" class="commits-load-more">
    <button onclick="loadMoreCommits()">加载更多</button>
  </div>
</div>
```

### 6.2 新增渲染函数

| 函数 | 职责 |
|------|------|
| `openCommitHistory(worktreePath)` | 入口：设置状态、切换 Tab、触发首次加载 |
| `loadCommits()` | 调用 API、更新 `commitHistory`、调用渲染 |
| `renderCommitsHeader()` | 渲染顶部 worktree 信息 + ahead/behind |
| `renderCommitsList()` | 遍历 `commitHistory` 渲染每个 commit 条目 |
| `renderCommitItem(commit)` | 渲染单个 commit 条目（含展开/收起） |
| `renderCommitDetail(commit)` | 渲染展开态的 commit 详情面板 |
| `loadMoreCommits()` | offset += limit，追加加载 |

### 6.3 与现有代码的关系

```
index.html
├── <style>
│   ├── ... 现有样式
│   └── /* 新增 */ .commits-header, .commits-list, .commit-item,
│       .commit-detail, .commit-files, .commits-load-more
│
├── <body>
│   ├── .tab-bar
│   │   ├── [Overview] [Diff] [Commits]  ← 新增 tab 按钮
│   │   └── ...
│   ├── #viewOverview
│   │   └── .list-item → [提交记录] 按钮  ← 新增入口
│   ├── #viewDiff
│   │   └── ... (不变)
│   └── #viewCommits  ← 新增视图
│       ├── #commitsHeader
│       ├── #commitsList
│       └── #commitsLoadMore
│
└── <script>
    ├── ... 现有状态与函数
    ├── /* 新增状态 */ selectedCommitWorktree, commitHistory, ...
    ├── /* 新增函数 */ openCommitHistory, loadCommits, renderCommitsList, ...
    └── /* 修改函数 */ switchTab() — 增加 'commits' 分支
```

### 6.4 server.js 路由扩展

```javascript
// 在现有路由注册处新增:
else if (pathname === '/api/commits')           → handleGetCommits(req, res)
else if (pathname === '/api/commits/ahead-behind') → handleGetAheadBehind(req, res)
else if (pathname === '/api/commit-diff')        → handleGetCommitDiff(req, res)
```

---

## 7. 数据流总览

```
┌──────────────────────────────────────────────────────────────┐
│                        Frontend (index.html)                  │
│                                                               │
│  [提交记录] ─→ openCommitHistory(wtPath)                      │
│                    │                                          │
│                    ├→ fetch('/api/commits?worktree=...')       │
│                    ├→ fetch('/api/commits/ahead-behind?...')   │
│                    │                                          │
│                    ▼                                          │
│              renderCommitsList(commits)                        │
│                    │                                          │
│                    ├→ 用户点击 [展开]                           │
│                    │   └→ fetch('/api/commit-diff?sha=...')    │
│                    │       └→ renderCommitDetail(data)         │
│                    │                                          │
│                    └→ 用户点击 [加载更多]                       │
│                        └→ fetch('/api/commits?offset=20...')   │
│                            └→ 追加渲染                         │
└───────────────────────────┬───────────────────────────────────┘
                            │ HTTP (fetch)
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                     Backend (server.js)                       │
│                                                               │
│  /api/commits            → git-inspector.getCommits()         │
│  /api/commits/ahead-behind → git-inspector.getAheadBehind()   │
│  /api/commit-diff        → git-inspector.getCommitDiff()      │
└───────────────────────────┬───────────────────────────────────┘
                            │ child_process.execFile
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                        Git Commands                           │
│                                                               │
│  git log --format=... --numstat --skip=N -n M                 │
│  git rev-list --left-right --count <base>...HEAD              │
│  git diff-tree -p --numstat -U3 <sha>                         │
└──────────────────────────────────────────────────────────────┘
```

---

## 8. 边界情况与注意事项

| 场景 | 处理方式 |
|------|---------|
| Worktree 已断开（existsOnDisk=false） | 禁用 [提交记录] 按钮，tooltip 提示"worktree 已断开" |
| Worktree 处于 detached HEAD | 正常展示提交记录，ahead/behind 对比基准改为 main 分支 HEAD |
| 空分支（无任何提交） | 显示空状态提示："该 worktree 暂无提交记录" |
| 大量提交（1000+） | 分页加载（每次 20 条），不一次性拉取全部 |
| 合并提交（merge commit） | 标记 `isMerge: true`，UI 上显示合并图标；diff 默认使用 first-parent |
| worktree 路径含空格/特殊字符 | API 参数使用 URL encode；git 命令使用 execFile 数组参数（已安全） |
| 并发请求（快速切换 worktree） | 使用 abort controller 或请求 ID 取消过期请求 |

---

## 9. 未来扩展（不在本期范围）

- **提交搜索**: 在 Commits Tab 顶部增加搜索框，支持 `git log --grep` / `--author` 过滤
- **图形化分支历史**: 使用 `git log --graph` 展示分支拓扑
- **Cherry-pick / Revert 操作**: 在 commit 详情中增加操作按钮
- **时间线视图**: 按日期分组展示提交（类似 GitHub 的 commit 列表）
- **WebSocket 实时推送**: 当 worktree 有新提交时自动刷新
