package com.qingyu.companion.mcp

/**
 * 与 PC 相同的超时与协议常量（S6-06「与 PC 相同的超时」）。
 *
 * PC 取值来源：
 * - electron/mcp/client.ts：initialize / tools/list 10s，tools/call 60s，protocolVersion 2024-11-05；
 * - electron/chat/toolGate.ts：waiting_approval 60s 超时默认拒绝；
 * - electron/services/toolLoop.ts：TOOL_CALL_TIMEOUT_MS 60s、MAX_TOOL_ROUNDS 10。
 */
object McpLimits {
    /** initialize 握手超时。 */
    const val INITIALIZE_TIMEOUT_MS = 10_000L

    /** tools/list 超时。 */
    const val TOOLS_LIST_TIMEOUT_MS = 10_000L

    /** 单次 tools/call 超时（终局，不重试）。 */
    const val TOOL_CALL_TIMEOUT_MS = 60_000L

    /** 权限确认超时：超时即默认拒绝（PC toolGate 语义）。 */
    const val APPROVAL_TIMEOUT_MS = 60_000L

    /** 工具调用循环轮数上限（PC toolLoop 语义，供生成任务侧接线时使用）。 */
    const val MAX_TOOL_ROUNDS = 10

    /** MCP 协议版本（与 PC initialize 相同）。 */
    const val PROTOCOL_VERSION = "2024-11-05"
}
