package com.qingyu.companion.utils

import com.qingyu.companion.model.Character
import com.qingyu.companion.model.Message
import com.qingyu.companion.model.SessionPreview

/**
 * 端侧搜索工具（路线图 5.2）
 * 基于 Room 已缓存数据（会话/角色/消息），纯内存过滤，先端侧后扩展 PC 全量
 */
object SearchUtils {

    fun filterSessions(sessions: List<SessionPreview>, query: String): List<SessionPreview> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return sessions
        return sessions.filter { s ->
            s.title.lowercase().contains(q) ||
                s.characterId.lowercase().contains(q) ||
                s.id.lowercase().contains(q)
        }
    }

    fun filterCharacters(characters: List<Character>, query: String): List<Character> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return characters
        return characters.filter { c ->
            c.name.lowercase().contains(q) ||
                c.description.lowercase().contains(q) ||
                c.tags.any { it.lowercase().contains(q) }
        }
    }

    fun filterMessages(messages: List<Message>, query: String): List<Message> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return messages
        return messages.filter { m ->
            m.content.lowercase().contains(q) ||
                (m.translation?.lowercase()?.contains(q) == true)
        }
    }

    fun highlightMatches(text: String, query: String): List<Pair<String, Boolean>> {
        if (query.isBlank()) return listOf(text to false)
        val q = query.lowercase()
        val lower = text.lowercase()
        val result = mutableListOf<Pair<String, Boolean>>()
        var idx = 0
        var pos = lower.indexOf(q, idx)
        while (pos >= 0) {
            if (pos > idx) result.add(text.substring(idx, pos) to false)
            result.add(text.substring(pos, pos + q.length) to true)
            idx = pos + q.length
            pos = lower.indexOf(q, idx)
        }
        if (idx < text.length) result.add(text.substring(idx) to false)
        return result
    }

    // ===================== E-05 聊天内搜索：匹配 id 列表 + 上一项/下一项导航 =====================

    /** 单条消息是否命中查询（内容或译文，忽略大小写；空查询不命中） */
    fun messageMatches(message: Message, query: String): Boolean {
        val q = query.trim()
        if (q.isEmpty()) return false
        return message.content.contains(q, ignoreCase = true) ||
            message.translation?.contains(q, ignoreCase = true) == true
    }

    /**
     * 聊天内搜索：维护**匹配 messageId 列表**（不再只过滤时间线）。
     * 顺序与输入一致（ChatScreen 传「底->上」时间线内的消息顺序，index 0 = 最新）。
     * 空查询返回空列表。
     */
    fun matchingMessageIds(messages: List<Message>, query: String): List<String> =
        if (query.trim().isEmpty()) {
            emptyList()
        } else {
            messages.filter { messageMatches(it, query) }.map { it.id }
        }

    /**
     * 上一项/下一项导航（纯函数）：
     * 以 currentIndex 为当前匹配位置（不在列表中时按「最近的下一项」定位），
     * 返回移动后应高亮的匹配下标；列表为空返回 null。
     *
     * @param matches 匹配 id 列表（顺序即展示顺序）
     * @param currentIndex 当前高亮下标（可为 -1 / 越界）
     * @param direction 1 = 下一项（更旧，视觉上方），-1 = 上一项（更新，视觉下方）
     */
    fun navigateMatch(
        matches: List<String>,
        currentIndex: Int,
        direction: Int,
    ): Int? {
        if (matches.isEmpty()) return null
        val size = matches.size
        val base = currentIndex.takeIf { it in 0 until size } ?: return 0
        return ((base + direction) % size + size) % size
    }
}
