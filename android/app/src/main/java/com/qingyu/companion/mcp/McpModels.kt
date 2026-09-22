package com.qingyu.companion.mcp

import com.qingyu.companion.mcp.schema.ToolSchemaNode

/**
 * MCP 领域模型（S6-06）。
 *
 * 对齐 PC `shared/types.ts` 的 McpServerConfig / McpTool / McpToolResult / McpServerStatus，
 * 并在 Android 侧补充：
 * - 传输方式显式区分两种远程通道（Streamable HTTP 与 HTTP+SSE），stdio 保留配置可见性但
 *   由 [com.qingyu.companion.mcp.McpPlatformPolicy] 标记 `platformSupport=pc_only`；
 * - 认证头 [headers] / 环境变量 [env] / command / args 只存在于本地配置，
 *   同步投影（[McpPublicConfigProjection]）绝不携带（总方案 §6.1、§3.3 红线）；
 * - 权限模板 [McpPermissionTemplate] 属于可同步的公共字段（阶段 6 §S6-06）。
 */

/** MCP 传输方式。wireName 与 PC `McpServerConfig.transport` 取值兼容（stdio / sse）。 */
enum class McpTransportKind(val wireName: String) {
    /** JSON-RPC over stdio 本地进程：仅 PC（platformSupport=pc_only），Android 绝不启动本地进程。 */
    STDIO("stdio"),

    /** 远程 Streamable HTTP（HTTP POST + 可选 SSE 流式响应）。 */
    STREAMABLE_HTTP("http"),

    /** 远程 HTTP+SSE（GET 事件流 + POST 消息端点），对应 PC 的 `sse`。 */
    SSE("sse");

    companion object {
        /** 解析持久化/同步来的传输字符串；兼容 PC 取值，未知返回 null。 */
        fun fromWire(value: String): McpTransportKind? = when (value.lowercase()) {
            "stdio" -> STDIO
            "http", "streamable_http", "streamable-http", "http_streamable" -> STREAMABLE_HTTP
            "sse" -> SSE
            else -> null
        }
    }
}

/** 工具权限模板规则（同步公共字段的一部分）。 */
enum class McpToolRule {
    /** 允许自动执行——仅在风险分级为 L0 且用户本地显式配置时生效。 */
    AUTO_ALLOW,

    /** 每次调用都必须显式确认；无确认即默认拒绝（与 PC 确认弹窗语义一致）。 */
    ASK,

    /** 无条件拒绝。 */
    DENY;

    companion object {
        fun fromWire(value: String): McpToolRule? = entries.firstOrNull { it.name.equals(value, ignoreCase = true) }
    }
}

/**
 * 权限模板：serverId -> (toolName -> 规则)。未命中的工具走 [defaultRule]（默认 ASK=默认拒绝，
 * 只有用户显式确认才会放行）。模板只能由用户本地配置产生，远端文本（工具名/描述/返回值）
 * 无法写入或修改它——这是「提示注入不得绕过权限」的结构性保证。
 */
data class McpPermissionTemplate(
    val defaultRule: McpToolRule = McpToolRule.ASK,
    val rules: Map<String, Map<String, McpToolRule>> = emptyMap(),
) {
    fun ruleFor(serverId: String, toolName: String): McpToolRule =
        rules[serverId]?.get(toolName) ?: defaultRule

    /** 同步 payload 形状（纯数据，键固定，便于红线测试逐键检查）。 */
    fun toPayload(): Map<String, Any?> = mapOf(
        "defaultRule" to defaultRule.name,
        "rules" to rules.mapValues { (_, perTool) -> perTool.mapValues { (_, rule) -> rule.name } },
    )
}

/**
 * MCP 服务器配置。stdio 条目保留 command/args/env 仅用于本地可见性展示，
 * Android 不会用它们启动任何进程（见 [McpPlatformPolicy] 与 [transport.McpTransportFactory]）。
 */
data class McpServerConfig(
    val id: String,
    val name: String,
    val transport: McpTransportKind,
    val url: String? = null,
    val command: String? = null,
    val args: List<String> = emptyList(),
    val env: Map<String, String> = emptyMap(),
    /** 远程 MCP 的认证头等敏感请求头：本地凭据，绝不同步、绝不进普通日志。 */
    val headers: Map<String, String> = emptyMap(),
    val enabled: Boolean = true,
    val autoStart: Boolean = false,
    val permissionTemplate: McpPermissionTemplate = McpPermissionTemplate(),
)

/** MCP 工具定义（工具清单 + 参数 schema，与 PC `McpTool` 同构）。 */
data class McpTool(
    val serverId: String,
    val name: String,
    val description: String,
    val inputSchema: ToolSchemaNode,
)

/** 工具返回内容块。返回文本永远是数据，不是指令（阶段 6 §3 提示注入红线）。 */
sealed class McpContentBlock {
    data class Text(val text: String) : McpContentBlock()
    data class Image(val data: String, val mimeType: String) : McpContentBlock()
    data class Resource(val uri: String, val mimeType: String?) : McpContentBlock()
    data class Unknown(val type: String) : McpContentBlock()
}

/** MCP 调用结果（与 PC `McpToolResult` 同构）。 */
data class McpToolResult(
    val content: List<McpContentBlock>,
    val isError: Boolean = false,
) {
    /** 与 PC toolLoop 相同的文本抽取：仅 text 块按换行拼接。 */
    fun textContent(): String = content
        .filterIsInstance<McpContentBlock.Text>()
        .joinToString("\n") { it.text }

    /** 结果规模摘要：只用于日志，绝不包含内容本身（敏感结果不写普通日志）。 */
    fun sizeSummary(): String {
        val textBytes = content.filterIsInstance<McpContentBlock.Text>()
            .sumOf { it.text.toByteArray(Charsets.UTF_8).size }
        return "块=${content.size} 文本=${textBytes}B"
    }
}

/** Server 状态信息（与 PC `McpServerStatus` 同构 + 平台标记）。 */
data class McpServerStatus(
    val id: String,
    val connected: Boolean,
    val toolCount: Int,
    val lastError: String? = null,
    val platformSupport: PlatformSupport,
)
