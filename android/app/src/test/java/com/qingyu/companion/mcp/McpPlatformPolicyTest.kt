package com.qingyu.companion.mcp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 平台策略测试（S6-06 / parity matrix `mcp.stdioOnly` = pc_only_confirmed）：
 * stdio 配置保留可见性但标 platformSupport=pc_only，Android 不可连接。
 */
class McpPlatformPolicyTest {

    @Test
    fun `stdio 标记 pc_only 且不可在 Android 连接`() {
        assertEquals(
            PlatformSupport.PC_ONLY,
            McpPlatformPolicy.platformSupport(McpTransportKind.STDIO),
            "stdio 必须标记为仅 PC（总方案 §3.2 产品确认）",
        )
        assertEquals("pc_only", McpPlatformPolicy.platformSupport(McpTransportKind.STDIO).marker, "标记文案必须是 pc_only")
        assertFalse(
            McpPlatformPolicy.canConnectOnAndroid(McpTransportKind.STDIO),
            "Android 绝不允许连接 stdio（不启动本地进程）",
        )
    }

    @Test
    fun `远程传输标记 same 且可连接`() {
        for (kind in listOf(McpTransportKind.STREAMABLE_HTTP, McpTransportKind.SSE)) {
            assertEquals(PlatformSupport.SAME, McpPlatformPolicy.platformSupport(kind), "$kind 必须是平台等价（same）")
            assertEquals("same", McpPlatformPolicy.platformSupport(kind).marker, "$kind 的标记文案必须是 same")
            assertTrue(McpPlatformPolicy.canConnectOnAndroid(kind), "$kind 是远程 MCP，Android 必须可连接")
        }
    }

    @Test
    fun `stdio 配置保留可见性且给出明确说明`() {
        assertTrue(McpPlatformPolicy.isConfigVisible(McpTransportKind.STDIO), "stdio 配置必须保留可见性，不得隐藏或回写删除")
        val note = McpPlatformPolicy.visibilityNote(McpTransportKind.STDIO)
        assertTrue(note != null && note.contains("pc_only"), "stdio 条目必须给用户明确的仅 PC 说明")
        assertEquals(null, McpPlatformPolicy.visibilityNote(McpTransportKind.SSE), "远程条目不需要平台说明")
    }

    @Test
    fun `wireName 与 PC 配置取值兼容`() {
        assertEquals("stdio", McpTransportKind.STDIO.wireName, "wireName 必须与 PC transport 取值兼容")
        assertEquals("sse", McpTransportKind.SSE.wireName, "wireName 必须与 PC transport 取值兼容")
        assertEquals(McpTransportKind.STDIO, McpTransportKind.fromWire("stdio"), "PC 持久化值必须可解析")
        assertEquals(McpTransportKind.SSE, McpTransportKind.fromWire("sse"), "PC 持久化值必须可解析")
        assertEquals(McpTransportKind.STREAMABLE_HTTP, McpTransportKind.fromWire("http"), "Streamable HTTP 新取值必须可解析")
    }
}
