# Android 独立客户端重构阶段 7 实施报告

> 日期：2026-09-24  
> 基线提交：工作区（含 `047e093` 及之后未推送改动）  
> 完成提交：随本报告与阶段 7/8 工作区整理提交  
> 结论：**工程范围通过；待验收**（Android 同步中心完整页、真机 LAN 联调、前台服务、PCE-01 A/B 取证闭合后方可签字）

## 已完成任务

| 任务 ID | 产物 | 证据 |
|---|---|---|
| **S7-01** Sync Core 纯逻辑 | `shared/sync-core/`（batch/capability/conflictSuggest/dependency/lanAuth/plan/sessionMachine/summary/tombstone/types）+ Kotlin `SyncCore.kt`/`LanAuth.kt` | golden `shared/fixtures/cross-platform/sync-core/`（plan/batch/conflict/dependency/session/capability/tombstone/lanAuth）；`syncCoreGolden.test.ts` **8/8**；`lanAuth.test.ts` **9/9**；Kotlin `SyncCoreGoldenTest`/`LanAuthGoldenTest` |
| **S7-02** 同步摘要 | `shared/sync-core/summary.ts` + `electron/domain/syncSummary.ts` | `syncSummary.test.ts` **3/3** |
| **S7-03** LAN 一次性授权 | `electron/domain/syncLanAuth.ts`（X25519 临时钥 + secret + SAS + 5 min TTL + scope=sync）+ Android `LanSyncAuthClient`/`SyncAuthScreen` | `syncLanAuth.test.ts` **5/5**（QR 字段/短认证串一致/SAS 不匹配拒绝/TTL/替换 session） |
| **S7-04** PC `/sync/v1` 路由 | `electron/bridge/syncRoutes.ts`（独立限流/body/并发/超时；鉴权前休眠拒绝；staging→prepare→commit） | `syncRoutes.test.ts` **7/7**；`syncRoutes.faultMatrix.test.ts` **8/8**（cancel/重复 push/乱序/commit 丢失恢复/hash 篡改/删改冲突/父删子写/双向 cursor） |
| **S7-05** Android LAN transport | `OkHttpSyncEngine` + `LanSyncTransport` + `LanSyncAuthClient` + `SyncAuthScreen/ViewModel` | `LanSyncTransportTest`/`LanSyncAuthClientTest`；扫码→SAS→PC 确认→会话密钥 UI 流 |
| **S7-06** 冲突中心基础 | `shared/sync-core/conflictSuggest.ts` + `dependency.ts`（`DEPENDENCY_CONFLICT`/delete fence） | golden `conflict.json`/`dependency.json`；faultMatrix 删改/父删子写用例 |
| **S7-07** 同步中心 UI（PC） | `src/pages/settings/SyncCenterSection.tsx` + `electron/ipc/syncCenter.ts` | `syncCenter.test.ts` **4/4**（LAN 授权流、设备列表、退役 receipt 清除、tombstone dry-run） |
| **S7-08** Tombstone 与设备管理 | `shared/sync-core/tombstone.ts` + 同步中心 dry-run | `tombstone.json` golden；`syncCenter` 设备退役用例 |

**门禁汇总（2026-09-24）**

| 命令 | 结果 |
|---|---|
| `pnpm check` | 通过 |
| `pnpm test -- …（阶段 7 同步套件）` | **50/50**（syncCore 8 + lanAuth 9 + syncSummary 3 + syncLanAuth 5 + syncRoutes 7 + faultMatrix 8 + syncCenter 4 + syncHealth 6） |
| `pnpm --dir relay-server check && test` | 通过（阶段 8 路由共用协议形状；35/35） |
| Android `synccore` + `network.sync` 单测 | BUILD SUCCESSFUL（含 `SyncCryptoGoldenTest`、`ServerSyncTransportTest`、Lan 系列） |

## 契约或迁移变化

1. **同步状态机**固定为方案 §1（`idle→scanning→…→completed` / `cancelling` / `failed`），服务端会话态为 OpenAPI `open/planned/…/expired`（阶段 8）。  
2. **LAN 授权**：二维码固定携带协议版本、host/port、sessionId、临时 X25519 公钥、256 位 secret、过期时间、指纹；SAS 由完整 transcript 派生；**禁止**复用长期 Bridge JWT。  
3. **批次排序**：父→子→引用→tombstone；`batchHash`/`idempotentKey` 跨端 golden。  
4. **D-1～D-12** 已于 2026-09-23 冻结（见[前置契约决策记录](./Android独立客户端重构阶段7前置契约决策记录-2026-09-23.md)），实体清单含独立 `group_session`/`group_message`。  
5. PC `/sync/v1` 与旧 Bridge 业务路由隔离；**不接入** Relay RPC allowlist。

## 测试命令与结果

见上表。故障矩阵 8 项均有自动断言（`syncRoutes.faultMatrix.test.ts`），对应方案 §3 表中 plan 取消、push 重复、pull 乱序、commit 丢失、hash 篡改、删改冲突、父删子写、双向游标。

## 未完成与阻断

1. **Android 同步中心** — **骨架已落**（2026-09-24，`SyncCenterScreen/ViewModel` + 设置入口 + `Routes.SYNC_CENTER`；backlog/手动开始取消/LAN·服务器入口位；`SyncCenterViewModelTest` 4/4）。**仍缺**：真实 plan/进度对接 `LanSyncTransport`/`ServerSyncTransport.runSyncFlow`、冲突列表页。  
2. **真机 LAN 联调**（Android ↔ PC 扫码双向同步 P0 数据）。  
3. **前台服务** — **骨架已落**（`SyncForegroundService` + Manifest `dataSync`；默认暂停、用户显式后台继续）。**仍缺**：与 transport 生命周期接线与取消钩子。  
4. **PCE-01 A/B 取证**（阶段 2 §8.1）——本阶段验收前置；见阶段 2 报告追加节（领域层已采，**GUI 半边仍缺**）。  
5. **物理真机矩阵** + **API 31**（GMD 环境锁/超时，2026-09-24 重试 2 次仍阻断）。

## 回滚方法

- 关闭 `manualSyncLanEnabled` / 吊销未完成 session；保留 journal 与冲突记录。  
- apply 前 checkpoint → 恢复至最后成功 receipt；**禁止**删 journal 假装回滚。  
- 代码回滚：`shared/sync-core/`、`electron/{bridge/syncRoutes,domain/syncLanAuth,ipc/syncCenter,syncLan}`、Android `synccore`/`network/sync`/`ui/sync` 为新增面；业务写路径仍受阶段 2 flag 控制。

## 下一阶段输入

- 阶段 8 已在此协议形状上扩展服务器 `/sync/v1` + E2EE（见阶段 8 报告）。  
- 阶段 9：旧链路删除清单以阶段 3/7 登记的远程 Repository/连接状态机为准。  
- 验收顺序：**PCE-01 → 阶段 2 签字 → 阶段 7 签字**。
