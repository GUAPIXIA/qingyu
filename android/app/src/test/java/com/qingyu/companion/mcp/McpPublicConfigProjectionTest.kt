package com.qingyu.companion.mcp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * `mcp_public_config` 同步投影红线测试（总方案 §6.1 / §3.3、阶段 6 §S6-06）：
 * 同步面只含名称、URL/transport、启用状态、权限模板；**认证头/环境变量绝不上传**。
 */
class McpPublicConfigProjectionTest {

    private val secretEnvValue = "env-secret-value-98765"
    private val secretHeaderValue = "Bearer header-secret-value-54321"
    private val secretArgValue = "arg-secret-value-11223"
    private val secretCommand = "cmd-secret-binary"
    private val secretUrlUser = "url-user-secret"

    private val dirtyConfig = McpServerConfig(
        id = "srv-1",
        name = "远程工具服",
        transport = McpTransportKind.SSE,
        url = "https://$secretUrlUser:password123@example.com/mcp?token=query-secret",
        command = secretCommand,
        args = listOf("--token", secretArgValue),
        env = mapOf("API_KEY" to secretEnvValue),
        headers = mapOf("Authorization" to secretHeaderValue),
        enabled = true,
        autoStart = true,
        permissionTemplate = McpPermissionTemplate(
            defaultRule = McpToolRule.ASK,
            rules = mapOf("srv-1" to mapOf("search" to McpToolRule.AUTO_ALLOW, "danger" to McpToolRule.DENY)),
        ),
    )

    private fun deepKeys(value: Any?): List<String> = when (value) {
        is Map<*, *> -> value.keys.map { it.toString() } + value.values.flatMap { deepKeys(it) }
        is List<*> -> value.flatMap { deepKeys(it) }
        else -> emptyList()
    }

    @Test
    fun `同步 payload 只含白名单五类字段`() {
        val payload = McpPublicConfigProjection.toSyncPayload(dirtyConfig)
        assertEquals(
            McpPublicConfigProjection.ALLOWED_KEYS,
            payload.keys,
            "mcp_public_config 只允许名称/URL/transport/启用状态/权限模板，多一个键都算泄密面扩大",
        )
    }

    @Test
    fun `红线-认证头与环境变量绝不进入同步面`() {
        val payload = McpPublicConfigProjection.toSyncPayload(dirtyConfig)
        val rendered = payload.toString()

        for (secret in listOf(secretEnvValue, secretHeaderValue, secretArgValue, secretCommand, secretUrlUser, "query-secret", "password123")) {
            assertTrue(!rendered.contains(secret), "同步面出现敏感值 $secret：认证头/环境变量/命令/参数/URL 凭据不得上传")
        }
        val keys = deepKeys(payload)
        for (forbidden in McpPublicConfigProjection.FORBIDDEN_KEYS) {
            assertTrue(keys.none { it.equals(forbidden, ignoreCase = true) }, "同步面出现禁用键 $forbidden：认证头/环境变量等不得上传")
        }
    }

    @Test
    fun `URL 的 userinfo 与敏感查询参数被剥离`() {
        val public = McpPublicConfigProjection.project(dirtyConfig)
        assertEquals("https://example.com/mcp?token=***", public.url, "URL 必须剥离 user:pass@ 凭据并把敏感查询参数值打码")
    }

    @Test
    fun `stdio 条目投影不含 url 且保留可见性字段`() {
        val stdioConfig = McpServerConfig(
            id = "srv-stdio",
            name = "本地文件工具",
            transport = McpTransportKind.STDIO,
            command = secretCommand,
            args = listOf(secretArgValue),
            env = mapOf("TOKEN" to secretEnvValue),
            enabled = false,
        )
        val public = McpPublicConfigProjection.project(stdioConfig)
        assertEquals(null, public.url, "stdio 条目没有远程 URL，不得把命令当 URL 上传")
        assertEquals("stdio", public.transport, "transport 必须如实同步，目标端才能标记 pc_only")
        assertEquals(false, public.enabled, "启用状态必须保留")
        val rendered = McpPublicConfigProjection.toSyncPayload(stdioConfig).toString()
        assertTrue(!rendered.contains(secretCommand), "stdio 的命令不得上传")
        assertTrue(!rendered.contains(secretArgValue), "stdio 的参数不得上传")
        assertTrue(!rendered.contains(secretEnvValue), "stdio 的环境变量不得上传")
    }

    @Test
    fun `权限模板完整随同步面下发`() {
        val payload = McpPublicConfigProjection.toSyncPayload(dirtyConfig)
        val template = payload["permissionTemplate"] as Map<*, *>
        assertEquals("ASK", template["defaultRule"], "权限模板默认规则必须随同步面下发")
        val rules = template["rules"] as Map<*, *>
        val serverRules = rules["srv-1"] as Map<*, *>
        assertEquals("AUTO_ALLOW", serverRules["search"], "逐工具权限规则必须随同步面下发")
        assertEquals("DENY", serverRules["danger"], "逐工具权限规则必须随同步面下发")
    }

    @Test
    fun `名称 transport 启用状态如实投影`() {
        val public = McpPublicConfigProjection.project(dirtyConfig)
        assertEquals("远程工具服", public.name, "名称必须保留，否则目标端无法显示同一配置")
        assertEquals("sse", public.transport, "transport 必须保留，否则目标端不知道用哪种远程通道")
        assertEquals(true, public.enabled, "启用状态必须保留")
    }

    @Test
    fun `白名单本身不含任何敏感键`() {
        for (key in McpPublicConfigProjection.ALLOWED_KEYS) {
            assertTrue(
                key !in McpPublicConfigProjection.FORBIDDEN_KEYS,
                "白名单混入敏感键 $key 会让红线检查形同虚设",
            )
        }
        assertEquals(
            setOf("name", "url", "transport", "enabled", "permissionTemplate"),
            McpPublicConfigProjection.ALLOWED_KEYS,
            "白名单必须精确等于 S6-06 允许的五类字段",
        )
    }
}
