package com.qingyu.companion.mcp

import com.qingyu.companion.mcp.client.McpClientApi
import kotlinx.serialization.json.JsonObject

/**
 * MCP 服务器管理（parity matrix `mcp.serverManage` / `mcp.remoteHttp` / `mcp.toolCall`）。
 *
 * - 配置增删改查 + 状态；stdio 条目**保留可见性**（platformSupport=pc_only），
 *   但 [startServer] / [startEnabled] 永远不会为它建立连接（架构禁令，抛 [McpStdioForbiddenException]）；
 * - 远程 Streamable HTTP / SSE 服务器通过 [clientFactory]（生产接 [com.qingyu.companion.mcp.client.McpClient]
 *   + [com.qingyu.companion.mcp.transport.McpTransportFactory]，测试用替身）连接；
 * - 工具清单来自已连接服务器；工具调用经 [McpToolHost] 暴露给 [McpToolExecutor]。
 *
 * 配置持久化通过 [McpConfigRepository] 接口接线（Room/DataStore 由主代理接入）。
 */
interface McpConfigRepository {
    fun load(): List<McpServerConfig>
    fun save(configs: List<McpServerConfig>)
}

/** 配置条目的可见性视图（UI 直接消费；stdio 标记 pc_only 并给出说明）。 */
data class McpServerView(
    val id: String,
    val name: String,
    val transport: McpTransportKind,
    val platformSupport: PlatformSupport,
    val connectableOnAndroid: Boolean,
    val enabled: Boolean,
    val autoStart: Boolean,
    /** 已脱敏 URL（stdio 为 null）。 */
    val url: String?,
    val note: String?,
)

/** 内存配置仓库（默认值/测试与无持久化场景的 Null Object，不是业务空实现）。 */
class InMemoryMcpConfigRepository(initial: List<McpServerConfig> = emptyList()) : McpConfigRepository {
    private var configs: List<McpServerConfig> = initial
    override fun load(): List<McpServerConfig> = configs
    override fun save(configs: List<McpServerConfig>) {
        this.configs = configs.toList()
    }
}

class McpServerManager(
    private val repository: McpConfigRepository,
    private val clientFactory: (McpServerConfig) -> McpClientApi,
    private val logger: McpLogger = NoopMcpLogger,
) : McpToolHost {

    private val clients = mutableMapOf<String, McpClientApi>()

    // ---------- 配置管理 ----------

    fun listServers(): List<McpServerConfig> = repository.load()

    fun listServerViews(): List<McpServerView> = listServers().map { it.toView() }

    fun listServerStatuses(): List<McpServerStatus> = listServers().map { config ->
        val client = clients[config.id]
        McpServerStatus(
            id = config.id,
            connected = client?.isConnected() == true,
            toolCount = client?.getTools()?.size ?: 0,
            lastError = null,
            platformSupport = McpPlatformPolicy.platformSupport(config.transport),
        )
    }

    fun addServer(config: McpServerConfig) {
        McpServerConfigValidator.validate(config)
        require(listServers().none { it.id == config.id }) { "MCP server id 已存在: ${config.id}" }
        repository.save(listServers() + config)
    }

    fun updateServer(id: String, transform: (McpServerConfig) -> McpServerConfig) {
        val configs = listServers()
        val index = configs.indexOfFirst { it.id == id }
        if (index < 0) return
        val updated = transform(configs[index])
        McpServerConfigValidator.validate(updated)
        repository.save(configs.toMutableList().also { it[index] = updated.copy(id = id) })
    }

    suspend fun removeServer(id: String) {
        stopServer(id)
        repository.save(listServers().filterNot { it.id == id })
    }

    // ---------- 连接管理 ----------

    /**
     * 启动/连接一个服务器。启动前重新校验配置（对齐 PC「每条启动路径都重新验证」）；
     * stdio 一律抛 [McpStdioForbiddenException]（Android 不启动本地进程）。
     */
    suspend fun startServer(id: String): McpClientApi {
        val config = listServers().firstOrNull { it.id == id }
            ?: throw McpConfigInvalidException("未找到 server: $id")
        McpServerConfigValidator.validate(config)
        if (!McpPlatformPolicy.canConnectOnAndroid(config.transport)) {
            logger.log(McpLogEvent.TransportError(config.name, "STDIO_FORBIDDEN", McpStdioForbiddenException.STDIO_MESSAGE))
            throw McpStdioForbiddenException()
        }
        clients[id]?.let { existing ->
            if (existing.isConnected()) return existing
            runCatching { existing.disconnect() }
        }
        val client = clientFactory(config)
        client.connect()
        clients[id] = client
        return client
    }

    suspend fun stopServer(id: String) {
        val client = clients.remove(id) ?: return
        runCatching { client.disconnect() }
    }

    /** 启动所有「启用 + autoStart」的服务器；stdio 条目直接跳过（不触碰、不报错）。 */
    suspend fun startEnabled() {
        for (config in listServers()) {
            if (!config.enabled || !config.autoStart) continue
            if (!McpPlatformPolicy.canConnectOnAndroid(config.transport)) continue
            runCatching { startServer(config.id) }
                .onFailure { logger.log(McpLogEvent.TransportError(config.name, "AUTOSTART", McpLogSanitizer.redactText(it.message ?: ""))) }
        }
    }

    suspend fun shutdownAll() {
        val ids = clients.keys.toList()
        for (id in ids) stopServer(id)
    }

    // ---------- 工具清单与调用（McpToolHost） ----------

    override fun serverConfig(serverId: String): McpServerConfig? =
        listServers().firstOrNull { it.id == serverId }

    override fun findTool(serverId: String, toolName: String): McpTool? =
        clients[serverId]?.getTools()?.firstOrNull { it.name == toolName }

    /** 所有已连接服务器的工具清单（与 PC mcpManager.getAllTools 一致）。 */
    fun listTools(): List<McpTool> = clients.values.flatMap { it.getTools() }

    override suspend fun callTool(
        serverId: String,
        toolName: String,
        args: JsonObject,
        timeoutMs: Long,
    ): McpToolResult {
        val client = clients[serverId]
            ?: throw McpDisconnectedException("Server $serverId 未连接")
        return client.callTool(toolName, args, timeoutMs)
    }

    private fun McpServerConfig.toView(): McpServerView = McpServerView(
        id = id,
        name = name,
        transport = transport,
        platformSupport = McpPlatformPolicy.platformSupport(transport),
        connectableOnAndroid = McpPlatformPolicy.canConnectOnAndroid(transport),
        enabled = enabled,
        autoStart = autoStart,
        url = url?.let { McpLogSanitizer.redactUrl(it) },
        note = McpPlatformPolicy.visibilityNote(transport),
    )
}
