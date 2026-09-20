package com.qingyu.companion.chatcore

/**
 * 与 JS `JSON.stringify` 语义一致的**最小 JSON 编码器**。
 *
 * 为什么不用 `org.json`：
 * 1. Android 的 `JSONObject.toString()` 会把 `/` 转义成 `\/`，而 JS 不转义——
 *    这会让同一条含 URL 的内容在两端产生不同字节（导出轮已实测到）；
 * 2. `org.json` 在 JVM 单元测试（非 Robolectric）中未实现，会让纯逻辑测试无法运行。
 *
 * 本模块只覆盖项目实际需要的形状：字符串数组与字符串对象字段。
 * 非 ASCII 与 emoji 原样输出（与 JS 一致）。
 */
object ChatJsonCodec {

    /** JS 风格字符串转义：只处理 `"`、`\` 与控制字符。 */
    fun quote(text: String): String {
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
     * 字符串数组 → JSON（**紧凑**格式，与 JS `JSON.stringify([...])` 一致，无空格）。
     * 用于 `swipes_json` 这类需要与 PC 逐字节一致的持久化字段。
     */
    fun encodeStringArray(values: List<String>): String =
        values.joinToString(prefix = "[", postfix = "]", separator = ",") { quote(it) }

    /**
     * 字符串数组解码；非法 JSON 返回 null（由调用方决定是否视为损坏）。
     *
     * 刻意**不依赖 `org.json`**：它在 JVM 单元测试（非 Robolectric）中未实现，
     * 会让纯逻辑测试静默拿到 null——本项目已在两处踩过这个坑。
     * 这里只需要解析自己编码出的（以及 PC `JSON.stringify` 产出的）字符串数组。
     */
    fun decodeStringArray(json: String?): List<String>? {
        if (json.isNullOrBlank()) return null
        val text = json.trim()
        if (!text.startsWith("[") || !text.endsWith("]")) return null
        val body = text.substring(1, text.length - 1).trim()
        if (body.isEmpty()) return emptyList()

        val values = mutableListOf<String>()
        var index = 0
        while (index < body.length) {
            // 元素间跳过空白与逗号
            while (index < body.length && (body[index] == ',' || body[index].isWhitespace())) index++
            if (index >= body.length) break
            if (body[index] != '"') return null
            index++
            val builder = StringBuilder()
            var closed = false
            while (index < body.length) {
                val ch = body[index]
                if (ch == '\\') {
                    if (index + 1 >= body.length) return null
                    when (val escaped = body[index + 1]) {
                        '"' -> builder.append('"')
                        '\\' -> builder.append('\\')
                        '/' -> builder.append('/')
                        'b' -> builder.append('\b')
                        'f' -> builder.append('\u000C')
                        'n' -> builder.append('\n')
                        'r' -> builder.append('\r')
                        't' -> builder.append('\t')
                        'u' -> {
                            if (index + 5 >= body.length) return null
                            val code = body.substring(index + 2, index + 6).toIntOrNull(16) ?: return null
                            builder.append(code.toChar())
                            index += 4
                        }
                        else -> return null
                    }
                    index += 2
                    continue
                }
                if (ch == '"') {
                    closed = true
                    index++
                    break
                }
                builder.append(ch)
                index++
            }
            if (!closed) return null
            values += builder.toString()
        }
        return values
    }
}
