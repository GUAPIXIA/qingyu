package com.qingyu.companion.mcp

/**
 * `mcp_public_config` 同步投影（总方案 §6.1、阶段 6 §S6-06 红线）。
 *
 * 同步面**只含**：名称、URL/transport、启用状态、权限模板。
 * **认证头 / 环境变量 / command / args 一律不上传**——投影是纯函数、白名单构造，
 * 未知字段不可能出现在输出里（`McpPublicConfigProjectionTest` 逐键+逐值守卫）。
 * URL 里的 userinfo（user:secret@）与查询凭据同样剥离（与 PC backup 脱敏一致）。
 */
data class McpPublicConfig(
    val name: String,
    /** 远程地址（stdio 条目为 null）；已剥离 userinfo。 */
    val url: String?,
    val transport: String,
    val enabled: Boolean,
    val permissionTemplate: McpPermissionTemplate,
)

object McpPublicConfigProjection {

    /** 同步 payload 允许的顶层键（白名单，红线测试逐项核对）。 */
    val ALLOWED_KEYS: Set<String> = setOf("name", "url", "transport", "enabled", "permissionTemplate")

    /** 永不允许出现在同步面的键（红线）。 */
    val FORBIDDEN_KEYS: Set<String> = setOf(
        "env", "environment", "headers", "header", "command", "args", "arguments",
        "authorization", "auth", "token", "secret", "password", "apiKey", "api_key", "credential",
    )

    /** 本地配置 → 同步实体（纯函数）。 */
    fun project(config: McpServerConfig): McpPublicConfig = McpPublicConfig(
        name = config.name,
        url = config.url
            ?.takeIf { config.transport != McpTransportKind.STDIO }
            ?.let { McpLogSanitizer.redactUrl(it) },
        transport = config.transport.wireName,
        enabled = config.enabled,
        permissionTemplate = config.permissionTemplate,
    )

    /** 同步 payload 形状（键固定；permissionTemplate 为两层 Map<String,String>）。 */
    fun toSyncPayload(config: McpServerConfig): Map<String, Any?> = toPayload(project(config))

    fun toPayload(public: McpPublicConfig): Map<String, Any?> = mapOf(
        "name" to public.name,
        "url" to public.url,
        "transport" to public.transport,
        "enabled" to public.enabled,
        "permissionTemplate" to public.permissionTemplate.toPayload(),
    )
}
