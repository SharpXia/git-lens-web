# Worktree 提交记录入口方案设计

> 版本: v2.0 | 日期: 2026-09-24 | 状态: 开发中（后端已实现并验证，前端待实现）

> 本文档为「Worktree 提交记录入口」的唯一权威方案。早期的 Tab 式备选方案
> (`../design-worktree-commit-history-entry.md`) 已废弃，其有价值的设计点
> （ahead/behind 统计、提交详情展开、单提交 Diff）已并入本文 §7 后续迭代。

## 0. 实施状态

| 模块 | 状态 | 说明 |
|------|------|------|
| `src/git-inspector.js` — `getWorktreeCommits()` | ✅ 已实现 | limit/offset 分页、base 自动检测、orphan 降级、NUL 安全分隔解析 |
| `src/server.js` — `GET /api/worktree-commits` | ✅ 已实现 | 400（缺参/路径/base 非法）、404（路径不存在）、500（git 失败）|
| 路径安全（§3.3.1/§3.3.2） | ✅ 已实现 | 绝对路径校验、目录存在性 stat 校验、base 字符白名单（拒绝 `..`）|
| `public/index.html` — 抽屉 UI（§4） | ⏳ 进行中 | 本分支接续开发 |

**已验证行为**（2026-09-24 冒烟测试）:
- 正常分支: `branch`/`head`/`base=main`/`totalCommits`/`commits[]` 全字段正确
- 领先 base 的 worktree: `totalCommits=1`, `hasMore=false`
- 主工作区（HEAD == main）: `totalCommits=0` → 前端需渲染空状态（§2.3.4）
- `worktree=/tmp/xxx` → 404 `指定的 worktree 路径不存在`
- `worktree=relative/path` → 400；`base=../etc` → 400

---

## 1. 现有架构现状分析

### 1.1 整体架构

git-lens-web 采用经典三层架构：静态 HTML 前端 + Node.js HTTP 后端 + Git CLI 数据层。

```
┌──────────────────────────────────────────────────┐
│  public/index.html (单文件 SPA, 内联 CSS + JS)     │
│  - 原生 DOM 操作, 无框架依赖                         │
│  - GitHub 暗色主题, CSS 自定义属性                    │
└──────────────────┬───────────────────────────────┘
                   │ HTTP (fetch)
┌──────────────────▼───────────────────────────────┐
│  src/server.js (node:http, 端口 9527)              │
│  - if/else 路由链, 无 Router 库                     │
│  - CORS 全开放, readJson() 解析 POST body          │
└──────────────────┬───────────────────────────────┘
                   │ execFile (promisified)
┌──────────────────▼───────────────────────────────┐
│  src/git-inspector.js                             │
│  - runGit(cwd, args) 统一封装                      │
│  - porcelain 格式解析                               │
│  - maxBuffer: 20MB                                │
└──────────────────────────────────────────────────┘
```

### 1.2 现有 Worktree 展示方式

Worktree 以**垂直列表**形式渲染在 Overview 面板左侧（`#wtList`），每个条目为 `.list-item` 行：

| 区域 | 内容 |
|------|------|
| 左侧 `.item-main` | 文件夹图标 + 目录名 + 徽章标签（Main 工作区 / 分支名 / 磁盘已失联 / 未提交修改 / 已加锁）|
| 路径区 `.item-path-box` | 完整文件系统路径 + 复制按钮 |
| 提交信息行 | 最近一次 commit 的相对时间、作者、subject |
| 右侧 `.item-actions` | "未提交 Diff" 按钮 / "与主干对比" 按钮 / "移除" 按钮 |

### 1.3 现有交互模式

- **无弹窗/抽屉** — 所有交互通过 `confirm()` 和 `alert()` 完成
- **Tab 切换** — Overview / Diff 两个视图通过 `display: block/none` 切换
- **手风琴折叠** — Diff 视图中的文件卡片支持展开/收起
- **自定义下拉** — 仓库选择器使用绝对定位下拉面板 + 模糊搜索 + 星标收藏
- **动画删除** — 条目删除时淡出 + 右滑 20px（250ms）

### 1.4 现有 API 端点

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/projects` | 发现仓库列表 |
| GET | `/api/inspect` | 仓库全量分析（worktrees + branches） |
| POST | `/api/delete-branch` | 删除分支 |
| POST | `/api/remove-worktree` | 移除 worktree |
| GET | `/api/check-branch` | 检查分支是否存在 |
| GET | `/api/check-worktree` | 检查 worktree 是否存在 |
| GET | `/api/diff-worktrees` | 两个 worktree 三点 diff |
| GET | `/api/uncommitted-diff` | 未提交变更 diff |
| POST | `/api/prune-worktrees` | 清理无效 worktree 引用 |

### 1.5 现有 Git 命令封装模式

```javascript
// 统一的 git 命令执行器
async function runGit(cwd, args) {
  const { stdout } = await exec('git', args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024
  });
  return stdout.trim();
}
```

关键特征：
- 使用 `execFile`（非 `exec`），参数以数组传递，无 shell 注入风险
- 所有函数接收 `repoPath` 或 `worktreePath` 作为 cwd
- porcelain / format 字符串解析返回结构化数据

---

## 2. Worktree 提交记录入口 — 触发场景与交互设计

### 2.1 触发场景

| # | 场景 | 用户意图 | 触发位置 |
|---|------|----------|----------|
| 1 | 查看某 worktree 的完整提交历史 | 了解该分支做了什么 | worktree 条目右侧操作区 |
| 2 | 对比两个 worktree 的提交差异 | 确认哪些 commit 是目标独有的 | Diff 面板的提交对比入口（后续扩展） |
| 3 | 查看某 worktree 最近几次提交 | 快速确认最新进展 | worktree 条目中已有的 lastCommit 行点击展开 |

**本方案聚焦场景 1**，场景 2/3 作为后续扩展点预留接口。

### 2.2 入口位置

在 worktree 条目右侧操作区（`.item-actions`）新增一个 **"提交记录"** 按钮，位于 "未提交 Diff" 和 "与主干对比" 之间：

```
┌─────────────────────────────────────────────────────────┐
│ 📁 example-team/feature-xxx          [Main] [feature-xxx] │
│ /path/to/worktree                           [复制]       │
│ 2 hours ago · xxd · feat: add commit log viewer         │
│                                                          │
│  [未提交 Diff (3)]  [提交记录]  [与主干对比]  [移除]      │
└─────────────────────────────────────────────────────────┘
```

按钮样式：与 "与主干对比" 一致的次要按钮风格（`btn-secondary`），图标使用 `📋` 或 SVG 历史图标。

### 2.3 展现形式 — 抽屉式提交日志面板

**选择抽屉（Drawer）而非弹窗（Modal）的理由：**

1. 与现有 Tab 切换模式一致，不引入新交互范式
2. 抽屉可从右侧滑入，不遮挡 worktree 列表上下文
3. 用户可边查看提交记录边参考 worktree 列表信息
4. 关闭后自然回到原位置，无需管理弹窗堆叠

#### 2.3.1 抽屉布局原型

```
┌────────────────────────────────────────┬──────────────────────────┐
│                                        │  ← 滑入抽屉 (420px) →    │
│  Worktree 列表 (保持不变)                │                          │
│                                        │  ┌────────────────────┐  │
│  ┌────────────────────┐               │  │ 📋 提交记录          │  │
│  │ 📁 worktree-A      │               │  │ feature-xxx         │  │
│  │ [提交记录] [对比]... │               │  │                    │  │
│  └────────────────────┘               │  │ [x] 关闭            │  │
│                                        │  ├────────────────────┤  │
│  ┌────────────────────┐               │  │ 分支: feature-xxx  │  │
│  │ 📁 worktree-B      │               │  │ HEAD: a1b2c3d      │  │
│  │ [提交记录] [对比]... │               │  │ 共 42 条提交        │  │
│  └────────────────────┘               │  ├────────────────────┤  │
│                                        │  │                    │  │
│                                        │  │ ● a1b2c3d  2h ago  │  │
│                                        │  │   feat: add viewer │  │
│                                        │  │   xxd              │  │
│                                        │  │                    │  │
│                                        │  │ ● e4f5g6h  5h ago  │  │
│                                        │  │   fix: edge case   │  │
│                                        │  │   xxd              │  │
│                                        │  │                    │  │
│                                        │  │ ...更多提交...       │  │
│                                        │  │                    │  │
│                                        │  │ [加载更多 (20条)]   │  │
│                                        │  └────────────────────┘  │
└────────────────────────────────────────┴──────────────────────────┘
```

#### 2.3.2 抽屉头部

| 元素 | 说明 |
|------|------|
| 标题 | "提交记录" |
| 分支名 | 当前 worktree 绑定的分支名（蓝色徽章） |
| HEAD 缩写 | 当前 HEAD commit short hash（`git log -1 --format=%h`） |
| 总提交数 | 该分支相对 main 的 commit 数量 |
| 关闭按钮 | 右上角 `×`，点击后抽屉向右滑出 |

#### 2.3.3 提交条目样式

每条提交记录渲染为卡片式条目：

```
┌──────────────────────────────────┐
│ ● a1b2c3d          2 hours ago  │  ← hash (可点击复制) + 相对时间
│ feat: add commit log viewer      │  ← commit subject (单行截断)
│ xxd                              │  ← 作者名
└──────────────────────────────────┘
```

- hash 使用等宽字体，颜色 `#58a6ff`（链接蓝）
- 点击 hash 可复制完整 SHA 到剪贴板（复用已有的剪贴板复制逻辑）
- subject 单行溢出省略（`text-overflow: ellipsis`）
- hover 时整行背景微亮（`#1c2128`）

#### 2.3.4 空状态设计

当 worktree 没有额外提交（即 HEAD 与 main 相同）时：

```
┌──────────────────────────────────┐
│                                  │
│         📋 (大图标, 48px)         │
│                                  │
│    该分支暂无额外提交              │
│    HEAD 与 main 分支指向同一提交   │
│                                  │
└──────────────────────────────────┘
```

#### 2.3.5 分页 / 条数限制策略

采用**渐进加载**（非传统分页），策略如下：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 首次加载条数 | 30 | 覆盖大多数日常分支 |
| "加载更多"增量 | 20 | 每次点击追加 20 条 |
| 单次请求上限 | 100 | 后端硬限制，防止超大响应 |
| 总提交数显示 | 精确值 | 通过 `git rev-list --count` 获取 |

"加载更多" 按钮在抽屉底部，点击后追加渲染新提交。当所有提交已加载完毕时，按钮变为 "已显示全部提交"（灰色不可点击）。

---

## 3. 后端 API 规格设计

### 3.1 新增端点：`GET /api/worktree-commits`

#### 请求参数（Query String）

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `worktree` | string | 是 | — | worktree 的绝对路径 |
| `limit` | integer | 否 | 30 | 返回提交条数，范围 [1, 100] |
| `offset` | integer | 否 | 0 | 跳过前 N 条提交（分页偏移） |
| `base` | string | 否 | 自动检测 | 基准分支/引用，用于计算"额外提交"。不传时自动检测 main 分支 |

#### 请求示例

```
GET /api/worktree-commits?worktree=/Users/example/workspace/individualProjects/git-lens-web-worktrees/feature-xxx&limit=30&offset=0
```

#### 响应 JSON 格式

**成功响应 (200):**

```json
{
  "ok": true,
  "worktreePath": "/Users/example/workspace/.../feature-xxx",
  "branch": "feature-xxx",
  "head": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  "base": "main",
  "totalCommits": 42,
  "commits": [
    {
      "hash": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      "shortHash": "a1b2c3d",
      "author": "xxd",
      "authorEmail": "xxd@example.com",
      "date": "2026-09-23T10:30:00+08:00",
      "relativeTime": "2 hours ago",
      "subject": "feat: add commit log viewer",
      "body": ""
    }
  ],
  "hasMore": true,
  "returnedCount": 30
}
```

**字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | boolean | 请求是否成功 |
| `worktreePath` | string | 请求的 worktree 路径 |
| `branch` | string | worktree 绑定的分支名 |
| `head` | string | 当前 HEAD 完整 SHA |
| `base` | string | 使用的基准引用 |
| `totalCommits` | integer | 该分支相对 base 的总提交数 |
| `commits` | array | 提交记录数组 |
| `commits[].hash` | string | 完整 commit SHA |
| `commits[].shortHash` | string | 短 hash（7 字符） |
| `commits[].author` | string | 作者名 |
| `commits[].authorEmail` | string | 作者邮箱 |
| `commits[].date` | string | ISO 8601 格式提交时间 |
| `commits[].relativeTime` | string | 相对时间（如 "2 hours ago"） |
| `commits[].subject` | string | 提交标题（第一行） |
| `commits[].body` | string | 提交正文（除标题外的部分，可为空） |
| `hasMore` | boolean | 是否还有更多提交可加载 |
| `returnedCount` | integer | 本次返回的提交条数 |

**错误响应 (400):**

```json
{
  "ok": false,
  "error": "worktree 路径不能为空"
}
```

**错误响应 (404):**

```json
{
  "ok": false,
  "error": "指定的 worktree 路径不存在"
}
```

### 3.2 底层 Git 命令封装

在 `src/git-inspector.js` 中新增 `getWorktreeCommits()` 函数：

```javascript
/**
 * 获取 worktree 的提交记录
 * @param {string} worktreePath - worktree 绝对路径
 * @param {object} options
 * @param {number} options.limit - 返回条数 (1-100, 默认 30)
 * @param {number} options.offset - 偏移量 (默认 0)
 * @param {string} [options.base] - 基准分支 (不传则自动检测)
 * @returns {Promise<WorktreeCommitsResult>}
 */
async function getWorktreeCommits(worktreePath, options = {}) {
  const limit = Math.min(Math.max(parseInt(options.limit) || 30, 1), 100);
  const offset = Math.max(parseInt(options.offset) || 0, 0);
  
  // 1. 验证 worktree 路径有效性
  // 2. 解析 worktree 信息 (分支名, HEAD)
  // 3. 自动检测 base 分支 (复用 getBranches 的 mainBranch 检测逻辑)
  // 4. 获取总提交数: git rev-list --count <base>..<head>
  // 5. 获取提交列表: git log --format=... --skip=<offset> --max-count=<limit> <base>..<head>
  // 6. 解析并返回结构化数据
}
```

#### Git 命令详情

**步骤 1 — 获取 worktree 基本信息：**

```bash
git worktree list --porcelain
```

从输出中定位匹配 `worktreePath` 的条目，提取 `branch` 和 `HEAD`。

**步骤 2 — 自动检测 base 分支：**

```bash
git symbolic-ref refs/remotes/origin/HEAD
```

回退策略（与现有 `getBranches()` 一致）：
1. 检查 `origin/HEAD` 指向
2. 尝试 `main`
3. 尝试 `master`

**步骤 3 — 获取总提交数：**

```bash
git rev-list --count <base>..<worktree-branch>
```

如果 `<base>` 和 `<worktree-branch>` 没有共同祖先（orphan 分支），则回退为：

```bash
git rev-list --count HEAD
```

**步骤 4 — 获取提交列表：**

```bash
git log <base>..<worktree-branch> \
  --format=%H|%h|%an|%ae|%aI|%cr|%s|%b---END--- \
  --skip=<offset> \
  --max-count=<limit> \
  -z
```

使用 `%x00`（NUL 分隔符）或自定义分隔符避免 subject/body 中的管道符冲突。

**推荐的安全格式（使用 NUL 分隔）：**

```bash
git log <base>..<worktree-branch> \
  --format=%H%n%h%n%an%n%ae%n%aI%n%cr%n%s%n%b%n---COMMIT_END--- \
  --skip=<offset> \
  --max-count=<limit>
```

### 3.3 边界安全处理

#### 3.3.1 路径安全

```javascript
// 1. 路径必须是绝对路径
if (!path.isAbsolute(worktreePath)) {
  return { ok: false, error: 'worktree 路径必须为绝对路径', status: 400 };
}

// 2. 路径规范化，防止 ../ 穿越
const normalized = path.normalize(worktreePath);
if (normalized !== worktreePath) {
  return { ok: false, error: '路径包含非法的目录遍历', status: 400 };
}

// 3. 验证路径确实在已注册的 worktree 列表中
const worktrees = await getWorktrees(repoPath);
const matched = worktrees.find(wt => wt.path === normalized);
if (!matched) {
  return { ok: false, error: '指定的 worktree 路径不存在', status: 404 };
}
```

#### 3.3.2 参数校验

```javascript
// limit 范围限制
const limit = Math.min(Math.max(parseInt(query.limit) || 30, 1), 100);

// offset 非负
const offset = Math.max(parseInt(query.offset) || 0, 0);

// base 分支名安全校验 — 仅允许合法 git ref 字符
if (base && !/^[a-zA-Z0-9_\/\-.]+$/.test(base)) {
  return { ok: false, error: 'base 参数包含非法字符', status: 400 };
}
```

#### 3.3.3 Git 命令超时

```javascript
const { stdout } = await exec('git', args, {
  cwd: worktreePath,
  maxBuffer: 20 * 1024 * 1024,
  timeout: 30_000  // 30 秒超时
});
```

#### 3.3.4 异常场景处理

| 异常场景 | 处理方式 | HTTP 状态码 |
|----------|----------|------------|
| worktree 路径不存在 | 返回错误提示 | 404 |
| worktree 磁盘已失联 | 返回错误提示 "磁盘不可用" | 422 |
| base 分支不存在 | 回退为 `git log HEAD` 显示全部提交 | 200 (降级) |
| orphan 分支（无共同祖先） | 回退为显示全部提交 | 200 (降级) |
| git 命令超时 | 返回超时错误 | 504 |
| limit/offset 非法值 | 返回参数校验错误 | 400 |
| 空仓库（无任何提交） | 返回空 commits 数组 | 200 |
| worktree 为 bare 类型 | 返回错误提示 "不支持 bare worktree" | 400 |

---

## 4. 前端实现原型

### 4.1 新增 DOM 结构

```html
<!-- 抽屉遮罩层 -->
<div id="commitsDrawerOverlay" class="drawer-overlay" style="display:none">
</div>

<!-- 提交记录抽屉 -->
<div id="commitsDrawer" class="drawer drawer-right" style="display:none">
  <div class="drawer-header">
    <h3>📋 提交记录</h3>
    <button class="drawer-close" onclick="closeCommitsDrawer()">×</button>
  </div>
  <div class="drawer-meta" id="commitsDrawerMeta">
    <!-- 分支名徽章 + HEAD hash + 总提交数 -->
  </div>
  <div class="drawer-body" id="commitsDrawerBody">
    <!-- 提交列表 或 空状态 或 加载指示器 -->
  </div>
  <div class="drawer-footer" id="commitsDrawerFooter" style="display:none">
    <button id="loadMoreCommitsBtn" class="btn-secondary" onclick="loadMoreCommits()">
      加载更多
    </button>
  </div>
</div>
```

### 4.2 新增 CSS 样式

```css
/* 抽屉遮罩 */
.drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 900;
  animation: fadeIn 200ms ease;
}

/* 右侧抽屉 */
.drawer-right {
  position: fixed;
  top: 0;
  right: 0;
  width: 420px;
  height: 100vh;
  background: var(--bg-card, #161b22);
  border-left: 1px solid var(--border-primary, #30363d);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform 250ms ease;
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.3);
}

.drawer-right.open {
  transform: translateX(0);
}

/* 抽屉头部 */
.drawer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-primary, #30363d);
}

.drawer-header h3 {
  margin: 0;
  font-size: 16px;
}

.drawer-close {
  background: none;
  border: none;
  color: var(--text-secondary, #8b949e);
  font-size: 20px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
}

.drawer-close:hover {
  background: var(--bg-hover, #1c2128);
  color: var(--text-primary, #c9d1d9);
}

/* 抽屉元信息 */
.drawer-meta {
  padding: 12px 20px;
  border-bottom: 1px solid var(--border-primary, #30363d);
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: var(--text-secondary, #8b949e);
}

/* 抽屉内容区 */
.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 20px;
}

/* 提交条目 */
.commit-item {
  padding: 12px;
  border: 1px solid var(--border-primary, #30363d);
  border-radius: 8px;
  margin-bottom: 8px;
  transition: background 150ms;
}

.commit-item:hover {
  background: var(--bg-hover, #1c2128);
}

.commit-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.commit-hash {
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  color: var(--accent, #58a6ff);
  cursor: pointer;
}

.commit-hash:hover {
  text-decoration: underline;
}

.commit-time {
  font-size: 12px;
  color: var(--text-tertiary, #6e7681);
}

.commit-subject {
  font-size: 14px;
  color: var(--text-primary, #c9d1d9);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 4px;
}

.commit-author {
  font-size: 12px;
  color: var(--text-secondary, #8b949e);
}

/* 抽屉底部 */
.drawer-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--border-primary, #30363d);
  text-align: center;
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 20px;
  color: var(--text-secondary, #8b949e);
  text-align: center;
}

.empty-state-icon {
  font-size: 48px;
  margin-bottom: 16px;
  opacity: 0.5;
}

/* 加载状态 */
.loading-spinner {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  color: var(--text-secondary, #8b949e);
}
```

### 4.3 新增 JavaScript 函数

```javascript
// ---- 抽屉状态 ----
let commitsDrawerState = {
  worktreePath: null,
  branch: null,
  base: null,
  totalCommits: 0,
  loadedCount: 0,
  limit: 30,
  isOpen: false
};

// ---- 打开抽屉 ----
async function openCommitsDrawer(worktreePath) {
  commitsDrawerState = {
    worktreePath,
    branch: null,
    base: null,
    totalCommits: 0,
    loadedCount: 0,
    limit: 30,
    isOpen: true
  };

  // 显示遮罩和抽屉
  document.getElementById('commitsDrawerOverlay').style.display = 'block';
  const drawer = document.getElementById('commitsDrawer');
  drawer.style.display = 'flex';
  requestAnimationFrame(() => drawer.classList.add('open'));

  // 显示加载状态
  document.getElementById('commitsDrawerBody').innerHTML =
    '<div class="loading-spinner">加载中...</div>';
  document.getElementById('commitsDrawerFooter').style.display = 'none';

  try {
    await fetchAndRenderCommits();
  } catch (err) {
    document.getElementById('commitsDrawerBody').innerHTML =
      `<div class="empty-state">
        <div class="empty-state-icon">⚠️</div>
        <div>加载失败: ${escapeHtml(err.message)}</div>
       </div>`;
  }
}

// ---- 关闭抽屉 ----
function closeCommitsDrawer() {
  const drawer = document.getElementById('commitsDrawer');
  drawer.classList.remove('open');
  setTimeout(() => {
    drawer.style.display = 'none';
    document.getElementById('commitsDrawerOverlay').style.display = 'none';
  }, 250);
  commitsDrawerState.isOpen = false;
}

// ---- 获取并提交渲染 ----
async function fetchAndRenderCommits() {
  const { worktreePath, loadedCount, limit } = commitsDrawerState;
  const params = new URLSearchParams({
    worktree: worktreePath,
    limit: String(limit),
    offset: String(loadedCount)
  });

  const resp = await fetch(`/api/worktree-commits?${params}`);
  const data = await resp.json();

  if (!data.ok) throw new Error(data.error);

  // 首次加载时设置元信息
  if (loadedCount === 0) {
    commitsDrawerState.branch = data.branch;
    commitsDrawerState.base = data.base;
    commitsDrawerState.totalCommits = data.totalCommits;
    renderCommitsMeta(data);
  }

  commitsDrawerState.loadedCount += data.commits.length;
  renderCommitsList(data.commits, loadedCount === 0);

  // 更新 "加载更多" 按钮
  const footer = document.getElementById('commitsDrawerFooter');
  const btn = document.getElementById('loadMoreCommitsBtn');
  if (data.hasMore) {
    footer.style.display = 'block';
    btn.textContent = `加载更多 (剩余 ${data.totalCommits - commitsDrawerState.loadedCount} 条)`;
    btn.disabled = false;
  } else {
    if (commitsDrawerState.loadedCount > 0) {
      footer.style.display = 'block';
      btn.textContent = '已显示全部提交';
      btn.disabled = true;
    } else {
      footer.style.display = 'none';
    }
  }
}

// ---- 渲染元信息 ----
function renderCommitsMeta(data) {
  document.getElementById('commitsDrawerMeta').innerHTML = `
    <span class="badge badge-blue">${escapeHtml(data.branch)}</span>
    <span style="font-family:monospace">${escapeHtml(data.head.slice(0, 7))}</span>
    <span>共 ${data.totalCommits} 条提交</span>
  `;
}

// ---- 渲染提交列表 ----
function renderCommitsList(commits, isFirstLoad) {
  const body = document.getElementById('commitsDrawerBody');

  if (commits.length === 0 && isFirstLoad) {
    body.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <div>该分支暂无额外提交</div>
        <div style="font-size:12px;margin-top:8px">
          HEAD 与 ${escapeHtml(commitsDrawerState.base)} 分支指向同一提交
        </div>
      </div>`;
    return;
  }

  const html = commits.map(c => `
    <div class="commit-item">
      <div class="commit-item-header">
        <span class="commit-hash" onclick="copyText('${c.shortHash}')"
              title="点击复制">${c.shortHash}</span>
        <span class="commit-time">${escapeHtml(c.relativeTime)}</span>
      </div>
      <div class="commit-subject" title="${escapeHtml(c.subject)}">
        ${escapeHtml(c.subject)}
      </div>
      <div class="commit-author">${escapeHtml(c.author)}</div>
    </div>
  `).join('');

  if (isFirstLoad) {
    body.innerHTML = html;
  } else {
    body.insertAdjacentHTML('beforeend', html);
  }
}

// ---- 加载更多 ----
function loadMoreCommits() {
  fetchAndRenderCommits();
}

// ---- 在 worktree 条目中添加按钮 ----
// 在 renderWorktrees() 函数的 .item-actions 区域追加:
// <button class="btn-secondary" onclick="openCommitsDrawer('${wt.path}')">
//   提交记录
// </button>
```

### 4.4 交互流程时序图

```
用户                    前端                         后端                    Git CLI
 │                      │                             │                       │
 │  点击 "提交记录"      │                             │                       │
 │─────────────────────>│                             │                       │
 │                      │  GET /api/worktree-commits  │                       │
 │                      │  ?worktree=...&limit=30     │                       │
 │                      │────────────────────────────>│                       │
 │                      │                             │  git worktree list    │
 │                      │                             │──────────────────────>│
 │                      │                             │<──────────────────────│
 │                      │                             │  git rev-list --count │
 │  显示抽屉 + 加载动画  │                             │──────────────────────>│
 │<─────────────────────│                             │<──────────────────────│
 │                      │                             │  git log --format=... │
 │                      │  { ok, commits, totalCommits }                      │
 │                      │<────────────────────────────│──────────────────────>│
 │  渲染提交列表         │                             │                       │
 │<─────────────────────│                             │                       │
 │                      │                             │                       │
 │  点击 "加载更多"      │                             │                       │
 │─────────────────────>│                             │                       │
 │                      │  GET ...&offset=30&limit=30 │                       │
 │                      │────────────────────────────>│  git log --skip=30    │
 │                      │  { ok, commits, hasMore }   │──────────────────────>│
 │                      │<────────────────────────────│<──────────────────────│
 │  追加渲染新提交       │                             │                       │
 │<─────────────────────│                             │                       │
```

---

## 5. 错误与异常处理设计

### 5.1 错误分类与处理策略

```
┌─────────────────────────────────────────────────────────────────┐
│                        错误处理层级                               │
├──────────────┬──────────────────────────────────────────────────┤
│ 层级          │ 处理方式                                         │
├──────────────┼──────────────────────────────────────────────────┤
│ 参数校验层    │ 400 + 明确错误信息, 不执行 git 命令                 │
│ (server.js)  │                                                   │
├──────────────┼──────────────────────────────────────────────────┤
│ 路径安全层    │ 400/404 + 安全提示, 防止路径穿越                     │
│ (server.js)  │                                                   │
├──────────────┼──────────────────────────────────────────────────┤
│ Git 执行层   │ try/catch 包裹, 区分超时(504)和其他错误(500)         │
│ (git-        │                                                   │
│  inspector)  │                                                   │
├──────────────┼──────────────────────────────────────────────────┤
│ 前端展示层    │ 抽屉内显示错误状态 + 重试按钮                        │
│ (index.html) │                                                   │
└──────────────┴──────────────────────────────────────────────────┘
```

### 5.2 前端错误状态 UI

```
┌──────────────────────────────────┐
│                                  │
│         ⚠️ (大图标, 48px)         │
│                                  │
│    加载提交记录失败                │
│    worktree 磁盘不可用            │
│                                  │
│         [重试]                    │
│                                  │
└──────────────────────────────────┘
```

### 5.3 降级策略

| 场景 | 降级行为 |
|------|----------|
| `base` 分支不存在 | 自动回退为 `git log HEAD`（显示全部提交），响应中 `base` 字段标记为 `"HEAD"` |
| orphan 分支 | 同上，`totalCommits` 为分支全部提交数 |
| git 命令返回空输出 | 返回 `commits: []`，`totalCommits: 0` |
| 提交 body 解析失败 | body 字段设为空字符串，不影响其他字段 |

---

## 6. 文件变更清单

实施本方案需要修改的文件：

| 文件 | 变更类型 | 状态 |
|------|----------|------|
| `src/git-inspector.js` | 新增函数 `getWorktreeCommits(worktreePath, options)`（含 §3.3 路径/参数安全校验） | ✅ 已完成 |
| `src/server.js` | 新增 `GET /api/worktree-commits` 路由处理（`statusCode` 透传） | ✅ 已完成 |
| `public/index.html` | 新增抽屉 DOM、CSS 样式、JS 交互逻辑 | ⏳ 进行中 |

---

## 7. 后续迭代规划

> 以下条目按优先级排序，吸收自已废弃的 Tab 式备选方案
> (`../design-worktree-commit-history-entry.md` §4/§5/§8)，接口契约均已对齐本文现有 API 风格。

### 7.1 P1 — Ahead/Behind 统计（抽屉头部增强）

抽屉头部增加相对 base 的 ahead/behind 计数，用户可一眼判断分支与主干的分叉程度。

```
GET /api/worktree-ahead-behind?worktree=<path>&base=<mainBranch>
→ { ok, ahead: 12, behind: 3, baseBranch, worktreeBranch }
底层: git rev-list --left-right --count <base>...HEAD  (输出 "behind\tahead")
```

### 7.2 P1 — 提交详情展开

点击提交条目展开详情：完整 body、parent SHA、`--numstat` 统计（filesChanged/insertions/deletions）。
列表接口已返回 `body` 字段；文件级统计需扩展 list 接口或新增详情接口（建议后者，按需加载）。

```
GET /api/commit-detail?worktree=<path>&sha=<sha>
底层: git diff-tree -p --numstat --stat <sha>  (merge commit 默认 first-parent)
```

### 7.3 P2 — 单提交 Diff 查看

在提交详情中提供「查看 Diff」，复用现有 Diff 视图的渲染管线（parseDiffOutput）。

### 7.4 P2 — 提交搜索/过滤

按作者、日期范围、关键词过滤：新增 `author`、`since`、`until`、`grep` 查询参数，直通 `git log` 对应 flag。

### 7.5 P3 — 远期扩展

| 扩展 | 说明 | 预留接口 |
|------|------|----------|
| 跨 worktree 提交对比 | 在 Diff 面板展示两个 worktree 的 commit 差异 | API 的 `base` 参数可扩展为任意 ref |
| Cherry-pick / Revert | 从提交记录中挑选 commit 应用到其他分支 | 需要新增 POST 端点 |
| 图形化历史 | ASCII graph 或 SVG 分支图 | `git log --graph` 输出可解析 |
| 时间线视图 | 按日期分组展示（类似 GitHub） | 纯前端分组渲染 |
| WebSocket 实时推送 | 新提交自动刷新 | 现架构为无状态轮询，需评估 |
