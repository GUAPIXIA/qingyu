package com.qingyu.companion.chatcore

/**
 * 阶段 6 S6-01(c)：群上下文的公共提示词段
 * （对齐 `shared/groupChatPrompt.ts`，与 PC 桌面/桥接共用段逐字一致）。
 *
 * 为什么必须逐字节对齐：这两段决定「群里有谁、谁被点名、谁在发言」。
 * 措辞漂移会让同一会话两端得到不同发言行为。
 */
object ChatGroupPrompts {

    /** 群聊成员概览段的成员项（只用 name/description 两字段）。 */
    data class RosterMember(
        val name: String,
        val description: String? = null,
    )

    /** 群聊成员概览段（含用户在场声明）。 */
    fun buildGroupRosterIntro(
        groupName: String,
        members: List<RosterMember>,
        userName: String,
    ): String {
        var systemContent = "你正在参与一个群聊「$groupName」。本群聊中共有 ${members.size} 个角色参与对话：\n"
        members.forEachIndexed { index, member ->
            // TS `description ? ' - ' + slice(0, 80) : ''`：空串视为无描述；80 按 UTF-16 码元截断
            val desc = if (!member.description.isNullOrEmpty()) " - " + member.description.take(80) else ""
            systemContent += "${index + 1}. 【${member.name}】$desc\n"
        }
        systemContent += "\n用户「$userName」也在群聊中。\n"
        return systemContent
    }

    /**
     * 点名/轮询模式的【对话规则】段；其他模式返回空串
     * （由调用方注入自己的 free 规则——桌面 free 规则与桥接有意不同，见 PC `groupChatContext.ts`）。
     */
    fun buildGroupTurnRulesPrompt(chatMode: String): String = when (chatMode) {
        "mention" ->
            "\n【对话规则】用户通过 @角色名 指定回复对象。只有被点名的角色才需要回复。" +
                "对白必须是该角色自己的第一人称；动作/神态可用第三人称叙述（与单聊一致），不要替其他角色说话。\n"
        "polling" ->
            "\n【对话规则】当前采用自动轮询模式。每次只轮到一位角色发言。" +
                "对白必须是该角色自己的第一人称；动作/神态可用第三人称叙述（与单聊一致），不要替其他角色或用户发言。\n"
        else -> ""
    }
}
