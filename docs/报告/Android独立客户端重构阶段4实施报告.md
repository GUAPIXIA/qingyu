# Android 独立客户端重构阶段 4 实施报告（进行中）

> 日期：2026-09-17
> 基线提交：`37801ff` + 阶段 3 未提交改动
> 结论：**进行中（本轮完成 S4-01 的基础设施与确定性模块）**
> 工作区状态：**未提交**

---

## 0. 本轮范围与结论

阶段 4 覆盖「Kotlin Chat Core 等价实现 + token 策略 + GenerationTask 状态机 + 单聊用例 + 记忆闭环 + UI 接管」。

> **结论（round 43）**：阶段 4 的**完成定义（方案 §5）三条子句已逐条取证满足**，见 §3.1.37；
> S4-01…S4-06 清单逐条核对完成（§3.1.35 / §3.1.36）。剩余项均已定性为
> 「属后续阶段（5/6）」或「需用户/发布决策」，逐条列在 §4，**不计入本阶段完成定义**。

阶段 4 需要的 Kotlin 等价源码约 **3900 行**（`lorebook.ts` 2153、`contextBuilder.ts` 1068、
`memory.ts`/`memoryCandidates.ts` 1114 等）。跨语言一致性由 **34 组 golden fixture** 保证：
每次移植都有可执行的 oracle，而不是靠人工目测；fixture 从 TS 生产实现生成，Kotlin 逐字节校验。

| 子项 | 状态 |
|---|---|
| 跨语言 golden fixture 机制（TS 生成 + Kotlin 校验） | ✅ 完成 |
| S4-01 第 1—2 层（variables/macros/regex/prompt converters） | ✅ 完成 |
| S4-01 第 3 层（lorebook 词法检索/BM25/RRF 融合、位置渲染） | ✅ 完成（round 2） |
| S4-01 第 4 层（memory 摘要窗口与输入预算、超长消息截断） | ✅ 完成（round 2） |
| S4-01 第 4—5 层（cropHistory、applyDepthInserts、序列化输入审计、历史分级降级） | ✅ 完成（round 3） |
| S4-01 第 5 层（统一上下文候选 + 确定性预算分配器） | ✅ 完成（round 4） |
| S4-01 第 5 层（世界书条目候选化 + 专项影子报告） | ✅ 完成（round 5） |
| S4-01 第 7 层（回复篇幅策略、场景系数、用户篇幅意图、主对话输出约束） | ✅ 完成（round 6） |
| S4-01 第 6 层部分（message post-process、thought、continuation seam） | ✅ 完成 |
| S4-02 token 计数策略（启发式口径） | ✅ 完成（精确 tokenizer 分支待评估） |
| S4-01 第 5 层（预算链：模型能力档案 / 推理门控 / 生成任务预算） | ✅ 完成（round 16，A3a） |
| S4-01 第 5 层（`contextBuilder` 主装配·无世界书子集） | ✅ 完成（round 18，A3b-1） |
| S4-01 第 5 层余项（世界书） | ✅ 完成（round 31）：运行时触发管线 + 装配器落位（fixture 锁定）+ canonical 编译 + 生产接线；**未覆盖**：词法通道、向量、时效、包含组、诊断（见代码文档逐条列出） |
| S4-01 第 7 层（narrative mode、thought 契约、instruct 模板） | ✅ 完成（round 14，A1） |
| S4-01 第 7 层余项（dialogue directions） | ✅ 完成（round 24，A5）：解析/校验/重复度/提示词跨语言对齐 + 本地直连接线 |
| S4-01 第 5 层余项（memoryCandidates 记忆候选与注入） | ✅ 完成（round 14，A2） |
| S4-01 第 8 层（文本度量、正文收尾器、统一收尾管线、异常终止协调） | ✅ 完成（round 15，A4） |
| S4-03 GenerationTask 状态机 | ✅ 完成（round 7）：状态集/一次性终止闸门/id 分离/草稿节流/interrupted 不重发 |
| S4-04 单聊用例 | ✅ 完成（round 43 核对）：清单 14 项**全部有 UI 入口**（见 §3.1.36）；发送/停止/失败重试、编辑/删除/清空、regenerate/swipe/input continue、从消息分支、翻译/引用/复制/朗读、会话级预设/人设/世界书/叙事模式、导出 MD/JSON、上下文用量与本轮诊断；journal 由契约测试保证 |
| S4-05 记忆闭环 | ✅ 完成：事实核心跨语言对齐 + v1→v2 迁移与 CAS（真机）+ 触发决策/提示词/编排与自动接线（含**竞态丢轮修复**）+ 独立 task type 用量 + 历史变更失效 + **降级路径测试**；向量层属阶段 6（见 §4.4） |
| S4-06 UI 从 Remote 切到 Local Repository | ✅ 完成：入口切换 + 真机端到端走查（三个 AVD 各 34 tests）；面板只写本地；稳定 key 机制已守卫（§3.1.30）；旧回退入口已清除并守卫（§3.1.26）；**streaming 重组动态测量未做**（§4.1） |

---

## 1. 跨语言 golden fixture 机制（本阶段一致性门禁的基础）

**真源**：TypeScript（PC）实现。Kotlin（Android）必须对同一输入给出同一结构化输出。

- fixture 生成器 / 守卫：`shared/__tests__/chatCoreGolden.test.ts`
  - `CHAT_CORE_UPDATE_FIXTURES=1` 时（重）生成 golden；
  - 默认**只读校验**：TS 实现变化而 fixture 未同步时该测试**先变红**，迫使「改契约或同时改两端」。
- golden 数据：`shared/fixtures/cross-platform/chat-core/`（13 个 JSON + README）
- Kotlin 侧：`android/app/src/test/.../chatcore/ChatCoreFixtures.kt`（fixture 读取器）+ `ChatCoreGoldenTest.kt`（逐字段断言）

### 1.1 非确定宏的处理（避免 flaky golden）

`{{random}}` / `{{id}}` / `{{time}}` / `{{date}}` / `{{datetime}}` **不写入字面值**，只记录：
可选集合（`randomOptions`）、形状正则（`idShape`）、以及「把本次实际选中值替换为占位符后的 `normalized` 文本」。
踩过的两个坑已固化在生成器注释里：

1. 判断用了哪个非确定宏必须看**展开前模板**（展开后 `{{id}}` 字面量已不存在）；
2. 归一化必须按**本次实际选中值**替换 —— 按「全部候选」替换会在展开值恰好等于某个未命中候选时漏改，导致同一用例随机红/绿。

修好前连续运行会间歇失败（8 次中 2—3 次红），修好后**连续 6 次运行全绿**。

## 2. 本轮实现的 Kotlin 模块

| Kotlin | 对齐 TS | 说明 |
|---|---|---|
| `chatcore/JsRegex.kt` | `RegExp` 语义 | JS↔JVM 差异收敛层：`g` 标志（非全局只替换首次）、JS 替换串语义（`$$`/`$&`/`` $` ``/`$'`/`$1..$9`，反斜杠按字面量）、标志集映射（未知标志视为非法） |
| `chatcore/ChatVariables.kt` | `variables.ts` | `replaceVariables` 大小写不敏感、null 回退空串、`original` 缺省回退角色名；`getDisplayName` |
| `chatcore/ChatMacros.kt` | `macros.ts` | 11 个内置宏、`{{name:参数}}` 与 `\|` 转义、未知宏原样保留、`buildMacroContext`；`now`/`random` 可注入 |
| `chatcore/ChatRegex.kt` | `regex.ts` | scope/stage/trigger 过滤、`applied`/`matched` 计数、output 两阶段链式、stop string 收集与截断；模式长度 500 与文本长度 200_000 上限与 PC 一致 |
| `chatcore/ChatPromptConverters.kt` | `promptConverters.ts` | OpenAI/Claude/Gemini 转换、provider 分发、assistant prefix |
| `chatcore/ChatMessagePostProcess.kt` | `messagePostProcess.ts` + `thoughtMarkup.ts` | MERGE/STRICT/SEMI 合并、`keepSeparate`、代入式对白前缀、thought 提取（容忍孤立/未闭合标签、空回退）、续写接缝去重（KMP） |
| `chatcore/ChatTokenCounter.kt` | `tokenCounter.ts` | 按模型族系数的启发式估算、图片 token、展示格式 |
| `chatcore/ChatLorebookRetrieval.kt` | `lorebookRetrieval.ts` | tokenizer（NFKC/小写/去代码块与 URL、CJK bigram+trigram、Latin ≥2 或纯数字）、字段权重、BM25、覆盖率修正、`runtime.revision` 指纹与内容哈希指纹、RRF 融合 |
| `chatcore/ChatLorebookRenderer.kt` | `lorebookRenderer.ts` | `chat` 深度注入（`max(0,floor(depth))`）、7 个 prompt 锚点、`outlet`/`custom` 回退 prompt_end 并记 fallback/decision |

### 2.1 round 2 新增（世界书 + 记忆窗口）

| fixture | 覆盖 |
|---|---|
| `lorebook-tokenize.json` | 中英混合、单字、Hangul/Katakana、代码块/URL 清洗、全角、空串 |
| `lorebook-search.json` | 12 组查询（含 topK/threshold 覆盖、空查询、停用书与停用条目排除、无 runtime 时的指纹分支） |
| `retrieval-fusion.json` | 三通道融合、单通道、空通道、自定义 k 与权重（含 vector 权重 0） |
| `lorebook-render.json` | 7 锚点全落位、chat 深度（含负数与小数钳制）、outlet 空名回退 default 与同名追加、未知 custom 回退 |
| `memory-budget.json` | 预算解析（含 `NaN`/`Infinity`/负数/小数/极小上下文）、超长消息首尾保留与省略标记 |
| `memory-window.json` | 游标不存在/为空、预算 1 与 10、overlap 0/3/-1、首条超预算仍完整保留且游标只推进到它本身 |

**fixture 约定的一个硬约束**：`NaN` / `Infinity` 不能直接进 JSON（`JSON.stringify` 写 `null`、`JSON.parse` 读回 `null`，会让用例自相矛盾），
改用字符串哨兵 `"NaN"` / `"Infinity"` / `"-Infinity"`，两端各自解析（生成器 `toSentinel`，Kotlin `sentinel`）。
另外 `runtime.revision` 是**书级**字段，`entry.runtime` 只含 `insertion`/`retrieval`/`adapterId`/`title`——首轮按 entry 级实现导致 TS 类型检查失败，已按真实类型修正。

## 3. 门禁结果

| 命令 | 结果 |
|---|---|
| `pnpm check` | **PASS**（exit 0） |
| `pnpm exec vitest run shared/__tests__/chatCoreGolden.test.ts` | **34/34**，连续 3 次运行稳定 |
| `pnpm test`（全量） | **3022 passed / 4 skipped** |
| `gradlew :app:testDebugUnitTest` | **1078 tests，0 failures**（2026-09-20 用 `--rerun` 强制真实执行后核对；此前报 893 属低估，原因见 `docs/规范/开发环境与门禁-备忘录-2026-09-18.md` §4.3） |
| `gradlew :app:connectedDebugAndroidTest`（**无过滤**全量） | **API 26 / 31 / 34 各 28 tests，0 failures** |
| `gradlew :app:lintDebug` | **0 Error** |

### 3.1 Kotlin 一致性测试明细（`ChatCoreGoldenTest`，31 用例）

round 1（16）：variables / displayName / macros / macroSplitArgs / buildMacroContext /
regex 五个 golden / promptConverters / messagePostProcess / thought / continuationSeam / tokenEstimate。

round 2 新增（6）：`lexicalTokenizeMatchesGolden`、`lexicalSearchMatchesGolden`、`retrievalFusionMatchesGolden`、
`lorebookRenderMatchesGolden`、`memoryBudgetMatchesGolden`、`memoryWindowMatchesGolden`。

round 3 新增（4）：`contextCropMatchesGolden`、`depthInsertMatchesGolden`、`inputAuditMatchesGolden`、
`historyDegradationMatchesGolden`。

round 4 新增（1，但覆盖 11 个候选 + 4 个候选组 + 9 个分配用例）：`contextCandidatesMatchGolden`。

round 5 新增（1，覆盖 8 个评分用例 + 5 个 origin + 5 个候选集 + 4 个注入统计 + 5 个影子报告）：`worldbookCandidatesMatchGolden`。

round 6 新增（1，覆盖 9 个可见字符 + 10 个中位数 + 4 个采样 + 32 个意图 + 12 个场景系数 + 10 个模式 + 16 个策略 + 4 段提示词逐字符）：`responsePolicyMatchesGolden`。

round 7 新增（2）：`generationTerminationMatchesGolden`（20 个观测推导 + 8 个 finishReason + 10 个有效原因 + 10 个有正文提示 + 30 个无正文提示 + 7 条闸门轨迹逐步重放）、`domainErrorsMatchGolden`（17 个错误码 × 3 种构造 + 8 个脱敏用例）。

### 3.1.1 S4-03 GenerationTask 状态机（`GenerationTaskMachineTest`，16 用例）

阶段文档 §2 S4-03 的四条硬约束逐条落地并有对应断言：

| 约束 | 实现 | 断言 |
|---|---|---|
| 状态固定 | `STATES = queued/preparing/streaming/finalizing/completed/cancelled/failed` | `stateSetMatchesStageDocument`；`interrupted` 是**失败码**而非状态，避免与固定状态集冲突 |
| taskId / requestId 分离 | 网络重试保持 requestId；逻辑级 [retry] 保留 taskId、换新 requestId | `logicalRetryKeepsTaskIdAndIssuesNewRequestId`（`task-9#1` → `task-9#2`） |
| 草稿节流、完成时一次成文 | [appendChunk] 只进内存缓冲；[takeFinalMessage] 是唯一落盘出口 | `draftIsBufferedAndOnlyMaterializedOnCompletion`（streaming/finalizing 期间均返回 null） |
| 进程死亡标 interrupted、不自动重发 | [recover] 非终态 → `failed` + `TASK_INTERRUPTED`、`retryable=false`、丢弃半截草稿 | `processDeathMarksInterruptedWithoutAutoResend`、`recoverIsNoOpForTerminalTasks` |
| 终止提示不拼入正文 | 提示走 `generationNotice`/`generationError` 字段，复用 PC 同口径 | `userCancelKeepsVisibleBodyAndIsNotRetryableTransition`、`contentFilterDoesNotPersistBody` |
| 终态不可回退 | 所有迁移在终态返回 false | `terminalStatesRejectFurtherTransitions` |

`interrupted` 与 `timeout` 的区别被单独锁定（`timeoutIsRetryableWhileInterruptedIsNot`）：
超时属于 `PROVIDER_TIMEOUT`（可重试），进程中断属于 `TASK_INTERRUPTED`（**不可自动重试**），
对应阶段文档「以免重复计费」。

### 3.1.2 S4-04 单聊生成闭环（`LocalChatGenerationUseCaseTest`，20 用例）

本轮把阶段 3 的 Repository、阶段 3 的模型直连、S4-03 的状态机串成**可运行的独立单聊路径**：

```
用户输入 → LocalStore.appendMessage（立即落盘）
         → 组装历史窗口 → ModelGateway.stream（本地直连，不经 PC）
         → chunk 只进状态机草稿缓冲
         → 终局：completed/cancelled 且有正文 → 一次性 appendMessage(assistant)
                失败/空输出 → 不创建消息，错误只进 generationError
```

| 阶段 4 硬约束 | 实现 | 断言 |
|---|---|---|
| 本地写入立即完成，不等网络 | 用户消息在调用模型**之前**落盘 | `happyPathPersistsUserThenAssistant` |
| 未验证完成结果不得提前保存为成功消息 | chunk 期间库中 assistant 计数恒为 0 | `chunksAreNotPersistedBeforeTerminalState` |
| 失败不创建空消息 | 失败/空输出走 `persistIfAny` 且 `final == null` | `transportFailureKeepsUserMessageAndCreatesNoAssistantMessage`、`emptyResponseFailsWithoutCreatingMessage` |
| 错误不拼入正文 | 提示只写 `generationNotice`/`generationError` | `userCancelKeepsAlreadyVisibleBody` |
| 终局分类与 PC 同口径 | `ModelErrorClassifier` 复用 `ChatGenerationTermination` | 取消/断网/限流/畸形响应/超时/审核拦截 6 条终局用例 |
| 提交前校验不写脏数据 | 会话缺失/未配置档案直接失败且不调用模型 | `unknownSessionFailsWithoutWritingAnything`、`missingProfileFailsWithActionableCode` |

**可测试性设计**：`ModelGateway` 抽象让整个闭环在无网络、无设备的环境下可测；
生产实现 `ModelClientGateway` 直接委托阶段 3 的 `ModelClient`（同一 adapter、同一认证头）。
另交付 `Ulid`（阶段 1 冻结的 ID 契约：48 位单调时间戳 + 80 位随机，同毫秒内保证有序）。

**本轮未覆盖（S4-04 剩余）**：编辑/删除/清空消息、swipe、continue、input continue、从消息创建分支、
翻译/引用/复制/朗读、会话级预设/人设/世界书/叙事模式、导出 Markdown/JSON、上下文用量与本轮诊断。

### 3.1.3 S4-06 本地优先 ChatRepository（`LocalChatRepositoryTest`，17 用例）

`ChatRepository` 是 UI 的唯一数据入口（约 60 个方法）。本轮交付 **`data/local/LocalChatRepository`**：
用阶段 3 的权威库 + S4-04 的本地生成闭包实现同一接口，使 `ChatScreen` / `ChatViewModel` 不改 UI 骨架即可切到本地数据源。

| 能力 | 状态 |
|---|---|
| 会话列表/新建（含开场白）/改名/删除（写 tombstone） | 已本地化 |
| 消息分页（`beforeId` 游标、按 `seq` 稳定排序）、编辑、删除 | 已本地化 |
| 发送：用户消息立即落盘 → 本地直连生成 → chunk/Done/Error 经 `events` 推送 | 已本地化 |
| swipe / 分支会话 / 清空对话 / 角色激活 | 已本地化 |
| 上下文用量（S4-02 启发式口径） | 已本地化 |
| 世界书/预设/翻译/快捷回复/公告/更新检查/用量汇总/长记忆总结 | **返回可行动的空结果**，不抛异常、不静默失败 |

`connectionState` 在本地模式返回「可用」而非「未连接 PC」——否则 UI 会显示误导性的离线态。

### 3.1.4 本轮排障记录：两个真实竞态/缺陷（非实现猜测）

测试首次运行出现 **间歇性失败**（同一代码时红时绿）。按「先定位根因再修」处理，找到 3 个根因，**全部在测试替身与用例，不在被测实现**：

| 根因 | 证据 | 修法 |
|---|---|---|
| `ScriptedGateway` 每次 `stream()` 重放同一脚本 | 代码即 `flow { script.forEach { emit(it) } }`；`secondTurn` 当初另建 gateway 正是绕行痕迹 | 改为**脚本队列**（每次生成消费一段），`secondTurn` 改为同一 gateway 连续两轮 |
| 事件在订阅者出现前被丢弃 | `MutableSharedFlow` replay=0：无订阅者时 `tryEmit` 事件直接消失 | 新增公开 `eventSubscriberCount`，测试**条件等待**订阅建立，删除 `yield()` 抢时序 |
| 收集协程跨线程改 `MutableList` | 事件列表在 `Dispatchers.Default` 上追加，测试线程读取无同步 | 收集改用 `Dispatchers.Unconfined`，`tryEmit` 同步投递、同线程按序入列 |
| （实现侧）每次生成消耗两个 ID | taskId 与 requestId 各调一次 `idFactory` | 每次生成只分配一个业务 ID，requestId 由 taskId 派生 |

修完后 `LocalChatRepositoryTest` **连续 5 次 `--rerun-tasks` 全绿**，间歇失败消失。

**同时暴露一篇实现改进**：`LocalChatGenerationUseCase` 原先在**落盘用户消息之前**读历史，靠手动补一条凑成请求；
改为落盘后读取，天然包含本轮输入，去掉了重复拼装。这是请求装配的真实缺陷，由「第二轮历史少一条」的断言暴露。

### 3.1.5 S4-06 入口切换与实机验收（round 10）

**切换点**：`AppContainer.repository` 由 `OnlineChatRepository` 改为 `LocalChatRepository`，
连接档案与 API Key 分别来自真实本地库（`connectionProfileRepository`）与 Keystore 包装的 `secretStore`。
按阶段 4 §S4-06「界面不得出现旧远程运行模式或回退入口」，这里**不提供**「切回远程聊天」开关——
回退入口本身即禁止项（`LocalSetupScreen` 同样明确不提供「进入旧伴侣模式」）。

**为什么把 profile/key 提供者改成 `suspend`**：档案读库、Key 读 Keystore，都是挂起操作；
原先的 `() -> T` 形态迫使在非挂起上下文取值。改为 `suspend () -> T` 后，解析发生在生成协程内，
既消除了 `runBlocking` 的必要，也让「未配置档案」按 S4-06 要求变成可行动错误而不是崩溃。

**真机验收**（新增 `phase4/LocalChatFlowInstrumentedTest`，7 用例 × 3 档 API = 21 次执行）：

| 验收项 | 断言 |
|---|---|
| 关闭 PC 后连续多轮 | 3 轮发送 → 6 条消息、role 顺序正确、第三轮请求带前两轮完整历史 |
| 分页游标 | 12 条消息一页返回，`beforeId` 取更早页不重叠 |
| 编辑/删除落 tombstone | 真实 SQLite 上 `isTombstoned` 为真（跨设备同步语义） |
| 分支会话 | 新会话、消息换新 id、原会话删除级联清空 |
| 失败可观察 | 断网失败后用户消息保留、**不创建 assistant 消息**、错误文案可行动 |
| 本地数据源 | 角色/连接档案/会话均来自真实库；未迁移能力留下可行动提示 |

此前所有测试都基于 `FakeLocalStore`，本轮首次在**真实 Room 库**上验证生产数据路径（`seq` 排序、游标、tombstone、档案读取）。

**真机验收命令与既有失败说明**：不加过滤的 `connectedDebugAndroidTest` 会连带执行
`phase0.CryptoSpikeTest`，其中 `softwareX25519EcdhMatchesBothSides` / `keystoreX25519IfSupported`
在三档 default 镜像上均因 `NoSuchAlgorithmException: no such algorithm: X25519 for provider AndroidOpenSSL` 失败。
该结论已在阶段 3 报告中记录（非本阶段引入，`CryptoSpike*` 未被本轮改动），故门禁沿用阶段 3 的 class 过滤方式：

```
gradlew :app:connectedDebugAndroidTest   -Pandroid.testInstrumentationRunnerArguments.class=com.qingyu.companion.phase3.LocalDatabaseInstrumentedTest,com.qingyu.companion.phase3.NotificationChannelsInstrumentedTest,com.qingyu.companion.phase3.SecretStoreInstrumentedTest,com.qingyu.companion.phase4.LocalChatFlowInstrumentedTest
```

注意 `-P...class=` **不支持通配符**（`phase3.*` 会报 `Failed loading specified test class`），必须写全限定类名。

**本轮必须坦白的一个副作用**：`repository` 是会话/角色/用量等页面的**共享入口**，
切到本地后这些页面也改为读本地库。本地角色数据目前只有两个来源——阶段 3 的旧缓存导入
（`LegacyCacheImporter` 从 `cached_sessions` 派生角色），以及阶段 5 的 PC 角色同步。
因此**全新安装且尚未做 PC 角色同步的用户，角色列表可能为空**，进而无法新建会话。
这是阶段 4 切换到本地权威库的必然中间状态，缓解路径是阶段 5 的角色同步；已记入风险清单。

### 3.1.6 S4-06 状态标签与实机发现的旧远程回退入口（round 11）

**1）数据源/生成状态标签**（S4-06「本地生成任务状态与模型连接状态有清晰标签」）

- `ChatRepository` 新增 `DataSourceStatus`（`local`/`modelConfigured`/`provider`/`model`/`baseUrl`），
  默认实现返回「远程且未配置」，避免任何实现被误标为本地直连；
- `LocalChatRepository` 从真实本地库读出档案并暴露 `refreshDataSourceStatus()`；
- 新增纯映射 `ChatStatusLabel`：数据源文案、生成中文案、缺配置时的**可行动作**、
  未迁移能力提示，以及顶栏副标题行的**优先级**（生成中 > 需配置动作 > 常驻数据源）；
- `ChatScreen` 顶栏副标题由「会话标题」改为「会话标题 · 数据源/状态」，
  生成中用 accent、缺配置用 warn 着色——不改布局，零溢出风险。

单测：`ChatStatusLabelTest`（12 例，穷举文案与优先级）+ `ChatViewModelLocalStatusTest`
（4 例，验证状态确实从**真实本地仓库**流到 UI 状态，并随档案变更更新）。

**2）实机查出的 S4-06 违规（单测无法发现）**

真机走查（uiautomator 导出真实界面文本）在**创建本地资料后**发现会话页呈现：

```
暂无会话 | 在 PC 端开始对话，或检查连接状态 | 重试 | 未连接
```

这**直接违反** S4-06「界面不得出现旧远程运行模式或回退入口」：本地模式完全可用，
却把用户赶回旧伴侣模式，并用红色「未连接」暗示应用不可用。
根因是入口切换只换了 `repository`，会话页的空态文案与连接胶囊仍按「PC 连接」语义渲染，
而 `connectionState == DISCONNECTED` 在本地模式下的含义已变为「未连 PC」而非「不可用」。

修复：

| 位置 | 修改 |
|---|---|
| `SessionsViewModel.UiState` | 新增 `localMode`，由 `dataSourceStatus.local` 驱动 |
| `SessionsScreen` 空态 | 本地模式用 `sessions_empty_desc_local`（「本机还没有会话。点「+」选择角色…」），动作由「重试」改为「新建会话」 |
| `QyConnectionChip` | 新增 `localMode`：未连 PC 时显示「本地模式」（accent）而非红色「未连接」；已连 PC 仍如实显示「已连接」 |
| `strings.xml` | 新增 `sessions_empty_desc_local` / `action_new_session` / `connection_chip_local` |

**修复后的实机复验文本**（同一台 API 34 模拟器，uiautomator 导出）：

```
暂无会话 | 本机还没有会话。点「+」选择角色，即可在本机直接开始对话 | 新建会话 | 本地模式
```

旧文案与红色「未连接」均已消失。**这条修正是本轮最有价值的部分：它只能靠实机发现**——
单测、lint、编译全部通过，仓库层用例也都绿，但用户看到的仍是旧伴侣模式话术。

**3）实机确认已知缺口（角色数据空洞）**

点击「新建会话」→ 角色选择器显示「**暂无角色 / 重试**」。即阶段 4 的完成定义
「关闭 PC 后从创建会话到连续多轮聊天」在**全新安装**上还无法走通：
本地角色仅由阶段 3 旧缓存导入或阶段 5 PC 角色同步产生。
本条由代码审计推断升级为**实机证据**，是阶段 4 关闭前必须解决的前置项。

### 3.1.7 实机端到端验收走查与第二个真 bug（round 12）

**先厘清职责边界**：`docs/方案/.../阶段5-内容管理功能对齐实施方案.md` §S5-01 明确把
「角色列表/创建/编辑/删除/导入导出」划给**阶段 5**。因此「全新安装无角色」不是阶段 4 的缺陷，
而是**跨阶段依赖**。阶段 4 要做的，是在有角色的前提下把完成定义走通——这也是本轮的重点。

**验收脚手架**（均不进仓库或版本控制）：

- 宿主机 mock OpenAI 兼容**流式**服务（`%TEMP%\qingyu-mock\mock-openai-server.js`，无第三方依赖），
  供模拟器经 `http://10.0.2.2:8099/v1` 访问。`10.0.2.2` 属私网 IPv4，与应用层 `EndpointPolicy`
  「仅私网/loopback 允许 http」一致，故不触碰任何安全边界。
- `phase4/AcceptanceSeedInstrumentedTest`：**只播种不清理**（角色 + 连接档案），
  供随后 UI 走查使用。与断言型测试分离，避免污染常规门禁。

**实机走查脚本与结果**（API 34，全程关闭 PC 与 Relay，界面文本由 `uiautomator dump` 取证）：

| 步骤 | 证据 |
|---|---|
| 建会话 | 会话页「本机还没有会话…」→ 点新建 → 角色「苏晚」→ 开始对话 |
| 状态标签 | 顶栏「**苏晚 · 本地直连 · mock-model**」（S4-06 标签在真机生效） |
| 第 1 轮 | 发送 `round-one` → 回复落盘显示；mock 记录 `turn=1 msgs=1` |
| 第 2 轮 | 发送 `round-two` → mock 记录 **`turn=2 msgs=3`**（历史确实带上来了） |
| 重生成 | 长按消息 → 重新生成 → 新 assistant 消息（mock `turn=2 msgs=4`），**未重复写入用户消息** |
| 编辑 | 长按 → 编辑 → 改文保存 → 界面显示 `…。-EDITED-ON-DEVICE` 且已落盘 |

**第二个真 bug（本轮实机查出）**：第一轮走查时，回复已完整显示，顶栏却**永久停在「正在生成…」**，
流水草稿也被清空。

根因：`LocalChatRepository.sendMessage` 原先「同步跑完整个生成才返回用户消息」，
而 `ChatViewModel.doSend` 在 `sendMessageUseCase` **返回之后**才把 UI 置为 `Streaming.Generating`——
顺序于是变成 Done 先到、随后被重置为「正在生成…」，界面再也回不到空闲态。
**单测抓不到**：单测直接断言仓库状态，不经过 ViewModel 的「发送后置生成中」这一步。

修复（同时满足阶段 4 §1「生成任务独立于 Compose 生命周期」）：

1. `LocalChatRepository` 新增自有 `CoroutineScope`，生成在该作用域内进行；
   `sendMessage` 只落盘用户消息并**立即返回**（与在线实现契约一致）；
2. 拆分 `LocalChatGenerationUseCase.appendUserMessage`，使「落盘用户消息」与「生成」可分离，
   生成时以 `userText = null` 调用，历史仍天然包含本轮输入；
3. 生成失败改为**经 `CompanionEvent.Error` 上报**，不再从 `sendMessage` 抛出——
   否则 ViewModel 会把它误判为「发送失败」而走 pending 重发路径；
4. `stopGeneration` 改为取消该 requestId 的生成 Job。

修复后实机复验：回复到达后顶栏恢复「苏晚 · 本地直连 · mock-model」，「正在生成…」与停止键同时消失。

### 3.1.8 S4-05 记忆事实核心跨语言对齐（round 13）

阶段 4 §S4-05 要求「手动摘要、自动摘要间隔、事实提取、当前状态、历史记录」，
其中**事实的提取、规范化、变更应用与检索排序**全部是确定性纯逻辑，因此按契约先对齐这部分
（`shared/chat-core/memory.ts` 568 行 → Kotlin `ChatMemoryFacts` + `ChatMemoryRanking`）。

对齐内容：

| 分组 | 覆盖 |
|---|---|
| 解析 | 【当前状态】/【时间线】/【摘要】/【事实】分段与兜底；【事实变更】/【事实提案】的 JSON 解析；**段存在但格式无效必须返回 null，让调用方保留旧事实**（不允许「解析失败即清空记忆」） |
| 规范化 | 旧文本事实迁移为结构化事实（稳定散列 id）、importance/confidence 钳制、status 归一 |
| 身份匹配 | subject + predicate + scope + entityId；scope 别名归一（本会话/session 等）；旧事实缺 scope/entityId 按通配 |
| 变更应用 | add 覆盖同键旧事实、update 改值归档旧值、update 仅改权重不归档、deactivate、未知 ID 忽略；被替代/停用的事实**只进 history** |
| 去重上限 | 超过 `MAX_MEMORY_FACTS` 时按 importance → confidence → updatedAt 保留；history 超过 `MAX_MEMORY_FACT_HISTORY` 截断 |
| 检索 | 30 天线性衰减最近性；结构化与字符串事实两套评分公式；**无语义分数（embedding 不可用）时降级排序并标记 `fallback`** |
| 预算 | 单条超限**跳过继续**；分层预算（当前状态 30% 上限 240/下限 30 → 事实 40% → 时间线） |

**fixture 立刻抓出一处真实语义分歧**：PC 的 `!updatedAt` 判断使 `updatedAt === 0` 也走「缺省」分支返回 0.5，
而我最初只判了 `null`，于是 0 被当成 1970 年，recency 直接掉到 0，会把「时间戳缺失但有价值」的旧事实排到末尾。
已修正为 `updatedAt == null || updatedAt == 0L`。这类分歧无法靠肉眼审查发现。

**关于 `fitLayeredMemoryBudget` 的一处诚实说明**：该函数内部用 `Date.now()` 计算 recency，
PC 与 Android 时钟不同必然不等，因此分层用例**刻意使用无 `updatedAt` 的旧文本事实**（recency 恒 0.5）以保证跨语言可比；
recency 本身由显式传 `now` 的 `recencyCases` / `rankCases` / `budgetCases` 锁定。
Kotlin 侧 `fitLayeredMemoryBudget` 额外接受显式 `now`（生产传当前时间），以满足「同输入同输出」的可测性要求。

**尚未覆盖（S4-05 剩余）**：
- 摘要触发决策（`memory_disabled` / `manual_mode` / `interval_not_reached` / `insufficient_messages` / `stale_version` 的判定顺序）；
- **CAS 落盘**：`expectedVersion` 不匹配时丢弃结果，防止生成期间用户编辑被旧摘要覆盖；
- 记忆请求使用**独立 task type 与用量记录**；
- 文本历史变化时使派生记忆失效（PC 规则）；
- embedding 不可用时事实仍保存（本模块已保证「降级不丢事实」，但向量层未接入）。

### 3.1.9 S4-01 第 5 层预算链跨语言对齐（round 16，A3a）

**先修正一处计划低估**：原计划把 A3 记为「`contextBuilder` 1130 行」。实测其完整依赖为
`lorebook.ts` **2153 行**（runtime 瀑布未移植）+ 预算链 **835 行**（完全未移植）+ builder **1068 行**，
合计约 **4000 行**——不是单轮任务。因此拆为：

- **A3a（本轮）**：预算链 —— `modelOutputProfile.ts`(460) + `reasoningGate.ts`(284) + `generationTaskBudget.ts`(148)
- **A3b（后续）**：`lorebook.ts` runtime + `contextBuilder.ts` 主装配

**A3a 对齐内容**：模型能力档案（精确登记 → 族通配 → 保守回退；用户覆盖可放大、运行时纠正只收紧）、
P90 推理余量（样本不足 10 取最大值；全 0 样本回退档案默认值——`max_tokens` 是上限而非花费，
多留推理空间不多花钱）、请求预算公式（`bodyReserve` → `reasoningReserve` → `requestMaxTokens` 与
`riskNotice`）、推理门控（档位→knob→gateTokens、可信判定、探测合并、预算型 knob 的正文保护钳制）、
生成任务预算（18 种任务的正文体量、自动扩容 `expandAdaptiveOutputBudget`）。

**fixture 再次抓到同一类问题**：`PERCENTILE_CASES` 的样本数组与 `HARD_CAP_CASES` 的 `NaN` 经 JSON
变成 `null`，导致 fixture 自相矛盾（连跑 2 次红 2 次）。这是**第 5 次**同类问题
（memory NaN、input-audit NaN、context-candidates NaN、worldbook Infinity、本次 percentile/hardCap NaN）。
已全部哨兵化；`contextBuilder` 的 fixture 设计必须先按「可往返」规则过一遍。

**验证**：`ChatBudgetChainGoldenTest` **6/6**；fixture 22/22 连续 3 次稳定；
变异验证（`BODY_RESERVE_MULTIPLIER` 1.25→1.5）→ `requestBudgetMatchesPc` + `generationTaskBudgetMatchesPc` 双双 FAILED。

### 3.1.10 S4-05 本地库 v1→v2 迁移与记忆 CAS 落盘（round 17）

**为什么先做这一块**：它是 S4-05 里唯一**不可回退**的部分（本地库是用户权威数据），
也正好解掉此前提示阶段 5 会遇到的 schema 冲突——阶段 5 的 S5-07（用量）与 S5-08（Backup V3）
直接建立在这两张表上，必须先稳定。

**schema 变更（v1 → v2，显式迁移，只增列、不重建表）**：

| 表 | 新增列 | 用途 |
|---|---|---|
| `local_memory_states` | `memory_version`、`current_state`、`facts_json`、`history_json`、`history_revision` | CAS 依据 / 分层注入 / 已对齐的规范事实模型 / 派生记忆失效依据 |
| `local_usage_records` | `task_type` | 记忆用量与聊天用量分开统计 |

**不复用 `local_memory_facts` 扁平表的理由**：它是阶段 3 的 subject/content 简表，
缺少 predicate/status/importance/scope/entityId，无法表达 S4-05 已对齐的事实模型；
规范模型以 JSON 存于记忆状态行（CAS 的同一行、同一事务），扁平表保留兼容。

**CAS 语义**（逐条对齐 PC `updateSessionIfMemoryVersion`）：事务内判断行是否存在 →
存在则走**单条条件 UPDATE**（`WHERE session_id=? AND memory_version=?`），
受影响 0 行即「版本已被并发推进」→ `applied=false`、**磁盘保持不变**、上报 `stale_version`；
不存在则只在期望版本为 0 时插入初始行。只有真正应用后才写 journal。

**真机验证（`MemoryMigrationAndCasInstrumentedTest`，7 项 × 三档 = 21 次执行，全部通过）**：
v1 行经迁移存活且新列取默认值、`change_log` 不因迁移丢失、
CAS 版本匹配即应用 / 版本过期即拒绝且磁盘不被覆盖 / 缺行且期望非 0 不创建行 /
修订号推进独立于记忆版本 / 用量可按 task_type 区分。

**过程中两个真实教训**：
1. **`MigrationTestHelper` 需要把导出的 schema 作为 `androidTest` assets**（原先只配了 JVM `test`）。
   这一行同时把「`app/schemas` 必须入库」从**提交卫生**升级为**测试前置**——缺文件时迁移测试必然失败。
2. **裸 SQL 迁移测试不得从 Kotlin 字段名推断列名**：我按 `envelope_json` 写 INSERT，
   而 v1 真实列是驼峰 `envelopeJson`（无 `@ColumnInfo` 改名）。改为直接读导出的 `1.json` 取证。

**同时修正**：`FakeLocalStore` 也实现了同一套 CAS 语义——
替身若「永远成功」，依赖 CAS 的用例就失去意义。

### 3.1.11 S4-01 第 5 层上下文主装配（无世界书子集，round 18）

**先修一个功能缺口**：本地生成此前只发「裸的用户/助手历史」——**没有任何 system message**，
模型收不到角色卡、人设、叙事模式、thought 契约与记忆。真机上「跑通」只是链路通，
换成真实模型就会完全脱离角色设定回复。本轮把共享装配器接进 `LocalChatGenerationUseCase`。

**移植范围**：`buildContextMessagesFromData` 在 `activeLorebookIds` 为空、`shadow` 关闭时的**完整路径**——
系统提示 / 越狱段 / 叙事模式 / 用户人设（system 与 separate 两种位置）/ thought 契约 /
记忆三层注入（候选分配 + 物化，含回滚到分层预算） / 角色设定 / 作者注释（top/middle/bottom） /
对话示例（after_system / after_history / always / first_turn / off） / 历史裁剪与压缩摘要注入 /
at_depth 深度注入 / 续写指令 / assistant 前缀 / 连续同角色合并 / provider 格式转换 /
`resolveChatRequestPlan`（响应策略 + 请求预算 + 意图 + 场景系数）。

**为什么这个子集是安全的**：世界书分支被 `if (lorebookIds.length > 0)` 守卫，
输入无世界书时该分支**不执行**，因此子集与 PC 在该输入下逐字节等价——
oracle 用的是 PC 真实的 `buildContextMessagesFromData`，不是重写的简化版。

**显式排除**：世界书 before/after_character 与 prompt_end、世界书 at_depth、示例的世界书包裹、
三类影子（世界书/记忆/历史降级）、输入审计、`shadow='shadow'`。这些需要 A3b-2 的 runtime 瀑布。

**fixture 抓到的两个真问题**：
1. **我把 thought 契约的主体名写死了**：PC 在尾部正文格式里传
   `subjectName: narrativeMode === 'omniscient' ? '' : charNameForVars`，
   我无条件传空串 → 沉浸模式下模型不知道这段内心独白属于谁。fixture 直接报出内容不符。
2. **tokenizer 转写错误（更严重）**：PC 的标点集合用的是 **ASCII 直引号 `"` `'`**
   （源码里各写了两遍），我却「美化」成了中文引号 `“”‘’`。
   原有 token fixture 里那条含直引号的用例**恰好落在同一个 `ceil` 内**，所以从未暴露；
   直到上下文装配的 `lastContextUsage` 差 1（801 vs 800）才被抓出。
   已修正为直引号 + 显式 JS 空白集合（`\s` 的平台差异），
   并补上能**放大**该差异的 token 用例（40 个连续引号、中文引号、U+3000/U+00A0），
   避免同类错误再次溜过。

**接线的三处测试前提更新**（属预期行为变更，不是回归）：
`LocalChatGenerationUseCaseTest` 两例与 `LocalChatRepositoryTest` 一例、以及真机
`LocalChatFlowInstrumentedTest` 的多轮用例，原先断言「请求消息数 == 历史条数」，
现在请求首条是 system 段，故改为过滤 system 后断言对话段，并**新增**断言系统提示非空、
输出上限 > 0。`historyLimit` 从「历史上限」改为「读取上限」（默认 400），
真正的裁剪口径是装配器的 token 预算。

### 3.1.12 S4-05 记忆闭环打通：触发决策、编排与自动接线（round 19）

**本轮之前的状态是「零件齐、机器不转」**：事实模型、窗口、评分、CAS 都已跨语言对齐并有测试，
但**记忆状态在生产中从未被创建**——没有触发点，因此注入路径永远拿到空数据。本轮把它接上。

**新增三块**：
1. `ChatMemorySummaryPolicy`（纯函数）：触发判定（记忆开关 → 手动/自动模式 → 间隔条数，
   顺序与 PC 一致）＋窗口构建后的复检＋事实提案退避状态＋提示词与用户正文构造＋
   证据定位＋主体身份范围补全。
2. `LocalMemorySummaryService`（IO 编排）：读库 → 判定 → 建窗 → **非流式**补全 → 解析 →
   事实应用 → **CAS 提交**；同一会话并发触发合并为同一在途任务。
3. 接线：助手消息落盘后**后台发起**自动总结（发起即忘，失败不影响对话）；
   消息编辑/删除推进历史修订号使派生记忆过期。

**决策顺序不是风格问题**：PC 先报「记忆关闭」、再报「手动模式」、最后才是「条数不足」。
顺序不同会让同一次调用报告出不同原因，日志与观测随之失真。已用测试固化。

**四个「不做就会静默损坏」的约束，全部有测试**：
- **CAS 失败必须丢弃**：测试在流被消费的瞬间推进版本以制造真实交错，断言 `stale_version`
  且磁盘未被覆盖。我第一版测试用 `Dispatchers.Unconfined` 直接跑完，**根本没有交错**，
  是测试假通过；改为在流内注入挂起点后才真正验证到。
- **游标只推进到已总结位置**：否则会永久漏掉一段对话。
- **解析失败不得清空记忆**：空输出必须 `Failed`，且摘要/版本/游标三者都不变。
- **首次 `set` 不产生历史**：`history` 只记录**被取代**的旧值。我最初断言「新事实要进历史」，
  被实现纠正；随后补了一个真正会取代旧值的用例（学徒 → 书店店主）来锁定这条语义。

**另外修正一处我自己引入的设计缺陷**：新参数一度加在 `requestIdFactory` 之后，
破坏了「末位置于尾随 lambda」的约定，导致两个调用点把 `"id"` 当成了 profile 提供者。
已把新参数移到 `requestIdFactory` 之前并在注释里写明该参数必须保持末位。

**验证**：`ChatMemorySummaryPolicyTest` 10 项 + `LocalMemorySummaryServiceTest` 7 项全过；
Android 单测 **735 / 0**；lint 0 Error；真机 API 26/31/34 各 28 tests 全过；`pnpm test` 3011 passed。
其中 3 个用例失败与 1 个期望值错误都是**我的测试写错**（未放角色、复用 store 导致无待总结内容、
退避公式手算错），已逐条改正——实现本身未因此改动语义。

### 3.1.13 S4-04 会话导出与 PC 共用契约（round 20）

**先修一个「看起来有、实际点不到」的问题**：Android 侧存在纯文本/Markdown 导出代码，
但 UI 只有一个「分享」图标直接分享**纯文本**——Markdown 与 JSON 从代码上存在却**没有任何入口**。
本轮把分享图标改为三选一菜单（纯文本 / Markdown / JSON）。

**再修一个跨端不一致**：Android 原来的会话 Markdown 是「`**我**`/`**角色**` + `---`」的简化格式，
而 PC 是「`# 对话记录` + `### 🧑 用户 · 时间`」并对消息内容做 Markdown 转义。
同一段对话在两端导出会得到两个不同的文件。

**做法：把导出逻辑从 IPC handler 抽到 `shared/chat-core/sessionExport.ts`**，
PC handler 与 Android 消费**同一份实现**；fixture 的 oracle 就是生产代码真正调用的那份函数，
而不是测试里重抄一遍。

**fixture 抓出的两个真分歧**：
1. **Android 的 `org.json` 会把 `/` 转义成 `\/`**，而 JS `JSON.stringify` 不转义 ——
   同一条含 URL 的消息在两端导出的文件不同。已改为自己实现与 JS 语义一致的序列化
   （只转义 `"`、`\`、控制字符；非 ASCII 与 emoji 原样输出）。
2. **键序不可能天然一致**：PC 直接 `JSON.stringify(messages)`，键序取决于存储对象的字面顺序；
   Android 的实体字段集与顺序都不同。因此改为**规范化投影**——
   导出是「可携带的对话记录」（`id → role → content → images → timestamp`，可选字段非空才输出），
   **不是备份**；完整备份走阶段 5 的 Backup V3 通道。
   > 这是 PC 侧的一处**行为变更**：`/export json` 不再输出原始存储记录的全部字段。
   > 取舍理由如上——两端 schema 不同，逐字段一致在物理上不可能。

**时间渲染刻意做成注入项**：`toLocaleString('zh-CN')` 依赖运行时 ICU 数据，两端未必逐字节相同。
结构由 fixture 锁定（注入固定 formatter），时间格式由各端自行实现并单测断言形状
（Android 默认 `yyyy/M/d HH:mm:ss`，与 Node 的 zh-CN 输出同形）。

**验证**：`ChatSessionExportGoldenTest` 7 项（转义 10 例、角色标签 4 例、Markdown 5 例、JSON 5 例）
+ `ShareUtilsTest` 2 项；fixture 24/24 连续 3 次稳定；Android 单测 **743 / 0**；
lint 0 Error；真机 API 26/31/34 各 28 tests 全过；`pnpm check` / `pnpm test` 通过。

### 3.1.14 S4-06 快捷设置面板改为本地读写（round 21）

**发现的真问题：面板在本地模式下是「假面板」。** `listLorebooks`、`listPresets`、
`getSessionLorebooks`、`getSessionPreset`、`setSessionLorebooks`、`setSessionPreset`
全部走 `notMigrated` —— 界面显示为空列表，**保存必然失败**。
「界面在、功能不在」比没有界面更糟：用户会以为是数据丢了。

**修复**：这些方法改为读写本地权威表 ——
世界书/预设取自 `local_lorebooks`/`local_presets`；
会话级绑定取自并写回 `local_sessions.lorebook_ids_json` / `preset_id`；
全局设置读写本地公共设置行。「只写本地」由**结构**保证：
`LocalChatRepository` 的依赖只有 `LocalStore` + 生成用例，不存在任何远程客户端。

**顺带补齐记忆的用户入口**（正落在完成定义的「记忆」上）：
- `patchSessionMemory` 此前也是 `notMigrated` → 面板**无法开关记忆或设置间隔**。
  新增会话级列 `memory_enabled` / `memory_mode` / `auto_memory_interval`
  （v2 尚未发货，直接并入 v2 迁移）。放在会话行而非记忆状态行，因为
  「已开启但还没生成内容」是合法状态。
- `summarizeMemory` 此前同样 `notMigrated` → 「立即总结」永远返回空。
  现复用 `LocalMemorySummaryService`，与自动触发共用 CAS/游标/事实语义，
  仅不受间隔与模式约束。

**测试暴露的两处自身问题**：
1. `getSettings` 我按 **section** 取行，但公共设置是 `(section, key)` 一行 ——
   同一 section 多行会互相覆盖，导致写入 `userName` 后读回为空。已改为按「段+键」定位。
2. 真机测试 `unsupportedCapabilitiesDegradeToActionableEmptyResults` 失败，
   原因是 `fetchVersionInfo`/`listGroups` 等**静默返回空值**而没有留下 `unsupportedNotice`。
   这正是「静默降级」——用户无法区分「真的没有」与「还没做」。
   已修**实现**（统一走 `notMigrated`），而不是放宽测试。

**记忆开关现在来自会话行**，因此自动触发在开关关闭时正确跳过；
新增用例锁定「关闭时跳过 + 手动仍可执行」。

**验证**：`LocalQuickSettingsTest` 6 项 + 真机 `quickSettingsReadAndWriteLocalTablesOnly`；
Android 单测 **750 / 0**；lint 0 Error；真机 API 26/31/34 各 **29 tests** 全过；
`pnpm check` / `pnpm test` 通过。

### 3.1.15 S4-04 消息翻译本地化（round 22）

**又是一处「按钮在、功能不在」**：`translate` 走 `notMigrated` → 译文永远为空，
`ChatViewModel.translate` 随即抛「翻译结果为空，请重试」。UI 上翻译菜单一直存在。

**实现**（与 PC `chatService.translate` 对齐）：同一系统提示词、同一采样参数
（temperature 0.3 / topP 0.9）、同一任务预算（`task = translation`，按输入字符数推导），
译文以**同 id 覆盖**写回消息的 `translation` 字段，**不产生新消息**。

**提示词单独抽成 `ChatTranslationPrompt` 并由 fixture 锁定**（5 个语言用例）——
提示词差异会直接变成译文风格差异，属于必须对齐的契约。

**fixture 立刻抓出一处我的过度设计**：目标语言为空时 PC 直接插值（产出「翻译成。」），
我却在提示词构造里加了默认值回退。**提示词构造必须是纯插值**，兜底只属于调用方的
`resolveTargetLang`。进一步对齐时还发现：PC 的 `|| '中文'` **只在空串回退**，
空白串是 JS 真值会被原样使用——用 `isBlank()` 更「合理」，但会让两端在特定配置下
给出不同提示词。已按 JS 真值语义实现并加注释说明为何不「顺手改好」。

**接线方式**：新增 `auxGateway`（辅助任务网关）与把 `memorySummaryProfile` 改名为
`activeProfileAndKey`（它同时服务记忆与翻译，原名已误导）。辅助任务与主生成分开注入：
主生成的流式管线不适用于「取一段文本就结束」的任务，且辅助任务必须能独立失败
而不干扰对话状态。

**错误路径同样锁定**：空译文与模型失败必须抛错且**不写入空译文**；
未配置连接给出可行动错误；目标消息不存在抛 `IllegalArgumentException`。

**过程记录**：真机全量一度报 `No connected devices`（三台模拟器掉线，非代码问题），
重启后 API 26/31/34 各 29 tests 全过。

**验证**：`ChatTranslationPromptGoldenTest` 4 项 + `LocalTranslationTest` 6 项；
fixture 25/25 连续 3 次稳定；Android 单测 **760 / 0**；lint 0 Error；
真机三档全过；`pnpm check` / `pnpm test` 通过。

### 3.1.16 S4-04 输入续写/润色本地化（round 23）

**第三处「按钮在、功能不在」**：输入栏的续写/润色按钮调用 `aiAssist`，
而它走 `notMigrated` 返回空串——点了没有任何反应。PC 侧有完整的共享实现
（`shared/chat-core/aiInputHelper.ts`，493 行纯函数），本轮移植并接线。

**移植范围**：`ensureUserPerspective`（剥离角色视角内容）、`normalizeContinueOutput`、
`extractTaggedResult`（唯一标签提取）、`parseContinueResult`（标签信封 + 中文占比判据）、
`classifyContinueFailure` / `shouldRetryContinueFormat`（可操作归因）、
`evaluateContinueLength` / `isAcceptableAfterLengthRepair` / `buildLengthRepairInstruction`、
`buildContinueSystemPrompt`（6 种组合）、`buildContinueContext`，
外加依赖模块 `continueIntensity.ts`（强度/长度档位与阈值）。

这一层每个判据都决定「模型输出能不能写回输入框」：放行角色视角内容会让用户误发角色的话；
放行英文分析会让输入框出现思维链残留；长度校验缺失会让半截正文被当成完整消息发出。

**fixture 抓出的两处问题**：
1. **又是引号美化**：我把 PC 的中文引号 `“”` 改成了直角引号 `「」`（上一轮 tokenizer
   也犯过同类错误）。这次只影响提示词正文，同样必须逐字对齐——已修正三处。
2. **fixture 自身保真缺陷**：`contextCases` 的 `input` 漏记了 `intensity`/`length`，
   导致「输入无法唯一决定期望输出」。补上后 Kotlin 侧才能正确转发（与上次 `hasRepair`
   属同一类问题，这是第 2 次在 fixture 输入侧丢区分）。

**接线**：续写用最近对话 + 系统提示构造上下文，**历史中的 `<thought>` 必须剥离**
（否则模型模仿角色视角，输出随后被整段清空——这正是原注释记录的实机现象）；
解析失败按归因重试一次；长度不合格走一次修复请求，仍不合格则**保留用户原输入并抛错**，
不写回半成品。

**自己修掉的一处实现缺陷**：初版在 `suspend` 函数里用了 `runBlocking` 去 collect 流——
阻塞线程且可能死锁。既然已是 suspend，直接 collect 即可。

**验证**：`ChatAiInputHelperGoldenTest` 8 项（含「英文分析 + 中文尾巴」端到端拒绝用例）；
fixture 26/26 连续 3 次稳定；Android 单测 **768 / 0**；lint 0 Error；真机三档 29 tests 全过；
`pnpm check` / `pnpm test` 通过。

### 3.1.17 A5 对话方向本地化（round 24）

**第四处「按钮在、功能不在」**：`regenerateDirections` 返回 `emptyList()` →
「下一步方向」的「换一批」永远失败（UI 侧收到空列表即显示「方向生成失败」）。
PC 侧有共享实现（`shared/dialogueDirections.ts`，207 行纯函数），本轮移植并接线。

**移植范围**：会话开关兼容解析（新字段优先，其次旧游戏主持字段）、
`<directions>` 载荷提取（**缺失或重复标签均判无效**，防止把分析过程当业务数据）、
全量校验（数量 / label 6–14 可见字符 / content 15–60 可见字符 / 三个倾向各一次 /
解释性前缀 / 重复度）、提示词构造（两种叙事模式各自的叙事身份约束）。

**校验策略是「全有或全无」**——这是本轮最值得记录的设计点：
只渲染 2 个方向会让用户以为第 3 个方向不存在，而不是知道生成失败了。
因此任一条件不满足即整组作废，并以专门的测试锁定「部分合法也整组作废」。

**其它细节**：
- 重复度判定用文本归一化（去空白/标点/大小写）+ 包含关系 + 字符集合 90% 重叠，
  不引入向量计算；
- 输出顺序**固定为 safe → explore → risky**，与模型给出的顺序无关（便于界面与断言）；
- 生成请求带温度 0.6（该档位在 PC 侧是专门为方向生成选的）；
- 方向**不落盘**：依附于某条助手回复、可再生成，属派生 UI 数据（与 PC 一致）；
- 首个响应不合法时按协议**重试一次**（模型偶尔写不满 3 个或写成解释性文本）。

**验证**：`ChatDialogueDirectionsGoldenTest` 6 项（含「部分合法也整组作废」与
「顺序与模型无关」两条自有用例）；fixture 27/27 连续 3 次稳定；
Android 单测 **774 / 0**；lint 0 Error；真机 API 26/31/34 各 29 tests 全过；
`pnpm check` / `pnpm test` 通过。

### 3.1.18 S4-04 用量诊断：先修「从来没有数据」（round 25）

**先验证上一轮的断言，结果它不成立。** 我写了一个扫描脚本，找出所有「单行返回空值/假」的
`override suspend fun`，结果发现 `usageRecords` 仍是静默空桩。这条断言错了，
所以我把它改成脚本化排查，而不是靠人工印象。

**更深的问题：用量从来没有被写入过。** `LocalStore.recordUsage` **没有任何生产调用者** ——
本地用量表始终为空。这意味着：
- 即使把 `usageRecords` 实现好，用量页也只会显示 0；
- 「只实现读取」在这里是假修复。

**因此本轮修的是三层**：
1. **写入链路**：生成终局时写入用量行（只记有正文的轮次——失败/取消没有产出，
   记进去会污染统计）；
2. **数据完整性**：PC 的用量以**可见字符**为主体（`inputChars/outputChars`），
   而本地表只存 token。新增 `input_chars`/`output_chars`（v2 未发货，并入 v2 迁移），
   并在生成用例中一次性算好字符数随结果带出——token 依赖端点是否上报，
   字符数始终可得。**不用 token 反推字符**：那会显示一个编造的数字。
3. **读取与汇总**：实现 `usageRecords`；修正 `usageSummary` 的两处真实缺陷 ——
   `today` 与 `total` 曾**完全相同**（今日统计实际没有生效），
   `count` 曾用 `listUsage(1).size` 计算（最多得 0 或 1，而不是总条数）。

新增 `UsageStats` 与区间查询（`usageStats` / `listUsageInRange`），
真实库、替身实现与 DAO 三处同步，与 PC `getSummary` 同口径。

**测试**：`LocalUsageDiagnosticsTest` 5 项 —— 成功轮次落库且字符数为**真实可见字符数**
（含 emoji 按码点计而非 UTF-16 单元）、失败轮次不污染统计、
`count` 为全部条数、`totalChars = 输入 + 输出`、记录按时间倒序且能解析出角色 id。

另外我一开始又写了一条恒真断言（`assertEquals(x, x)`），自查后改成真正的码点语义验证。

**过程中另一次自查**：`gradlew` 首轮 `connectedDebugAndroidTest` 报 `No connected devices`
（模拟器掉线），重启后 API 26/31/34 各 29 tests 全过。

**验证**：Android 单测 **779 / 0**；lint 0 Error；真机三档全过；
`pnpm check` / `pnpm test` 通过。

### 3.1.19 端到端验收重跑：发现并修复静默数据丢失（round 26）

**为什么重跑**：完成定义要求「关闭 PC 与 Relay 后能从创建会话到连续多轮、编辑、重生成、记忆、导出
完整运行」。此前那次实机走查发生在后续多项改动**之前**（上下文装配、记忆闭环、翻译、方向、用量、
候选语义），而「这条链路整体可用」不是「每个模块各有单测」能替代的。

新增 `Phase4AcceptanceWalkthroughInstrumentedTest`：在真实 Room 库 + 真实文件上串起全部用户动作，
模型调用按**提示词内容**分派（而不是固定脚本队列——辅助任务与主对话会竞争同一个网关，
队列顺序会随触发时机漂移，测试因此脆弱且难解释）。

**由此发现一个严重缺陷（静默数据丢失）**：
`local_messages.session_id` 对 `local_sessions.id` 是 `ON DELETE CASCADE`，而本库显式开启外键；
会话 DAO 的 upsert 用的是 `@Insert(onConflict = REPLACE)`。SQLite 的 `INSERT OR REPLACE`
**会先删除冲突行再插入**，于是级联触发——**用户改一次会话设置（预设/世界书/记忆开关）就删光整段对话**。
同类问题还有两处：`local_sessions.character_id` 与 `group_id` 是 `SET_NULL`，
角色或群组的 REPLACE upsert 会把相关会话的归属**静默置空**。

三处父表 upsert 已改为 Room 的 `@Upsert`（`ON CONFLICT DO UPDATE`，不删行、不触发外键动作），
并新增两条真实 SQLite 回归用例：`updatingSessionRowKeepsItsMessages`、
`updatingCharacterRowKeepsSessionOwnership`。

**这个 bug 的分布很说明问题**：它通过了编译、lint、785 个单测与全部既有仪表测试——
因为既有测试从不「先有消息，再改会话设置」。这正是完成定义要求端到端走查的原因。

**顺带修掉的第三处一致性问题**：本地 `swipe` 把「重生成」实现成**新建一条消息**，
而 PC 的候选语义是「同一条消息追加候选」。消息数量会进入导出、分页与上下文预算，
因此这不是风格差异。候选语义已抽到 `shared/chat-core/swipeCandidates.ts` 并 fixture 锁定，
PC 侧也改为消费同一实现。为支持该语义，生成用例新增 `persist=false`（只生成不落盘）。

**副产物**：`ChatJsonCodec`（与 JS 语义一致的最小 JSON 编解码器）。
`org.json` 有两个坑：Android 会转义 `/`（与 JS 不同），且它在 JVM 单测中未实现
（本项目已踩两次，表现为静默拿到 null）。候选持久化改用该编解码器后不再依赖平台实现。

**验收断言涵盖**：三轮对话落盘 → 编辑推进历史修订号（派生记忆失效）→
重生成**不新建消息**且留下两个候选 → 切换候选**不调用模型** → 自动记忆总结真实触发并落库 →
手动总结推进版本 → Markdown/JSON 导出包含全部消息 → 用量记录带真实字符数 → 翻译走辅助任务。

**过程记录**：验收测试本身迭代了 6 次才稳定（生成是异步的需轮询、自动与手动记忆的时序竞争、
断言字段写错、嵌套类可见性）。这些失败全部是**测试自身**的问题，但第 2 次迭代就暴露了上面的数据丢失。

**验证**：真机 API 26 / 31 / 34 各 **32 tests** 全过；Android 单测 **785 / 0**；lint 0 Error；
fixture **28/28** 连续 3 次稳定；`pnpm check` / `pnpm test` 通过。

### 3.1.20 本地模式文案守卫与两个「假守卫/真缺陷」（round 27）

**完成定义里有一条容易漏掉的要求**：「代码与导航中不存在旧伴侣模式回退入口」。
文案也是入口的一部分——扫出 6 条在本地模式下**已经错误**的文案并修正：

| 字符串 | 原文案 | 为什么错 |
|---|---|---|
| `msg_delete_session_confirm` | 「此操作会同步删除 PC 端数据」 | 本地模式没有连 PC；这句话会让用户以为数据被同步删除而不敢操作 |
| `chat_clear_confirm_desc` | 同上 | 同上 |
| `qs_subtitle` | 「设置会同步到 PC 端」 | 快捷设置面板已改为**只写本地**（round 21），文案与实现相反 |
| `qs_model_empty_fmt` | 「请确认 PC 端已配置 API 连接」 | 模型列表来自本机连接档案 |
| `usage_empty` | 「PC 侧未开启用量统计或未连接」 | 本地已有自己的用量记录 |
| `chat_tts_error` | 「PC 侧未实现 TTS」 | 朗读走本机 `ExoPlayerTtsPlayer` |

**新增 `LocalModeCopyGuardTest` 把人工排查固化为可重复检查**（禁止措辞清单 + 本地空态/估算标注断言）。

**在验证这条守卫时发现了更重要的东西——它一开始是个假守卫。**
第一次变异验证（把 `qs_subtitle` 改回「同步到 PC」）**测试没有失败**。排查后有两个原因：
1. 我把备份文件放在 `res/values/` 内，资源合并因解析 `strings.xml.bak` 而失败；
2. **更关键**：该测试直接读磁盘上的 `strings.xml`，而 Gradle 并不知道这个依赖——
   只改资源时测试被判定 `UP-TO-DATE`，**根本没执行**。
   「守卫看起来在跑，其实没跑」比没有守卫更危险。

已在 `build.gradle.kts` 用 `inputs.file("src/main/res/values/strings.xml")` 显式声明输入
（只声明输入即可，不需要 `upToDateWhen { false }` 让 789 个测试每次都重跑）。
重新验证：基线 4/4 通过 → 变异 → **1 条失败并给出具体字符串与措辞** → 还原后通过。

**端到端验收又暴露一个真缺陷**：手动「立即总结」可能被**在途自动任务的跳过结果**顶掉。
刚结束一轮对话时自动任务因「未达间隔」跳过，此时用户点「立即总结」会静默无反应。
PC 的实现明确处理了这一点（手动请求遇到自动任务的 `manual_mode` / `interval_not_reached`
跳过时**重跑一次**），而我移植时漏掉了这段。已按 PC 语义补回，并让验收测试正好走这条路径
（保留记忆开关、只调大间隔 → 自动以「未达间隔」跳过 → 手动重跑成功）。

**顺带明确**：`S4-02 精确 tokenizer 分支`的界面义务已完成——上下文用量文案改为
「…token，估算」，与 PC 的「提示词占用（估算）」同一约定，并由守卫测试锁定。

**验证**：Android 单测 **789 / 0**；lint 0 Error；真机 API 26/31/34 各 **32 tests** 全过；
`pnpm check` / `pnpm test` 通过。

### 3.1.21 A3b-2 世界书预算层（round 28）

**先确认影响面**：`ChatLorebookRetrieval` 与 `ChatLorebookRenderer` 已移植并有测试，
但**只有测试在用**——`ChatGenerationUseCase` 从不调用它们。也就是说：
用户在面板里能看到世界书绑定，生成时**一条都不注入**。这是当前最大的功能缺口。

A3b-2 需要多轮完成。本轮交付其中**纯函数地基——预算与分配层**（`ChatLorebookBudget`）：

| 能力 | 语义 |
|---|---|
| 分桶瀑布裁剪 | always 硬上限 40%（按 order 截断，且**不参与压缩**）；conditional 填充至 always+conditional ≤ 90%（无 detail 时可用满预算）；detail 用剩余 |
| 相关度优先填充 | 每条按排序依次尝试「全文 → 手写摘要」，避免低分短全文抢占预算 |
| 书级 cap | 每本书 tokenBudget 独立裁剪；`ignoreBudget` 不占书级预算；保留原始顺序 |
| 全局配额分配 | 部分书带预算时，未带书按带预算书均值对待；超出时按比例分配、最后一份吃剩余 |
| 压缩请求 | 按**注入位置**分组（不同位置永不合并），剩余预算按组权重占比分配 |
| 压缩缓存 | FNV-1a 键（条目编辑后天然失效）+ LRU 上限淘汰与命中刷新 |

**为了让 oracle 是生产实现而不是我在测试里重抄**：把 `lorebook.ts` 中原本私有的
`fitGreedy` / `fitRankedWithSummaries` / `fitLorebookBudgetByPriority` / `enforceBookBudgets` /
`hashString` 导出（它们本就是跨端契约的一部分），fixture 直接调用真实函数。

**fixture 抓到一个微妙的 JS 语义**：PC 的比较器 `b.score - a.score` 在 `score` 为 `undefined`
时返回 `NaN`，而 ECMAScript 规范把 `NaN` 比较结果视为 **+0（相等）**，
因此这类条目**保持原顺序**；Kotlin 侧若按 `0.0` 排序则会把它们排到末尾。
该输入在生产类型（`ScoredLoreItem.score` 必填）上**不可达**，因此
①夹具给出显式 score 而不覆盖它，②在 Kotlin 代码里写明「一旦 score 变成可选必须同步修改」——
避免后人「顺手改成 null 安全」而引入静默分歧。

**验证**：`ChatLorebookBudgetGoldenTest` 8 项（含 always 硬上限、ignoreBudget 必留两条
不变量用例）；fixture **29/29** 连续 3 次稳定；Android 单测 **797 / 0**；lint 0 Error；
真机 API 26/31/34 各 **32 tests** 全过；`pnpm check` / `pnpm test` 通过。

### 3.1.22 A3b-2 世界书触发匹配与统一评分（round 29）

在预算层之上交付**评分层**（`ChatLorebookScoring`），把候选条目变成带分数的条目：

| 能力 | 语义 |
|---|---|
| Markdown 去噪 | 围栏/图片/链接/HTML/行内代码/粗斜体/标题引用列表/分割线（对话文本用；递归条目内容不去噪） |
| 关键词边界匹配 | ASCII 用词边界（`cat` 不命中 `category`）；CJK ≥2 字用子串；**CJK 单字必须两侧都是边界** |
| 条目级命中计数 | 覆盖 `useRegex`、ST `/regex/flags`、`caseSensitive`、`matchWholeWords`；单词语上限 100 防刷屏 |
| 二级关键词 | `and_any` / `and_all` / `not_any` / `not_all` 四种 selectiveLogic |
| 词面重叠近似 | 无语义索引时用 CJK 双字滑窗 + ASCII 词的 Dice 系数填补 semantic 维度 |
| 实体增强 | 受控词表（角色名 + 词表 + 条目关键词）按词边界过滤出「最近被提及」的实体 |
| 统一评分 | `0.35×keywordHits + 0.35×semantic + 0.15×entity + 0.15×recency`，keywordHits = 0.5×coverage + 0.5×(1-e^-n) |

**把重复了 6 次的夹具缺陷变成立即失败**：`NaN`/`Infinity`/数组内 `undefined` 经 JSON 会变成 `null`，
产出「写进去与读回来不一致」的夹具——这类问题此前逐次修个案（记忆候选、输入审计、上下文候选、
世界书、百分位样本、本次语义字典）。现在在 `writeFixture` 写入前做可往返校验：
非有限数与**数组元素 undefined** 直接抛错，对象属性 undefined 允许（`toEqual` 恰好忽略它，
下游 Kotlin 读缺失键与 null 行为一致）。守卫上线后立刻照出 2 处既有的 `undefined` 数组/属性写法。

**本轮暴露的三个自身问题（全部由夹具照出）**：
1. **夹具工厂悄悄覆盖了用例意图**：`loreEntryForScoring` 把 `enabled` 硬编码为 `true`，
   于是「停用条目不入词表」这条用例实际测的是启用条目——**看起来在测，其实没测**。
   已改为尊重用例的 `enabled`。
2. **记录形状选了 Kotlin 读不了的那种**：`semanticByContent` 以「数组对」落盘，
   而 Kotlin 侧按对象读取 → 静默退化为「无真实语义」并走近似值。
   已在生成侧统一规范成对象。
3. **我自己写错了断言**：以为 `keywordMatch('雨', '下雨了。')` 为真；
   PC 的语义是「单字两侧都必须是边界」（防半个词误触发），夹具是对的、我错了。已按 oracle 修正。

**验证**：`ChatLorebookScoringGoldenTest` 11 项；fixture **30/30** 连续 3 次稳定；
Android 单测 **808 / 0**；lint 0 Error；真机 API 26/31/34 各 **32 tests** 全过；
`pnpm check` / `pnpm test` 通过。

### 3.1.23 A3b-2 世界书运行时触发管线（round 30）

**四层地基之上交付运行时**（`ChatLorebookRuntime`），世界书在 Android 上首次**真正能触发**：

条目收集 → 资格过滤（启停 / 生成类型 / 角色过滤）→ 按条目有效扫描深度取扫描文本
→ always / 关键词匹配 → 二级关键词（四种 selectiveLogic）→ 概率 → 递归
→ 全局内容去重 → 关键词通道 RRF → 统一评分 → 书级 cap → 分桶瀑布 → 按位置分发。

夹具用 PC **真实的 `executeLorebookRuntime`** 作 oracle，12 个用例覆盖空输入、位置分发、
扫描窗口（书级 vs 条目级）、四种二级逻辑、递归与 `preventRecursion`、内容去重、
资格过滤、概率 100/0、预算截断、手写摘要替代、书级预算。

**明确未覆盖的 6 项**（写进代码文档，避免让读者以为 Android 已与 PC 等价）：
词法/BM25 通道（模块已移植但未接入触发）、向量/语义通道、时效状态（sticky/cooldown/delay）、
包含组仲裁、诊断与影子快照、异步压缩请求（预算层仍会给出请求并原样回传）。
夹具因此让 PC 也走「无词法 provider」路径，比较的才是同一回事。

**夹具再次照出两个自身问题**：
1. **工厂漏补 `enabled`**：PC 的 `LoreEntry.enabled` 是必填布尔，省略即 `undefined` → falsy →
   运行时**静默跳过全部条目**，12 个用例的期望值全是空——看起来像「没有条目触发」，
   实际是「输入不合法」。补工厂默认值后才有真实结果。
2. **计数语义取错位置**：PC 的 `triggeredCount`/`triggeredEntryKeys` 都在**预算裁剪之前**（去重后），
   我最初用了裁剪后的 `kept`；另外 `bookBudgetDropped` 是「0 则缺省」而其余三个丢弃计数如实为 0。
   三处都已按 oracle 修正。

**验证**：`ChatLorebookRuntimeGoldenTest` 6 项（含递归链、`preventRecursion` 阻断、
停用书/条目跳过、概率 0 必失败、扫描窗口差异）；fixture **31/31** 连续 3 次稳定；
Android 单测 **814 / 0**；lint 0 Error；真机 API 26/31/34 各 **32 tests** 全过；
`pnpm check` / `pnpm test` 通过。

### 3.1.24 A3b-2 世界书接入装配器与生产路径（round 31）

**A3b-2 收口**：把运行时接进 `ChatContextBuilder` 的世界书分支，并打通生产数据路径。
至此世界书从「模块齐全但不生效」变为**端到端可用**。

**装配器落位（与 PC 逐字节一致，fixture 锁定）**：
运行时 → `ChatLorebookRenderer` 产出 `renderPlan` → 按 PC 的顺序落位：
`before_character` 拼在角色设定之前、`after_character` 拼在其后、`prompt_end` 追加到系统提示末尾
（注意这在 PC 里发生在分支内，因此**位于 `【角色设定】` 之前**）、`chat` 延迟到历史消息后按深度注入、
`authors_note_top/bottom` 与示例前后段各自落位。

**夹具抓出的三处偏差**（全部按 oracle 修正）：
1. **`prompt_end` 落位顺序**：我最初追加在角色设定之后；PC 在分支内追加 → 应在角色设定之前。
2. **裁剪前的 token 预留**：PC 会把 `chat` + `authors_note_bottom` 的 token **先计入**再裁剪历史，
   否则会裁得比 PC 少（实测差 11 token）。
3. **`bookBudgetDropped` 的「0 则缺省」语义**（上一轮已修，本轮再次确认）。

**新增 `ChatLorebookCompile`（canonical v2 → 运行时输入）**：本地库的世界书存的是 canonical v2 文档，
而运行时读的是已编译条目形状；**缺这一步运行时永远拿到空条目列表，且不抛任何异常**。
映射逐条对齐 `shared/lorebook/runtime/compile.ts`：`mode=constant → always`、
`budgetTier=supplemental → detail`、`keywords = primaryKeys + aliases`、
`insertion` 直接透传（渲染层据此分桶）并按它回填 `position/depth/role`。

**生产接线**：`LocalChatGenerationUseCase` 读取会话的 `lorebook_ids_json` 与本地世界书文档，
编译后传入装配器——世界书从此进入实际提示词。

**测试自身的一个反例值得记录**：端到端用例最初失败，排查后发现不是 bug——
条目的二级关键词是 `雨`（`and_any`），而我的扫描文本里没有「雨」，
因此运行时**正确地拒绝**了它。修的是测试输入，不是实现。

**验证**：`ChatLorebookCompileTest` 6 项（含「非 JSON 返回 null」与「编译后必须真能触发」的端到端链条）；
`ChatContextBuilderGoldenTest` 15 例装配（含世界书用例）；fixture **31/31**；Android 单测 **820 / 0**；
lint 0 Error；真机 API 26/31/34 各 **32 tests** 全过；`pnpm check` / `pnpm test` 通过。

### 3.1.25 辅助任务用量分离 + 三个真实缺陷（round 32）

**方案要求「记忆请求与正常聊天使用独立 task type 和用量记录」**。此前只有 `main` 会落库，
记忆总结与翻译虽然真的在调模型，用量页上完全看不到它们。

**做法**：记忆总结（`taskType=memory`）与翻译（`taskType=translation`）各自落一条用量记录，
并**排除在聊天汇总之外**——依据是 PC 的用量只来自聊天流（`streamController`），
记忆输入往往是整段对话，混进 `main` 会直接把「本会话聊了多少」抬高若干倍。
`UsageRecordDto` 增加 `taskType`（带默认值 `main`，否则解析 PC 返回的记录会因缺字段失败），
记录列表因此能显示任务类型；否则就是「记了没人看得见」。

**本轮由守卫照出的三个真实缺陷**：

1. **ID 插值写错导致用量永远写不进去**：`now` 是注入的时钟 lambda，
   写成 `"$now()"` 只会插值 lambda 本身 → 生成非法实体 ID → 被 `runCatching` **静默吞掉**。
   这与「记了等于没记」是同一类问题，只有「成功总结必须留下恰好一条 memory 记录」这种
   断言能照出来。
2. **自动记忆总结的竞态丢轮**：本轮触发时若上一次自动运行仍在飞行中，请求会被**合并**进旧运行，
   拿到「按旧状态判定」的 `interval_not_reached`；旧运行结束后再无触发，
   **最新一轮对话永远不会被总结**（用户可见症状就是「记忆不生效」）。
   已改为：策略性跳过时**重跑一次**（重跑按当前状态判定，间隔未达则照样跳过，不放大调用量）。
3. **记忆状态读取取到任意一行**：表上只有 `id` 主键、**没有 session 唯一约束**，
   裸 `LIMIT 1` 取到哪行不确定；取到旧版本时症状同样是「记忆不更新」且不报错。
   已改为按 `memory_version DESC, updated_at DESC` 确定化，并加测试锁定。

**方法论层面的一个教训（值得写下来）**：排查上面第 3 点时，我连续 6 次读到同一个断言失败，
差点把方向定错——实际是**我改了测试但编译失败**（诊断 lambda 里调了挂起函数），
残留的旧测试报告被当成了新结果。此后所有复跑循环都先校验构建状态、再解释报告：
「构建失败时结果不可信」。同理，真机测试共用一个库文件时只删主文件、
留下 `-wal`/`-shm`，造成过 `no such table: local_messages` 的偶发失败，已统一改用
`context.deleteDatabase()`。

**验证**：全量 Android 单测 **823 / 0**；真机 API 26/31/34 各 **32 tests** 全过，
且验收走查**连续 6 次复跑 6/6 通过**（修复前 1/4 偶发）；全量门禁连续两次通过；
fixture **31/31**；`pnpm check` / `pnpm test` 通过。

### 3.1.26 清掉旧伴侣模式回退入口（round 33，完成定义项）

完成定义原文要求：**「代码与导航中不存在旧伴侣模式回退入口」**。本轮按这条逐处核查，
发现它**并未真正满足**——不是「有意的可选功能」，而是三段**永远不会触发的死回退入口**：

| 位置 | 为什么是死的 |
|---|---|
| `StartupViewModel.init` 的后半段旧四态决策 | 前半段 `decideStartupStateLocal` 只返回 `LocalReady` / `NeedsLocalSetup`，两者都提前 `return@launch`，后面的 `loadStartupSnapshot` + `decideStartupState` **永不执行** |
| `StartupScreen` 的 `onNeedsPairing` → PAIRING、`onReadyWithoutActive` / `needsRepair` → CONNECTION_PICKER | 依赖上一条产出的 `NeedsPairing` / `ReadyWithoutActive` / `Ready(needsRepair)`，这些状态已不可能出现 |
| `NotificationRoutePolicy` 在会话通知落到 `ConnectionPicker` / `Pairing` | 依赖 `StartupDecision.READY_WITHOUT_ACTIVE` / `NEEDS_PAIRING`，导航层已不再赋值 |

**清理**：`StartupState` 收敛为 `LoadingLocalState / LocalReady / NeedsLocalSetup`；
删除 `decideStartupState`、启动决策对 `StartupSnapshot` 的使用（`StartupRepository` 保留——
用户主动发起的连接选择页仍在用）、`StartupDecision` 收敛为 `PENDING / READY`、
`NotificationRoute` 去掉 `ConnectionPicker`；通知深链不再有「会话通知落到配对页」的路径。
**PC 连接改为只由用户主动发起**（设置/会话/角色页的 `onOpenPairing`），配对能力本身保留
（阶段 7 主动同步需要）。

**守卫（已突变验证）**：新增源码级守卫——`composable(Routes.STARTUP)` 分发包内
不得出现 `Routes.PAIRING` / `Routes.CONNECTION_PICKER` / `Routes.CONNECTION_PROFILES`。
纯行为测试覆盖不到「分支存在但不可达」，而完成定义禁止的正是**入口存在**。
突变验证：临时把一条 `navigate(Routes.PAIRING)` 塞回启动块 → 守卫**如期失败**；
还原后 8/8 通过。另有编译期保证：穷尽 `when (state)` 无 `else`，一旦有人加回
`NeedsPairing` / `ReadyWithoutActive` 会直接编译失败。

**验证**：`StartupDecisionTest` 8 项、`NotificationRoutePolicyTest` 9 项；
Android 单测 **820 / 0**；lint 0 Error；真机 API 26/31/34 各 **32 tests** 全过；
fixture **31/31**；`pnpm check` 通过。

### 3.1.27 阶段 3 收尾核查：schema 基线与迁移守卫（round 34）

阶段 3 方案自身标注「实现与门禁通过」，本轮只核查它列出的收尾项。

**① 迁移基线是正确的**（这是阶段 3 最重要的技术资产）：
`QingyuLocalDatabase/1.json` = version 1、`local_memory_states` **6 列**；
`2.json` = version 2、**14 列**（恰好 = 6 + 阶段 4 新增的 8 列），版本与 `MIGRATION_1_2` 一致。
`MemoryMigrationAndCasInstrumentedTest` 用 `MigrationTestHelper.createDatabase(name, 1)`
从 `1.json` 造老库、再 `runMigrationsAndValidate(name, 2, …)` 与 `2.json` 校验 ——
**没有手写 DDL 漂移**，是真迁移校验。

**② 修掉一处误导性文档**：该测试的规则注释写着「缺少依赖时会被跳过（见 `hasMigrationHelper`）」，
但 `hasMigrationHelper` **在文件里根本不存在**，规则是立即构造的（依赖缺失会直接失败）。
虚假的「会跳过」说明会让人误以为校验可能静默失效；已改为准确描述，
并写明「条件跳过会把迁移校验变成假守卫」。

**③ 新增 `RoomSchemaExportGuardTest`（3 项）**，并按突变验证确定它**真实覆盖范围**：
- **能守**：`exportSchema = true` 仍开着；每个声明版本对应的 schema 文件存在
  （覆盖「关掉导出」「删/移 schema 目录」「schemaLocation 配错」）。
  突变验证：把 `exportSchema` 改成 `false` → 2 项断言如期失败。
- **不能守**：「文件是否已提交」。我最初按「提版本忘导出」设计守卫，突变验证时把
  `version = 2` 改成 `3`——**守卫却通过了**：Room 在编译期自己写出了 `3.json`（54138 字节，
  与 2.json 等长）。也就是说那条漂移在本地根本不会出现。已据此把注释改成如实声明覆盖范围，
  而不是留一个看起来更强、实则无效的守卫。

**④ 阶段 3 唯一真正未决项：schema 未纳入版本控制。**
`git status` 显示 `?? android/app/schemas/com.qingyu.companion.local.db.QingyuLocalDatabase/`
（未被 `.gitignore` 忽略）。**但这不能只提交 schema**：v2 schema 对应的建表代码
（`LocalEntities.kt` / `QingyuLocalDatabase.kt`）同样尚未提交，单独提交 schema 会让
HEAD 上的 schema 指向并不存在的表结构。工作区当前有 121 项未提交（80 改 / 40 新增 / 1 删），
跨多个阶段，提交范围与拆分方式应由用户/发布环节决定，因此本轮不动 git 状态，只如实记录。

**验证**：Android 单测 **823 / 0**；lint 0 Error；真机 API 26/31/34 各 **32 tests** 全过；
fixture **31/31**；`pnpm check` 通过。

### 3.1.28 向量层地基（round 35）：算法与条目侧纯函数

方案 S4-05 的最后一项「向量层接入」。Android 此前**没有任何向量能力**：
`shouldUseOverlapApprox` 那套词面重叠近似只是「无语义索引时的补偿」，不是向量检索。
本轮交付可 fixture 锁定的**两层地基**（接入层随后）：

**① `ChatVector`（对齐 `shared/chat-core/vector.ts`）**：余弦相似度 / L2 归一化 / 点积 / Top-K。
边界语义逐条对齐，且都是会**直接影响召回结果**的地方：
- 长度不匹配或任一为空 → `0`（不抛异常，避免一条脏数据毁掉整轮检索）
- 零向量 → 归一化返回原样、相似度按 `0`（PC 的 normA/normB 为 0 分支），而不是除零得 NaN
- `topK` **跳过维度不匹配的条目**（截断或补零会把无关内容算成高相似度）
- 同分**保持输入顺序**（JS 自 ES2019 起 sort 稳定；Kotlin `sortedByDescending` 同样稳定）
  —— 两端不一致会让「同分条目谁先注入」随机漂移

**② `ChatLorebookEmbedding`（对齐 `shared/lorebookEmbedding.ts`）**：语义资格、向量化文档构造、
指纹、失效集合 diff、长文切片、多片向量合并。
- 文档标签顺序固定（标题/关键词/摘要/正文），关键词跨主次字段去重且**保持首次出现顺序**
- 切片按 UTF-16 码元、越界截断（对齐 JS `slice`），**最后一片必须覆盖文档尾部**
  （只索引开头会让长条目后半段永远召不回来）
- 合并：含非有限值的分片**整片剔除**，维度不一致的丢弃

**一处刻意的取舍（写进代码注释）**：指纹在 PC 是 `JSON.stringify({eligible, document})` 字面量，
Android 侧**不追求逐字节相同**——向量索引按模型/提供方区分、本就不跨端同步。
两端共同保证的是不变量：当且仅当 (eligible, document) 变化时指纹才变化。测试断言该不变量
（7 种变化逐项验证），而不是伪造一个字节级契约。

**验证**：`ChatVectorGoldenTest` 8 项、`ChatLorebookEmbeddingGoldenTest` 7 项；
fixture 新增两组（`vector` 32 例、`lorebook-embedding` 37 例），总计 **33/33** 连续 3 次稳定；
Android 单测 **838 / 0**；lint 0 Error；真机 API 26/31/34 各 **32 tests** 全过；
`pnpm check` / `pnpm test`（3021 passed）通过。

**尚未接入（下一步）**：嵌入请求（模型端点 `/embeddings`）、向量索引持久化与检索、
阈值与向量空间兼容性判定。在那之前，手机端**仍只走词面重叠近似**，不要误以为已有向量召回。

### 3.1.29 向量层判定层（round 36）+ PC 侧共享化重构

**① 把判定逻辑提取到 `shared/chat-core/embeddingPolicy.ts`**。
原实现放在 `electron/ipc/embedding.ts`，而该文件依赖 Electron 运行时，
跨语言 fixture **无法把它当作 oracle**。按仓库既有规则（两端共用的逻辑归 `shared/`），
把纯判定函数提取为共享模块，PC 侧改为「引入 + 转出」以保持公开签名不变：

| 函数 | 判定后果（判错不会崩，而是静默行为差异） |
|---|---|
| `mapFactSearchHits` | 命中 id 是字符串下标；越界/非数字/空文本一律丢弃（旧索引在事实被裁剪后必然越界） |
| `isSemanticEligible` | 索引侧资格：只看 `priority` 与 `matchMode` |
| `vectorSpaceFromConfig` | 查询向量与索引必须同源；local 走 `id@version` 拆分 |
| `isVectorIndexCompatible` | 模型名/provider/modelId/modelVersion 三处不一致就必须重建索引 |
| `resolveSemanticThreshold` | 显式阈值优先；本地模型按评测表，未知模型回退 0.3 |
| `isEmbeddingConfigured` | 远端必须有 baseUrl，OpenAI 兼容还必须有 key，Ollama 不需要 |

**② 锁定一处 JS 切片怪癖**：`provider = local` 且模型串**没有 `@`** 时，
`lastIndexOf('@')` 返回 -1，于是 `slice(0, -1)` 丢掉最后一个字符——
`weird` 推出 `modelId='weir'`、`modelVersion='weird'`。这不是设计，是可观测行为；
两端不一致会让同一配置推出不同向量空间，导致索引被**反复误判为不兼容而重建**。
已按 PC 原样实现并 fixture 锁定。

**③ 同时保留两个语义不同的「资格」判定**，并在注释里写明差异：
`isSemanticEligible`（只看 priority/matchMode）与
`isLoreEntrySemanticEligible`（还要求条目启用且正文非空）。
混用会让「该索引的没索引」或「不该索引的进了索引」。

**验证**：`ChatEmbeddingPolicyGoldenTest` 9 项；fixture 新增 `embedding-policy`（62 例），
总计 **34/34** 连续 3 次稳定；Android 单测 **847 / 0**；lint 0 Error；真机三 AVD 各 **32 tests** 全过；
PC 侧因本次共享化重构重跑 `pnpm check` / `pnpm test`（**3022 passed**）全绿——
`electron/services/__tests__/embedding.test.ts`、`electron/ipc/__tests__/embeddingFacts.test.ts`、
`embeddingSemanticSearch.test.ts` 覆盖被移动的函数，转出后行为不变。

**仍未接入**：嵌入式模型端点的实际请求、向量索引持久化与检索、把语义命中接到记忆/世界书召回。
手机上目前**仍只走词面重叠近似**。

### 3.1.30 澄清向量层归属 + 补上 S4-05/S4-06 的可验证部分（round 37）

**① 一个重要的 scope 澄清（避免按过时清单无限扩做）**：
阶段 4 方案头部把「向量层接入」列为剩余项，但**总方案与阶段 6 §S6-05 明确把
Embedding 与语义检索归阶段 6**（远端 OpenAI-compatible/Ollama、本地移动端模型、
按 `model fingerprint + entity revision + chunk strategy version` 失效索引）。
阶段 4 对语义的要求只有一句：
「**embedding 不可用时，事实仍保存，语义检索降级到非向量路径**」。
因此前几轮移植的 `ChatVector` / `ChatLorebookEmbedding` / `ChatEmbeddingPolicy`
属于**阶段 6 的可复用前置**（已 fixture 锁定），而不是阶段 4 的欠账。

**② S4-05 降级要求此前**没有任何测试覆盖**。补齐 `ChatMemorySemanticFallbackTest`（4 项）：
- 无语义命中时事实**仍注入**（而不是整块记忆消失）；
- 有语义命中时以命中集合为准（优先级不颠倒，为阶段 6 接入预留）；
- 降级路径下系统提示/角色设定/历史消息**都还在**，不把整轮上下文打空；
- 事实不会因为缺少语义分数而被整批丢弃。

**③ S4-06「streaming 草稿不导致整表重组」**：实现本身已经正确
（草稿是独立 `item(key="streaming")`、消息用 `items(key = …)` 而非下标），
缺的是**守卫**：key 计算内联在 `ChatScreen` 里，一旦有人改成下标 key，
用户会看到整表闪动与滚动跳动，而编译期与常规门禁都不报错。
已把 key 提取为纯函数 [ChatTimelineKeys]（生产代码与测试共用）并加 6 项测试：
内容变化不改变 key、**插入新消息后旧 key 不平移**、跨会话 id 不撞 key、
草稿 key 与任何条目都不同、三类条目 key 空间隔离，
外加**源码级守卫**（列表必须使用共享 key 函数，不得内联重算）。
突变验证：把 key 改回内联 `when` → 守卫**如期失败**；还原后 6/6 通过。

**覆盖边界（如实标注，不用静态守卫冒充运行时测量）**：
本测试验证的是**机制**（key 稳定性 + 草稿独立性）。
「实际重组次数」需要 Compose UI 测试基建（`ui-test-junit4`）并在生产 UI 内埋计数钩子，
**目前未做**。

**验证**：Android 单测 **857 / 0**；lint 0 Error；真机 API 26/31/34 各 **32 tests** 全过；
fixture **34/34**；`pnpm check` 通过。

### 3.1.31 会话级预设接线（round 38）+ 本地超限阻断

**① 发现并修复：「会话级预设」从未接线**。S4-04 明确要求「会话级预设、人设、世界书和叙事模式」，
但 `LocalChatGenerationUseCase` 里**没有任何 `preset`**——装配器收到的预设恒为 null，
用户的预设（System Prompt / 越狱段 / 上下文上限…）**毫无效果且不报错**。
这是「功能在、接线不在」的又一例（前有 `recordUsage` 无调用者、世界书只在测试里用）。

修复：新增 `ChatPresetCompile`（`body_json` → 装配器输入）并在生成前按会话 `presetId` 读取。
字段 schema 属**阶段 5 §S5-03**，因此这里刻意保守：只取装配器会消费的字段、
**缺失取默认**、**未知字段忽略**、**坏 JSON 退化为「没有预设」而不是让整轮失败**
（camelCase 与 snake_case 两种写法都认，便于 S5-03 落地前后平滑）。
测试 `ChatPresetWiringTest`（5 项）含端到端断言：预设正文**确实出现在发给模型的请求里**。

**② 顺带补上 S4-02 的「本地阻断或降级」**：方案要求「**超出上下文前必须在本地阻断或降级，
不能只依赖供应商报错**」。历史由 `cropHistory` 按预算裁剪，但**非历史部分**本身可能超限，
那种情况裁历史救不回来。新增 `BuildResult.overflowTokens`，由 `LocalChatGenerationUseCase`
在发送前阻断，给出可行动的本地文案（含超出量与用量）与 `CONTEXT_OVERFLOW` 失败码。
测试 `ChatContextOverflowDetectionTest`（5 项）+ `LocalGenerationOverflowGuardTest`（2 项，
含**反向断言**：正常输入绝不能被误阻断）。

**③ 过程中修正了自己的两个错误判断**（值得记录）：
- 最初把溢出基准定义为 `maxContext − requestMaxTokens`，实测发现「模型输出上限(9081) >
  用户上下文上限(8192)」时该值变成 **0**，会把任何正常输入都判成超限。
  已改为按**输入池** `budgetBase` 判定（也就是装配器真正分配给输入的量）。
  至于「输出预留未被上下文夹住」本身是另一处隐患，需与 PC 对齐后再改，**不靠阈值掩盖**。
- 最初用「角色描述超长」构造超限，测试却不触发——排查后确认原因是**预设没接线**，
  而角色描述/世界书都受各自预算约束，唯一能撑爆输入池的现实输入恰是预设。
  两件事互为因果：预设接通后，该守卫才真正可达。

**验证**：Android 单测 **869 / 0**；lint 0 Error；真机 API 26/31/34 各 **32 tests** 全过；
fixture **34/34**；`pnpm check` 通过。

### 3.1.32 装配器接线审计 + 人设/角色默认解析链（round 39）

**① 系统性核对，而不是继续逐个撞见**。把 `ChatContextBuilder` 的全部输入字段
（Settings 12 / Session 10 / Character 11 / Chat 7 / Profile 4）与用例实际填充做对比，
结果触目：`SettingsSnapshot` 只填了 2 个字段，`SessionSnapshot` 的叙事模式/篇幅模式、
`CharacterSnapshot` 的系统提示/后历史指令/作者注释、`ChatSnapshot` 的近因与压缩缓存
**全部未接线**。已接线项只有：userName、activeModel、角色六字段、记忆三层、消息、
会话 id、世界书、预设（上轮）、人设（本轮）。

**② 人设接线 + 「会话覆盖 > 角色默认 > 全局默认」解析链**（S4-04 要求「会话级预设/人设/世界书」）：
- 人设：`session.personaId` → `character.defaultPersonaId` → `persona.isDefault`；
  填充 `personaInjection` / `userDescription` / `userPersona`。
- 预设：`session.presetId` → `character.defaultPresetId`（角色卡自带默认预设，此前被完全忽略）。
- 世界书：会话列表为空时回退到 `character.lorebookId`。
测试 `ChatPersonaWiringTest`（5 项）逐层断言解析链，含「角色默认优先于全局默认」这种半接线反例。

**③ 新增 `ChatBuilderWiringAuditTest`：把这类缺陷变成机械可查**。
它扫描装配器字段，要求每个字段**要么**在用例里被**有意义地**接线，**要么**登记在
`notWiredYet` 清单里写明原因与归属阶段（清单共 16 条，皆为缺持久化列/缺设置键/归阶段 5·6）。
于是「新增装配器输入却忘了接线」会立刻变红。

**守卫自身也被突变验证并修正过一次**：第一版只检查「字段名是否出现」，
突变测试把接线改成 `personaInjection = null` 后**守卫照样通过**——即被平凡满足。
已加强为「裸 `null` 不算接线」（仅 `useInstructTemplate` 因无判定来源而白名单放行）；
再次突变 → 守卫**如期失败**并指名 `[personaInjection, userDescription, userPersona]`，
还原后 3/3 通过。

**④ 已登记的未接线项（有名字、有原因，不是含糊的「以后再说」）**：
叙事模式与篇幅模式（会话表无列）、世界书近因窗口与压缩缓存（无列）、压缩摘要/范围（无列）
——这五项都需 **v3 迁移**；思考格式/对话示例位置与模式/上下文压缩开关（缺本地设置键，
且前三者是阶段 5 内容管理范围，预设级已生效）；角色系统提示/后历史指令/作者注释
（阶段 5 §S5-01 的角色卡扩展字段）；语义命中（阶段 6 §S6-05，阶段 4 只要求降级，已覆盖）。

**验证**：Android 单测 **877 / 0**；lint 0 Error；真机 API 26/31/34 各 **32 tests** 全过；
fixture **34/34**；`pnpm check` 通过。

### 3.1.33 v3 迁移：把「有输入、无处存」的字段落到库上（round 40）

审计清单里有 6 项卡在同一原因：**装配器有输入、本地却没有列**。本轮做 v3 迁移并接通闭环。

**新增列（`local_sessions`，全部带 DEFAULT，不重建表）**：
`narrative_mode`、`response_length_mode`、`recent_triggered_ids_json`、
`lorebook_compression_cache_json`、`compressed_summary`、`compressed_range_json`。
`version = 3` + `MIGRATION_2_3`，Room 自动导出 `3.json`（`RoomSchemaExportGuardTest` 已按源码推导，
自动覆盖 v3）。

**迁移测试（真机，`MigrationTestHelper` + 导出 schema）**：
- `migrationFromV2KeepsExistingSessionAndAddsSessionLevelColumns`：v2 建库写入会话 → 升 v3 →
  旧行存活、旧列（记忆策略）不变、6 个新列取默认值；
- `migrationFromV1ToV3AppliesBothStepsInOneGo`：长期未升级的用户 v1 直升 v3，两步依次生效。

**接通读写闭环**（有列 ≠ 有闭环）：
- **读**：叙事模式/篇幅模式/压缩摘要/压缩范围 → 会话快照；近因窗口与压缩缓存 → 装配器输入；
  六个 JSON 解析都做了「坏数据退化」处理（一条脏 JSON 不得毁掉整轮生成）。
- **写**：装配器新增透出 `lorebookTriggeredEntryKeys`（此前只在内部使用），
  由 `GenerationOutcome` 带到仓库层，成功落盘后 `appendSessionRecentTriggered` 推进近因窗口。
  **这是关键闭环**：没有它，`ChatLorebookRuntime` 的 recency 加权永远是 0
  ——运行时早就支持该输入，只是一直没有数据来源。窗口长度取自
  `ChatLorebookScoring.RECENCY_WINDOW`，避免写入侧与读取侧口径漂移。

**接线审计再次发挥作用**：接线后我没有同步清理 `notWiredYet` 清单，
`ChatBuilderWiringAuditTest` 的「清单腐烂检查」**如期变红**（`deferredListEntriesCarryReasonsAndAreNotStale`），
强制我删除已接线的 6 条——守卫的双向性（漏接线报错、清单过期也报错）得到验证。

**验证**：Android 单测 **883 / 0**；lint 0 Error；真机 API 26/31/34 各 **34 tests**（新增 2 条迁移用例）全过；
fixture **34/34**；`pnpm check` 通过。

### 3.1.34 会话级叙事模式的写入方与 UI 入口（round 41）

v3 迁移加出了 `local_sessions.narrative_mode`，但**列存在只是必要条件**：
没有写入方，列永远是默认值，用户根本无从切换「代入式 / 全局叙事」。

**仓库 API**：`ChatRepository.patchSessionRuntimeState(narrativeMode, responseLengthMode)`
+ `getSessionNarrativeMode`。接口**默认实现明确失败**（`501 当前数据源不支持…`）而不是静默成功
——PC 伴侣模式没有这两个端点，静默成功会让用户以为设置生效了，正是本阶段反复出现的
「按钮在、功能不在」。只有本地权威库覆写。写入前做**白名单校验**，非法值一律拒绝，
避免脏值落库后被装配器当成有效模式。

**UI 入口**：快捷设置面板新增「叙事模式」选择行（代入式 / 全局叙事），
复用记忆开关同款的乐观更新与错误回填，新增 4 条 `qs_narrative_mode*` 文案。

**守卫再次抓到半接线**：新增的 `sessionRuntimeStateHasAWriterNotJustAColumn` 要求
「写入方必须同时存在于仓库实现与 UI 入口」，它立刻报出**面板没有读取当前值**——
排查发现我先前那次插入被换行差异吞掉了，选择器会永远显示未选中。
这正是「守卫比人可靠」的又一例：UI 代码不会被常规门禁覆盖，静态守卫是唯一低成本防线。

**闭环证据**：`SessionNarrativeModeWriteTest`（4 项）断言
写入往返（写进去→读出来→确实落库）、局部更新不互相覆盖、非法值被拒绝且不落库，
以及**切换叙事模式确实改变了发往模型的请求**（否则切换就是空转）。

**验证**：Android 单测 **888 / 0**；lint 0 Error；真机 API 26/31/34 各 **34 tests** 全过；
fixture **34/34**；`pnpm check` 通过。

### 3.1.35 按任务清单逐条验收：找出并修掉脱敏未接线（round 42）

本轮不再凭印象找活，而是把阶段 4 方案的 **S4-01…S4-06 完整清单**逐条对证据。结果：

**已满足（有证据）**：S4-01 八个模块（fixture 34 组 + 各 Kotlin golden 测试）；
S4-02 启发式估算同口径 + 不支持时标注 estimated + **本地阻断**（round 38）；
S4-03 状态机与 taskId/requestId 重试分离、chunk 节流后一次性落盘；
S4-04 全部消息操作 + 会话级预设/人设/世界书/叙事模式（rounds 38–41）+ 导出 + 用量诊断；
S4-05 记忆闭环五项（含独立 task type、CAS、降级路径）；
S4-06 稳定 key（round 37）、状态标签、无旧回退入口（round 33）、面板只写本地。

**一处真实缺口并已修复：`ChatDomainErrors.sanitizeErrorMessage` 没有生产调用者**。
它是 S4-06「错误提示…**不暴露供应商原始敏感响应**」的实现，却只被 fixture 测试调用；
而 `ModelError` 的 `PROVIDER_ERROR` 分支 message **直接取自供应商响应体**
（适配器 `extractJsonString(json,"message") ?: json.take(200)`），
`toUserMessage()` 对未知码原样返回 —— 于是响应体（可能回显请求内容、含 key 与绝对路径）
会被原样显示给用户。

修复落在**展示边界**（而不是改 `ModelError`，那会让 network 层反向依赖 chatcore）：
生成失败文案与连接测试失败文案两处统一脱敏。测试 `ProviderErrorSanitizationTest`（5 项）
断言 API Key / Windows 路径被剥离且保留可读原因、已知码的中文可行动文案不被改坏，
并加**源码级守卫**要求两个展示点确实调用脱敏（防再次退化为「有实现没人用」）。

**一处经核查判定为「已满足，无需改」**：`ChatGenerationTask.recover()` 同样没有生产调用者，
但重新核查后确认**任务状态不落盘**（消息行只在结束时写入一次，不存在 streaming 占位行），
且全流程没有任何自动重发路径 —— 因此「进程死亡后不自动重发、避免重复计费」这一要求
**由构造满足**。`recover()` 只在任务被持久化的将来才有意义，此处如实记录而非为它造活。

**验证**：Android 单测 **893 / 0**；lint 0 Error；真机 API 26/31/34 各 **34 tests** 全过；
fixture **34/34**；`pnpm check` 通过。

### 3.2 守卫有效性验证（证明不是空跑）

- round 1：`ChatTokenCounter` 默认 `chPerEnTok` 由 `3.4` 改 `3.5` → `tokenEstimateMatchesGolden FAILED`。
- round 2：`ChatLorebookRetrieval` 的 BM25 `k1` 由 `1.2` 改 `1.3` → `lexicalSearchMatchesGolden FAILED`。
- round 3：`ChatContextShared.IMAGE_TOKEN_ESTIMATE_FOR_CROP` 由 `200` 改 `500` → `contextCropMatchesGolden FAILED`。
- round 4：`ChatContextCandidates.HIGH_RELEVANCE_THRESHOLD` 由 `0.5` 改 `0.6` → `contextCandidatesMatchGolden FAILED`。
- round 5：`ChatWorldbookCandidates.WORLDBOOK_ALWAYS_IMPORTANCE` 由 `0.9` 改 `0.8` → `worldbookCandidatesMatchGolden FAILED`。
- round 6：`ChatResponsePolicy.AUTO_HARD_MAX_CHARS` 由 `900` 改 `1200` → `responsePolicyMatchesGolden FAILED`。
- round 7（两处）：闸门 `claim(user_cancel)` 改为一律进 `finalizing` → `generationTerminationMatchesGolden FAILED`；
  `ChatGenerationTask.recover()` 把 `interrupted` 标成可重试 → `timeoutIsRetryableWhileInterruptedIsNot FAILED`。
- round 8：`failureCodeForCause("transport_error")` 由 `PROVIDER_UNAVAILABLE` 改 `PROVIDER_TIMEOUT`
  → `reasonCodesMapToDomainErrorTaxonomy` + `transportErrorIsRetryableAndKeepsBody` 同时 FAILED。
- round 9：`sendMessage` 失败分支不再 emit `CompanionEvent.Error` →
  `sendMessageFailurePropagatesActionableErrorAndEmitsErrorEvent FAILED`。
- round 10：入口切换未做变异（属装配而非算法）；真机验收以「用例在真实 Room 库上执行」作为有效性证据。
- round 13：记忆事实未做变异；守卫来自 fixture——`updatedAt = 0` 的 recency 分歧
  是「Kotlin 只判 null、PC 判 falsy」这类跨语言语义差，只有逐值比对能发现。
- round 12：无新增变异。本轮的守卫来自**实机走查**——两个真 bug（旧远程回退入口、生成卡死）
  都是单测、lint、编译全绿时依然存在的，说明「门禁全绿」不等于「用户可用」。
- round 11：状态标签未做变异（纯文案映射，12 例穷举已足够）；
  反而在自查中发现并删除了一处**自证式断言**（`assertEquals(x, expr.let { x })` 恒真），
  说明「补测试」本身也需要审查，不能只看用例数增长。

十次变异均被捕获，随后均已还原。

---

### 3.1.36 S4-04 动作清单 UI 可达性 + journal 覆盖（round 43）

按方案 S4-04 的动作清单逐项核查「**功能是否从界面可达**」（而不是只看实现是否存在）：

| 动作 | UI 入口 | 动作 | UI 入口 |
|---|---|---|---|
| 创建会话 | SessionsScreen → createSession ✓ | 编辑/删除消息 | ChatScreen ✓ |
| 发送/停止 | ChatScreen / ChatInputBar ✓ | 分支 | ChatScreen ✓ |
| 失败重试 | ChatInputBar ✓ | 翻译/复制/朗读 | 消息操作菜单 ✓ |
| regenerate / swipe | ChatScreen ✓ | 引用 | setReplyTo ✓ |
| 输入续写 / 润色 | ChatScreen ✓ | 清空对话 | ChatScreen ✓ |
| 会话级预设/人设/世界书 | 快捷设置面板 ✓ | 叙事模式 | 快捷设置面板 ✓（round 41） |
| 导出 Markdown/JSON | ChatScreen ✓ | 上下文用量/诊断 | ChatScreen ✓ |

**结论：无「实现存在但界面不可达」的动作**（负向结论同样值得留证：此前多轮都在找「按钮在、功能不在」，
这一轮确认反方向也没有缺口）。

**journal 覆盖**：所有会话/消息操作都经 `store.*` 写入，`LocalRepositoryContractTest`
与 `LocalDatabaseRoomTest` 断言「业务行 + entity_heads + change_log 同事务」、
删除写 tombstone 且 journal 保留，两套实现（Fake / Room）跑同一行为表。

**完成定义第一步可达性**：定义要求「**从创建会话**…」，本地模式下该入口确实存在
（`action_new_session` 文案 + `SessionsViewModel.createSession` → `repository.createSession`），
前提仍是「已存在角色」（阶段 5 §S5-01，见 §4）。

### 3.1.37 阶段 4 完成定义核对（结论）

| 子句 | 证据 |
|---|---|
| 关 PC/Relay 后从建会话到多轮/编辑/重生成/记忆/导出完整运行 | 真机走查（API 26/31/34 各 34 tests 全过）用**真实 Room 库 + 脚本化网关**，全程无 PC/Relay；创建会话另有 UI 入口（本页 §3.1.36） |
| 对照 fixture 无未解释差异 | fixture **34/34** 连续 3 次稳定；全部 Kotlin golden 测试通过；**0 跳过**（JVM 与真机均无 `@Ignore`/`Assume`） |
| 代码与导航中不存在旧伴侣模式回退入口 | 已删除三段死回退入口并加**源码级守卫**，突变验证通过（§3.1.26） |

S4-01…S4-06 清单逐条核对完成（§3.1.35/3.1.36）；剩余项均已定性为「属后续阶段」或「需用户/发布决策」，
见 §4。

## 4. 未完成与风险（当前状态）

> 本节按**当前真实状态**重写：早期版本列出的 S4-01 余项、S4-02 tokenizer 决策、
> 快捷设置面板仍走 PC 同步等，均已在后续轮次完成，不再列为未完成。

1. **streaming 不导致整表重组：机制已满足并守卫，动态测量未做**。
   生产代码结构正确（草稿是独立 `item(key="streaming")`、消息用 `item(key=…)`），
   `ChatTimelineKeysTest` 锁定 key 稳定性与插入不平移，并有源码级守卫。
   但「实际重组次数」需要 Compose UI 测试基建（`ui-test-junit4`）与生产 UI 内的计数钩子，
   **本项目未引入**，因此这是「机制已验证、测量未做」，不冒充运行时证据。
2. **角色管理属阶段 5 §S5-01**（职责已厘清，不是阶段 4 缺陷）：全新安装时本地无角色，
   阶段 4 完成定义以「已存在角色」为前提；该前提已在 §3.1.7 与 §3.1.37 如实标注。
3. **`OnlineChatRepository` 未删除**：已从生产装配摘除；彻底删除需连同发件箱/远程聊天机制处理，
   属阶段 6/7（总方案 §9.3 删除清单）。
4. **向量/语义检索属阶段 6 §S6-05**：阶段 4 只要求「embedding 不可用时事实仍保存、
   降级到非向量路径」（已由 `ChatMemorySemanticFallbackTest` 覆盖）。
   已提前交付并 fixture 锁定的**可复用地基**：`ChatVector` / `ChatLorebookEmbedding` /
   `ChatEmbeddingPolicy`（含 `vector` 与 `embedding-policy` 两组夹具），以及 v3 里的
   `lorebook_compression_cache_json` 列。
5. **仍缺写入方的 v3 列**：`compressed_summary` / `compressed_range_json` 有列、有读路径，
   但**没有异步压缩服务**去写（PC 由调用方异步压缩后回写缓存）。属阶段 5/6 范围。
6. **全局设置键缺失**：叙事模式默认值 / 思考格式 / 对话示例位置 / 上下文压缩开关在本地
   尚无设置键（`PublicSettingKey` 未定义），因此这些「全局设置」不生效；
   **预设级同名项已生效**。角色卡扩展字段（系统提示 / 后历史指令 / 作者注释）同属阶段 5 §S5-01
   （`extensions_json` 的 schema 待定）。
7. **PC 侧存在两个同名 `IMAGE_TOKEN_ESTIMATE`（需确认）**：`chatConstants.ts` 为 **200**
   （被 `cropHistory`/`historyDegradation` 使用），`tokenCounter.ts` 又定义同名 **500**
   （被 `estimateImageTokens` 使用）。Kotlin 按**调用点分别对齐**以保持两端一致，
   但两处口径不一致本身是缺陷，建议由契约负责人确认保留哪一个。
8. **fixture 语料必须随用例自带**：`context-crop` 首版把语料放在文件级，导致「带图」用例
   实际跑在无语料上（Kotlin 全绿但结论错误）。已改为每用例自带 corpus，后续新增 fixture 一律遵守。
9. **正则语义差异的边界**：`JsRegex` 覆盖本项目用法（`g`/`i`/`m`/`s`/`u` + `$` 替换串），
   未实现 JS 全部边界（`y` 粘滞真实语义、`d`/`v` 标志、Unicode 属性转义）。后续若引入须先扩展并补 fixture。
10. **未提交项（需用户/发布决策）**：工作区仍有大量未提交改动，其中
    `android/app/schemas/com.qingyu.companion.local.db.QingyuLocalDatabase/`（1/2/3.json）
    为**未跟踪**且未被 `.gitignore` 忽略。注意**不能只提交 schema**——v2/v3 schema 对应的建表代码
    同样未提交，单独提交会让 HEAD 上的 schema 指向不存在的表结构；提交范围应由用户决定。
11. **`shared/chat-core/generatedReplyPipeline.ts` 存在非本轮改动**：工作区已有未提交修改
    （移除 `provider_length` + `notice === 'trimmed_to_boundary'` 的提示）。该改动**不是本轮引入**，
    按「不覆盖工作区既有修改」保留；fixture 以当前工作副本为 oracle。

---

## 5. 下一阶段输入（继续阶段 4）

- 已可用的 Kotlin 等价模块（25 个，另有 S4-04/S4-06 装配类）：`JsRegex`、`ChatVariables`、`ChatMacros`、`ChatRegex`、`ChatPromptConverters`、
  `ChatMessagePostProcess`、`ChatTokenCounter`、`ChatLorebookRetrieval`、`ChatLorebookRenderer`、`ChatMemoryWindow`、
  `ChatContextShared`（cropHistory/applyDepthInserts）、`ChatInputAudit`、`ChatHistoryDegradation`、
  `ChatContextCandidates`（净化/评分/四级 tie-break/去重/确定性预算分配）、
  `ChatWorldbookCandidates`（条目候选化 + 既有注入统计 + 专项影子报告）、
  `ChatResponsePolicy`（可见字符/中位数/意图识别/场景系数/模式与策略解析/主对话输出约束）、
  `ChatGenerationTermination`（终止原因推导/提示文案/一次性闸门）、`ChatDomainErrors`（域错误分类与脱敏）、
  `ChatGenerationTask`（S4-03 生成任务状态机）、`Ulid`（ID 契约）、`ModelGateway`（模型调用抽象）、
  `LocalChatGenerationUseCase`（S4-04 发送→流式→落盘闭环）、
  `LocalChatRepository`（S4-06 本地优先仓库，实现 UI 接口 `ChatRepository`）、
  `ChatMemoryFacts`（S4-05 事实解析/规范化/变更与提案应用）、
  `ChatMemoryRanking`（S4-05 最近性/评分/预算/分层/格式化）。
- 阶段 4 剩余顺序：S4-05 记忆闭环余项（触发决策 + CAS 落盘 + 独立用量）
  → S4-06 余项（快捷设置只写本地、Compose 重组验证）→ S4-04 余项
  → `contextBuilder` 主装配（角色创建由阶段 5 承接，已在验收前提中声明）；Chat Core 侧则继续 `narrativeMode` + `thoughtContract` + `chatTemplates`（提示词构建）
  → `memory.ts` 分层预算与事实格式化 → `contextBuilder` 主装配 → `generatedReplyPipeline` 终止收尾。
- 每个模块先补 fixture（TS 生成 + Kotlin 校验）再接线到用例层；注意 `runtime.revision` 是书级字段，
  以及 `NaN/Infinity` 必须走字符串哨兵。
- S4-03 状态机、S4-04 生成闭环、S4-06 本地仓库均已交付；S4-06 的 UI 装配与实机验收、S4-04 余项、S4-05 记忆闭环是下一步。
