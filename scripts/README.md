# scripts/ 工具登记

> 用途：登记本目录每个入口的用途、运行方式、输出位置与敏感配置，避免“生产未引用即删除”。
> 最后核对：2026-10-03（阶段 5 联验设施接入与边界门禁）。
> 约定：默认工作目录为仓库根；`npx tsx` 指 `pnpm exec tsx`；输出目录若不在下表则视为临时草稿。

## 1. 固定入口（构建、检查、版本）

| 入口 | 用途 | 运行方式 | 输出 |
|---|---|---|---|
| `version.mjs` | 版本号读写与 Android 同步 | `pnpm version:*` | `package.json`、`CHANGELOG.md` |
| `check-contracts.mjs` | 契约漂移门禁（schemas / fixtures / settings_public / openapi operationId / entityType 双向比对） | `pnpm check:contracts` | stdout 结果，非零退出即失败。**当前为绿并已入 CI**：entityType 集合以 `shared/contracts/sync-envelope.ts` 的 `SyncEntityType` 为单一事实源与 schema enum 双向比对（含比对函数自检）。2026-10-05 前因脚本硬编码清单与 D-11/D-12 冻结契约脱节而长期“已知红”，历史说明见阶段 5 报告 |
| `check-docs-index.mjs` | 文档索引门禁：docs 下非归档 md 必须被其他文档链接（无孤儿文档），且 `docs/README.md` 必须登记各分类索引页（ADR／compose／方案族／两个归档 README） | `pnpm check:docs-index` | stdout 结果，非零退出即失败；含“注入孤立样本”自检 |
| `check-write-bypass.mjs` | 写路径旁路检查（禁止绕过仓储写入口） | `pnpm check:write-bypass` | stdout |
| `check-forwarders.mjs` | 转发层残余检查（旧路径不得有新引用） | `pnpm check:forwarders` | stdout |
| `check-boundaries.mjs` | 跨目录依赖方向门禁（shared 平台依赖／PC↔画板／core 纯度／features 交叉与环；`--self-test` 负例自检） | `pnpm check:boundaries` / `pnpm check:boundaries:selftest` | stdout |
| `check-pc-agent.mjs` | 外部 Agent 工具门禁：动作目录 ↔ `shared/ipc-api.ts` 契约漂移（成员遗漏、悬空映射、签名漂移、豁免缺原因、能力矩阵陈旧、UI/异步声明合法性）。**当前为绿**；`--require-covered` 已按“无 unregistered”收紧并常态通过 | `pnpm check:pc-agent`（可选 `--require-covered` / `--json`） | stdout 结果，非零退出即失败 |
| `check:gates`（聚合） | forwarders + 写路径 + boundaries（含负例）一次性门禁 | `pnpm check:gates` | stdout |
| `dev.ps1` / `dev.bat` | 本地开发启动辅助 | `pwsh scripts/dev.ps1` | 无 |
| `electron-stub*.mjs` | electron ESM 桩（给 tsx 运行的评测脚本提供 `electron` 导入） | `pnpm exec tsx --import ./scripts/electron-stub.mjs <script>` | 无 |

## 2. 评测与基线（真实模型）

| 入口 | 用途 | 关键参数 | 输出 |
|---|---|---|---|
| `evaluate-generation.ts` | 生成效果分批评测（对话／续写／方向／生图提示词／预设） | `--batch --key-file --base-url --model --out` | `--out` 指定目录（默认示例 `.poc-tmp/eval-gen`） |
| `evaluate-imagine-prompts.ts` | imagine 提示词全排列评测 | 同上 | `--out` 目录 |
| `evaluate-local-embedding.ts` | 本地向量模型评测 | 模型路径参数见文件头 | `--out` 目录 |
| `generation-baseline.ts` | 生成基线采集（W0 冻结基线） | 见文件头 | `--out` 目录 |
| `session-isolation-model-bench.ts` | 会话隔离真实模型基准 | 见文件头 | `.poc-tmp/` |
| `spatial-ai-model-bench.ts`、`spatial-group-model-bench.ts`、`spatial-group-stage2-model-bench.ts`、`spatial-group-stage2-resume-bench.ts`、`spatial-group-stage3-model-bench.ts` | 空间画板／群聊各阶段真实模型基准 | 见文件头 | `.poc-tmp/` |
| `g1-report.ts`、`g2-collect.ts`、`g2-collect.ps1`、`g2-progress.ts` | 动态上下文 G1／G2 取证报告与采集 | 见文件头 | `.poc-tmp/`、`output/` |
| `evaluate-active-profile.ps1` | 活跃连接档案评测包装 | `-Batches -Reps -Out [-NoGate]` | `-Out` 目录 |

## 3. 实时联验启动器（浏览器／Electron）

| 入口 | 用途 | 输出 |
|---|---|---|
| `spatial-group-browser.mjs`、`spatial-group-stage1-browser.mjs`、`spatial-group-stage2-browser.mjs`、`spatial-group-stage3-browser.mjs`、`spatial-phase1-browser.mjs` | 画板／群聊各阶段浏览器联验（含 mock host） | `output/playwright/*` |
| `run-session-isolation-model.mjs`、`run-spatial-group-stage2-model.mjs`、`run-spatial-group-stage3-model.mjs` | 真实模型联验启动包装 | `output/session-isolation-model`、`output/spatial-group-*` |
| `logger-epipe-smoke.mjs` | 日志管道关闭（EPIPE）冒烟 | `output/logger-epipe/` |
| `pce01-ab-bench.mjs`、`pce01-gui-ab.mjs` | PCE01 同步域 A/B 基准与 GUI 基准 | `.poc-tmp/`、`output/pce01` |
| `lan-e2e.ts`、`lan-hold.ts`、`lan-mumu-e2e.ts`、`diag-lan-inject.cjs`、`mumu-*.cjs` | 局域网／MuMu 模拟器联验与诊断 | 终端输出 |

## 4. 诊断、工具与一次性材料

| 入口 | 用途 | 处置 |
|---|---|---|
| `decrypt-api-key.cjs` | 用 Electron safeStorage 解出活跃连接 API Key，写入 `--key-file`；被评测脚本引用 | 保留（敏感：输出文件不得入库） |
| `dump-ui-texts.cjs` | 导出 UI 文案 | 保留（诊断） |
| `verify-backup.mjs` | 备份 ZIP 结构校验 | 保留（回归支撑） |
| `refresh-parity-matrix.mjs`、`_gen-parity-md.mjs` | 跨端 parity 矩阵刷新与文档生成 | 保留（报告支撑） |
| `regenerate-roleplay-fixture.ts` | 角色扮演 fixture 再生成 | 保留（跨端 golden 支撑） |
| `gen-phase0-messages-10k.mjs` | 1 万条消息夹具生成 | 保留（基准数据生成） |
| `sign-model-catalog.ts` | 模型目录签名（同步加密生成器） | 保留（安全/契约） |
| `s9-07-legacy-purge-check.mjs` | s9 旧链路清扫检查 | 保留（回归支撑） |
| `mumu-explore.cjs`、`mumu-walkthrough.cjs`、`mumu-sync-center.cjs` | MuMu 模拟器探索脚本 | 保留（诊断） |
| `.mimosa/` | 本地 AI 工具会话状态（gitignore） | 不入库，可清理 |

## 5. 公共联验设施与已知结论（阶段 2/3/5）

- 浏览器联验启动器（第 3 组）共用设施（写 `host.tsx`／`host.html`、518x 端口 Vite、Playwright `msedge`、就绪轮询、`result.json` 与失败截图）已抽取为 [scripts/lib/browserHarness.mjs](./lib/browserHarness.mjs)（`startViteServer`／`launchHarnessBrowser`／`waitForServer`／`runBrowserSession`）。
  - 阶段 5 已完成接入：`spatial-group-browser.mjs`、`spatial-group-stage1-browser.mjs`、`spatial-group-stage2-browser.mjs`、`spatial-group-stage3-browser.mjs`、`spatial-phase1-browser.mjs` 全部改用 `runBrowserSession`，并适配「启用空间画布」开关新流程；5 个脚本均已本地 smoke 通过。
- Electron 联验启动器（`run-session-isolation-model.mjs`、`run-spatial-group-stage2-model.mjs`、`run-spatial-group-stage3-model.mjs`、`logger-epipe-smoke.mjs`）共用打包/启动/日志/退出设施，已抽取为 [scripts/lib/electronHarness.mjs](./lib/electronHarness.mjs)（`buildElectronBundle`／`spawnElectronBundle`／`runElectronBundle`）。
- `clean.ps1` 已于 2026-10-02 重写为白名单模式（见文件头说明），默认仅预览。
- `check-pc-agent.mjs`（2026-10-03 加入）是外部 Agent 工具包的门禁，配合 [`tools/pc-agent/`](../tools/pc-agent/README.md)：目录由 `pnpm pc-agent:catalog` 生成，能力矩阵 [`docs/pc-agent/能力矩阵.md`](../docs/pc-agent/能力矩阵.md) 由目录渲染，禁止手改。**与 `check:gates` 并列执行、结果分别记录**（方案 §10：不同门禁的红绿不得互相掩盖）；CI 的 “Structure gates” 作业里作为独立步骤运行 `pnpm check:pc-agent`。
- 本目录**不含**外部 Agent 工具的验证入口：`verify/dual-entry.mjs`（双入口等价）、`verify/matrix.mjs`（双入口全量矩阵）、`probes/`（可行性探针）都在 `tools/pc-agent/` 下，见该目录 README。
- `工具集` 不含已迁移至 `tests/` 的纯测试与 `output/` 下的草稿。