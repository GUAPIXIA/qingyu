package com.qingyu.companion.mcp

/**
 * MCP 日志面（S6-06：敏感结果不写普通日志）。
 *
 * 规则：
 * - 工具返回内容（文本/图片/资源）**绝不**进入日志，只记录规模摘要 [McpToolResult.sizeSummary]；
 * - 错误文本可能夹带工具返回内容或凭据，写日志前必须过 [McpLogSanitizer.redactText]；
 * - URL 只记录去除 userinfo 的形式（与 PC backup 脱敏一致）。
 */

interface McpLogger {
    fun log(event: McpLogEvent)
}

/** 空日志器（默认值；不是业务空实现，是标准 Null Object）。 */
object NoopMcpLogger : McpLogger {
    override fun log(event: McpLogEvent) = Unit
}

sealed class McpLogEvent {
    abstract fun render(): String

    /** 调用开始：只含服务名/工具名。 */
    data class CallStarted(val serverName: String, val toolName: String) : McpLogEvent() {
        override fun render(): String = "mcp.call start server=$serverName tool=$toolName"
    }

    /** 调用终局：只含结果类别与规模摘要，不含内容。 */
    data class CallFinished(
        val serverName: String,
        val toolName: String,
        val outcome: String,
        val durationMs: Long,
    ) : McpLogEvent() {
        override fun render(): String =
            "mcp.call end server=$serverName tool=$toolName outcome=$outcome durationMs=$durationMs"
    }

    /** 权限判定：只含风险级与决定。 */
    data class PermissionDecided(
        val serverName: String,
        val toolName: String,
        val risk: String,
        val decision: String,
    ) : McpLogEvent() {
        override fun render(): String =
            "mcp.permission server=$serverName tool=$toolName risk=$risk decision=$decision"
    }

    /** 传输错误：message 必须已经过 [McpLogSanitizer.redactText]。 */
    data class TransportError(val serverName: String, val kind: String, val message: String) : McpLogEvent() {
        override fun render(): String = "mcp.transport error server=$serverName kind=$kind message=$message"
    }
}

object McpLogSanitizer {

    private val URL_USERINFO = Regex("""(https?://)([^/@\s]+)@""")
    private val SENSITIVE_QUERY = Regex(
        """(?i)([?&](?:token|key|secret|password|passwd|api[-_]?key|access[-_]?token|auth|signature|sig)=)[^&\s]*""",
    )
    private val BEARER = Regex("""(?i)bearer\s+\S+""")
    private val SENSITIVE_KV = Regex(
        """(?i)(authorization|api[-_]?key|apikey|token|secret|password|passwd|cookie|env)\s*[:=]\s*"?[^\s",;}]+""",
    )

    /**
     * URL 脱敏（同步投影与日志共用）：
     * 剥离 userinfo（user:secret@host），并把敏感查询参数（token/key/secret/...）的值打码，
     * 保留主机、路径与非敏感查询参数。
     */
    fun redactUrl(url: String): String {
        val noUserinfo = URL_USERINFO.replace(url.trim()) { match -> match.groupValues[1] }
        return SENSITIVE_QUERY.replace(noUserinfo) { match -> match.groupValues[1] + "***" }
    }

    /** 文本脱敏：Bearer 令牌、URL 凭据与 key=value 形式的凭据打码（先处理 Bearer，防止令牌值残留）。 */
    fun redactText(text: String): String {
        val noBearer = BEARER.replace(text, "Bearer ***")
        val noUrlCredentials = URL_USERINFO.replace(noBearer) { match -> match.groupValues[1] }
        val noQuerySecrets = SENSITIVE_QUERY.replace(noUrlCredentials) { match -> match.groupValues[1] + "***" }
        return SENSITIVE_KV.replace(noQuerySecrets) { match -> "${match.groupValues[1]}=***" }
    }

    /** 结果摘要：规模信息可进日志，内容不可。 */
    fun describeResult(result: McpToolResult): String =
        if (result.isError) "错误结果（${result.sizeSummary()}，内容不记录）" else "成功（${result.sizeSummary()}，内容不记录）"
}
