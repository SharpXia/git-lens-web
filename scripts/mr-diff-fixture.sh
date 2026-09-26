#!/usr/bin/env bash
# mr-diff-fixture.sh —— 本地 MR + Branch Diff 集成验证的 fixture 仓库构建脚本
#
# 用法:
#   bash scripts/mr-diff-fixture.sh <目标目录>
#
# 在目标目录下创建 fixture 主仓库(repo/)与各 feature worktree，幂等：已存在则先删除重建。
# 覆盖的场景素材：
#   1. main：>=4 个提交（README / 文本与冲突行 / 最小 PNG 图片 / 二进制文件）
#   2. feature/normal：从 main 分叉后 2 个独有提交（改文本 + 新增文件）
#   3. feature/conflict：与 main 对同一行做不同修改（制造合并冲突）
#   4. feature/absorbed：1 个独有提交，且该提交已被 cherry-pick 进 main（吸收判定素材）
#   5. plain-branch：只有分支、没有 worktree、没有独有提交
#   6. feature/deep/name：分支名含 "/"，1 个独有提交，无 worktree
#   7. feature/dirty：有 worktree，且含未提交修改 + untracked 文件
#   8. worktree：main(repo 本体)/normal/conflict/absorbed/dirty 各一个
#   9. feature/merged-no-ff：1 个独有提交，验证 --no-ff 合并成功路径
#
# 输出约定：stdout 只输出各路径行与最后一行的单行 JSON 汇总；过程信息全部走 stderr。
# 依赖：git、bash。所有提交统一注入 QA 作者信息，不依赖全局 git 配置。

set -euo pipefail

usage() {
  echo "用法: $0 <目标目录>" >&2
  echo "  在目标目录下构建本地 MR + Branch Diff 验证用的 fixture 仓库与 worktree（幂等，先删后建）。" >&2
}

if [ $# -ne 1 ]; then
  usage
  exit 1
fi

command -v git >/dev/null 2>&1 || { echo "错误: 未找到 git 命令" >&2; exit 1; }

TARGET_RAW="$1"
mkdir -p "$TARGET_RAW"
# macOS 上 /tmp 是 /private/tmp 的符号链接：统一用 realpath 后的路径创建 worktree，
# 避免 git porcelain 登记路径与调用方传入路径失配（见 docs/iteration-log.md 已知问题 1）
TARGET="$(cd "$TARGET_RAW" && pwd -P)"

REPO="$TARGET/repo"
WT_NORMAL="$TARGET/wt-feature-normal"
WT_CONFLICT="$TARGET/wt-feature-conflict"
WT_ABSORBED="$TARGET/wt-feature-absorbed"
WT_DIRTY="$TARGET/wt-feature-dirty"
TMP_DEEP="$TARGET/.tmp-worktree-deep"
TMP_NOFF="$TARGET/.tmp-worktree-noff"

# 幂等：清理上一次构建留下的子路径。只删 fixture 自己的目录，不碰目标目录中的其他内容
rm -rf "$REPO" "$WT_NORMAL" "$WT_CONFLICT" "$WT_ABSORBED" "$WT_DIRTY" "$TMP_DEEP" "$TMP_NOFF"
mkdir -p "$TARGET"

log() { echo "[fixture] $*" >&2; }
fail() { echo "[fixture] 自检失败: $*" >&2; exit 1; }

# 统一注入 QA 作者信息，保证不依赖全局 git 配置
qa_git() {
  local dir="$1"; shift
  git -C "$dir" -c user.name=QA -c user.email=qa@test.local "$@"
}

qa_commit() {
  local dir="$1"; shift
  qa_git "$dir" commit -q "$@"
}

# ---------- 1. main 基础历史 ----------

log '构建 main 基础提交（README / 文本与冲突行 / PNG 与二进制）'
git init -q "$REPO"
git -C "$REPO" symbolic-ref HEAD refs/heads/main

cat > "$REPO/README.md" <<'EOF'
# MR Diff Fixture

用于本地 MR 与 Branch Diff 集成验证的最小仓库素材。
EOF
git -C "$REPO" add README.md
qa_commit "$REPO" -m 'main: 初始化 README'

cat > "$REPO/notes.txt" <<'EOF'
main 基础文本文件。
feature/normal 将在本文件追加自己的行。
EOF
cat > "$REPO/conflict.txt" <<'EOF'
shared-choice: base
说明: main 与 feature/conflict 各自修改上面这一行，用于制造合并冲突。
EOF
git -C "$REPO" add notes.txt conflict.txt
qa_commit "$REPO" -m 'main: 添加文本文件与冲突素材行'

mkdir -p "$REPO/assets"
# 最小 1x1 PNG（70 字节），printf 直接写字节。注意：转义后若紧跟十六进制字符会被
# printf 的 \x 解析贪婪吞并（如 \xda63 被读成 \xda6），因此一律改写为显式转义
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\x0dIDATx\xda\x63\xfc\xcf\xc0P\x0f\x00\x04\x85\x01\x80\x84\xa9\x8c\x21\x00\x00\x00\x00IEND\xae\x42\x60\x82' > "$REPO/assets/logo.png"
# urandom 64 字节有约 78% 概率不含 NUL，git 文本启发式会把它当文本 diff（numstat 给行数而非 - -）；
# 显式补一个 NUL 字节确保 git 判定为二进制，供 isBinary 断言使用
{ head -c 64 /dev/urandom; printf '\x00'; } > "$REPO/assets/blob.bin"
git -C "$REPO" add assets
qa_commit "$REPO" -m 'main: 添加 PNG 图片与二进制文件'

# ---------- 2. feature/conflict 与 feature/absorbed 的分叉（都基于当前 main 顶点） ----------

log '构建 feature/conflict（与 main 修改同一行，制造合并冲突素材）'
git -C "$REPO" worktree add -q -b feature/conflict "$WT_CONFLICT"
cat > "$WT_CONFLICT/conflict.txt" <<'EOF'
shared-choice: feature
说明: main 与 feature/conflict 各自修改上面这一行，用于制造合并冲突。
EOF
qa_commit "$WT_CONFLICT" -am 'conflict: 修改共享行为 feature 版本'

# absorbed 分支先于 main 的下一次提交分叉：保证它的独有提交父节点与之后 cherry-pick
# 落点不同，否则 cherry-pick 会生成完全相同的提交对象（同一 SHA），退化成纯祖先而非补丁等价
log '构建 feature/absorbed（独有提交随后 cherry-pick 进 main）'
git -C "$REPO" worktree add -q -b feature/absorbed "$WT_ABSORBED"
cat > "$WT_ABSORBED/absorbed-notes.txt" <<'EOF'
本提交会以相同补丁内容出现在 main 中（cherry-pick），用于验证吸收判定。
EOF
git -C "$WT_ABSORBED" add absorbed-notes.txt
qa_commit "$WT_ABSORBED" -m 'absorbed: 添加将被 main 吸收的说明文件'
ABSORBED_SHA="$(git -C "$WT_ABSORBED" rev-parse HEAD)"

cat > "$REPO/conflict.txt" <<'EOF'
shared-choice: main
说明: main 与 feature/conflict 各自修改上面这一行，用于制造合并冲突。
EOF
qa_commit "$REPO" -am 'main: 修改共享行为 main 版本（与 feature/conflict 冲突）'

log 'cherry-pick 进 main（补丁等价、SHA 不同，构成吸收判定素材）'
qa_git "$REPO" cherry-pick "$ABSORBED_SHA" >/dev/null

# ---------- 4. feature/normal（2 个独有提交） ----------

log '构建 feature/normal（独有提交 1: 改文本；独有提交 2: 新增文件）'
git -C "$REPO" worktree add -q -b feature/normal "$WT_NORMAL"
echo 'feature/normal 独有提交 1 追加的行。' >> "$WT_NORMAL/notes.txt"
qa_commit "$WT_NORMAL" -am 'normal: 追加 notes.txt 独有行'
cat > "$WT_NORMAL/normal-feature.txt" <<'EOF'
feature/normal 独有提交 2 新增的文件。
EOF
git -C "$WT_NORMAL" add normal-feature.txt
qa_commit "$WT_NORMAL" -m 'normal: 新增 normal-feature.txt'

# ---------- 5. feature/dirty（已提交素材 + 未提交修改 + untracked） ----------

log '构建 feature/dirty（已提交: 新文件与图片/二进制追加；工作区: 未提交修改 + untracked）'
git -C "$REPO" worktree add -q -b feature/dirty "$WT_DIRTY"
cat > "$WT_DIRTY/dirty-committed.txt" <<'EOF'
feature/dirty 已提交的新文件。
EOF
# 追加字节让图片/二进制文件出现在已提交 Diff 中，供 isImage/isBinary 标记断言使用
printf '\x00\xff' >> "$WT_DIRTY/assets/logo.png"
printf '\xde\xad\xbe\xef' >> "$WT_DIRTY/assets/blob.bin"
git -C "$WT_DIRTY" add -A
qa_commit "$WT_DIRTY" -m 'dirty: 新增已提交文件并追加图片/二进制字节'

# 工作区刻意保持未提交修改与 untracked 文件，作为 uncommitted/all 模式的验证素材
echo 'feature/dirty 的本地未提交修改行。' >> "$WT_DIRTY/notes.txt"
cat > "$WT_DIRTY/dirty-untracked.txt" <<'EOF'
feature/dirty 的 untracked 文件。
EOF

# ---------- 6. feature/deep/name（临时 worktree 提交后移除） ----------

log '构建 feature/deep/name（临时 worktree 提交后移除，保持无 worktree）'
git -C "$REPO" worktree add -q -b feature/deep/name "$TMP_DEEP"
cat > "$TMP_DEEP/deep-feature.txt" <<'EOF'
feature/deep/name 的独有提交内容。
EOF
git -C "$TMP_DEEP" add deep-feature.txt
qa_commit "$TMP_DEEP" -m 'deep: 分支名含斜杠的独有提交'
git -C "$REPO" worktree remove "$TMP_DEEP"

# ---------- 7. plain-branch（只有分支） ----------

log '构建 plain-branch（只有分支，无独有提交、无 worktree）'
git -C "$REPO" branch plain-branch HEAD

# ---------- 8. feature/merged-no-ff（--no-ff 合并成功路径素材） ----------

log '构建 feature/merged-no-ff（临时 worktree 提交后移除，验证 --no-ff 合并成功路径）'
git -C "$REPO" worktree add -q -b feature/merged-no-ff "$TMP_NOFF"
cat > "$TMP_NOFF/no-ff-feature.txt" <<'EOF'
feature/merged-no-ff 的独有提交内容，将被 --no-ff 合并进 main。
EOF
git -C "$TMP_NOFF" add no-ff-feature.txt
qa_commit "$TMP_NOFF" -m 'noff: 供 --no-ff 合并验证的独有提交'
git -C "$REPO" worktree remove "$TMP_NOFF"
git -C "$REPO" worktree prune

# ---------- 9. 自检 ----------

log '自检: 分支 / worktree / 场景素材'

for b in main feature/normal feature/conflict feature/absorbed plain-branch feature/deep/name feature/dirty feature/merged-no-ff; do
  git -C "$REPO" rev-parse --verify -q "refs/heads/$b" >/dev/null || fail "分支不存在: $b"
done

wt_registered() { git -C "$REPO" worktree list --porcelain | grep -qF "$1"; }
wt_registered "$REPO"        || fail '主工作区(repo)未登记'
wt_registered "$WT_NORMAL"   || fail 'worktree 未登记: feature/normal'
wt_registered "$WT_CONFLICT" || fail 'worktree 未登记: feature/conflict'
wt_registered "$WT_ABSORBED" || fail 'worktree 未登记: feature/absorbed'
wt_registered "$WT_DIRTY"    || fail 'worktree 未登记: feature/dirty'

_wtlist="$(git -C "$REPO" worktree list --porcelain)"
case "$_wtlist" in *'feature/deep/name'*|*'plain-branch'*|*'merged-no-ff'*)
  fail 'plain-branch / feature/deep/name / feature/merged-no-ff 不应出现在 worktree 列表' ;;
esac

[ -n "$(git -C "$WT_DIRTY" status --porcelain)" ] || fail 'feature/dirty worktree 应有未提交改动'
git -C "$WT_DIRTY" status --porcelain | grep -q 'dirty-untracked.txt' || fail 'feature/dirty 缺少 untracked 文件'
git -C "$WT_DIRTY" status --porcelain | grep -q ' notes.txt' || fail 'feature/dirty 缺少 notes.txt 未提交修改'

# 吸收判定素材：确有 1 个 main 不可达的独有提交，且 git cherry 判定其补丁等价（输出全为 '-'）
[ "$(git -C "$REPO" rev-list --count main..feature/absorbed)" = "1" ] || fail 'feature/absorbed 应恰好 1 个 main 不可达的独有提交'
_cherry="$(git -C "$REPO" cherry main feature/absorbed)"
{ [ -n "$_cherry" ] && ! printf '%s' "$_cherry" | grep -qv '^-'; } || fail 'feature/absorbed 的独有提交应全部被 main 吸收（git cherry 全为 -）'

# 冲突素材：两侧首行不同，且已从共同祖先双向分叉
[ "$(git -C "$REPO" show main:conflict.txt | head -n 1)" != "$(git -C "$REPO" show feature/conflict:conflict.txt | head -n 1)" ] \
  || fail 'main 与 feature/conflict 的冲突行应不同'
_BASE_SHA="$(git -C "$REPO" merge-base main feature/conflict)"
git -C "$REPO" merge-base --is-ancestor "$_BASE_SHA" main || fail '冲突素材 merge-base 异常'
git -C "$REPO" merge-base --is-ancestor "$_BASE_SHA" feature/conflict || fail '冲突素材 merge-base 异常'

[ "$(git -C "$REPO" rev-list --count main)" -ge 4 ] || fail 'main 提交数应 >= 4'
[ "$(git -C "$REPO" rev-list --count main..feature/normal)" = "2" ] || fail 'feature/normal 应恰好 2 个独有提交'
[ "$(git -C "$REPO" rev-list --count main..feature/merged-no-ff)" = "1" ] || fail 'feature/merged-no-ff 应恰好 1 个独有提交'
[ "$(git -C "$REPO" rev-list --count main..feature/deep/name)" = "1" ] || fail 'feature/deep/name 应恰好 1 个独有提交'

[ "$(head -c 4 "$REPO/assets/logo.png" | od -An -tx1 | tr -d ' \n')" = "89504e47" ] || fail 'assets/logo.png 不是合法 PNG 头'

# ---------- 10. 输出 ----------

log '构建完成'
echo "repo:              $REPO (branch: main)"
echo "worktree normal:   $WT_NORMAL (branch: feature/normal)"
echo "worktree conflict: $WT_CONFLICT (branch: feature/conflict)"
echo "worktree absorbed: $WT_ABSORBED (branch: feature/absorbed)"
echo "worktree dirty:    $WT_DIRTY (branch: feature/dirty)"
echo "branch plain:      plain-branch (无 worktree)"
echo "branch deep:       feature/deep/name (无 worktree)"
echo "branch no-ff:      feature/merged-no-ff (无 worktree)"
echo
# 单行 JSON 汇总放在 stdout 最后一行，供 verify 脚本按行解析
printf '{"root":"%s","repo":"%s","worktrees":{"main":"%s","feature/normal":"%s","feature/conflict":"%s","feature/absorbed":"%s","feature/dirty":"%s"},"branches":{"main":"main","normal":"feature/normal","conflict":"feature/conflict","absorbed":"feature/absorbed","plain":"plain-branch","deep":"feature/deep/name","dirty":"feature/dirty","mergeNoFF":"feature/merged-no-ff"}}\n' \
  "$TARGET" "$REPO" "$REPO" "$WT_NORMAL" "$WT_CONFLICT" "$WT_ABSORBED" "$WT_DIRTY"
