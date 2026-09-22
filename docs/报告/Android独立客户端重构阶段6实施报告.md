# Android 独立客户端重构阶段 6 实施报告

> 日期：2026-09-22（增量报告，随阶段进度续写）  
> 基线提交：`af85b9b`（工作区另含阶段 2–5 交织的未推送改动，见 §0.2）  
> 完成提交：S6-01(a) = `95c1f1e`；S6-01(b) 见 §0.1（均**尚未推送**）  
> 结论：**进行中** — S6-01(a) 跨端契约层与 S6-01(b) Android 群数据层已落地并通过双端门禁；S6-01 余项与 S6-02～S6-07 未完成（§5）。阶段 6 尚不能签字。

## 0. 边界与工作区

### 0.1 本增量的提交

- 提交 **`95c1f1e`**（2026-09-22，未推送）：S6-01(a) 群聊发言调度、free 多角色拆分、派生记忆失效决策的**跨语言契约层**（TS oracle + golden fixture + Kotlin 等价实现 + PC 生产接线），19 files，+3674/−227。
- **S6-01(b)**（2026-09-22，未推送，提交哈希见看板行）：Android 群数据层补全——本地库 v5（`local_groups` 调度参数列、`local_messages` 身份三键、新表 `local_group_messages`、会话方向开关）、`EntityPayloads` 三处（message 身份键缺口清零 + 群会话/群消息临时 payload）、`LocalStore`/`RoomLocalSyncRepository`/`FakeLocalStore` 群消息记账链、`ChatRepository` 群生命周期接口（默认明确失败）、`LocalChatRepository` 群聊 12 项真实现（`groupAiReply` 除外）、DTO 补字段、v4→v5 instrumented 迁移测试。
- PC 侧接线为**等价重构**：不改任何用户可观察行为（提示词、文案、调度结果、落盘语义均不变），由既有 43 条 `useGroupChatStore` 用例、12 条 `groupMemoryManager` 用例、6 条 checkpoint 用例与全量 `pnpm test` 佐证。

### 0.2 工作区并存改动（非本轮产物，未触碰）

`git status` 中既有：`android/.../content/backup/BackupOrchestrator.kt`、`BackupV3.kt`、`BackupV3SafetyTest.kt`、`electron/**`、`src/**`、`shared/{defaults,dialogueDirections,ipc-api,types,chat-core/{aiInputHelper,contextBuilder}}.ts` 等交织改动，以及 `.mcp.json`、`__pycache__/`、`diag2.txt`、`diag3.txt`、`android/draft_patch.py`、`android/app/src/main/java/com/qingyu/companion/领域模型。`、`.tmp-walkthrough-20260922/` 等杂物。本轮一律未改、未删。`src/store/__tests__/useGroupChatStore.test.ts` 为已改文件，本轮**未修改**（新测试落在新文件）。

例外说明：看板 `docs/方案/安卓独立客户端与主动同步/README.md` 与本轮提交一并入库时，**携带了工作区中其他 Agent 既有（未提交）的阶段 2–5 状态文字更新**（与 `047e093` 整体入库的既有做法一致）；本轮只改了阶段 6 行。

## 1. 已完成任务

| 任务 ID | 产物 | 证据 |
|---|---|---|
| S6-01(a)-1 发言调度纯逻辑 | `shared/chat-core/groupScheduling.ts`（轮次、@提及、mention/polling/free 发言计划、轮询续排、接力间隔、自动记忆触发） | PC 生产接线：`src/store/useGroupChatStore.ts`（sendMessage 发言计划/提及/轮次 ×4 处）、`src/store/groupStreamController.ts`（checkPollingContinue、checkAutoMemory） |
| S6-01(a)-2 free 拆分归属纯逻辑 | `shared/chat-core/groupFreeSplit.ts`（omniscient 不拆分、【角色名】拆段、旁白并入首段、未识别角色旁注、空段丢弃、无标记回落） | PC 生产接线：`src/store/groupStreamController.ts#splitAndSaveMessages` |
| S6-01(a)-3 派生记忆失效决策 | `shared/chat-core/derivedMemory.ts`（阶段五检查点 + 13 键全量失效 patch） | PC 生产接线：`src/store/chatUtils.ts#invalidateDerivedMemory` / `#invalidateGroupDerivedMemory` |
| S6-01(a)-4 跨语言 golden fixture | `shared/fixtures/cross-platform/chat-core/{group-scheduling,group-free-split,memory-invalidation}.json`（group-scheduling 含 4+7+10+9+6+8=44 例，free-split 19 例，invalidation 13 例） | TS 生成器兼守卫 `shared/__tests__/groupChatCoreGolden.test.ts`（env 门控重生成 + 默认只读校验 + 两次求值确定性自检 + 不可往返值拒写）；README 文件表已补三行 |
| S6-01(a)-5 Kotlin 等价实现 | `android/app/src/main/java/com/qingyu/companion/chatcore/{ChatGroupScheduling,ChatGroupFreeSplit,ChatMemoryInvalidation}.kt` | 纯 Kotlin（无 Compose/协程依赖），供后续群调度状态机/群记忆接入复用 |
| S6-01(a)-6 Kotlin 一致性测试 | `android/app/src/test/java/com/qingyu/companion/chatcore/{ChatGroupSchedulingGoldenTest,ChatGroupFreeSplitGoldenTest,ChatMemoryInvalidationGoldenTest}.kt` | 读**同一份** fixture 逐字段断言；含 `resetPatchIsAFixedPointOfPcFieldSet` 钉 13 键键集 |
| S6-01(b)-1 本地库 v5 | `LocalEntities/LocalDaos/QingyuLocalDatabase`：`local_groups` +9 调度列、`local_messages` +3 身份键列、`local_sessions` +方向开关列、**新表 `local_group_messages`**（24 列 + 2 索引，对齐 PC `GroupMessage`）、`MIGRATION_4_5`、导出 `app/schemas/.../5.json` | instrumented 迁移测试 `phase6/GroupChatSchemaMigrationInstrumentedTest`（v4 数据存活 + 新表经 Room validate 可读写） |
| S6-01(b)-2 消息 payload 缺口闭合 | `EntityPayloads.messagePayload` 身份三键按 PC `typeof === 'string'` 语义下发；`SyncPayloadGoldenTest.PC_ONLY_KEYS["message"]` **清零**（阶段 5 登记的三键缺口闭合） | `SyncPayloadGoldenTest` 16/16；缺口必须恰好为零，多一键少一键都红 |
| S6-01(b)-3 群会话/群消息临时 payload | `EntityPayloads.groupSessionPayload/groupMessagePayload`：镜像 PC `group.ts` 的 spread 语义（−id +parentId），**D-11 未决前的临时口径** | 契约行为 11 双实现；文档逐条标注 D-11 |
| S6-01(b)-4 群消息记账链 | `LocalStore` + `RoomLocalSyncRepository` + `FakeLocalStore`：群消息 append/update/delete 走 `withJournal("message", …)`，父会话/父群 tombstone 保护、会话删除级联清理 | `LocalRepositoryContractTest` 行为 11（Fake/Room **双实现各跑一遍**） |
| S6-01(b)-5 群聊本地实现 | `LocalChatRepository` 16 项真实现：群列表/会话列表/消息列表/发送（幂等+轮次+身份快照）/编辑/删除/建群（PC 新建默认值）/设置补丁（白名单）/成员增删/删群级联/会话增删改/会话设置/群翻译（PC 短提示词变体）；`groupAiReply` 保留 notMigrated（属 S6-01d 生成闭环） | `LocalGroupChatRepositoryTest` 7 例（新建默认值、补丁白名单与非法值报错、成员排序、幂等、身份快照、历史修订号、稳定排序） |
| S6-01(b)-6 接口与 DTO | `ChatRepository` 新增 `deleteGroup/createGroupSession/renameGroupSession/deleteGroupSession/patchGroupSession`（默认实现**明确失败** 501，同 `patchSessionRuntimeState` 先例）；`GroupChat/GroupSession/GroupMessage` DTO 补调度/身份字段 | 既有序列化与 VM 测试零回归；`ContentWiringAuditTest` 钉子随迁移更新（双向守卫） |

这补上了阶段 5 §2.28 指认的前置缺口之一：**「一份群调度 fixture」**（此前 `cross-platform` 四组 fixture 中无任何群调度 oracle，PC 的 groupCas/群测试都是单端断言）。

## 2. 契约变化与语义钉子

### 2.1 契约变化

- 新增 `chat-core` 组三份 golden fixture（`version: 1`），再生命令：
  `$env:CHAT_CORE_UPDATE_FIXTURES="1"; pnpm exec vitest run shared/__tests__/groupChatCoreGolden.test.ts`。
- 无 schema / Room / 同步端点变更；同步 payload 白名单未动（群调度字段本就 `deliberatelyExcluded`，见 `sync-payload/group-payload.json`）。

### 2.1b 契约/迁移变化（S6-01b）

- **Room v4→v5 迁移**（只加列、只加表，不重建既有表）：`local_groups` 群调度参数 9 列、`local_messages` 身份三键、`local_sessions` 会话方向开关、新表 `local_group_messages`。旧行迁移后 = PC 新建群缺省（`polling`/不自动接力/`maxRounds` 1/2000ms/索引 0），旧消息身份三键 = NULL（= 未设置 = payload 不下发）。schema 导出 `5.json` 已随仓库保留（`RoomSchemaExportGuardTest` 流程要求）。
- **`message` 同步 payload 缺口闭合**：阶段 5 在 `SyncPayloadGoldenTest.PC_ONLY_KEYS` 登记的三键（`speakerKind/generationKind/narrativeMode`）随 v5 列 + `messagePayload` 映射**清零**——这是 S6-01「旁白与角色身份」欠的账。
- **群会话/群消息 payload 是临时镜像**（`EntityPayloads.groupSessionPayload/groupMessagePayload`）：按 PC `group.ts` 现状 spread 语义逐字段镜像；**D-11 未决**，决策落定后必须按新契约重写并补跨端 golden。
- `LocalGroupEntity.mode`（`sequential|round_robin|manual`，旧缓存来源）保留仅作迁移溯源；业务一律读新列 `chat_mode`（`mention|polling|free`）。

### 2.2 语义钉子（fixture 钉死的 PC 现状，禁止"顺手修复"）

1. **`currentSpeakerIndex % memberIds.length` 的 JS 取模语义**：负索引/除数 0 → 无发言者（`no_speaker`），不是抛异常也不是修正为正。
2. **polling `maxRounds` 按会话内 distinct AI 轮次计数**（`__free__` 不算角色发言、`__narrator__` 算），不是"每条用户消息的接力上限"。
3. **@提及是子串匹配**：`@小A` 会同时命中成员「小」与「小A」；大小写敏感；按成员顺序返回；用**正则处理前的原文**采样。
4. **polling 忽略显式回复目标**；mention 无目标回落 `currentSpeakerIndex` 轮转；未知 chatMode 走自由发言分支。
5. **free 拆分**：未识别角色旁注归属**首成员**（上一条已是首成员则并入）；识别到但空正文的段丢弃且无旁注；全段皆空 → 空消息列表（占位由调用方移除）。
6. **派生记忆 hasDerived 的 chat/group 差异**：单聊把 `memoryFactParseFailureCount/memoryFactRetryAfterVersion` 计入"有派生数据"，群聊不计（PC 两侧现状差异）。已在 fixture 用对偶用例钉住（"（语义钉子）事实解析退避计数计入单聊/不计入群聊派生数据"）。

### 2.3 发现的 PC 侧行为不一致（**未改**，登记为 D-14 等待签字）

只读取证（阶段 6 §0：不能为降低 Android 实现成本改变已验证的 PC 行为）发现 PC 群聊存在若干自相矛盾处，例如：polling 非 autoMode 时 `currentSpeakerIndex` 永不推进（"按顺序"只在接力下成立）；free 中途停止的半截正文存成 `__free__` 消息（沉浸模式不渲染、后续上下文标【未知角色】）；群气泡不显示 `generationNotice/generationError`（只落盘）；`__free__/__narrator__` 消息显示"重新生成"但 store 静默无效；群导出 md 的 speaker 取 characterId 原值且与单聊 `sessionExport` 不同源；桥接（旧伴侣通道）与桌面的群口径不同（用户消息 `round:0`、`members[(round-1)%len]` 轮转、历史全带【名字】前缀）。完整清单见 D-14。

## 3. 测试命令与结果

| 命令 | 结果 | 备注 |
|---|---|---|
| `$env:CHAT_CORE_UPDATE_FIXTURES=1; pnpm exec vitest run shared/__tests__/groupChatCoreGolden.test.ts`（生成） | **3/3 通过** | 生成三份 fixture；用例内声明的期望值与 oracle 输出逐条相等 |
| `pnpm exec vitest run shared/__tests__/groupChatCoreGolden.test.ts`（只读复跑） | **3/3 通过** | 默认只读校验通过，fixture 与 TS 实现一致 |
| `pnpm exec vitest run shared/__tests__/groupChatCoreGolden.test.ts src/store/__tests__/{useGroupChatStore,groupMemoryManager,checkpoint}.test.ts` | **64/64 通过** | PC 接线回归（useGroupChatStore 43、groupMemoryManager 12、checkpoint 6、golden 3） |
| `pnpm exec tsc -b --noEmit` | **通过（exit 0）** | — |
| `pnpm check` | **通过（exit 0）** | `tsc -b --noEmit && tsc -p tsconfig.electron.json --noEmit` |
| `pnpm test` | **3080 通过 / 4 跳过 / 0 失败**（TestFiles 280 passed \| 1 skipped） | 含接线后的全部群聊/记忆/上下文既有用例 |
| `cd android; .\gradlew.bat :app:testDebugUnitTest --rerun` | **1121/0 失败/0 跳过**（146 suites） | 新增 Kotlin golden 三件全绿；详见 §3.1 |

### 3.1 Android 单测补记

| 项 | 结果 |
|---|---|
| `cd android; .\gradlew.bat :app:testDebugUnitTest --rerun` | **BUILD SUCCESSFUL；146 suites / 1121 tests / 0 失败 / 0 跳过**（XML 时间戳 2026-09-22T06:40:30–06:40:39，本次运行） |
| 新增跨语言 golden | `ChatGroupSchedulingGoldenTest` **6/6**、`ChatGroupFreeSplitGoldenTest` **1/1**（19 例逐条比对）、`ChatMemoryInvalidationGoldenTest` **2/2**（13 例逐条比对 + 13 键键集钉死） |
| 基线对比 | 阶段 5 记录 1112 tests → 本增量 1121（+9，全为新增用例；既有 0 失败保持） |

### 3.2 S6-01(b) 门禁补记

| 命令 | 结果 | 备注 |
|---|---|---|
| `.\gradlew.bat :app:testDebugUnitTest --rerun` | **147 suites / 1128 tests / 0 失败 / 0 跳过**（XML 时间戳 2026-09-22T07:25:01–07:25:24） | 首跑暴露 `ContentWiringAuditTest` 钉子过期（群能力已迁移），按新事实更新为**双向守卫**后全绿 |
| `LocalGroupChatRepositoryTest` | **7/7** | 新建默认值 / 补丁白名单 / 成员排序 / 会话生命周期与删群级联 / 发送幂等与身份快照 / 编辑删除推进历史修订号 / (logicalTime,id) 稳定排序 |
| `SyncPayloadGoldenTest` | **16/16** | `PC_ONLY_KEYS["message"]` 清零后缺口恰好为零 |
| `LocalRepositoryContractTest` | **2/2**（行为表 11 条） | 行为 11 群消息记账/tombstone/父实体保护/级联，Fake 与 Room 双实现各过 |
| `.\gradlew.bat :app:pixel2Api34DebugAndroidTest -P…class=GroupChatSchemaMigrationInstrumentedTest` | 见下 | v4→v5 迁移 + 新表 Room validate 的真实 SQLite 验证（§11.2 Room migration 强制项） |

#### 迁移 instrumentation 证据（Gradle Managed Device）

| 项 | 结果 |
|---|---|
| 命令 | `.\gradlew.bat :app:pixel2Api34DebugAndroidTest "-Pandroid.testInstrumentationRunnerArguments.class=com.qingyu.companion.phase6.GroupChatSchemaMigrationInstrumentedTest"` |
| 设备 | Gradle Managed Device `pixel2Api34`（Pixel 2 / API 34 / `systemImageSource=aosp`） |
| 结果 | **2 tests / 0 失败**（XML 时间戳 `2026-09-22T07:32:30`；`app/build/outputs/androidTest-results/managedDevice/debug/pixel2Api34/TEST-pixel2Api34-_app-.xml`） |
| 覆盖 | ①v4 群/会话/消息/change_log 旧行迁移后存活、群调度列取 PC 新建群缺省、身份三键 NULL、方向开关 0；②迁移后 Room 打开库（validate 通过 = 新表 DDL 与 `@Entity` 生成语句逐字对齐）且群消息读写/seq 递增/journal 记账正常 |
| 过程记录 | 首跑 1/2 失败——**测试种子 SQL** 漏了 v4 `local_sessions`/`local_messages` 的 NOT NULL 列（`SQLiteConstraintException`），与迁移本身无关；补全种子列后 2/2。该失败恰好反证了 v4 约束仍被真实 SQLite 执行 |

## 4. 刻意取舍

1. **oracle = 生产代码**：三个纯模块被 PC 生产路径直接调用（不是"测试专用副本"），符合 swipeCandidates/syncPayload 的既有约定；PC 接线是等价重构，行为差由既有单测守护。
2. **fixture 不写 id/时间戳**：拆分结果只含 `characterId + content`（id 由调用方 nanoid 分配），无易变值，无需 volatile 哨兵。
3. **不动阶段 0 冻结的 baseline**：`shared/fixtures/cross-platform/baseline/sessions/group-chat/group-modes.json`（natural/nomination/poll + role/speakerId/nominate 字段）与 PC 真实类型不对齐，不能直接作 oracle；登记为 D-13，未改。
4. **hasDerived 差异按现状钉死**，不"顺手修复"（修也得先改契约、双端同改）。
5. 群消息的 `status/speakerKind/generationKind` 补齐（`shared/messageIdentity.ts#withMessageIdentity`）、`saveMessagesBatch` 200 条上限等**持久化**语义本轮未纳入 fixture（属 S6-01 数据层子项，随 Room 落库一起做）。

## 5. 未完成与阻断

### U-n（未完成）

- **U-6-1 S6-01 余项**（群数据层已落地，剩余为）：`groupAiReply` 本地生成闭环（群调度器状态机 + `LocalGroupGenerationUseCase` 接 ModelGateway + 中断/部分失败终局 + stop）、群记忆接入（默认记忆配置、摘要/事实、CAS、编辑删除失效判定接 `ChatMemoryInvalidation`）；
- **U-6-2 S6-01 群上下文装配**：roster/turnRules/叙事 prompt 移植（`ChatNarrativeMode.kt:11` 已注明归属阶段 6）、多成员/发言人聚焦上下文、group-context golden；
- **U-6-3 S6-01 调度器与生成闭环**：群调度器领域状态机（仿 `ChatGenerationTask.Machine`，禁止进 Compose/VM，消费 `ChatGroupScheduling`）；
- **U-6-4 S6-01 群记忆接入**：`LocalMemorySummaryService` 扩群会话、scope=`group:{id}` 事实提案、CAS stale 丢弃；
- **U-6-5 S6-01 UI 收尾**：群编辑/删除、成员增删排序、模式切换 UI（矩阵 `group.chatModes` notes「缺模式切换 UI」）、停止、续写、导出、TTS 入口；
- **U-6-6 S6-02～S6-07 全部**（附件/识图、TTS、生图与 ComfyUI、Embedding 三级、MCP 平台策略、公告/更新/诊断）；
- **U-6-7 实机验证**：音频焦点/蓝牙/低存储/权限撤销（§3 第 6 条）与 Android 8/12/14 真机矩阵；
- **U-6-8 备份覆盖**：Backup V3 需要覆盖新表 `local_group_messages` 与群调度列（含恢复回滚与 counts 校验）。`BackupOrchestrator.kt`/`BackupV3.kt` 当前是**其他 Agent 在途修改**（工作区 dirty），本轮未触碰，归属与该线合流后补齐。

### D-n（待决策，需签字方明确后执行，不留给后续 Agent 猜）

- **D-13（契约负责人）**：阶段 0 baseline `group-modes.json` 与 PC 群类型不对齐（模式命名 natural/nomination/poll ≠ mention/polling/free；消息字段 role/speakerId/nominate ≠ characterId/round；群记忆 memory.entries ≠ GroupSession.memory*）。选项：①重写 baseline fixture 对齐 PC 类型（推荐，改动仅测试资产）；②建映射层转译后再作 oracle（多一层可漂移代码）；③标记该文件仅作数据形态示意、不作 oracle（则 S6-01"与 PC fixture 对齐"改以本轮三份 chat-core fixture 为准）。
- **D-14（产品 + 契约负责人）**：§2.3 的 PC 群行为不一致清单——Android 是**逐字对齐（含缺陷）**还是**修复后对齐**。阶段 6 §0 要求不为 Android 便利改 PC 行为，故本轮按逐字对齐执行；若产品判定其中属 PC 缺陷（如 free 中停消息不可见、群气泡不显示中断提示），按总方案 §3.4 须单独立项修 PC 并补 PC 回归证据，再同步 Kotlin。
- **D-15（契约负责人，沿用阶段 5 遗留）**：S6-02 前置 D-12（`media_manifest` 跨端落点）与 S6-05 前置 D-9（`semanticRequired` 两端行为相反）仍未决，卡 S6-02 媒体同步语义与 S6-05 降级语义。
- **D-16（产品）**：P2 条目 `chat.sessionStats`、`lorebook.keywordLocalization` 无纳入记录也无签字排期，「移动端 embedding ABI」决策无落地记录 —— 阶段 6 §4「其余 P2 项有签字确认的排期」目前证据不足，验收前必须补。

### B-n（阻断）

- 无新增阻断。

### P1-x（过程问题）

- P1-6-1：工作区存在与本阶段无关的杂物（`android/draft_patch.py`、`android/.../领域模型。`、`diag2.txt`、`diag3.txt`、`__pycache__/`、`.mcp.json`），建议归属 Agent 清理；本轮不代删。

### F-n（跨阶段旁证）

- F-6-1：`shared/fixtures/cross-platform/chat-core/*.json` 由 `shared/__tests__/chatCoreGolden.test.ts` 生成的 44 份与本轮 3 份共用同一目录与 `ChatCoreFixtures` 读取器；两份生成器共用 `CHAT_CORE_UPDATE_FIXTURES` 开关（README 已注明分别执行）。
- F-6-2：`ContentWiringAuditTest.unmigratedCapabilitiesKeepAnActionableNoticeThatTheUiConsumes` 的钉子随 S6-01b 更新为**双向守卫**——未迁移能力（群聊 AI 回复/公告/版本信息）必须走 `notMigrated`，已迁移的群能力不得回退成 `notMigrated`（把「已经做了」伪装回「还没做」同样是撒谎）。首跑正是这条守卫把过期钉子顶红的，属守卫按设计工作。

## 6. 回滚方法

- S6-01(a)：纯新增 + 等价接线，无数据迁移。回滚 = revert `95c1f1e`：删除 `shared/chat-core/{groupScheduling,groupFreeSplit,derivedMemory}.ts`、三份 fixture、`shared/__tests__/groupChatCoreGolden.test.ts`、Kotlin 三模块 + 三测试，并还原 `src/store/{useGroupChatStore,groupStreamController,chatUtils}.ts`。还原后 PC 行为与基线一致；Android 侧新模块未接入生产路径。
- S6-01(b)：含 **Room v4→v5 迁移**。revert 代码后再启动会因 schema 版本回退触发 Room 校验失败，需**卸载重装**或用 `5.json` 之前的备份恢复 `qingyu-local.db`（v5 只加列/加表，恢复 v4 文件对旧代码完全可读）。迁移前的用户数据无需专门快照：v4→v5 不删不改任何既有列值，失败路径是打开库报错而非数据损坏。

## 7. 下一阶段输入

- Kotlin 侧 `ChatGroupScheduling` / `ChatGroupFreeSplit` / `ChatMemoryInvalidation` 是 S6-01 调度器状态机（U-6-3）与群记忆（U-6-4）的直接依赖，发言计划/拆分/失效语义以三份 fixture 为唯一真源。
- S6-01 群上下文（U-6-2）应按 PC 规格（`groupChatContext.ts` 组装顺序 1–19）建 `group-context` golden；桥接精简版口径（旧伴侣通道）按总方案 §9.3 属阶段 9 删除对象，不移植。
- S6-02 媒体、S6-05 语义检索分别等 D-15 的 D-12/D-9 结论；S6-03 TTS、S6-04 生图、S6-06 MCP、S6-07 公告/更新/诊断为"绿地"部分，不受上述决策阻塞（阶段 5 §2.28 结论）。
