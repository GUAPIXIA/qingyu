package com.qingyu.companion.ui.groups

import com.qingyu.companion.chatcore.ChatGroupFreeSplit
import com.qingyu.companion.chatcore.ChatGroupScheduling
import com.qingyu.companion.model.GroupMessage

/**
 * 群导出（S6-01(f) 第 4 项，D-14 群口径）。
 *
 * **不复用**单聊 `ChatSessionExport` 的单角色叙事——群导出用**群口径 Markdown**：
 * 每条按发言者归属列出（用户／旁白／成员），按 (round, timestamp, id) 稳定排序。
 *
 * PC 现状对齐处（D-14，登记不「顺手修复」）：PC 群导出 md 的 speaker 取 `characterId`
 * **原值**、与单聊 `sessionExport` 不同源。本实现为**新口径**（speaker 取成员显示名），
 * 与 PC 现状的差异点即「speaker 显示名 vs characterId 原值」——此差异已在此标注，
 * 若产品要求逐字对齐 PC 现状，改 [speakerLabel] 一处即可（回退 characterId 原值）。
 *
 * 纯函数，JVM 可测。正文保持干净：`generationError`／`generationNotice` **不进正文行**
 * （语义钉子：错误绝不进正文）；如需保留提示，另起附注段。
 */
object GroupExport {

    /** 发言者显示名（新口径）：用户 → 用户名，旁白 → 旁白，成员 → 显示名，未知回退 characterId。 */
    internal fun speakerLabel(
        characterId: String,
        memberNames: Map<String, String>,
        userName: String,
    ): String = when (characterId) {
        ChatGroupScheduling.USER_ID -> userName.ifBlank { "用户" }
        ChatGroupFreeSplit.NARRATOR_ID -> "旁白"
        else -> memberNames[characterId] ?: characterId
    }

    /** (round, timestamp, id) 稳定排序，避免逻辑时间相同时顺序漂移。 */
    internal fun sorted(messages: List<GroupMessage>): List<GroupMessage> =
        messages.sortedWith(compareBy({ it.round }, { it.timestamp }, { it.id }))

    /** 单条正文行：`【发言者】正文`。 */
    internal fun line(speaker: String, content: String): String = "【${speaker}】${content}"

    /**
     * 构造群口径 Markdown 导出文本。
     *
     * @param groupName 群名
     * @param sessionTitle 会话标题
     * @param memberNames 成员显示名（characterId -> name）
     * @param userName 用户显示名
     */
    fun build(
        groupName: String,
        sessionTitle: String,
        memberNames: Map<String, String>,
        userName: String,
        messages: List<GroupMessage>,
        exportedAt: Long,
    ): String {
        val body = sorted(messages)
        val members = memberNames.values.filter { it.isNotBlank() }
        val sb = StringBuilder()
        sb.appendLine("# ${groupName.ifBlank { "群聊" }}")
        sb.appendLine()
        sb.appendLine("- 会话：${sessionTitle.ifBlank { "未命名" }}")
        if (members.isNotEmpty()) sb.appendLine("- 成员：${members.joinToString("、")}")
        sb.appendLine("- 导出时间：${exportedAt}")
        sb.appendLine()
        sb.appendLine("## 对话")
        for (m in body) {
            // 正文干净：只导出 content，不拼 generationError／generationNotice（语义钉子）
            val speaker = speakerLabel(m.characterId, memberNames, userName)
            sb.appendLine(line(speaker, m.content))
        }
        return sb.toString()
    }
}
