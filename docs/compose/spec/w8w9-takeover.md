---
feature: w8w9-takeover
status: delivered
updated: 2026-09-14
branch: feat/w8w9-takeover
commits: 2f4e582..98cb956
---

# W8+W9 生产接管（记忆候选注入 + 世界书去固定比例）

## Report

**What was built** — G1 通过后启动上下文生产切换：记忆由 `buildMemoryCandidateSet` + `allocateContextCandidates(budgetBase)` 选择并经 `materializeMemoryInjection` 注入（去掉 `min(800, budgetBase*0.1)` 专属上限）；分配/物化异常回落 `fitLayeredMemoryBudget`（有测）。世界书删除 `lorebookRatio` 乘法，`lorebookBudget = budgetBase`，历史仍由 `cropHistory` 吃剩余。群聊路径未改。

**Verification** — `vitest shared/chat-core + contextBuilder` **188 通过**（含回滚 2 例）；`tsc -b --noEmit` 通过。复审 C1（回滚无测）已用 `vi.mock` 强制 materialize 抛错关闭，复审无 critical。

**Journey log**
- 接管后 `memoryShadow.existing.capTokens = budgetBase`（不再是 800）；大窗口测试改为断言注入 > 800
- 记忆与世界书各自可占满 `budgetBase`，仅历史被 crop——已知设计上限，统一池 re-render 留 W10
- 回滚必须用 `vi.mock` 打断 `materializeMemoryInjection` 才能强制 catch 路径
- 环境仍禁 `git worktree add`：分支 `feat/w8w9-takeover` 基于 `feat/g1-pass`

## [S1] Problem

G1 已于 2026-09-14 方案 A 实机通过。主计划 §7.7 允许启动上下文生产切换，但 W7–W9 仍只影子运行：
- 记忆注入仍走 `fitLayeredMemoryBudget` 的 `min(800, budgetBase*0.1)` 固定上限；
- 世界书仍用 `budgetBase × lorebookRatio`（默认 30%）固定比例；
- 历史裁剪后摘要路径已有，但与统一预算/候选选择未对齐。

用户要求本包做 **W8+W9 全量接管**（记忆 + 世界书 + 历史确认摘要优先）。

## [S2] Design

### 接管范围与不变量

| 层 | 接管行为 | 回滚 |
|---|---|---|
| 记忆 W8 | `buildMemoryCandidateSet` + `allocateContextCandidates(budgetBase)` 选择后注入；**去掉 800/10% 上限** | 分配/物化异常时回落 `fitLayeredMemoryBudget(memoryBudget)`；存储永不因本轮分配删除 |
| 世界书 W9 | `lorebookBudget` 不再乘 `lorebookRatio`，改为 `budgetBase`（历史由 `cropHistory` 吃剩余）；运行时内 always/conditional/detail 瀑布与 summary 替代保留 | 运行时失败路径不变；无新开关 |
| 历史 W9 | 既有「有压缩摘要且覆盖裁剪范围则注入摘要」保持；确认不先删摘要再删原文 | 无行为回退需求（原逻辑即此） |

**明确不做（本包）**：群聊 `groupChatContext` / `groupMemoryManager` 仍走旧路径；统一池端到端 re-render（记忆→世界书→历史仍按现有注入顺序，靠 `budgetBase` 共享与 history crop 逼近统一预算）；W10 UI。

### 记忆物化契约

新增 `materializeMemoryInjection(plan, selectedIds, source)`：

- 输入：候选集、分配器 `selectedIds`、原始 `currentState/facts/timeline`；
- 输出：`{ currentState, facts, timeline }`（可直接拼进 systemContent）；
- current-state：`memory:current-state` 入选则用完整 trim 文本（候选侧不再截断状态段）；
- facts：按官方 `scoreAndRankFacts` 序过滤入选 id，还原 `MemoryFactRecord[]`；
- timeline：按候选顺序拼接入选 chunk 的 `text`（保留最新优先的块序）；
- 入选为空 → 该层空字符串/空数组。

### 世界书预算

```ts
// 旧：Math.floor(budgetBase * clamp(lorebookRatio, 0.05, 1))
// 新：budgetBase（固定比例删除；保留 lorebookRatio 设置读但不参与生产预算）
const lorebookBudget = budgetBase
```

历史 `cropHistory` 的 `usedTokens` 已含世界书占用，空间不足时裁历史——与「统一剩余预算」语义一致。

### 观测

- `memoryShadow` 仍记录：`existing` = 本轮候选注入结果（接管后）；`plan` 仍为全量候选（供对照）；
- 或：`existing` 统计接管注入，日志 `mode=memory-takeover` 数值串；
- 隐私不变：只计数/token/id。

### 测试边界

- 单测：`materializeMemoryInjection` 入选/空选/事实回填/时间线拼接；
- 集成：开关影子仍不改 `messages` 相对关系（接管后 with/without shadow 一致）；
- 回归：大预算可超 800；小预算不丢 mandatory 记忆层（state 优先）；
- 世界书：有 always 条目时仍注入；无 ratio 时 lorebook 仍可占满预算但历史被 crop；
- 不跑真实模型。

## [S3] Out of Scope

- 群聊记忆/世界书路径；
- 序列化后审计 `serialized:true` 适配器接入；
- W10 诊断 UI / settings v3→v4；
- G2 / legacy 退出；
- 统一池一次分配后重排全部消息（未来优化）。

## Tasks

- [x] T1: `materializeMemoryInjection` + 单测 — acceptance: 入选/空选/事实/时间线物化正确 (covers: S2)
- [x] T2: `contextBuilder` 记忆接管（候选注入 + 回滚） — acceptance: 无影子时 messages 含候选注入记忆；异常回落旧行为有测 (covers: S2; depends: T1)
- [x] T3: 世界书 lorebookBudget=budgetBase — acceptance: 无 lorebookRatio 乘法；历史仍 crop 进预算；always 仍注入 (covers: S2; depends: T2)
- [x] T4: 影子/日志与回归 — acceptance: 相关 vitest + tsc 绿；memoryShadow 与注入自洽 (covers: S2; depends: T3)
- [x] T5: 技术评审 — acceptance: 无 critical (covers: S2; depends: T4)
