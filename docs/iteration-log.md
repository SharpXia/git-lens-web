# 迭代账本 — Worktree 提交记录入口

> 本文件记录「Worktree 提交记录入口」各迭代条目的进度、阻塞与结论。
> 权威计划见 `docs/proposals/worktree-commits-entry.md` §7；本文只记状态与结论，不重复接口契约。

## 状态总览（最终）

| 条目 | 优先级 | 状态 | 迭代分支 | 合入 commit（merge --no-ff） |
|------|--------|------|----------|------------------------------|
| 7.1 ahead/behind 统计 | P1 | ✅ 已合入 | iter/7.1-ahead-behind（已删） | 57c68de |
| 7.2 提交详情展开 | P1 | ✅ 已合入 | iter/7.2-commit-detail（已删） | e255119 |
| 7.4 搜索过滤 | P2 | ✅ 已合入 | iter/7.4-search-filter（已删） | 4e686c5 |
| 7.3 单提交 Diff | P2 | ✅ 已合入 | iter/7.3-commit-diff（已删） | 2f92617 |
| 时间线分组视图 | P3 | ✅ 已合入 | iter/p3-timeline-grouping（已删） | c94eb23 |
| 图形化分支历史 | P3 | ❌ 已移除（用户回归判定与列表无差异化，c9d1a8d） | iter/p3-graph-history（已删） | e106d55 |
| cherry-pick/revert | P3 | ✅ 已合入 | iter/p3-commit-action（已删） | 913fbb3 |
| 跨 worktree 提交对比 | P3 | ⏸ 延后（评估见下） | — | — |
| WebSocket 实时推送 | P3 | ⏸ 延后（评估见下） | — | — |

## 执行记录

### 2026-09-24

- 建立本账本。此前 P1/P2/P3 均未开始。
- 启动阶段一：iter-a（7.2）/ iter-b（7.1）/ iter-c（7.4）三个并行 worktree 同时开工，条目静态分配。
- 阶段一完成，三条分支全部自验通过并提交：
  - iter-b `abd0ed4` + `ea485bb`：`GET /api/worktree-ahead-behind` + 抽屉徽章；顺带修复 macOS /tmp 符号链接导致分支误判 detached 的问题（realpath 后比较）
  - iter-a `0444268` + `fdc54b9`：`GET /api/commit-detail` + 卡片点击展开；实测发现方案原文「merge 加 `--first-parent`」对 diff-tree 无输出，改为显式区间 `<sha>^1 <sha>` 实现同等契约
  - iter-c `3787686`：列表接口新增 author/since/until/grep 白名单过滤（计数与列表同用过滤 flag，分页一致）+ 抽屉过滤行
- 阶段二完成：按 iter-b → iter-a → iter-c 顺序 `merge --no-ff` 合入 main（57c68de / e255119 / 4e686c5）。两处预期冲突（函数追加、路由区、openCommitsDrawer 重置逻辑）均按并集手工解决；每步合入后 9599 端口回归既有端点与新端点，全量回归 35 项断言全部通过（含 /tmp 仓库上的 remove-worktree / delete-branch / prune 写操作端点）。
- 阶段三批次一开工：iter-d（7.3，依赖已合入的 7.2）/ iter-e（时间线分组）/ iter-f（图形化历史）并行。
  - iter-d `775e932` + `52ef7a0`：`GET /api/commit-diff` + 详情面板「查看 Diff」，复用 formatDiffLines 渲染管线
  - iter-e `5c8f8cd`：纯前端按日期分组（今天/昨天/YYYY-MM-DD），18 项脱离 DOM 的单测覆盖时区/跨月/跨年边界
  - iter-f `96141ca`：列表接口 `graph=1` 直通 `git log --graph`，解析提交块首行图形前缀等宽渲染；15 项单测含 body 不被图形前缀污染的回归
- 阶段三批次一合入完成：iter-d → iter-e → iter-f（2f92617 / c94eb23 / e106d55）。iter-f 与 iter-e 在 renderCommitsList 附近三处并集型冲突，手工取并集解决；每步 9599 回归全绿。
- 阶段三批次二：iter-g（cherry-pick/revert）独立分支实现并合入（913fbb3，`caac73b`）。`POST /api/commit-action` action 白名单 + sha 校验；git 失败（含冲突、空提交）自动执行对应 `--abort` 恢复现场并返回 409；三种失败场景均验证 `status --porcelain` 恢复为空。写操作测试全部在 /tmp 自建仓库，未触碰任何真实仓库。

### 2026-09-25

- **分支归属调整**：迭代提交原按任务文本合入 main（`2f85686`…`12e6e67` 共 10 个提交）；用户确认真实意图是「新内容先进 feat/worktree-commits-entry，验收后再决定是否进 main」。已执行：feat/worktree-commits-entry 以 `--ff-only` 接收全部提交至 `12e6e67`，main `reset --hard` 回退至开工前的 `fcaafc3`，提交哈希未变、main 历史恢复原样。本分支当前状态：**待用户验收**；验收通过后再决定是否合回 main。
- **扫描配置隔离修复**：测试实例曾因复用默认配置目录而覆盖扫描目录配置；现已支持 `GIT_LENS_CONFIG_DIR`，测试实例统一使用独立临时目录。
- **页面初始化中断 bug（真实浏览器验证发现并修复）**：用户报告 feat 代码合入期间「项目无法加载」。真实浏览器复现确认：iter-c 新增的提交过滤输入框回车绑定位于脚本顶层，而这些输入框在脚本文档流之后的抽屉 DOM 中，解析到绑定时 `getElementById` 返回 null → 顶层 TypeError 中断脚本 → `loadProjects()` 等后续初始化全部不执行。此问题存在于全部 curl/语法级验证盲区。修复 `1a23c95`：绑定移入 `DOMContentLoaded`。修复后经真实浏览器完整回归：65 仓库加载、worktree 列表、抽屉、时间线分组、详情展开（231 文件 +789/-618 逐行 Diff）、领先/落后徽章（P2 领先 57、feat worktree 领先 24）、图形历史、过滤空态均正常。
- **人工回归反馈修复（5 条）**：用户对 feat 分支人工回归提出 5 条反馈，全部处理完毕。
  1. 抽屉加宽：`width: min(420px, 92vw)` → `min(720px, 92vw)`（0767b77，1080p 下超过屏幕 1/3）。
  2. Cherry-pick 失败根因与修复：操作原本作用在「正在查看的 worktree」自身分支上，pick 已有提交必然失败。改为详情面板内嵌「目标工作区」选择器，用户未手动选择时按动作语义给默认值（Cherry-pick 默认主工作区、Revert 默认当前 worktree）；后端 `commitAction` 增加 `merge-base --is-ancestor` 前置校验，自捡/误 revert 返回 409 中文提示（cec99ca）。
  3. 未提交修改管理：新增 `GET /api/stash-list` 与 `POST /api/stash-action`（push -u 含 untracked / pop / drop / discard 四动作白名单），未提交面板加「暂存 (Stash)」「丢弃全部修改」按钮与 stash 列表区块（Pop/Drop），操作后 `refreshCurrentDiff` 统一刷新面板与外层 dirty 状态。实测发现 `git stash push` 空工作区退出码为 0 仅打印提示，改为前置 `status --porcelain` 自查返回 409（ad4231d）。
  4. 图形历史移除：用户判定 `*` 前缀与列表无差异化、不达预期，前后端 graph 相关代码（解析器/接口参数/按钮/CSS）整体删除（c9d1a8d）。
  5. Revert 后「领先 main 2」误导修复：`getWorktreeAheadBehind` 复用分支列表的 `getBranchMergeStatus`（祖先/树一致/补丁等价/merge-tree 四方判定）返回 `contentEquivalent` 与 `mergeType`；徽章在内容等价时显示绿色「✓ 与基准无差异」（tooltip 注明判定依据），机械计数降级为弱色小字；仍落后基准时显示「落后 N（无独有改动）」警示（c230be7）。
- **分支列表提交记录入口（回归期新增需求）**：分支行加「提交记录」按钮复用提交抽屉。`getWorktreeCommits`/`getWorktreeAheadBehind` 新增 `options.ref`（白名单校验，无法解析 404），以指定分支为顶点计算范围/统计；抽屉 state、请求参数与 URL/session 恢复（`commitsRef`）全链路支持分支模式（ae87bea）。
- **验证**：`node --check` 两个后端文件 + awk 抽取内联 JS 校验通过；/tmp 自建仓库经 9528（GIT_LENS_CONFIG_DIR 隔离）HTTP 断言：ref 模式列表/徽章、自捡 cherry-pick 409、跨分支 revert 409、完整 revert 抵消后 contentEquivalent=true 且 mergeType=tree（ahead=2）、stash push/pop/drop/discard 与空工作区 409，全部通过。浏览器人工回归待用户进行。
- **二次回归修复（stale 徽标）**：用户复测发现 cherry-pick 后抽屉仍显示旧「领先 2」、revert 后外层 worktree 列表仍显示旧领先徽标。根因：抽屉徽章缓存 `commitsDrawerAheadBehind` 每轮抽屉只拉一次，写操作后未作废；外层列表 `/api/inspect` 数据写操作后未刷新。修复 `e73cf02`：commitAction 成功后置空徽章缓存重拉（cherry-pick 到主干后补丁/merge-tree 等价 → 显示「无差异」），并抽出 `refreshRepoInspectData()` 在写操作后同步刷新外层列表。HTTP 复验：主干分叉场景 cherry-pick feat 两提交后 feat 徽章 ahead=2/behind=3 且 contentEquivalent=true（merge-tree）。
- **三次回归修复（worktree 列表判定过窄）**：用户在真实 demo 仓库（/tmp/git-lens-demo）发现 append-verification-line（加行+revert 抵消）仍显「领先 2」、add-mit-license（已 cherry-pick 进主干）仍显「领先 1」。根因：`/api/inspect` 的 worktree 分析只做「分支树 === 主干树」一重比较，主干因其他提交前移后树必然不同，无法识别 revert 抵消与 cherry-pick 吸收。修复 `7530642`：worktree 分析复用与抽屉徽章同一套 `getBranchMergeStatus` 四方判定（祖先/树一致/git cherry 补丁等价/merge-tree），`hasCommittedDiff` 同步改为「改动未被吸收才算」。真实仓库复验：两个误报 worktree 均显示「内容已与主干同步」，确有独有改动的 coordination-6 仍正确显示领先 1。
- **四次回归修复（Diff 视图同源问题）**：用户进一步发现 add-mit-license 的 Diff 详情页仍展示「全量变更 1」（LICENSE 文件），而该内容已 cherry-pick 进 main；append-verification-line 不展示仅因 add+revert 文本恰好抵消，属巧合而非判定正确。根因：`getWorktreeDiff` 的 `hasTargetCommittedChanges` 同样是树比较一重判定，无法识别补丁等价吸收。修复 `be98202`：引入 `isTargetAbsorbedBySource`（复用 `getBranchMergeStatus`），被吸收时领先计数归零且不产生 committed/all Diff。真实仓库复验：add-mit-license 与 append-verification-line 均无 Diff 内容，coordination-6 的独有改动仍正常展示。

### 延后条目评估结论

**跨 worktree 提交对比 — 延后。**
- 工作量：后端约 0.5h（复用 ahead/behind 的 worktree 解析 + `rev-list --left-right` 对称差集），前端约 1.5–2h（新增对比视图模式、双 worktree 选择器、与现有 Tab/URL 状态恢复逻辑 syncStateToUrl 的联动），合计逼近或超过 2h 红线。
- 侵入性：需要给 Diff/抽屉体系引入一种新的视图模式，改动状态机。
- 建议方案：不新开面板，在现有提交抽屉 meta 行加「与其他 worktree 对比」入口，复用列表渲染管线分左右两列展示双方独有提交；后端用对称差集 SHA 列表 + 现有详情接口按需取数。

**WebSocket 实时推送 — 延后。**
- 工作量：不引依赖手写 ws 协议（握手/帧解析/心跳）2h+；引入 ws 依赖虽快但新增运行时依赖；叠加 HEAD 监听（fs.watch 或轮询 rev-parse）、连接与订阅管理、前端重连去重，合计明显超过 2h。
- 侵入性：现架构为无状态 node:http + fetch 请求响应，无任何长连接基础设施，实时推送属于全局架构级改动。
- 建议方案：轻量替代优先——抽屉加「手动刷新」按钮 + `visibilitychange` 回前台时自动刷新（零架构改动）；确需准实时可用轮询 `rev-parse HEAD` 比对变化的订阅式刷新，成本远低于 WebSocket。

### 已知问题

1. **macOS /tmp 符号链接路径**：`/tmp → /private/tmp`。以非规范路径（/tmp/...）调用时，`getWorktreeCommits` 及既有 `check-worktree`/`diff-worktrees` 的 `path.resolve` 与 porcelain 真实路径比对失配（分支误判为 HEAD / worktree 判定不存在）。`getWorktreeAheadBehind` 已用 `fs.realpath` 修复同类问题；常规绝对路径不受影响。建议后续统一在各端点入口做 realpath 归一。
2. ~~图形模式的提交顺序~~（图形历史功能已于 2026-09-25 应用户回归反馈整体移除，此条作废）
3. **merge 提交的详情/Diff 基准**：采用对第一父的显式区间 diff（方案契约的等价实现），不展示合并双方逐父差异；已在代码注释说明。
4. **since/until 白名单的边界**：`2026-02-31` 这类格式合法但日历不存在的日期会放行交给 git 解释，未在应用层拒绝；已在代码注释说明。
5. **测试实例会写真实配置（已修复）**：配置路径原为硬编码 `~/.config/git-lens-web`，任意端口的测试实例与真实服务共用，测试期间写扫描目录会覆盖用户配置。现支持 `GIT_LENS_CONFIG_DIR` 环境变量覆盖，测试实例必须指向 /tmp 私有目录。

### 验证方式备忘

- 集成回归脚本：/tmp/glw-setup-repo.sh（造 main 14 提交 + feature/feat2 分叉与二进制/merge 提交）+ /tmp/glw-verify.mjs（STAGE=b/a/c/d/e/f/g/full 分阶段断言，全部通过）。
- 每次合入前后的固定检查：`node --check` 两个后端文件；awk 抽取 index.html 内联 JS 后 `node --check`；9599 端口起服务跑对应阶段断言；结束后 kill 进程。

### 2026-09-25（本地 MR 与 Branch Diff 协调开发）

- **四 worktree 并行分工**（均基于 main@b78d1aa）：
  - `mr-backend`（分支 codex/local-mr-backend）：MR API 与本地合并语义（创建/列表/详情/审阅动作/`--no-ff` 合并/失败自动 abort）；
  - `branch-diff-backend`（分支 codex/branch-diff-backend）：`GET /api/diff-refs` 六种 Worktree/分支组合与 kind 标注，保留 `/api/diff-worktrees` 原行为；
  - `ui`（分支 codex/local-mr-branch-diff-ui）：Diff 选择器类型切换、URL 参数恢复、MR 面板与局部刷新；
  - `qa`（分支 codex/local-mr-branch-diff-qa，本 worktree）：契约文档、fixture 构建脚本、HTTP 集成验证脚本，不改 `src/` 与 `public/`。
- **协调分支**：codex/local-mr-branch-diff（integration worktree），负责按 mr-backend → branch-diff-backend → ui 顺序 `merge --no-ff` 汇总；契约以 `docs/local-mr-branch-diff.md` 为准。
- **实施顺序**：先冻结契约（数据模型/状态机/API 错误码/合并前置检查/局部刷新表），qa 据此先产出验证脚本作为机械化验收标准；后端两分支按契约并行实现；ui 依赖契约字段并行开发；最后集成、跑 full 回归。
- **验证方式备忘**：
  - `bash scripts/mr-diff-fixture.sh /tmp/<目录>`：幂等构建 8 分支 5 worktree 的场景素材（冲突/吸收/dirty/deep 分支名/plain 分支/--no-ff 素材/图片与二进制），stdout 末行为 JSON 汇总，脚本内自检；
  - `node scripts/verify-mr-branch-diff.mjs --base-url http://127.0.0.1:<端口> --config-dir /tmp/<私有目录> --stage <full|mr|diff|compat>`：STAGE 分阶段 HTTP 断言（mr=MR 全链路，diff=Branch Diff 矩阵与兼容，compat=既有接口回归，full=全部）；fixture 与扫描目录写入全部隔离在 /tmp 与脚本参数指定的 config-dir；
  - 本基线（未合入新接口）实测：STAGE=compat 11 项断言全绿；STAGE=mr 在 404 处给出「该接口尚未在当前基线实现」提示，属预期。
- **状态：开发中，待集成回归。** 集成后由协调方在 integration worktree 起 `--stage full` 一键回归。

### 2026-09-25（本地 MR 与 Branch Diff 集成回归结论）

- **集成完成**：协调分支 codex/local-mr-branch-diff 已按顺序合入 A（78204df+327ff2a）→ B（4088299+2cbde68）→ 协调方路由（2630b53）→ D（8648954+91b3169）→ C（55e836a/7880c1e/3b486b4/1fe6004，合并提交 812c315）。
- **路由接入（协调方 2630b53）**：`GET/POST /api/merge-requests`、`GET /api/merge-requests/<id>`、`POST /api/merge-requests/action`、`GET /api/diff-refs`（参数名按契约用 sourceType/targetType，未采纳 B 汇报建议的 sourceKind）。
- **后端回归**：`node --test` 30/30（MR 20 + diff-refs 10）；STAGE=full 106/106 全绿。
- **集成期修复（均属 QA 交付物偏差，实现无缺陷）**：
  1. fixture 的 blob.bin 用纯 urandom 生成，约 78% 概率不含 NUL，git 文本启发式按文本 diff 输出（numstat 给行数而非 `- -`），isBinary 断言失败；改为显式补 `\x00`。
  2. 「不存在 MR」断言误用非 UUID 字符串（触发 400 参数校验路径），改为格式合法的未知 UUID 验证 404 语义。
- **浏览器 GUI 回归（9529 隔离实例 + /tmp fixture，真实浏览器操作）**：
  - 分支行「与主分支对比」：无 worktree 的 plain-branch 与含 `/` 的 feature/deep/name 均正确切 Diff Tab 并以 branch↔branch committed 加载；URL 形如 `diffType=ref&diffBaseType=branch&...&mode=committed`；
  - 可搜索选择器：Worktree/本地分支分组、「deep」过滤只剩目标分支、↓/Enter 键盘选中生效；
  - MR 全生命周期：分支行「发起 MR」预填 source/target、顶部「新建 MR」按钮、创建后列表局部刷新、审阅通过出现「审阅已通过」徽章与「✓ 合并 (--no-ff)」主按钮、合并成功后抽屉显示「已合并 · 合并提交 3678834b」且分支列表/Worktree 徽章/冗余计数联动更新；
  - 冲突场景：feature/conflict 的 MR 合并返回红色「合并失败（已自动中止合并并恢复现场）」，MR 保持 open+approved，目标 worktree `status --porcelain` 干净、无 MERGE_HEAD；
  - 状态恢复：刷新后 `mr=<id>` 恢复 MR 抽屉、`diffType=ref` 完整恢复 Branch Diff 选择器与结果；旧格式 `diffType=worktree`/`uncommitted` 链接按 worktree/未提交语义兼容解析；
  - 隔离确认：验证过程使用独立端口和配置目录，未修改日常实例数据。
- **端口变更说明**：任务书指定 9528，但该端口被待验收分支 feat/worktree-commits-entry 的测试实例占用，为不中断其验收，全程改用 9529 + /tmp/git-lens-web-dev-9529（隔离语义不变）。
- **已知问题（测试环境，非产品缺陷）**：ZCode 内置浏览器的 layout 坐标读数（getBoundingClientRect/scrollY）与真实渲染存在脱节，且滚轮事件管线超时，导致自动化操作需以截图坐标 + confirm 对话框处理辅助完成；人工浏览器操作不受影响。
- **状态：已集成，全部回归通过，待用户验收合入 main。**
