# Android 独立客户端重构阶段 3 实施报告

> 日期：2026-09-17（阶段文档编写日期 2026-09-16）
> 基线提交：`37801ff`（阶段 2 收口后）
> 结论：**通过** — S3-01～S3-07 全部落地；JVM 单测 588/588、lint 0 Error、assembly 与 `pnpm check`/`relay-server check` 通过；**API 26/31/34 三档真实模拟器 instrumentation 全绿（7/7 × 3）**（本轮补齐系统镜像后执行）。
> 工作区状态：**未提交**（改动集中在 `android/`，与并行工作线无文件重叠）。

---

## 0. 阶段门禁结果（最终）

| 门禁 | 结果 |
|---|---|
| `gradlew :app:testDebugUnitTest` | **BUILD SUCCESSFUL** — 588 tests，0 failures |
| `gradlew :app:lintDebug` | **BUILD SUCCESSFUL** — 0 Error（92 Warning / 2 Information，均既有） |
| `gradlew :app:assembleDebug` | **BUILD SUCCESSFUL** |
| `gradlew :app:connectedDebugAndroidTest` | **BUILD SUCCESSFUL** — API 26 / 31 / 34 各 **7 tests，0 failures** |
| `pnpm check` | **PASS**（exit 0） |
| `pnpm --dir relay-server check` | **PASS**（exit 0） |

### 0.1 设备矩阵（本轮实际执行）

| 设备 | API | ABI | 镜像指纹 | 结果 |
|---|---|---|---|---|
| `qingyu-api26` | 26 (8.0.0) | x86_64 | `Android/sdk_phone_x86_64/generic_x86_64:8.0.0/OSR1.180418.004/4931640:userdebug/test-keys` | 7/7 |
| `qingyu-api31` | 31 (12) | x86_64 | `Android/sdk_phone64_x86_64/emulator64_x86_64:12/SE1A.220826.006.A1/10064458:userdebug/test-keys` | 7/7 |
| `qingyu-api34` | 34 (14) | x86_64 | `Android/sdk_phone64_x86_64/emu64x:14/UE1A.230829.036.A1/11228894:userdebug/test-keys` | 7/7 |

每次执行均记录 `api` 与 `model`（`SecretStoreInstrumentedTest` / `NotificationChannelsInstrumentedTest` 打印到 test stdout）。
环境补齐动作：安装 `cmdline-tools` 并用 `sdkmanager` 安装 `system-images;android-{26,31,34};default;x86_64`，用 `avdmanager` 创建三个 AVD。

### 0.2 本轮发现并修复的真实缺陷

**API 26/27 启动崩溃（P0，已修复）**：`AppNotificationHelper.ensureChannels` 无条件给渠道赋 `group = GROUP_ID`，
但 `NotificationChannelGroup` API 自 **API 28** 才有；API 26/27 上 `createNotificationChannel` 抛
`IllegalArgumentException: NotificationChannelGroup doesn't exist`，异常发生在
`CompanionApp.onCreate → AppContainer.start → NotificationDispatcher.start → ensureChannels`，
导致 API 26 设备**直接启动崩溃**（instrumentation 首次运行报 `0 tests on qingyu-api26` + `Process crashed`）。
修复：`groupSupported = SDK_INT >= P` 时建组并赋组，26/27 完全跳过组；并对渠道创建加 `runCatching`。
回归测试：`NotificationChannelsInstrumentedTest`（2 用例，覆盖真实系统 NotificationManager 的组校验）。

### 0.3 阶段 0 遗留的密码提供方实测结论（重要，供阶段 7/8）

在 **default 系（非 Google APIs）x86_64** 镜像上，系统未提供 `X25519`：
- API 34：`NoSuchAlgorithmException: no such algorithm: X25519 for provider AndroidKeyStore`，
  且软件 X25519（`CryptoSpike.generateSoftwareX25519`）同样失败；
  已注册 provider 仅为 `AndroidNSSP, AndroidOpenSSL, CertPathProvider, AndroidKeyStoreBCWorkaround, BC, HarmonyJSSE, AndroidKeyStore`
  —— **没有 Conscrypt**。
- 对比阶段 0 在 MuMu API 35 的结论：Keystore X25519 不可用，但**软件 Conscrypt X25519 ECDH 通过**。

因此 `CryptoSpikeTest > softwareX25519EcdhMatchesBothSides` / `keystoreX25519IfSupported` 在 default 镜像上失败
（`keystoreWrapUnwrap32ByteSpaceKey`、`spaceKeyNeverExposedFromKeystoreMaterial`、两个 Ed25519 用例通过）。
这不是阶段 3 引入的回归（`CryptoSpikeTest`/`CryptoSpike` 本轮未改动），但直接闭合 ADR-010 的关键结论：
**阶段 7/8 的 X25519 实现不得依赖系统 provider，必须在 APK 内自带可用的 X25519 实现（如 BouncyCastle `bcprov`），
且必须在 API 26 实机复核**（阶段 0 遗留项 1 的建议由此升级为「必须」）。

**阶段 3 收尾复核（2026-09-17）——本项已闭合：**

按上述结论改造 `CryptoSpike` 的软件 X25519 路径：**优先使用自带 BouncyCastle provider 实例**
（`org.bouncycastle.jce.provider.BouncyCastleProvider()`，坐标 `bcprov-jdk18on:1.78.1`），
失败才回退系统 provider；`KeyAgreement` 同策略。关键实现细节：**必须传 provider 实例而非名字 `"BC"`**，
因为 Android 平台自带同名 `BC` 旧变体，`addProvider` 会因同名被拒，`getInstance(alg,"BC")`
会落回那个**不含 X25519** 的平台实现。

结果：

| 项 | 结果 |
|---|---|
| `softwareX25519EcdhMatchesBothSides` | **API 26 / 31 / 34 全部通过**（此前三档均失败） |
| `keystoreX25519IfSupported` | **API 26 / 31 / 34 全部通过**（Keystore 不支持时回退自带软件实现） |
| 无过滤全量 `connectedDebugAndroidTest` | **三档各 21 tests，0 failures**（此前必须用 class 过滤排除这 2 项） |

因此门禁不再需要 class 过滤，`phase0.CryptoSpikeTest` 已回归常规门禁。
ADR-010 已同步修订（「重新评估条件」补记，基线由「Conscrypt/BC」改为「自带 BouncyCastle」）。

**仍未闭合（环境项，非依赖风险）**：Android 8/12/14 **物理真机**矩阵未跑。
但由于系统 provider 依赖已消除，真机缺 Conscrypt/X25519 不再会破坏阶段 7/8 的实现前提；
真机复核降级为环境验证项。**依赖提升未做**：bcprov 目前仍是 `androidTestImplementation`，
生产实现落地时须提升为 `implementation`，在那之前不得声称「APK 已自带 BC」。

---

## 1. 已完成任务

| 任务 ID | 产物 | 证据 |
|---|---|---|
| **S3-01** | `local/db/LocalEntities.kt`（21 张表，显式外键与删除策略）、`local/db/LocalDaos.kt`（16 个 DAO + 事务化 `allocateCounter`）、`local/db/QingyuLocalDatabase.kt`（`version = 1`、`exportSchema = true`、打开即 `PRAGMA foreign_keys = ON`） | `LocalDatabaseRoomTest`（13 用例，Robolectric 真实 SQLite）；导出 schema `app/schemas/com.qingyu.companion.local.db.QingyuLocalDatabase/1.json` |
| **S3-01** | 新增 22 张表覆盖阶段文档清单：`characters / lorebooks / presets / personas / regex_rules / quick_reply_sets / groups / sessions / messages / memory_states / memory_facts / usage_records / media_manifests / public_settings / device_settings / connection_profiles / entity_heads / change_log / sync_receipts / conflicts`（+ 契约专用 `contract_objects`） | 同上；`exported schema v1 matches runtime identity` 断言运行时表集合与导出 schema 完全一致 |
| **S3-02** | `local/migration/LegacyCacheReader.kt`：旧库 + WAL/SHM 只读快照复制、副本 WAL checkpoint 自包含化、版本解析（主库头 → `-wal` 头双端序）、库名可注入（便于测试隔离） | `LegacyCacheMigrationTest`（8 用例）：`snapshot copies legacy database and wal without rewriting` 逐字节断言旧库未被改写；`reader absorbs schema differences across legacy v1 to v7` 覆盖无 outbox 表/无收尾列的 v1 形状 |
| **S3-02** | `local/migration/LegacyCacheImporter.kt`：三选一决策、真实快照导入（保留原 ID、`importedFrom=legacy_companion_cache`）、outbox 三分类（对账/草稿/仅诊断） | `snapshot import preserves ids and marks provenance`（2 角色 + 2 会话 + 3 消息 + 1 草稿 + 1 对账） |
| **S3-02** | 共同迁移 genesis：`local/domain/MigrationIdentity.kt`（规范内容哈希、genesis manifest 解析、实体 ID 合法性） | `same id and same hash inherits genesis without new concurrent version`：同源投影 `origin=migration` 且版本向量为空（不生成独立并发祖先） |
| **S3-03** | `local/domain/LocalStore.kt`（UI/业务唯一入口）、`RoomLocalSyncRepository.kt`（全部实体 CRUD + journal + head 同事务、`origin ∈ {local, remote, migration}`、tombstone、回滚） | `LocalRepositoryContractTest`（2 用例 × 10 条行为不变量，同一行为表跑内存实现与 Room 实现） |
| **S3-03** | 跨语言契约：Kotlin 执行器 `app/src/test/.../domain/contracts/RepositoryContract.kt` 读 `shared/contracts/fixtures/repository/behavior-table.json` | `RepositoryContractSuiteTest`（4 用例）：Room 与内存实现 **0 失败**（含路径穿越拒绝、canonical hash 与字段顺序无关、分页不重不漏、remote 不回显为 local） |
| **S3-04** | `local/settings/LocalSettingsRepository.kt`：`PublicSettings`（进 envelope）/ `DeviceSettings`（仅本机，不写 journal）、枚举化键与白名单 | `ConnectionProfileAndSettingsTest`：`public settings are journaled while device settings are not` |
| **S3-04** | `security/SecretStore.kt`：Keystore 不可导出 wrapping key（AES-256-GCM）加密保存 `SecretRef`；Keystore 不可用降级内存实现而非明文落盘 | `SecretStoreInstrumentedTest`（设备侧）；`Phase3LocalDomainTest` 覆盖语义 |
| **S3-06** | `security/ConnectionProfileRepository.kt`：public 与 secret **两个独立事务**；public 更新永不擦除 secret；空 secret 拒绝写入；`ConnectionProfileView` 只含掩码与「已配置/未配置」 | `ConnectionProfileAndSettingsTest`（5 用例，含「Keystore 失败时旧值保留且 public 行仍可用」） |
| **S3-06** | `ui/settings/connection/ConnectionProfilesScreen.kt` + `ConnectionProfilesViewModel.kt`：新增/编辑/删除/排序/启用/测试；保存后立即清空明文输入 | 路由 `Routes.CONNECTION_PROFILES` 已接入 `CompanionNavHost` |
| **S3-05** | `network/models/ModelAdapter.kt`：四类 provider 的请求构造 + 认证头（Bearer / x-api-key / x-goog-api-key / 可选 Bearer）、SSE 与 NDJSON 解析、非流式解析、能力探测 | `ModelAdapterMockWebServerTest`（14 用例） |
| **S3-05** | `network/models/ModelClient.kt`：OkHttp 实际执行层；流式 `streamWithHandle`（可取消句柄）、非流式 `complete`、`testConnection`（与生成共用 adapter 与认证头）；统一 `ModelError.retryable` 分类 | 同上：成功流、分片边界（1 字节/块强制跨片）、非 2xx、429/401、取消、超时、畸形 JSON、空响应、reasoning 过滤 |
| **S3-05** | 安全：默认仅 HTTPS（`requireSafeBaseUrl`）、HTTP 需按档案显式启用、关闭自动重定向避免凭据外带、无全局忽略证书开关 | `http base url requires explicit opt in`、`api key never appears in built request headers for ollama without key` |
| **S3-07** | `ui/startup/LocalSetupScreen.kt` + `LocalSetupViewModel.kt`：本地初始化/旧缓存迁移向导；`NeedsLocalSetup` 不再走配对页 | `Routes.LOCAL_SETUP` 接入；`StartupViewModel` 决策改为「有本地库 → LocalReady，否则 → NeedsLocalSetup」 |
| **S3-07** | `data/AppContainer.kt`：`qingyu-local.db` 接入生产 DI（**移除** `fallbackToDestructiveMigrationOnDowngrade`）、`KeystoreSecretStore`、`ConnectionProfileRepository`、`LocalSettingsRepository`、`ModelClient`、`LegacyCacheReader/Importer`、`ensureLocalBootstrapped()` | `compileDebugKotlin` 通过；`lintDebug` 无新增 Error |

### 1.1 关键设计决定（阶段内落地，供阶段 4/7 引用）

1. **counter 全程十进制字符串**：`local_device_state.next_counter_text` 为 `TEXT`，`allocateCounterInTx()` 用 `ULong` 自增并回写字符串；版本向量序列化/反序列化 `VersionVectorJson` 不使用 `Long`。契约测试用 `BigInteger` 比较。
2. **契约命名空间**：`behavior-table.json` 的任意 `entityType` 只落 `contract_objects` 表 + 该命名空间的 head/journal，避免行为表 payload 形状污染业务表 schema；`contractChangesAfter` 按命名空间过滤后分页。
3. **快照自包含化**：旧库 WAL 未 checkpoint 时主库头版本为 0，`SQLiteOpenHelper` 会因版本不一致回调 `onUpgrade` 并写事务、**打断 WAL 恢复**（实测会让快照退化为空库）。因此快照流程改为「复制 → 对副本做底层 `SQLiteDatabase.openDatabase` + `wal_checkpoint(TRUNCATE)` → 删除副本 `-wal/-shm`」，使副本成为普通自包含库文件；原始旧库全程只读。
4. **删除原子性**：业务行清除与 tombstone 写入合并进 `deleteWithTombstone()` 单事务，避免「有 tombstone 无业务删除」或反向的半提交。
5. **取消语义**：`ModelRequestHandle.cancel()` 后流直接结束、不再发出业务错误事件；调用方以 `handle.isCancelled` 区分用户取消与供应商错误（避免 `callbackFlow` 关闭竞态导致的事件丢失）。
6. **`EMPTY_DELTA` 哨兵**：SSE 心跳/角色帧（无正文也无用量）在流式路径被忽略，在非流式路径转为 `EMPTY_RESPONSE`（可重试），不会被误当成正文。

---

## 2. 契约或迁移变化

| 项 | 变化 | 兼容范围 |
|---|---|---|
| 新增 Room 库 | `qingyu-local.db` v1（22 张表，含契约专用表） | 新库首次落地，尚无历史版本，不提供 1→N 迁移 |
| 旧伴侣缓存 | **不原地升级**；只读快照 + 一次性导入 | 兼容 v1—v7 旧 schema（列探测式读取，不依赖 Room 实体） |
| 共享 fixtures | 只**读取** `shared/contracts/fixtures/repository/behavior-table.json`，未修改 | `shared/contracts/` 与 `shared/fixtures/` 均无改动 |
| 同步信封 | `LocalEnvelope`（`contractVersion = 1`）：`contentHash = sha256(canonicaljson(payload))`，排除 `updatedAt` | 与阶段 1/2 定义一致 |
| 实体 ID 校验 | 新增 `MigrationIdentity.isValidEntityId`（拒绝 `/`、`\`、`..`、NUL、控制字符、空、>512）并接入所有写路径 | 与 `repositoryContract.ts` 的 `invalid-entity-id-is-rejected` 用例一致（Room 与内存实现均通过） |

**未修改**：`shared/**`、`electron/**`、`relay-server/**`、`android/app/src/main/.../data/CacheDatabase.kt`（旧缓存库保持不变，只被 `LegacyCacheReader` 只读读取）。

---

## 3. 测试命令与结果

| 命令 | 结果 | 日志/产物 |
|---|---|---|
| `.\gradlew.bat :app:testDebugUnitTest` | **BUILD SUCCESSFUL** — 588 tests，0 failures | `app/build/test-results/testDebugUnitTest/*.xml` |
| （阶段 3 新增用例明细） | 契约 6 + Room 13 + Repository 契约 2 + 迁移 8 + 模型 MockWebServer 17 + 连接档案/设置 9 + Phase3LocalDomain 8（含既有启动/适配器用例） | 同上 |
| `.\gradlew.bat :app:lintDebug` | **BUILD SUCCESSFUL** — 0 Error（92 Warning / 2 Information，均为既有项） | `app/build/reports/lint-results-debug.xml` |
| `.\gradlew.bat :app:assembleDebug` | **BUILD SUCCESSFUL** | `app/build/outputs/apk/debug/` |
| `pnpm check` | **PASS**（`tsc -b --noEmit && tsc -p tsconfig.electron.json --noEmit`，exit 0） | 未改动 PC 代码，无回退 |
| `pnpm --dir relay-server check` | **PASS**（exit 0） | 同上 |
| `.\gradlew.bat :app:connectedDebugAndroidTest`（class 过滤为 `com.qingyu.companion.phase3.*`） | **BUILD SUCCESSFUL** — API 26 / 31 / 34 各 7 tests，0 failures | `app/build/outputs/androidTest-results/connected/debug/TEST-qingyu-api{26,31,34}*.xml` |

### 3.1 关键测试证据摘录

- **设备矩阵**：`secretStoreInstrumentedTest` 与 `notificationChannelsInstrumentedTest` 打印
  `api=<SDK_INT> model=<MODEL>`；三档实际 API 为 26 / 31 / 34（见 §0.1 指纹）。
- **Notification 渠道回归**：`ensureChannelsCreatesAllFourChannelsOnThisApiLevel` 在**真实系统 NotificationManager** 上创建 4 条渠道；
  API 26/27 不再因渠道组崩溃（修复前 API 26 为 `0 tests` + `Process crashed`，修复后 7/7）。
- **Room 契约测试**（共享行为表）：`room local store satisfies shared repository contract` → failures = 0；`in memory store satisfies shared repository contract` → failures = 0。用例 id 覆盖 `put-creates-readable-entity-and-one-local-change`、`second-put-strictly-increases-counter`、`tombstone-marks-deleted-and-records-change`、`changesAfter-pages-without-gap-or-overlap`、`invalid-entity-id-is-rejected`、`content-hash-is-canonical-not-field-order-dependent`、`remote-origin-does-not-echo-as-local`。
- **迁移快照只读性**：`snapshot copies legacy database and wal without rewriting` 对旧库文件做前后逐字节比对并通过；`reader absorbs schema differences across legacy v1 to v7` 证明 v1 形状（无 `outbox_messages`、无 v7 收尾列）可被扫描并完整导入，且旧库文件仍在。
- **启动本地优先**：`decideStartupStateLocal` 在 `hasLocalDb = true` 时返回 `LocalReady`（无需任何 PC 连接）；`hasLocalDb = false`（含 `connectionCount > 0`）返回 `NeedsLocalSetup`，不再进入配对页。
- **settings 分区**：public 写 1 次 journal、device 写 0 次；`unknown device setting key is rejected`。
- **secret 边界**：`public update never clears secret`、`saving empty secret is rejected and keeps old value`、`secret store failure keeps public row usable`、`views expose only masked secret state`（并断言视图类无 `apiKey` 字段）。
- **payload 上限**：`payload above two mebibytes is rejected while boundary passes`（边界内通过、超限抛 `PayloadTooLargeException`）；
  `oversized payload does not leave half committed rows`（超限写入整体回滚，无业务行/head/journal 残留）。
- **base URL 加固**：`base url rejects userinfo query fragment and path traversal`（8 种非法形状全部拒绝）、
  `base url accepts normalized public lan and ipv6 forms`（HTTPS / 私网 / localhost / `[::1]` / 首尾空白规范化）。
- **流式边界**：MockWebServer 以 **1 字节/块** 写出 SSE，验证跨 socket 分片行拼接；`data: {not-json` 断言 `MALFORMED_JSON` 且 `retryable = false`。

---

## 4. 未完成与阻断

1. **旧伴侣链路仍在运行（阶段 9 范围）**：`OnlineChatRepository`、`connectionCoordinator`、配对页与 WS 仍在依赖图中，`AppContainer.start()` 仍会 `restore()` 上次 PC 连接。阶段 3 只完成「本地权威库 + 本地优先入口」，**旧连接页/远程会话页/自动连接入口的整体移除属于阶段 9 的删除清单**（总方案 §9.3、阶段 9 文档）。因此本中间状态**不得对外发布**（阶段 3 文档 §4 已明确）。
2. **生成任务幂等与进程恢复属于阶段 4**：阶段 3 只保证 `ModelClient` 的取消/错误分类；「进程被杀、旋转、低内存恢复不重复发送模型请求」需要生成任务 ID 与 `interrupted` 终局状态，随阶段 4 生成闭环实现。
3. **X25519/Ed25519 自带实现已落地并三档验证（原阶段 7/8 前置，现已闭合）**：见 §0.3 收尾复核——软件 X25519 改为优先使用自带 BouncyCastle provider，API 26/31/34 无过滤全量 21/21 通过；门禁不再需要 class 过滤。**剩余环境项**：Android 8/12/14 物理真机矩阵未跑（已无系统 provider 依赖风险）；bcprov 仍为 androidTestImplementation，阶段 7/8 落生产实现时须提升为 implementation。
4. **API 26 UI 冒烟未覆盖**：本轮 instrumentation 只覆盖阶段 3 的库/密钥/通知渠道；旧伴侣模式（阶段 9 删除对象）在 API 26 的完整 UI 冒烟不在本阶段范围。
5. **`app/schemas/` 新增文件需随提交入库**：迁移/身份校验测试依赖导出 schema，若不入库则 `exported schema v1 matches runtime identity` 会失败。
6. **工作区未提交**：本阶段改动全部集中在 `android/`，未与阶段 2 的 `electron/`、`scripts/` 改动重叠。

---

## 5. 回滚方法

- 本阶段为**新增为主**：删除 `android/app/src/main/java/com/qingyu/companion/local/`、`security/SecretStore.kt` 的新增部分、
  `network/models/ModelClient.kt`、`ui/settings/connection/`、`ui/startup/LocalSetup*`，并回退 `AppContainer.kt`、
  `CompanionNavHost.kt`、`Routes.kt`、`build.gradle.kts`、`libs.versions.toml` 即可回到 `37801ff` 行为。
- **用户数据回滚**：`qingyu-local.db` 是独立新库；删除该文件不影响旧 `qingyu-companion-cache`（阶段 3 从未写入旧库）。
  旧缓存快照（`qingyu-companion-cache.snapshot*`）为只读副本，可整体删除。
- 新主库创建/导入失败时：不执行 destructive fallback、不改写旧缓存；由 `LocalSetupViewModel` 输出诊断并停留在迁移修复页，
  已导入实体经 `deleteCharacter/deleteSession` 写 tombstone 回滚（`failed import can be rolled back without destructive fallback` 覆盖）。
- 回滚点：`37801ff`（阶段 2 收口后）。

---

## 6. 下一阶段输入

- **阶段 4（单聊生成闭环）**：
  - 直接依赖 `LocalStore`（业务表 + journal + head 同事务）、`ModelClient.streamWithHandle`（可取消流）与 `ModelError.retryable`；
  - 需补：生成任务 ID 与 `interrupted` 终局、进程恢复不重发、上下文预算与记忆注入（当前 `LocalStore` 已提供 `memory_states/memory_facts` 落库）；
  - `LocalMessageEntity.seq` 由 Repository 分配，展示顺序 = `(logicalTime, id)`（阶段 4 决定逻辑时间注入）。
- **阶段 5（内容管理对齐）**：`LocalStore` 已覆盖角色/世界书/预设/人设/正则/快捷回复/群组/会话/消息的读写与 tombstone；世界书 `canonicalJson` 与预设 `bodyJson` 为受控 JSON，schema 待阶段 5 冻结为同步实体。
- **阶段 7（同步核心）**：可直接消费 `entity_heads`（版本向量 + 哈希 + `deleteFenceJson` 预留）、`change_log`（`origin` + 单调 `seq` + 信封 JSON）、`sync_receipts`、`conflicts`；`applyRemote` 已保证不推进本机 dot。
- **阶段 7/8（密码提供方，新增前置）**：见 §0.3 —— X25519 不得依赖系统 provider；本阶段已在 API 26/31/34 default 镜像上取证，需在 API 26 实机复核并确定自带实现依赖（ADR-010 需按此更新）。
- **阶段 9（旧链路删除）**：本阶段保留的旧连接/远程会话路径与其测试需按阶段 9 清单整体删除（见「未完成与阻断」1）。
- **契约负责人**：本阶段未改 `shared/contracts/`；Kotlin 侧执行器与 TS 执行器已对同一行为表 0 差异，后续新增用例只需向 `behavior-table.json` 追加并同时满足两语言 runner。

## 7. 本轮（goal round 2）增量

相对本轮开始时的状态，新增改动与证据：

| 项 | 内容 |
|---|---|
| 门禁补齐 | 安装 `cmdline-tools` + `system-images;android-{26,31,34};default;x86_64`，创建三个 AVD，`connectedDebugAndroidTest` 三档 **7/7 全绿** |
| 缺陷修复 | API 26/27 通知渠道组导致 `CompanionApp.onCreate` 崩溃（P0）—— 修复 + `NotificationChannelsInstrumentedTest` 回归（2 用例） |
| S3-05 加固 | `requireSafeBaseUrl` 升级为完整 URL 解析：拒绝 userinfo / query / fragment / `..` 路径 / 非法端口 / 非法主机名，支持 IPv6 字面量；新增 3 个测试（含 8 种非法形状） |
| S3-03 补强 | payload 上限 2 MiB 落到写路径（`MigrationIdentity.requirePayloadWithinLimit` + `PayloadTooLargeException`），超限整体回滚；新增 2 个测试 |
| 取证 | 记录 default 镜像缺 Conscrypt/X25519 的实测结论（§0.3），更新 ADR-010 的后续动作 |

最终计数：JVM 单测 **588/588**；instrumentation **21/21**（7 × 3 档）；lint **0 Error**。
