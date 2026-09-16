# Android 独立客户端重构阶段 2 实施报告

> 日期：2026-09-16  
> 基线提交：`a5aacb5`  
> 结论：**部分通过（基础设施已交付，全量写路径收口未完成）** — 可进入后续域收口；不得据此宣布阶段 2 完成。

## 已完成任务

| 任务 ID | 产物 | 证据 |
|---|---|---|
| S2-02 | `electron/domain/deviceIdentity.ts` | 单测：生成/递增 counter/克隆新身份 |
| S2-03 | `electron/domain/syncMeta.ts`（`node:sqlite`） | device_state/entity_heads/change_log/conflicts/checkpoints/file_transactions/bootstrap_receipts；WAL/FK/busy_timeout |
| S2-01 | `electron/domain/pcRepository.ts` | put/tombstone → 文件 + head + journal；文件事务 PREPARED→FILES_APPLIED→JOURNAL_COMMITTED |
| S2-04 部分 | `usecases/personaUseCase.ts` + settings IPC 钩子 | flag 开启时 persona/settings_public 写 journal |
| S2-05 部分 | `bootstrap.ts` | 幂等 bootstrap receipt + genesisId + datasetHash |
| flag | `electron/domain/featureFlag.ts` | 按域开关 `sync-repo-flags.json` |

## 测试命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm exec vitest run electron/domain` | PASS 7/7 |
| `pnpm check` | PASS |

## 未完成与阻断（阶段 2 剩余）

1. **全量写入口收口未完成**：preset/lorebook/character/session/message/group/usage/mcp 尚未迁 Repository；IPC/Bridge/自动记忆/导入仍大量直写。
2. **崩溃恢复演练**未做：`PREPARED/FILES_APPLIED` 启动前滚回滚逻辑已建表，恢复器未接主进程启动。
3. **绕过检测自动化**未接入 CI（仅有手动能力矩阵清单）。
4. **远端批次应用器 S2-06**、**S2-07 观测导出**未实现。
5. settings_public journal 钩子在业务 `writeJson` **之后**调用；与「同事务」严格语义仍有差距，域收口时需与业务写合并进同一 file transaction。

## 回滚

关闭 `sync-repo-flags.json` 各域为 false；删除 `electron/domain/**` 与 `sync-meta.db` 不影响旧业务读取（业务文件仍由旧 writeJson 负责）。

## 下一阶段输入

- 继续 S2-04 其余域与启动恢复；完成后才能进入依赖“PC journal”的阶段 7 并行线。
- 阶段 3（Android）不依赖本阶段完成。
