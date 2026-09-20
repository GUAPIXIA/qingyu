package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-01：消息后处理（对齐 `shared/chat-core/messagePostProcess.ts`
 * 与 `shared/thoughtMarkup.ts` 的供应商推理清理）。
 */
object ChatMessagePostProcess {

    // ---------------------------------------------------------------- 供应商推理清理

    private val VENDOR_THINKING_BLOCK =
        Regex("<\\s*(?:think|thinking)\\b[^>]*>[\\s\\S]*?(?:<\\s*/\\s*(?:think|thinking)\\s*>|$)", RegexOption.IGNORE_CASE)
    private val ORPHAN_VENDOR_THINKING_TAG = Regex("<\\s*/\\s*(?:think|thinking)\\s*>", RegexOption.IGNORE_CASE)

    /** 删除 `<think>` / `<thinking>` 推理标记及其内容；`<thought>` 原样保留。 */
    fun stripVendorThinking(text: String): String {
        if (text.isEmpty()) return text
        return VENDOR_THINKING_BLOCK.replace(text, "").let { ORPHAN_VENDOR_THINKING_TAG.replace(it, "") }
    }

    // ---------------------------------------------------------------- 合并策略

    /**
     * MERGE 模式：连续同角色合并；system 穿插在 user/assistant 之后时并入前一条；
     * `keepSeparate` 的消息（at_depth 世界书、作者注释）保持独立。
     */
    fun mergeConsecutiveMessages(messages: List<ChatPromptConverters.ChatMessage>): List<ChatPromptConverters.ChatMessage> {
        if (messages.isEmpty()) return emptyList()
        val merged = mutableListOf<ChatPromptConverters.ChatMessage>()
        for (msg in messages) {
            if (merged.isEmpty()) {
                merged += msg
                continue
            }
            val lastIndex = merged.lastIndex
            val last = merged[lastIndex]
            if (msg.keepSeparate || last.keepSeparate) {
                merged += msg
                continue
            }
            when {
                last.role == msg.role -> merged[lastIndex] = last.copy(
                    content = last.content + "\n\n" + msg.content,
                    images = mergeImages(last.images, msg.images),
                )
                msg.role == "system" && (last.role == "user" || last.role == "assistant") ->
                    merged[lastIndex] = last.copy(content = last.content + "\n\n" + msg.content)
                else -> merged += msg
            }
        }
        return merged
    }

    /** STRICT 模式：先 MERGE，再强制 user/assistant 交替（防御 system 穿插边界）。 */
    fun strictAlternatingMessages(messages: List<ChatPromptConverters.ChatMessage>): List<ChatPromptConverters.ChatMessage> {
        if (messages.isEmpty()) return emptyList()
        val result = mergeConsecutiveMessages(messages)
        val final = mutableListOf<ChatPromptConverters.ChatMessage>()
        for (msg in result) {
            if (msg.role == "system") {
                final += msg
                continue
            }
            if (final.isEmpty()) {
                final += msg
                continue
            }
            val lastIndex = final.lastIndex
            val last = final[lastIndex]
            if (last.role == msg.role) {
                final[lastIndex] = last.copy(content = last.content + "\n\n" + msg.content)
            } else {
                final += msg
            }
        }
        return final
    }

    /** SEMI 模式：system 可连续，user/assistant 相同角色合并。 */
    fun semiStrictMessages(messages: List<ChatPromptConverters.ChatMessage>): List<ChatPromptConverters.ChatMessage> {
        if (messages.isEmpty()) return emptyList()
        val result = mutableListOf<ChatPromptConverters.ChatMessage>()
        for (msg in messages) {
            if (result.isEmpty()) {
                result += msg
                continue
            }
            val lastIndex = result.lastIndex
            val last = result[lastIndex]
            when {
                msg.role == "system" && last.role == "system" ->
                    result[lastIndex] = last.copy(content = last.content + "\n\n" + msg.content)
                msg.role == last.role && msg.role != "system" ->
                    result[lastIndex] = last.copy(content = last.content + "\n\n" + msg.content)
                else -> result += msg
            }
        }
        return result
    }

    // ---------------------------------------------------------------- 代入式对白前缀

    /**
     * immersive 模式下，给「独占一行且只有一对引号」的裸对白补角色名前缀。
     * 行内已含角色名（避免重复人名）、全局叙事（omniscient）、thought 块内一律保持原样。
     */
    fun normalizeRoleplayDialoguePrefixes(text: String, characterName: String, narrativeMode: String): String {
        val name = characterName.trim()
        if (text.isEmpty() || name.isEmpty() || narrativeMode != "immersive") return text

        val normalizeVisibleLines: (String) -> String = { segment ->
            Regex("[^\\r\\n]+").replace(segment) { match ->
                val line = match.value
                val trimmed = line.trim()
                val isBareDialogue = (trimmed.startsWith("“") && trimmed.endsWith("”")) ||
                    (trimmed.startsWith("「") && trimmed.endsWith("」"))
                if (!isBareDialogue || trimmed.contains(name)) {
                    line
                } else {
                    val leading = Regex("^\\s*").find(line)?.value ?: ""
                    val trailing = Regex("\\s*$").find(line)?.value ?: ""
                    "${leading}${name}：${trimmed}${trailing}"
                }
            }
        }

        val tagRegex = Regex("<\\s*(/?)\\s*(?:thought|think|thinking)\\b[^>]*>", RegexOption.IGNORE_CASE)
        var depth = 0
        var cursor = 0
        val result = StringBuilder()
        for (match in tagRegex.findAll(text)) {
            val segment = text.substring(cursor, match.range.first)
            result.append(if (depth == 0) normalizeVisibleLines(segment) else segment)
            result.append(match.value)
            depth = if (match.groupValues[1].isNotEmpty()) maxOf(0, depth - 1) else depth + 1
            cursor = match.range.last + 1
        }
        val tail = text.substring(cursor)
        result.append(if (depth == 0) normalizeVisibleLines(tail) else tail)
        return result.toString()
    }

    // ---------------------------------------------------------------- thought 提取

    private val THOUGHT_TAG = Regex("\\\\?<\\s*(/?)\\s*thought\\b[^>]*>", RegexOption.IGNORE_CASE)

    data class ThoughtResult(val thought: String?, val content: String, val isFallback: Boolean)

    private class ParsedThought(val thought: String?, val content: String)

    /**
     * 以标签状态扫描文本，容错模型输出：
     * - 孤立结束标签：其前面的片段视为泄漏的思考内容；
     * - 未闭合开始标签：其后剩余文本视为思考内容；
     * - 多个 thought 块按 `\n\n` 拼接。
     */
    private fun parseThoughtBlocks(text: String): ParsedThought {
        val normalized = stripVendorThinking(text)
        val thoughts = mutableListOf<String>()
        val contentParts = StringBuilder()
        val activeThoughtParts = StringBuilder()
        var depth = 0
        var cursor = 0

        fun flushThought() {
            val value = activeThoughtParts.toString().trim()
            if (value.isNotEmpty()) thoughts += value
            activeThoughtParts.setLength(0)
        }

        for (match in THOUGHT_TAG.findAll(normalized)) {
            val segment = normalized.substring(cursor, match.range.first)
            val isClosing = match.groupValues[1] == "/"
            if (isClosing) {
                if (depth > 0) {
                    activeThoughtParts.append(segment)
                    depth--
                    if (depth == 0) flushThought()
                } else {
                    val leaked = segment.trim()
                    if (leaked.isNotEmpty()) thoughts += leaked
                }
            } else {
                if (depth > 0) activeThoughtParts.append(segment) else contentParts.append(segment)
                depth++
            }
            cursor = match.range.last + 1
        }

        val tail = normalized.substring(cursor)
        if (depth > 0) {
            activeThoughtParts.append(tail)
            flushThought()
        } else {
            contentParts.append(tail)
        }

        return ParsedThought(
            thought = if (thoughts.isEmpty()) null else thoughts.joinToString("\n\n"),
            content = contentParts.toString().trim(),
        )
    }

    /** 提取 thought；剥离后正文为空时回退到思考内容并标记 `isFallback`。 */
    fun extractThought(text: String): ThoughtResult {
        if (text.isEmpty()) return ThoughtResult(null, "", false)
        val parsed = parseThoughtBlocks(text)
        val stripped = parsed.content
        val isFallback = stripped.isEmpty() && !parsed.thought.isNullOrEmpty()
        val content = stripped.ifEmpty { parsed.thought ?: "" }
        return ThoughtResult(parsed.thought, content, isFallback)
    }

    /** 剥离 thought 块，返回剩余正文（不做空回退）。 */
    fun stripThought(text: String): String = if (text.isEmpty()) text else parseThoughtBlocks(text).content

    /** 去掉 thought 标签本身但保留内容（TTS 朗读内心想法等场景）。 */
    fun stripThoughtTags(text: String): String {
        if (text.isEmpty()) return text
        return THOUGHT_TAG.replace(stripVendorThinking(text), "").trim()
    }

    // ---------------------------------------------------------------- 续写接缝去重

    /** 续写接缝：达到该长度直接去重。 */
    const val CONTINUATION_SEAM_MIN_OVERLAP = 4

    /** 续写接缝下限：3 字仅允许在边界处去重。 */
    const val CONTINUATION_SEAM_FLOOR_OVERLAP = 3

    private const val MIN_CONTINUATION_OVERLAP = 8

    private val SEAM_BOUNDARY =
        Regex("[\\s，。！？；：、,.!?;:…—～~“”‘’「」『』（）()［］【】〔〕《》〈〉*#-]")

    private fun isSeamBoundary(prev: String, next: String, overlap: Int): Boolean {
        val before = if (prev.length > overlap) prev[prev.length - overlap - 1].toString() else ""
        if (before.isEmpty() || SEAM_BOUNDARY.containsMatchIn(before)) return true
        val after = if (next.length > overlap) next[overlap].toString() else ""
        return after.isEmpty() || SEAM_BOUNDARY.containsMatchIn(after)
    }

    /** S4 续写接缝去重：阈值 4，3 字仅在边界处去重。 */
    fun trimContinuationSeam(prev: String, next: String): String {
        if (prev.isEmpty() || next.isEmpty()) return next
        val maxOverlap = minOf(prev.length, next.length)
        if (maxOverlap < CONTINUATION_SEAM_FLOOR_OVERLAP) return next
        val overlap = maxSuffixPrefix(prev, next)
        if (overlap >= CONTINUATION_SEAM_MIN_OVERLAP) {
            return next.substring(overlap).replace(Regex("^\\s+"), "")
        }
        if (overlap == CONTINUATION_SEAM_FLOOR_OVERLAP && isSeamBoundary(prev, next, overlap)) {
            return next.substring(overlap).replace(Regex("^\\s+"), "")
        }
        return next
    }

    /** 通用续写复述去重（默认阈值 8，供自动补尾等保守场景）。 */
    fun trimContinuationOverlap(prev: String, next: String, minOverlap: Int = MIN_CONTINUATION_OVERLAP): String {
        if (prev.isEmpty() || next.isEmpty()) return next
        val maxOverlap = minOf(prev.length, next.length)
        if (maxOverlap < minOverlap) return next
        val overlap = maxSuffixPrefix(prev, next)
        if (overlap >= minOverlap) {
            return next.substring(overlap).replace(Regex("^\\s+"), "")
        }
        return next
    }

    /** prev 的最长后缀 = next 的最长前缀（KMP，O(n+m)）。 */
    internal fun maxSuffixPrefix(prev: String, next: String): Int {
        if (prev.isEmpty() || next.isEmpty()) return 0
        val lps = IntArray(next.length)
        var j = 0
        for (i in 1 until next.length) {
            while (j > 0 && next[i] != next[j]) j = lps[j - 1]
            if (next[i] == next[j]) j++
            lps[i] = j
        }
        j = 0
        for (i in prev.indices) {
            while (j > 0 && prev[i] != next[j]) j = lps[j - 1]
            if (prev[i] == next[j]) j++
            if (j == next.length) j = lps[j - 1]
        }
        return j
    }

    private fun mergeImages(base: List<String>?, extra: List<String>?): List<String>? {
        if (extra.isNullOrEmpty()) return base
        return (base ?: emptyList()) + extra
    }
}
