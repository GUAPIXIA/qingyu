package com.qingyu.companion.ui.components

/**
 * 心理描写/思考（thought）块处理。
 *
 * 对齐 PC 端 `src/utils/messagePostProcess.ts` 的 extractThought 规范
 * （方案 §3.3「渲染规则文档化，两端对照同一规范」）：
 * - `<thought>` 只表示当前角色的第一人称内心独白
 * - `<think>` / `<thinking>` 属于供应商推理，提取前直接丢弃
 * - 提取所有 thought 块内容，trim 后以 `\n\n` 拼接
 * - 剥离 thought 块后的剩余为正文；正文为空时回退到 thought 内容（避免空消息）
 * - 无标签时 thought 为 null
 */
data class ThoughtExtraction(
    val thought: String?,
    val content: String,
    val isFallback: Boolean,
)

private val VENDOR_THINKING_BLOCK = Regex(
    """<\s*(?:think|thinking)\b[^>]*>[\s\S]*?(?:<\s*/\s*(?:think|thinking)\s*>|$)""",
    RegexOption.IGNORE_CASE,
)
private val ORPHAN_VENDOR_THINKING_CLOSE = Regex(
    """<\s*/\s*(?:think|thinking)\s*>""",
    RegexOption.IGNORE_CASE,
)
private val THOUGHT_BLOCK = Regex("""<thought>([\s\S]*?)</thought>""", RegexOption.IGNORE_CASE)

/**
 * 历史函数名保留给现有调用方；当前语义是移除供应商推理，而不是转换成角色 thought。
 */
fun normalizeThoughtTags(text: String): String {
    if (text.isEmpty()) return text
    return text
        .replace(VENDOR_THINKING_BLOCK, "")
        .replace(ORPHAN_VENDOR_THINKING_CLOSE, "")
}

/**
 * 提取所有 thought 块。
 * @return [ThoughtExtraction]：thought=拼接的思考内容（无则 null）；content=剥离后的正文
 * （为空时回退到思考内容）；isFallback=是否触发了空回退
 */
fun extractThought(text: String): ThoughtExtraction {
    if (text.isEmpty()) return ThoughtExtraction(thought = null, content = "", isFallback = false)
    val normalized = normalizeThoughtTags(text)
    val thoughts = THOUGHT_BLOCK.findAll(normalized)
        .map { it.groupValues[1].trim() }
        .toList()
    val stripped = normalized.replace(THOUGHT_BLOCK, "").trim()
    val thought = if (thoughts.isNotEmpty()) thoughts.joinToString("\n\n") else null
    // 剥离后为空则回退到思考内容，避免显示「空消息」
    val isFallback = stripped.isEmpty() && thought != null
    val content = stripped.ifEmpty { thought.orEmpty() }
    return ThoughtExtraction(thought = thought, content = content, isFallback = isFallback)
}

/** 剥离 thought 块，返回剩余正文（不做空回退） */
fun stripThought(text: String): String {
    if (text.isEmpty()) return text
    return normalizeThoughtTags(text).replace(THOUGHT_BLOCK, "").trim()
}

/** 去掉 thought 标签本身但保留内容（TTS 朗读内心想法等场景） */
fun stripThoughtTags(text: String): String {
    if (text.isEmpty()) return text
    return normalizeThoughtTags(text).replace(Regex("""</?thought>""", RegexOption.IGNORE_CASE), "").trim()
}
