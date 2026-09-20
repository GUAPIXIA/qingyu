package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-04：会话导出（Markdown / JSON）
 * （对齐 `shared/chat-core/sessionExport.ts`）。
 *
 * 为什么必须共用同一份逻辑：同一段对话在 PC 与 Android 上导出应当得到**同一个文件**，
 * 否则「导出」在两端就是两个不同的功能。结构与转义由 fixture `session-export.json` 锁定。
 *
 * 时间渲染是**注入项**：`toLocaleString('zh-CN')` 的产物依赖运行时 ICU 数据，
 * 两端未必逐字节相同。因此本模块默认使用自己实现的 `zh-CN` 风格格式化
 * （`yyyy/M/d HH:mm:ss`，与 Node 的 zh-CN 输出一致），并允许调用方覆盖。
 */
object ChatSessionExport {

    /** 导出所需的字段子集（避免把 UI 模型耦进来）。 */
    data class ExportMessage(
        val role: String,
        val content: String,
        val timestamp: Long,
        val images: List<String>? = null,
    )

    /** 时间渲染函数；缺省为 zh-CN 风格。 */
    fun interface TimeFormatter {
        fun format(timestamp: Long): String
    }

    /** 默认时间渲染：与 Node `new Date(ts).toLocaleString('zh-CN')` 同形（月/日不补零）。 */
    val DEFAULT_TIME_FORMATTER = TimeFormatter { timestamp ->
        val calendar = java.util.Calendar.getInstance()
        calendar.timeInMillis = timestamp
        val year = calendar.get(java.util.Calendar.YEAR)
        val month = calendar.get(java.util.Calendar.MONTH) + 1
        val day = calendar.get(java.util.Calendar.DAY_OF_MONTH)
        val hour = calendar.get(java.util.Calendar.HOUR_OF_DAY)
        val minute = calendar.get(java.util.Calendar.MINUTE)
        val second = calendar.get(java.util.Calendar.SECOND)
        "%d/%d/%d %02d:%02d:%02d".format(year, month, day, hour, minute, second)
    }

    /**
     * 导出 Markdown 时转义消息内容中的特殊字符。
     * 防止内容中的 `#` 标题 / `*斜体*` / `` `代码` `` / `![图片]` 破坏导出格式。
     */
    fun escapeMarkdownContent(text: String): String {
        val escaped = StringBuilder(text.length + 8)
        for (ch in text) {
            if (ch == '\\' || ch == '`' || ch == '*' || ch == '_' || ch == '[' || ch == ']' ||
                ch == '{' || ch == '}' || ch == '#'
            ) {
                escaped.append('\\')
            }
            escaped.append(ch)
        }
        // 图片语法前导：上一步已把 `[` 转义为 `\[`，此处把 `!\[` 整体转义为 `\!\[`（防图片注入）
        return escaped.toString().replace("!\\[", "\\!\\[")
    }

    /** 角色标签（导出用）。 */
    fun exportRoleLabel(role: String): String = when (role) {
        "user" -> "🧑 用户"
        "assistant" -> "🎭 AI"
        else -> "系统"
    }

    /**
     * 会话 → Markdown。
     * 结构：`# 对话记录` + 每条消息的 `### 标签 · 时间` + 图片 + 转义正文 + 分隔线。
     */
    fun exportSessionMarkdown(
        messages: List<ExportMessage>,
        formatTime: TimeFormatter = DEFAULT_TIME_FORMATTER,
    ): String {
        val builder = StringBuilder()
        builder.append("# 对话记录\n\n")
        for (message in messages) {
            builder.append("### ").append(exportRoleLabel(message.role)).append(" · ")
                .append(formatTime.format(message.timestamp)).append("\n\n")
            // 图片：base64 data URI 不转义，保留图片语法
            message.images?.forEach { image ->
                builder.append("![图片](").append(image).append(")\n\n")
            }
            builder.append(escapeMarkdownContent(message.content)).append("\n\n---\n\n")
        }
        return builder.toString()
    }

    /**
     * 会话 → JSON：原始消息数组，2 空格缩进（与 PC 的 `JSON.stringify(..., null, 2)` 一致）。
     *
     * **为什么不用 `org.json`**：Android 的 `JSONObject.toString()` 会把 `/` 转义成 `\/`，
     * 而 JS `JSON.stringify` 不转义。这会让同一条含 URL 的消息在两端导出不同的文件
     * （fixture 已抓出该分歧）。因此这里实现与 JS 语义一致的序列化：
     * 只转义 `"`、`\` 与控制字符；非 ASCII 与 emoji 原样输出。
     */
    fun exportSessionJson(messages: List<Map<String, Any?>>): String = jsStringify(messages, 0)

    /**
     * 与 JS `JSON.stringify(value, null, 2)` 等价的序列化。
     * - 对象键按插入顺序输出（调用方用 LinkedHashMap 保证稳定）；
     * - 空对象/空数组输出 `{}` / `[]`（不带换行）；
     * - 非有限数值输出 `null`（JS 行为）。
     */
    private fun jsStringify(value: Any?, indent: Int): String = when (value) {
        null -> "null"
        is String -> jsQuote(value)
        is Boolean -> if (value) "true" else "false"
        is Double -> when {
            value.isNaN() || value.isInfinite() -> "null"
            value == Math.floor(value) && !value.isInfinite() -> value.toLong().toString()
            else -> value.toString()
        }
        is Float -> when {
            value.isNaN() || value.isInfinite() -> "null"
            value == Math.floor(value.toDouble()) -> value.toLong().toString()
            else -> value.toString()
        }
        is Number -> value.toString()
        is Map<*, *> -> {
            if (value.isEmpty()) {
                "{}"
            } else {
                val pad = "  ".repeat(indent + 1)
                val closePad = "  ".repeat(indent)
                value.entries.joinToString(",\n") { (key, item) ->
                    "$pad${jsQuote(key.toString())}: ${jsStringify(item, indent + 1)}"
                }.let { "{\n$it\n$closePad}" }
            }
        }
        is List<*> -> {
            if (value.isEmpty()) {
                "[]"
            } else {
                val pad = "  ".repeat(indent + 1)
                val closePad = "  ".repeat(indent)
                value.joinToString(",\n") { item -> "$pad${jsStringify(item, indent + 1)}" }
                    .let { "[\n$it\n$closePad]" }
            }
        }
        else -> jsQuote(value.toString())
    }

    /** JS 风格字符串转义：只处理 `"`、`\` 与控制字符，非 ASCII 原样保留。 */
    private fun jsQuote(text: String): String {
        val builder = StringBuilder(text.length + 2)
        builder.append('"')
        for (ch in text) {
            when (ch) {
                '"' -> builder.append("\\\"")
                '\\' -> builder.append("\\\\")
                '\b' -> builder.append("\\b")
                '\u000C' -> builder.append("\\f")
                '\n' -> builder.append("\\n")
                '\r' -> builder.append("\\r")
                '\t' -> builder.append("\\t")
                else -> if (ch < ' ') {
                    builder.append("\\u").append("%04x".format(ch.code))
                } else {
                    builder.append(ch)
                }
            }
        }
        builder.append('"')
        return builder.toString()
    }

    /**
     * 由导出模型构造**稳定键序**的 JSON 结构（与 PC 消息字段顺序一致）。
     * 返回 `LinkedHashMap` 以保证键序稳定。
     */
    fun toJsonMap(message: ExportMessage, extra: Map<String, Any?> = emptyMap()): LinkedHashMap<String, Any?> {
        // 键序必须与 PC 的 EXPORT_KEY_ORDER 一致：id → role → content → images → timestamp。
        // images 仅非空时输出（与 PC 相同），避免两端产出不同形状。
        val map = LinkedHashMap<String, Any?>()
        val id = extra["id"]
        if (id is String && id.isNotEmpty()) map["id"] = id
        map["role"] = message.role
        map["content"] = message.content
        if (!message.images.isNullOrEmpty()) map["images"] = message.images
        map["timestamp"] = message.timestamp
        for ((key, value) in extra) if (key != "id") map[key] = value
        return map
    }
}
