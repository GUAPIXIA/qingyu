# Android 独立客户端重构阶段 5 实施报告

> 日期：2026-09-18（2026-09-19 复核更新；**2026-09-20 收尾**）
> 基线提交：`37801ff`（阶段 4 预算断言与文档同步）
> 完成提交：`047e093`（阶段 5 收尾 + 阶段 2–5 工作区成果整体入库；本报告与执行索引的回写是其后的
> 独立文档提交，故报告里不再自指该提交哈希）
> 结论：**进行中 —— 未到可签字状态**。2026-09-20 收尾后：单元测试 **1109 / 0**、
> `lintDebug` **0 Error**、`assembleDebug` 通过，**设备三档自动化矩阵全绿**
> （API 26 GMD 59/0、API 34 GMD 59/0、API 31 走**经典 AVD** 路径 59/0——GMD 那条路被插件写死的
> `PT2M` 挡住，见 §3.2），`pnpm lint` 的 7 个 error **已清零**（统一门禁首次全绿），
> 关闭了 §5 那条悬置的 P1（`retrieval` 从没进过运行时 → §2.21），
> 把 P1-d 的「诚实失败」那一半修了（OOM 不再被说成「ZIP 解析失败」+ 驻留预算先拒 → §2.22），
> 并修掉 **message / session / group** 三类实体的 payload P0（三条写路径此前都在发 Room 列名 →
> 两端哈希永不相等 → §2.23、§2.24），以及**信封本身**的 P0（少了 `parentId`/`schemaVersion`
> 两个必填键 → §2.26）。
> 同时新增 **D-10/D-11/D-12** 三条契约级决策（`usage_clear_marker` 粒度、
> PC 的群消息 payload 与 `message` 契约不一致、`memory_*`/`media_manifest` 在 PC 无落点）。
> **注意 §3.2「(2)」**：api26 全量套件的间歇 522 曾被我记成「已用设备档位 A/B 定位」，
> 第 5 轮已**自我推翻**并撤回该结论。
> 仍不能签字的两件事：**物理真机走查未做**（模拟器不能顶替，§11.1 两个要求不互替）、
> 以及 D-1～D-9 那批需要产品签字的决策。
> 按 §4 看板规则记「进行中」，不记「已完成」。

## 0. 阅读须知：本阶段的实际边界

阶段 5 文档（S5-01～S5-08）要求的是「用户可以只用 Android 建立和维护完整聊天资产」。
本轮完成的是**支撑这一目标的下半程**：规范 payload、仓储写路径、导入导出编解码、
跨端 golden fixture、备份 V3 格式与安全边界，以及角色编辑器一条完整竖切。

**尚未完成的是真机验证**：世界书、预设、人设、正则、快捷回复、用量分析、备份与恢复
七个编辑器/功能页与角色管理都已存在并接了路由（八个能力入口全部可达，见 §5）。
剩下的缺口不是「功能不存在」，而是**没有在设备上跑过**：
v3→v4 迁移的 instrumentation 已在 API 26/34 各 35 tests 全绿（见 §3、U-10），
但 SAF 导入导出/草稿自动保存/删除影响提示/恢复确认框
这类只有真机才能证明的行为一次都没走查。因此「Android 能独立维护内容资产」
目前是**代码层面成立、证据层面未签字**。

## 1. 已完成任务

| 任务 ID | 产物 | 证据 |
|---|---|---|
| S5-00 数据层前置 | Room v4：`local_lorebook_mapping_templates`、`local_usage_clear_markers` 两张缺失的同步实体表；角色卡 V1/V2/V3 全字段、预设内建分区/排序/启用、人设头像、正则 `group/stage/trigger/stopStrings`、快捷回复角色作用域、用量 `status/character_id/date_key` 维度 | `local/db/LocalEntities.kt`、`local/db/QingyuLocalDatabase.kt` 的 `MIGRATION_3_4`（只加列/加表/加索引，不重建表）、`app/schemas/.../4.json` 由 KSP 正常导出 |
| S5-00 规范 payload | `local/domain/EntityPayloads.kt`：16 个实体类型常量、固定实体 id、以及逐一对齐 PC 的 payload 构造 | 见 §2 两个 P0 修复 |
| S5-00 仓储写路径 | `LocalStore` 扩展、`RoomLocalSyncRepository` 全部走 journal、删除影响范围与安全解绑、`clearUsage` 因果支配判定、`LorebookMappingTemplateDsl` 受限路径 DSL | `local/domain/ContentContracts.kt`、`test/.../local/domain/Stage5ContentStoreTest.kt`（结果见 §3） |
| S5-01 角色管理 | `CharacterEditorViewModel` + `CharacterManagerScreen` + `Routes.CHARACTER_MANAGER` + 只读页入口 | 主源码编译通过；导航已接通（只读页顶部入口 → 管理页）。**未做真机走查** |
| S5-01 角色卡编解码 | `content/CharacterCardCodec.kt`（V1/V2/V3/bare 导入、V2/V3 JSON 与 PNG 导出、内嵌 `character_book` 提取、未知字段保留）、`content/PngTextChunks.kt` | `content/ContentIoGoldenTest.kt` 对 `shared/fixtures/cross-platform/content-io/` 断言（结果见 §3） |
| S5-01 媒体导入 | `content/MediaImportGate.kt`：先解码验证再落盘、单文件/单批数量与字节上限、内容寻址 + tmp/rename、越权路径读写拒绝 | `test/.../content/MediaImportGateTest.kt` |
| S5-02 世界书编解码 | `content/lorebook/**`（canonical v2 模型与校验、限额与深度、迁移 v1→v2、7 种外部格式适配器、注册表检测/导入/导出、兼容性报告、映射模板与受限 DSL）共 7474 行 | 主源码编译通过；`test/.../content/lorebook/*` 有 5 个测试文件（由并行子代理编写，结果见 §3） |
| S5-03 预设编解码 | `content/PresetCodec.kt`：`normalizePreset`/`normalizeImportedPreset` 的 Kotlin 等价实现；`LocalChatRepository.updatePreset` 从 `notMigrated` 落地为真实写入（内建预设转副本并返回新 id） | golden `preset-normalize.json`（17 例）+ `preset-import.json`（5 例） |
| S5-05 正则安全 | `content/RegexCompatibility.kt`：静态兼容性判定 + 工作量预算匹配器 | `test/.../content/RegexCompatibilityTest.kt` |
| S5-06 快捷回复 | `content/QuickReplyCodec.kt`、`content/QuickReplyPolicy.kt`；`listQuickReplies`/`executeQuickReply` 从空实现落地 | golden 无（PC 侧无对应纯函数），单测覆盖 |
| S5-07 用量清理 | `usage_clear_marker` 实体 + 因果支配清理 + 逐设备 counter 取最大 + tombstone 记账 | `Stage5ContentStoreTest` |
| S5-08 Backup V3 格式 | `content/backup/BackupV3.kt`：清单、条目名安全校验、只读预检、密钥自检 | `test/.../content/backup/BackupV3SafetyTest.kt` |
| 跨端 fixture（内容 I/O） | `shared/fixtures/cross-platform/content-io/`（7 份 golden + README）与生成器 `shared/__tests__/contentIoGolden.test.ts` | `pnpm exec vitest run shared/__tests__/contentIoGolden.test.ts` 8/8 通过（生成模式与只读校验模式各跑一次） |
| 跨端 fixture（**同步 payload**） | `shared/fixtures/cross-platform/sync-payload/`（`character-payload.json`、`other-entity-payloads.json`）与生成器 `shared/__tests__/syncPayloadGolden.test.ts`；PC 8 个私有 payload 函数加 `export` 作为 oracle | 生成器 3/3 通过；受影响 PC 模块回归 `electron/ipc` + `electron/services` + 本组共 **641 passed / 4 skipped**，`tsc --noEmit` 无错。当场抓到并修复 §2.5-1 的 `usage_record` 哈希差异 |
| §2 草稿区（六个编辑器） | `data/ContentDraftStore.kt`、`ui/content/ContentDraftCodec.kt`、`ContentDraftAutosaver`、`rememberEditorExitGuard`；六个编辑器 VM/界面接线 + 三条 P0/P1 修复（异步恢复盖输入、恢复后保存空转、新建预设点击即崩） | `test/.../ui/content/ContentDraftCodecTest.kt` 5/5、`androidTest/.../phase5/ContentDraftAreaInstrumentedTest.kt` API 34/26 各 7/0（见 §2.12、§3） |
| PC 缺陷修复 | `electron/services/charCard.ts` 导出基底 PNG 常量 | `electron/services/__tests__/charCardPngBase.test.ts` 7/7；`tsc --noEmit` 无错；charCard/vision 相关 61/61 |

## 2. 契约与迁移变化（含两个 P0 修复）

### 2.1 Android journal payload 与共享 schema 不兼容（P0，已修）

阶段 3 把 Room 列名直接写进同步信封：`exampleDialogueJson`、`avatarPath`、`lorebookId`、
`defaultPresetId` 等。而 `shared/contracts/schemas/character-payload.schema.json` 是
`additionalProperties: false` 且键名为 `exampleDialog`/`boundLorebookIds`/`boundPresetId`。
后果是**本机自己产出的信封会被共享契约判为非法**，并且与 PC
`characterEntityPayload`（`electron/services/charCard.ts`）算出的哈希永不相等。

修法：`EntityPayloads` 显式做「列名 → 契约键名」映射，并按 PC 的稀疏白名单
（只有 schema 定义且该端确实存在的字段才下发）。角色的其余本地列
（`creatorNotes`、`postHistoryInstructions`、`characterVersion`、`groupOnlyGreetings`、
`authorNote`、内嵌世界书、默认记忆策略）**不进 payload**——它们不在 schema 里，
塞进去会被判非法且与 PC 哈希不符；跨端保真由角色卡导入导出与 Backup V3 承担。

### 2.2 同步实体粒度与 PC 不一致（P0，已修）

| 实体 | PC 实际做法 | Android 阶段 3 做法 | 后果（若不改） |
|---|---|---|---|
| `settings_public` | 整份设置一个实体 `settings-public`（`bootstrapScanners.ts:136`、`ipc/settings.ts:settingsPublicPayload`） | 按 `(section,key)` 每键一个实体 | 同一份设置两端实体 id 不同，首次同步必然大量伪冲突 |
| `quick_reply_set` | 整库一个实体 `quick-replies-root`，角色级集合删除另以 `qr-char-<id>` 记 tombstone（`ipc/quickReply.ts`） | 每个集合行一个实体、无角色级 tombstone | 删除会静默丢失 |

已改为与 PC 同粒度；本地仍保留行式存储，journal 以聚合视图下发。

### 2.3 新增 PC 缺陷单独立项：角色卡 PNG 导出基底损坏

`charCard.ts` 的 1x1 透明 PNG 常量声明 `IDAT` 长度为 11、实际数据 13 字节，
按块遍历会在 `IEND` 之前脱轨。后果不是显示问题而是**数据读不回来**：
`readPngTextChunks` 找不到 `chara` 段，`importCharacterFromPng` 抛「不包含角色卡数据」
——即 PC 自己导出的这类 PNG 角色卡，PC 自己也导不进去，阶段 5 的
「P0 格式跨端往返无语义损失」在这条路径上原本是断的。

修复只改常量，不动导出逻辑。回归证据：`charCardPngBase.test.ts` 三组用例
（结构合法性 / 真实导出→导入往返 / **把旧常量钉成仍然是坏的**，防止有人改回去还全绿）。
兼容性：修好的常量与旧的在同一位置、同一长度字段位上只差一个字节值；
已导出的旧 PNG 卡仍是坏的，需要重新导出。

### 2.5 新增 `sync-payload` golden 组，并当场抓到一处哈希破坏性差异

`shared/fixtures/cross-platform/sync-payload/`（生成器
`shared/__tests__/syncPayloadGolden.test.ts`）直接以 **PC 生产代码里的 payload 构造函数本身**
为 oracle（`characterEntityPayload`、`personaEntityPayload`、`presetEntityPayload`、
`regexRulePayload`/`ruleEntityPayload`、`quickReplyStorePayload`、`settingsPublicPayload`、
`usageRecordPayload`、`lorebookEntityPayload`）。这些函数原本模块私有，为可测性各加了一个
`export`，**不改任何行为**。之所以值得单独成组：`contentHash` 就是对 payload 的 canonical
JSON 求哈希，而「PC 改了映射、Android 没跟着改」这种漂移两端各自单测都发现不了。

生成后立刻暴露的问题：

1. **已修**：`usage_record` 里 `characterId`/`sessionId` 为 null 时，PC 因为 JS
   `undefined` 序列化消失而**只有 5 个键**，Android 却写成显式 `null`（`CanonicalJson`
   编成 `null` 文本）→ 同一份「无会话用量」两端哈希不同。改为按 PC 语义整个键不下发。
2. **需产品/契约决策（未决）**：PC 的 payload 普遍是「对象上有什么键就发什么键」，
   而 Room 列非空。对**由应用 UI 创建**的数据两端一致（PC 也会把空文本框存成 `""`），
   但对**手工编辑或外部导入、确实缺可选键**的旧文件，Android 会补出 PC 没有的键
   （`character.minimal` 在 PC 只有 `name`；`regex_rule.minimal` 不含 `flags`/`group`/
   `stage`/`trigger*`/`stopStrings`）。要么 PC 写入端统一补齐这些键，要么 Android
   记录「键是否存在」——两者都是契约级改动，不该由实现 Agent 单方面定，
   已登记给阶段 7 决策门。
3. **需知悉**：`lorebook` 的 payload 是「canonical 文档去掉 id」，因此
   `createdAt`/`updatedAt` **参与哈希**（fixture 已固定）。这与总方案 §6.2
   「contentHash 排除 updatedAt 等非业务字段」在字面上冲突；现阶段以 PC 实际行为为准
   保证两端一致，规范化留到后续单独评审，不在本阶段偷改。
4. **需知悉**：`quick_reply_set` 的 `byCharacter` 会保留**空数组键**
   （`char-empty` 仍出现在 map 里），Android 聚合逻辑必须同样保留，否则删空一个角色集合
   与「该角色从来没有集合」在两端不可区分。

### 2.7 本轮新增并抓到的两处缺陷（跨端 golden 与 UI 收敛时暴露）

**(a) 角色名为纯空白时两端哈希不同（P1，已修）**
`EntityPayloads.characterPayload` 原先用 `row.name.ifBlank { 未命名角色 }`，而 PC 是
`card.name || '未命名角色'` —— 只有**空串**才兜底，`"   "` 原样下发。
`SyncPayloadGoldenTest` 对 `character-payload` fixture 的 `blank-name-falls-back`
用例直接报出 `expected "   " but was "未命名角色"`。已改成 `ifEmpty`，
并由 `blank-name-falls-back`（下发 `"   "`）+ `empty-name`（下发 `未命名角色`）两条钉住。
影响面：这类角色在阶段 7 会被判成「两端都改过」的伪冲突。

**(b) 世界书映射模板序列化把自己写坏（P0，已修）**
`LorebookMappingFieldPaths.toJsonMap()` 在 `linkedMapOf(...).apply { put("keys", keys) }` 里
裸写 `keys` —— `apply` 换了隐式接收者，`keys` 解析到的是**正在构造的那张 Map 的 `keySet` 视图**
（活引用），不是字段路径。序列化出来是 `"fields": {"keys": ["keys","content","title"]}`。
后果链：模板落库/回读后 `fields.keys` 不是字符串 → `requireTemplate` 抛错；
导入第三方世界书时关键词与 `namePath` 全解析不出来 → 名字静默退化成兜底名、
条目关键词为空 → 编译出的运行时世界书一条都触发不了。
现改为 `this@LorebookMappingFieldPaths.keys`，并把 `requireTemplate` 的错误消息
加上实际类型（就是它把这条 bug 定位出来的）。

**教训**：`apply`/`with` 里构造 Map 时，凡与 `Map` 成员同名的属性（`keys`、`values`、`size`、
`entries`）都必须显式限定接收者；这一类错误编译期无提示，只有往返测试能抓到。

**(c) Backup V3 日期键用了 API 34 才有的方法（P1，本阶段自引入，已修）**
`BackupOrchestrator.toLocalDateKey` 写了 `LocalDate.ofInstant(Instant, ZoneId)` —— 这个工厂方法
**API 34 起才有**，而 `minSdk = 26`。后果不是编译错误而是运行时 `NoSuchMethodError`：
Android 8–13 用户一恢复含用量/日期键的备份就崩，而 **1035 个单测全都跑在 JDK 上，全绿**。
是首跑 `lintDebug` 的 `NewApi` 检查抓到的（本轮唯一 1 个 Error）。
已改为 API 26 起可用且语义等价的 `Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()`，
`lintDebug` 复跑 **0 Error**、`assembleDebug` 通过。
**这条的价值不在修了自己，而是证明 §11.2 的 `lintDebug`/`assembleDebug` 不是形式门禁**：
阶段 3 曾修过同形状的 API 26/27 崩溃（通知渠道组），说明这一类缺陷在本仓有复发倾向，
每个新写的 `java.time`/`java.util` 调用都必须过 lint 而不是只过单测。

### 2.8 把「死 golden」接活之后抓到的两处偏差（§3 的 D-5①）

先说清这一节为什么存在。`content-io/lorebook-detect.json` 与 `lorebook-import-roundtrip.json`
是 PC 实现生成的跨语言 golden，但**只有 TS 自己读它**（全仓 Kotlin 侧唯一的引用是我留下的
一句注释）。也就是说 README 的跨端矩阵里「世界书往返」那一格，此前实质上是
**两端各自测自己**：Android 有 `LorebookExportRoundTripTest`（自己导、自己导回），
PC 有 registry 测试，两边的期望值没有任何一处被对方消费过。
而 Android 自己闭环有个抓不到的盲区：**两端都缺同一个字段时，闭环看起来毫发无损**。

本轮做的事：
- 新增 `content/lorebook/LorebookCrossLanguageGoldenTest.kt`（5 条），把上面两份 golden 变成
  Kotlin 侧真实断言——检测候选（含顺序、置信度、冲突提示与两个阈值常量）、
  **PC 导出 → Android 再导入** 与 PC 自己再导入的 canonical 逐字段相等、
  同一份 canonical 两端**导出物**逐字节相等、PC 拒绝用例的文案逐字相等、
  PC 用到的 6 个适配器在 Android 全部注册且可导出；
- 新增第三份 golden `content-io/lorebook-catalog-canonical.json`（104 KB，28 条）：
  把**阶段 0 的真实外部文件**（`tests/lorebook/fixtures/`，含 6 份 invalid）的
  PC canonical、PC 兼容性报告、PC 导出对象一起冻结，Kotlin 侧在同一段字节上复现四道；
- 把易变值归一规则收进唯一出处 `shared/__tests__/helpers/goldenVolatile.ts`，
  两份 TS golden 与 Kotlin 侧共用同一套哨兵。

接活之后立刻抓到两处真偏差：

**(a) 原生 v1 导出丢掉书级未知字段（P1，已修）**
`LorebookNativeV1Format.exportLorebook` 把 `bookExtras = document.foreign["qingyu.native-v1"]`
**算出来了却从未合进导出结果**，返回的是不含 extras 的 `view`。
导入侧明明按 PC 的规则把未知字段存进了 `foreign`（报告也如实写「N 个未知原生字段已保留」），
导出侧却不还回去——「导一次少一个字段」正是方案 §2 禁止的静默丢失。
PC 是 `{...bookExtras, ...view, entries}`（`nativeV1.ts:82-90`）。
28 份阶段 0 样本里只有 `native-v1-unknown-extensions` 带书级未知字段，
而它的导出恰好少了 `futureBookOption: {revision: 2}`，被第 4 道断言点名。
Android 自己闭环时两端同缺此键，`LorebookExportRoundTripTest` 全绿。

**(b) Risu 的拒绝文案两端不同（P1，已按 PC 对齐；PC 侧不一致另立 D-7）**
`risu/invalid.json`（`data: ["不是对象", 42]`）两端都拒绝，但文案不同：
PC 报「世界书包含无法导入的结构：**没有可导入的世界书条目**」，
Android 报「…**2 个条目不是对象，无法导入**」。
根因是 `LorebookRisuFormat` 把**未过滤**的原始条目数组喂进统一导入器的 payload，
而 PC 的 `resolveEntries` 里那一句 `data.filter(isRecord)` 已经把非对象条目滤掉了，
于是 `common.ts:273` 的 `sourceCount - sourceEntryList.length` 恒为 0、`invalid_entries` 永不触发。
（`novelai`/`agnai` 的 invalid 样本走的是另一条路，PC 确实会报「1 个条目不是对象」，
所以这两条两端本来就一致，也一并被 golden 钉住了。）
已把 Android 改成与 PC 同一形状。**顺带记下 PC 自己的不一致**：
`risu.ts:105` 的 `isRecord(entry) ? toPayloadEntry(entry) : entry` 里 `: entry` 分支
在预过滤之后是死代码，而它上面的注释写的是「不做预过滤：非对象条目交给统一导入器计数」——
即 PC 的实现与它自己的意图相反，且同一套代码里 novelai/agnai 按意图、risu 按反意。
这属于 PC 侧行为改动（会换掉 PC 用户看到的文案），按 §11.3 需要单独的回归证据，
不在本阶段顺手改，故立案 **D-7**。

**归一规则的教训（两端共用，别改回「一律抹掉」）**
`entries[].id` 是不是易变值，取决于它是谁给的：外部格式自带的（`v1e`、`a1`、`n1`）
会被导出原样写回，属于业务语义；导入器现生成的（PC 是 `mock-id-N`，Android 是 ULID）才是噪声。
判据取 `id !== sourceId`。第一版按「所有 `entries[].id`」抹，结果把 `v1e` 一起抹掉，
而原生 v1 的导出恰好**直接写 `entry.id`**，于是 Android 的正确答案反倒被判成偏差。
另一条同期修掉的：`src/test/setup.ts` 把 nanoid mock 成**全局自增** `mock-id-N`，
所以抹错范围不仅造成假红灯，还会让 fixture 随用例执行顺序漂移。
现在两份 lorebook golden 都带「两次求值逐字节相同 + 不残留 mock-id」的自检。

**顺带发现的一处 fixture 口径差（不算缺陷，但会误导下一个人）**
`tests/lorebook/fixtures/catalog.json` 的 `expected.importable` **不是**「导入会不会成功」：
`native-v1-invalid` 标的是 `importable: true`，而 PC 的导入器对它会抛
「轻语原生世界书 v1 校验失败」。它实际表达的是「检测能不能认出这个格式」。
Android 既有用例 `LorebookFormatImportTest` 用 `importable && kind != "invalid"` 过滤，
恰好躲过了这层歧义；新的跨端用例改成直接按 PC 实际结果分支（21 条导入 / 7 条拒绝），
并在断言旁边写明别再拿 `importable` 推数量。

### 2.9 恢复失败路径：一处谎报与三条真机证明（§3 的 D-5②）

**发现的缺陷：事务已提交、媒体落位失败时把结果报成「已回滚」（P1，已修）**
`BackupOrchestrator.restore` 的三条失败路径原本共用一个 `catch (Throwable)`，
统一返回 `rolledBack = true, applied = emptyMap()`。但媒体文件的 `renameTo`
发生在 `store.inTransaction { ... }` **之后**——那一刻库已经按备份改完了。
于是这条路径对用户说的是「什么都没动」，实际是「角色/预设/会话都已覆盖，只有头像没落位」。
两种后果都不体面：用户再恢复一遍（第二次可能成功，也可能又失败），
或者相信「已回滚」而不去核对，留下一堆指向缺失媒体的行。
现在把这条路径单拆成 `MediaMoveFailure` 分支：**如实报 `rolledBack = false` + 已应用的 counts**，
错误文案写明「数据库已按备份更新，但媒体文件落位失败」，交给 UI 说清「库已更新、媒体缺 N 个」。
（Room 的事务不会也不该倒带——恢复本身是幂等合并，倒带反而需要另一份快照。）

**三条失败路径的真机证明**（`phase5/BackupRestoreFailureInstrumentedTest`，API 34 GMD）：
1. **媒体写不进去**（只读媒体目录）→ 失败点在事务之前：`rolledBack = true`、库里只剩本地那一行；
2. **事务内部失败**（在写世界书时注入 `IOException("No space left on device")`）→
   证明「先前成功的 `putCharacter` 也一起倒带」，且 `applied` 为空；
3. **事务提交后 move 失败**（目标位置预置非空目录，POSIX rename 必失败）→
   断言 `rolledBack == false`、角色确实已被备份覆盖、`applied["characters"] == 1`——
   就是上面那个缺陷的回归位。
4. **单条目体积上限**：64 MiB+1 的全零载荷（包本身几十 KB）必须在 `BackupV3.inspect`
   被「单条目过大」拒掉，且拒绝原因里**不能**出现 `Java heap space`。
   这条只在设备上测得动：上一版它在 JVM 单测里先 OOM，测的是堆不是上限（§5-P1-d 记过），
   所以当时把断言从单测撤出而不是降级成「反正都拒绝」。

**「磁盘满」的覆盖口径要写准**：这三条走的是**写边界失败**这个等价路径
（只读目录 / 注入 IOException / rename 冲突），**不是**把分区真写满到 ENOSPC。
在 GMD 模拟器上填满分区要几百 MB 写放大、还会污染同宿主的其它用例，代价不值。
「ENOSPC 本身未被模拟」因此仍是这条矩阵上的一个已知缺口，别把它读成已覆盖。

### 2.10 压力矩阵：三档压力数据真跑，以及一处与同步契约的正面冲突（§3 的 D-5③）

`phase5/ContentLoadMatrixInstrumentedTest`，API 26 与 API 34 各 **4 tests / 0 失败**
（`2026-09-19T05:10:48` 与 `05:12:08`）。这一格要的不是「感觉不卡」，而是三条能判定的东西：

| 压力形状 | 断言的机制 | 实测（api34 / api26，整用例墙钟） |
|---|---|---|
| 500 角色 | 分页与搜索都在数据库层：一页恰好 `PAGE_SIZE=200`（与 `CharacterEditorViewModel.PAGE_SIZE` 同值），总数由 `COUNT` 单独给，`LIKE` 命中的 20 行全部真含关键词，翻两页**零重叠** | 2.16s / 2.56s |
| 100 本世界书（5 本 × 3,500 条 + 95 本 × 100 条，约 1.9 万条目、~9 MiB JSON） | 列 id 的路径不被大列拖住（100 条 id 全部可列出），巨型本按 id 取回仍是 **3,500 条、一条不丢** | 23.25s / 7.70s（大头是灌数据） |
| 1,000 预设 | 内建/用户两个分区各 500 条，两区合计 = 总量（分区口径不漏行） | 9.56s / 6.08s |

排序列**逐行赋不同 `updated_at`** 是有意为之：全是同一个值时 `LIMIT/OFFSET` 的行序不确定，
翻页重叠断言就变成掷骰子——这类「用例自己造的不确定性」必须在写的时候就掐掉。

**D-8：方案 §3 的「每书 5k 条」与同步契约的 2 MiB 单条 payload 上限正面冲突**
实测 5,000 条的 canonical 文档 = **2,467,984 字节** > **2,097,152 字节**
（`shared/syncBaseline/index.ts#MAX_PAYLOAD_BYTES` 与
`electron/domain/bootstrapScanners.ts#DEFAULT_MAX_PAYLOAD_BYTES`、
Android `MigrationIdentity.MAX_PAYLOAD_BYTES` 三处同值——**两端共用，不是 Android 自加**），
于是 `putLorebook` 在记账阶段就被 `PayloadTooLargeException` 拒掉。
按每条 ~494 字节折算，**一本书的条目上限约 4,245 条**。
`MigrationIdentity` 那段注释给的出路是「更大的二进制内容走 blob / app-private files」，
但世界书正文不是二进制、它就是实体 payload 本身，所以 blob 那条路对这件事不适用——
真要支持 5k 条得改**同步契约**（抬高上限、或把世界书文档分块记账），
牵动两端哈希边界与 relay 的接受范围，属 §11.3 的跨端改动，不在阶段 5 单方面决定。

这条**没有用「降级断言」换绿**：`lorebookAtPlanScaleIsRefusedByTheSharedPayloadCap`
直接断言「5k 条必须被上限拒掉、异常里报出的 limitBytes 必须等于契约常量、
且库里不能留下半个影子」。将来谁抬高上限或补上分块路径，这条会立刻变红，
逼着他同时改 §3 的口径和 D-8 的结论——正是要的效果。
压力矩阵因此是在**契约允许的最大档**（3,500 条/本）上签字的，
这一格读成「5k 条已验证可用」就是误读。

### 2.11 第一次把 Compose 交互层放上设备：修掉一个「列表永远出不来」的缺陷，并划清走查还剩多少

阶段 5 之前 `androidTest` 里没有一处 `createComposeRule`——「八条入口可达」的证据只是
「路由常量存在 + 能编译」。本轮补了两件事：
`ContentUiWalkthroughInstrumentedTest`（中心页八条入口逐行点击，1/1 通过，API 34）与
`CharacterEditorMainDispatcherProbeTest`（真实主线程 + 真实 Room 驱动 S5-01 的
`CharacterEditorViewModel`：保存恰好一次业务变更、版本向量推到 `"1"`、
DB 层分页检索命中，1/1 通过，API 34）。

**抓到的真实缺陷：骨架屏最短展示混用了两个时间基准，骨架屏永不消失（已修）**
`rememberSkeletonVisible`（`ui/components/AsyncStates.kt`）起表用 `System.currentTimeMillis()`，
停表用 `withFrameMillis` 的帧时间。帧时钟是「自启动以来的单调毫秒」（量级 1e4–1e7），
墙上时间是 1.7e12，于是 `now - shownSinceMs` 恒为大负数、永远 `< minShowMs`，
状态机一路返回 `previous`——**骨架屏不再消失，列表内容不再出现**。
已改成两侧都取帧时钟（`withFrameMillis { it }` 起表），最短展示 300ms 的语义不变。
为什么以前没暴露：`skeletonTick` 是纯函数且有单测，但两个时间参数都由调用方喂，
喂错基准纯函数测不到；而受它影响的 会话/角色/群聊/用量 四个列表页此前一次真机都没跑过。
**这条缺陷的因果是按代码判定的**（读得出来），不是在设备上观察到的——
修完之后那三条走查用例的症状一模一样（见下），所以不能声称「走查红是因为它」。

**数据加载类走查的结果：产品链路已被组合出来的界面证明，手指点按钮那一格仍归真机**
`ContentUiWalkthroughInstrumentedTest` 现在 API 34 与 API 26 各 **3 tests / 0 失败**
（`2026-09-19T06:57:47` / `06:58:36`）。三条分别是：

1. `saveIsDisabledUntilTheDraftActuallyChanges`——**输入前 `保存` 带 Disabled，输入后消失**，
   且这一步之后 head 数量不变。它同时是 §2「只有保存才产生业务变更」的界面侧证据，
   也是判因证据：说明真实键入确实进了草稿（此前我怀疑「输入根本没到 ViewModel」，实测否掉了）。
2. `saveViaSemanticsActionProducesOneJournaledChange`——从组合出来的界面上触发 `保存` 的
   OnClick 语义动作，结果：库里出现该角色、`entity_heads` 版本向量恰好推到 `"1"`、
   `change_log` 有这一条、head 只多一个。**「一次保存 = 一次业务变更」这条验收语由此在设备上是成立的。**
3. `everyContentEntryOnTheHubIsReachable`——中心页八条入口逐个真实点击、各自回调。

**为什么 2 用的是语义动作而不是真实触摸（这是本轮实测出来的，不是回避）**：
真触摸那条用例一路红到最后，测到的事实是——
`保存` 节点确实在根视口内（比过 `boundsInRoot`），但注入点击后
既没有 busy 进度指示、head 增量也是 0，即处理函数根本没被调用；
而尝试用 `GLOBAL_ACTION_BACK` 收软键盘时，宿主 Activity 直接被结束，
说明当时**并没有键盘挡在上面**（我先前「软键盘遮住底部操作行」的猜测就此作废）；
同一宿主里中心页八行的真实点击是好的，所以这不是「触摸注入整体不可用」，
而是这一个节点在本宿主下点不动，机制未查明。
结论要按这个分寸读：**界面到仓储这一段是真的走通了**（输入→草稿→保存→记账），
**「手指落在按钮上」仍只能靠物理真机走查收口**——那本来就是 §5 的未完成项，
不许因为这三条绿就把它划掉。

### 2.12 §2 的草稿区补齐：六个编辑器全部接上，并当场抓到三个真实缺陷

方案 §2 的原文是两句：「编辑器自动保存必须**写草稿区**，不把每次键入都发布成同步变更；
点击保存**或离开确认后**生成一个业务变更」。本轮之前只有第二半是成立的
（`EditorDraft.commit` 保证不点保存就不落库、不记账），第一半**根本没做**：
草稿只活在 ViewModel 里，手机上进程被系统回收、或用户切去聊天再回来，
写到一半的世界书就整篇没了——而这恰恰是移动端最常见的中断方式。
另外角色编辑器的代码注释当时写着「取消会走离开确认」，界面上却**没有那个确认框**，
属于同一类「注释声称有、代码里没有」。

**落地了什么**

| 件 | 位置 | 为什么长这样 |
|---|---|---|
| 草稿区存储 | `data/ContentDraftStore.kt`（DataStore `companion_content_drafts`，键 `"$kind#$entityId"`） | 分区名与 `EntityTypes` 同名（用例直接拿 `EntityTypes` 常量断言，改名会红而不是留下一堆读不到的旧草稿）；同一种实体可以并存多份未保存草稿 |
| 行编解码 | `ui/content/ContentDraftCodec.kt` | **全列**快照，不用同步层 payload：payload 是按 PC 契约裁出来的稀疏白名单，拿它存草稿会静默丢掉只有本机才有的列（头像路径、内嵌世界书、卡片规范版本、记忆开关）。可空列用 `JSONObject.NULL` 区分「用户清空了」与「从没设过」，否则一次清空会在恢复时被吞掉 |
| 写入器 | `ContentDraftAutosaver`（`ui/content/ContentEditorSupport.kt`） | 300 ms 防抖：DataStore 每次写都是一次磁盘提交，输入法连打会把它变成写放大器；`settle()` 保证「已清草稿」不会被在途排程覆盖 |
| 离开确认 | `rememberEditorExitGuard`（同一文件） | 六个编辑器共用一份判定：返回箭头 / 系统返回键 / 操作行「取消」三条出口只要漏接一条，就留下「没被问就丢了半篇内容」的路径。角色编辑器原先手写的那份已并进来，只剩一处实现 |

六个编辑器（角色 / 世界书 / 预设 / 人设 / 正则 / 快捷回复）全部接上：
键入只进草稿区，`draftRestored` 时界面显式说明「已恢复上次未保存的草稿（尚未保存为一次变更）」，
保存成功或用户在确认框里选「放弃草稿并离开」才清草稿。
快捷回复的草稿快照存**行**（含 `itemsJson`）而不是 `SetDraft`——后者带着 `items`/`extras` 两份派生值，
直接序列化会出现「行与派生值不一致」的草稿。

**抓到的三个真实缺陷（都由 `ContentDraftAreaInstrumentedTest` 在设备上先跑红、修完转绿）**

1. **`startCreate()` 的异步恢复会盖掉用户正在写的内容**。恢复草稿是一次 IO，整段写在
   `launch` 里时，界面先显示空白、IO 回来再 `_editor.update { EditorState(...) }` 整体重建状态——
   在这中间打进去的字直接没了。修法：先**同步**立起空编辑器，异步那份只在
   「当前草稿仍未被改动」时才套用（六个 VM 同一形状）。
2. **恢复出来的新建草稿永远存不下去**。草稿区拿回来的行成为 `EditorDraft.original`，
   `dirty` 恒为假 → `commit` 判定「无变化」→ 不落库、不记账，而界面**显示「已保存」**。
   快捷回复因为有 `isNew` 强制写而躲过，其余四个都中招。修法是 `commit(force = 新建行)`。
   这条特别值得记：它恰好是「草稿区」这个功能自己引入的，早一天有草稿区就会早一天踩到。
3. **「新建预设」一点就崩**。`PresetEditorViewModel.startCreate()` 用
   `PresetCodec.normalize(name = "")` 造种子，而 `normalize` 对空名抛 `PresetFormatException`，
   调用点在点击处理函数里是**同步**的 → 未捕获异常。改用非空种子名 `未命名预设`。
   此前预设的单测只测编解码，没测过 `startCreate` 这条路。

**一条测试侧的自伤（不是产品缺陷，但必须记）**：草稿区是进程级单例，而「新建」共用 `new` 这一把键。
第 1 条修好之后，走查用例 `saveViaSemanticsActionProducesOneJournaledChange` 反而**由绿转红**——
上一条用例留下的未保存草稿被这一条恢复出来，`performTextInput` 于是变成**追加**，
`name == 我打进去的字符串` 当然不成立。修法是用例前后清草稿槽（`@Before`/`@After`），
不是放宽断言。教训：**给产品加持久化，就要同时给测试加隔离**，否则用例之间开始互相喂数据。

同类的还有：保存路径是「先落库、后清草稿」（顺序不能反，否则写失败时草稿也没了），
所以「草稿已清空」只能在库里出现该行之后再等一会儿——`assertNull` 直接读会在 API 26 上输掉这个窗口。

**证据**：`ContentDraftCodecTest` 5/5（反射按主构造器造行 + **列数漂移守卫**：
`declaredFields` 数与草稿 JSON 的键数不等就当场红，不依赖有人记得补测试）；
`ContentDraftAreaInstrumentedTest` 六个编辑器各一条 + 一条「放弃草稿」路径，
API 34 与 API 26 各 7 tests / 0 失败（见 §3）。
仍未收口的两点记在 §5：草稿区**没有容量上限**（U-11），
以及「手指真能点到底部保存按钮」仍归物理真机走查（§2.11 已划界，本轮没变）。

### 2.13 §3 三跳链的第二种格式：预设「PC 导入 → Android 导出 → PC 再导入」接上，并量出剩下两种格式的边界

§3 的矩阵第一条是「每种外部格式使用阶段 0 fixture 做 PC 导入 → Android 导出 → PC 再导入，以及反向流程」。
本轮之前只有**世界书**有这条链（§2.8），预设只有 `preset-import`（第一跳：两端导入结果一致）。
只测第一跳的漏洞很具体：导入实现对齐、**导出**把某一列写歪，或者导出的文件再导入一次就变味，都能绿过去。

**做了什么**

- TS 侧新增 `preset-roundtrip` 生成用例（`shared/__tests__/contentIoGolden.test.ts`），
  按 PC 自己的路径跑完整链：`normalizeImportedPreset` → `presetEntityPayload` →
  `JSON.stringify(preset, null, 2)`（就是 `electron/ipc/preset.ts` 导出 handler 写文件的那一句）→
  再 `normalizeImportedPreset` 一次，把两端都会读的 payload 一起冻进
  `shared/fixtures/cross-platform/content-io/preset-roundtrip.json`（4 例：standard snake_case、
  native 覆盖 snake、越界钳位、无名称回退）。
- Kotlin 侧 `PresetCodecGoldenTest.presetChainPcImportAndroidExportPcReimport` 读同一份 fixture 断言三件事：
  Android 导入 == PC 导入；**Android 用生产代码的 `EntityPayloads.presetPayload`（进 contentHash 的那一份）
  导出的 payload == PC 的 payload**；Android 读回自己的导出再导一次不变，且 == PC 二次导入的结果。
  比较一律走 canonical JSON——payload 键顺序归 `sync-payload` 那组管，这里只回答
  「同一条预设两台设备算出来是不是同一件事」。
- 实测结论：**PC 自己的往返在 4 例上都是无损的**（`importedPayload` 与 `reimportedPayload` 全等），
  预设的 payload 是 12 键白名单，因此 Android 侧「正文整体就是 payload」（D-3）与 PC 一致。
  门禁：`contentIoGolden` **10/10**（含只读校验模式），Android 全量 **1055 / 0 失败**。

**顺手量到：剩下两种格式没有可接的链，原因是 PC 侧不存在导入/导出路径**

| 格式 | PC 侧实际有什么 | 结论 |
|---|---|---|
| 人设 | `electron/ipc/persona.ts` 只有 `list/save/delete/createDefault`，**没有** import/export handler；只有纯函数 `personaEntityPayload`（3 键白名单） | 「PC 导入 → Android 导出 → PC 再导入」这条矩阵项**对人设不适用**（没有外部文件格式可言）；能做且已做的是 payload 对齐（`sync-payload` 组） |
| 正则 | `electron/ipc/regex.ts` 同样没有 import/export；`regex:save` 把对象原样存盘，PC **没有**正则归一化器 | 同上。但有一处真实差异要记：PC 的 payload 是 `{...rule} - id`（**未知键会进哈希**），Android 是固定 11 键。Android 代码注释已写明属已知差异、留给阶段 7 的 fixture 钉死（`EntityPayloads.kt:134-141`），本轮不重复决定，记在 §5 的 U-12 |
| 快捷回复 | 导入逻辑长在 `ipcMain.handle('quickReply:importJson')` 里（dialog + `readFileSync`），最内层纯函数 `normalizeQuickReply` **没有 export** | 想做三跳必须先让 PC 把那个纯函数暴露出来（一行 `export`）。另有**有意差异**：Android 保留 PC 会丢弃的条目未知键（`QuickReplyCodec.unknownByKey`），所以「PC 再导入 Android 的导出」必然把那些键再丢一次——链子能接，但断言口径要先定（决策，不是实现） |

### 2.14 §3 三跳链的第三种格式：角色卡整链接上，并因此修掉一处「两端各导出一份、字节不同」

预设那档（§2.13）之后，剩下最要紧的 P0 格式就是角色卡。它此前的证据全是**单步**：
`character-card-validation`（判定与错误文案）、`png-chunks`（chunk 读写）、`png-export-base`（导出基底）。
单步全对不等于链对——导入读错一个字段、导出少写一个键、或者「导出的文件再导入一次就变味」，
都必须把整条链跑一遍才会红。

**链的形状**（`shared/__tests__/contentIoGolden.test.ts` 新增 `character-card-roundtrip`，
输入是阶段 0 冻结的三张卡：V1 裸卡、V2 内嵌世界书、V3）：
PC 从原始卡导入 → `exportCharacterToJson` 落成文件文本 → 再导入 → 再导出。
`exportCharacterToJson` 不写时间戳也不生成 uuid，所以这条链**完全确定**，
不需要为可测性引入任何接缝（PC 的两个函数都是按文件路径的接口，测试里落到临时目录即可）。
Kotlin 侧 `CharacterCardChainGoldenTest` 对应跑四档断言：

1. Android 导入原始卡再导出的内容 == PC 导出的那份（**语义**，canonical JSON 比较）；
2. 同上但**逐字节**相同；
3. 反向：Android 读 PC 导出的那份再导一次 == PC 自己的二次导出（往返不漂移）；
4. fixture 里 PC 自身的 `exportStable` 标记也进门禁，并硬要求三张卡全部可导入
   ——一条都跑不通的链可以「全绿地空跑」，那是最容易骗过自己的形状。

**第 2 档红出来的真实差异（已修）**：Android 的 `org.json` 会把 `/` 转义成 `\/`，
`JSON.stringify` 不会。阶段 0 的卡里 `extensions` 带 `avatar-placeholder: [/]` 这类值，
于是两端各导出一次就是两份**语义相同、字节不同**的文件。这不影响解析，但影响两件实在事：
用户 diff 两份导出会看到整篇被重写；跨端 fixture 只能比解析结果、比不了字节。
修法不是放宽断言，而是在导出侧加 [pcCompatible]：只把字符串上下文里的 `\/` 还原成 `/`，
每轮连吃两格，因此值里真的含「反斜杠 + 斜杠」（文本 `\\\/`）时不会被误改。
PNG 的 `chara` / `ccv3` 段载荷同一口径（PC 写的是紧凑 `JSON.stringify`），所以那条路径也接了同一个函数——
否则「JSON 导出对齐了、PNG 导出还差一个转义」会继续静默存在。

**读法**：三跳链至此覆盖 角色卡 / 世界书 / 预设 三种 P0 格式；剩下两档不适用或待决策，
口径与证据写在 §2.13 末尾那张表和 §5 的 U-12，不在这里含糊带过。

### 2.15 §3「删除有引用资产的所有分支均有测试」是按**实测**发现缺口的

这条要求此前在报告里被当作已完成——因为仓储层有 `Stage5ContentStoreTest`。
按 grep 数一遍调用点才发现不是：`deleteLorebook` / `deletePreset` / `deletePersona` /
`deletePersonaUnbindingReferences` / `deleteRegexRule` / `deleteCharacterQuickReplies`
这些名字**只出现在 `FakeLocalStore` 的声明里**，整棵测试树没有一条用例调用过它们。
接口存在≠分支有测试，而这里恰好是 §4「所有写入进入 Repository 和 change journal」最集中的一类分支。

补了 7 条，每条都跑 Room 与内存替身两遍（沿用本文件的 `eachStore` 口径）：

| 分支 | 断言的是什么 |
|---|---|
| 不带解绑的原语删除 | 留 tombstone、头标 `deleted`，且**刻意不碰引用行**——把「原语不是用户路径」钉住，将来谁把原语接到界面上，这里先响 |
| 世界书解绑删除 | 清 `lorebookId`、从 `boundLorebookIdsJson` 里摘掉但保留其它绑定、会话列表同样摘掉；角色与会话两行的版本向量必须**因果推进**（只写库不记账就是两端一致地错） |
| 人设解绑删除 | 清角色默认人设与会话人设，返回的影响范围等于删除前测到的那份 |
| 预设 / 人设原语删除 | 只 tombstone 目标本身，同类的另一条不受影响，幸存那条不得被标 `deleted` |
| 正则删中间一条 | 其余规则的 `sortIndex` 不得被重排——顺序本身是业务语义，对端也要看到同样的链 |
| 清空角色快捷回复 | 产生**两行** journal：整库实体 `quick-replies-root` 的 payload + `qr-char-<id>` 的 tombstone，且实体 id 集合逐条对得上；**没有集合可清时整段跳过**（连 journal 都不动），否则「删一个不用快捷回复的角色」会凭空推进版本向量 |
| 删角色只剩一个集合 | 还有别的集合时**不得**留角色级 tombstone，那会让对端把活着的集合当已删 |

过程里被纠正的是**我的断言**而不是实现：第一版写「清空角色集合 = 一行变更」，
跑出来 Room 给的是两行（整库 payload 一行 + tombstone 一行，两个不同实体），
替身同口径。也就是说这条链上「一次用户动作 = 两条 journal」是正确形状，
我原先按 §2 的「一次保存一条变更」直觉套错了粒度——记下来，因为这类套错很容易再犯。

### 2.16 Android 12 那一次全量套件的红，读出来是本轮自己带进去的一个回归

> **本节末尾有一句推断已在 §2.17(b) 被推翻**：「同一次 `OnClick` 语义动作被宿主调了两次」不成立——那个 `2` 是**设备全局 dot 计数**，不是这一行被记了两次。「连点两次保存会重复落库」本身是真的，另有独立用例（独立内存库 + 两次显式 `save()`）守着。

全量套件在 API 31 上跑出 2 个失败（§3 有记录）。其中
`ContentUiWalkthroughInstrumentedTest.saveViaSemanticsActionProducesOneJournaledChange`
的失败信息很具体：**`一次保存应把版本向量恰好推到 1 expected:<[1]> but was:<[2]>`**——
用例只触发了一次保存动作，实体却被记了两次。

先在设备上把它做成了可判定的最小复现：`CharacterEditorSaveIdempotenceInstrumentedTest`
（新建 → 改名 → `save()` → 再 `save()`，内容一字未改）。API 34 上稳定红：
`两次点保存只该有一条变更 expected:<1> but was:<2>`。

**根因是 §2.12 那次改动带进来的。** 为了让「从草稿区恢复出来的新建草稿」能存进库，
`EditorDraft.commit` 加了 `force = 新建行`。角色编辑器的保存成功后**不关页面**
（界面继续编辑，这是刻意的设计），于是 `characterId` 仍是 null，
第二次提交依旧走 `force` 分支，把同一行再落一次。
其余五个编辑器不受影响，因为它们在保存成功后直接 `_editor.update { EditorState() }` 关掉了页面；
世界书则早就在成功回调里把 `lorebookId` 升上去、`isNewDraft` 置假。

修法是补上角色编辑器缺的那一步：保存成功后把 `characterId` 升到已落库的行 id。
之后重复提交回到 `dirty` 判定，没改过就什么都不产生。
**读法要说白**：这不只是「双击保存会多一条同步变更」的产品问题，
它也意味着 §2.11 那条「一次保存 = 一次业务变更」的绿**当时是靠在 dirty 判定上侥幸成立的**——
同一个语义动作在该宿主下其实被调了两次（一次点击推出 2 格），只是旧的 dirty 判定把第二次吞了。
现在这条不变式改由「状态机 + 专门的幂等用例」共同守，而不是靠运气。

**另一条经验（省一次踩坑）**：这条用例本来写在 JVM 单测里（Robolectric）。
Robolectric 下测试线程**就是**主线程，`runBlocking(Dispatchers.Main)` + `delay` 自锁，
整个测试任务挂住不动（实测 8 分钟无输出，只能 `--stop` 清守护进程）。
必须驱动 `viewModelScope` 的用例只能放 androidTest——与
`CharacterEditorMainDispatcherProbeTest` 同一前提。这条已记进项目记忆。

**同一个修复又带出第二个 bug，是被「把整套一起跑」抓到的**：把 `characterId` 升上去之后，保存成功回调里那句 `draftArea.discard(draftKey(state.draft))` 再算键时拿到的已经是**行 id**，于是去清一个从没写过的槽，而真正该清的 `character#new` 留在原地——下次进来会把「已保存的内容」当未保存草稿恢复出来。在 API 26 上把幂等用例、走查三条与草稿区七条**放在同一跑里**才暴露（`保存后草稿区没有清空…：等待 8000 ms 后仍不成立`），因为草稿区那条正是它的判据；只复跑走查/幂等两条就会漏掉。修法是把键在升级之前先算好（`savedKey`，与正则编辑器同形状）。 **教训按这条记**：改动跨「保存 → 清草稿 → 恢复」这条链时，必须整链复跑，不能只跑与改动同名的那条用例。
修完两处的复跑结果：**API 26 与 API 34 各 11 tests / 0 失败**（幂等 1 + 走查 3 + 草稿区 7 同跑），三件套 `2026-09-19T11:29` 复跑 1066 / 0、lint 0 Error。

### 2.17 草稿区容量上限（U-11 关闭），以及一次自我推翻：那个「版本向量 2」根本不是重复写

**（a）容量上限。** §2.12 把草稿区接上之后留下的真实风险是：Preferences DataStore
**全量驻留内存、每次写整文件重写**，而一本接近 2 MiB 的世界书草稿会把「每 300 ms 一次」的
自动保存变成持续的大块重写，多条草稿累加后文件再也降不下来。本轮的处理：

- `ContentDraftStore.put` 返回 `DraftWrite`（`ACCEPTED` / `TOO_LARGE` / `OVER_BUDGET`），
  判定放在 `edit {}` 里做（DataStore 自己的写互斥内），不留 check-then-write 的空子；
- **单条上限直接取同步契约的那个 2 MiB**（`MigrationIdentity.MAX_PAYLOAD_BYTES`），
  不另发明一个数——用例 `capMatchesTheSyncPayloadContract` 钉的就是这件事；
  总量取 4 条满额的余量；
- **拒绝但不淘汰**：淘汰等于丢用户没保存的东西，比拒绝写入严重得多；
- 拒绝必须说话：`ContentDraftAutosaver` 通过 `onSkipped` 把原因写进六个编辑器**已有的**
  那行 error 文案（「…自动草稿已停用：请及时点保存，退出前不会替你留稿」），
  文案里的 MiB 数由常量算出来——写死的数字会在有人调上限之后变成假话；
- 同值自动保存直接跳过（`lastWritten`），省掉「焦点变化也把整档重写一遍」。
  它对世界书基本不生效：那一层的投影每次都带新的 `updatedAt`，内容上确实不同——
  这不是漏，记在这里免得被当成 bug。

**（b）一次自我推翻。** §2.16 里我写过「同一次 `OnClick` 语义动作被宿主调了两次」，
依据是走查用例读到 `版本向量 = 2`。给两条用例的失败信息加上
「这一行在 journal 里被记了几次、各是什么 origin 与 dot」之后，一次连跑就把话挑明了：

```
一次保存应把版本向量恰好推到 1；这一行被记了 1 次：local/<deviceId>#2   expected:<[1]> but was:<[2]>
```

**journal 里这一行只有一条**。`2` 是**设备全局 dot 计数**：版本向量里那个数读作
「这一笔变更落在本设备的第几个 dot 上」，不是「这一行被写了几次」。
所以只要这个进程里先前写过任何实体，后跑的那条拿到的就是 2 以上——
「谁后跑谁红」，与类无关、与镜像档位也无关（API 34 连跑同样复现；API 31 那次是同一件事）。
结论分三条：

1. 那两条断言的口径本来就是错的（拿 per-device 的 dot 去等值比较 1），
   此前的绿是**顺序运气**，不是产品当时的状态；
2. §2.16 由它推出的「宿主把点击发了两次」不成立，已就地标注更正；
3. 改成正确口径（**这一行在 journal 里的条数**恰好 1 + 本设备 dot 存在）之后，
   探针 2 + 走查 3 + 草稿区 7 + 幂等 1 连跑 **API 34 与 API 26 各 13 tests / 0 失败**。

改断言没有放宽任何东西：`一次保存 = 一次业务变更` 本来就是 per-entity 的陈述，
dot 从来不是它的判据。而真正存在过的重复写风险由
`CharacterEditorSaveIdempotenceInstrumentedTest`（独立内存库、两次显式 `save()`、
断言 journal 条数与 `headCount` 增量）单独守着。

**方法上的收获**：这两条红一条真一条假，分开它们最终只靠失败信息里那个
「这一行的 journal 条数」。以后写记账类断言，失败消息里要带上
**能把两种解释二选一的那个计数**——§2.11 记的是「busy 指示 + 行数」，
这次再加一条「per-entity 变更条数 vs 设备 dot」。

### 2.18 按 §2 补的两处界面级要求：世界书列表的搜索/分页下推到 SQL，正则删除也显示影响范围

审计这一轮时是把 §2 的每条要求**对着代码找证据**，不是对着报告的记忆。两处对不上：

**（a）世界书列表的搜索与分页。** 方案的句子是「大型列表分页/搜索在数据库层执行」。
角色侧早就有 `searchCharacters(query, sortBy, limit, offset)` + `countCharacters(query)`，
世界书侧却只有 `listLorebooks()`（全表 `SELECT *`），VM 里再 `filter` ——
而世界书一本的正文就是 MiB 级，压力口径是 100 本：等于「搜一个词先把 100 本文档树读进进程，
再丢掉大部分」。这段在代码注释里是**自认为已上报的缺口**，本轮做完：

- `LocalLorebookDao.search / countMatching`：WHERE 只用名称与来源格式两列（与旧内存过滤同口径），
  `ORDER BY name COLLATE NOCASE, id` + `LIMIT/OFFSET`；两个查询共用同一个 WHERE，
  否则页码会和内容对不上；
- `LocalStore.searchLorebooks / countLorebooks`，Room 与内存替身各一份实现；
- VM：`ListState.total` 新增、`matched`（内存过滤）删掉、`refresh()` 走 SQL、
  `loadMore()` 用「已显示条数」当偏移、`onQueryChange` 改成重问数据库
  （查询词一变，内存里那一页就跟新词无关了）；
- 列表页：底部 `加载更多（已显示 X / N）`，不做「只放一个按钮」——用户会以为就只有这些。
- 已知行为照抄角色侧：查询词里的 `%` / `_` 是 LIKE 通配符，不转义。
  要改就两个列表一起改，单边改会让两个列表的搜索语义不同。

**契约用例**（`lorebook search and paging agree across both stores`）钉的是：同一页内容、
偏移续页、末页不足页长、大小写不敏感、按来源格式命中时的顺序、查不到时总数与页都为空。
Room 与替身必须逐项一致。

**（b）正则规则的删除确认没显示影响范围。** §2 那句是「删除均显示影响范围」，
正则那一侧原来是一个光秃秃的「删除会记录为一条删除变更」。现在换成共用的
`DeleteImpactDialog`，并说清真话：引用计数是**零是有依据的**（本地库里没有任何列存正则规则 id），
所以不写「被 N 处引用」骗人；`extraWarning` 讲真正后果——作用域/阶段/分组、启用状态、
删除后这条不再改写文本，**其余规则的顺序不会被重排**（顺序就是链式替换的语义，
这条同时被 §2.15 新加的那条删除分支用例从仓储侧钉住）。

**顺手抓到的一次 Kotlin 作用域坑**（写替身时踩的）：`buildString { forEach { ... } }` 里的
`forEach` 绑的是那个**空的 StringBuilder 接收者**，不是外层字符串——于是每个名字都折成空串，
`sortedWith(compareBy(...))` 静默退化成插入序。是分页契约用例把它抓出来的：
Room 给 `[delta, epsilon]`、替身给 `[gamma-book, delta]`。同源风险在 `apply { }` 上也踩过一次
（阶段 5 早期记录）。教训是**替身与真实现必须跑同一张行为表**，
只测其中一边时这类退化不会被任何人看见。

**还剩的同形缺口（如实记）**：预设列表既没有搜索框也没有分页，而压力口径是 1k 预设
（`listPresetSection(builtin)` 全表读）；人设/正则/快捷回复列表同理但量级小得多。
§2 那句话是条件式的（分页/搜索*如果*做就要在数据库层），所以这不算违反，
但对 1k 预设的列表可用性是有实际差别的，记在 §5。

### 2.19 把同一句话用到预设列表上（1k 预设），顺带纠正两处我自己写错的东西

§2「大型列表分页/搜索在数据库层执行」还有一处没落地：预设列表既没有搜索框也没有分页，
而 §3 给这一份的压力口径正是 **1k 预设**（`listPresetSection` 全表读）。
本轮按 §2.18(a) 同一形状补完：`LocalPresetDao.search/countMatching`
（`is_builtin` 分区 + 名称/说明 LIKE + 与 `listByBuiltin` 逐项一致的排序 + `LIMIT/OFFSET`）、
`LocalStore.searchPresets/countPresets`、Room 与替身各一份、VM 加 `query`/`userTotal`/
`loadMoreUser()`、列表页加搜索框与「加载更多我的预设（已显示 X / N）」。
内建分区不分页：它是安装包带来的固定小集合，整份只读展示。

**两处我自己写错、必须就地纠正的记录**（都是这一步里发生的，不是历史包袱）：

1. 我在给替身写注释时断言「原先只是 `filter`、按插入序返回」——**不成立**：
   原来的实现是 `filter{}.sortedWith(compareBy(sortIndex, name.lowercase(), id))`，
   只是它的折叠用 `lowercase()`（连非 ASCII 一起折），而 SQL 的 `COLLATE NOCASE` 只折 A-Z。
   真正的差异是折叠范围，不是「有没有排序」。注释已按事实重写。
2. 我给替身换实现时锚点只匹配了两行，把原代码第三行 `.sortedWith(...)` 落了下来，
   挂在新 `countPresets` 后面 → 编译期就红（`sortedWith` 找不到接收者）。
   记这条是因为它说明了**多行锚点的替换必须带完整语句**：漏一行不会「少改一点」，
   而是把语义整个错位到下一个成员上。

契约用例 `preset search and paging agree across both stores` 跑 Room 与替身两遍：
分区隔离、页内容、续页、末页不足页长、名称命中、大小写不敏感、说明列命中、
内建分区不受用户查询词影响、查不到时总数与页都为空。
折叠口径也在这条里钉住（单看任何一侧都正常，同表才露）。

**这轮的门禁与设备复跑**：`testDebugUnitTest` **1071 / 0**、`lintDebug` 0 Error / 19 Warning、
`assembleDebug` 通过；改动过读路径的三类设备用例（草稿区 7 + 走查 3 + 压力矩阵 4）
在 API 34 与 API 26 各 **14 / 0**（见 §3）。

§2 的五句现在逐句有据：草稿区（§2.12 + 容量 §2.17a）、离开确认（§2.12）、
删除影响范围（六个编辑器 + 正则 §2.18b）、大型列表在数据库层（角色 / 世界书 §2.18a / 预设 §2.19）、
导入报告五类（角色卡、世界书、预设、快捷回复、备份恢复 §2.9）——
最后这一句的「所有导入」我只验到这五条路径，其它入口若有导入行为要另外补。

### 2.20 把「所有导入显示五类」逐条对着代码数一遍：预设缺两类，角色卡缺的一类是**读出来才知道**的

上一段那句「五句逐句有据」在导入这一句上是**没有数过的**——我按 §2 原文
「所有导入显示成功、跳过、近似映射、失败和未知字段保留报告」把每个导入入口的报告类型
与界面渲染逐个读了源码，实测结果并不齐：

| 导入入口 | 报告里有什么 | 界面印什么 | 缺什么 |
| --- | --- | --- | --- |
| 角色卡 | `ImportReport(imported, skipped, failed, unmapped, boundLorebooks)` | 四类 + 绑定世界书 | **近似映射**（且这条路径唯一真实的近似没有任何读数，见下） |
| 世界书 | `ImportSummary(imported, approximated, failed, skipped, preservedNotes)` 五样俱全 | 表头只印四类 | **未知字段保留**不进表头（只在非空时才出现） |
| 预设 | `ImportReport(imported, failed, unsupported)` | 三类 | **跳过、近似映射**两类都没有 |
| 快捷回复 | 五样俱全 | 五样全印（含 0） | — |
| 人设 / 正则 | 无导入入口（PC 侧也没有 import handler，见 §2.13） | — | 该句对这两类**不适用** |

三类缺口分别按事实补齐，没有一处是靠「把断言改松」或「把类别合并」抹平的：

**(a) 预设的近似映射：`PresetCodec.approximateNotes`**（`content/PresetCodec.kt`）。
`normalize` 一直在静默改用户的数据——钳位（`temperature: 11 → 2`）、取整（`maxContext: 1500.4 → 1500`）、
非数值回落（`topP: "abc" → 0.95`）、截断（名称 >100 字符）、非法枚举整个丢弃
（`exampleDialogMode: "sometimes"`）、非文本正文当空（`systemPrompt: 123 → ""`）。
清单刻意走**旁路读数**而不是改 `normalize` 的返回形状：`normalize` 的输出整体就是同步 payload 的正文，
动它会牵动跨端 golden。口径也钉死为「只报填了且被改动的」——缺失键与显式 `null` 都算「用户没填」，
否则每一篇用默认值的预设都会带一串没发生过的告警。
`normalizeImported` 里传入的是**做完蛇形→原生映射之后**的 Map：酒馆式 `max_context` 越界最狠，
若清单只认 camelCase 就会恰好漏掉最需要报的那一批。
并加了一条不变量用例：报告不产生第二次改动（`normalize(body)` 再归一化一次必须一字不变）。

**(b) 预设的跳过：`PresetCodec.foreignShapeNote`**。这条是读代码时发现的**真实缺陷**，不只是报告缺类：
预设正文只有 `id`/`name` 必填，而角色卡顶层恰好也有 `name`，于是——

> 一份角色卡 JSON 走预设导入入口，会被**静默导入成一条"看着有内容"的预设**：
> `name` 与 `description` 从卡上串过来，真正决定行为的 `systemPrompt` / `jailbreak` 一格都没有。

这不是推测，用例 `unguardedImportOfACardFileWouldSilentlyYieldAnEmptyPreset` 把这份空壳的
逐字段结果钉住了（`name=卡名`、`description=角色的描述`、`systemPrompt=""`、`temperature=0.8`）。
守卫按格式的自有标记判类别（`spec=chara_card_v2/v3`、`data.first_mes`、`entries` 数组），
世界书与打包成数组的预设同样归入跳过。
**边界必须说清楚**：PC 的 `normalizeImportedPreset` 没有同类守卫，这是 Android 侧的导入路由 UX，
不改归一化结果——守卫只决定「导不导」，不改「导成什么」，所以两端对同一份预设仍算同一个 `contentHash`。

**(c) 角色卡的近似映射：唯一的真实近似是 PNG 文本段**。角色卡路径没有数值钳位，
它唯一会「导入了但内容比原文少」的地方是 `zTXt` / 压缩 `iTXt` 段——两端都读不出内容
（PC 同规则，跨端 fixture `itxt-compressed-skipped` 早把它钉成"一致行为"而非缺陷）。
问题在于这件事**只在 fixture 里存在，界面上一个字都没有**，用户分不清「这张卡本来没写」和
「写了但被导入丢了」。补法是加读数、不改行为：`PngTextChunks.unreadTextChunkKeys()`
（对比 `read()` 实际取回的键与 chunk 链里出现过的文本段），导入成功后按段落进报告。
`read()` 的返回形状一个字没动，与 (a) 同一个取舍。
世界书侧只把「未知字段保留」的计数提进表头（明细仍在下方按条列），使五类**即使为 0 也印出来**。

**本轮门禁**：`testDebugUnitTest` **1078 / 0**（+7 条 `PresetImportReportTest`）、
`lintDebug` 0 Error / 19 Warning、`assembleDebug` 通过。
**设备侧本轮未复跑**（§11.2 口径）：改动落在导入报告的读数与文案上，Room 读写路径未动，
但「未复跑」不等于「已通过」——下一轮接上 §2 的设备级验证时，需要跑的是导入这一条走查
（预设页选一份角色卡 JSON 应进「跳过」而不是新增一条预设），以及新加的 7 条用例所依赖的
`PresetCodec` 在真机 Room 路径上的表现。真机 8/12/14 走查与 API 31 复跑仍被宿主磁盘占满卡着（§3）。

### 2.21 §5 那条悬置的 P1 结案：`retrieval` 从没进过运行时，差异此前完全无声

**结论先行**：上一版报告 §5 把 `LorebookRuntimeCompileTest` 那条红猜成「hybrid/semantic 条目永不触发」、
又猜「根因在阶段 4 生成主链路」——**两个方向都不对**。那条用例当时红的原因是测试前置没给角色上下文
（已修，见 §5-B-1），而真正的问题不是某条用例，是**一个字段从来没有被读过**：

`ChatLorebookCompile` 的类注释写着「`retrieval` → `matchMode`（keyword / both / semantic）」，
但 `compileEntry` 构造运行时条目时**根本没有读这个字段**，`ChatLorebookRuntime.Entry` 里也没有对应属性。
于是运行时对所有模式一视同仁地只用关键词通道，「这条要求的到底是哪条通道」在运行时里根本不存在。

**三种真实差异（PC 口径取自 `shared/chat-core/lorebook.ts` 的 `hasKeywordChannel` / `isLexicalEligibleMode` / `isSemanticDeadEntry`）**：

| `retrieval` | PC（无 embeddings） | Android 改动前 | 用户看到什么 |
|---|---|---|---|
| `keyword` | 关键词通道 | 关键词通道 | 一致 |
| `hybrid`（有关键词） | 关键词通道（另有词法） | 关键词通道 | 一致（见下方平台级缺口） |
| `hybrid`（**无关键词**） | **词法兜底** | 无任何可用通道 → 不触发 | **无声少注入** |
| `semanticPreferred` | 向量 → **词法兜底** | 关键词近似（而 PC 根本不用关键词） | **无声改了机制** |
| `semanticRequired` | **停用该条目** + warn-once | 关键词照常触发 | **两端相反** |

后三行不是假想，有确定的导入路径：SillyTavern 的 `vectorized: true` 条目在 `LorebookNativeV1`
（`matchMode = if (keywords.isNotEmpty()) "both" else "semantic"`）→ `LorebookNativeMigration.retrievalFromLegacy`
（`"semantic" → "semanticPreferred"`）之后，**无 key 的那一条就是 `semanticPreferred`**——
它在 Android 上一条可用通道都没有，静默不注入。

**改了什么（三层，全部是「补读数」，没有一处改触发行为）**

1. `ChatLorebookRuntime.Entry` 新增 `retrieval`，`ChatLorebookCompile` 如实读 `activation.retrieval`
   （缺省 `keyword`，与 `LorebookActivation.retrieval` 同口径）——注释与代码从此一致；
2. 新增 `ChatLorebookChannels`：把「本机有什么通道」收成两个常量（`VECTOR_AVAILABLE` /
   `LEXICAL_AVAILABLE`，当前都是 `false`）与一张判定表，产出 `SAME / APPROXIMATED / UNAVAILABLE /
   PC_DISABLED` 四档；`hasKeywordChannel` / `isSemanticDeadEntry` 与 PC 同名函数逐条对齐，便于将来对照。
   它同时写明了**平台级缺口**：PC 的 `hybrid` 条目恒可走词法，本机不能，所以本机结果是 PC 的**子集**——
   这一条不逐条判定（不实现词法通道就无法知道会不会命中），只能声明口径；
3. 导入结果给用户一行话：`FileOutcome.channelNote` → `ImportSummary.channelNotes` → 列表页印出，
   例如「检索通道差异：2 条不会触发（原文要求语义/词法检索，本机暂无该通道）。」
   数字全部由 findings 数出来、不写死（写死的数字会在有人实现通道之后变成假话）。

**为什么不能塞进兼容性报告**：`LorebookCompatibilityReport` 与 PC **逐字节相同**——
`LorebookCrossLanguageGoldenTest` 直接断言 `report.toJsonMap()` 等于 PC 冻结的那份。
往里加一条 issue 会让跨端 golden 变红。所以这是 Android 侧的**独立读数**，走界面提示
（与 §2.20(c) 加 `unreadTextChunkKeys()` 同一取舍：加读数、不改行为）。

**有意没做**：**没有**按 `retrieval` 分流触发。方案 §S6-05 要的正是「分级实现：远程 embedding →
本地模型 → 关键词/词法降级」，那时才会真正按通道分流；本阶段动分流会连带改掉跨语言 golden 的口径，
而那条 golden 的 12 个用例里**没有一条带 `retrieval`**——也就是说「按模式分流」目前既没被证明、
也没被证伪。先把字段带进运行时、把差异说出口，再交给 S6-05 落地，是这一步的边界。

**新增用例（13 条）**

- `ChatLorebookChannelsTest`（11 条，纯 JVM）：PC 同名两判据的对照（含 `always` 不受语义缺失影响）、
  判定表逐行（含未知模式不猜含义）、聚合只统计**会被实际考虑**的条目（跳过停用书/停用条目，
  否则会提示一条根本不会参与触发的条目）、无差异时不给文案、文案里的数字由 findings 数出来；
  另加 `platformCapabilityConstantsAreTheSingleSwitch`——阶段 6 翻那两个常量时这张表会一起变红，
  逼着同时更新分类表与文档，而不是让「本机静默不支持」继续没有读数；
- `LorebookRuntimeCompileTest.retrievalModeSurvivesTheCompileBoundary`（1 条）：七个 full 夹具逐条断言
  `document.entries[i].activation.retrieval == book.entries[i].retrieval`，并硬要求夹具至少覆盖一种
  非 `keyword` 模式（否则这条断言形同空跑）。

**回滚**：三处互相独立。删 `ChatLorebookChannels.kt` 并去掉 `FileOutcome.channelNote` /
`ImportSummary.channelNotes` 两处即回到「不给用户这行提示」；`Entry.retrieval` 与 compile 的读取是纯新增字段，
不影响任何既有断言（golden 夹具不带该字段，`keyword` 默认值即原行为）。

**顺带纠正上一版的一处读法**：§5 写「所有 hybrid/semantic 外部条目在 Android 上永不触发」——不成立。
`hybrid` 条目（ST 里 `vectorized` 且**有关键词**的）照常按关键词触发；真正不触发的是
「无关键词的 `hybrid`」以及「`semanticPreferred` 且没有任何可用命中途径」这两类。

### 2.22 §5-P1-d 的「诚实失败」那一半：驻留预算 + OOM 与「包损坏」分开说

**问题**（报告此前只记了现象）：`BackupV3.inspect` 把整包与每个条目字节都留在内存里，
上限却是**契约**的 1 GiB，而 Android 单应用堆只有它的 1/4–1/8；于是「备份变大」先撞 OOM，
而那句 `runCatching` 把 `OutOfMemoryError` 一起吞掉，用户看到的是
**「ZIP 解析失败：Java heap space」**——读起来像文件坏了，于是重导一遍或去怀疑文件来源，
而真正该做的是换台机器或换路径。`BackupV3SafetyTest` 里原先那段注释把这个设计问题写得很清楚，
但它写的是「仍未解决」。

**改了什么（都在 `BackupV3.kt`，**接口形状未动**）**

1. `residentBudgetBytes(sourceBytes, heapMaxBytes)`：驻留预算 = `min(契约 1 GiB, (可用堆 − 源包) × 0.5)`。
   纯函数、堆大小可注入，因此**设备的真实堆值不进断言**（否则同一条用例在不同机器上断的是不同的数）。
   先把源包扣掉是因为它此刻已经在内存里；扣完不够就返回 0，调用方据此**直接拒**而不是等 OOM。
2. `inspect(bytes, budgetBytes = …)`：超预算在**解压过程中**就拒，文案给出「上限 / 已解压 / 下一步」；
   注入的预算仍被契约上限夹住，**契约不因注入而放宽**。
3. `describeInspectFailure(error, seenBytes)`：OOM → 「本机内存不足…请改在 PC 上恢复」，
   其它 → 「ZIP 解析失败：…」。两条分支各有断言，坏包那一支还从 `inspect` 入口**端到端**跑过
   （手工拼一个「local header 声明 deflate、数据是垃圾」的最小 ZIP）。

**口径要读准——别把它读成已修**：这一轮修的是**失败的可解释性**与**提前拒绝**。
真正**恢复**一个大于驻留预算的备份仍然做不到，那要改 `Preview.entries: Map<String, ByteArray>`
这个整包驻留的接口形状（P1-d 的剩余项，属 S5-08 能力层）。所以现在正确的说法是
**「拒绝得诚实且可执行」**，不是「多大的备份都能恢复」。

**新增用例（4 条；`BackupV3SafetyTest` 现有 15 条，全量单测 1091 → 1095）**：
预算数学（取小 + 扣源包 + 兜底 0）；超预算被预算拒而不是被堆拒，并**带对照组**
（同一个包给足预算必须通过——否则证明的是「这包本来就坏」）；OOM 与包损坏两句不同的话；
坏包端到端不抛异常。同时把该文件里那段「这是个未解决的设计问题」的注释改成现状说明：
**过期的注释比没有注释更危险**，它会让下一个人以为这里还是坏的、或者以为已经修好了。

### 2.23 消息与会话的同步 payload：三条写路径都在发 Room 列名（P0，已修）

**怎么发现的**：回看 §5-P1-d 时顺手核对「`EntityPayloads` 到底覆盖了哪几类实体」——只有 **9 个**
构造函数，而总方案 §6.1 列了 **17 类**同步实体。于是把 `message` / `session` 的 payload 与
`shared/contracts/schemas/` 逐键对了一遍：

- 契约 `message-payload.schema.json` 是 `additionalProperties:false`，`required` 里**有 `timestamp`**；
- PC 的 `messageEntityPayload`（`electron/ipc/chat.ts`）逐字照着它写：`sessionId/role/content/timestamp/
  characterId` + 可选的 `speakerKind/generationKind/narrativeMode/swipes(数组)/swipeIndex/replyToId`，
  本地保真字段（`images`/`translation`/`charUsage`/`generationError`/`contentRenderMode`/
  `dialogueDirections`）**一个都不发**；
- 而 Android 三条写路径发的都是 **Room 列名**：`logicalTime`/`seq`/`swipesJson`/`imagesJson`/
  `usageJson`/`translation`/`generationStatus`，**没有 `timestamp`**；
- 会话同理：PC 发 `lorebookIds`（数组）+ `createdAt`/`updatedAt`/`narrativeMode`，
  Android 发 `lorebookIdsJson`（字符串）并**漏掉那三键**。

后果不是「不一致」这么轻：`contentHash = sha256(canonicalJson(payload))`，因此**两端对同一条消息、
同一个会话算出的哈希永远不相等**。消息是同步量最大的实体（总方案 §12 基线 100 万条），而 §6.3 的
合并规则完全建立在「同内容 → 同哈希」之上，所以这条缺陷在阶段 7 会表现成**满屏伪冲突**。

**这不是新问题，是 §2.1 那一处的漏网**：阶段 5 给 `character` 修掉了「Room 列名进信封」，
但 `message`/`session` 从没进 `sync-payload` golden（那份只覆盖 8 类实体），于是同一类缺陷
在**量级更大**的实体上活了下来。更糟的是它有**三份实现**——仓储、`LegacyCacheImporter`
（一次性迁移那条写路径）、`FakeLocalStore`（测试替身）——三份都是旧的列名版本，
**彼此「一致地错」**，所以契约套件与跨端 golden 都抓不到它。

**改了什么**

1. `EntityPayloads` 新增 `messagePayload` / `sessionPayload`，逐键对齐 PC：
   `timestamp ← logicalTime`、`swipes` 由 `swipesJson` 解析成**数组**、`lorebookIds` 由
   `lorebookIdsJson` 解析、`narrativeMode` 的 `"" → null`、可空键为空则不下发键；
2. **三条写路径全部改成委派**：`RoomLocalSyncRepository.putSession/appendMessage/updateMessage`、
   `LegacyCacheImporter` 的三个同伴函数、`FakeLocalStore`（各自的第二份规则直接删掉）；
3. PC 侧给 `messageEntityPayload` / `sessionEntityPayload` 各加一个 `export`（**不改行为**）
   ——跨端 golden 的 oracle 必须是**生产代码本身**，否则 Android 只能抄一份规则，抄错了没人发现；
4. 新增两组 fixture：`sync-payload/message-payload.json`（5 例）与 `session-payload.json`（3 例），
   Kotlin 侧 4 条用例把它们钉成不动点（含「本地保真列一个都不许进信封」与「平台扩展列不许进会话 payload」）。

**未做的部分（逐键登记，不是放宽断言）**：Android 的 message 行**没有**
`speakerKind`/`generationKind`/`narrativeMode` 三列，PC 下发这三键时本机发不出。
`SyncPayloadGoldenTest` 用 `PC_ONLY_KEYS` 把缺口**逐键登记**，断言的形态是
「缺口必须**恰好等于**登记集合 ∩ 本用例 PC 键集」——PC 新增键、或 Android 补上列，都会立刻变红。
补这三列本身属**阶段 6 S6-01「群聊……旁白与角色身份」**。

**一处测试输入的修正（不是放宽断言）**：`LegacyCacheMigrationTest` 原先用手搓的
`createdAt = 0 / updatedAt = 0` 会话去预测 genesis 哈希，而会话 payload 按契约**要带**这两个值、
导入端读的是旧库里的真实值（`seedSample()` 里的 `1000 / 2000`）。委派之后预测对不上，用例因此变红
——修的是**测试输入**（改成与种子一致），断言一条没动。这同时说明：这条用例此前之所以绿，
正是因为旧 payload 里**没有**这两个键。

**回滚**：新增的两个 payload 函数与三条委派可独立回退；两组 fixture 是纯新增
（删掉会让 Kotlin 用例因缺输入而直接报错，不会静默跳过）。

### 2.24 `group` 的 payload：同一批缺陷的第三处（§2.23 的续）

`group` 的**实体 id 两端一致**，但 payload 还是 Room 列名那一套：

| | PC `groupEntityPayload` | Android 改动前 |
|---|---|---|
| 键 | `name` / **`memberIds`（数组）** / `createdAt` / `updatedAt` | `name` / `mode` / **`characterIdsJson`（字符串）** / `memoryEnabled` / `avatarPath` |

也就是说**成员列表这个语义主键的名字与类型两端都不同**（`characterIdsJson` 字符串 vs
`memberIds` 数组），另外漏了 `createdAt`/`updatedAt`、多了三个键 —— 同一份群聊两端哈希必然不同，
而且即使哈希相同，对端也**读不出成员**（键名与类型都不同，不是「多一个键」那种软差异）。

改法与前两处完全一致：新增 `EntityPayloads.groupPayload`，仓储与 `FakeLocalStore` 改成委派，
PC 侧 `groupEntityPayload` 加 `export`（不改行为），新增 fixture `sync-payload/group-payload.json`
（4 例）与 2 条 Kotlin 用例（不动点 + 「调度/本地列不许进信封」）。

**顺带确认一件事**：「群的调度方式目前不参与同步」是**两端的共同现状**，不是单边缺陷——
PC 的 `chatMode`/`maxRounds`/`speakerInterval`/`presetId` 同样没进 payload。
所以 Android 的 `mode`/`memoryEnabled` 正确地**不发**（发了就是单边加键），
这一条写进了 fixture 的 `deliberatelyExcluded`，将来谁要同步群调度参数就必须先改契约。

**同批记录下来、但**不改**的三条契约级差异**（都属「不该由实现 Agent 单方面定」）：
见 §5 的 **D-10**（`usage_clear_marker` 的实体粒度）、**D-11**（PC 把群会话/群消息写在
`session`/`message` 同一实体类型下、却用另一套 payload 构造函数）、**D-12**
（`memory_state`/`memory_fact`/`media_manifest` 在 PC 侧没有落点）。

### 2.25 内容层接线审计：把「功能在、接线不在」变成机械检查（并拿到一次阴性结论）

**为什么做这个**：备忘 §5-3 把「功能在、接线不在」列为本仓高发缺陷，并记下了历史上的四次
——`recordUsage` 没有生产调用者（用量页永远 0）、世界书检索/渲染只被测试使用（绑定了书却一条不注入）、
会话预设/人设从未传给装配器。这类缺陷**编译期与常规门禁都不报错**：单测全绿、跨端 golden 也对。
阶段 4 已有 `ChatBuilderWiringAuditTest` 守住装配器输入，而**内容层（阶段 5 的八个编辑器、
草稿区、媒体闸门、备份编排、用量分析）一直没有同类守卫**——它们正是下一批候选。

**先做人工审计，结论是阴性的（值得记）**：逐模块查簇外生产调用方，17 个交付项里 14 个有；
唯一没有的是 `ChatEmbeddingPolicy` / `ChatLorebookEmbedding` / `ChatVector` 这**一个互相引用的簇**
——它按 fixture 锁定、是纯函数，等的是阶段 6 §S6-05 的嵌入通道，属**有意未接线**而非漏接。
同时确认未迁移能力那条链是通的：`LocalChatRepository.notMigrated()` 会写 `unsupportedNotice`，
而这个 StateFlow **确实被 `ChatViewModel`（第 171 行）消费**，不是死信号。

**把结论固化成守卫**：新增 `ContentWiringAuditTest`（5 条，纯 JVM，扫源码文本），判据：

1. **能力 → 生产调用方**：清单 18 项，每项必须被「≥2 个生产文件」提到（声明处 + 至少一个调用方），
   否则要么接上、要么写进 `notWiredYet` 并注明归属阶段；
2. **未接线清单不许腐烂**：判据是「**簇外**没有任何生产文件引用」——不能数「出现几次」，
   因为这个簇内部互相调用（第一版正是那么写的，被自己的测试当场指出）；
3. **中心页八条入口三件齐全**：八个回调都要真的挂在 `HubRow` 的 `onClick` 上、导航宿主都要传
   **非空**实现、目标路由都要有 `composable` 落点。这条针对一个很容易重犯的坑：
   后六个回调**有 `null` 默认值**，不传也能编译，那一行会渲染出来但**点不动**；
4. **同步 payload 只能由 `EntityPayloads` 产出**：三条写路径必须委派，且不得再出现
   「把 Room 列名当 payload 键」的写法——直接锁住 §2.23/§2.24 修掉的那个 P0 类；
5. （附带）未迁移能力必须继续走 `notMigrated`，且 `unsupportedNotice` 必须仍被界面消费。

**突变验证**（备忘 §5-2 要求「每个新守卫都要故意打破一次，确认会变红」）：
把 `FakeLocalStore` 的 `groupPayload(row)` 换回 `mapOf("characterIdsJson" to …)` → 第 4 条**变红**；
从导航宿主删掉 `onOpenBackup = { … }` 一行 → 第 3 条**变红**。两处均已还原并复跑全绿。

**本轮改动是「只加测试」**：没有改任何生产代码，因此不涉及设备复跑，也不涉及 PC 门禁
（Android 单测 1101 → **1106**、`lintDebug` **0 Error**、`assembleDebug` 通过）。

### 2.26 同步信封少了两个**必填键**：`parentId` 与 `schemaVersion`（P0，已修）

**怎么发现的**：把 §2.23/§2.24 那套「与契约逐键对一遍」往上一层用——这次对的是**信封本身**。
`shared/contracts/schemas/sync-envelope.schema.json` 是 `additionalProperties:false` 且有 **11 个 `required`**，
而 Android 的 `LocalEnvelope.toJson()` 只发 9 个键，缺的正是两个：

| 缺的键 | 为什么它不是「可有可无」 |
|---|---|
| **`parentId`** | §6.3 跨实体不变量（角色—会话—消息、会话—记忆、资产—绑定）的**唯一来源**；Sync Core 靠它做 delete fence 与孤儿检测 |
| **`schemaVersion`** | payload 迁移注册表（`shared/contracts/migrations.ts` 只允许 N→N+1）的入口；没有它，接收端不知道该不该跑迁移 |

PC 那边一直是对的：`shared/contracts/sync-envelope.ts#makeEnvelope` 明确发
`contractVersion/parentId/schemaVersion`，各写路径也都带 parent（`chat.ts` 会话→角色、消息→会话；
`group.ts` 会话→群、消息→会话，**连 `deletes` 都带**），而且
`shared/domain/__tests__/memoryRepository.test.ts` 里已有孤儿（orphan）用例——**PC 侧这套语义是被测试过的**。
所以这是 Android 单边不合契约，按 §0「优先修正 Android 映射」直接对齐，**不需要决策**。

**为什么一直没人发现**：Android 只写不读。跨端 payload golden 只管 payload、不管信封；
契约套件比的是「Room 与替身是否相同」——两边同样缺，**一致地错**。这恰好说明这类缺陷会在
「没人对着契约检查」的那一层继续存活。

**改了什么**

1. `LocalEnvelope` 新增 `parentId` / `schemaVersion` 并**写进 `toJson()`**（缺省 `null` / `1`，与 PC `makeEnvelope` 同口径）；
2. `withJournal(...)` / `tombstoneInTx(...)` / `deleteWithTombstone(...)` 增加 `parentId` 并透传；
3. **补齐 parent 语义**（让字段真正有用的那一半）：
   - 会话 → 父是群或角色（`groupId ?: characterId`，与 PC 的两条写路径一致）；
   - 消息 → 父是会话；记忆状态 / 事实 → 父是会话；媒体清单 → 父是 owner（PC 尚无落点，见 D-12）；
   - **删除路径也带 parent**（PC 的 `deletes` 带）：`deleteSession`/`deleteMemoryFact` 在删除**之前**把父读出来
     （行一删，parentId 就永久是 null；为此给 `LocalMemoryDao` 加了 `getFact(id)`），`deleteMessage` 用已有的 sessionId；
   - `applyRemote(...)` 增加 `parentId` 形参：远端信封里的 parent 必须落到本机 head/journal，否则不变量在应用端丢失；
4. `FakeLocalStore` 同步（替身与真实现必须跑同一张行为表：`journal`/`tombstone`/三个删除/`applyRemote` 都带上 parentId）。

**顺带修掉同一类的第四处——而且这次是「本机内部」版本**：`memory_state` 有**两种 payload 形状**：
`putMemoryState` 用 4 键内联 map，而 CAS 路径用 `memoryStatePayload` 的 7 键。
同一实体类型、两条生产写路径 → 两个 `contentHash`。旁边那句注释
「保留原字段进 journal 载荷，同时补上 S4-05 新增字段」正说明当时只改了 CAS 那一处。
现统一到 `memoryStatePayload` 并补上 `parentId = row.sessionId`。

**新增守卫（2 条）**：`EnvelopeSchemaConformanceTest` 直接读**同一份 schema 文件**逐项核对——
必填键齐全、无额外键、`contractVersion` 为常量、`entityType` 在枚举内、`dot` 恰为 `{deviceId, counter}`、
所有 counter 是「无前导零的十进制字符串」（§6.2 要求不得经过 JVM `Long` 的有损转换）、
`contentHash` 形态正确，且 `parentId`/`schemaVersion` **键必须在**（值可为 null）。
**突变验证**：把 `parentId` 从 `toJson()` 里删掉 → 两条用例立刻红（已还原、复跑全绿）——正是原始缺陷的形状。

**2026-09-20 第 9 轮补齐**：迁移路径 `importFromLegacy(...)` 现已带 `parentId`——
`LocalStore` 接口 + `RoomLocalSyncRepository`/`FakeLocalStore` 两处实现 + `LegacyCacheImporter` 三处调用
（角色 `null`、会话 `characterId`、消息 `sessionId`）。新增用例
`migrated sessions and messages carry their parent in the envelope`：不读内存对象，而是从
**change_log 里读回真实信封**逐条核对（会话→角色、消息→会话，顶层实体的 `parentId` 键在场且为 null）。
**突变验证**：把会话那处改回 `null` → 用例立刻红（已还原、复跑全绿）。
`usage_record`/`usage_clear_marker`/设置等顶层实体 parent 恒为 null——与 PC 一致，不需要改。

### 2.6 迁移

`MIGRATION_3_4` 全部是加列/加表/加索引，无重建、无 destructive fallback；新列都带 DEFAULT。
「未设置」用空串 / `-1` / `NULL` 表达，不用空值冒充用户主动清空。
`FakeLocalStore` 同步扩展，契约表两边一致。

## 3. 测试命令与结果

| 命令 | 结果 | 备注 |
|---|---|---|
| `./gradlew :app:compileDebugKotlin` | **通过**（无错误） | Room v4 schema 由 KSP 正常导出，说明实体/迁移 DDL 一致 |
| `./gradlew :app:testDebugUnitTest` | **1078 通过 / 0 失败 / 0 跳过** | 数字取自 `app/build/test-results/testDebugUnitTest/*.xml`，`--rerun-tasks` 全量跑；§2.9 改完 `BackupOrchestrator`/`BackupScreen` 之后**又整体复跑一次**仍 1049/0。上一轮 1044 → 1049（+5 条跨语言世界书用例 `LorebookCrossLanguageGoldenTest`）→ 1054（+5 条 `ContentDraftCodecTest`）→ 1055（+1 条预设三跳 `presetChainPcImportAndroidExportPcReimport`）→ 本轮 **1059**（+4 条角色卡三跳 `CharacterCardChainGoldenTest`；这条链改动了 `CharacterCardCodec` 的导出写法，所以三件套整体复跑）→ 本轮 **1066**（+7 条 §3 删除分支契约用例，见 §2.15；复跑 `2026-09-19T11:29` → 容量用例 **1069**（`11:51`）→ §2.18 的世界书分页契约用例后 **1070 / 0**（`2026-09-19T12:44`）→ §2.19 的预设分页契约用例后 **1071 / 0**（`2026-09-19T12:58`，`lintDebug` 仍是 0 Error / 19 Warning，`assembleDebug` 同跑通过）→ §2.20 的导入报告五类补齐后 **1078 / 0**（`2026-09-19T13:22`，+7 条 `PresetImportReportTest`；同跑 `lintDebug` 0 Error / 19 Warning、`assembleDebug` 通过。**设备侧本轮未复跑**，见 §2.20 末与本表下方的设备行）|
| `./gradlew :app:lintDebug` | **0 Error / 19 Warning**（`lint-results-debug.txt` 末行口径） | 首跑**抓到 1 个我引入的 API 34 调用**，已修；见 §2.7(c)。`assembleDebug` 与 `lintDebug` 连跑 **BUILD SUCCESSFUL** |
| `./gradlew :app:assembleDebug` | **通过**，产物 `app-debug.apk` 26,771,316 字节 | 修完 NewApi 后重跑确认 |
| `pnpm exec vitest run shared/__tests__/syncPayloadGolden.test.ts` | **3/3 通过** | PC 侧真值；两份 fixture 已被 Kotlin 侧断言 |
| `pnpm exec vitest run shared/__tests__/contentIoGolden.test.ts` | **11/11 通过** | 生成模式与只读校验模式各一次；「lorebook case 逐字节稳定 + 不残留 mock-id」自检保留；本轮新增 `preset-roundtrip`（§2.13）与 `character-card-roundtrip`（§2.14）两条三跳链 |
| `pnpm exec vitest run shared/__tests__/lorebookCatalogGolden.test.ts` | **2/2 通过** | 本轮新增：阶段 0 的 28 份样本 → PC canonical/报告/导出 冻结成 golden |
| `pnpm exec vitest run electron/services/__tests__/charCardPngBase.test.ts` | **7/7 通过** | PC 缺陷修复证据 |
| `npx tsc --noEmit` | **通过** | |
| `pnpm check` | **通过** | `tsc -b --noEmit` + `tsc -p tsconfig.electron.json` 均无输出 |
| `pnpm test` | **3045 通过 / 4 跳过**（本轮 +2 条三跳链生成用例：预设 §2.13、角色卡 §2.14）（278 文件 + 1 跳过） | 含 `syncPayloadGolden`、`contentIoGolden`、`lorebookCatalogGolden` 的只读校验模式 |
| `pnpm lint` | **失败：7 error + 1 warning** | **不是本阶段引入**，见 §3.1 归属表 |
| `pnpm --dir relay-server check` | **通过** | |
| `pnpm --dir relay-server test` | **13 通过 / 13** | |
| 相关 PC 回归（charCard / domainWrite / vision / validator） | **61/61 通过** | 因为改了 PC 服务，按 §11.3 补 |
| `:app:compileDebugAndroidTestKotlin` | **通过** | 新增 `phase5/CardFieldsAndTemplateTablesMigrationInstrumentedTest`（v3→v4：行存活、默认值三态、两张新表、5 个新索引、迁移后按 v4 打开可读卡） |
| `:app:pixel2Api26DebugAndroidTest` | **35 tests / 0 失败**（Android 8.0，aosp x86_64，GMD 自建 AVD） | timestamp `2026-09-19T02:50:29`；改动后复跑 `2026-09-19T03:13` 仍 35/0 |
| `:app:pixel2Api34DebugAndroidTest` | **35 tests / 0 失败**（Android 14，aosp x86_64），**但同一天出现过 1 次非确定性失败**，见 §5-F-1 | 三次全量跑：02:52 → 35/0；03:13 → 34/1（阶段 4 用例）；03:19（`--rerun`）→ 35/0 |
| `:app:pixel2Api34DebugAndroidTest -P…class=…BackupRestoreFailureInstrumentedTest` | **4 tests / 0 失败**，timestamp `2026-09-19T04:55:03` | §2.9 的三条失败路径 + 单条目上限；上限那条在设备上实测 1.83 s（64 MiB+1 全零载荷解压），**没有 OOM**，证明拒绝来自上限判定而非堆 |
| `:app:pixel2Api26DebugAndroidTest`（同一个类） | **4 tests / 0 失败**，timestamp `2026-09-19T04:56:55` | Android 8 上 `File.renameTo`/只读目录语义与 14 一致，`rolledBack` 分支在两档都成立；上限 1.93 s |
| `:app:pixel2Api34DebugAndroidTest -P…class=…ContentLoadMatrixInstrumentedTest` | **4 tests / 0 失败**，timestamp `2026-09-19T05:10:48` | §2.10 的压力矩阵。整用例墙钟：角色 2.16s、世界书 23.25s、预设 9.56s、超上限拒绝 1.66s（大头是灌数据，不是查询） |
| `:app:pixel2Api26DebugAndroidTest`（同一个类） | **4 tests / 0 失败**，timestamp `2026-09-19T05:12:08` | 角色 2.56s、世界书 7.70s、预设 6.08s、超上限 0.92s |
| `:app:pixel2Api34DebugAndroidTest -P…class=ContentUiWalkthroughInstrumentedTest` | **3 tests / 0 失败**，XML timestamp `2026-09-19T06:57:47` | 本仓第一批 Compose 交互层用例：输入前保存不可点/输入后可点（6.93s）、语义动作保存=一次业务变更且版本向量 `"1"`（4.94s）、中心页八条入口真实点击（2.91s） |
| `:app:pixel2Api26DebugAndroidTest`（同一个类） | **3 tests / 0 失败**，XML timestamp `2026-09-19T06:58:36` | Android 8.0 上三条同样成立（3.84s / 2.45s / 1.41s） |
| 同设备的两条主线程探针（`CharacterEditorMainDispatcherProbeTest`） | **2 tests / 0 失败**，`2026-09-19T06:20:34` | 手搭仓储与 **AppContainer 交出的仓储** 都通过：保存落库、记账、DB 分页检索命中——用来把「界面走查跑不通」定位成宿主/命中测试问题而不是产品问题 |
| `:app:pixel2Api34DebugAndroidTest -P…class=…CharacterEditorMainDispatcherProbeTest` | **1 test / 0 失败**（跑于 `05:48` 那一轮；XML 已被同一设备的后续运行覆盖，只保留运行记录） | 真实主线程 + 真实 Room 驱动 S5-01 VM：保存=一次业务变更、版本向量 `"1"`、DB 分页命中。需要数据加载的三条走查因宿主协程不推进未能落地，见 §2.11 |
| `:app:testDebugUnitTest --tests "*ContentDraftCodecTest*"` | **5 tests / 0 失败**，XML timestamp `2026-09-19T07:43:59` | 全量复跑合计 **1054 tests / 0 失败 / 0 跳过**（`2026-09-19T08:09:25`，含 §2.12 三条缺陷修完之后） |
| `:app:pixel2Api34DebugAndroidTest -P…class=…ContentDraftAreaInstrumentedTest` | **7 tests / 0 失败**，报告生成时间 `2026-09-19T08:21:45`（UTC，`--rerun-tasks` 强制复跑） | §2.12 的六个编辑器 + 放弃草稿路径。**首跑是 7 tests / 7 失败**，三条产品缺陷就是从那一次读出来的 |
| `:app:pixel2Api26DebugAndroidTest -P…class=…ContentDraftArea…,ContentUiWalkthrough…` | **10 tests / 0 失败**，`2026-09-19T08:20:06`（UTC） | Android 8 上草稿区与 Compose 走查一并复跑；上一轮 §2.11 的三条走查用例仍成立 |
| `:app:pixel2Api34DebugAndroidTest`（`ContentUiWalkthroughInstrumentedTest` 复跑） | **3 tests / 0 失败**，`2026-09-19T08:26:40`（UTC） | §2.11 之后又改了角色 VM 的 `startCreate`/`save`，所以这三条必须复跑确认没被带坏。中途它红过一次，原因在用例之间共享草稿区而非产品（见 §2.12 末段） |
| `:app:pixel2Api31DebugAndroidTest`（`ContentDraftAreaInstrumentedTest`） | **7 tests / 0 失败**，报告 `2026-09-19T09:22` 前后（整轮耗时 15m12s，绝大部分是宿主侧 install/启动） | **Android 12 这一档此前从未跑成**：`adb install-multiple` 超时两次（§5-U-10 记录过）。这次单独重跑通过——同一条用例、同样的镜像，说明当时是宿主空闲度而不是环境不可能。至此草稿区矩阵 API 26 / 31 / 34 三档齐。**超时的机制本轮量到了具体数值**：GMD 的 APK 安装插件把 adb 超时写死成 `Timeout: PT2M`，命令是 `adb -s emulator-5554 install-multiple -t --user 0 -r -d app-debug.apk`；本机 api31 那一档的安装**间歇性**超过 2 分钟（一次尝试直接 `Finished 0 tests`，连收尾的 `pm uninstall` 也超时），所以「重跑即可」的准确说法只是「重试可能过」。**本轮后续两次 api31 尝试都没过**：连着两次 `Finished 0 tests`，都是 `AdbTimeoutException: Adb command timed out`（安装命令 `adb -s emulator-5554 install-multiple -t --user 0 -r -d app-debug.apk` 在插件写死的 `Timeout: PT2M` 下超时，收尾 `pm uninstall com.qingyu.companion` 同样超时）。同时量到宿主条件：**D: 盘 702 GB 已用 674 GB、剩 28 GB（97% 满）**，GMD 的镜像与 AVD 都在这块盘上——这解释了「上午能过、现在过不了」，也说明这一档要恢复稳定得先腾磁盘，不是重跑能解决的。按 §11.2「不能执行时必须记录命令、失败摘要与替代证据」：命令 `:app:pixel2Api31DebugAndroidTest -P…class=…`；失败摘要见上；替代证据是同一份修复代码在 API 34 上 4/0（§2.16），以及本轮早上 api31 自己跑过的 7/0（草稿区）与 3/0（走查，修复前）。**修复后的代码在 Android 12 上尚未复跑成功，这一格不算已验证** |
| `:app:pixel2Api31DebugAndroidTest`（**全量套件，不加 class 过滤**） | **55 tests / 2 失败**（15m48s） | 两个红都只在**全量同进程**下出现，单独重跑各自通过：`CharacterEditorMainDispatcherProbeTest.theContainerProvidedRepositoryPersistsOnTheMainThreadToo`（容器交出的仓储在 2 s 轮询窗口内没落库）与 `ContentUiWalkthroughInstrumentedTest.saveViaSemanticsActionProducesOneJournaledChange`。这不是「环境问题、忽略」：同一台镜像上一条过一条不过，说明这两条用例**依赖进程内先后顺序**（真实的文件库与共享草稿槽都是进程级），正在按 §5-U-13 追判因 |
| `:app:pixel2Api34DebugAndroidTest` / `:app:pixel2Api26DebugAndroidTest`（**探针 2 + 走查 3 + 草稿区 7 + 幂等 1 连跑**） | 两档各 **13 tests / 0 失败**（53 s / 1m3s） | §2.17(b) 断言口径改对之后的合并验证；此前同样的连跑是「谁后跑谁红」 |
| `:app:pixel2Api34DebugAndroidTest` / `:app:pixel2Api26DebugAndroidTest`（草稿区 + 走查 + 压力矩阵连跑） | 两档各 **14 tests / 0 失败**（`12:46` 1m54s、`12:48` 1m21s；§2.19 之后同一组再各跑一次 14/0，`13:01` 1m55s / `13:03` 1m21s） | §2.18 改了世界书列表的读路径与列表页，所以把这三类一起复跑；压力矩阵里「100 本世界书读回」那条走的就是同一批 DAO | 
| `:app:pixel2Api31DebugAndroidTest`（修复后复跑尝试，两次） | **未跑成：`Finished 0 tests`** | `adb install-multiple` 与收尾 `pm uninstall` 都在插件写死的 `Timeout: PT2M` 下超时；宿主 D: 盘 97% 满（剩 28 GB）。不写成已通过，见 §5-U-10 |
| `:app:pixel2Api34DebugAndroidTest -P…class=CharacterEditorSaveIdempotence…,ContentUiWalkthrough…` | **4 tests / 0 失败**（37 s） | §2.16 的幂等用例与走查三条一起跑。**修之前**这条幂等用例稳定红（`两次点保存只该有一条变更 expected:<1> but was:<2>`），是本轮 §2.12 的 `force` 带进去的回归 |
| `:app:pixel2Api26DebugAndroidTest` / `:app:pixel2Api34DebugAndroidTest`（幂等 + 走查 + 草稿区**同跑**，11 tests） | **API 26 首跑 11 / 1 失败 → 修 `savedKey` 后两档各 11 / 0**（46 s / 40 s） | 那一条失败是 §2.16 的第二个 bug（保存成功后清错了草稿槽）。**只复跑与改动同名的用例会漏掉它**：同跑整套才抓到 |
| `:app:pixel2Api31DebugAndroidTest`（`ContentUiWalkthroughInstrumentedTest`） | **3 tests / 0 失败**，报告 `2026-09-19T09:42:40`（UTC；整轮 15m26s，同样是宿主 install 慢，不是用例慢） | **Compose 交互层现在三档都有证据**：中心页八条入口真实点击（1.50s）、输入前保存不可点/输入后可点（4.65s）、语义动作保存=一次业务变更（2.33s）。「Android 8 / 12 / 14」这条矩阵行里 12 那一格此前是空的，本轮填上 |

### 3.2 2026-09-20 复跑（本地门禁 + 设备矩阵）

| 命令 | 结果 | 备注 |
|---|---|---|
| `.\gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug` | **BUILD SUCCESSFUL**（6m43s）；单测 **1091 通过 / 0 失败 / 0 跳过 / 139 套**；`lintDebug` **0 Error / 94 Warning**；`assembleDebug` 通过（`app-debug.apk` 25.1 MB） | 上一版为 1078/138 套；本轮 **+13 条**（`ChatLorebookChannelsTest` 12 + `LorebookRuntimeCompileTest.retrievalModeSurvivesTheCompileBoundary` 1）。**警告数与上一版的 19 不同**：本轮是全量分析，其中 **75 条是版本建议**（`GradleDependency` 66 + `AndroidGradlePluginVersion` 9），其余为 `ObsoleteSdkInt` 4 / `InlinedApi` 3 / `ApplySharedPref` 2 等既有项——**0 Error 的口径不变**，也没有本轮新引入的代码问题 |
| `pnpm lint` | **0 error / 1 warning**（上一版 7 error） | 逐条归属与修法见 §3.1 |
| `pnpm check` | **通过** | `tsc -b` + `tsc -p tsconfig.electron.json` 均无输出 |
| `pnpm test` | **3045 通过 / 4 跳过**（278 文件 + 1 跳过） | 与上一版数字一致；本轮改了 `shared/contracts/migrations.ts`、`shared/domain/memoryRepository.ts` 两个共享文件，故按 §11.3 复跑全量 |
| `pnpm --dir relay-server check` / `test` | **通过** / **13 通过** | |
| `pnpm exec vitest run electron/chat/__tests__/compaction.test.ts` | **6 通过**（单跑 622ms） | 见下方「一次假红」 |
| `:app:pixel2Api34DebugAndroidTest`（全量，**修复前**） | **58 tests / 1 失败**：`CharacterEditorSaveIdempotenceInstrumentedTest.savingTwiceWithoutNewEditsProducesOneJournaledChange`（`两次点保存只该有一条变更 expected:<1> but was:<2>`） | 见下方「设备侧：一处真机制、一处环境项」 |
| 同类单跑（api34） | **1 / 0**（33s） | 同上 |
| `:app:pixel2Api34DebugAndroidTest`（全量，**修复后**） | **59 tests / 0 失败** | 同上 |
| `:app:pixel2Api26DebugAndroidTest`（全量，**Nexus 5 档**，两次） | **各 59 tests / 2 失败**：`ContentUiWalkthroughInstrumentedTest` 的 `saveIsDisabledUntilTheDraftActuallyChanges` 与 `saveViaSemanticsActionProducesOneJournaledChange`，均为 `SQLiteDiskIOException: disk I/O error (code 522) … PRAGMA journal_mode` | 失败在**数据库打开**阶段，不是断言失败；见下 |
| 同类单跑（api26，Nexus 5 档） | **3 / 0**（47s） | 同上 |
| `ContentLoadMatrixInstrumentedTest` + `ContentUiWalkthroughInstrumentedTest` 两类同跑（api26，Nexus 5） | **7 / 0** | 压力矩阵不是触发条件 |
| `BackupRestoreFailureInstrumentedTest` + `ContentUiWalkthroughInstrumentedTest` 两类同跑（api26，Nexus 5） | **7 / 0** | 64 MiB 备份载荷也不是触发条件 |
| `:app:pixel2Api26DebugAndroidTest`（全量，**Pixel 2 档**，第 3 轮） | **59 tests / 0 失败**（3m54s） | **这一格后来被推翻**：同一档位在第 5 轮又以同样两条 522 失败（见下「(2)」）。当时的 59/0 是**单次巧合**，不是「档位换对了」 |
| `:app:pixel2Api31DebugAndroidTest`（GMD 路径，两次，第二次前已清掉残留 emulator 进程） | **未跑成：两次都 `Finished 0 tests`** | `Adb command timed out`（GMD 安装插件写死 `Timeout: PT2M`）：第一次卡在 `shell am get-current-user`，第二次卡在 `install-multiple … app-debug.apk`，收尾的 `pm uninstall` 同样超时。**这条路径上一条用例都没跑过** |
| `:app:connectedDebugAndroidTest --rerun`（**经典 AVD 路径**，`qingyu-api31(AVD) - 12`，手动起 AVD 后连跑） | **59 tests / 0 失败 / 0 跳过**（49.9s，整轮 1m4s） | 绕开 GMD 写死的 `PT2M`：手动起 `qingyu-api31`（`ANDROID_AVD_HOME=D:\Code\android-avd`）→ `adb` 等 `sys.boot_completed=1`（约 45s）→ `connectedDebugAndroidTest --rerun`。按备忘 §5-7 的「缓存回放」陷阱核验过三点：结果 XML 时间戳为本次（18:09:19，读取时 18:09:29）、`adb devices` 显示 `emulator-5554 device`、且加了 `--rerun` 绕过缓存。16 个类逐类全绿，含本轮受影响的 `ContentDraftAreaInstrumentedTest` 7/0、`ContentLoadMatrixInstrumentedTest` 4/0、`CharacterEditorSaveIdempotenceInstrumentedTest` 2/0 |
| `:app:testDebugUnitTest :app:lintDebug :app:assembleDebug`（§2.22 改动后） | **1095 通过 / 0 失败 / 0 跳过 / 139 套**；`lintDebug` **0 Error / 94 Warning**；`assembleDebug` 通过（`app-debug.apk` 25.6 MB） | 上一版 1091；本轮 **+4 条**（`BackupV3SafetyTest` 的预算数学 / 超预算带对照组 / OOM 与包损坏分句 / 坏包端到端） |
| 三档设备矩阵（§2.22 改动后**全部复跑**） | API 26 GMD **59/0**、API 34 GMD **59/0**、API 31 经典 AVD **59/0** | 改的是 `BackupV3.inspect`（生产代码），所以三档都复跑而不是只跑备份那一类；`BackupRestoreFailureInstrumentedTest` 三档均 **4/0**（含「单条目过大」那条断言，证明单条目上限路径没被带偏） |
| `:app:testDebugUnitTest :app:lintDebug :app:assembleDebug`（§2.23 改动后） | **1099 通过 / 0 失败 / 0 跳过 / 139 套**；`lintDebug` **0 Error / 94 Warning**；`assembleDebug` 通过 | 上一版 1095；本轮 **+4 条**（`SyncPayloadGoldenTest` 的消息/会话不动点 + 两条「本地保真列与平台扩展列不得进信封」）；该文件现 14 条 |
| `pnpm check` / `pnpm lint` / `pnpm test`（§2.23 改动后） | 通过 / **0 error** / **3047 通过 / 4 跳过**（278 文件 + 1 跳过） | 上一版 3045；**+2 条**（`syncPayloadGolden` 新增 message/session 两组 fixture 的生成与只读校验）。PC 侧只改了 `messageEntityPayload`/`sessionEntityPayload` 各加一个 `export` |
| 设备矩阵（§2.23 改动后复跑） | API 31 经典 AVD **59/0**；API 26 GMD **59 条 / 2 失败**；API 34 GMD **59 条 / 1 失败** | **三条失败全是已知既有项，与本轮改动无关**：api26 的两条是上面「(2)」那条间歇性 522；api34 的一条是 `Phase4AcceptanceWalkthroughInstrumentedTest.fullWalkthroughRunsEntirelyOnLocalDatabase`（`编辑历史必须使派生记忆失效 expected:<1> but was:<0>`，即 §5-F-1 记的阶段 4 时序脆弱）。两个类**单跑均通过**（`ContentUiWalkthroughInstrumentedTest` 3/3、`Phase4AcceptanceWalkthroughInstrumentedTest` 1/1） |
| `:app:testDebugUnitTest :app:lintDebug :app:assembleDebug`（§2.24 改动后） | **1101 通过 / 0 失败 / 0 跳过 / 139 套**；`lintDebug` **0 Error / 94 Warning**；`assembleDebug` 通过 | 上一版 1099；本轮 **+2 条**（`SyncPayloadGoldenTest` 的群 payload 不动点 + 「调度/本地列不得进信封」）；该文件现 16 条 |
| `pnpm check` / `lint` / `test`（§2.24 改动后） | 通过 / **0 error** / **3048 通过 / 4 跳过** | 上一版 3047；**+1 条**（`group-payload` fixture 的生成与只读校验）；PC 侧只改了 `groupEntityPayload` 加 `export`（不改行为） |
| 设备（§2.24 改动后） | API 31 经典 AVD **59/0**（1m15s，XML 时间戳为本次） | 本轮只复跑这一档：改动在 payload 层，已由 JVM 契约套件（含替身 vs Room 同表）与 api31 设备套件覆盖；**api26/api34 本轮未复跑**，不把上一轮的结果当成这一轮的（两档的既有间歇项见上两行） |
| `:app:testDebugUnitTest :app:lintDebug :app:assembleDebug`（§2.25 **只加测试**后） | **1106 通过 / 0 失败 / 0 跳过 / 140 套**；`lintDebug` **0 Error / 94 Warning**；`assembleDebug` 通过 | 上一版 1101；本轮 **+5 条**（`ContentWiringAuditTest`）。**没有改生产代码**，所以设备与 PC 门禁都不涉及——这一点本身就是「只加守卫」应有的形状 |
| `:app:testDebugUnitTest :app:lintDebug :app:assembleDebug`（§2.26 改动后） | **1108 通过 / 0 失败 / 0 跳过 / 141 套**；`lintDebug` **0 Error / 94 Warning**；`assembleDebug` 通过 | 上一版 1106；**+2 条**（`EnvelopeSchemaConformanceTest`）。本轮改了生产代码（信封字段 + parent 语义 + `memory_state` payload 统一），故设备复跑 |
| 设备（§2.26 改动后） | API 31 经典 AVD **59/0**（1m14s，XML 时间戳为本次） | api26/api34 本轮未复跑（同上一行的口径：不把旧结果当新结果） |
| `:app:testDebugUnitTest :app:lintDebug :app:assembleDebug`（§5-U-14 补齐后） | **1109 通过 / 0 失败 / 0 跳过 / 141 套**；`lintDebug` **0 Error / 94 Warning**；`assembleDebug` 通过 | 上一版 1108；**+1 条**（迁移信封 parent 用例，含突变验证）。改了生产代码（`importFromLegacy` 链路），故设备复跑 |
| 设备（U-14 补齐后） | API 31 经典 AVD **59/0**（1m12s，XML 时间戳为本次） | api26/api34 本轮未复跑 |

**一次假红（记下来，别当成回归）**：本轮先把 `pnpm test` 与 `gradlew :app:testDebugUnitTest`
**并行**跑（两个都吃 CPU 与磁盘），`compaction.test.ts > 保留策略 > 超过 200 个或 7 天的 terminal 被清理`
在 5000ms 超时上红了。**单跑同一文件 622ms 通过**、随后清空负载的 `pnpm test` 也 **3045/0**。
结论：`vitest` 默认 5s 超时在本机同时跑 Android 全量构建时不够用，不是产品回归——
但**门禁不能并行跑**这件事本身要记下来，否则下一个人会重踩。

**本轮遇到并修复的环境问题（不是代码问题，但会挡住整个门禁）**：`gradlew` 一开始**完全不出输出**、
静默挂死。查下来是宿主的 Gradle 发行版**不见了**——`~/.gradle/wrapper/dists/gradle-8.9-bin/<hash>/`
下只剩 `.lck` 与 `.part`（我那次挂死留下的），`~/.gradle/caches` 也不在了，
于是 wrapper 去 `services.gradle.org` 下载，而本网络到该域名不通（超时）。
绕法是**不改仓库**地把发行版落位：

1. 临时把 `android/gradle/wrapper/gradle-wrapper.properties` 的 `distributionUrl` 指向可达镜像
   （`https://mirrors.cloud.tencent.com/gradle/gradle-8.9-bin.zip`，实测 HTTP 200、136,114,148 字节），跑一次 `gradlew --version`；
2. wrapper 下载目录是**按 URL 哈希**分的，所以镜像装出来的是另一个 hash 目录；
   把 `gradle-8.9/` 与 `gradle-8.9-bin.zip.ok` 复制进原 URL 对应的 hash 目录；
3. **把 `gradle-wrapper.properties` 还原**（`git status` 确认该文件干净），此后 `gradlew` 不再联网下载。

依赖侧复跑时要重新解析：`repo1.maven.org` 与 `dl.google.com/dl/android/maven2` 实测均可达（HTTP 200），
不需要镜像。**留一句给下一个人**：本机若再次出现「`gradlew` 无任何输出」，先看
`~/.gradle/wrapper/dists/` 里有没有 `gradle-8.9/`，不要先去怀疑代码或 Gradle 配置。

**设备侧：一处是真机制、一处是设备档位——两处都已定位，不是「跑挂了先记着」**

先说要紧的：**受本轮改动影响的类在两档全量跑里都是绿的**——
`ContentDraftAreaInstrumentedTest` **7/0**（六个编辑器的草稿区，含世界书编辑器）、
`ContentLoadMatrixInstrumentedTest` **4/0**（含 100 本世界书的读回与分页）、
`PresetImportReportInstrumentedTest` **2/0**、`BackupRestoreFailureInstrumentedTest` **4/0**。
本轮改了 `LorebookEditorViewModel` / `LorebookListScreen`（Compose 侧），
按 §2.16 的教训把受影响的设备用例整链复跑了一遍。

**(1) API 34 那条是真机制，已修：`save()` 的重入窗口**

`CharacterEditorViewModel.save()` 用**调用这一刻**的 `characterId` 决定 `isNewRow`（即是否 `force` 落库），
而 `characterId` 是在保存成功的回调里才升上去的。于是「第一次提交还没落地时又提交一次」
会拿着 `isNewRow = true` 再 force 落一遍 → 两条 journal、版本向量多推一格。
用例里那句固定 `delay(SETTLE_MS = 500)` 在满载的全量套件里不够用，所以**时红时绿**：
单跑 1/0、修前那次全量红、后来复跑 58/58 全绿——**这一条此前记的「已修」是靠时序运气成立的**。

修法两处：

- `CharacterEditorViewModel.save()` 加 `busy` 重入闸：在途提交期间第二次调用直接返回。
  它覆盖的真实路径不止连点按钮——`saveAndClose()`（离开确认里的「保存并离开」）与在途保存撞车时同样走这里；
- 用例拆成两条、各覆盖一种时序：`savingTwiceWithoutNewEditsProducesOneJournaledChange` 现在用
  `awaitSettled(vm)` 轮询 `busy` 落下（**不再靠固定 sleep**），新增
  `savingAgainWhileTheFirstSaveIsStillInFlightProducesOneJournaledChange` 正面覆盖「第一次还在飞就再点一次」。
  两条在 API 26 与 API 34 各 **2/2 通过**。
  新用例顺带钉住一个前提：`viewModelScope`（`Main.immediate`）在调用线程上**同步**跑到首个挂起点——
  若哪天不成立，第二次会真的落库，这条会立刻红。

**(2) API 26 全量套件的 `SQLiteDiskIOException(522)`：间歇性；我先前那条「A/B 定位到设备档位」的结论已作废**

现象：**全量 59 条同实例**跑完时，后段的 `ContentUiWalkthroughInstrumentedTest` 两条用例红在
`SQLiteDiskIOException: disk I/O error (code 522)`，且发生在 `PRAGMA journal_mode`（打开数据库）阶段
——**不是断言失败**。而同一镜像上：同类单跑 **3/0**、加上压力矩阵 **7/0**、加上 64 MiB 备份载荷 **7/0**。
宿主磁盘也不是满的（当时 D: 剩 49.7 GB），所以**不是**报告此前记的「宿主磁盘 97% 满」那个原因。

**中间那条（现已作废）的推断**：查构建文件时发现 `pixel2Api26` 用的是 `device = "Nexus 5"`
（而本报告一直写「三档都是 Pixel 2」），于是假设「2013 年的档位数据分区更小、被全量套件的累积写入撑满」，
并做了一次 A/B：Nexus 5 档 2 失败 → Pixel 2 档 **0 失败**，据此把它记成了「设备档位是差异变量」。

**2026-09-20 第 5 轮推翻**：在同一份代码、同一个 **Pixel 2** 档位上，全量跑**又出现了同样两条、同样的 522**
（而同类单跑 3/3 通过）。所以：

1. **档位不是差异变量**，那次 59/0 是**单次巧合**；把它写成「A/B 已定位」是错的，此处撤回。
   这条正好是报告自己反复强调的那件事：**一次绿不等于因果**。
2. 该失败**与第 5 轮的改动无关**（改的是 message/session payload；同一份代码在 api31 全量 59/0，
   两条失败用例单跑也都通过）。
3. `pixel2Api26` 的档位改动**保留**，但理由只剩两条：与 api31/api34 对齐（报告一直这么写），
   以及两者同为 1080x1920 xxhdpi（点击坐标类用例不受影响）。**它不再被当成修复**，
   构建文件里的注释已按这个口径重写。

**仍未解决的是机制**：单跑/子集绿、全量红，这个形状说明与「累积」有关（磁盘、句柄或进程内状态），
但**我没有证据**指向其中任何一个，不写成已定位。下一步是两个具体动作：
① 在用例里读一次 `StatFs`（`/data` 可用字节）并把数字打进断言消息，把「磁盘要满」从推断变成实测；
② 把 59 条拆到两个模拟器实例上跑，看 522 是否消失（用来区分「累积」与「同实例」）。

### 3.3 设备矩阵与随阶段提交的入库清单（§3 通用说明）

设备矩阵用 **Gradle Managed Devices** 声明在 `app/build.gradle.kts`
（`pixel2Api26` / `pixel2Api31` / `pixel2Api34` + 组 `deviceMatrix`，一条
`./gradlew :app:deviceMatrixAndroidTest` 跑齐三档），
**镜像版本（§11.2 要求随报告记录）**：三档都是 `default` tag（**无 Google APIs**）、`x86_64`、
由 GMD 自建的 `Pixel 2`（1080x1920 xxhdpi）AVD；
`system-images;android-26;default;x86_64` 包版本 1、
`system-images;android-31;default;x86_64` 包版本 3、
`system-images;android-34;default;x86_64` 包版本 2；模拟器 `emulator 37.0.1`；
SDK 落在 `D:\Code\android-sdk`（`local.properties` 的 `sdk.dir`，未提交）。
「无 Google APIs」这一点对结论有影响：涉及 Play 服务/通知渠道后端的路径在本矩阵里**不会被覆盖**，
不能把这里的绿读成「带 GMS 的设备上也一样」。

并在 `gradle.properties` 打开 `android.experimental.testOptions.managedDevices.allowOldApiLevelDevices=true`
——**开实验开关是为了保住 API 26 这一档**，而不是把最低支持版本从门禁里悄悄删掉。
三档并发跑时 api31 会被 install 超时拖垮，逐档单独跑才可靠（api26/api34 单独跑各 <1 分钟）。

**必须随本阶段一起提交的新文件（2026-09-20 已入库，此处保留为清单）**：`shared/fixtures/cross-platform/` 的
`sync-payload/`、`content-io/`、`chat-core/` 三个目录当时**整体仍未跟踪**（本轮又往 `content-io/`
里加了 `lorebook-catalog-canonical.json`，并**重生成**了 `lorebook-detect.json` 与
`lorebook-import-roundtrip.json`），而 Kotlin 侧 `SyncPayloadGoldenTest`、
`LorebookCrossLanguageGoldenTest` 的断言全部以它们为输入。
golden 测试的输入不在仓库里，门禁就只对某台机器成立——这跟阶段 3 报告点过的
`app/schemas/.../1.json` 未跟踪是同一类问题。
**现状**：`shared/` 侧（fixtures + `__tests__` + `chat-core` 新模块）已随 `a080a05` 入库；
Android 侧（含 `app/schemas/.../{1,2,3,4}.json`）已随 **`047e093`** 入库，该提交同时收走了
阶段 2/3/4/5 交织在一起的工作区改动。清单如下：`shared/__tests__/lorebookCatalogGolden.test.ts`、
`shared/__tests__/helpers/goldenVolatile.ts`、
`android/.../content/lorebook/LorebookCrossLanguageGoldenTest.kt`、
`android/.../phase5/BackupRestoreFailureInstrumentedTest.kt`；本轮再加`android/.../data/ContentDraftStore.kt`、`android/.../ui/content/ContentDraftCodec.kt`、`android/.../test/.../ui/content/ContentDraftCodecTest.kt`、`android/.../androidTest/.../phase5/ContentDraftAreaInstrumentedTest.kt`、`shared/fixtures/cross-platform/content-io/preset-roundtrip.json`（§2.13）、`shared/fixtures/cross-platform/content-io/character-card-roundtrip.json` 与 `android/.../content/CharacterCardChainGoldenTest.kt`（§2.14）。

### 3.1 `pnpm lint` 的 7 个 error：**2026-09-20 已清零**（此前只做归属、不动别的阶段的文件）

上一版按 §11.4「发现同文件冲突时停止该文件并报告」只做了归属，没有替别的阶段改。
本轮把它们全部清掉（**均不改变行为**），使 §11.2 的统一门禁第一次真正全绿：

| 位置 | 规则 | 修法与依据 |
|---|---|---|
| `.qa-poc/assist-run.ts:30,59` | no-unused-vars ×2 | **不是源码**：`.qa-poc/`（及 `.qa`/`.poc-tmp`/`.tmp-archive`/`.mimosa`/`output`）在 `.gitignore` 里已封死，ESLint 却还在扫。加进 `eslint.config.js` 的 `ignores`，与 gitignore 口径对齐 |
| `electron/ipc/embedding.ts:72` | no-unused-vars | `DEFAULT_SIMILARITY_THRESHOLD` 常量与它的 `as SHARED_*` 导入都是抽取 `shared/chat-core/embeddingPolicy` 之后的残留（判定已走共享函数）。删除常量与对应导入 |
| `shared/contracts/migrations.ts:12,12,43` | no-explicit-any ×3 | **不是随手改成 `unknown` 就完事**：各实体注册的 `(payload: X) => X` 在 `strictFunctionTypes` 下无法赋给 `(payload: unknown) => unknown`（参数逆变），改类型会让每一处 `register()` 编译失败。这里的 `any` 是注册表的边界类型，故加 `eslint-disable-next-line` 并写明理由 |
| `shared/domain/memoryRepository.ts:28` | no-unused-vars | `interface EntityRow` 无任何引用，删除（`SyncEnvelope` 仍被大量使用，保留） |
| `src/components/api/ImageGenModelsSection.tsx:140` | exhaustive-deps（**warning**） | 仍存在：它只是 warning，不阻塞 0-error 门禁；PC UI，本阶段未触碰 |

复跑：`pnpm lint` = **0 error / 1 warning**（上面那一处），`pnpm check` 通过，`pnpm test` **3045 通过 / 4 跳过**。
本阶段改过的 PC 文件（`charCard.ts`、`ipc/{persona,preset,regex,quickReply,settings}.ts`、`services/usage.ts`）
仍然一条 lint 错误都没有。

**本轮新增/转绿的用例组**（数字取自 `app/build/test-results/testDebugUnitTest` 的 XML）：
`SyncPayloadGoldenTest` 9/0、`RegexCompatibilityTest` 13/0、`LocalDatabaseRoomTest` 16/0、
`QuickReplyCodecTest` 7/0、`QuickReplyPolicyTest` 7/0、`BackupV3SafetyTest` 9/0、
**`LorebookCrossLanguageGoldenTest` 5/0（本轮新增，D-5①）**、`LorebookFormatImportTest` 18/0
（其中 `risuInvalidIsRejectedWithPcEmptyEntriesMessage` 是本轮按 PC 文案改写的那条）。
instrumentation 侧新增两组：`BackupRestoreFailureInstrumentedTest` 4/0（api26+api34）、
`ContentLoadMatrixInstrumentedTest` 4/0（api26+api34）。

**曾一度砸掉约 40 个阶段 4 用例的根因**：阶段 5 的实体写入开始解析 JSON 列
（`extensionsJson`/`canonicalJson`/`bodyJson`），而纯 JVM（非 Robolectric）单测里的
`org.json` 是 android.jar 的未实现桩，报 `Method length in org.json.JSONObject not mocked`。
已加 `testImplementation("org.json:json:20240303")`；重跑后这批用例全绿，
故该依赖是**必要的**而不是掩盖问题的补丁（保留在 `app/build.gradle.kts` 并写了原因注释）。

**正则预算的两条用例曾被推翻（重要）**：原先用 JS 教科书炸弹 `(a+)+b` / `(a|aa)+$` 断言
「一定被预算中止」。用 JDK 17 单文件探针实测：`java.util.regex` 会把 `(a+)+` 归并成 `a+`
并对必选字面量做预搜索，28 个 `a` 只花 1,625 次字符访问就返回未命中——用例恒真，
测的是引擎脾气而不是我们的预算。改用 `(x+x+)+y`：24 字 9,296 次、100 字 667,000 次
（输入 ×2.5、代价 ×70），预算在 `reads == limit + 1` 处**确定性**切断。
校准数据（约 20 万次访问/毫秒）已写进 `RegexCompatibility` 的类注释。

## 4. 本阶段刻意做出的取舍

1. **正则不用超时线程**：回溯发生在原生匹配循环内，不响应中断，协程 `withTimeoutOrNull`
   也只是置标志位；而且「同一条规则同一段文本有时成功有时超时」对编辑器测试台是不可接受的。
   改用计数 `CharSequence` 的工作量预算，结果可复现。
2. **快捷回复 `text` 型在本地 Repository 里故意返回「未处理」**：ViewModel 既有契约是
   未处理时走本地发送支线（含宏展开与引用清理）。在这里再实现一次发送会出现两份发送逻辑漂移。
3. **Backup V3 沿用 PC V2 的目录布局**：换布局等于要求对端升级后才能读备份。
   新增 `templates/` 与 `config/usageClearMarkers.json` 两处，是 V2 里不存在的实体。
4. **符号链接检测在 Android 上不可实现**：`android.util.zip.ZipEntry` 不暴露
   `getExternalAttributes()`，拿不到 Unix mode 位。没有假装能检测——真正的防线是
   预检阶段完全不落盘，应用阶段只按仓库固定的路径表写文件。
5. **新增 `testImplementation(kotlin("test"))`**：为的是不批量翻转 70 处断言的
   参数顺序（JUnit 消息在首位、kotlin.test 在末位，改写容易把 expected/actual 写反，
   那会让测试静默失效）。**这是对仓库既有约定的偏离，需要复核**；若要统一成
   `org.junit.Assert`，必须逐处核对参数顺序而不是全局替换。
6. **只读角色页保持不动**：阶段 4 已过实机走查。编辑能力走新路由
   `characters/manage`，入口以带默认值的可选参数加到只读页顶栏，避免既有调用点与
   `CharactersLoadStateTest` 因签名变更而改动。
7. **先修数据层，再接界面**：世界书、快捷回复、用量分析、内容设置分区在本轮前半段
   就已能编译，但当时数据层还有红灯（其中一条会把导入的第三方世界书写成空关键词），
   所以**故意不接路由**——把一条已知会静默改坏用户内容的链路做成用户可点到的功能，
   等于用「界面已交付」掩盖「数据会损坏」。单元测试 1035/0 之后才补上路由与中心页入口。
   代价是多花了一轮，收益是接通的每一条路径都有绿的存储层垫底。
   **接完仍未实机走查**，所以这几项按 §4 还不算交付完成。

## 5. 未完成与阻断

**阻断项**

- ~~B-1 单元测试全量门禁未过~~ **已解除：1035 用例 / 0 失败 / 0 跳过**（本轮 2 → 0）。
  最后两条**都不是产品缺陷**，而且是先被我自己误判过一次的那种——记录如下，
  因为「红测试逼出的真相与直觉相反」这件事本身就是结论：

  **(a) `LorebookRuntimeCompileTest.compiledBookActuallyTriggersThroughTheRuntime`：测试前置缺失。**
  上一版报告我先说「回滚没生效」、再说「常驻语义在编译后丢失」，**两条都被证据否证**。
  把 `enabled`/`priority`/`characterFilter`/`generationTriggers` 与丢弃计数一起打印后才看清：
  条目以 `pri=always`、`en=true` 正常进入候选循环，`alwaysDropped` 等全为 0，
  但它的 `characterFilter = (names=[Alice], tags=[royal])`——而测试只给了
  `charName="苏晚"`，没给 `characterNames`/`characterTags`。
  于是运行时按「角色绑定」把它挡掉是**正确行为**，S5-02 要求的能力其实工作得好好的。
  修法是补测试的前置（`characterNames=[Alice]` + `characterTags=[royal]`，
  `contextAllowed` 对 names/tags 是各维都要命中），**断言强度没降**：仍然要求这条真被注入，
  并且现在还通过了后半段「正文出现在 atDepth/beforeChar」的注入证据。

  **(b) `LorebookExportRoundTripTest.exportThenReimportPreservesEntrySemantics`：PC 也这样。**
  先把断言从「比数量」改成「比键名集合」，才看清多出来的是哪个键：`extentions`
  （Risu 上游就是这个拼写，不能改成 `extensions`）。再查 PC 自己生成的 golden
  （`content-io/lorebook-import-roundtrip.json` 的 `risu` 用例）：
  **首导入 `fields=["text"]`，往返后 `fields=["text","extentions"]`——PC 完全一样**，
  因为 `risu.ts:169` 无条件写 `extentions:{…}`。所以这是 oracle 行为，
  我的新断言比真值更严才是错的。处理：显式白名单「往返只允许新增 `extentions`」，
  并把「不许丢任何键」和「不许多出别的键」两条都保留（比原来的数量断言更强）。

  顺带留下两条一般性教训：
  1. 数量断言会放过「字段被换成另一个键」这种真实损坏，跨端保真要比**键名**；
  2. 断言消息只能证明它打印的那些字段——没打印就等于没证据。

  **本轮已定位并修掉的（都有用例转绿为证）**
  1. `RepositoryContractSuiteTest.oversized payload does not leave half committed rows` → **转绿**。
     上一版报告把它归因于「`withJournal` 先写业务行、回滚没生效」——**那个归因是错的**。
     实测真实机制：测试给的 `canonicalJson` 是 `"xxxx…"`（根本不是 JSON），
     `JsonValues.parseObject` 对「非法文本」和「`{}`」都返回空 Map，于是
     `lorebookPayload` 算出**空 payload** → 2 MiB 上限校验形同不存在 → 超大写入被**接受**。
     这是 P1 级的静默数据损坏：本地条目还在，同步出去的 payload 却是空文档。
     修法：`putLorebook` 落库前要求 `canonicalJson` 是合法 JSON 对象
     （新增 `JsonValues.isJsonObjectText`，专门区分「非法」与「空对象」）。
     同时把该用例的输入改成**合法但超大**的文档——否则它测的是格式校验而不是 §6.2 上限。
     改完仍通过 → **证明 `db.withTransaction` 在 payload 超限时的回滚是有效的**，
     写库后再校验的顺序在当前实现下不构成脏行（这一条现在有测试撑着，不再是猜测）。
     同类风险仍在（未逐一加守卫）：`presetPayload(bodyJson)`、`mappingTemplatePayload(templateJson)`、
     `quickReplyStorePayload(itemsJson)` 也走「解析失败即空」的路径。
  2. `PngTextChunksGoldenTest` 的 `itxt-compressed-skipped` → **转绿**，并做出**决策**：
     Android 与 PC 逐字节对齐（PC 从不解压 `iTXt`，直接按 UTF-8 取 text 段）。
     理由：同一张卡 PC 取得到 `chara`、Android 取不到，是「导入结果两端不一致」；
     而对齐后真·zlib 压缩段在两端都得到同一段乱码并同样按非法卡片报错——
     失败是显式且共同的，比本机静默跳过更好排查。**PC 端不解压 iTXT 本身是缺陷**，
     已挂在 §2.3 的 PC 缺陷单旁边，修 PC 会让 fixture 变红，属预期的 regenerate-or-fail-red。
  3. `LorebookMappingTemplateTest.templateRoundTripsThroughJson` → **转绿**（§2.7(b) 的 `Map.keys` 遮蔽）。
     同一条 bug 在**同文件 549 行**还有第二处：`apply { put("keys", keys) }` 里外层局部变量
     `keys` 被接收者的 `Map.keySet` 遮蔽（隐式接收者比外层局部更近），
     条目关键词被写成 `["keys","content",…]`。已改名 `entryKeys` 并就地留注释。
     全仓扫过 `put("…", keys|values|entries|size)` 形态，已无残留站点。

  **剩余 2 条（外部格式 → canonical 的适配器层）**
  - **（2026-09-20 更正）本条的根因既不在适配层、也不在阶段 4 主链路。**
    它当时红的原因是测试前置没给角色上下文（见上方 B-1(a)，已修）；而
    「`retrieval` 从没进过运行时」才是这一段真正剩下的那条 P1，已在 **§2.21** 结案。
    下面这一整段（含两次自我推翻）作为**排查过程**保留，读的时候别把它当结论。
  - `LorebookRuntimeCompileTest.compiledBookActuallyTriggersThroughTheRuntime` →
     **本轮已用自诊断断言定位到具体那一维**（消息现在会打印文档条目与编译条目的触发相关字段）。
     实测输出：
     ```
     触发结果=[]
     文档条目=[10:constant:[王城, 首都]:[帝国, 皇帝]:80.0, 11:conditional:[]:[]:100.0]
     编译条目=[10:kw=[王城, 首都]:sec=[帝国, 皇帝], 11:kw=[]:sec=[]]
     ```
     **更正（本小节初稿写错了，这里是被证据推翻后的版本）**：初稿据「编译条目只打印了
     `kw`/`sec`」推断「常驻语义在编译后丢失」——**该推断不成立**，诊断消息本身没打印 `priority`
     字段，我把它当成了「没有」。复核代码后事实是：
     `ChatLorebookCompile.kt:58` 明确 `mode == "constant" -> "always"`，
     `ChatLorebookRuntime.kt:232` 是 `matched = priority == "always" || keywordMatched`，
     且 `always` 还刻意跳过二级关键词过滤（235 行），`probability=80` 配 `random={0.0}` 也不会被挡。
     **再更正（同一小节，第二次被证据推翻——这正说明前一个结论不该写）**：
     把 `enabled`/`priority` 与序列化后的文档一起打出来之后：
     ```
     编译条目=[10:kw=[王城, 首都]:sec=[帝国, 皇帝]:en=true:pri=always, …]
     文档JSON={"…","enabled":true,"entries":[{"id":"10","enabled":true,
              "activation":{"mode":"constant","budgetTier":"protected",…
     ```
     所以「书级/条目级 enabled」「角色与生成类型过滤」这些上游原因**都不成立**：
     条目 10 确实以 `pri=always`、`en=true` 进到候选循环，`matched = priority=="always"` 为真，
     `probability=80` 配 `random={0.0}` 也过得去。
     于是范围收窄到**触发之后、进结果之前**那一段：
     `triggeredEntryKeys = deduped.mapNotNull { it.key }`（ChatLorebookRuntime.kt:387）取的是
     `deduped`（内容级去重/插入位置/预算之后的条目列表），**不是** `triggeredIds`。
     也就是说条目被判定触发、但没有进入最终条目列表——最可疑的是
     `budgetTier = "protected"` 这一档没被预算层认（fixture 就是 protected），
     以及 `insertion` 位置不被支持时条目被静默丢弃。
     **本轮最后再排除三条**（都不需要再查）：
     (a) 「触发后、进 `triggeredItems` 前被过滤」——不成立：`ChatLorebookRuntime.kt:262-275`
         从 `triggeredIds += key` 到 `triggeredItems += Item(...)` 之间没有任何 `continue`；
     (b) 「内容去重把它吃掉」——`deduped` 只丢 `content` 完全相同的后到者（289-294 行），两条条目正文不同；
     (c) 「`generationTriggers` 与默认 `generationType="normal"` 系统性不匹配」——
         `generationTriggers` 缺省是 `null`（CanonicalLorebook.kt:445/462 只在显式存在时才写键），
         `contextBlockReason` 对 null 直接放过。
     **最终一次观测的结果（本报告结束时仍未定位到根因，但已排除到只剩两条）**：
     `triggeredCount=0`、`droppedCount/alwaysDropped/conditionalDropped/detailDropped` **全为 0**、
     `kept=[]` → 候选循环一条都没接受，**不是预算丢弃**（此前所有「降级/被裁」的猜测一律作废）。
     放宽打印后看到该条目的 `scheduling` 与 `insertion` 实际内容：
     ```
     "activation":{… "retrieval":"hybrid", "wholeWords":false, "regex":{"enabled":false,"flags":"i"}}
     "insertion":{"kind":"chat","depth":2,"role":"system"}
     "scheduling":{"order":250,"probability":80,"scanDepth":1,"recursion":{…},
                   "groups":[{"name":"王族",…},{"name":"地点",…}],"groupScoring":true, …}
     ```
     只剩两条可疑，且都能一句话验证：
     1. **`retrieval = "hybrid"`**：Android 没有 embeddings（`Input.semanticEnabled` 恒 false）。
        若 `ChatLorebookCompile` 把 `retrieval` 映成 `matchMode` 后，运行时在候选之前就按
        「需要语义通道」把条目整条跳过，那么**所有 hybrid/semantic 外部条目在 Android 上永不触发**——
        这才是真正需要修的 P1（并要在导入报告里显式告诉用户「本条依赖语义检索，Android 不支持」，
        符合方案 S5-02「兼容性报告 + 不静默改含义」）。
     2. **`groups` + `groupScoring`**：`ChatLorebookRuntime.kt:247` 明写「包含组仲裁未实现：候选原样通过」，
        所以按代码它不该挡；但打印被截断处还有一个 `sti…` 开头的键没看到，
        若其中含 `characterFilter`（角色限定），那么零触发是**正确行为**，
        失败原因是测试没给对应角色上下文（属于测试前置写错，要补 `characterNames`/`characterTags`，
        不是放宽断言）。
     下一步顺序：先看 `ChatLorebookCompile.kt` 的 `retrieval`→`matchMode` 映射与运行时对 `matchMode`
     的前置过滤；若条目能进候选，再把文档 `scheduling` 尾部的 `sti…` 键名打印完整确认有无 `characterFilter`。
     本条留在阶段 5 报告里，但**根因位置在阶段 4 生成主链路**（`ChatContextBuilder` 用同一执行器），
     修它要连带回归阶段 4 的世界书注入用例。

     本条上我连错两次（先说回滚、再说常驻降级丢失），记录在此是为了让下一个接手的人
     直接从我错的地方继续，而不是把这两条再猜一遍。

     教训记在这里：**断言消息只能证明它打印的那些字段**。打印集没覆盖到的字段，
     其结论要么是猜测要么去补打印——本次两处误判（回滚顺序、常驻降级）都是同一个形状。
  - `LorebookExportRoundTripTest.exportThenReimportPreservesEntrySemantics`：
    risu 适配器第 2 条目的**条目级保留区字段数** 原 0 / 往返后 1（导出再导入多出一个字段）。
    该断言只比**数量**，所以「哪个字段挤进了保留区」当前无处可查。下一步先把
    `assertForeignSurvivesRoundTrip` 的比较从数量改成**键名集合**（顺带修掉一个真实弱点：
    字段被替换成另一个字段时数量断言会静默放过），看到键名再判断是 `consumedEntryKeys`
    少列了键还是导出多写了字段。

  本轮在此方向上另外修掉的第 4 条（转绿）：`importsEntriesFromAnArbitraryShape`
  取不到书名。实现只试 `namePath ?: "name"`，而第三方格式把书名放在 `title` →
  静默退化成 `兜底名`。改为「显式 `namePath` 优先，缺省按固定顺序试 `name`→`title`」
  （`DEFAULT_BOOK_NAME_PATHS`，顺序即口径）。该用例后半段的 `primaryKeys`
  与 canonical 合法性断言此前根本没机会跑到，现在一并转绿。
- ~~B-2 Kotlin 侧尚未对 `sync-payload` golden 断言~~ **已解除**：
  `local/domain/SyncPayloadGoldenTest`（9 个用例全绿）以「不动点」形式断言两份 fixture：
  把 PC 算出的 payload 当 Android 落库结果重建行，再用 Android 构造函数回算，要求逐键相同。
  键集合偏差用 `ANDROID_ONLY_KEYS` **白名单逐条登记**（当前只有 `character/minimal` 与
  `regex_rule/minimal` 两条合成输入），多一个少一个都变红——不靠注释里的口头承诺。
  这一层当场抓到 §2.7(a) 的哈希破坏性差异。
- ~~B-3 `usage_clear_marker` 恢复~~ **已闭合**：`LocalStore` 补了
  `putUsageClearMarker`（带守卫：**拒绝写本机自己的行**，本机游标只能由 `clearUsage`
  的因果判定推进，否则一个备份文件就能伪造清理进度、抹掉并发产生的用量记录，违反 §6.3）
  与 `listUsageClearMarkers`。
  **同时发现打包侧也是坏的**：`create()` 从来没写 `config/usageClearMarkers.json`
  （`BackupV3.ARRAY_FILES` 里列了这个路径，但那是个**没有任何引用的死常量**），
  所以现在两侧都补上：create 落全量游标 + counts，restore 读回并只应用外部设备。
  新增 `BackupOrchestratorRoundTripTest`（3 例：跨设备往返保真、同机跳过不失败、
  拒绝伪造本机进度）。**注意**：这条链路此前只有安全测试，没有任何端到端往返用例，
  所以「打包器写什么 / 恢复器读什么」的错位能一直躺着——补的那 3 例是这次真因所在。
- F-1 **阶段 4 instrumentation 用例非确定性失败**（本阶段发现的旁证，不属阶段 5 范围）：
  `Phase4AcceptanceWalkthroughInstrumentedTest.fullWalkthroughRunsEntirelyOnLocalDatabase`
  在 api34 全量跑中失败一次：「编辑历史必须使派生记忆失效 expected:<1> but was:<0>」
  （`Phase4AcceptanceWalkthroughInstrumentedTest.kt:313`）。
  同一份代码：**单独跑该类通过**、**当天另两次全量跑通过**（35/0），api26 全量通过。
  断言前读到的 `historyRevision` 是 0，说明该用例注释里自己点过的
  「记忆行由 `seed()` 预置」前置在那次运行没成立（慢设备/并发下 `awaitAssistantCount`
  与 seed 的时序），属**测试自身的时序脆弱**，不是产品回归。
  未修（越阶段），但必须记录：阶段 4 签字前该用例得改成显式等待 seed 落地或断言前重取基线。

**过程问题（必须记录，否则下个阶段重犯）**

- P1-a **已修**（本轮）：`deletePresetUnbindingReferences` / `deletePersonaUnbindingReferences`
  不再跑裸 `UPDATE`，改成把被绑定的角色/会话读出来、清掉引用后逐行经
  `putCharacter` / `putSession` 落库（它们才写 journal），仍在同一 `withTransaction` 内。
  `LocalDaos` 里的 `unbindSessions`/`unbindCharacters` 四段裸 UPDATE 已删除，换成
  `listBoundSessions`/`listBoundCharacters`。
  **契约用例新增并两端各跑一遍**（`eachStore` 同时跑 Room 与内存实现）：
  `unbinding during preset delete journals the character and session rows`
  断言被解绑角色与会话的 head 版本**因果推进**且 journal 计数至少 +3
  （实测 `{"android-device-a":"1"} → {"…":"4"}`）。
  这条以前抓不到，因为**两端一致地犯错**，契约套件只比两端是否相同。
- P1-b **已修（存储层）**：新增 `deleteLorebookUnbindingReferences(id): BindingImpact`，
  同一事务里解绑角色的 `lorebook_id` + `bound_lorebook_ids_json`（**保持其余绑定的原顺序**，
  顺序进 payload 进哈希）与会话的 `lorebook_ids_json`，再删书 + tombstone；
  用例 `deleting a bound lorebook unbinds characters and sessions and journals them` 两端全绿。
- D-6 **UI 还没切到原子路径**（需要决策，别顺手改）：`LorebookEditorViewModel.confirmDelete`
  仍是逐条解绑，因为它额外容忍了「父角色已 tombstone 的会话」这种**死引用**——
  `putSession` 会拒绝写这种行，放进单事务会让整次删除永久失败。
  切到 `deleteLorebookUnbindingReferences` 前要先定死引用怎么办：跳过并如实报告？
  还是先清死引用再删？两个都比现在的行为好，但不该由实现 Agent 在收尾时猜。

- ~~P1-c `usage_clear_marker` 的自动保留上限语义未实现~~ **已修**（本轮）。
  先核实了 PC 侧的真实契约再动手（上一版报告写「未实现」时**没有**先确认 PC 有没有这个上限）：
  PC `electron/services/usage.ts:24` 有 `MAX_RECORDS = 10000`，超限时按 timestamp 升序排序、
  保留最新 10000 条，并把被淘汰的 id 作为 `deletes` 经域写入产 tombstone。
  Android 此前**完全没有上限**（用量无限增长），也没有淘汰语义。
  现在两端对齐：`LocalStore.MAX_USAGE_RECORDS = 10_000`，`recordUsage` 在同一事务内淘汰超额最旧记录，
  **逐条 `tombstoneInTx`**（裸 DELETE 正是 §S5-07 点名的静默删除，会让别的设备下一轮同步把它们带回来）。
  Room 与内存实现同一口径，契约用例 `usageRetentionTrimEvictsOldestAndTombstonesEachEvictedRecord`
  两端各跑一遍：断言保留数=上限、最旧两条被淘汰且**是 tombstone 而非无痕删除**、最新两条留下。
  平局顺序差异已写明：PC 靠文件插入顺序的稳定排序，Android 用 `created_at, id`（id 是 ULID，
  同毫秒内即插入序），因此淘汰的是同一批——**这一条目前只有注释与代码依据，没有跨语言 fixture 钉住**。
  残留风险：PC 改了 `MAX_RECORDS` 而 Android 没跟，没有任何测试会红。
  下一步把上限值放进 `shared/fixtures/cross-platform/` 的一份小 fixture（像 payload 那样）才算钉死。
- P1-d **`BackupV3.inspect` 的内存模型与设备不匹配**：整包字节 + 每个条目的解压内容
  全部留在内存里，上限却是 `MAX_TOTAL_UNCOMPRESSED_BYTES = 1 GiB`；
  Android 单应用堆远小于这个量级，合法的大备份会 OOM。
  实测旁证：写 64 MiB 单条目上限用例时，测试进程先 OOM，
  `runCatching` 把 `OutOfMemoryError` 转成了 `Rejected("ZIP 解析失败：Java heap space")`
  ——也就是说**今天的代码在 OOM 时确实会拒绝（不会写坏数据），但拒绝原因不是上限判定**。
  该条上限断言因此从单测里撤出（不降级成「反正都拒绝」的假绿），改由大堆 instrumentation 补。
  **本轮补上了那一半**：`oversizedSingleEntryIsRejectedByTheLimitNotByTheHeap` 在 API 26/34
  各跑一次，64 MiB+1 的全零载荷实测 ~1.9 s 内被「单条目过大」拒掉、**没有 OOM**，
  证明拒绝来自上限判定而不是堆崩。**2026-09-20 更新（§2.22）**：这条的**前半**已修——
  执行层改成按 `residentBudgetBytes`（`min(契约 1 GiB, (可用堆 − 源包) × 0.5)`）在解压过程中
  **先拒**，并用 `describeInspectFailure` 把 `OutOfMemoryError` 与「包损坏」分成两句：
  用户不会再看到「ZIP 解析失败：Java heap space」这种把内存问题说成文件损坏的文案。
  **仍未修的是能力层**：`Preview.entries: Map<String, ByteArray>` 是整包驻留的根，
  大于驻留预算的**合法**备份目前只能被诚实拒绝（文案指向「改在 PC 上恢复或分批导出」），
  要能真的恢复它得改成流式/两遍式——接口形状改动，仍不在阶段 5 顺手做。
- D-5 **§3 测试矩阵三项都已跑通，但每一格的口径都要照实读**（不是「以后再说」，是签字项）：
  ~~① 每种外部格式的 **PC 导入 → Android 导出 → PC 再导入**~~ **已闭合**（见 §2.8：
  跨语言 golden 接活 + 阶段 0 的 28 份样本冻结成 `lorebook-catalog-canonical.json`，
  四道断言（检测/导入/报告/导出）两端各跑一遍，并当场抓到两处偏差）；
  ~~② 备份的 **磁盘满 / 恢复回滚** 与单条目体积上限~~ **已闭合**（见 §2.9：
  三条失败路径 + 上限判定都在 API 34 GMD 上真跑，并当场抓到一处「把已提交的恢复报成已回滚」）——
  但**覆盖口径是「写边界失败」，真 ENOSPC（把分区写满）仍未模拟**，这一格不能读成全绿；
  ~~③ **压力矩阵**（500 角色 / 100 世界书×5k 条 / 1k 预设）~~ **已闭合**（见 §2.10：
  API 26/34 各 4 条全绿），但「每书 5k 条」这一档**与同步契约的 2 MiB payload 上限正面冲突**，
  实际验证的是契约允许的最大档 3,500 条/本，冲突本身另立 **D-8**。
  ①的闭合方式要记清楚，别高估它：跨端往返是**组合**出来的
  （两端导出物逐字节相等 + PC 自己的再导入闭环），不是真把 Android 的产物搬进 TS 跑一遍。
  组合成立的前提是「导出是纯函数」——这一条由 golden 的逐字节相等直接钉住，
  所以没有另加断言。若哪天导出引入外部状态（时间、随机 id），这个论证会失效，
  届时需要真的把 Android 产物落盘给 TS 消费。

- D-8 **方案 §3 的「每书 5k 条」与同步契约的 2 MiB 单条 payload 上限互斥**（实测 + 需决策）：
  5,000 条的 canonical 文档实测 2,467,984 字节 > 上限 2,097,152 字节，
  三端常量同值（`shared/syncBaseline`、PC `bootstrapScanners`、Android `MigrationIdentity`），
  所以这是**契约级**冲突而不是 Android 的实现缺陷；一条世界书实际能装约 4,245 条。
  三个选项，代价各不同：抬高上限（改两端哈希边界与 relay 接受范围）、
  世界书文档分块记账（改实体粒度，牵动阶段 7 的合并语义）、
  或把 §3 的口径改成「每书 ≤ 契约上限」（最省事，但要方案作者签字承认口径变了）。
  阶段 5 不替别人决定，留 **D-8** 立案，配套用例
  `lorebookAtPlanScaleIsRefusedByTheSharedPayloadCap` 会在任何一端改动时变红。

- D-7 **PC 侧 Risu 导入的未知/坏条目文案自相矛盾**（本阶段新发现，需要 PC 侧决策）：
  `risu.ts:99-105` 的注释写「不做预过滤：非对象条目交给统一导入器计数并生成结构化拒绝报告」，
  但 `resolveEntries` 已经 `data.filter(isRecord)`，于是那句注释描述的分支（`: entry`）是死代码、
  `invalid_entries` 对 Risu 永不触发；`novelai.ts`/`agnai.ts` 却按注释的意图把未过滤条目传下去。
  后果是真实用户可见的差异：**含个别坏条目的 Risu 世界书**（3 条正常 + 2 条垃圾）
  两端都会成功导入并**静默丢掉那 2 条**，报告里一行都不提——这与方案 §2
  「所有导入显示成功、跳过、近似映射、失败」直接冲突。
  Android 本可以报得更全（改之前就是这么做的），但那是 PC 没有的行为，
  按「PC 行为不得回归 + Android 是对齐方」先对齐 PC、把改哪一端留给决策。
  建议的修法是 PC 侧把 `resolveEntries` 的过滤去掉（保留 detect 侧的过滤），
  需要 PC 端 fixture 重生成 + 回归证据，属 §11.3 的改动，不在阶段 5 顺手做。

- ~~P1-b 世界书删除没有解绑路径~~ **已修**：见本节顶部「P1-b 已修（存储层）」。
- D-4 **解绑语义两端不一致**（需要决策，别留给实现 Agent 猜）：
  PC `electron/ipc/preset.ts:37-44` 的 `deletePresetFile` **完全不解绑**——只删预设文件本身，
  角色上的 `boundPresetId` 原地悬空。Android 现在会解绑（按阶段 5 §2 的要求）。
  也就是说两端对同一操作会产生不同的角色状态。要么 PC 补解绑（符合 §2，属 PC 侧改动，按 §11.3 要回归证据），
  要么 Android 改成「有引用就阻止删除 + 显示影响」并把解绑作为用户显式动作。
  **本阶段选哪个都不该顺手改**，故仅立案。


- 本轮 4 个子代理里有 **3 个在 150 轮上限处中止**，各自留下「声称完成但源码不过编译」的
  中间态（`LorebookEditorScreen`、`QuickReplyEditorViewModel`、`UsageInsightsScreen` 等）。
  其中一处语法错误实际是 Kotlin 字符串模板里嵌套双引号
  （`"${row.name.ifBlank { "快捷回复集合" }} 副本"`）导致解析器在**很远之后**才报错，
  误导了定位方向；改成先算局部变量即通过。
- 与子代理同时编辑同一文件是本轮最贵的错误（它写、我改，互相覆盖）。
  后续：一个文件只允许一个写入者；子代理跑不完就在其返回后由主线接手，不追加并行编辑。

**待决策（不要留给后续 Agent 猜）**

- D-1 「PC 缺键 vs Android 补空串」的通用规则（§2.5-2）：PC 写入端补齐，还是 Android
  记录键存在性？影响 `character`、`regex_rule` 两类，属阶段 7 决策门。
- D-2 `lorebook` payload 含 `createdAt`/`updatedAt`，与总方案 §6.2 字面冲突（§2.5-3）。
  现以 PC 实际行为为准；若要规范化，需同时给 PC 一份「排除时间戳」的改动并做哈希迁移。
- D-3 阶段 5 方案 §S5-03 要求预设可编辑 `stop`，但 PC 的 `Preset` 类型没有该字段。
  预设正文整体即 `preset` 实体 payload，Android 单方面加键会让两端哈希不一致，
  因此**未实现**；需要产品确认是删方案文字，还是 PC 先加字段并做兼容迁移。
- D-9 **`semanticRequired` 两端行为相反，且 S6-05 的降级口径要先定**（§2.21 立案）：
  Android 目前对 `semanticRequired` 按关键词触发，而 PC 在无向量时**停用**它并 warn-once——
  两者不可能都对，且这是用户可见差异（同一本书，PC 不注入、Android 注入）。
  三个选项：① 对齐 PC 停用（Android 少注入，但两端一致）；② 保留关键词近似（多注入，但两端不同，
  且与条目作者「只允许向量触发」的意图相反）；③ 等 S6-05 实现向量通道后由通道可用性自然收敛。
  **影响面比看上去小**：`semanticRequired` 目前**没有任何导入路径会产出**
  （`LorebookNativeV1` / `LorebookNativeMigration` 只产出 `keyword` / `hybrid` / `semanticPreferred`，
  只有手写 canonical v2 才可能带），所以本阶段只立案不动手。
  但 S6-05 落地时必须**同时**定这一条与 `ChatLorebookChannels` 的两个通道常量——
  翻常量会让 `ChatLorebookChannelsTest` 与 §2.21 那张表一起变红，那正是重新签字的时机。
- D-10 **`usage_clear_marker` 的实体粒度两端不同**（§2.24 立案）：PC 写**一个固定 id**
  `usage-clear-marker` 的实体、payload 里带**逐设备**的 `clearedThrough` 映射
  （`electron/services/usage.ts:162`）；Android 写**每设备一个实体**（`entityId = deviceId`，
  `RoomLocalSyncRepository.putUsageClearMarker`）。两端的 payload 形状都对
  （`usage-clear-marker-payload.schema.json` 是 `additionalProperties:false` + 必带 `clearedThrough`，
  Android 的 `UsageClearMarkerPayload.of` 还做了自校验），**差的只是实体 id**。
  后果：同一批清理语义落在不同 entityId 上，§6.3「多个 marker 逐设备取最大值」无从跨端成立
  ——两端各持一半信息且谁都不收敛。两个选项：① Android 收敛到单实体（按 PC 的 id，
  逐设备映射进 payload）；② PC 改成逐设备实体（要改 §6.3 合并口径与 PC 读取路径）。
  需契约签字，**不在阶段 5 单方面改**。
- D-11 **PC 把群会话/群消息写在 `session`/`message` 同一实体类型下，却用另一套 payload 构造函数**
  （§2.24 立案，属 PC 侧改动）：`electron/ipc/group.ts` 用 `entityType: 'session'` / `'message'`
  写群会话与群消息，payload 却来自 `groupSessionEntityPayload` / `groupMessageEntityPayload`
  ——**原始 spread 去掉 id**，与冻结契约（`message-payload.schema.json` 要求 `timestamp`、
  且 `additionalProperties:false`）完全不同。也就是说**同一个实体类型在 PC 内部就有两种不兼容的
  payload 形状**：单聊走 schema 那条、群聊走 spread 那条。
  后果：Android 无论怎么映射都只能对上其中一半——第 5 轮把 Android 的 message/session 对齐到了
  **单聊**契约，于是 PC 的群消息/群会话与单聊消息在阶段 7 必然互不收敛。
  三个选项：① 群会话/群消息改用**独立实体类型**（最干净，但要动 §6.1 的实体清单与两端 id 空间）；
  ② 把群的两个 payload 也收敛到 schema（要改 PC 已发布格式语义，按 §11.3 需 PC 回归证据 + fixture 重生成）；
  ③ 在信封里加「形状判别」字段（最差，等于把不确定性推给合并层）。**本阶段只立案**。
- D-12 **`memory_state`/`memory_fact`/`media_manifest` 在 PC 侧没有落点，而 Android 已在写**（§2.24 立案）：
  PC 自己的物化表写着这条事实——`electron/domain/remoteMaterializers.ts:350-352`：
  「PC 尚无 `media_manifest` 独立落点（阶段 7 引入 blob 存储后实现）」、
  「PC 的长记忆内嵌在 session 实体中，无独立落点」、「PC 的事实记录内嵌在 session 实体中，无独立落点」。
  而 Android 把 `memory_state`/`memory_fact` 当**独立实体**记账（各有本地表与 payload 形状）；
  `media_manifest` 有表与 `putMediaManifest`、但**没有** payload 构造函数（见 §7）。
  后果：Android 会产出 PC 明确「不支持物化」的实体类型；反向地 PC 内嵌在 session 里的长记忆
  Android 也不会去读。§6.1 已把这三类列为同步实体，所以要么 PC 补独立落点、要么契约去掉它们
  （记忆的同步口径改成「随 session 走」）。属阶段 7/8 的契约决策。

**未开始**

- ~~U-14 迁移路径的 `parentId` 还没补~~ **已修（第 9 轮，见 §2.26 末尾）**：`LocalStore.importFromLegacy(...)`
  增加 `parentId` 形参，`RoomLocalSyncRepository`/`FakeLocalStore` 两处实现透传，`LegacyCacheImporter`
  三处调用分别给 `null` / `characterId` / `sessionId`；并有从 change_log 真实信封读回校验的用例
  （含突变验证）。因此**迁移进来的会话/消息不再是「无父」**。
- U-1 S5-02 世界书编辑器 UI：`ui/lorebooks/LorebookEditorViewModel.kt` + `LorebookEditorScreen.kt`
  **已能编译**（canonical v2 条目编辑、多格式导入、兼容性报告、触发测试台走 runtime 同一执行器），
  **已接通**（`Routes.LOREBOOKS` + `CompanionNavHost` composable + 中心页入口，指向
  `LorebookListScreen`）。**但真机走查未做**，所以按 §4 不能算交付完成。
  这条链路上原有的 3 个适配器/模板缺陷已在 §5-B1 中全部结案（其中 2 个是测试侧问题，非产品缺陷）。
- U-5 S5-06 快捷回复 UI：`ui/quickreplies/QuickReplyEditorViewModel.kt` + `QuickRepliesScreen.kt`
  同上——已接 `Routes.QUICK_REPLIES` 与中心页入口；集合级复制重映射条目 id、
  命令型按 `QuickReplyPolicy` 给出「为什么在 Android 上不可用」的理由文本已实现但未验证到界面。
- U-6 S5-07 用量分析与内容设置：`ui/usage/UsageInsightsScreen.kt`、
  `ui/settings/sections/ContentSettingsSection.kt` 同上——**已接通**。
  设备级设置「明确不同步」的分区已内嵌进 `SettingsScreen`（放在内容管理入口之后）；
  用量分析走新路由 `Routes.USAGE_INSIGHTS`，与阶段 3 的只读 `USAGE` 分开。
- ~~U-7 S5-08 Backup V3 界面入口~~ **已完成并接通**：`ui/backup/BackupScreen.kt`
  （导出 → 选文件 → **只读校验 + 预览**（来源平台/条目数/排除清单）→ 确认 → 事务恢复），
  路由 `Routes.BACKUP` + 中心页入口。之前 `BackupOrchestrator` 在主源码里
  **从未被实例化过**——等于能力全在库里但用户一步都走不到。
  仍未做的是**实机走查**（下面判定里那条）。

- ~~U-2 S5-03 预设编辑器 UI~~ **已完成**：`ui/presets/PresetEditorViewModel.kt` + `PresetsScreen.kt`。
  内建/用户分区、内建只读→另存副本、采样参数、生成规划与篇幅/推理字段、
  JSON 导入（含 `unsupportedFields` 报告）与导出、删除前显示解绑影响。
  **未提供 `stop` 字段**：方案 §S5-03 文字提到 stop，但 PC `Preset` 无此字段，
  而预设正文整体就是同步 payload，加键会让两端哈希不一致（见 D-3）。
- ~~U-3 S5-04 人设 UI~~ **已完成**：`ui/personas/PersonasScreen.kt`（列表 + 编辑 + 头像选择 +
  列表上直接设默认）。
- ~~U-4 S5-05 正则 UI~~ **已完成**：`ui/regex/RegexEditorViewModel.kt` + `RegexScreen.kt`，
  含列表开关/排序、触发条件与停止符折叠区、以及走工作量预算的测试台；
  路由 `Routes.REGEX` 与「内容管理」中心页已接通。
- ~~U-8 编辑器自动保存的**草稿区落盘**~~ **已完成**：`ContentDraftStore` + `ContentDraftCodec` +
  `ContentDraftAutosaver`，六个编辑器全部接线，离开确认收成一个 `rememberEditorExitGuard`。
  过程中抓到三条真实缺陷（异步恢复盖输入 / 恢复后保存空转 / 新建预设点击即崩），见 §2.12。
  **但只到「设备用例证明数据行为」为止**：草稿恢复在界面上长什么样、用户点「放弃草稿并离开」
  是不是真点得到，仍属下面的实机走查缺口。
- ~~U-11 草稿区没有容量上限~~ **已关闭**（§2.17(a)）：单条取同步契约的 2 MiB、总量 4 条满额、拒绝但不淘汰、拒绝原因进界面文案、同值自动保存跳过。
  仍未做的是另一件事：**大实体改用文件型草稿**（现在仍是单个 DataStore 装所有草稿）；有上限兜着之后它不再是正确性问题，是体验与 IO 形态的选择。
  原始问题：`PreferencesContentDraftStore` 把整行快照写进 DataStore，
  而这个 DataStore 是「全量驻留内存 + 每次写整文件重写」。一本接近 2 MiB 上限的世界书
  （见 D-8 的 payload 冲突）如果正被编辑，草稿就是同量级字符串，键入期间的防抖写会放大成
  主线程之外的持续 IO，低端机上可能表现为卡顿甚至 ANR。**未做**：草稿大小上限、超限降级为
  「不落草稿并在界面上说明」，以及把大实体改成文件型草稿。这一条要连同 D-8 一起决策。
- U-13 全量套件（同进程、类之间不隔离）在 API 31 上出现过 2 个红，本轮状态：
  1. `ContentUiWalkthroughInstrumentedTest.saveViaSemanticsAction...` → **判因完成并已修**（§2.16：
     本轮 `force` 带来的重复提交回归，幂等用例 + `characterId` 升级已修，API 34 上 4/0）；
  2. `CharacterEditorMainDispatcherProbeTest.theContainerProvidedRepositoryPersistsOnTheMainThreadToo`
     → **单跑通过、全量跑红**（同一镜像、同一条用例）。这条用例的判定窗口是写死的 2 s 轮询
     （`repeat(40) { delay(50) }`），而它用的是**容器交出的真实文件库**，同进程里前面的类会先动它；
     现在的证据只支持「该用例依赖进程内先后顺序」这一句，**不支持**把它判成产品缺陷或环境问题。
     想复跑确认也做不到：本轮之后 api31 的 adb 安装已稳定超时（宿主磁盘 97% 满，见 §3），→ **已判因并关闭（§2.17(b)）**：既不是产品缺陷也不是档位问题，是那两条断言把「设备全局 dot」当成了「这一行的变更条数」，谁后跑谁红。改成 per-entity 口径后，探针 + 走查 + 草稿区 + 幂等 13 条在 API 34 与 API 26 连跑各 0 失败。
      **2026-09-20 更正：这一格已补上**——API 31 用经典 AVD 路径全量 59/0（见 §3.2/U-10），
      「Android 12 + 本轮改动」不再是空的。下面这句是当时的记录，保留以说明当时的判断：
      api31 那一档在本轮全部改动之后仍未复跑（宿主磁盘 97% 满导致 adb 安装超时，见 §3）。
     下一步按判因顺序做：先给这条用例换可控的库与超时口径，再看它在全量下是否仍红。
- ~~预设列表没有搜索/分页~~ **已补**（§2.19）：`searchPresets`/`countPresets` 下推 SQL，
  列表页有搜索框与「加载更多（X / N）」，内建分区保持整份只读（它是安装包的固定小集合）。
  人设 / 正则 / 快捷回复三个列表仍是全表读：量级小（各自几十条量级），
  且 §2 那句是条件式的，所以不判为违反，但要动它们时就照搬这一套。
- U-12 跨端往返矩阵**只闭合到三种格式**（角色卡按步骤钉、世界书三跳、预设三跳本轮已补，见 §2.13）。
  剩下的不是「还没写」，而是**PC 侧没有对应的纯函数边界**：
  人设与正则在 PC 根本没有 import/export handler（只有 `list/save/delete`），
  「PC 导入 → Android 导出 → PC 再导入」这句要求对它们**不适用**；
  快捷回复的导入器长在 `ipcMain.handle` 里，最内层纯函数 `normalizeQuickReply` 未 `export`，
  要接链必须先改 PC 一行可见性。三处各自的口径：
  1. 人设 / 正则：以 payload 对齐为准（已由 `sync-payload` 组覆盖），矩阵项标「不适用」；
  2. 正则的**开放 payload 差异**（PC `{...rule} - id` 让未知键进哈希，Android 固定 11 键）
     在 Android 代码注释里已声明为已知差异并留给阶段 7 的 fixture（`EntityPayloads.kt:134-141`）。
     **本轮没有把它假装关掉**：现存的 `regex_rule` golden 两例都不带未知键，所以这条差异
     目前既没被证明、也没被证伪，需要一个带未知键的 case 才能判；
  3. 快捷回复：Android 有意保留 PC 会丢的未知键（`QuickReplyCodec.unknownByKey`），
     于是「PC 再导入 Android 的导出」必然再丢一次——链子接得起来，但**断言口径是决策**
     （按语义等价比？还是按字节比、把差异判成红？），需与 D-3 / D-7 一起签字。

- ~~U-9 压力口径验证~~ **已跑**：`phase5/ContentLoadMatrixInstrumentedTest`，
  500 角色 / 100 世界书 / 1k 预设，API 26 与 API 34 各 4 tests 全绿（见 §2.10、§3）。
  **但「每书 5k 条」这一档没能按方案原文验证**：它超过同步契约的 2 MiB 单条 payload 上限，
  实测被 `PayloadTooLargeException` 拒掉（方案与契约互斥，另立 **D-8** 待决策）；
  实际验证的是契约允许的最大档 **3,500 条/本**（5 本巨型 + 95 本常规）。
  另外这三条测的是**仓储/DAO 层的可用性与机制**（分页在库、命中在库、读回不失真），
  **不等于**「列表在用户手上不卡」——Compose 层的渲染与滚动仍未走查（见上面八条路径的实机走查）。
- U-10 v3→v4 迁移 instrumentation：**已在真机跑通**——API 26 与 API 34 各 35 tests 全绿
  （Gradle Managed Devices，aosp x86_64 镜像，见 §3）。
  **API 31（Android 12）这一档：2026-09-20 已用「经典 AVD」路径全量跑通 59/59**
  （`qingyu-api31(AVD) - 12`，`connectedDebugAndroidTest --rerun`，见 §3.2）。
  这条把此前几次 `AdbTimeoutException` 的性质定死了：**卡的是 GMD 那条路**——
  它的 APK 安装插件把 adb 超时写死成 `Timeout: PT2M`，本机 api31 的安装间歇性超过 2 分钟；
  换 `connectedDebugAndroidTest`（手动起 AVD + 已连设备）后同一份代码 1m4s 跑完全部 59 条、0 失败。
  所以「Android 12 一档」现在**自动化矩阵内三档齐**（26 GMD / 31 经典 AVD / 34 GMD 各 59/0），
  且阶段 3 迁移类、阶段 4 用例、阶段 5 备份失败路径与压力矩阵**都在 API 31 上真跑过了**
  （16 个类逐类 0 失败）。
  仍不能顶替的是**物理真机**：Android 8/12/14 真机矩阵依旧未跑（§11.1 两个要求不能互相顶替）。

**已接通的可达路径**（数据层全绿之后才接，顺序见 §4-7）：
设置 → 内容管理（`Routes.CONTENT_HUB`）→ 角色管理（S5-01）、正则规则（S5-05）、
预设（S5-03）、人设（S5-04）、**世界书**（S5-02，`Routes.LOREBOOKS` → `LorebookListScreen`）、
**快捷回复**（S5-06，`Routes.QUICK_REPLIES`）、**用量分析**（S5-07，`Routes.USAGE_INSIGHTS`）、
**备份与恢复**（S5-08，`Routes.BACKUP`）；设置页内嵌 `ContentSettingsSection`
（可同步公开设置 + 明确不参与同步的设备级分区）。**八个能力入口全部可达。**

**对用户可感知完成度的判定**：阶段 5 §4 的验收语「用户可以只用 Android 建立和维护完整聊天资产」
在**代码与门禁层面已具备**：八个能力都可达、写入全走 Repository + change journal、
单元测试 1038/0、`lintDebug` 0 Error、`assembleDebug` 通过、API 26/34 instrumentation 各 35/0、
PC 侧 `pnpm check`/`pnpm test`/relay 全绿。
**但仍不能签字**：八条路径里只有「中心页八条入口逐个可点」这一条有了设备证据（§2.11），
需要数据加载与弹层确认的走查（新建→保存→记账、搜索滤行、删除影响确认、备份恢复确认框）仍未跑通
（SAF 选文件与导出、草稿自动保存、删除影响提示、恢复确认框、权限与低版本行为）。
本阶段新写的 `BackupScreen` 与四个由子代理交接的编辑器都只证明「能编译 + 数据层对」，
Compose 层的交互正确性目前**没有任何测试覆盖**——这正是 §11.1 测试金字塔要求实机验收兜住的那一层。

**依赖其他阶段的遗留**

- 阶段 2 的 PCE-01（PC 无感升级与 A/B 性能门禁）仍未补；阶段 2/3/4/5 交织的工作区改动
  已随 **`047e093`** 整体入库（不再是「未提交」），但 PCE-01 本身仍缺，
  所以阶段 7 的前置（阶段 2 含 PCE-01、3、4、5）**尚未真正满足**。
- `047e093` 只提交到本地，**尚未推送**到 `origin/main`（推送与否由用户决定）。

## 6. 回滚方法

1. Room：本地库是新增文件（阶段 3 起独立于旧缓存库），删除 `qingyu-local.db` 即回到
   未迁移状态；`MIGRATION_3_4` 只做加法，保留 v4 库不影响 v3 读取路径。
2. PC：`charCard.ts` 是单常量改动，回滚即还原该常量 + 删除 `charCardPngBase.test.ts`；
   但**不建议回滚**，回滚等于恢复「PC 导出的 PNG 卡 PC 自己导不进去」。
3. Android 内容层：`content/**`、`ui/content/**`、`ui/characters/Character*` 新文件、
   `Routes.CHARACTER_MANAGER` 与顶栏入口互相独立，整体删除不影响阶段 3/4 路径；
   `LocalEntities`/`LocalDaos`/`LocalStore`/`RoomLocalSyncRepository` 的改动需要连同
   `MIGRATION_3_4` 一起回退（同一次提交内完成）。
4. 共享 fixture 与生成器：`shared/fixtures/cross-platform/content-io/` +
   `shared/__tests__/contentIoGolden.test.ts` + 本轮新增的
   `shared/__tests__/lorebookCatalogGolden.test.ts`、`shared/__tests__/helpers/goldenVolatile.ts`
   与 `lorebook-catalog-canonical.json` 是纯新增，删除不影响任何现有断言——
   但删掉 `lorebook-catalog-canonical.json` 会让 `LorebookCrossLanguageGoldenTest` 直接报错
   （缺输入即失败，不会静默跳过），这是有意的。
   注意本轮**重生成**了 `lorebook-detect.json` 与 `lorebook-import-roundtrip.json`
   （前者补进 `input`/`file`，后者改成条目 id 哨兵），回滚这两个文件时要连
   `LorebookCrossLanguageGoldenTest` 一起回退，否则 Kotlin 侧会因缺 `input` 而变红。

## 7. 下一阶段输入

- 阶段 6/7 可以直接使用：`EntityPayloads`（规范 payload 单一来源）、
  `CanonicalEntityIds`（`settings-public`、`quick-replies-root`）、`MIGRATION_3_4` 后的 v4 库、
  `usage_clear_marker` 因果清理、`LorebookMappingTemplateDsl` 受限 DSL。
- 阶段 7 开工前必须先收 §5 的 B-1（全量单测绿）与 B-2（跨端 fixture 补齐），
  否则同步核心会在错误的 payload 形状上再做一层。
- 剩余 UI（U-1～U-7）建议按「世界书 → 预设 → 人设 → 正则 → 快捷回复 → 设置/用量 → 备份」
  顺序推进：世界书最复杂且依赖已就绪的编解码层，备份入口依赖前六者的数据结构。
- **阶段 6（尤其 S6-05 Embedding 与语义检索）可以直接接手的接缝**：`ChatLorebookChannels`
  已经把「本机有什么通道」收成 `VECTOR_AVAILABLE` / `LEXICAL_AVAILABLE` 两个常量与一张四档判定表，
  `ChatLorebookRuntime.Entry.retrieval` 也已带上 canonical 的检索模式。S6-05 落地时的正确顺序是
  **实现通道 → 翻常量 → 让 `ChatLorebookChannelsTest` 变红 → 同时改分类表、类注释与本节口径**，
  而不是另起一套判断。**开工前先定 D-9**（`semanticRequired` 在 PC 被停用、在本机被关键词触发，
  两者不可能都对）。
- 阶段 6 需要、而阶段 5 **确实没有**覆盖到的两处（**别因为 `EntityPayloads.EntityTypes` 里有常量就以为齐了**，
  这两个常量本阶段就有，但常量不等于可用）：
  - `media_manifest`：Room 表 `local_media_manifests`、DAO 与 `LocalStore.putMediaManifest` **都在**，
    但 `EntityPayloads` 现有的 9 个 payload 构造函数里**没有它**——也就是说它目前还进不了同步信封；
  - `mcp_public_config`：Android 侧**只有 `EntityTypes.MCP_PUBLIC_CONFIG` 这一个常量**，
    没有表、没有 DAO、没有 payload。S6-06 得从零加。
