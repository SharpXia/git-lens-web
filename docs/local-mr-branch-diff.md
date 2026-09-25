# 本地 MR 与 Branch Diff — 设计文档

> 状态：开发中，待集成回归。本文是四个并行 worktree 的共同契约来源；
> 契约落地的机械化验证见 `scripts/mr-diff-fixture.sh` 与 `scripts/verify-mr-branch-diff.mjs`。

## 1. 功能概述

在本地单机场景下补齐「分支 → 合入主干」的协作闭环：

- **本地 MR（Merge Request）**：对同一仓库的任意两个本地分支发起合并请求，走
  「创建 → 审阅（通过 / 要求修改）→ 合并（或拒绝 / 取消）」的状态流转。合并使用
  `git merge --no-ff` **真实修改**目标分支，冲突时服务端自动中止（abort）并保持 MR 打开。
  与远端托管平台的 MR 的本质区别：没有服务端仓库，审阅与合并都发生在本机，数据落盘在
  本地配置目录。
- **Branch Diff**：把现有「Worktree ↔ Worktree」的 Diff 能力推广到任意
  Worktree / 分支组合（含混合方向与同名自比），复用既有的三种模式（仅未提交 / 全量 / 仅已提交）。
  分支 ↔ 分支对比是**纯引用比较**，不受任何工作区未提交内容干扰。

## 2. MR 数据模型

### 2.1 字段定义

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | MR 唯一标识，URL 与操作请求均使用它定位 |
| `repoPath` | string | 所属仓库的绝对路径（配置目录内按其 sha256 分文件存储） |
| `sourceBranch` | string | 源分支名 |
| `targetBranch` | string | 目标分支名（必须是检出 worktree 的分支，见 §4） |
| `title` | string | 标题 |
| `description` | string | 描述，可为空 |
| `status` | enum | `open` / `merged` / `rejected` / `canceled` |
| `reviewStatus` | enum | `pending` / `approved` / `changes_requested` |
| `createdAt` / `updatedAt` | string | 创建 / 最近更新时间（ISO 字符串） |
| `sourceHeadAtCreate` | string | 创建时源分支 HEAD，用于合并后核对第二父 |
| `targetHeadAtCreate` | string | 创建时目标分支 HEAD |
| `mergedAt` | string \| null | 合并完成时间，仅 `merged` 态有值 |
| `mergedCommit` | string \| null | 合并产生的新 HEAD（即 merge commit SHA），仅 `merged` 态有值 |
| `decisionReason` | string \| null | 终态决定原因（reject / cancel 时由 `reason` 写入） |

### 2.2 状态机

```text
                        ┌──────────────────────────────────────────────┐
                        │                   open                       │
                        │  reviewStatus: pending ⇄ changes_requested   │
                        │        approve ↓（pending/changes_requested  │
                        │                  均可发起）                   │
                        │  reviewStatus: approved                      │
                        └──────┬──────────────┬──────────────┬─────────┘
                          merge │         reject│        cancel│
                                │  （需 approved）│（任意 open 态）│（任意 open 态）
                                ▼               ▼              ▼
                             merged          rejected       canceled
                            （终态）          （终态）        （终态）
```

流转规则：

| 当前状态 | 动作 | 前置条件 | 结果 |
| --- | --- | --- | --- |
| open | approve | — | `reviewStatus=approved` |
| open | request_changes | — | `reviewStatus=changes_requested` |
| open | merge | `reviewStatus=approved`，且通过 §4 前置检查 | `status=merged`，写入 `mergedAt` / `mergedCommit` |
| open | reject | — | `status=rejected`，`decisionReason=reason` |
| open | cancel | — | `status=canceled` |
| 任意终态 | 任意动作 | — | 409，拒绝 |

终态不可逆；`canceled` 释放 `source+target` 的 open 占用，允许重新创建同类 MR。

## 3. API 契约

### 3.1 接口定义

```text
GET  /api/merge-requests?repoPath=<path>&status=<open|merged|rejected|canceled>
     → { ok: true, mergeRequests: [...] }
     status 可省略，省略时返回全部

POST /api/merge-requests
     body { repoPath, sourceBranch, targetBranch, title, description }
     → { ok: true, mergeRequest } | 400 | 404 | 409

GET  /api/merge-requests/<id>?repoPath=<path>
     → { ok: true, mergeRequest } | 404

POST /api/merge-requests/action
     body { repoPath, id, action: approve|request_changes|reject|cancel|merge, reason? }
     → { ok: true, mergeRequest } | 409
```

### 3.2 错误码表

| 码 | 触发场景 | 说明 |
| --- | --- | --- |
| 400 | 创建缺参（repoPath / sourceBranch / targetBranch / title 缺失）、`sourceBranch === targetBranch` | 请求本身不合法 |
| 404 | `repoPath` 不是有效仓库、分支不存在、MR id 不存在 | 资源未找到 |
| 409 | 已存在相同 source+target 的 open MR（重复创建）；非法状态转换（终态后再操作、未 approve 直接 merge）；合并前置检查失败（target 无检出 worktree / target worktree 不干净）；Git 冲突 | 冲突时服务端已自动 abort，MR 保持 open，错误信息说明原因 |

### 3.3 Branch Diff

```text
GET /api/diff-refs?path=<repo>&sourceType=worktree|branch&source=<值>&targetType=worktree|branch&target=<值>&mode=uncommitted|all|committed
    → { ok: true, diff: {...} } | 400 | 404
```

- `diff.source` / `diff.target` 新增 `kind` 字段（`worktree` / `branch`），其余字段
  （`path` / `branch` / `head` / `isMain` / `isDirty` / `lastCommit`）与既有
  `/api/diff-worktrees` 的 diff 同构；`ahead` / `behind` / `files` / `counts` /
  `effectiveMode` 等语义不变。
- 旧接口 `GET /api/diff-worktrees?path=&source=&target=&mode=` 保留原行为，仅接受
  worktree 路径输入，作为 `/api/diff-refs` 的兼容子集。

## 4. 本地合并语义

合并命令：`git -C <target-worktree> merge --no-ff --no-edit <sourceBranch>`。

### 4.1 前置检查清单（按序执行，任一失败即 409/404）

1. MR 存在且 `status=open`；
2. `action=merge` 时 `reviewStatus` 必须为 `approved`；
3. 目标分支存在检出 worktree（无 worktree 的分支不能作为合并目标）；
4. 目标 worktree 干净：`git status --porcelain` 为空（未提交修改与 untracked 都算脏）；
5. 源分支存在且可解析。

### 4.2 成功路径

- 合并成功后：`status=merged`，`mergedAt=当前时间`，`mergedCommit = git rev-parse HEAD`；
- 因 `--no-ff`，即使可以快进也会产生 merge commit，其第二父即 `sourceHeadAtCreate`，
  保证合并痕迹可追溯；
- 合并后目标 worktree 应保持干净。

### 4.3 失败自动 abort

合并执行失败（典型为 Git 冲突）时，服务端必须执行对应 `git merge --abort` 恢复现场：

- 目标 worktree 恢复干净（`git status --porcelain` 为空、无 `MERGE_HEAD` 残留）；
- MR 保持 `open`，向调用方返回 409 与明确的冲突说明；
- 不得留下半完成的合并状态（这是与 Cherry-pick / Revert 失败恢复一致的既有约定）。

## 5. Branch Diff 语义矩阵

六种组合行为（source × target，含两类边界）：

| # | source | target | 行为 |
| --- | --- | --- | --- |
| 1 | worktree | worktree | 与既有 `/api/diff-worktrees` 完全一致；同一 worktree 时进入自审模式（锁定仅未提交模式） |
| 2 | worktree | branch | source 取该 worktree 当前分支（detached 时取 HEAD）；committed/all 以双方 merge-base 为基准 |
| 3 | branch | worktree | 与 #2 对称；target worktree 的未提交内容按 mode 决定是否计入 |
| 4 | branch | branch | 纯引用三点比较（merge-base），**不读取任何 worktree**，未提交 / untracked 内容一律不出现 |
| 5 | 同名同值（含 source===target） | 空结果：`files` 为空、ahead/behind 为 0；worktree 自比沿用自审模式语义 |
| 6 | 失联 / 不存在的引用 | 明确错误：分支不存在或 worktree 失联（目录缺失、prunable）返回 404/4xx，`error` 给出可读中文说明 |

`ahead` / `behind` 约定：`ahead` 为 target 相对 source 的独有提交数，`behind` 为 source
相对 target 的独有提交数（与既有 `rev-list --left-right --count source...target` 顺序一致）。
被 source 吸收（cherry-pick / 补丁等价）的 target 沿用既有判定：ahead 归零、不产生 committed Diff。

## 6. 前端交互

### 6.1 选择器与 URL 参数

- Diff 区域的 source / target 各为一组「类型 + 值」下拉：类型切换 Worktree / 分支，
  值随类型联动（Worktree 列表来自 `/api/inspect`，分支列表复用分支透视数据）；
- URL 参数恢复：`sourceType` / `source` / `targetType` / `target` / `mode` 写入与恢复方式
  与既有 Diff 视图的 `syncStateToUrl` 一致，刷新后可还原对比现场；
- MR 面板：仓库内展示 MR 列表（可按 status 过滤）、创建表单（源 / 目标分支选择 + 标题 +
  描述）、详情卡（字段、审阅状态、操作按钮：approve / request_changes / reject / cancel /
  merge，reject 与 request_changes 可附 reason）。

### 6.2 局部刷新表

| 操作 | 刷新范围 |
| --- | --- |
| 创建 MR | MR 列表 + MR 数量徽标 + 详情 |
| 审阅（approve / request_changes） | MR 列表 + 详情 + 审阅状态 |
| 拒绝 / 取消 | MR 列表 + 详情 + 状态 |
| 合并成功 | MR 列表 + 详情 + `/api/inspect` + 分支 / Worktree 列表 + Diff 选择器 |
| 合并冲突（409） | 仅错误提示，MR 保持 open |
| Branch Diff 操作 | 仅 Diff 结果区 |

合并成功之所以触发大范围刷新：目标分支 HEAD 实际前移，`/api/inspect` 的 worktree 领先 /
落后徽章、分支合并状态、Diff 选择器中的分支选项都可能变化，必须整体重取。

## 7. 配置存储路径与隔离策略

- MR 数据按仓库分文件存储：`<config-dir>/merge-requests/<sha256(repoPath)>.json`，
  内容为该仓库全部 MR 的 JSON；文件随 MR 创建自动生成；
- `config-dir` 遵循既有约定：默认 `~/.config/git-lens-web`，可用 `GIT_LENS_CONFIG_DIR`
  环境变量覆盖；
- **测试与多实例隔离是硬约束**：任何测试实例必须设置
  `GIT_LENS_CONFIG_DIR=/tmp/<私有目录>`，验证脚本会断言（只 stat / 读，不写）真实用户配置
  目录未被写入 MR 数据。扫描目录配置同理——`POST /api/scan-directories` 是全量替换语义，
  测试脚本必须先 GET 再合并写入。

## 8. 验证方式

```bash
# 1. 构建 fixture 仓库（幂等，可重复执行）
bash scripts/mr-diff-fixture.sh /tmp/glwt-mr-fixture

# 2. 启动被测服务（端口与配置目录必须与真实实例隔离）
PORT=9529 GIT_LENS_CONFIG_DIR=/tmp/glwt-verify-config node src/server.js

# 3. 分阶段集成验证
node scripts/verify-mr-branch-diff.mjs --base-url http://127.0.0.1:9529 \
     --config-dir /tmp/glwt-verify-config --stage full   # 或 mr / diff / compat
```

- `mr` 阶段覆盖：创建（正常 / 缺参 400 / 分支不存在 404 / source==target 400 / 重复 409）、
  列表过滤与详情 404、approve / request_changes / reject / cancel 全部流转与终态 409、
  `--no-ff` 合并成功（mergedCommit 与第二父核对）、dirty target 409、冲突 409 + 自动
  abort 验证、配置隔离断言；
- `diff` 阶段覆盖：§5 矩阵全部六种组合、三种 mode、图片 / 二进制标记、失联 worktree
  明确错误、`/api/diff-worktrees` 兼容回归；
- `compat` 阶段覆盖：`/api/inspect` / `/api/worktree-commits`（ref 参数）/
  `/api/worktree-ahead-behind` / `/api/uncommitted-diff` 结构冒烟，保证新功能不破坏既有接口。
