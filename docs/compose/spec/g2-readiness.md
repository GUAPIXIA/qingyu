---
feature: g2-readiness
status: designed
updated: 2026-09-14
branch: feat/g2-readiness
commits:
---

# G2 取证就绪（分段进度与验收清单）

## Report

## [S1] Problem

主计划 W10 已交付后，下一阶段是 **G2 legacy 退出门**（§7.13）。G2 需要 ≥500 次有效生成且覆盖 ≥2 供应商，样本必须按功能状态分段、不得混合。现有 `generation-baseline` 只报告全局有效数，**不判定分段是否可过门**，也缺少可复用的离线清单。

用户选择本包只做 **G2 取证工具**（不落地 W10/功能分支、不做 W11）。

## [S2] Design

### 纯逻辑 `shared/g2Readiness.ts`

- 有效生成口径**复用** `computeValidGenerations`（C4 冻结），不重定义分母。
- 分段键：`pipeline`（unified|legacy，缺省 unified）× `gate`（off/low/standard/full/none）。
- `computeG2Progress`：分段有效数、供应商列表、是否存在「单段 ≥500 且 ≥2 供应商」的可过门分段。
- `buildG2Checklist`：§7.13 七条清单；可离线判定的标 pass/pending，其余 pending 并注明人工证据。
- `formatG2ProgressSummary`：一行数值日志。

### 脚本 `scripts/g2-progress.ts`

```text
npx tsx scripts/g2-progress.ts [--file jsonl] [--out report.md] [--days N]
  [--g1-passed] [--phase7-ok] [--dynamic-context-ok] [--android-ok] [--legacy-kept]
```

- 默认读 userData 观测 JSONL（与 baseline 同路径规则）；
- 输出分段表 + 清单；
- 退出码：可过门 0，未达标 2（便于监控）。

### 过门口径

**仅同一分段**满足有效 ≥500 且供应商 ≥2 才 `pass=true`。跨段加总只作总览，不可过门。

## [S3] Out of Scope

- 自动读取 G1 报告文件（清单用旗标人工标注）；
- W11 删除 legacy / 8192 复审；
- 实机连打 500 次生成；
- 合并 W10/功能分支到 main。

## Tasks

- [ ] T1: `g2Readiness` 纯函数 + 单测 — acceptance: 分段/跨段混合不过门、单段过门、排除 error/aux/后台 (covers: S2)
- [ ] T2: `g2-progress` 脚本 + 本机观测试跑 — acceptance: 输出分段表与清单；未达标 exit 2 (covers: S2; depends: T1)
- [ ] T3: 技术评审 — acceptance: 无 critical (covers: S2; depends: T2)
