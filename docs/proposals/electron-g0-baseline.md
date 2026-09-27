# G0 基线测试记录

- 基线提交：`main@1cc3e1f`（在协调分支 2da6ca3 上执行，src 与 main 完全一致）
- 执行日期：2026-09-27
- 环境：macOS 25.4.0 arm64，Node v24.21.0，git 2.50.1（Apple Git-155）
- 隔离措施：`GIT_LENS_CONFIG_DIR=/tmp/glwt-electron-baseline/config`；测试自身全部使用 `fs.mkdtemp` 临时目录；9527 主实例与真实配置未触碰

## 命令

```bash
GIT_LENS_CONFIG_DIR=/tmp/glwt-electron-baseline/config node --test test/*.test.mjs
```

## 结果（全部通过）

| 套件 | 结果 |
| --- | --- |
| test/bulk-cleanup.test.mjs | 通过 |
| test/delivered-via.test.mjs | 通过 |
| test/diff-refs.test.mjs | 通过 |
| test/merge-request.test.mjs | 通过 |
| test/stash-action.test.mjs | 通过 |

汇总：tests 41，pass 41，fail 0，耗时约 6.4 秒。

## 基线风险备忘（供后续门禁对照）

1. `src/server.js` 导入即监听，`npm start` 默认 9527——G1 拆分后需回归本基线全部 41 项。
2. 全部 API 响应带 `Access-Control-Allow-Origin: *`——G1 移除后需确认既有测试不依赖该头。
3. `scripts/verify-mr-branch-diff.mjs` 当前可指向任意 URL 并读取 `--config-dir` 元数据——改造为 fail-closed 前禁止用于桌面版验收（契约 §8.3）。
