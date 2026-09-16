# Android 独立客户端重构阶段 2 实施报告

> 日期：2026-09-16  
> 基线提交：`a5aacb5`  
> 完成提交：见 git log（`e34fe03` 基础设施 + 本轮续作）  
> 结论：**部分通过** — 基础设施 + 启动恢复 + 远端 apply + 观测 + 多域 journal 钩子已交付；**全量 IPC/Bridge 写入口收口未完成**，不得宣布阶段 2 完成。

## 已完成任务

| 任务 ID | 产物 | 证据 |
|---|---|---|
| S2-02 | `deviceIdentity.ts` | 单测：生成/递增/克隆 |
| S2-03 | `syncMeta.ts`（`node:sqlite`） | heads/change_log/file_transactions/bootstrap_receipts |
| S2-01 | `pcRepository.ts` | put/tombstone → 文件+head+journal |
| S2-04 部分 | persona/regex/**preset**/**lorebook**/**quickReply**/**usage**/**character**/**chat**/**group** IPC + settings_public | bypass **7/11**；OPEN: mcp、bridge chatService/routes、services/usage 底层 |
| S2-05 | `bootstrap.ts` | 幂等 receipt + genesisId |
| 启动恢复 | `recovery.ts` | PREPARED→ABORT；FILES_APPLIED→ABORT 待哈希增强 |
| S2-06 骨架 | `remoteApply.ts` | origin=remote、HASH_MISMATCH 拒绝、冲突表、伪冲突收敛 |
| S2-07 | `metrics.ts` + `scripts/check-write-bypass.mjs` | 诊断不含正文；静态绕过清单 |

## 测试命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm exec vitest run electron/domain` | **PASS 13/13** |
| `pnpm check` | **PASS** |
| `node scripts/check-write-bypass.mjs` | high-risk journaled **11/11**（character/chat/group/lorebook/preset/quickReply/usage/mcp + bridge chatService/routes + services/usage） |

## 未完成与阻断

1. HIGH_RISK 写入口已 11/11 journaled。
2. FILES_APPLIED 恢复未按磁盘 hash 前滚/回滚。
3. 真实用户数据 bootstrap/崩溃恢复/Backup V2 回滚演练未做。
4. lorebook/quickReply journal 为骨架 payload；flag 默认关闭，生产尚未默认启用。
5. usage 在 IPC 与 service 层可能双重 journal（flag 开启时），后续可合并到单一入口。

## 回滚

`sync-repo-flags.json` 全 false；删除 `electron/domain/**` 与 `sync-meta.db`。

## 下一阶段输入

- 阶段 3 可并行（Android 数据/模型连接）。
- 阶段 7 依赖本阶段写入口收口完成后启用真实 journal 上传。
