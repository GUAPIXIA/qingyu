# tools/ 登记

> 用途：登记本目录探索脚本与外部集成工具的生命周期，避免把“一次性材料”误认为生产入口，也避免把仍有证据价值的材料直接删除。
> 最后核对：2026-10-02（阶段 2 工具整理）。

## 1. 保留（有契约／生成职责）

| 路径 | 用途 | 运行方式 | 说明 |
|---|---|---|---|
| `gen-sync-crypto-fixtures.ts` | 生成跨端 E2EE 互操作 fixture（固定测试密钥，生产禁用） | `pnpm exec tsx tools/gen-sync-crypto-fixtures.ts` | 被 `shared/__tests__/syncCrypto.test.ts`、`android/shared/__tests__/syncCrypto.test.ts` 的契约验证间接依赖；**不得删除** |
| `gcm-vector.json` | 跨端 GCM 测试向量 | 数据文件 | 与 `debug-cross2.ts` 配合的一次性验证材料 |

## 2. 探索脚本（一次性材料，保留但不再维护）

| 路径 | 用途 | 说明 |
|---|---|---|
| `debug-aad.ts` | 打印 E2EE AAD／子密钥／密文标签 | 2026-09 同步加密排障遗留 |
| `debug-b64.ts` | Base64 编解码差异对比 | 同上 |
| `debug-cross.ts`、`debug-cross2.ts` | TS ⇄ Java 跨端解密对照 | 同上；`debug-cross2` 读取 `gcm-vector.json` |
| `debug-entity.ts` | 实体加密往返检查 | 同上 |
| `debug-gcm*.ts`（5 个） | AES-256-GCM 参数与标签行为核对（含 NIST 向量） | 同上 |

这些脚本只打印诊断信息、无测试或构建消费者。如需清理，先确认排障记录已归档到报告；默认保留，不进入删除名单。

## 3. mimo-bridge（外部集成勘察）

| 路径 | 用途 | 说明 |
|---|---|---|
| `ARCHITECTURE.md` | DSH ⇄ Xiaomi MiMo 桥接勘察结论 | 决策记录，保留 |
| `asar.mjs`、`dispatch.mjs`、`inspect-events.mjs` | 桥接通道验证脚本 | 保留（外部工具职责） |
| `state.json` | 桥接状态快照 | 运行时数据，可重建 |

## 4. 处置结论（阶段 2/3）

- `gen-sync-crypto-fixtures.ts` 属跨端契约生成器，列出保留；输出写入受保护的 `shared/fixtures/cross-platform/sync-crypto/e2ee-interop.json`。
- `debug-*.ts`、`gcm-vector.json` 为一次性探索材料：保留现状，不新增消费者；若后续确认排障记录完整，可整体归档。
- `mimo-bridge/extracted/`（Desktop bundle 提取副本）、`mimo-bridge/logs/`（一次性勘察日志）、`mimo-bridge/scratch/`（冒烟草稿与 `.mimocode` 引导副本）已于 2026-10-02 移入 `.tmp-archive/mimo-bridge-rebuildable-20261002/`：三者均可重建，且 `dispatch.mjs` 未引用；如需恢复原位置，将其移回 `tools/mimo-bridge/` 即可。
- 本目录不含 `tests/` 下的自动化测试与 `output/` 下的联验证据（各自有独立登记）。