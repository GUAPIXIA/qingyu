package com.qingyu.companion.chatcore

import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.network.models.ChatMessageDto
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelStreamEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.toList

/**
 * 阶段 6 S6-01(e)：**群聊长记忆摘要服务**（对齐 PC `src/store/groupMemoryManager.ts#runGroupMemorySummary`）。
 *
 * 与单聊 `LocalMemorySummaryService` 的差异（PC 群语义，逐条镜像）：
 * - 消息源是**群消息表**，格式化为 `用户名: …` / `【成员名】…`（与 pendingCompression 归属同口径）；
 * - 系统提示含**群名与成员名**（PC groupMemoryManager 108–129 逐字）；
 * - 事实提案由服务端归一化：`scope = group:{groupId}`，`entityId` 回退链
 *   `提案.entityId → 同名成员（trim/大小写不敏感）→ subject==用户名 ? '__user__'`；
 * - 解析失败退避：`retryAfter = n>=3 ? v+2^(n-2) : v`；
 * - **提交必须 CAS**（`applyMemoryStateIfVersion`）：版本不符丢弃本次摘要，
 *   提示「本次旧摘要未写入」，绝不覆盖新历史。
 *
 * 三条硬约束同单聊：CAS 提交 / 游标只推进到真正总结过的位置 / 同会话并发触发合并。
 */
class LocalGroupMemoryService(
    private val store: LocalStore,
    private val gateway: ModelGateway,
    private val now: () -> Long = System::currentTimeMillis,
) {

    sealed interface Outcome {
        data class Summarized(
            val summary: String,
            val currentState: String,
            val factCount: Int,
            val memoryVersion: Long,
            val cursorMessageId: String?,
        ) : Outcome

        data class Skipped(val reason: String) : Outcome
        data class Failed(val message: String) : Outcome
    }

    private val inFlight = mutableMapOf<String, Deferred<Outcome>>()

    /**
     * 触发一次群记忆总结。`automatic = true` 受自动模式与间隔约束；`false` 为手动触发。
     * 提示词里的成员名列表与群名来自群行与成员行（PC groupMemoryManager 同源）。
     */
    suspend fun summarize(
        scope: CoroutineScope,
        groupId: String,
        sessionId: String,
        automatic: Boolean,
        profile: ConnectionProfilePublic,
        apiKey: String?,
        model: String,
        userName: String = ChatContextBuilder.DEFAULT_USER_NAME,
        autoMemoryInterval: Int = ChatMemorySummaryPolicy.DEFAULT_AUTO_MEMORY_INTERVAL,
    ): Outcome {
        val entry = synchronized(inFlight) {
            inFlight[sessionId] ?: scope.async {
                run(groupId, sessionId, automatic, profile, apiKey, model, userName, autoMemoryInterval)
            }.also { inFlight[sessionId] = it }
        }
        return try {
            entry.await()
        } finally {
            synchronized(inFlight) { if (inFlight[sessionId] === entry) inFlight.remove(sessionId) }
        }
    }

    private data class GroupMessageView(
        override val id: String,
        override val content: String,
        val characterId: String,
    ) : ChatMemoryWindow.WindowMessage

    private suspend fun run(
        groupId: String,
        sessionId: String,
        automatic: Boolean,
        profile: ConnectionProfilePublic,
        apiKey: String?,
        model: String,
        userName: String,
        autoMemoryInterval: Int,
    ): Outcome {
        val group = store.getGroup(groupId)
            ?: return Outcome.Skipped(ChatMemorySummaryPolicy.REASON_INSUFFICIENT_MESSAGES)
        val session = store.getSession(sessionId)
            ?: return Outcome.Skipped(ChatMemorySummaryPolicy.REASON_INSUFFICIENT_MESSAGES)
        val memoryState = store.getMemoryState(sessionId)
        val memberEntities = group.let { g ->
            parseStringList(g.characterIdsJson).mapNotNull { store.getCharacter(it) }
        }
        val memberNames = memberEntities.joinToString("、") { it.name }

        val stored = store.listGroupMessages(sessionId)
            .filter { it.content.isNotBlank() }
            .map { GroupMessageView(id = it.id, content = it.content, characterId = it.characterId) }

        // 记忆启用判定：会话行是开关与策略的权威来源（与单聊同）
        val memoryEnabled = session.memoryEnabled || !automatic
        val policyInput = ChatMemorySummaryPolicy.Input(
            memoryEnabled = memoryEnabled,
            memoryMode = session.memoryMode,
            autoMemoryInterval = autoMemoryInterval,
            automatic = automatic,
            messageIds = stored.map { it.id },
            cursorMessageId = memoryState?.memoryLastMessageId,
            memoryVersion = memoryState?.memoryVersion ?: 0L,
            factRetryAfterVersion = memoryState?.factRetryAfterVersion,
        )
        val decision = ChatMemorySummaryPolicy.decideBeforeWindow(policyInput)
        if (!decision.shouldSummarize) {
            return Outcome.Skipped(decision.reason ?: ChatMemorySummaryPolicy.REASON_INSUFFICIENT_MESSAGES)
        }

        val previousFacts = parseFacts(memoryState?.factsJson)
        val previousHistory = parseFacts(memoryState?.historyJson)
        val previousFactsText = ChatMemoryRanking.formatMemoryFacts(previousFacts)
        val previousMemory = memoryState?.summary.orEmpty()

        val memoryBudget = ChatGenerationTaskBudget.resolveGenerationTaskBudget(
            ChatGenerationTaskBudget.Input(task = "memory", model = model),
        )
        val outputTokens = memoryBudget.request.requestMaxTokens
        val overhead = ChatMemorySummaryPolicy.promptOverheadTokens(
            characterName = memberNames,
            userName = userName,
            previousState = memoryState?.currentState.orEmpty(),
            previousMemory = previousMemory,
            previousFactsText = previousFactsText,
            estimateTokens = { text -> ChatTokenCounter.estimateTokens(text, model) },
        )
        val summaryInputBudget = ChatMemoryWindow.resolveMemorySummaryInputBudget(
            maxContext = CONTEXT_LIMIT.toDouble(),
            systemPromptTokens = overhead.toDouble(),
            reservedOutputTokens = outputTokens.toDouble(),
        )

        val nextVersion = (memoryState?.memoryVersion ?: 0L) + 1
        val shouldAttemptFactProposal = nextVersion >= (memoryState?.factRetryAfterVersion ?: 0L)
        val narrativeMemoryGuidance = ChatNarrativeMode.getNarrativeMemoryGuidance(
            ChatNarrativeMode.resolveNarrativeMode(session.narrativeMode),
        )

        // ---- 群记忆系统提示（PC groupMemoryManager 108–129 逐字） ----
        val systemPrompt = buildSystemPrompt(
            groupName = group.name,
            memberNames = memberNames,
            shouldAttemptFactProposal = shouldAttemptFactProposal,
            narrativeMemoryGuidance = narrativeMemoryGuidance,
            previousState = memoryState?.currentState.orEmpty(),
            previousMemory = previousMemory,
            previousFactsText = previousFactsText,
        )

        val nameOf = memberEntities.associate { it.id to it.name }
        fun format(view: GroupMessageView): String =
            if (view.characterId == "__user__") "$userName: ${view.content}"
            else "【${nameOf[view.characterId] ?: "未知角色"}】${view.content}"

        val summaryWindow = ChatMemoryWindow.buildSummaryWindow(
            stored,
            memoryState?.memoryLastMessageId,
            ::format,
            { text -> ChatTokenCounter.estimateTokens(text, model) },
            ChatMemoryWindow.Options(tokenBudget = summaryInputBudget),
        )
        if (summaryWindow.pending.size < ChatMemorySummaryPolicy.MEMORY_SUMMARY_MIN || summaryWindow.selected.isEmpty()) {
            return Outcome.Skipped(ChatMemorySummaryPolicy.REASON_INSUFFICIENT_MESSAGES)
        }

        val conversationText = buildString {
            if (summaryWindow.overlap.isNotEmpty()) {
                append("【已总结内容，仅作衔接】\n")
                append(summaryWindow.overlap.joinToString("\n", transform = ::format))
                append("\n\n")
            }
            append("【待总结的新对话】\n")
            append(summaryWindow.selected.joinToString("\n") { view ->
                if (summaryWindow.selected.size == 1) {
                    ChatMemoryWindow.fitOversizedMemoryMessage(
                        format(view),
                        summaryInputBudget,
                    ) { text -> ChatTokenCounter.estimateTokens(text, model) }
                } else {
                    format(view)
                }
            })
        }

        val events = gateway.stream(
            profile.provider,
            profile,
            ModelChatRequest(
                model = model,
                messages = listOf(
                    ChatMessageDto("system", systemPrompt),
                    ChatMessageDto("user", conversationText),
                ),
                maxTokens = outputTokens,
                stream = false,
            ),
            apiKey,
        ).first.toList()
        events.filterIsInstance<ModelStreamEvent.Failure>().firstOrNull()
            ?.let { return Outcome.Failed(it.error.toUserMessage()) }
        val raw = events.filterIsInstance<ModelStreamEvent.Chunk>().joinToString("") { it.value.deltaText }

        val parsed = ChatMemoryFacts.parseMemoryResult(raw)
        if (parsed.currentState.isEmpty() && parsed.summary.isEmpty() && parsed.facts.isEmpty() &&
            !parsed.factProposalsPresent
        ) {
            return Outcome.Failed("群聊长记忆总结未产出可解析内容")
        }

        // ---- 事实提案归一化（scope=group:{gid}；entityId 回退链同 PC） ----
        var failureCount = memoryState?.factParseFailureCount ?: 0
        var retryAfterVersion = memoryState?.factRetryAfterVersion ?: 0L
        var facts = previousFacts
        var history = previousHistory
        val proposals = parsed.factProposals
        if (parsed.factProposalsPresent && proposals == null) {
            // 提案段存在但格式无效：保留旧事实，按指数退避推迟重试
            failureCount += 1
            retryAfterVersion = if (failureCount >= 3) {
                nextVersion + (1L shl (failureCount - 2))
            } else {
                nextVersion
            }
        } else if (proposals != null && proposals.isNotEmpty()) {
            val normalized = proposals.map { proposal ->
                proposal.copy(
                    scope = "group:$groupId",
                    entityId = resolveEntityId(proposal, memberEntities, userName),
                )
            }
            val applied = ChatMemoryFacts.applyFactProposals(
                previousFacts = facts,
                previousHistory = history,
                proposals = normalized,
                sourceMessageId = summaryWindow.processedThroughMessageId ?: "",
                updatedAt = now(),
            )
            facts = applied.facts
            history = applied.history
            failureCount = 0
            retryAfterVersion = 0L
        }

        // ---- CAS 提交：版本不符丢弃本次摘要，绝不覆盖新历史 ----
        val baseVersion = memoryState?.memoryVersion ?: 0L
        val entity = (memoryState ?: com.qingyu.companion.local.db.LocalMemoryStateEntity(
            id = "$sessionId-memory",
            sessionId = sessionId,
            updatedAt = now(),
        )).copy(
            // 缺【时间线】保留旧时间线（PC：只更新状态/事实并推进游标）
            summary = parsed.summary.ifEmpty { previousMemory },
            currentState = parsed.currentState,
            factsJson = ChatMemoryFacts.factsToJson(facts),
            historyJson = ChatMemoryFacts.factsToJson(history),
            memoryVersion = baseVersion + 1,
            memoryLastMessageId = summaryWindow.processedThroughMessageId,
            factParseFailureCount = failureCount,
            factRetryAfterVersion = retryAfterVersion,
        )
        val commit = store.applyMemoryStateIfVersion(sessionId, baseVersion, entity)
        if (!commit.applied) {
            return Outcome.Failed("群聊长记忆已被其他操作更新，本次旧摘要未写入。请重试总结。")
        }
        return Outcome.Summarized(
            summary = entity.summary,
            currentState = entity.currentState,
            factCount = facts.size,
            memoryVersion = commit.currentVersion,
            cursorMessageId = summaryWindow.processedThroughMessageId,
        )
    }

    /** 提案 entityId 回退链（PC groupMemoryManager 195–233）：提案 → 同名成员 → 用户。 */
    private fun resolveEntityId(
        proposal: ChatMemoryFacts.FactProposal,
        members: List<com.qingyu.companion.local.db.LocalCharacterEntity>,
        userName: String,
    ): String? {
        proposal.entityId?.takeIf { it.isNotEmpty() }?.let { return it }
        members.firstOrNull { it.name.trim().equals(proposal.subject.trim(), ignoreCase = true) }?.let { return it.id }
        return if (proposal.subject == userName) "__user__" else null
    }

    private fun buildSystemPrompt(
        groupName: String,
        memberNames: String,
        shouldAttemptFactProposal: Boolean,
        narrativeMemoryGuidance: String,
        previousState: String,
        previousMemory: String,
        previousFactsText: String,
    ): String = "你是一个对话摘要助手。请根据以下群聊「$groupName」的最近对话（成员：$memberNames），更新当前状态、长期时间线并抽取关键事实。\n" +
        "\n" +
        "输出格式（严格按此格式）：\n" +
        "【当前状态】\n" +
        "1-3 句：当前场景、地点、正在进行的目标或冲突，以及影响下一轮对话的即时关系或情绪。\n" +
        "\n" +
        "【时间线】\n" +
        "最多 8 条按时间顺序排列的简短事件：保留仍会影响剧情、关系、承诺或任务的旧事件，并合并新事件；只有被新对话明确推翻时才改写旧事件。不要重复当前状态。\n" +
        "\n" +
        (if (shouldAttemptFactProposal) {
            "【事实提案】\n```json\n" +
                "[{\"subject\":\"主体\",\"predicate\":\"属性或关系\",\"value\":\"值\",\"changeType\":\"set\",\"importance\":3,\"confidence\":0.9}]\n" +
                "```"
        } else {
            "本次结构化事实更新正在退避；不要输出【事实提案】。"
        }) +
        "\n" +
        "要求：\n" +
        "- $narrativeMemoryGuidance\n" +
        "- 事实必须是持久有效的信息（人名、身份、地点、目标、约定、关系等），不要写临时情绪。\n" +
        "- 只输出语义事实提案，绝对不要输出事实 ID、action、patch 或完整事实列表。changeType 用 set 表示新增/更新，clear 表示失效。\n" +
        "- 服务端负责规范化群聊范围和角色身份；没有事实变更时输出空数组 []。\n" +
        "- 只输出上述格式内容。\n" +
        "\n" +
        "【之前的当前状态】\n${previousState.ifEmpty { "无" }}\n\n" +
        (if (previousMemory.isNotEmpty()) "【之前的时间线】\n$previousMemory\n\n" else "") +
        "【之前的事实】\n$previousFactsText\n\n事实范围由服务端确定。"

    private fun parseFacts(json: String?): List<ChatMemoryFacts.FactRecord> {
        if (json.isNullOrBlank()) return emptyList()
        return runCatching {
            val array = org.json.JSONArray(json)
            (0 until array.length()).mapNotNull { index ->
                when (val item = array.opt(index)) {
                    is String -> item.takeIf { it.isNotBlank() }?.let { ChatMemoryFacts.FactRecord.TextFact(it) }
                    is org.json.JSONObject -> {
                        if (item.optString("kind") == "text") {
                            // factsToJson 的文本事实形态（kind=text）：必须原样回读，否则往返丢文本
                            item.optString("text").takeIf { it.isNotBlank() }
                                ?.let { ChatMemoryFacts.FactRecord.TextFact(it) }
                        } else {
                            ChatMemoryFacts.FactRecord.Structured(
                                id = item.optString("id"),
                                subject = item.optString("subject"),
                                predicate = item.optString("predicate"),
                                value = item.optString("value"),
                                status = item.optString("status").ifEmpty { "active" },
                                importance = item.optInt("importance", 3),
                                confidence = item.optDouble("confidence", 0.8),
                            )
                        }
                    }
                    else -> null
                }
            }
        }.getOrDefault(emptyList())
    }

    private fun parseStringList(json: String): List<String> = runCatching {
        val array = org.json.JSONArray(json)
        (0 until array.length()).map { array.optString(it) }.filter { it.isNotEmpty() }
    }.getOrDefault(emptyList())

    companion object {
        /** 群摘要的上下文上限（与 LocalChatGenerationUseCase 同口径的保守常量）。 */
        const val CONTEXT_LIMIT = 8192
    }
}
