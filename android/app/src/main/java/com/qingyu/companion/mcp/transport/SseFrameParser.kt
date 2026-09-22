package com.qingyu.companion.mcp.transport

/**
 * SSE（text/event-stream）分帧解析器：纯 JVM 状态机，逐块 feed，输出完整事件。
 *
 * 遵循 SSE 解析规则：
 * - 事件由空行分隔；`data:` 多行按 `\n` 合并（去掉每行一个前导空格，整体不追加尾随换行）；
 * - `:` 开头为注释行，忽略；`event:`/`id:`/`retry:` 为字段；其余字段忽略；
 * - 换行兼容 `\n`、`\r\n`、`\r`；分块可落在任意位置（跨块重组）；
 * - 只有累积过 `data:` 的空行分隔块才产出事件；流结束时未终结的残余行丢弃（[finish] 不产出）。
 */
class SseFrameParser {

    data class SseEvent(
        val event: String,
        val data: String,
        val id: String? = null,
        val retry: Long? = null,
    )

    private val lineBuffer = StringBuilder()
    private val dataLines = mutableListOf<String>()
    private var eventName: String? = null
    private var lastEventId: String? = null
    private var retryMs: Long? = null
    private var sawCarriageReturn = false

    /** 喂入一段文本，返回其中完整解析出的事件（可能为空）。 */
    fun feed(chunk: String): List<SseEvent> {
        val events = mutableListOf<SseEvent>()
        for (char in chunk) {
            when {
                char == '\r' -> {
                    handleLine(lineBuffer.toString(), events)
                    lineBuffer.clear()
                    sawCarriageReturn = true
                }
                char == '\n' -> {
                    if (sawCarriageReturn) {
                        sawCarriageReturn = false // \r\n 是同一个换行
                    } else {
                        handleLine(lineBuffer.toString(), events)
                        lineBuffer.clear()
                    }
                }
                else -> {
                    sawCarriageReturn = false
                    lineBuffer.append(char)
                }
            }
        }
        return events
    }

    /** 流结束：未以换行终结的残余行按规范丢弃，仅复位事件累积状态。 */
    fun finish(): List<SseEvent> {
        lineBuffer.clear()
        dataLines.clear()
        eventName = null
        retryMs = null
        sawCarriageReturn = false
        return emptyList()
    }

    private fun handleLine(rawLine: String, events: MutableList<SseEvent>) {
        if (rawLine.isEmpty()) {
            dispatch(events)
            return
        }
        if (rawLine.startsWith(":")) return // 注释行
        val colonIndex = rawLine.indexOf(':')
        val field = if (colonIndex < 0) rawLine else rawLine.substring(0, colonIndex)
        var value = if (colonIndex < 0) "" else rawLine.substring(colonIndex + 1)
        if (value.startsWith(" ")) value = value.substring(1)
        when (field) {
            "event" -> eventName = value
            "data" -> dataLines += value
            "id" -> if (!value.contains('\u0000')) lastEventId = value
            "retry" -> value.toLongOrNull()?.let { retryMs = it }
            else -> Unit // 未知字段忽略
        }
    }

    private fun dispatch(events: MutableList<SseEvent>) {
        if (dataLines.isEmpty()) {
            // 只有 event 名没有 data 的块不派发（规范：data 缓冲为空则丢弃事件）
            eventName = null
            retryMs = null
            return
        }
        events += SseEvent(
            event = eventName ?: "message",
            data = dataLines.joinToString("\n"),
            id = lastEventId,
            retry = retryMs,
        )
        dataLines.clear()
        eventName = null
        retryMs = null
    }
}
