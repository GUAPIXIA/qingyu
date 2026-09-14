---
feature: g1-pass
status: delivered
updated: 2026-09-14
branch: feat/g1-pass
commits: 5462034..a79b93c  # 代码经 e552005 文件集并入 main；文档/取证脚本于主计划 §16「G1 方案A通过」修订补回
---

# G1 灰度门通过（方案 A + chenxi flash 实机取证）

## Report

**What was built** — 在 `feat/g1-pass` 上落地方案 A：`disableIgnored` 端点写入 `earlyAbort:false`，适配器 `shouldEnableRunawayGuard` + 流中 `guard.disable()`，取消对可出正文请求的推理越线误杀。实机取证切换到活跃档案 **chenxi / `deepseek-v4.1-flash`**；`g1-report` 按观测失败率与 transport 空正文归因判定，总判通过。

**Verification** — 相关 vitest（adapterGate/reasoningGate/gateRecovery/chat-core）219 例通过；`tsc -b --noEmit` 通过；`--batch verify` 14 例离线通过。实机双臂各 **144 例**：门控臂空正文 0、earlyAbort 0、infra 0；对照臂同。`g1-report` 总判 ✅。复审修复：`attempts>1` 不再作空正文恢复代理（directions 解析重试误计已消除）。

**Journey log**
- 早期 n=240 pro 端点空正文 5.8% + 8/8 中止空正文 → 方案 A（停用 disableIgnored 提前中止）
- flash 活跃档案 model ID 为 `deepseek-v4.1-flash`（无 `chenxi/` 前缀）；评测默认与 `-Model` 对齐
- `attempts` 被 directions 解析重试抬高：恢复统计必须走 transport `length+0` / `empty_output`
- G1 第 1 条字面口径是观测失败率；95% 上界（需 n≥600 零失败）作附注不单独判负
- 环境禁止 `git worktree add`：在主检出用分支 `feat/g1-pass` 代替 worktree

## [S1] Problem

G1 灰度门（主计划 §7.7）未通过：扩样 n=240 推理相关空正文 5.8%，其中提前中止 8/8 空正文。`disableIgnored` 端点上 `off` 已是降档末级，观测线落在推理分布中段导致误杀。用户要求本包**必须实机判过**，并切换到活跃档案 `chenxi` / `deepseek-v4.1-flash`（额度已恢复）。

## [S2] Design

### 已定策略（方案 A，已在分支落地）

1. 端点探测到 `disableIgnored` 时，主进程 `resolveDispatchGateDirective` 写入 `earlyAbort: false`。
2. 适配器 `shouldEnableRunawayGuard`：`earlyAbort === false` 或非 off/none 档 → 不启用推理越线守卫。
3. 流中首次出现 off 档推理 delta → 标记 `disableIgnored` 并 `guard.disable()`，本轮不再中止。
4. 空正文恢复依赖 P90 保守余量 + 零输出一次重试（R1/R2）；**同档重试计入恢复成功率**（仅 transport 空正文 / empty_output）。

### 实机模型与档案

- 活跃 profile：`chenxi`（`-UbocPROcmYx9QN-vdfGO`），`provider=openai`，`baseUrl=http://171.80.3.245:28080/v1`，`model=deepseek-v4.1-flash`。
- 评测默认/覆盖模型 ID 为 **`deepseek-v4.1-flash`**（不是 `chenxi/deepseek-v4.1-flash`——profile 里 model 字段无此前缀）。
- `evaluate-active-profile.ps1 -Model` 可覆盖；空则用活跃 profile。

### G1 判定（本包采用的取证口径）

| 条款 | 本包判定 |
|---|---|
| 推理挤占可见失败率 < 0.5% | **观测失败率**（字面门禁）；95% 上界作附注 |
| 空正文降档恢复 ≥ 90% | **transport 空正文 / empty_output** 触发的同档重试；无样本则 N/A |
| 只有正文 < 20 字符才整轮恢复 | 既有代码契约 + 单测 |
| 提前中止条件 + 成对对照不降正文产出 | 方案 A 后门控臂 `earlyAbort` 应为 0；与 no-gate 对照比正文产出率 |
| 降档额外 completion < 3% | 无降档样本则 N/A（主路径为同档重试） |
| 同请求体成功路径无回归 | prod vs no-gate 成对 |
| 全量/Bridge/Android fixture | 仓库定向测试全绿 |

### 取证命令（入库路径）

```text
pwsh scripts/evaluate-active-profile.ps1 -Batches dialogue,stream,directions -Reps 12 -Out .poc-tmp/eval-g1-flash/prod
pwsh scripts/evaluate-active-profile.ps1 -Batches dialogue,stream,directions -Reps 12 -NoGate -Out .poc-tmp/eval-g1-flash/no-gate
npx tsx scripts/g1-report.ts --arm prod=.poc-tmp/eval-g1-flash/prod/results.json --arm no-gate=.poc-tmp/eval-g1-flash/no-gate/results.json
```

## [S3] Out of Scope

- W8/W9 生产注入接管（仍封停，等 G1 过后按序）。
- 内置 `disableIgnored` 模型档案持久化（W6）。
- 群聊 4 处 `ai.onError` 的完整恢复统一（G1 以单聊/方向/流式取证为主）。
- G2 / 500 次有效生成 / legacy 退出。
- Android 接入。

## Tasks

- [x] T1: 基线提交 W9 影子 + 方案 A，并修正评测模型 ID 默认值 — acceptance: 分支可干净复现；`deepseek-v4.1-flash` 为默认模型；`tsc`/相关单测绿 (covers: S2)
- [x] T2: 增强 g1-report：空正文恢复按 transport 归因；第1条观测失败率；总判 — acceptance: 报告输出恢复率与 earlyAbort 行；无样本时 N/A (covers: S2; depends: T1)
- [x] T3: 实机门控臂 + 对照臂扩样（chenxi flash） — acceptance: 两臂各 144 例；无系统性 429 (covers: S2; depends: T1)
- [x] T4: 汇总 G1 七条并给出通过/不通过 — acceptance: `g1-report` 总判 ✅；空正文 0/144；earlyAbort 0 (covers: S2; depends: T3)
- [x] T5: 定向回归 + 技术评审 — acceptance: vitest/tsc 绿；复审无 critical (covers: S2; depends: T4)
