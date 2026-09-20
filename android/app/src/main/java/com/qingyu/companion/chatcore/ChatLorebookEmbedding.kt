package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-05：世界书向量层的条目侧纯函数
 * （对齐 PC `shared/lorebookEmbedding.ts`）。
 *
 * 这一层决定「哪些条目要进向量索引、条目被向量化时到底喂了什么文本、
 * 长文本怎么切片、多片向量怎么合并成一条」——
 * 它是「同一段世界书在 PC 与手机上召回结果是否一致」的直接决定因素。
 *
 * 与 [ChatVector] 一样是纯函数，因此逐字节与 PC 对齐并 fixture 锁定。
 * 尚未覆盖（需要网络与存储，属于接入环节）：嵌入请求、向量索引持久化、
 * 阈值与向量空间兼容性判定。
 */
object ChatLorebookEmbedding {

    /** 条目侧字段（对齐 `LoreEntry` 中会影响资格与向量文档的部分）。 */
    data class Entry(
        val id: String,
        val content: String = "",
        val keywords: List<String> = emptyList(),
        val secondaryKeywords: List<String> = emptyList(),
        val summary: String? = null,
        val title: String? = null,
        val enabled: Boolean = true,
        /** always | conditional | detail */
        val priority: String? = null,
        /** keyword | semantic | both（缺省视为 both） */
        val matchMode: String? = null,
    )

    /** 条目是否应进入向量索引：常驻（always）条目无需语义触发。 */
    fun isSemanticEligible(entry: Entry): Boolean {
        if (!entry.enabled || entry.priority == "always") return false
        val mode = entry.matchMode ?: "both"
        return (mode == "semantic" || mode == "both") && entry.content.trim().isNotEmpty()
    }

    /**
     * 构造用于向量化的检索文档。
     * 标题、别名与摘要提供高精度锚点，正文负责语义覆盖；标签保持稳定，
     * 避免不同字段直接拼接造成含义混淆。
     */
    fun buildEmbeddingDocument(entry: Entry): String {
        val title = entry.title?.trim().orEmpty()
        val keywords = (entry.keywords + entry.secondaryKeywords)
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            // PC 用 `new Set(...)` 去重：保持**首次出现**的顺序
            .distinct()
        val summary = entry.summary?.trim().orEmpty()
        val content = entry.content.trim()
        val parts = listOf(
            if (title.isNotEmpty()) "标题：$title" else "",
            if (keywords.isNotEmpty()) "关键词：${keywords.joinToString("、")}" else "",
            if (summary.isNotEmpty()) "摘要：$summary" else "",
            if (content.isNotEmpty()) "正文：$content" else "",
        )
        return parts.filter { it.isNotEmpty() }.joinToString("\n")
    }

    /**
     * 指纹：仅比较会改变向量文档或语义资格的字段。
     *
     * **这是设备内部的失效判定标识，不是跨端契约**：PC 的指纹是 `JSON.stringify({eligible, document})`
     * 的字面形式，Android 侧不追求与其逐字节相同（向量索引按模型/提供方区分，本身不跨端同步）。
     * 两端共同保证的是**不变量**：当且仅当 (eligible, document) 有变化时指纹才变化。
     */
    fun embeddingFingerprint(entry: Entry): String {
        val eligible = if (isSemanticEligible(entry)) "1" else "0"
        val document = buildEmbeddingDocument(entry)
        return "eligible=$eligible\nlen=${document.length}\n$document"
    }

    /** 找出需要失效/重建向量的条目 id，包含新增与删除（顺序与 PC 一致：先旧后新）。 */
    fun diffEmbeddingIds(previous: List<Entry>, next: List<Entry>): List<String> {
        val nextById = next.associateBy { it.id }
        val previousIds = previous.map { it.id }.toSet()
        val changed = linkedSetOf<String>()
        for (old in previous) {
            val new = nextById[old.id]
            if (new == null || embeddingFingerprint(old) != embeddingFingerprint(new)) {
                changed += old.id
            }
        }
        for (entry in next) if (!previousIds.contains(entry.id)) changed += entry.id
        return changed.toList()
    }

    /**
     * 长条目按字符边界切片并保留少量重叠，避免只索引正文开头。
     * `maxChunks` 是存储/耗时保护线；最后一片始终覆盖文档尾部。
     */
    fun splitEmbeddingDocument(
        text: String,
        maxChars: Int,
        maxChunks: Int = 16,
        overlapRatio: Double = 0.15,
    ): List<String> {
        val clean = text.trim()
        if (clean.isEmpty()) return emptyList()
        val size = maxOf(64, kotlin.math.floor(maxChars.toDouble()).toInt())
        if (clean.length <= size) return listOf(clean)
        val overlap = minOf(size - 1, maxOf(0, kotlin.math.floor(size * overlapRatio).toInt()))
        val step = maxOf(1, size - overlap)
        val chunks = mutableListOf<String>()
        var start = 0
        while (start < clean.length && chunks.size < maxChunks) {
            // 与 JS `slice(start, start + size)` 一致：越界自动截断到末尾
            chunks += clean.substring(start, minOf(start + size, clean.length))
            if (start + size >= clean.length) break
            start += step
        }
        val tail = clean.substring(maxOf(0, clean.length - size))
        if (chunks.last() != tail) {
            if (chunks.size >= maxChunks) {
                chunks[chunks.size - 1] = tail
            } else {
                chunks += tail
            }
        }
        return chunks
    }

    /** 多片向量取质心后重新归一化，维持「一条目一向量」的索引格式。 */
    fun mergeChunkVectors(vectors: List<List<Double>>): List<Double> {
        val usable = vectors.filter { vector -> vector.isNotEmpty() && vector.all { it.isFinite() } }
        if (usable.isEmpty()) return emptyList()
        val dimensions = usable[0].size
        val sameSpace = usable.filter { it.size == dimensions }
        if (sameSpace.isEmpty()) return emptyList()
        val mean = MutableList(dimensions) { 0.0 }
        for (vector in sameSpace) {
            for (index in 0 until dimensions) mean[index] += vector[index]
        }
        for (index in 0 until dimensions) mean[index] /= sameSpace.size
        return ChatVector.l2Normalize(mean)
    }
}
