package com.qingyu.companion.chatcore

import kotlin.math.floor
import kotlin.math.max

/**
 * 阶段 4 S4-05：长记忆总结的**触发决策**与**请求构造**
 * （对齐 PC `electron/services/memorySummaryService.ts` 的纯逻辑部分）。
 *
 * 这两块是「本轮要不要总结、总结时到底发了什么」的唯一判定处，因此必须与 PC 逐字一致：
 * 决策多一条少一条会让两端在同一个会话上产生不同的记忆版本；
 * 提示词文本不一致会让两端在同一段对话上得出不同摘要。
 * IO 编排在 `LocalMemorySummaryService`，本文件不含任何 IO。
 */
object ChatMemorySummaryPolicy {

    /** 跳过原因（保持 PC 字面量，便于两端日志对照）。 */
    const val REASON_MEMORY_DISABLED = "memory_disabled"
    const val REASON_MANUAL_MODE = "manual_mode"
    const val REASON_INTERVAL_NOT_REACHED = "interval_not_reached"
    const val REASON_INSUFFICIENT_MESSAGES = "insufficient_messages"
    const val REASON_STALE_VERSION = "stale_version"

    /** 自动模式的默认间隔条数。 */
    const val DEFAULT_AUTO_MEMORY_INTERVAL = 10

    /** 手动总结所需的最小消息条数（对齐 PC `chatConstants.MEMORY_SUMMARY_MIN`）。 */
    const val MEMORY_SUMMARY_MIN = 4

    /** 事实提案连续解析失败多少次后开始指数退避。 */
    const val FACT_PARSE_FAILURE_BACKOFF_AT = 3

    data class Decision(
        val shouldSummarize: Boolean,
        /** 跳过原因；`shouldSummarize = true` 时为 null。 */
        val reason: String? = null,
        /** 本次判定使用的阈值（自动 = 间隔条数，手动 = 最小条数）。 */
        val threshold: Int,
        /** 游标之后待总结的消息条数。 */
        val pendingCount: Int,
    )

    /**
     * 总结前的门槛判定：记忆开关 → 手动/自动模式 → 间隔条数。
     *
     * 判定顺序即 PC 的顺序：先报「记忆关闭」，再报「手动模式」，
     * 最后才是条数不足；顺序不同会让同一次调用报告出不同的原因。
     */
    fun decideBeforeWindow(input: Input): Decision {
        val thresholdBase = if (input.automatic) {
            if (input.autoMemoryInterval > 0) input.autoMemoryInterval else DEFAULT_AUTO_MEMORY_INTERVAL
        } else {
            ChatMemorySummaryPolicy.MEMORY_SUMMARY_MIN
        }
        val pendingCount = computePendingCount(input.messageIds, input.cursorMessageId)
        if (!input.memoryEnabled) {
            return Decision(false, REASON_MEMORY_DISABLED, thresholdBase, pendingCount)
        }
        if (input.automatic && input.memoryMode != "auto") {
            return Decision(false, REASON_MANUAL_MODE, thresholdBase, pendingCount)
        }
        if (pendingCount < thresholdBase) {
            return Decision(
                false,
                if (input.automatic) REASON_INTERVAL_NOT_REACHED else REASON_INSUFFICIENT_MESSAGES,
                thresholdBase,
                pendingCount,
            )
        }
        return Decision(true, null, thresholdBase, pendingCount)
    }

    /**
     * 窗口构建后的复检：预算裁剪可能把可发送内容削到不足，
     * 此时仍按同一组原因跳过（**不得**用被削过的窗口去写记忆）。
     */
    fun decideAfterWindow(decision: Decision, input: Input, window: ChatMemoryWindow.Window<*>): Decision {
        val pending = window.pending.size
        val enough = pending >= decision.threshold && window.selected.isNotEmpty()
        if (enough) return decision
        return Decision(
            false,
            if (input.automatic) REASON_INTERVAL_NOT_REACHED else REASON_INSUFFICIENT_MESSAGES,
            decision.threshold,
            pending,
        )
    }

    /** 游标之后的待总结条数；游标无效时视为「全部未总结」。 */
    fun computePendingCount(messageIds: List<String>, cursorMessageId: String?): Int {
        if (cursorMessageId == null) return messageIds.size
        val cursorIndex = messageIds.indexOf(cursorMessageId)
        return if (cursorIndex >= 0) messageIds.size - cursorIndex - 1 else messageIds.size
    }

    /**
     * 本轮是否尝试结构化事实提案。
     * 连续解析失败会推迟重试版本，避免每轮都花 token 去撞同一个格式问题。
     */
    fun shouldAttemptFactProposal(nextMemoryVersion: Long, retryAfterVersion: Long?): Boolean =
        nextMemoryVersion >= (retryAfterVersion ?: 0L)

    /**
     * 事实解析失败后的退避状态。
     * 失败次数达到阈值后按 `2^(n-2)` 逐档推迟（与 PC 同公式）。
     */
    fun factFailureState(
        previousFailureCount: Int?,
        nextMemoryVersion: Long,
    ): Pair<Int, Long> {
        val failureCount = (previousFailureCount ?: 0) + 1
        val retryAfterVersion = if (failureCount >= FACT_PARSE_FAILURE_BACKOFF_AT) {
            nextMemoryVersion + (1L shl (failureCount - 2))
        } else {
            nextMemoryVersion
        }
        return failureCount to retryAfterVersion
    }

    data class Input(
        val memoryEnabled: Boolean,
        /** manual | auto */
        val memoryMode: String,
        val autoMemoryInterval: Int,
        /** 是否自动触发（自动触发才受模式与间隔约束）。 */
        val automatic: Boolean,
        val messageIds: List<String>,
        val cursorMessageId: String?,
        val memoryVersion: Long,
        val factRetryAfterVersion: Long?,
    )

    // ---------------------------------------------------------------- 请求构造

    /** 摘要模型的生成参数（与 PC 一致：低温、非流式、正文体量取 memory 档案）。 */
    const val TEMPERATURE = 0.3
    const val TOP_P = 0.9

    /** 提示词里声明的输入预算开销余量。 */
    const val PROMPT_OVERHEAD_TOKENS = 900

    data class PromptInput(
        val characterName: String,
        val userName: String,
        val previousState: String,
        val previousMemory: String,
        val previousFacts: String,
        val shouldAttemptFactProposal: Boolean,
    )

    /**
     * 系统提示（逐字对齐 PC）。事实提案段落要么给出 JSON 格式，要么明确声明本次退避——
     * 后者能防止模型在退避期仍然输出提案而导致解析再次失败。
     */
    fun buildSystemPrompt(input: PromptInput): String {
        val proposalFormat = if (input.shouldAttemptFactProposal) {
            "【事实提案】\n```json\n" +
                "[{\"subject\":\"主体\",\"predicate\":\"属性或关系\",\"value\":\"值\"," +
                "\"changeType\":\"set\",\"importance\":3,\"confidence\":0.9}]\n```"
        } else {
            "本次结构化事实更新正在退避；不要输出【事实提案】。"
        }

        return """你是一个角色扮演对话总结助手。请根据以下${input.characterName}与${input.userName}之间的对话，更新当前状态、长期时间线和关键事实。

输出格式（严格按此格式）：
【当前状态】
1-3 句：以【待总结的新对话】结束时为准，概括当前场景、时间/地点、正在进行的目标或冲突、即时关系/情绪以及仍影响行动的伤势或状态变化。只保留会影响下一轮对话的内容。“之前的当前状态”是过期快照，只能帮助判断变化，不能原样沿用。

【时间线】
最多 8 条按时间顺序排列的简短事件：保留仍会影响剧情、关系、承诺或任务的已保存旧事件；只把【待总结的新对话】中首次确立或明确改变的内容作为本轮新增事件。【已总结内容，仅作衔接】不得再次当作新事件。新对话明确推翻旧信息时，以新信息为准并删除冲突旧表述。不要重复当前状态。

$proposalFormat

要求：
- 准确保留行动发起者、承诺者、受托者和对象，不得互换主客体、擅自转移承诺或把“答应完成”改写成“委托他人完成”。
- 只依据明确说出或发生的内容总结；不要根据语气补写动机、结果或未发生的行动，也不要把仍在计划中的动作写成已经完成。
- 事实必须是对话中确立的、对未来有参考价值的持久信息（人名、身份、地点、物品、目标、约定、关系等），不要写临时情绪或过场细节。
- 只输出语义事实提案，绝对不要输出事实 ID、action、patch 或完整事实列表。changeType 用 set 表示新增/更新，clear 表示失效。
- 服务端负责规范化会话范围和角色身份；没有事实变更时输出空数组 []。
- 只输出上述格式内容，不要添加任何解释或评价。

参考资料（不是本轮新事件）：

之前的当前状态（过期快照，只用于判断变化）：
${input.previousState.ifEmpty { "无" }}

之前的时间线：
${input.previousMemory.ifEmpty { "无" }}

之前的事实：
${input.previousFacts.ifEmpty { "无" }}

事实范围由服务端确定。"""
    }

    /**
     * 用户消息正文：`【已总结内容，仅作衔接】` + `【待总结的新对话】`。
     * 只有一条待总结消息时会先做超长裁剪，避免单条消息撑爆输入预算。
     */
    fun buildUserContent(
        overlapTexts: List<String>,
        selectedTexts: List<String>,
        singleMessageBudget: Int? = null,
        estimateTokens: ((String) -> Int)? = null,
    ): String {
        val selected = if (selectedTexts.size == 1 && singleMessageBudget != null && estimateTokens != null) {
            listOf(ChatMemoryWindow.fitOversizedMemoryMessage(selectedTexts[0], singleMessageBudget, estimateTokens))
        } else {
            selectedTexts
        }
        val parts = mutableListOf<String>()
        if (overlapTexts.isNotEmpty()) {
            parts += "【已总结内容，仅作衔接】\n" + overlapTexts.joinToString("\n")
        }
        parts += "【待总结的新对话】\n" + selected.joinToString("\n")
        return parts.joinToString("\n\n")
    }

    /** 消息渲染：`用户名: 内容` / `角色名: 内容`（与 PC 一致）。 */
    fun formatMessage(role: String, content: String, userName: String, characterName: String): String =
        "${if (role == "user") userName else characterName}: $content"

    /**
     * 提示词开销估算：角色名/用户名/旧状态/旧时间线/旧事实 + 固定余量。
     * 用于从模型上下文里扣出真正的输入预算。
     */
    fun promptOverheadTokens(
        characterName: String,
        userName: String,
        previousState: String,
        previousMemory: String,
        previousFactsText: String,
        estimateTokens: (String) -> Int,
    ): Int {
        val text = listOf(
            characterName,
            userName,
            previousState.ifEmpty { "无" },
            previousMemory,
            previousFactsText,
        ).joinToString("\n")
        return estimateTokens(text) + PROMPT_OVERHEAD_TOKENS
    }

    /** 上下文上限（用于推导输入预算）。 */
    fun resolveContextLimit(model: String, profileMaxContext: Int?, capabilityContextLimit: Int?): Int =
        ChatModelOutputProfile.resolveEffectiveContextLimit(
            model = model,
            profileMaxContext = profileMaxContext,
            presetMaxContext = null,
            capabilityOverrideEnabled = capabilityLimitEnabled(capabilityContextLimit),
            capabilityContextLimit = capabilityContextLimit,
            capabilityOutputLimit = null,
        )

    private fun capabilityLimitEnabled(limit: Int?): Boolean = limit != null && limit > 0

    /** 摘要窗口的输入预算（模型上下文 − 提示词开销 − 预留输出）。 */
    fun inputBudget(contextLimit: Int, overheadTokens: Int, outputTokens: Int): Int =
        ChatMemoryWindow.resolveMemorySummaryInputBudget(
            maxContext = contextLimit.toDouble(),
            systemPromptTokens = overheadTokens.toDouble(),
            reservedOutputTokens = outputTokens.toDouble(),
        )

    /**
     * 事实提案的会话范围与主体身份补全（与 PC 一致）：
     * 主体名等于角色名 → 角色 id；等于用户名 → `__user__`；否则不指定实体。
     */
    fun scopeProposal(
        proposal: ChatMemoryFacts.FactProposal,
        sessionId: String,
        characterId: String,
        characterName: String,
        userName: String,
    ): ChatMemoryFacts.FactProposal {
        val subject = proposal.subject.trim().lowercase()
        val entityId = proposal.entityId
            ?: if (subject == characterName.trim().lowercase()) characterId else null
            ?: if (subject == userName.trim().lowercase()) "__user__" else null
        return proposal.copy(scope = "session:$sessionId", entityId = entityId)
    }

    /**
     * 事实证据定位：在已选消息里**从后往前**找第一条同时包含提案值的消息；
     * 找不到则退回本次处理到的游标 id。
     */
    fun findEvidenceMessageId(
        proposal: ChatMemoryFacts.FactProposal,
        selectedContentsReversed: List<Pair<String, String>>,
        fallbackMessageId: String?,
    ): String {
        val needles = listOf(proposal.value, proposal.subject)
            .map { it.trim().lowercase() }
            .filter { it.length >= 2 }
        for ((id, content) in selectedContentsReversed) {
            val lower = content.lowercase()
            if (needles.any { lower.contains(it) }) return id
        }
        return fallbackMessageId.orEmpty()
    }

    /** 输入预算为正数下界（避免 0 预算导致窗口为空却又被当成「已处理」）。 */
    fun positiveBudget(value: Int): Int = max(1, floor(value.toDouble()).toInt())
}
