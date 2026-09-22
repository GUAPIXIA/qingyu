package com.qingyu.companion.chatcore

/**
 * 阶段 6 S6-01：群聊发言调度与消息归属（对齐 `shared/chat-core/groupScheduling.ts`）。
 *
 * mention/polling/free 三种发言模式决定「用户发言后谁回复、自动接力排到谁、
 * 何时交还用户、消息归属给哪个角色」。这是领域状态机的**纯逻辑核心**：
 * 不依赖 Compose / ViewModel / 协程，任何 UI 循环都不得重写这里的判定。
 *
 * 语义钉子（与 PC 逐字一致，禁止"顺手修复"）：
 * - `currentSpeakerIndex % memberIds.size` 必须保持 JS 取模语义：
 *   除数为 0 或负索引均视为越界 → 无发言者（不是抛异常、不是修正为正）；
 * - polling 的 `maxRounds` 按「会话内不同 AI 轮次总数」计数（distinct），
 *   不是每条用户消息的接力上限；`__free__` 占位不算角色发言，`__narrator__` 算；
 * - mention 的 `@名字` 是**子串**匹配（大小写敏感），与 UI 的 @ 选择器是两条独立通道；
 * - polling 模式忽略显式回复目标，一律轮转。
 */
object ChatGroupScheduling {

    const val USER_ID: String = "__user__"
    const val FREE_ID: String = "__free__"

    data class Member(val id: String, val name: String)

    data class MessageRef(val characterId: String, val round: Long)

    /** 下一轮编号：`max(rounds, 0) + 1`（空会话为 1；用户消息与其触发的 AI 回复共用同一轮）。 */
    fun nextGroupRound(rounds: List<Long>): Long {
        var max = 0L
        for (round in rounds) if (round > max) max = round
        return max + 1
    }

    /**
     * @提及检测：正文里出现 `@成员名` 子串的成员 id（按成员顺序）。
     * 匹配的是**原始输入**（PC 在正则处理前采样），大小写敏感。
     */
    fun detectMentionedMembers(content: String, members: List<Member>): List<String> =
        members.filter { content.contains("@" + it.name) }.map { it.id }

    sealed interface SpeakerPlan {
        /** via = "target"（显式指定）或 "round_robin"（currentSpeakerIndex 轮转）。 */
        data class Single(val speakerId: String, val speakerIndex: Int, val via: String) : SpeakerPlan
        object Free : SpeakerPlan
        /** reason = "no_speaker"（未指定发言角色）或 "speaker_missing"（发言角色不存在）。 */
        data class Error(val reason: String) : SpeakerPlan
    }

    /**
     * 一条用户消息之后的发言计划：
     * - mention：回复 `targetCharId`；无目标时回落到 `currentSpeakerIndex` 轮转；
     * - polling：一律轮转（显式目标被忽略）；
     * - 其他模式（含未知模式）：一次生成、多角色拆分（free）。
     */
    fun resolveSpeakerPlan(
        chatMode: String,
        memberIds: List<String>,
        currentSpeakerIndex: Long,
        targetCharId: String? = null,
        knownCharacterIds: List<String>? = null,
    ): SpeakerPlan {
        if (chatMode != "mention" && chatMode != "polling") return SpeakerPlan.Free
        var speakerId: String? = targetCharId
        var via = "target"
        if (chatMode == "polling" || speakerId.isNullOrEmpty()) {
            via = "round_robin"
            val speakerIdx = if (memberIds.isEmpty()) null else currentSpeakerIndex % memberIds.size
            speakerId = speakerIdx?.takeIf { it >= 0 && it < memberIds.size }?.let { memberIds[it.toInt()] }
        }
        if (speakerId.isNullOrEmpty()) return SpeakerPlan.Error("no_speaker")
        if (knownCharacterIds != null && speakerId !in knownCharacterIds) return SpeakerPlan.Error("speaker_missing")
        return SpeakerPlan.Single(speakerId, memberIds.indexOf(speakerId), via)
    }

    sealed interface PollingContinuePlan {
        data class Continue(val nextCharId: String, val nextSpeakerIndex: Int) : PollingContinuePlan
        /** reason = "max_rounds" / "no_last_speaker" / "speaker_not_member"。 */
        data class Stop(val reason: String) : PollingContinuePlan
    }

    /**
     * polling 自动接力的续排计划：
     * - 轮数按会话内非用户消息的 distinct round 计；
     * - 下一发言者 = 最后一条角色消息发言者在成员表中的下一位（循环）；
     * - 上限 / 无角色消息 / 发言者已不在成员表 → 停止，交还用户。
     */
    fun planPollingContinue(
        messages: List<MessageRef>,
        memberIds: List<String>,
        maxRounds: Long,
    ): PollingContinuePlan {
        val characterMessages = messages.filter { it.characterId != USER_ID && it.characterId != FREE_ID }
        val rounds = characterMessages.map { it.round }.toSet()
        if (rounds.size >= maxRounds) return PollingContinuePlan.Stop("max_rounds")
        val lastCharMsg = characterMessages.lastOrNull() ?: return PollingContinuePlan.Stop("no_last_speaker")
        val currentIdx = memberIds.indexOf(lastCharMsg.characterId)
        if (currentIdx < 0) return PollingContinuePlan.Stop("speaker_not_member")
        val nextIdx = (currentIdx + 1) % memberIds.size
        return PollingContinuePlan.Continue(memberIds[nextIdx], nextIdx)
    }

    /** polling 接力间隔：`max(500, speakerInterval || 2000)` 毫秒。 */
    fun resolvePollingIntervalMs(speakerInterval: Long?): Long {
        val base = if (speakerInterval == null || speakerInterval == 0L) 2000L else speakerInterval
        return maxOf(500L, base)
    }

    /**
     * 自动记忆触发判定（PC `checkAutoMemory`）：
     * 仅 memoryEnabled 且 memoryMode='auto'；按「游标之后未总结的消息数」与
     * `autoMemoryInterval || 10` 比较；游标缺失/丢失按全量计数（不误判为 0）。
     */
    fun planAutoMemoryTrigger(
        memoryEnabled: Boolean?,
        memoryMode: String?,
        autoMemoryInterval: Long?,
        memoryLastMessageId: String?,
        messageIds: List<String>,
    ): Boolean {
        if (memoryEnabled != true || memoryMode != "auto") return false
        val interval = if (autoMemoryInterval == null || autoMemoryInterval == 0L) 10L else autoMemoryInterval
        val cursor = memoryLastMessageId
        val cursorIndex = if (cursor.isNullOrEmpty()) -1 else messageIds.indexOf(cursor)
        val unsummarizedCount = if (cursorIndex >= 0) messageIds.size - cursorIndex - 1 else messageIds.size
        return unsummarizedCount >= interval
    }
}
