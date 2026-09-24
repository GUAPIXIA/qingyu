# Android 独立客户端重构阶段 8 实施报告

> 日期：2026-09-24  
> 基线提交：工作区（阶段 7 S7-01～S7-08 已落、未提交）之上  
> 完成提交：本报告随工作区提交  
> 结论：**工程范围通过**（待真实 PostgreSQL/对象存储联调与端到端演练后签字）

## 已完成任务

| 任务 ID | 产物 | 证据 |
|---|---|---|
| 决策冻结 | [`阶段8前置决策冻结`](./Android独立客户端重构阶段8前置决策冻结-2026-09-24.md) | 威胁模型、scrypt 恢复包、配额默认值、对象存储、保留期、轮换运维 |
| S8-01 | `shared/sync-crypto/`（已有）+ **修复 TS `encryptEntity` 双重 `buildEntityAad` 导致 GCM tag 与 JVM 不一致**；重生成 `e2ee-interop.json` | `syncCrypto.test.ts` 21/21；`SyncCryptoGoldenTest` 7/7（含实体密文逐字节） |
| S8-02 | `keyEnvelope.ts`/`recovery.ts` + 服务端 `keyRoutes`（登记/信封中转/challenge 语义）+ 恢复包 scrypt 决策 | golden 复算 SAS/wrapKey/签名；`validateKeyEnvelopeWire` 单测 |
| S8-03 | `relay-server/migrations/004_sync.sql` + `src/sync/{types,validation,session,quota,objectStore,syncRoutes,keyRoutes,retention}` | `pnpm check`；`syncValidation` 13 例 |
| S8-04 | `electron/domain/serverTransport.ts` + `android/.../ServerSyncTransport.kt` | `serverTransport.test.ts` 5 例；`ServerSyncTransportTest` 4 例 |
| S8-05 | `quota.ts` 默认配额 + push 原子拒绝 + plan 配额回显 + `GET /sync/v1/quota` | 配额单测 4 分支 |
| S8-06 | `POST /sync/v1/keys/rotate` + `sync_reencrypt_cursors` + 重加密批次校验（不伪造业务 dot） | 校验单测 + 路由 |
| S8-07 | 备份脚本覆盖对象存储；指标（session/push/commit/key envelope）；保留期 GC 纯逻辑 | `syncRetention.test.ts` 4 例；`deploy/backup.sh` |

## 契约或迁移变化

1. **E2EE 线格式**：push/pull 使用 `WireEntity`（元数据 + 密文），不是明文 `SyncEnvelope`。加密在进入 transport 前完成。
2. **AAD 契约修复**：`encryptEntity`/`decryptEntity` 接受 `EntityAadInput | string`；**禁止**对已规范化的 AAD 字符串二次 `buildEntityAad`。跨端 golden 已按标准 GCM（与 JCE 互操作）重生成。
3. **数据库**：`relay-server/migrations/004_sync.sql` 新增 12 张 `sync_*` 表，全部启用 RLS；应用角色无 SUPERUSER/BYPASSRLS。
4. **恢复包 KDF**：Argon2id 评估后冻结 **scrypt**（N≥2^15 推荐 2^18, r=8, p=1, dkLen=32）。
5. **配额默认**：实体 100 000 / 密文 500 MiB / 单 blob 64 MiB / batch 200 条·4 MiB / 设备 10。

## 测试命令与结果

| 命令 | 结果 | 日志/产物 |
|---|---|---|
| `pnpm check` | 通过 | 根 TS + electron |
| `pnpm test -- shared/__tests__/syncCrypto.test.ts … syncRoutes*.test.ts` | **62/62** | 含 syncCrypto 21、syncCoreGolden 8、lanAuth 9、syncLanAuth 5、syncRoutes 7、faultMatrix 8、syncCenter 4 |
| `pnpm --dir relay-server check` | 通过 | |
| `pnpm --dir relay-server test` | **35/35** | syncValidation 13、serverTransport 5、syncRetention 4 + 既有 13 |
| `.\gradlew.bat :app:testDebugUnitTest --tests synccore.* --tests network.sync.*` | **BUILD SUCCESSFUL** | `SyncCryptoGoldenTest`（含实体密文/tag 与 TS golden 一致）、`ServerSyncTransportTest` 4 例 |
| `npx tsx tools/gen-sync-crypto-fixtures.ts` | 写出 `shared/fixtures/cross-platform/sync-crypto/e2ee-interop.json` | 固定测试密钥，生产禁用 |

### 关键缺陷修复（本轮抓到）

| 缺陷 | 影响 | 处置 |
|---|---|---|
| TS `encryptEntity` 将已是字符串的 AAD 再 `buildEntityAad` 一次 | 实体 GCM **tag 与 JVM/标准 GCM 不一致**，服务器模式跨端解密必败 | 改为 `EntityAadInput \| string` 直用；重生成 golden；Kotlin 侧无需改 |
| counter 未挡 UInt64 溢出 | 极端 counter 可绕过 | `validateVersionVector` 增加 `> 2^64-1` 拒绝 |
| `syncRoutes.stage` 缺 `sessionId`、`EntityHeadRow` 无 `updatedAt` | `pnpm check` 红（阶段 7 遗留） | 最小补齐 |

## 未完成与阻断

1. **真实 PostgreSQL + 对象存储联调**：迁移 `004_sync.sql` 未在实库执行；路由层集成测试未起真库。需要 CI/运维环境跑 `pnpm migrate` + 安全矩阵（跨空间 404、吊销设备、batch 重放、密钥信封替换）。
2. **端到端演练**（阶段 8 §5）：PC↔Android 经服务器双向、并发双 head、push/pull/commit 各阶段重启、PG+对象存储恢复。
3. **客户端 UI 接线**：ServerTransport 已就绪，同步中心「我的服务器」入口尚未接到 `runSyncFlow`（阶段 7 同步中心已留入口位）。
4. **Keystore wrapping / 真机密钥交付走查**：Kotlin `SyncCrypto` 已有恢复包/信封原语；Android Keystore 包装与带外 SAS 真机批准流待实机。
5. **历史重加密任务调度**：游标 API 与表已齐，客户端维护任务未接 UI。
6. **安全审计清单**（§4）自动化覆盖不全：恶意压缩包/JSON 深度、数据库泄露演练、日志泄密扫描待补。

## 回滚方法

1. 服务端：关闭 `/sync/v1` 新 session 创建（摘 `syncRoutes`/`keyRoutes` 注册），允许只读导出窗口；客户端退回纯本地或局域网同步。
2. 数据库：`004_sync.sql` 为增量表，回滚只需停止写入；勿在未提供导出前删密文。
3. 客户端：`serverTransport` / `ServerSyncTransport` 未接入主路径前可整文件移除；GCM AAD 修复必须保留（否则与 JVM 不互操作）。
4. 不得恢复旧 `/relay/v1` RPC 作为回退。

## 下一阶段输入

- 阶段 9：一次性迁移、旧链路删除与发布；本阶段确认**不**把旧 Relay RPC 挂进 `/sync/v1`。
- 运维：按决策冻结表配置 `RELAY_OBJECT_DIR`、配额、备份（DB+objects）与告警（hash 错误激增、对象不一致、RLS 异常）。
- 安全：按 §4 清单补自动化；密钥丢失场景依赖用户恢复包，服务端不可找回。
