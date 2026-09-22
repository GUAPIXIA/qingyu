package com.qingyu.companion.mcp

/**
 * MCP 服务器配置校验（与 PC electron/mcp/manager.ts validateServerConfig 语义对齐的可移植子集）：
 * 名称 1..100、transport 合法、远程 url 必须是 http(s)。
 *
 * Android 侧补充：stdio 条目只做可见性展示，command/args/env 仅存本地，
 * 校验**不要求**它们存在（同步来的 stdio 公共配置本来就不含这些敏感字段）。
 */
object McpServerConfigValidator {

    fun validate(config: McpServerConfig) {
        if (config.name.isBlank() || config.name.length > 100) {
            throw McpConfigInvalidException("MCP server 名称无效（1..100 字符）")
        }
        when (config.transport) {
            McpTransportKind.STDIO -> Unit // 仅可见性；不校验 command（PC 专有字段不同步）
            McpTransportKind.STREAMABLE_HTTP, McpTransportKind.SSE -> {
                val url = config.url
                if (url.isNullOrBlank() || !Regex("^https?://").containsMatchIn(url)) {
                    throw McpConfigInvalidException("MCP server URL 必须是 http(s) 链接")
                }
            }
        }
    }
}
