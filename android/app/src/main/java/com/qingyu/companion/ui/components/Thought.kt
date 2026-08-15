package com.qingyu.companion.ui.components

/**
 * 心理描写/思考（thought）块处理。
 *
 * 对齐 PC 端 `src/utils/messagePostProcess.ts` 的 extractThought 规范
 * （方案 §3.3「渲染规则文档化，两端对照同一规范」）：
 * - 支持 `<thought>` 与 `<thinking>` 两种标签（大小写不敏感，`<thinking>` 先归一化为 `<thought>`）
 * - 提取所有 thought 块内容，trim 后以 `\n\n` 拼接
 * - 剥离 thought 块后的剩余为正文；正文为空时回退到 thought 内容（避免空消息）
 * - 无标签时 thought 为 null
 */
data class ThoughtExtraction(
    val thought: String?,
    val content: String,
    val isFallback: Boolean,
)

private val THINKING_OPEN = Regex("""<thinking([\s>])""", RegexOption.IGNORE_CASE)
private val THINKING_CLOSE = Regex("""</thinking>""", RegexOption.IGNORE_CASE)
private val THOUGHT_BLOCK = Regex("""<thought>([\s\S]*?)</thought>""", RegexOption.IGNORE_CASE)

/** 将 `<thinking>` 标签归一化为 `<thought>`（与 PC 端 normalizeThoughtTags 一致） */
fun normalizeThoughtTags(text: String): String {
    if (text.isEmpty()) return text
    return text
        .replace(THINKING_OPEN, "<thought$1")
        .replace(THINKING_CLOSE, "</thought>")
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
