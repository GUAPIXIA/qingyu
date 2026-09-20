package com.qingyu.companion.chatcore

import com.qingyu.companion.local.db.LocalMemoryStateEntity
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
 * 阶段 4 S4-05：长记忆总结的编排
 * （对齐 PC `electron/services/memorySummaryService.ts` 的 IO 部分）。
 *
 * 流程：读会话与消息 → 触发决策 → 构建摘要窗口 → **非流式**补全 →
 * 解析（当前状态 / 时间线 / 事实提案 / 事实变更）→ 事实应用 → **CAS 提交**。
 *
 * 三条硬约束：
 * 1. **提交必须 CAS**：生成期间用户可能编辑了历史，版本不符时丢弃本次摘要并上报
 *    `stale_version`，绝不覆盖新历史（与 PC 同语义）。
 * 2. **游标只推进到真正发送过并被总结的位置**，否则会永久漏掉一段对话。
 * 3. **同一会话的并发触发合并**：复用同一在途任务，避免两个摘要写同一个版本。
 */
class LocalMemorySummaryService(
    private val store: LocalStore,
    private val gateway: com.qingyu.companion.chatcore.ModelGateway,
    private val now: () -> Long = System::currentTimeMillis,
) {

    /** 总结结果（保持 PC 字面量，便于两端日志对照）。 */
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

    private val inFlight = mutableMapOf<String, InFlight>()

    /**
     * 触发一次总结。`automatic = true` 表示由「助手消息完成」自动触发（受自动模式与间隔约束），
     * `false` 表示用户手动触发（只受最小条数约束）。
     */
    suspend fun summarize(
        scope: CoroutineScope,
        sessionId: String,
        automatic: Boolean,
        profile: ConnectionProfilePublic,
        apiKey: String?,
        model: String,
        userName: String = ChatContextBuilder.DEFAULT_USER_NAME,
        autoMemoryInterval: Int = ChatMemorySummaryPolicy.DEFAULT_AUTO_MEMORY_INTERVAL,
    ): Outcome {
        val entry = synchronized(inFlight) {
            inFlight[sessionId] ?: InFlight(
                deferred = scope.async {
                    run(sessionId, automatic, profile, apiKey, model, userName, autoMemoryInterval)
                },
                automatic = automatic,
            ).also { inFlight[sessionId] = it }
        }
        return try {
            val result = entry.deferred.await()
            // 合并进在途任务时**必须重跑一次**，覆盖两种情况：
            //
            // 1. 手动请求不能被**自动**任务的「跳过」结果顶掉 —— 典型场景：刚结束一轮对话时
            //    自动任务因「未达间隔」跳过，此时用户点「立即总结」，不重跑就会静默无反应。
            // 2. 自动请求同样不能被**更早的自动运行**的「跳过」结果顶掉 —— 这是更隐蔽的一种：
            //    本轮触发时上一次自动运行仍在飞行中，于是本轮**合并**进旧运行，拿到的是
            //    「按旧状态判定」的 interval_not_reached；旧运行结束后再无触发，
            //    最新一轮对话就**永远不会被总结**（用户可见症状是「记忆不生效」）。
            //
            // 重跑不是无条件多调一次模型：`run` 会按**当前**状态重新判定，
            // 若间隔仍未达到则照样跳过（无模型调用），因此这里不会放大调用量，也不会递归。
            if (result is Outcome.Skipped &&
                (result.reason == ChatMemorySummaryPolicy.REASON_MANUAL_MODE ||
                    result.reason == ChatMemorySummaryPolicy.REASON_INTERVAL_NOT_REACHED)
            ) {
                val retry = synchronized(inFlight) {
                    InFlight(
                        deferred = scope.async {
                            run(sessionId, automatic, profile, apiKey, model, userName, autoMemoryInterval)
                        },
                        automatic = automatic,
                    ).also { inFlight[sessionId] = it }
                }
                retry.deferred.await()
            } else {
                result
            }
        } finally {
            synchronized(inFlight) { if (inFlight[sessionId]?.deferred === entry.deferred) inFlight.remove(sessionId) }
        }
    }

    /** 在途任务 + 它是否为自动触发（手动请求需要在「自动跳过」后重跑）。 */
    private class InFlight(val deferred: Deferred<Outcome>, val automatic: Boolean)

    private suspend fun run(
        sessionId: String,
        automatic: Boolean,
        profile: ConnectionProfilePublic,
        apiKey: String?,
        model: String,
        userName: String,
        autoMemoryInterval: Int,
    ): Outcome {
        val session = store.getSession(sessionId)
            ?: return Outcome.Skipped(ChatMemorySummaryPolicy.REASON_INSUFFICIENT_MESSAGES)
        val memoryState = store.getMemoryState(sessionId)
        val characterName = session.characterId?.let { store.getCharacter(it)?.name }
            .orEmpty()
            .ifEmpty { "角色" }
        val characterId = session.characterId.orEmpty()

        val stored = store.listMessages(sessionId)
            .filter { it.role != "system" && it.content.isNotBlank() }

        // 记忆启用判定：会话行是开关与策略的权威来源（S4-05）。
        // 手动触发时允许在开关关闭的情况下执行（用户在界面上显式点了「立即总结」）。
        val memoryEnabled = session.memoryEnabled || !automatic
        val memoryMode = session.memoryMode

        val policyInput = ChatMemorySummaryPolicy.Input(
            memoryEnabled = memoryEnabled,
            memoryMode = memoryMode,
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
        val previousHistory = parseStructured(memoryState?.historyJson)
        val previousFactsText = ChatMemoryRanking.formatMemoryFacts(previousFacts)
        val previousMemory = memoryState?.summary.orEmpty()

        val memoryBudget = ChatGenerationTaskBudget.resolveGenerationTaskBudget(
            ChatGenerationTaskBudget.Input(task = "memory", model = model),
        )
        val outputTokens = memoryBudget.request.requestMaxTokens
        val overhead = ChatMemorySummaryPolicy.promptOverheadTokens(
            characterName = characterName,
            userName = userName,
            previousState = memoryState?.currentState.orEmpty(),
            previousMemory = previousMemory,
            previousFactsText = previousFactsText,
            estimateTokens = { ChatTokenCounter.estimateTokens(it, model) },
        )
        val inputBudget = ChatMemorySummaryPolicy.inputBudget(
            contextLimit = ChatMemorySummaryPolicy.resolveContextLimit(
                model = model,
                profileMaxContext = null,
                capabilityContextLimit = null,
            ),
            overheadTokens = overhead,
            outputTokens = outputTokens,
        )

        val window = ChatMemoryWindow.buildSummaryWindow(
            messages = stored.map { MemoryWindowMessage(it.id, it.role, it.content) },
            cursorId = memoryState?.memoryLastMessageId,
            formatMessage = { ChatMemorySummaryPolicy.formatMessage(it.role, it.content, userName, characterName) },
            estimateTokens = { ChatTokenCounter.estimateTokens(it, model) },
            options = ChatMemoryWindow.Options(tokenBudget = inputBudget),
        )
        val rechecked = ChatMemorySummaryPolicy.decideAfterWindow(decision, policyInput, window)
        if (!rechecked.shouldSummarize) {
            return Outcome.Skipped(rechecked.reason ?: ChatMemorySummaryPolicy.REASON_INSUFFICIENT_MESSAGES)
        }

        val baseVersion = memoryState?.memoryVersion ?: 0L
        val nextVersion = baseVersion + 1
        val attemptFacts = ChatMemorySummaryPolicy.shouldAttemptFactProposal(
            nextVersion,
            memoryState?.factRetryAfterVersion,
        )

        val systemPrompt = ChatMemorySummaryPolicy.buildSystemPrompt(
            ChatMemorySummaryPolicy.PromptInput(
                characterName = characterName,
                userName = userName,
                previousState = memoryState?.currentState.orEmpty(),
                previousMemory = previousMemory,
                previousFacts = previousFactsText,
                shouldAttemptFactProposal = attemptFacts,
            ),
        )
        val userContent = ChatMemorySummaryPolicy.buildUserContent(
            overlapTexts = window.overlap.map {
                ChatMemorySummaryPolicy.formatMessage(it.role, it.content, userName, characterName)
            },
            selectedTexts = window.selected.map {
                ChatMemorySummaryPolicy.formatMessage(it.role, it.content, userName, characterName)
            },
        )

        val events = runCatching {
            gateway.stream(
                profile.provider,
                profile,
                ModelChatRequest(
                    model = model,
                    messages = listOf(
                        ChatMessageDto("system", systemPrompt),
                        ChatMessageDto("user", userContent),
                    ),
                    temperature = ChatMemorySummaryPolicy.TEMPERATURE,
                    maxTokens = outputTokens,
                    stream = false,
                ),
                apiKey,
            ).first.toList()
        }.getOrElse { error ->
            return Outcome.Failed(error.message ?: error::class.java.simpleName)
        }
        events.filterIsInstance<ModelStreamEvent.Failure>().firstOrNull()?.let {
            return Outcome.Failed(it.error.message)
        }
        val text = events.filterIsInstance<ModelStreamEvent.Chunk>()
            .joinToString("") { it.value.deltaText }
        val parsed = ChatMemoryFacts.parseMemoryResult(text)
        if (parsed.summary.isEmpty() && parsed.currentState.isEmpty()) {
            return Outcome.Failed("长记忆总结未产出可解析内容（模型可能只返回了思考过程或格式不符）")
        }
        // S4-05：记忆请求必须与正常聊天使用**独立 task type 与用量记录**，
        // 否则「本轮聊天花了多少」会被记忆任务污染。
        // 只记成功轮次（失败没有可用产出，记进去同样是污染）。
        recordAuxUsage(
            sessionId = sessionId,
            taskType = "memory",
            promptChars = ChatTextMetrics.countVisibleCharacters(systemPrompt) +
                ChatTextMetrics.countVisibleCharacters(userContent),
            outputChars = ChatTextMetrics.countVisibleCharacters(text),
            usage = events.filterIsInstance<ModelStreamEvent.Chunk>()
                .lastOrNull { it.value.promptTokens != null }
                ?.value,
            model = model,
        )

        // 事实应用：提案优先 → 显式变更 → 都没有则保留旧快照。
        // 解析失败（段存在但格式无效）必须完全保留旧快照，不得清空用户记忆。
        val hasFactsSection = text.contains("【事实】")
        val hasProposalSection = text.contains("【事实提案】")
        var facts: List<ChatMemoryFacts.FactRecord> = if (hasFactsSection) {
            parsed.facts.map { ChatMemoryFacts.FactRecord.TextFact(it) }
        } else {
            previousFacts
        }
        var history = previousHistory
        var factStateUpdates: Pair<Int, Long>? = null
        val sourceMessageId = window.processedThroughMessageId ?: ""

        when {
            attemptFacts && hasProposalSection && !parsed.factProposals.isNullOrEmpty() -> {
                var workingFacts: List<ChatMemoryFacts.FactRecord> = previousFacts
                var workingHistory = previousHistory
                val reversed = window.selected.reversed().map { it.id to it.content }
                for (proposal in parsed.factProposals) {
                    val scoped = ChatMemorySummaryPolicy.scopeProposal(
                        proposal = proposal,
                        sessionId = sessionId,
                        characterId = characterId,
                        characterName = characterName,
                        userName = userName,
                    )
                    val applied = ChatMemoryFacts.applyFactProposals(
                        previousFacts = workingFacts,
                        previousHistory = workingHistory,
                        proposals = listOf(scoped),
                        sourceMessageId = ChatMemorySummaryPolicy.findEvidenceMessageId(
                            proposal = scoped,
                            selectedContentsReversed = reversed,
                            fallbackMessageId = window.processedThroughMessageId,
                        ),
                        updatedAt = now(),
                    )
                    workingFacts = applied.facts
                    workingHistory = applied.history
                }
                facts = workingFacts
                history = workingHistory
                factStateUpdates = 0 to 0L
            }
            parsed.factChangesPresent && !parsed.factChanges.isNullOrEmpty() -> {
                val applied = ChatMemoryFacts.applyMemoryFactChanges(
                    previousFacts = previousFacts,
                    previousHistory = previousHistory,
                    changes = parsed.factChanges,
                    sourceMessageId = sourceMessageId,
                    updatedAt = now(),
                )
                facts = applied.facts
                history = applied.history
                factStateUpdates = 0 to 0L
            }
            attemptFacts && parsed.factProposalsPresent && parsed.factProposals == null -> {
                // 段存在但格式无效 → 记一次失败并退避，旧事实保持不变
                factStateUpdates = ChatMemorySummaryPolicy.factFailureState(
                    previousFailureCount = memoryState?.factParseFailureCount,
                    nextMemoryVersion = nextVersion,
                )
            }
        }

        val summaryToWrite = parsed.summary.ifEmpty { previousMemory }
        val stateToWrite = parsed.currentState.ifEmpty { memoryState?.currentState.orEmpty() }
        val commit = store.applyMemoryStateIfVersion(
            sessionId = sessionId,
            expectedVersion = baseVersion,
            entity = LocalMemoryStateEntity(
                id = memoryState?.id ?: "memory-$sessionId",
                sessionId = sessionId,
                summary = summaryToWrite,
                coveredThroughSeq = memoryState?.coveredThroughSeq ?: 0L,
                budgetJson = memoryState?.budgetJson ?: "{}",
                updatedAt = now(),
                currentState = stateToWrite,
                factsJson = ChatMemoryFacts.factsToJson(facts),
                historyJson = ChatMemoryFacts.factsToJson(history),
                historyRevision = memoryState?.historyRevision ?: 0L,
                memoryLastMessageId = window.processedThroughMessageId,
                factParseFailureCount = factStateUpdates?.first ?: memoryState?.factParseFailureCount ?: 0,
                factRetryAfterVersion = factStateUpdates?.second ?: memoryState?.factRetryAfterVersion ?: 0L,
            ),
        )
        if (!commit.applied) return Outcome.Skipped(ChatMemorySummaryPolicy.REASON_STALE_VERSION)
        return Outcome.Summarized(
            summary = summaryToWrite,
            currentState = stateToWrite,
            factCount = facts.size,
            memoryVersion = commit.currentVersion,
            cursorMessageId = window.processedThroughMessageId,
        )
    }

    private fun parseFacts(json: String?): List<ChatMemoryFacts.FactRecord> = parseRaw(json) { raw ->
        ChatMemoryFacts.factRecordFromJson(raw)
    }

    private fun parseStructured(json: String?): List<ChatMemoryFacts.FactRecord.Structured> =
        parseRaw(json) { raw -> ChatMemoryFacts.factRecordFromJson(raw) }
            .filterIsInstance<ChatMemoryFacts.FactRecord.Structured>()

    private fun <T> parseRaw(json: String?, decode: (org.json.JSONObject) -> T?): List<T> {
        if (json.isNullOrBlank()) return emptyList()
        return runCatching {
            val array = org.json.JSONArray(json)
            (0 until array.length()).mapNotNull { index ->
                (array.opt(index) as? org.json.JSONObject)?.let(decode)
            }
        }.getOrDefault(emptyList())
    }

    private data class MemoryWindowMessage(
        override val id: String,
        val role: String,
        override val content: String,
    ) : ChatMemoryWindow.WindowMessage

    /**
     * 记录辅助任务用量（记忆/翻译等）。
     *
     * 这些请求走的是同一个模型端点，若混入 `main` 会直接污染「本轮聊天花了多少」——
     * 而记忆总结的输入往往是整段对话，量级远超单轮聊天。
     */
    private suspend fun recordAuxUsage(
        sessionId: String,
        taskType: String,
        promptChars: Int,
        outputChars: Int,
        usage: com.qingyu.companion.network.models.ModelChunk?,
        model: String,
    ) {
        if (outputChars <= 0) return
        runCatching {
            store.recordUsage(
                com.qingyu.companion.local.db.LocalUsageRecordEntity(
                    // 用「会话+任务+时间」构造稳定 id：同一会话的同类辅助调用不会互相覆盖。
                    // 必须写 ${now()}：`now` 是注入的时钟 lambda，写成 `"$now()"` 只会插值
                    // lambda 本身 → 生成非法实体 ID → 被 runCatching 静默吞掉 → **用量永远写不进去**。
                    id = "$taskType-$sessionId-${now()}",                    sessionId = sessionId,
                    messageId = null,
                    provider = "",
                    model = model,
                    promptTokens = usage?.promptTokens ?: 0,
                    completionTokens = usage?.completionTokens ?: 0,
                    createdAt = now(),
                    taskType = taskType,
                    inputChars = promptChars,
                    outputChars = outputChars,
                ),
            )
        }
    }
}
