# compose 阶段收口索引

> 范围：`docs/compose/spec/` 下全部阶段收口记录（9 份）。
> 状态取自各文件前言 `status`；这些是**阶段验收记录**，不是待办方案——落地或过时后按 [文档索引](../README.md) 的归档规则处理。
> 本页由 [文档索引](../README.md) 的「架构/ 与 compose/」小节链接。

| feature | 主题 | 状态 | updated | commits | 文档 |
|---|---|---|---|---|---|
| `g1-pass` | G1 灰度门通过（方案 A + chenxi flash 实机取证） | delivered | 2026-09-14 | `5462034..a79b93c`（代码经 `e552005` 文件集并入 main） | [g1-pass.md](./spec/g1-pass.md) |
| `g2-readiness` | G2 取证就绪（分段进度与验收清单） | delivered | 2026-09-14 | `5462034..25aeeeb` | [g2-readiness.md](./spec/g2-readiness.md) |
| `w8w9-takeover` | W8+W9 生产接管（记忆候选注入 + 世界书去固定比例） | delivered | 2026-09-14 | `2f4e582..98cb956` | [w8w9-takeover.md](./spec/w8w9-takeover.md) |
| `w11-cleanup` | W11 旧链路清理与上限复审 | delivered | 2026-09-14 | `4b49b54..8621cfe` | [w11-cleanup.md](./spec/w11-cleanup.md) |
| `pc-ux-phase2` | PC 端体验阶段 2（中波 M）收口 | done | 2026-10-03 | pending（收口事实见[第二轮实施报告](../报告/PC端用户体验修复实施报告-第二轮.md) §9） | [pc-ux-phase2.md](./spec/pc-ux-phase2.md) |
| `phase0-android-sync-baseline` | 安卓独立客户端与主动同步 · 阶段 0 基线冻结与决策门 | delivered | 2026-09-16 | `002ce41..f509918` | [phase0-android-sync-baseline.md](./spec/phase0-android-sync-baseline.md) |
| `phase1-contracts-repo-boundary` | 规范契约与仓储边界（阶段 1） | delivered | 2026-09-16 | `04ad93b..HEAD` | [phase1-contracts-repo-boundary.md](./spec/phase1-contracts-repo-boundary.md) |
| `phase2-pc-repo-journal` | PC 写路径收口与变更日志（阶段 2） | delivered（阶段验收仍为「待验收」，PCE-01 GUI 相对门禁未过） | 2026-10-03 | `a5aacb5..HEAD` | [phase2-pc-repo-journal.md](./spec/phase2-pc-repo-journal.md) |
| `phase3-android-local-data-models` | Android 独立数据与模型连接（阶段 3） | delivered（待阶段负责人签字） | 2026-10-03 | `60b536f..HEAD` | [phase3-android-local-data-models.md](./spec/phase3-android-local-data-models.md) |

## 关联登记

- 主计划与阶段方案：[PC 生成入口冻结清单](../方案/PC生成入口冻结清单-2026-09-13.md)、[方案族执行索引](../方案/安卓独立客户端与主动同步/README.md)
- 实施与取证报告：[文档索引](../README.md) 的 `报告/` 小节
