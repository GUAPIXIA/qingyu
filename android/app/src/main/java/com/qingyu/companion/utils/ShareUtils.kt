package com.qingyu.companion.utils

import com.qingyu.companion.model.Message

/**
 * 分享/复制工具（路线图 5.2）
 * - 单条消息：纯文本 / Markdown
 * - 整段会话：导出文本 / Markdown 并走系统 Share Sheet
 */
object ShareUtils {

    fun messageToPlainText(message: Message): String {
        val roleLabel = if (message.role.name == "user") "我" else "角色"
        val sb = StringBuilder()
        sb.append("[$roleLabel] ")
        sb.append(message.content.trim())
        if (message.images.isNotEmpty()) {
            sb.append("\n[图片 x${message.images.size}]")
        }
        return sb.toString()
    }

    fun messageToMarkdown(message: Message): String {
        val roleLabel = if (message.role.name == "user") "**我**" else "**角色**"
        val sb = StringBuilder()
        sb.append("$roleLabel: ")
        sb.append(message.content.trim())
        if (message.images.isNotEmpty()) {
            message.images.forEachIndexed { idx, _ ->
                sb.append("\n![image${idx + 1}](image${idx + 1})")
            }
        }
        return sb.toString()
    }

    fun sessionToPlainText(messages: List<Message>): String {
        if (messages.isEmpty()) return ""
        return messages.joinToString("\n\n") { messageToPlainText(it) }
    }

    fun sessionToMarkdown(messages: List<Message>): String {
        if (messages.isEmpty()) return ""
        return messages.joinToString("\n\n---\n\n") { messageToMarkdown(it) }
    }

    fun sessionExportText(messages: List<Message>, asMarkdown: Boolean): String {
        return if (asMarkdown) sessionToMarkdown(messages) else sessionToPlainText(messages)
    }
}
