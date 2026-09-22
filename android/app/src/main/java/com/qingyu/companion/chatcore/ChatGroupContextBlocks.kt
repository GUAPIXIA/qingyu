package com.qingyu.companion.chatcore

/**
 * 阶段 6 S6-01(c)：群上下文装配的确定性文本块
 * （对齐 `shared/chat-core/groupContextBlocks.ts`；出处为 PC
 * `src/store/groupChatContext.ts#buildGroupChatContext` 的对应段）。
 *
 * 语义钉子（与 PC 逐字一致，禁止"顺手修复"）：
 * - free 成员卡的示例在**无示例锚点**时随卡内联（`对话示例：`），有锚点时集中重排
 *   并带成员名（`对话示例（名）：`）；发言人聚焦卡的示例**始终**是 `对话示例：`；
 * - 成员卡块返回值自带前导 `\n\n` 与 lorebookBefore（与 PC `systemContent +=` 拼接语义一致）；
 * - 历史归属：用户消息无名字前缀（图片随消息），角色消息前缀 `【成员名|未知角色】`
 *   且变量替换用**发言者名**做 charName；
 * - 后历史指令 free 逐成员拼接（各带尾换行）/ 聚焦模式仅目标角色；
 * - `includeDescription`/`includePersona` 缺省视为 true。
 */
object ChatGroupContextBlocks {

    data class Member(
        val id: String,
        val name: String,
        val description: String? = null,
        val personality: String? = null,
        val scenario: String? = null,
        val systemPrompt: String? = null,
        val exampleDialog: String? = null,
        val postHistoryInstructions: String? = null,
    )

    data class HistoryMessage(
        val characterId: String,
        val content: String,
        val images: List<String> = emptyList(),
    )

    data class PersonaInjection(
        val enabled: Boolean = true,
        val position: String = "system",
        val includeDescription: Boolean? = null,
        val includePersona: Boolean? = null,
    )

    data class HistoryEntry(
        val role: String,
        val content: String,
        val images: List<String>? = null,
    )

    data class MemberCardsOptions(
        val userName: String,
        val shouldSendScenario: Boolean,
        val lorebookBefore: String = "",
        val lorebookAfter: String = "",
        val exampleBefore: List<String> = emptyList(),
        val exampleAfter: List<String> = emptyList(),
    )

    /** 变量替换用的 charName：mention/polling 为目标角色名，free 为成员名「、」连接。 */
    fun resolveCharNameForVars(targetName: String?, members: List<Member>): String =
        targetName ?: members.joinToString("、") { it.name }

    /**
     * 场景注入门控（scenarioInjectionMode）：
     * `off` 从不注入；`first_turn` 仅首轮（用户消息 ≤ 1 条）；`always` 总是；缺省 first_turn。
     */
    fun resolveShouldSendScenario(scenarioInjectionMode: String?, userMessageCount: Int): Boolean {
        val mode = scenarioInjectionMode ?: "first_turn"
        return mode != "off" && (mode != "first_turn" || userMessageCount <= 1)
    }

    /** free（多成员）角色卡块（含前导 `\n\n` 与世界书前后段）。 */
    fun buildFreeMemberCards(members: List<Member>, opts: MemberCardsOptions): String {
        val userName = opts.userName
        val hasExampleAnchors = opts.exampleBefore.isNotEmpty() || opts.exampleAfter.isNotEmpty()

        var out = "\n\n" + opts.lorebookBefore + "以下是所有角色的完整设定：\n"
        for (m in members) {
            out += "\n--- ${m.name} ---\n"
            if (!m.description.isNullOrEmpty()) out += "描述：" + ChatVariables.replaceVariables(m.description, userName, m.name) + "\n"
            if (!m.personality.isNullOrEmpty()) out += "性格：" + ChatVariables.replaceVariables(m.personality, userName, m.name) + "\n"
            if (opts.shouldSendScenario && !m.scenario.isNullOrEmpty()) {
                out += "场景：" + ChatVariables.replaceVariables(m.scenario, userName, m.name) + "\n"
            }
            if (!m.systemPrompt.isNullOrEmpty()) out += "\n" + ChatVariables.replaceVariables(m.systemPrompt, userName, m.name) + "\n"
            if (!hasExampleAnchors && !m.exampleDialog.isNullOrEmpty()) {
                out += "\n对话示例：\n" + ChatVariables.replaceVariables(m.exampleDialog, userName, m.name) + "\n"
            }
        }
        if (hasExampleAnchors) {
            if (opts.exampleBefore.isNotEmpty()) out += "\n" + opts.exampleBefore.joinToString("\n") + "\n"
            for (m in members) {
                if (!m.exampleDialog.isNullOrEmpty()) {
                    out += "\n对话示例（${m.name}）：\n" + ChatVariables.replaceVariables(m.exampleDialog, userName, m.name) + "\n"
                }
            }
            if (opts.exampleAfter.isNotEmpty()) out += "\n" + opts.exampleAfter.joinToString("\n") + "\n"
        }
        if (opts.lorebookAfter.isNotEmpty()) out += "\n" + opts.lorebookAfter
        return out
    }

    /** mention/polling（发言人聚焦）角色卡块（含前导 `\n\n` 与世界书前后段）。 */
    fun buildTargetMemberCard(target: Member, opts: MemberCardsOptions): String {
        val userName = opts.userName

        var out = "\n\n" + opts.lorebookBefore + "【当前发言角色：" + target.name + "】\n"
        if (!target.description.isNullOrEmpty()) out += "描述：" + ChatVariables.replaceVariables(target.description, userName, target.name) + "\n"
        if (!target.personality.isNullOrEmpty()) out += "性格：" + ChatVariables.replaceVariables(target.personality, userName, target.name) + "\n"
        if (opts.shouldSendScenario && !target.scenario.isNullOrEmpty()) {
            out += "场景：" + ChatVariables.replaceVariables(target.scenario, userName, target.name) + "\n"
        }
        if (!target.systemPrompt.isNullOrEmpty()) out += "\n" + ChatVariables.replaceVariables(target.systemPrompt, userName, target.name) + "\n"
        if (opts.exampleBefore.isNotEmpty()) out += "\n" + opts.exampleBefore.joinToString("\n") + "\n"
        if (!target.exampleDialog.isNullOrEmpty()) {
            out += "\n对话示例：\n" + ChatVariables.replaceVariables(target.exampleDialog, userName, target.name) + "\n"
        }
        if (opts.exampleAfter.isNotEmpty()) out += "\n" + opts.exampleAfter.joinToString("\n") + "\n"
        if (opts.lorebookAfter.isNotEmpty()) out += "\n" + opts.lorebookAfter
        return out
    }

    /**
     * 用户人设正文（不含 `【用户人设】` 标题；标题由调用方按注入位置补）。
     * [PersonaInjection.includeDescription]/[PersonaInjection.includePersona] 为 null 视为 true。
     */
    fun buildUserPersona(
        userName: String,
        userDescription: String?,
        userPersona: String?,
        charNameForVars: String,
        injection: PersonaInjection?,
    ): String {
        val eff = injection ?: PersonaInjection()
        if (!eff.enabled) return ""
        var text = "用户名：$userName\n"
        if (eff.includeDescription != false && !userDescription.isNullOrEmpty()) {
            text += "描述：" + ChatVariables.replaceVariables(userDescription, userName, charNameForVars) + "\n"
        }
        if (eff.includePersona != false && !userPersona.isNullOrEmpty()) {
            text += "性格：" + ChatVariables.replaceVariables(userPersona, userName, charNameForVars) + "\n"
        }
        return text
    }

    /**
     * 历史消息 → prompt 消息的归属标注：空正文跳过；用户消息无前缀（图片随消息）；
     * 角色消息前缀 `【成员名|未知角色】` 且变量替换用发言者名。
     */
    fun mapHistoryMessages(
        messages: List<HistoryMessage>,
        members: List<Member>,
        userName: String,
        charNameForVars: String,
    ): List<HistoryEntry> {
        val out = ArrayList<HistoryEntry>()
        for (m in messages) {
            if (m.content.isEmpty() || m.content.isBlank()) continue
            val char = members.firstOrNull { it.id == m.characterId }
            val speaker = if (m.characterId == "__user__") userName else (char?.name ?: "未知角色")
            if (m.characterId == "__user__") {
                out += HistoryEntry(
                    role = "user",
                    content = ChatVariables.replaceVariables(m.content, userName, charNameForVars),
                    images = if (m.images.isNotEmpty()) m.images else null,
                )
            } else {
                out += HistoryEntry(
                    role = "assistant",
                    content = "【$speaker】" + ChatVariables.replaceVariables(m.content, userName, speaker),
                )
            }
        }
        return out
    }

    /**
     * 后历史指令：free 逐成员拼接（各带尾换行，变量替换用该成员名）；
     * mention/polling 仅目标角色（变量替换用 charNameForVars）。调用方 trim() 后注入。
     */
    fun buildPostHistoryInstructions(
        chatMode: String,
        members: List<Member>,
        target: Member?,
        userName: String,
        charNameForVars: String,
    ): String {
        if (chatMode == "free") {
            var text = ""
            for (m in members) {
                if (!m.postHistoryInstructions.isNullOrEmpty()) {
                    text += ChatVariables.replaceVariables(m.postHistoryInstructions, userName, m.name) + "\n"
                }
            }
            return text
        }
        val instructions = target?.postHistoryInstructions ?: return ""
        return ChatVariables.replaceVariables(instructions, userName, charNameForVars)
    }
}
