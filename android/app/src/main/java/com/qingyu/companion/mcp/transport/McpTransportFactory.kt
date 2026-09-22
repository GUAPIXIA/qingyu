package com.qingyu.companion.mcp.transport

import com.qingyu.companion.mcp.McpServerConfig
import com.qingyu.companion.mcp.McpStdioForbiddenException
import com.qingyu.companion.mcp.McpTransportKind
import kotlinx.coroutines.CoroutineScope

/**
 * 传输工厂：按配置创建远程传输。
 *
 * **架构禁令（总方案 §3.2 / parity matrix `mcp.stdioOnly` = pc_only_confirmed）**：
 * stdio 配置在 Android 上只保留可见性（platformSupport=pc_only），
 * 任何创建/连接尝试都以 [McpStdioForbiddenException] 终局——本工厂、本包
 * 不存在任何本地进程启动路径（`StdioNoProcessPathTest` 源码守卫）。
 */
object McpTransportFactory {

    fun create(
        config: McpServerConfig,
        engine: McpHttpEngine,
        scope: CoroutineScope,
    ): McpTransport = when (config.transport) {
        McpTransportKind.STDIO -> throw McpStdioForbiddenException()
        McpTransportKind.STREAMABLE_HTTP -> StreamableHttpTransport(config, engine, scope)
        McpTransportKind.SSE -> HttpSseTransport(config, engine, scope)
    }
}
