package com.qingyu.companion.chatcore

import com.qingyu.companion.local.db.LocalGroupMessageEntity
import com.qingyu.companion.local.db.LocalUsageRecordEntity
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.network.models.ChatMessageDto
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelStreamEvent
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withContext

/**
 * 阶段 6 S6-01(d)：**群聊本地生成闭环**（关掉 PC 后群聊独立生成）。
 *
 * 与单聊 `LocalChatGenerationUseCase` 同构，但按群语义组装与落盘：
 * - 轮次编排由 [ChatGroupTurnMachine]（领域状态机）驱动——本类只执行副作用
 *   （组上下文、流式、定时接力、落盘），不内联任何调度判定；
 * - 上下文由 [ChatGroupContextBuilder]（组装配顺序 1–19，跨语言 fixture 钉住）产出；
 * - **终局唯一经 `ChatGeneratedReplyPipeline.finalizeGenerationTerminalResult`**
 *   （文档硬约束「群聊必须经过本入口」；这是该入口的第一个 Kotlin 生产调用方）：
 *   错误只进 generationNotice/generationError、绝不拼入 content；无正文不建空消息；
 *   user_cancel 保留已见正文 + 「已停止生成」；
 * - 落盘归属由 [ChatGroupTurnMachine.Turn] **锁定**（生成中删成员/切模式不改写）；
 *   free 轮经 [ChatGroupFreeSplit] 拆分为多条角色消息，提示字段挂最后一条。
 *
 * 依赖全部可注入（无网络、无 Device 可完整测试）。
 */
class LocalGroupGenerationUseCase(
    private val store: LocalStore,
    private val gateway: ModelGateway,
    private val profileProvider: suspend () -> ConnectionProfilePublic?,
    private val apiKeyProvider: suspend () -> String?,
    /**
     * 群生成所需设置面。缺省 = PC 默认值（注入开/系统位置、thought 开、first_turn 场景门控）；
     * 用户级设置（人设/注入/叙事规则）的接线随 S6-01f 设置 UI 接入。
     */
    private val settingsProvider: suspend () -> GroupGenerationSettings = { GroupGenerationSettings() },
    /** output 正则规则（收尾管线第 2–3 步）。 */
    private val regexRulesProvider: suspend () -> List<ChatRegex.Rule> = { emptyList() },
    private val idFactory: () -> String = { Ulid.newId() },
    private val now: () -> Long = { System.currentTimeMillis() },
    private val historyLimit: Int = LocalChatGenerationUseCase.ANDROID_HISTORY_READ_CAP,
) {

    /** 群生成设置面（PC settings 的群相关子集；身份解析语义见 [ChatGroupContextBuilder.resolvePersonaFields]）。 */
    data class GroupGenerationSettings(
        val defaultPersonaId: String? = null,
        val activePersonaId: String? = null,
        val globalUserName: String = "",
        val globalUserDescription: String = "",
        val globalUserPersona: String = "",
        val personaInjection: ChatGroupContextBlocks.PersonaInjection? = null,
        val scenarioInjectionMode: String? = null,
        val enableThoughtFormat: Boolean = true,
        val omniscientNarrativeRules: String? = null,
        val defaultNarrativeMode: String? = null,
        /** 上下文上限（连接档案能力面；缺省 8192 与 LocalChatRepository 口径一致）。 */
        val contextLimit: Int = 8192,
    )

    /** 流式过程中向持有者暴露的增量事件。 */
    sealed interface Delta {
        data class TurnStarted(val turn: ChatGroupTurnMachine.Turn, val requestId: String) : Delta
        data class Chunk(val requestId: String, val text: String) : Delta

        /** 本轮终局：已按锁定归属落盘的消息 id（未落盘为空）。 */
        data class TurnFinished(
            val turn: ChatGroupTurnMachine.Turn,
            val messageIds: List<String>,
            val noticeFields: Map<String, String>,
            /** complete | recovered | needs_tail_repair | failed | raw | empty */
            val status: String,
        ) : Delta

        data class WaitingUser(val reason: String) : Delta
        data class Rejected(val reason: String) : Delta
        data class Stopped(val reason: String) : Delta
    }

    /**
     * 执行一条链（一次用户触发 → 若干接力轮 → 交还用户/停止）。
     *
     * [turnRound] 传用户消息的轮号（与 AI 回复共用；缺省取最后一条用户消息）；
     * [forcedSpeakerId] = 立即接话（不经发言计划、开新轮、不接力）。
     * 收集方取消即用户停止（保留已见正文）。
     */
    fun generate(
        groupId: String,
        sessionId: String,
        requestId: String,
        targetCharId: String? = null,
        forcedSpeakerId: String? = null,
        chainEnabled: Boolean = true,
        turnRound: Long? = null,
    ): Flow<Delta> = flow {
        val group = store.getGroup(groupId)
        if (group == null) {
            emit(Delta.Rejected("group_not_found"))
            return@flow
        }
        val session = store.getSession(sessionId)
        if (session == null || session.groupId != groupId) {
            emit(Delta.Rejected("session_not_found"))
            return@flow
        }
        val profile = profileProvider()
        if (profile == null) {
            emit(Delta.Rejected("no_profile"))
            return@flow
        }
        val effectiveApiKey = apiKeyProvider()
        val settings = settingsProvider()

        val memberIds = parseStringList(group.characterIdsJson)
        val config = machineConfigOf(group, memberIds)
        val machine = if (forcedSpeakerId != null) {
            ChatGroupTurnMachine.Machine(config)
        } else {
            ChatGroupTurnMachine.Machine(config, targetCharId = targetCharId, knownCharacterIds = null)
        }

        var history = loadMessageRefs(sessionId)
        var step = if (forcedSpeakerId != null) {
            machine.beginOneShot(forcedSpeakerId, history)
        } else {
            machine.begin(history, turnRound ?: lastUserRound(history) ?: ChatGroupScheduling.nextGroupRound(history.map { it.round }))
        }

        var turnIndex = 0
        while (true) {
            when (step) {
                is ChatGroupTurnMachine.Step.Rejected -> {
                    emit(Delta.Rejected(step.reason))
                    return@flow
                }
                is ChatGroupTurnMachine.Step.Stopped -> {
                    emit(Delta.Stopped("stopped"))
                    return@flow
                }
                is ChatGroupTurnMachine.Step.WaitUser -> {
                    emit(Delta.WaitingUser(step.reason))
                    return@flow
                }
                is ChatGroupTurnMachine.Step.ScheduleNext -> {
                    // 接力定时（PC clearPollingTimer + setTimeout 语义；收集方取消即停链）
                    delay(step.delayMs)
                    step = machine.onChainTick(loadMessageRefs(sessionId))
                }
                is ChatGroupTurnMachine.Step.RunTurn -> {
                    val turn = step.turn
                    val turnRequestId = "$requestId#t${turnIndex++}"
                    emit(Delta.TurnStarted(turn, turnRequestId))

                    val result = runTurn(
                        turn = turn,
                        turnRequestId = turnRequestId,
                        groupId = groupId,
                        sessionId = sessionId,
                        memberIds = memberIds,
                        session = session,
                        settings = settings,
                        profile = profile,
                        apiKey = effectiveApiKey,
                        collect = { emit(it) },
                    )
                    emit(Delta.TurnFinished(turn, result.messageIds, result.noticeFields, result.status))

                    // 续排决策：读**新鲜**群配置（PC checkPollingContinue 口径）
                    history = loadMessageRefs(sessionId)
                    val freshGroup = store.getGroup(groupId)
                    val currentConfig = freshGroup?.let { machineConfigOf(it, parseStringList(it.characterIdsJson)) }
                    step = machine.onTurnFinished(
                        messages = history,
                        persisted = result.messageIds.isNotEmpty(),
                        currentConfig = currentConfig,
                    )
                }
            }
        }
    }

    // ---------------------------------------------------------------- 单轮执行

    private data class TurnResult(
        val messageIds: List<String>,
        val noticeFields: Map<String, String>,
        val status: String,
    )

    private suspend fun runTurn(
        turn: ChatGroupTurnMachine.Turn,
        turnRequestId: String,
        groupId: String,
        sessionId: String,
        memberIds: List<String>,
        session: com.qingyu.companion.local.db.LocalSessionEntity,
        settings: GroupGenerationSettings,
        profile: ConnectionProfilePublic,
        apiKey: String?,
        collect: suspend (Delta) -> Unit,
    ): TurnResult {
        val group = store.getGroup(groupId)!!
        val members = memberIds.mapNotNull { store.getCharacter(it) }
        val blockMembers = members.map { character ->
            ChatGroupContextBlocks.Member(
                id = character.id,
                name = character.name,
                translatedName = translatedNameOf(character.translatedContentJson),
                description = character.description,
                personality = character.personality,
                scenario = character.scenario,
                systemPrompt = character.systemPrompt,
                exampleDialog = exampleDialogOf(character.exampleDialogueJson),
                postHistoryInstructions = character.postHistoryInstructions,
            )
        }
        val memoryState = store.getMemoryState(sessionId)
        val storedMessages = store.listGroupMessages(sessionId).takeLast(historyLimit)
        val presetEntity = group.presetId?.let { id -> store.listPresets().firstOrNull { it.id == id } }
        val presetJson = presetEntity?.bodyJson?.let { runCatching { org.json.JSONObject(it) }.getOrNull() }

        val personaId = session.personaId
        val sessionPersona = personaId?.let { id -> store.listPersonas().firstOrNull { it.id == id } }
        val personaFields = ChatGroupContextBuilder.resolvePersonaFields(
            sessionPersonaId = personaId,
            // Android 行无法区分「未设置」与「显式 null」：非空即视为已显式设置（已知口径，见报告）
            sessionPersonaIdDefined = personaId != null,
            sessionPersona = sessionPersona?.let {
                ChatGroupContextBlocks.PersonaLike(name = it.name, description = it.description, persona = it.persona)
            },
            defaultPersonaId = settings.defaultPersonaId,
            activePersonaId = settings.activePersonaId,
            globalUserName = settings.globalUserName,
            globalUserDescription = settings.globalUserDescription,
            globalUserPersona = settings.globalUserPersona,
        )

        val built = ChatGroupContextBuilder.build(
            ChatGroupContextBuilder.Input(
                groupName = group.name,
                chatMode = group.chatMode,
                groupSystemPrompt = group.systemPrompt,
                defaultNarrativeMode = group.defaultNarrativeMode.takeIf { it.isNotEmpty() },
                members = blockMembers,
                targetId = if (turn.kind == ChatGroupTurnMachine.KIND_SINGLE) turn.speakerId else null,
                session = ChatGroupContextBuilder.SessionInput(
                    personaId = personaId,
                    narrativeMode = session.narrativeMode.takeIf { it.isNotEmpty() },
                    memoryEnabled = session.memoryEnabled,
                    memory = memoryState?.summary,
                    memoryCurrentState = memoryState?.currentState,
                    memoryFacts = factsOf(memoryState?.factsJson),
                    compressedSummary = session.compressedSummary.takeIf { it.isNotEmpty() },
                    compressedRange = parseCompressedRange(session.compressedRangeJson),
                ),
                messages = storedMessages.map {
                    ChatGroupContextBuilder.Message(
                        characterId = it.characterId,
                        content = it.content,
                        images = imagesOf(it.imagesJson),
                        timestamp = it.logicalTime,
                    )
                },
                userName = personaFields.userName,
                userDescription = personaFields.userDescription,
                userPersona = personaFields.userPersona,
                personaInjection = settings.personaInjection,
                settings = ChatGroupContextBuilder.Settings(
                    defaultNarrativeMode = settings.defaultNarrativeMode,
                    enableThoughtFormat = settings.enableThoughtFormat,
                    omniscientNarrativeRules = settings.omniscientNarrativeRules,
                    scenarioInjectionMode = settings.scenarioInjectionMode,
                    contextCompression = null,
                ),
                preset = ChatGroupContextBuilder.PresetInput(
                    systemPrompt = presetJson?.optString("systemPrompt").orEmpty(),
                    jailbreak = presetJson?.optString("jailbreak").orEmpty(),
                    contextTemplate = presetJson?.optString("contextTemplate").orEmpty(),
                ),
                profile = ChatGroupContextBuilder.ProfileInput(
                    provider = profile.provider.wire,
                    // ConnectionProfilePublic 无 instruct 模板开关：缺省按 provider 推断
                    useInstructTemplate = null,
                ),
                model = profile.model,
                maxContext = settings.contextLimit,
                requestMaxTokens = requestMaxTokensFor(profile.model, storedMessages.sumOf { it.content.length }),
                lorebookPlan = null,
                trackUsage = false,
            ),
        )

        val request = ModelChatRequest(
            model = profile.model,
            messages = built.messages.map { ChatMessageDto(it.role, it.content) },
            temperature = presetJson?.optDouble("temperature", 0.8) ?: 0.8,
            maxTokens = requestMaxTokensFor(profile.model, storedMessages.sumOf { it.content.length }),
            stream = true,
        )
        val promptChars = built.messages.sumOf { ChatTextMetrics.countVisibleCharacters(it.content) }

        // ---- 流式（每轮一个一次性终止闸门：迟到 chunk/终局事件全部忽略） ----
        val taskMachine = ChatGenerationTask.Machine(taskId = turnRequestId)
        taskMachine.prepare()
        taskMachine.startStreaming()
        val (events, handle) = gateway.stream(profile.provider, profile, request, apiKey)

        var cancelled = false
        var failureError: com.qingyu.companion.network.models.ModelError? = null
        var finishReason: String? = null
        var completed = false
        try {
            events.collect { event ->
                currentCoroutineContext().ensureActive()
                when (event) {
                    is ModelStreamEvent.Chunk -> {
                        if (event.value.deltaText.isNotEmpty()) {
                            taskMachine.appendChunk(event.value.deltaText)
                            collect(Delta.Chunk(turnRequestId, event.value.deltaText))
                        }
                        event.value.promptTokens?.let { prompt ->
                            taskMachine.recordUsage(prompt, event.value.completionTokens ?: 0)
                        }
                        if (event.value.finished) {
                            finishReason = event.value.finishReason
                            taskMachine.beginFinalizing(event.value.finishReason ?: "stop")
                        }
                    }
                    is ModelStreamEvent.Completed -> {
                        completed = true
                        finishReason = event.finishReason
                        taskMachine.beginFinalizing(event.finishReason.ifEmpty { "stop" })
                    }
                    is ModelStreamEvent.Failure -> {
                        failureError = event.error
                        if (event.error.code == CANCELLED_CODE) cancelled = true
                    }
                }
            }
        } catch (_: kotlinx.coroutines.CancellationException) {
            // 用户停止 / 持有者取消：按 user_cancel 走终局——**必须保留已见正文**
            //（S6-01「生成中断的终局」），落盘在 NonCancellable 段内完成；
            // 此后的 emit 会随取消抛出，但数据已落盘。
            cancelled = true
        }

        // ---- 终局 + 落盘：NonCancellable 保证取消路径也能保住部分正文终局 ----
        return withContext(NonCancellable) {
            finishAndPersist(
                turn = turn,
                turnRequestId = turnRequestId,
                groupId = groupId,
                sessionId = sessionId,
                groupName = group.name,
                blockMembers = blockMembers,
                session = session,
                taskMachine = taskMachine,
                cancelled = cancelled,
                failureError = failureError,
                finishReason = finishReason,
                completed = completed,
                profile = profile,
                promptChars = promptChars,
                narrativeModeHint = group.defaultNarrativeMode,
            )
        }
    }

    private suspend fun finishAndPersist(
        turn: ChatGroupTurnMachine.Turn,
        turnRequestId: String,
        groupId: String,
        sessionId: String,
        groupName: String,
        blockMembers: List<ChatGroupContextBlocks.Member>,
        session: com.qingyu.companion.local.db.LocalSessionEntity,
        taskMachine: ChatGenerationTask.Machine,
        cancelled: Boolean,
        failureError: com.qingyu.companion.network.models.ModelError?,
        finishReason: String?,
        completed: Boolean,
        profile: ConnectionProfilePublic,
        promptChars: Int,
        narrativeModeHint: String,
    ): TurnResult {
        var errorMessage: String? = null
        val cause: String = when {
            cancelled -> "user_cancel"
            failureError != null -> {
                errorMessage = ChatDomainErrors.sanitizeErrorMessage(failureError.toUserMessage())
                ModelErrorClassifier.causeFor(failureError)
            }
            completed || taskMachine.snapshot().status == "finalizing" ->
                ChatGenerationTermination.terminationCauseFromFinishReason(finishReason)
            else -> {
                errorMessage = "供应商未返回可用内容"
                "protocol_error"
            }
        }
        val terminal = ChatGeneratedReplyPipeline.finalizeGenerationTerminalResult(
            rawText = taskMachine.draftText(),
            finishReason = finishReason,
            terminationCause = cause,
            regexRules = regexRulesProvider(),
            characterName = turn.speakerId?.let { id -> blockMembers.firstOrNull { it.id == id }?.name }
                ?: groupName,
            errorMessage = errorMessage,
        )

        // ---- 按锁定归属落盘 ----
        val narrativeMode = ChatNarrativeMode.resolveNarrativeMode(
            session.narrativeMode.takeIf { it.isNotEmpty() },
            narrativeModeHint.takeIf { it.isNotEmpty() },
        )
        val messageIds = mutableListOf<String>()
        if (terminal.persistable && terminal.content.isNotEmpty()) {
            if (turn.kind == ChatGroupTurnMachine.KIND_FREE) {
                val split = ChatGroupFreeSplit.split(
                    terminal.content,
                    blockMembers.map { ChatGroupFreeSplit.Member(it.id, it.name) },
                    narrativeMode,
                )
                val notices = terminal.noticeFields
                split.messages.forEachIndexed { index, segment ->
                    val isLast = index == split.messages.size - 1
                    val id = idFactory()
                    store.appendGroupMessage(
                        LocalGroupMessageEntity(
                            id = id,
                            sessionId = sessionId,
                            groupId = groupId,
                            characterId = segment.characterId,
                            content = segment.content,
                            round = turn.round.toInt(),
                            narrativeMode = narrativeMode,
                            speakerKind = if (segment.characterId == ChatGroupFreeSplit.NARRATOR_ID) "narrator" else "character",
                            generationKind = "assistant_reply",
                            generationNotice = if (isLast) notices["generationNotice"] else null,
                            generationError = if (isLast) notices["generationError"] else null,
                            contentRenderMode = "blocks",
                            logicalTime = now(),
                            seq = -1,
                            createdAt = now(),
                            updatedAt = now(),
                        ),
                    )
                    messageIds += id
                }
            } else {
                val id = idFactory()
                store.appendGroupMessage(
                    LocalGroupMessageEntity(
                        id = id,
                        sessionId = sessionId,
                        groupId = groupId,
                        characterId = turn.speakerId ?: ChatGroupFreeSplit.FREE_ID,
                        content = terminal.content,
                        round = turn.round.toInt(),
                        narrativeMode = narrativeMode,
                        speakerKind = if (turn.speakerId == ChatGroupFreeSplit.NARRATOR_ID) "narrator" else "character",
                        generationKind = "assistant_reply",
                        generationNotice = terminal.noticeFields["generationNotice"],
                        generationError = terminal.noticeFields["generationError"],
                        contentRenderMode = "blocks",
                        logicalTime = now(),
                        seq = -1,
                        createdAt = now(),
                        updatedAt = now(),
                    ),
                )
                messageIds += id
            }
            // 用量诊断：群轮次按 main 记账（token 可能缺失，字符数始终可得）
            runCatching {
                store.recordUsage(
                    LocalUsageRecordEntity(
                        id = "$turnRequestId-usage",
                        sessionId = sessionId,
                        provider = "",
                        model = profile.model,
                        promptTokens = taskMachine.snapshot().usage["promptTokens"] ?: 0,
                        completionTokens = taskMachine.snapshot().usage["completionTokens"] ?: 0,
                        createdAt = now(),
                        taskType = "main",
                        inputChars = promptChars,
                        outputChars = ChatTextMetrics.countVisibleCharacters(terminal.content),
                    ),
                )
            }
        }
        return TurnResult(messageIds, terminal.noticeFields, terminal.status)
    }

    // ---------------------------------------------------------------- 小工具

    private suspend fun loadMessageRefs(sessionId: String): List<ChatGroupScheduling.MessageRef> =
        store.listGroupMessages(sessionId).map { ChatGroupScheduling.MessageRef(it.characterId, it.round.toLong()) }

    private fun lastUserRound(refs: List<ChatGroupScheduling.MessageRef>): Long? =
        refs.lastOrNull { it.characterId == "__user__" }?.round

    private fun machineConfigOf(
        group: com.qingyu.companion.local.db.LocalGroupEntity,
        memberIds: List<String>,
    ): ChatGroupTurnMachine.Config = ChatGroupTurnMachine.Config(
        chatMode = group.chatMode,
        autoMode = group.autoMode,
        maxRounds = group.maxRounds.toLong(),
        memberIds = memberIds,
        currentSpeakerIndex = group.currentSpeakerIndex.toLong(),
        speakerIntervalMs = group.speakerInterval,
    )

    private fun requestMaxTokensFor(model: String, inputChars: Int): Int =
        ChatGenerationTaskBudget.resolveGenerationTaskBudget(
            ChatGenerationTaskBudget.Input(task = "group_reply", model = model, inputChars = inputChars),
        ).request.requestMaxTokens

    private fun parseStringList(json: String): List<String> = runCatching {
        val array = org.json.JSONArray(json)
        (0 until array.length()).map { array.optString(it) }.filter { it.isNotEmpty() }
    }.getOrDefault(emptyList())

    private fun imagesOf(json: String): List<String> = parseStringList(json)

    private fun exampleDialogOf(json: String): String = runCatching {
        val array = org.json.JSONArray(json)
        (0 until array.length()).joinToString("\n") { array.optString(it) }.trim()
    }.getOrDefault("")

    private fun translatedNameOf(json: String): String? = runCatching {
        val root = org.json.JSONObject(json)
        root.optString("name").takeIf { it.isNotEmpty() }
    }.getOrNull()

    private fun parseCompressedRange(json: String): Pair<Long, Long>? = runCatching {
        if (json.isBlank()) return@runCatching null
        val root = org.json.JSONObject(json)
        if (!root.has("startTs") || !root.has("endTs")) return@runCatching null
        root.getLong("startTs") to root.getLong("endTs")
    }.getOrNull()

    /** 记忆事实：规范对象或旧文本事实；注入侧只需可渲染文本（与单聊 `factsOf` 同口径）。 */
    private fun factsOf(json: String?): List<ChatMemoryFacts.FactRecord> {
        if (json.isNullOrBlank()) return emptyList()
        return runCatching {
            val array = org.json.JSONArray(json)
            (0 until array.length()).mapNotNull { index ->
                when (val item = array.opt(index)) {
                    is String -> item.takeIf { it.isNotBlank() }?.let { ChatMemoryFacts.FactRecord.TextFact(it) }
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

    companion object {
        /** 取消事件的错误码（与 ModelClient 的 CANCELLED 一致）。 */
        const val CANCELLED_CODE = "CANCELLED"
    }
}
