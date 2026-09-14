---
feature: w11-cleanup
status: designed
updated: 2026-09-14
branch: feat/w11-cleanup
commits:
---

# W11 旧链路清理与上限复审

## Report

## [S1] Problem

G2 七条已核实通过。主计划 §7.14 要求在 G2 后清理已无生产必要或已完成使命的路径：legacy 生成管线、方向 1536、记忆 800 主路径、世界书固定比例、shadow 默认记录、`reasoningGateEnabled` kill switch，并独立复审 8192 安全阀。

本分支已并入 W8W9 记忆/世界书接管与方案 A（`e552005`）。`fitLayeredMemoryBudget` **保留为异常回滚**（§7.10 第 2 条），不删除函数本身。

## [S2] Design

| 项 | 动作 |
|---|---|
| legacy 退出 | 默认已 unified；设置 UI **隐藏** legacy 选项（一版仍可读旧 settings 并走 legacy）；`pipelineLegacy` 代码分支保留一个版本 |
| 方向 1536 | 已无生产调用（W4）；删除残留常量/注释若仍存在 |
| 记忆 800 | 生产主路径已是候选注入；**保留** `fitLayeredMemoryBudget` 作 catch 回滚；删除「生产仍走 800」的误导性注释 |
| 世界书比例 | 生产 `lorebookBudget=budgetBase`；`Settings.lorebookRatio` 已迁出；Bridge 兼容字段可保留 patch 校验但不参与预算 |
| shadow | `BuildOptions.shadow` **默认改为 `'off'`**（生产不再记录分类影子）；显式 `'shadow'` 仍可测/诊断 |
| reasoningGateEnabled | G1 已过：**强制视为开启**（`isReasoningGateEnabled` 恒 true）；设置页移除开关；旧字段可保留读兼容 |
| 8192 | §10 决策门：**保留** `MAX_REQUEST_OUTPUT_TOKENS=8192`（证据不足，见 G2/G1 报告）；写入 ADR 注记 |
| 旧消息渲染 | 不动 |
| 文档 | 主计划 §7.14、README、CHANGELOG、W11 实施报告 |

### 行为不变量

- 不删除 Android 兼容渲染；
- 不删除 `fitLayeredMemoryBudget` / adapter 守卫实现（可测与回滚）；
- 不把 8192 提高或删除；
- 群聊未下沉路径暂不强改（仅注释/默认一致）。

## [S3] Out of Scope

- 真正物理删除 `fitLayeredMemoryBudget` 实现体；
- 提高/删除 8192；
- Android UI 接入新门控语义；
- 远程合并 main（环境禁 merge）。

## Tasks

- [ ] T1: shadow 默认 off；gate 开关强制 on + 去 UI — acceptance: 缺省不产 contextShadow；isReasoningGateEnabled 恒 true (covers: S2)
- [ ] T2: legacy 设置隐藏、默认 unified；注释与误导文案清理 — acceptance: 设置页无 legacy 切换；旧数据仍可读 (covers: S2; depends: T1)
- [ ] T3: 8192 ADR 注记 + 主计划/README/CHANGELOG/W11 报告 — acceptance: 文档写明保留 8192 与 W11 完成项 (covers: S2; depends: T2)
- [ ] T4: 定向测试 + 评审 — acceptance: 无 critical (covers: S2; depends: T3)
