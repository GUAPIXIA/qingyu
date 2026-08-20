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
}
