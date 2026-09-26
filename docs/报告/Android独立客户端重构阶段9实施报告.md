# Android 独立客户端重构阶段 9 实施报告

> 日期：2026-09-26  
> 基线提交：`4d00c16`（QR 注入 + MuMu↔PC 真 LAN 联调）  
> 结论：**工程范围已落（待验收）**——S9-01/02/06、S9-07 旧链路清零、PC/Relay/Android 门禁绿。  
> 前置：阶段 6、8 尚未全部签字；S9-04/08 实机与演练待执行后方可置「已完成」。

## 1. 任务完成情况

| 任务 ID | 产物 | 证据 |
|---|---|---|
| **S9-01** PC 升级预检 | `electron/domain/upgradePrecheck.ts`：可用空间、损坏 JSON/JSONL、重复 ID、孤儿媒体、schema；只读、可取消 | `upgradePrecheck.test.ts` 7 例 |
| **S9-01** Android 一次性迁移 | （阶段 3 已有）`LegacyCacheReader/Importer` + `LocalSetup` 三选一向导 | `LegacyCacheMigrationTest`、`StartupDecisionTest` |
| **S9-02** 首次同步引导 | `electron/domain/firstSyncPlan.ts` + `syncCenter:buildFirstSyncPlan` IPC：初始资料侧、migrationGenesisId、禁止一键覆盖 | `firstSyncPlan.test.ts` 5 例 |
| **S9-03** E2E 矩阵骨架 | [S9-03-E2E旅程矩阵.md](../方案/安卓独立客户端与主动同步/S9-03-E2E旅程矩阵.md) | 旅程 J1–J18 清单 |
| **S9-05** 发布门禁项 | `scripts/s9-07-legacy-purge-check.mjs` 引用清零扫描 | 扫描报告 |
| **S9-06** 遥测隐私 | `shared/telemetry/privacy.ts`：明确同意、白名单、计数落桶、敏感键丢弃 | `telemetryPrivacy.test.ts` 5 例 |
| **S9-07** 删除清单 | [S9-07-旧伴侣链路删除清单.md](../方案/安卓独立客户端与主动同步/S9-07-旧伴侣链路删除清单.md) | 清单 + 扫描 |
| **S9-07** Android 删除 | `OnlineChatRepository`/`QingyuApi`/旧配对/远程 WS 等（执行中，见 §3） | purge-check 命中下降 |
| **S9-07** PC/Relay 删除 | `electron/bridge` 业务 `/api/v1`、`electron/relay/**`、`/relay/v1/bridge`、手机连接 UI（执行中） | git status 大批 D |
| **S9-04/08** 实机验收与恢复演练 | **未执行**（需物理真机、真库、密钥轮换环境） | 阻断项 |

## 2. 契约或迁移变化

- 新增 IPC：`syncCenter:runUpgradePrecheck`、`syncCenter:buildFirstSyncPlan`（`shared/ipc-api.ts` SyncCenterAPI 扩展；preload 同步）。
- 新增模块：`electron/domain/upgradePrecheck.ts`、`electron/domain/firstSyncPlan.ts`、`shared/telemetry/privacy.ts`。
- **不改** canonical schema、fixtures、`/sync/v1` 协议、迁移 genesis 语义。
- 旧 `/api/v1` 伴侣业务面与 `/relay/v1/bridge` 按 S9-07 删除；`/sync/v1` 与空间/设备/token 保留。

## 3. S9-07 删除进度（purge-check）

扫描脚本：`node scripts/s9-07-legacy-purge-check.mjs`（退出码 0 = 清零）。

| 阶段 | 命中数 | 说明 |
|---|---|---|
| 开工前 | 43（含备份目录） | 基线 |
| 去掉备份目录后 | 29 | 有效基线 |
| PC/Relay 删除后 | 22 | Bridge `/api/v1`、`electron/relay/**`、手机连接 UI 已清 |
| Android 删除后 | **0** | **purge-check OK** |

**已删除**：
- Android：`OnlineChatRepository`、`QingyuApi`、`WsClient*`、`ConnectionManager*`、`OnlineSettingsSyncRepository`、`data/send` 远程 outbox、`ui/pairing` 旧配对、`network/relay/**`、`NsdDiscovery`、`ConnectionStore` 等
- PC：`electron/bridge` 业务 `/api/v1`（routes/chatService/ws/taskRoutes/tts/auth…）、`electron/relay/**` 整目录、`PhoneConnectionSection`、`usePairApproval`
- Relay：`/relay/v1/bridge`、WS hub、RPC broker、command queue/snapshot、pairing ticket
- 共享：`relayProtocol.ts`、`pairingQr.ts`、`chat-core/capabilities.ts`（伴侣面）、旧 fixtures

**保留**：`local/migration/**`、`LocalChatRepository`、`network/sync/**`、`shared/sync-core|sync-crypto|contracts`、`electron/bridge/syncRoutes.ts`、`relay-server` 的 `auth/db/sync/space`。`settingsRevision` 工具已从旧 `settingsSync` 抽到 `electron/services/settingsRevision.ts`。

## 4. 测试命令与结果

| 命令 | 结果 | 日志/产物 |
|---|---|---|
| `pnpm test -- electron/domain/__tests__/upgradePrecheck.test.ts electron/domain/__tests__/firstSyncPlan.test.ts electron/ipc/__tests__/syncCenter.test.ts` | **17 passed** | S9-01/02 + 既有 syncCenter |
| `pnpm test -- shared/__tests__/telemetryPrivacy.test.ts` | **5 passed** | S9-06 |
| `node scripts/s9-07-legacy-purge-check.mjs` | **OK（0 命中）** | S9-07 验收扫描 |
| `pnpm check` | **clean** | PC monorepo |
| `pnpm test`（全量） | **276 files / 3206 passed / 4 skipped** | 含 domain/ipc/shared/UI |
| `pnpm --dir relay-server check && test` | **clean / 6 files / 26 passed** | 无 bridge/WS/RPC |
| `pnpm lint` | ⚠️ 部分 **历史** unused-vars（tools/ 等）；S9 新模块 clean | 与 S9-07 无关 |
| Android `compileDebugKotlin` | **BUILD SUCCESSFUL** | 旧远程栈已卸 |
| Android `testDebugUnitTest` | **205 suites / 1425 tests / 0 failures** | S9-07 后全量 |

## 5. 未完成与阻断

1. **S9-04 真机/服务器验收**：Android 8/12/14 物理矩阵、家用路由/热点/移动网、两空间三设备隔离。
2. **S9-08 故障恢复演练**：迁移失败回滚、Backup V3 重导、密钥丢失提示、服务器只读降级。
3. **S9-05 发布门禁**：P0/P1 矩阵 100%、PC A/B（PCE-01 GUI 半边）、安全审查、用户文档。
4. **前置**：阶段 6（实机矩阵 9×3）、阶段 8（真库联调、安全矩阵）仍待验收。
5. **Go/No-Go**：连续两周试运行指标（阶段 9 §3）未开始。
6. **备注**：`pnpm lint` 仍有 tools/ 等历史 unused-vars；S9 新模块已 clean。`relay-server` 的 `@fastify/websocket` 依赖可后续移除。

## 6. 回滚方法

- 新增文件可直接删除：`upgradePrecheck.ts`、`firstSyncPlan.ts`、`shared/telemetry/privacy.ts`、两份测试、`S9-03`/`S9-07` 文档、purge-check 脚本；IPC/preload 增量 revert。
- S9-07 删除按提交粒度 revert：PC bridge/relay 删除与 Android 删除应分提交；旧链路恢复 = 取出删除前提交，**不得**用 feature flag 复活。
- 迁移读取器（`LegacyCacheReader`）保留至稳定版后一版本再删。

## 7. 下一阶段输入

- 删除收口后：统一门禁 + purge-check=0 + 路由 404/WS 握手失败证据。
- 阶段 6/8 签字材料。
- S9-04/08 实机与演练取证模板（见 S9-03 矩阵 J8/J17/J18）。
