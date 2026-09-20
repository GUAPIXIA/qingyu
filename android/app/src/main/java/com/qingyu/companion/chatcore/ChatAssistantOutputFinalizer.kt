package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-01 第 8 层：统一正文收尾器
 * （对齐 `shared/assistantOutputFinalizer.ts`）。
 *
 * 处理顺序（方案 §5.2）：
 * - `stop` 且结构完整 → 正常接受；
 * - `length` 但正文已在完整句/段结束 → 直接接受，不提示错误；
 * - 尾部残缺 → 回退到最后一个稳定句界/段界，删除悬空半句与未闭合标记；
 * - 稳定正文足够 → `recovered`（轻提示「已在完整句处收束」）；
 * - 稳定正文过短或无稳定边界 → `needs_tail_repair`（由调用方发起一次短补尾）。
 *
 * **绝不把半个标签或半句返回为可保存正文**；输出正则/停止字符串由调用方管线处理，
 * 本模块只负责内容完整性与边界（补尾成功后的复检也走本模块）。
 */
object ChatAssistantOutputFinalizer {

    /** complete | recovered | needs_tail_repair | failed */
    val STATUSES = listOf("complete", "recovered", "needs_tail_repair", "failed")

    /** trimmed_to_boundary | tail_repaired | partial_network_output */
    val NOTICES = listOf("trimmed_to_boundary", "tail_repaired", "partial_network_output")

    data class Diagnostics(
        val completeSentence: Boolean,
        val balancedQuotes: Boolean,
        val balancedMarkup: Boolean,
        val visibleChars: Int,
    )

    data class Finalized(
        val content: String,
        val status: String,
        val notice: String? = null,
        /** needs_tail_repair 时给补尾请求的上下文：最后 1–2 个段落 + 残缺尾句 */
        val repairContext: String? = null,
        /** 稳定边界之后被回退掉的残缺尾段（合并补尾结果时做重叠去重参考） */
        val brokenTail: String? = null,
        val diagnostics: Diagnostics,
    )

    /** 稳定正文可独立保存的最小可见字符数（低于此值进入一次短补尾）。 */
    const val MIN_KEEP_VISIBLE_CHARS = 24

    /** 供应商推理标记 / 空标签清理：保留有效的 `<thought>` 块（心理描写是业务特性）。 */
    private val EMPTY_THOUGHT = Regex("<thought>[$JS_SPACE]*</thought>", RegexOption.IGNORE_CASE)
    private val TOOL_CALL_SENTINEL = Regex("\\[TOOL_CALL:[\\s\\S]*\\]\\s*\\z")

    private const val JS_SPACE = "\\t\\n\\u000B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"

    private fun stripVendorResidue(text: String): String =
        TOOL_CALL_SENTINEL.replace(
            EMPTY_THOUGHT.replace(ChatMessagePostProcess.stripVendorThinking(text), ""),
            "",
        ).trim()

    private val THOUGHT_OPEN = Regex("<thought[$JS_SPACE>]", RegexOption.IGNORE_CASE)
    private val THOUGHT_CLOSE = Regex("</thought>", RegexOption.IGNORE_CASE)

    /** 找到最后一个未闭合 `<thought>` 的开标签位置；无未闭合块时返回 -1。 */
    fun findUnclosedThoughtStart(text: String): Int {
        val opens = THOUGHT_OPEN.findAll(text).toList()
        for (i in opens.indices.reversed()) {
            val openIndex = opens[i].range.first
            val afterOpen = text.substring(openIndex)
            if (!THOUGHT_CLOSE.containsMatchIn(afterOpen)) return openIndex
        }
        return -1
    }

    /** 稳定句尾：句末标点 + 可选的收尾引号/星号/书名号。 */
    private val STABLE_TAIL = Regex("[。！？…][”’」』）)】》*]*[$JS_SPACE]*\\z")

    /** 稳定边界候选：从长到短尝试的切点（段落界与句界）。 */
    fun collectBoundaryCandidates(text: String): List<Int> {
        val candidates = mutableSetOf<Int>()
        // 段落边界：空行之前为界（保留含换行的完整段）
        for (match in Regex("\\n[$JS_SPACE]*\\n").findAll(text)) {
            if (match.range.first > 0) candidates += match.range.first
        }
        // 句界：句末标点（含尾随引号/星号）之后
        for (match in Regex("[。！？…][”’」』）)】》*]*").findAll(text)) {
            val end = match.range.last + 1
            if (end > 0 && end < text.length) candidates += end
        }
        // 文本本身是稳定句尾
        if (STABLE_TAIL.containsMatchIn(text) || ChatTextMetrics.isCompleteSentence(text)) {
            candidates += text.length
        }
        return candidates.sortedDescending()
    }

    /** 组装诊断信息。 */
    fun buildDiagnostics(content: String): Diagnostics {
        val closure = ChatTextMetrics.analyzeTextClosure(content)
        return Diagnostics(
            completeSentence = if (content.trim().isNotEmpty()) ChatTextMetrics.isCompleteSentence(content) else false,
            balancedQuotes = closure.balancedQuotes,
            balancedMarkup = closure.balancedAsterisks && closure.closedThought,
            visibleChars = ChatTextMetrics.countVisibleCharacters(content),
        )
    }

    /** 补尾上下文：最后 1–2 个段落 + 残缺尾句（上限 600 字符）。 */
    fun buildRepairContext(rawText: String): String {
        val paragraphs = Regex("\\n[$JS_SPACE]*\\n").split(rawText).filter { it.trim().isNotEmpty() }
        val tail = paragraphs.takeLast(2).joinToString("\n\n").trim()
        if (tail.length <= 600) return tail
        return tail.substring(tail.length - 600)
    }

    /** 收尾主流程（方案 §5.2 处理顺序 3–9）。 */
    fun finalizeAssistantOutput(
        rawText: String,
        finishReason: String?,
        characterName: String? = null,
        responsePolicyMode: String? = null,
        narrativeMode: String? = null,
    ): Finalized {
        val raw = stripVendorResidue(rawText)

        if (raw.isEmpty()) {
            return Finalized(content = "", status = "failed", diagnostics = buildDiagnostics(""))
        }

        // 未闭合的 <thought>：回退到该块之前（残缺思考块不进入正文）
        var workingText = raw
        val unclosedThought = findUnclosedThoughtStart(workingText)
        if (unclosedThought >= 0) {
            workingText = workingText.substring(0, unclosedThought).trimEnd()
        }
        if (workingText.isEmpty()) {
            return Finalized(
                content = "",
                status = "needs_tail_repair",
                notice = if (finishReason == "network_error") "partial_network_output" else null,
                repairContext = buildRepairContext(raw),
                brokenTail = raw,
                diagnostics = buildDiagnostics(""),
            )
        }

        val fullDiagnostics = buildDiagnostics(workingText)
        val structurallyClean = fullDiagnostics.balancedQuotes && fullDiagnostics.balancedMarkup

        // stop / length 且结构完整、完整句收尾 → 直接接受（length 恰好完整不提示错误）
        if (structurallyClean && fullDiagnostics.completeSentence &&
            (finishReason == "stop" || finishReason == "length" || finishReason == "tool_calls")
        ) {
            return Finalized(content = workingText, status = "complete", diagnostics = fullDiagnostics)
        }
        // 网络中断但恰好完整收束 → 接受并提示
        if (structurallyClean && fullDiagnostics.completeSentence && finishReason == "network_error") {
            return Finalized(
                content = workingText,
                status = "complete",
                notice = "partial_network_output",
                diagnostics = fullDiagnostics,
            )
        }

        // 尾部残缺：从长到短寻找「结构闭合 + 稳定句尾」的切点
        for (cut in collectBoundaryCandidates(workingText)) {
            var candidate = workingText.substring(0, cut).trimEnd()
            if (candidate.isEmpty()) continue
            // 悬空的尾部星号属于未闭合展示标记：删除后重查，
            // 避免句末被句界正则连同尾部星号一起纳入候选导致整段降级为补尾
            val asteriskCount = candidate.count { it == '*' }
            if (asteriskCount % 2 == 1 && candidate.endsWith("*")) {
                candidate = candidate.dropLast(1).trimEnd()
            }
            val diagnostics = buildDiagnostics(candidate)
            if (!(diagnostics.balancedQuotes && diagnostics.balancedMarkup)) continue
            if (!STABLE_TAIL.containsMatchIn(candidate)) continue

            val brokenTail = workingText.substring(cut).trim()
            if (diagnostics.visibleChars < MIN_KEEP_VISIBLE_CHARS) {
                // 稳定正文过短 → 一次短补尾
                return Finalized(
                    content = candidate,
                    status = "needs_tail_repair",
                    notice = if (finishReason == "network_error") "partial_network_output" else null,
                    repairContext = buildRepairContext(raw),
                    brokenTail = brokenTail,
                    diagnostics = diagnostics,
                )
            }
            // 稳定正文足够表达本轮内容 → recovered
            return Finalized(
                content = candidate,
                status = "recovered",
                notice = "trimmed_to_boundary",
                brokenTail = brokenTail,
                diagnostics = diagnostics,
            )
        }

        // 没有任何稳定边界（整段无句末标点）→ 一次短补尾
        return Finalized(
            content = "",
            status = "needs_tail_repair",
            notice = if (finishReason == "network_error") "partial_network_output" else null,
            repairContext = buildRepairContext(raw),
            brokenTail = workingText,
            diagnostics = buildDiagnostics(""),
        )
    }

    /**
     * 补尾结果合并：稳定前缀 + 补尾文本，复用调用方的重叠去重；
     * 合并后复检完整性——仍不完整或变短则回退稳定前缀（补尾失败）。
     */
    fun mergeTailRepair(
        finalized: Finalized,
        repairText: String,
        finishReason: String?,
        trimOverlap: (prev: String, next: String) -> String,
    ): Finalized {
        if (repairText.trim().isEmpty()) {
            return finalized.copy(status = if (finalized.content.isNotEmpty()) "recovered" else "failed")
        }
        val appended = trimOverlap(finalized.content, repairText.trim())
        val merged = (finalized.content + appended).trim()
        val rechecked = finalizeAssistantOutput(merged, finishReason ?: "stop")
        // 合并后必须不短于稳定前缀，否则视为补尾失败（保留稳定前缀）
        if (rechecked.status == "needs_tail_repair" || rechecked.status == "failed" ||
            rechecked.diagnostics.visibleChars < finalized.diagnostics.visibleChars
        ) {
            return finalized.copy(status = if (finalized.content.isNotEmpty()) "recovered" else "failed")
        }
        return rechecked.copy(
            status = if (rechecked.status == "complete") "complete" else "recovered",
            notice = "tail_repaired",
        )
    }
}
