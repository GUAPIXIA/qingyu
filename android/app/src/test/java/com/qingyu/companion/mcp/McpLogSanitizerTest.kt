package com.qingyu.companion.mcp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 日志脱敏测试（S6-06：敏感结果不写普通日志）。
 */
class McpLogSanitizerTest {

    @Test
    fun `URL 凭据与敏感查询参数被打码`() {
        val redacted = McpLogSanitizer.redactUrl("https://user:secret@example.com/mcp?token=abc&region=cn")
        assertTrue(!redacted.contains("secret@example.com"), "URL userinfo 必须剥离")
        assertTrue(!redacted.contains("abc"), "敏感查询参数值必须打码")
        assertTrue(redacted.contains("region=cn"), "非敏感查询参数应保留")
    }

    @Test
    fun `文本中的 Bearer 与 key value 凭据被打码`() {
        val redacted = McpLogSanitizer.redactText("call failed: Authorization: Bearer XYZ123 api_key=K-999 password: pw1")
        assertTrue(!redacted.contains("XYZ123"), "Bearer 令牌必须打码")
        assertTrue(!redacted.contains("K-999"), "api_key 值必须打码")
        assertTrue(!redacted.contains("pw1"), "password 值必须打码")
    }

    @Test
    fun `结果摘要只含规模不含内容`() {
        val result = McpToolResult(content = listOf(McpContentBlock.Text("机密正文 TOP-SECRET")))
        val summary = McpLogSanitizer.describeResult(result)
        assertTrue(!summary.contains("机密正文"), "结果内容绝不能出现在日志摘要里")
        assertTrue(!summary.contains("TOP-SECRET"), "结果内容绝不能出现在日志摘要里")
        assertTrue(summary.contains("内容不记录"), "摘要必须显式声明内容不记录")
    }

    @Test
    fun `日志事件渲染只含元数据`() {
        val line = McpLogEvent.CallFinished(
            serverName = "远程工具服",
            toolName = "search",
            outcome = McpLogSanitizer.describeResult(McpToolResult(listOf(McpContentBlock.Text("secret-body")))),
            durationMs = 12,
        ).render()
        assertTrue(!line.contains("secret-body"), "调用终局日志不得携带结果内容")
        assertEquals(
            "mcp.call end server=远程工具服 tool=search outcome=成功（块=1 文本=11B，内容不记录） durationMs=12",
            line,
            "日志行必须稳定只含元数据，便于审计红线",
        )
    }
}
