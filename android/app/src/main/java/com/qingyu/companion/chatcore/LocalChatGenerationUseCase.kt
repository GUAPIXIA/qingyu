package com.qingyu.companion.chatcore

import com.qingyu.companion.local.db.LocalMessageEntity
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.network.models.ChatMessageDto
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelError
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.network.models.ModelRequestHandle
import com.qingyu.companion.network.models.ModelStreamEvent
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.flow

/**
 * 阶段 4 S4-04：单聊「发送 → 流式 → 落盘」用例。
 *
 * 这是阶段 4「独立单聊生成闭环」的最小可运行路径：
 * **不依赖 PC**，本地写用户消息 → 本地直连模型 → 流式累积 → 终局落盘。
 *
 * 事务与状态边界（阶段 4 §1「明确事务边界」「未验证完成结果不得提前保存为成功消息」）：
 * 1. 用户消息**立即**写 Repository（乐观状态：本地写入不等待网络）；
 * 2. 流式 chunk 只进 [ChatGenerationTask.Machine] 的草稿缓冲，不产生任何房间写入；
 * 3. 只有终局（completed / cancelled 且有正文）才一次性写 assistant 消息；
 *    失败与空输出**不创建空消息**，错误只进 `generationError` 字段。
 *
 * 依赖全部可注入，因此本用例可在无网络、无 Device 的环境下完整测试。
 */
class LocalChatGenerationUseCase(
    private val store: LocalStore,
    private val gateway: ModelGateway,
    /** 连接档案（只含非秘密字段；provider/baseUrl/model/allowHttp） */
    private val profileProvider: suspend () -> ConnectionProfilePublic?,
    /** API Key 读取（生产来自 Keystore 包装；测试注入固定值）。两者都读库/Keystore，故为 suspend。 */
    private val apiKeyProvider: suspend () -> String? = { null },
    /** ID 生成器（生产 ULID；测试确定性序列） */
    private val idFactory: () -> String = { Ulid.newId() },
    private val now: () -> Long = { System.currentTimeMillis() },
    /** Android 侧读取上限（装配器的 token 预算裁剪才是权威口径）。 */
    private val historyLimit: Int = ANDROID_HISTORY_READ_CAP,
) {

    /** 流式过程中向 UI 暴露的增量事件。 */
    sealed interface Delta {
        /** 任务已就绪（用户消息已落盘） */
        data class Started(val taskId: String, val requestId: String, val userMessageId: String?) : Delta

        /** 正文增量（节流后由 UI 追加） */
        data class Chunk(val text: String) : Delta

        /** 终局（含提示与是否落盘） */
        data class Finished(val outcome: GenerationOutcome) : Delta
    }

    data class GenerationOutcome(
        val taskId: String,
        val requestId: String,
        /** 状态机终态：completed | cancelled | failed */
        val status: String,
        /** 失败码（failed 时非空；如 TASK_INTERRUPTED / PROVIDER_TIMEOUT） */
        val failureCode: String?,
        val retryable: Boolean,
        val terminationCause: String,
        /** 提示字段与文案（不拼入正文） */
        val noticeField: String?,
        val noticeText: String?,
        /** 已落盘的 assistant 消息 id（未落盘为 null） */
        val assistantMessageId: String?,
        val userMessageId: String?,
        val content: String,
        val usage: Map<String, Int>,
        /**
         * S4-04 用量诊断：本轮发送给模型的**可见字符数**（全部消息正文之和）。
         * token 依赖端点是否上报 usage，字符数始终可得，因此用量记录以它为准。
         */
        val promptChars: Int = 0,
        /** 本轮产出的可见字符数（落盘正文）。 */
        val outputChars: Int = 0,
        /**
         * 本轮世界书实际触发的条目 key。调用方据此推进会话**近因窗口**；
         * 不落盘的话，运行时的 recency 加权永远是 0。
         */
        val lorebookTriggeredEntryKeys: List<String> = emptyList(),
    ) {
        val persisted: Boolean get() = assistantMessageId != null
    }

    /**
     * 最近一次落盘的 assistant 消息 id。
     * 供 `ChatRepository` 适配层在终局后取回真实消息（`sendMessage` 需要返回落盘实体）。
     */
    @Volatile
    var lastAssistantMessageId: String? = null
        private set

    /**
     * 只落盘用户消息，不触发生成；返回消息 id（空文本返回 null）。
     *
     * 为什么要拆出来：发送契约要求「用户消息立即落盘并返回，生成随后异步进行」，
     * 而 [generate] 内部会在落盘后再读历史组装请求。拆开后调用方可以先拿到用户消息、
     * 再以 `userText = null` 调用 [generate]，历史仍天然包含本轮输入。
     */
    suspend fun appendUserMessage(sessionId: String, text: String): String? {
        val content = text.takeIf { it.isNotEmpty() } ?: return null
        val session = store.getSession(sessionId) ?: return null
        val id = idFactory()
        store.appendMessage(
            LocalMessageEntity(
                id = id,
                sessionId = sessionId,
                characterId = session.characterId,
                role = "user",
                content = content,
                logicalTime = now(),
                seq = -1,
                createdAt = now(),
                updatedAt = now(),
            ),
        )
        return id
    }

    /**
     * 生成一次单聊回复。
     *
     * @param userText 非空时先落盘用户消息；为空时用于 regenerate/swipe（不新增用户消息）
     * @param profile 显式档案；为 null 时向 [profileProvider] 现取（读库，故在协程内解析）
     * @param persist 是否把产出落盘为**新消息**。重生成（swipe direction=0）必须传 false：
     *   PC 的候选语义是「同一条消息追加候选」，新建消息会让两端消息数量不同。
     */
    fun generate(
        sessionId: String,
        userText: String?,
        profile: ConnectionProfilePublic? = null,
        apiKey: String? = null,
        persist: Boolean = true,
    ): Flow<Delta> = flow {
        val effectiveProfile = profile ?: profileProvider()
        val effectiveApiKey = apiKey ?: apiKeyProvider()
        // 每次生成只分配**一个**业务 ID 作为任务标识；requestId 由 taskId 派生，
        // 保证「逻辑重试换新 requestId、网络重试保持」的语义同时不额外消耗 ID 序列。
        val taskId = idFactory()
        val machine = ChatGenerationTask.createMachine(taskId) { id -> "$id#retry" }

        // ---- 1. 会话与角色校验（不合法直接失败，不写任何数据） ----
        val session = store.getSession(sessionId)
        if (session == null) {
            emit(
                Delta.Finished(
                    failure(
                        machine,
                        cause = "unknown",
                        code = "SESSION_NOT_FOUND",
                        message = "会话不存在",
                    ),
                ),
            )
            return@flow
        }
        if (effectiveProfile == null) {
            emit(
                Delta.Finished(
                    failure(machine, cause = "unknown", code = "INVALID_COMMAND", message = "未配置模型连接档案"),
                ),
            )
            return@flow
        }

        // ---- 2. 用户消息立即落盘（本地优先） ----
        val userMessageId = userText?.takeIf { it.isNotEmpty() }?.let { text ->
            val id = idFactory()
            store.appendMessage(
                LocalMessageEntity(
                    id = id,
                    sessionId = sessionId,
                    characterId = session.characterId,
                    role = "user",
                    content = text,
                    logicalTime = now(),
                    seq = -1,
                    createdAt = now(),
                    updatedAt = now(),
                ),
            )
            id
        }

        if (!machine.prepare()) {
            emit(Delta.Finished(failure(machine, "unknown", "UNKNOWN", "任务状态异常")))
            return@flow
        }
        emit(Delta.Started(machine.taskId, machine.requestId, userMessageId))

        // ---- 3. 组装请求（**用户消息落盘之后**读取，因此天然包含本轮输入） ----
        // 角色先行加载：会话级预置的解析链需要角色默认值（defaultPresetId/defaultPersonaId/lorebookId）
        val character = session.characterId?.let { store.getCharacter(it) }
        // 会话绑定的世界书 id（面板可读写）；未绑定时为空列表，装配器会跳过世界书分支
        val sessionLorebookIds = runCatching {
            val array = org.json.JSONArray(session.lorebookIdsJson)
            (0 until array.length()).map { array.optString(it) }.filter { it.isNotEmpty() }
        }.getOrDefault(emptyList())
        // 会话未绑定世界书时回退到**角色默认世界书**（角色卡自带 lorebookId）：
        // 解析链同为「会话覆盖 > 角色默认 > 无」。
        val activeLorebookIds = sessionLorebookIds.ifEmpty {
            character?.lorebookId?.let { listOf(it) } ?: emptyList()
        }
        val activeLorebookBooks = if (activeLorebookIds.isEmpty()) {
            emptyList()
        } else {
            val byId = activeLorebookIds.toSet()
            store.listLorebooks()
                .filter { byId.contains(it.id) }
                .mapNotNull { entity ->
                    ChatLorebookCompile.compile(entity.canonicalJson, entity.id, entity.name)
                }
        }
        // 预设解析链：会话覆盖 > 角色默认（角色卡 defaultPresetId）> 无。
        // 此前装配器从未收到预设 → 用户设了预设却毫无效果且不报错（「功能在、接线不在」）。
        val sessionPreset = (session.presetId ?: character?.defaultPresetId)?.let { presetId ->
            store.listPresets().firstOrNull { it.id == presetId }
        }?.let { entity ->
            ChatPresetCompile.parse(entity.bodyJson, entity.id)
        }
        // 人设同链：会话覆盖 > 角色默认 > 全局默认人设
        val sessionPersona = run {
            val personas = store.listPersonas()
            val boundId = session.personaId ?: character?.defaultPersonaId
            boundId?.let { id -> personas.firstOrNull { it.id == id } }
                ?: personas.firstOrNull { it.isDefault }
        }
        //
        // 走共享的 `ChatContextBuilder`（无世界书子集），而不是「裸历史」：
        // 系统提示、越狱段、叙事模式、用户人设、thought 契约、记忆三层、角色设定、
        // 作者注释、对话示例、历史裁剪与压缩摘要、续写指令、assistant 前缀都在这里产出。
        // 端到端逐字节与 PC 对齐由 fixture `context-builder.json` 锁定。
        val memoryState = store.getMemoryState(sessionId)
        val storedMessages = store.listMessages(sessionId)
            .filter { it.role == "user" || it.role == "assistant" }
            // 令牌预算裁剪由装配器按上下文预算负责；这里只是一个兜底的读取上限，
            // 避免超长会话一次性载入过多行（正常会话远达不到该值）。
            .takeLast(historyLimit)
        val built = ChatContextBuilder.buildContextMessagesFromData(
            ChatContextBuilder.BuildData(
                character = character?.let {
                    ChatContextBuilder.CharacterSnapshot(
                        id = it.id,
                        name = it.name,
                        description = it.description,
                        personality = it.personality,
                        scenario = it.scenario,
                        exampleDialog = exampleDialogOf(it.exampleDialogueJson),
                    )
                },
                chat = ChatContextBuilder.ChatSnapshot(
                    messages = storedMessages.map { message ->
                        ChatContextBuilder.MessageSnapshot(
                            id = message.id,
                            role = message.role,
                            content = message.content,
                            images = imagesOf(message.imagesJson).takeIf { it.isNotEmpty() },
                            timestamp = message.logicalTime,
                        )
                    },
                    sessions = listOf(
                        ChatContextBuilder.SessionSnapshot(
                            id = session.id,
                            characterId = session.characterId.orEmpty(),
                            memoryEnabled = memoryState != null,
                            memory = memoryState?.summary.orEmpty(),
                            memoryCurrentState = memoryState?.currentState,
                            memoryFacts = factsOf(memoryState?.factsJson),
                            // v3 新增的会话级字段：此前只存在于装配器输入，本地无处存，
                            // 因此「会话级叙事模式/篇幅模式」与「历史压缩摘要」都无法生效。
                            narrativeMode = session.narrativeMode.takeIf { it.isNotEmpty() },
                            responseLengthMode = session.responseLengthMode.takeIf { it.isNotEmpty() },
                            compressedSummary = session.compressedSummary.takeIf { it.isNotEmpty() },
                            compressedRange = parseCompressedRange(session.compressedRangeJson),
                        ),
                    ),
                    currentSessionId = sessionId,
                    // 世界书近因窗口与压缩缓存（v3）：运行时早就支持这两个输入，
                    // 此前一直没有数据来源，导致 recency 加权恒为 0、压缩缓存永不命中。
                    recentTriggeredIds = parseRecentTriggeredIds(session.recentTriggeredIdsJson),
                    lorebookCompressionCache = parseCompressionCache(session.lorebookCompressionCacheJson),
                    // 会话绑定的世界书：canonical v2 文档 → 运行时输入。
                    // 缺这一步运行时永远拿到空条目，表现为「绑定了世界书却一条都不注入」且不报错。
                    activeLorebookIds = activeLorebookIds,
                ),
                lorebooks = activeLorebookBooks,
                preset = sessionPreset,
                settings = ChatContextBuilder.SettingsSnapshot(
                    userName = localUserName(),
                    activeModel = effectiveProfile.model,
                    // 人设注入：字段来源为会话/默认人设；注入位置与包含项沿用默认
                    // （system 位置、同时包含描述与性格），与 PC 默认一致。
                    personaInjection = if (sessionPersona != null) {
                        ChatContextBuilder.PersonaInjection()
                    } else {
                        null
                    },
                    userDescription = sessionPersona?.description?.takeIf { it.isNotEmpty() },
                    userPersona = sessionPersona?.persona?.takeIf { it.isNotEmpty() },
                ),
                profile = ChatContextBuilder.ProfileSnapshot(
                    provider = effectiveProfile.provider.wire,
                    model = effectiveProfile.model,
                    useInstructTemplate = null,
                    maxContext = 0,
                ),
            ),
        )
        // 阶段 4 S4-02：**超出上下文前在本地阻断**，不能只依赖供应商报错。
        // 历史已按预算裁剪，但非历史部分（预设/系统提示/世界书/用户人设）本身就可能超限——
        // 那种情况裁剪历史救不回来。此处直接以可行动的本地错误结束本轮，
        // 而不是把超限请求发出去、再把供应商的原始报错抛给用户。
        if (built.overflowTokens > 0) {
            emit(
                Delta.Finished(
                    failure(
                        machine,
                        cause = "invalid_request",
                        code = "CONTEXT_OVERFLOW",
                        message = "上下文超出模型上限：估算超出 ${built.overflowTokens} token" +
                            "（已用 ${built.lastContextUsage.used} / 上限 ${built.lastContextUsage.max}）。" +
                            "请缩短预设/人设，或减少本会话绑定的世界书。",
                    ),
                ),
            )
            return@flow
        }
        val request = ModelChatRequest(
            model = effectiveProfile.model,
            messages = built.messages.map { ChatMessageDto(it.role, it.content) },
            // 与上下文预留同源：绝不在两处分别推导输出上限
            maxTokens = built.requestMaxTokens,
            stream = true,
        )
        // S4-04 用量诊断：字符数在这里一次性算好，随结果带出（token 可能缺失，字符数始终可得）
        val promptChars = built.messages.sumOf { ChatTextMetrics.countVisibleCharacters(it.content) }

        val (events, handle) = gateway.stream(effectiveProfile.provider, effectiveProfile, request, effectiveApiKey)
        machine.startStreaming()

        // ---- 4. 流式消费（chunk 只进草稿缓冲） ----
        var cancelled = false
        var failureError: ModelError? = null
        var finishReason: String? = null
        var completed = false

        try {
            events.collect { event ->
                currentCoroutineContext().ensureActive()
                when (event) {
                    is ModelStreamEvent.Chunk -> {
                        if (event.value.deltaText.isNotEmpty()) {
                            machine.appendChunk(event.value.deltaText)
                            emit(Delta.Chunk(event.value.deltaText))
                        }
                        event.value.promptTokens?.let { prompt ->
                            machine.recordUsage(prompt, event.value.completionTokens ?: 0)
                        }
                        if (event.value.finished) {
                            finishReason = event.value.finishReason
                            machine.beginFinalizing(event.value.finishReason ?: "stop")
                        }
                    }

                    is ModelStreamEvent.Completed -> {
                        completed = true
                        finishReason = event.finishReason
                        machine.beginFinalizing(event.finishReason.ifEmpty { "stop" })
                    }

                    is ModelStreamEvent.Failure -> {
                        failureError = event.error
                        if (event.error.code == CANCELLED_CODE) cancelled = true
                    }
                }
            }
        } catch (_: kotlinx.coroutines.CancellationException) {
            // 由外部取消（ViewModel 作用域结束）：按用户取消处理，保留已见正文
            cancelled = true
        }

        // ---- 5. 终局 ----
        val outcome = when {
            cancelled -> finishCancelled(machine, sessionId, userMessageId, promptChars, persist)
            failureError != null -> finishFailure(machine, failureError!!, sessionId, userMessageId)
            completed || machine.snapshot().status == "finalizing" ->
                finishCompleted(machine, sessionId, finishReason, userMessageId, promptChars, persist, built.lorebookTriggeredEntryKeys)
            else -> finishFailure(
                machine,
                ModelError("EMPTY_RESPONSE", "供应商未返回可用内容", retryable = true),
                sessionId,
                userMessageId,
                // 空输出属于「供应商返回了无法使用的响应」，归 INVALID_MODEL_RESPONSE；
                // 与「传输中断」区分开，便于用户看到可行动作。
                explicitFailureCode = "INVALID_MODEL_RESPONSE",
            )
        }
        emit(Delta.Finished(outcome))
    }

    /** 取消入口：交给调用方持有（ViewModel 取消作用域即可），此处暴露给测试。 */
    fun cancel(handle: ModelRequestHandle?) {
        handle?.cancel()
    }

    // ---------------------------------------------------------------- 终局处理

    private suspend fun finishCompleted(
        machine: ChatGenerationTask.Machine,
        sessionId: String,
        finishReason: String?,
        userMessageId: String?,
        promptChars: Int = 0,
        persist: Boolean = true,
        lorebookTriggeredEntryKeys: List<String> = emptyList(),
    ): GenerationOutcome {
        if (machine.snapshot().status == "finalizing") machine.markCompleted()
        return persistIfAny(
            machine,
            sessionId,
            causeForFinishReason(finishReason),
            userMessageId,
            promptChars,
            persist,
            lorebookTriggeredEntryKeys,
        )
    }

    private suspend fun finishCancelled(
        machine: ChatGenerationTask.Machine,
        sessionId: String,
        userMessageId: String?,
        promptChars: Int = 0,
        persist: Boolean = true,
    ): GenerationOutcome {
        machine.terminate("user_cancel")
        return persistIfAny(machine, sessionId, "user_cancel", userMessageId, promptChars, persist)
    }

    private suspend fun finishFailure(
        machine: ChatGenerationTask.Machine,
        error: ModelError,
        sessionId: String,
        userMessageId: String?,
        explicitFailureCode: String? = null,
    ): GenerationOutcome {
        val cause = ModelErrorClassifier.causeFor(error)
        // 展示边界脱敏（阶段 4 S4-06「不暴露供应商原始敏感响应」）：
        // `PROVIDER_ERROR` 的 message 直接来自供应商响应体（适配器取 `json.take(200)`），
        // 响应体可能回显请求内容（含 key/路径）。已知错误码有固定可行动文案，
        // 未知码走 else 分支原样返回，因此必须在这里统一脱敏。
        machine.terminate(cause, ChatDomainErrors.sanitizeErrorMessage(error.toUserMessage()), failureCode = explicitFailureCode)
        val snapshot = machine.snapshot()
        return GenerationOutcome(
            taskId = snapshot.taskId,
            requestId = snapshot.requestId,
            status = snapshot.status,
            failureCode = snapshot.failureCode,
            retryable = snapshot.retryable,
            terminationCause = snapshot.terminationCause ?: cause,
            noticeField = snapshot.noticeField,
            noticeText = snapshot.noticeText,
            assistantMessageId = null,
            userMessageId = userMessageId,
            content = "",
            usage = snapshot.usage,
        )
    }

    /**
     * 有正文时一次性落盘 assistant 消息；无正文不创建空消息。
     * 落盘同时写入 `generationNotice`/`generationError` 字段，不拼入 content。
     */
    private suspend fun persistIfAny(
        machine: ChatGenerationTask.Machine,
        sessionId: String,
        terminationCause: String,
        userMessageId: String?,
        promptChars: Int = 0,
        persist: Boolean = true,
        lorebookTriggeredEntryKeys: List<String> = emptyList(),
    ): GenerationOutcome {
        val snapshot = machine.snapshot()
        val final = machine.takeFinalMessage()
        // persist=false 用于「同一条消息追加候选」的重生成：内容照常产出，
        // 但绝不新建消息——消息数量是导出、分页与上下文预算的输入。
        val assistantId = if (final != null && persist) {
            val id = idFactory()
            val noticeField = final.noticeField
            store.appendMessage(
                LocalMessageEntity(
                    id = id,
                    sessionId = sessionId,
                    characterId = store.getSession(sessionId)?.characterId,
                    role = "assistant",
                    content = final.content,
                    logicalTime = now(),
                    seq = -1,
                    generationStatus = snapshot.status,
                    generationNotice = if (noticeField == "generationNotice") final.noticeText else null,
                    generationError = if (noticeField == "generationError") final.noticeText else null,
                    usageJson = if (final.usage.isEmpty()) null else usageJson(final.usage),
                    createdAt = now(),
                    updatedAt = now(),
                ),
            )
            id
        } else {
            null
        }
        lastAssistantMessageId = assistantId
        return GenerationOutcome(
            taskId = snapshot.taskId,
            requestId = snapshot.requestId,
            status = snapshot.status,
            failureCode = snapshot.failureCode,
            retryable = snapshot.retryable,
            terminationCause = snapshot.terminationCause ?: terminationCause,
            noticeField = snapshot.noticeField,
            noticeText = snapshot.noticeText,
            assistantMessageId = assistantId,
            userMessageId = userMessageId,
            content = final?.content ?: "",
            usage = snapshot.usage,
            promptChars = promptChars,
            outputChars = final?.content?.let { ChatTextMetrics.countVisibleCharacters(it) } ?: 0,
            lorebookTriggeredEntryKeys = lorebookTriggeredEntryKeys,
        )
    }

    /** 供应商 finishReason → 应用层终止原因（与 PC 同口径）。 */
    private fun causeForFinishReason(finishReason: String?): String =
        ChatGenerationTermination.terminationCauseFromFinishReason(finishReason)

    /** 前置校验失败：不写任何数据，直接给终局。 */
    private fun failure(
        machine: ChatGenerationTask.Machine,
        cause: String,
        code: String,
        message: String,
    ): GenerationOutcome {
        machine.prepare()
        machine.terminate(cause, message, failureCode = code)
        val snapshot = machine.snapshot()
        return GenerationOutcome(
            taskId = snapshot.taskId,
            requestId = snapshot.requestId,
            status = snapshot.status,
            failureCode = snapshot.failureCode,
            retryable = snapshot.retryable,
            terminationCause = snapshot.terminationCause ?: cause,
            noticeField = snapshot.noticeField,
            noticeText = snapshot.noticeText,
            assistantMessageId = null,
            userMessageId = null,
            content = "",
            usage = emptyMap(),
        )
    }

    private fun usageJson(usage: Map<String, Int>): String =
        usage.entries.joinToString(",", "{", "}") { (key, value) -> "\"$key\":$value" }

    companion object {
        const val DEFAULT_HISTORY_LIMIT = 40

        /** Android 侧读取上限（装配器的 token 预算裁剪才是权威口径）。 */
        const val ANDROID_HISTORY_READ_CAP = 400

        /** 取消事件的错误码（与 ModelClient 的 CANCELLED 一致）。 */
        const val CANCELLED_CODE = "CANCELLED"
    }

    /** 本地用户名（暂无设置入口时使用默认值）。 */
    private suspend fun localUserName(): String = ChatContextBuilder.DEFAULT_USER_NAME

    /** 角色卡示例对话：`exampleDialogueJson` 为 JSON 数组，取首条作为示例文本。 */
    private fun exampleDialogOf(json: String): String = runCatching {
        val array = org.json.JSONArray(json)
        (0 until array.length()).joinToString("\n") { array.optString(it) }.trim()
    }.getOrDefault("")

    /**
     * 世界书近因窗口：`[[key,...], ...]`（每轮一组，旧在前）。
     * 坏数据一律退化为空窗口，不能让一条脏 JSON 毁掉整轮生成。
     */
    private fun parseRecentTriggeredIds(json: String): List<List<String>> = runCatching {
        val rounds = org.json.JSONArray(json)
        (0 until rounds.length()).mapNotNull { index ->
            rounds.optJSONArray(index)?.let { round ->
                (0 until round.length()).map { round.optString(it) }.filter { it.isNotEmpty() }
            }
        }
    }.getOrDefault(emptyList())

    /** 世界书压缩缓存：`{压缩键: {summary, entryKeys, createdAt, lastUsedAt}}`。 */
    private fun parseCompressionCache(json: String): Map<String, ChatLorebookBudget.CompressionCacheEntry> =
        runCatching {
            val root = org.json.JSONObject(json)
            root.keys().asSequence().mapNotNull { key ->
                root.optJSONObject(key)?.let { entry ->
                    val summary = entry.optString("summary")
                    if (summary.isEmpty()) {
                        null
                    } else {
                        key to ChatLorebookBudget.CompressionCacheEntry(
                            summary = summary,
                            createdAt = entry.optLong("createdAt", 0L),
                            lastUsedAt = if (entry.has("lastUsedAt")) entry.optLong("lastUsedAt") else null,
                        )
                    }
                }
            }.toMap()
        }.getOrDefault(emptyMap())

    /** 历史压缩覆盖范围：`{"startTs":..,"endTs":..}`；缺失或非法返回 null。 */
    private fun parseCompressedRange(json: String): ChatContextBuilder.CompressedRange? = runCatching {
        if (json.isBlank()) return@runCatching null
        val root = org.json.JSONObject(json)
        if (!root.has("startTs") || !root.has("endTs")) return@runCatching null
        ChatContextBuilder.CompressedRange(startTs = root.getLong("startTs"), endTs = root.getLong("endTs"))
    }.getOrNull()

    /** 消息图片：`images_json` 为字符串数组（本地相对路径或 base64）。 */
    private fun imagesOf(json: String): List<String> = runCatching {
        val array = org.json.JSONArray(json)
        (0 until array.length()).map { array.optString(it) }.filter { it.isNotEmpty() }
    }.getOrDefault(emptyList())

    /**
     * 记忆事实：`facts_json` 为已对齐的规范模型数组（对象）或旧文本事实（字符串）。
     * 注入侧只需要可渲染文本，故统一降为文本事实。
     */
    private fun factsOf(json: String?): List<ChatMemoryFacts.FactRecord> {
        if (json.isNullOrBlank()) return emptyList()
        return runCatching {
            val array = org.json.JSONArray(json)
            (0 until array.length()).mapNotNull { index ->
                when (val item = array.opt(index)) {
                    is String -> item.takeIf { it.isNotBlank() }
                        ?.let { ChatMemoryFacts.FactRecord.TextFact(it) }
                    is org.json.JSONObject -> {
                        val structured = ChatMemoryFacts.FactRecord.Structured(
                            id = item.optString("id"),
                            subject = item.optString("subject"),
                            predicate = item.optString("predicate"),
                            value = item.optString("value"),
                            status = item.optString("status").ifEmpty { "active" },
                            importance = item.optInt("importance", 3),
                            confidence = item.optDouble("confidence", 0.8),
                        )
                        val text = ChatMemoryFacts.memoryFactToText(structured)
                        text.takeIf { it.isNotBlank() }?.let { ChatMemoryFacts.FactRecord.TextFact(it) }
                    }
                    else -> null
                }
            }
        }.getOrDefault(emptyList())
    }
}

/** 供测试与诊断：把 provider 名映射为 provider 枚举（生产由连接档案携带）。 */
fun providerFromWire(wire: String): ModelProvider = ModelProvider.fromWire(wire) ?: ModelProvider.OpenAI

/** SharedFlow 版增量通道（UI 侧可选使用，避免每次订阅重建请求）。 */
fun LocalChatGenerationUseCase.deltaChannel(): MutableSharedFlow<LocalChatGenerationUseCase.Delta> =
    MutableSharedFlow(extraBufferCapacity = 64)
