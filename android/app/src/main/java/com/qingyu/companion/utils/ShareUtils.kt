package com.qingyu.companion.utils

import com.qingyu.companion.chatcore.ChatSessionExport
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

    /**
     * 整段会话导出（阶段 4 S4-04）。
     *
     * **必须走 [ChatSessionExport]**：导出结构、角色标签与转义与 PC 共用同一份契约
     * （fixture `session-export.json` 锁定）。此前这里是「`**我**` / `**角色**` + `---`」的
     * 简化格式，与 PC 的「`# 对话记录` + `### 🧑 用户 · 时间`」不同——
     * 同一段对话在两端导出会得到两个不同的文件。
     */
    fun sessionExportText(messages: List<Message>, asMarkdown: Boolean): String {
        if (messages.isEmpty()) return ""
        return if (asMarkdown) {
            ChatSessionExport.exportSessionMarkdown(messages.map { it.toExportMessage() })
        } else {
            sessionToPlainText(messages)
        }
    }

    /** 会话导出为 JSON（与 PC 的 `/export json` 等价）。 */
    fun sessionExportJson(messages: List<Message>): String =
        ChatSessionExport.exportSessionJson(
            // id 参与导出的规范键序首位（与 PC 的 EXPORT_KEY_ORDER 一致）
            messages.map { ChatSessionExport.toJsonMap(it.toExportMessage(), extra = mapOf("id" to it.id)) },
        )

    private fun Message.toExportMessage(): ChatSessionExport.ExportMessage =
        ChatSessionExport.ExportMessage(
            role = role.name,
            content = content,
            timestamp = timestamp,
            images = images.takeIf { list -> list.isNotEmpty() },
        )
}
