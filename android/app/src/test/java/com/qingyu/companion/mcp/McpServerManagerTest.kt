package com.qingyu.companion.mcp

import com.qingyu.companion.mcp.schema.ToolSchemaNode
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * MCP 服务器管理测试（parity matrix `mcp.serverManage` / `mcp.toolCall`）：
 * 配置可见性（含 stdio pc_only）、启停、工具清单与调用路由。
 */
class McpServerManagerTest {

    private val stdioConfig = McpServerConfig(
        id = "stdio-1",
        name = "本地文件工具",
        transport = McpTransportKind.STDIO,
        command = "tool.exe",
        args = listOf("--root", "D:/data"),
        env = mapOf("API_KEY" to "secret"),
    )

    private val remoteConfig = McpServerConfig(
        id = "http-1",
        name = "远程工具服",
        transport = McpTransportKind.STREAMABLE_HTTP,
        url = "https://example.com/mcp",
        headers = mapOf("Authorization" to "Bearer local-secret"),
        autoStart = true,
    )

    private fun managerWith(
        created: MutableList<String> = mutableListOf(),
    ): Triple<McpServerManager, MutableList<String>, FakeMcpClient> {
        val client = FakeMcpClient(
            tools = listOf(
                McpTool("http-1", "search", "搜索", ToolSchemaNode.ObjectNode(mapOf("query" to ToolSchemaNode.StringNode()), listOf("query"))),
            ),
        )
        val manager = McpServerManager(
            repository = InMemoryMcpConfigRepository(listOf(stdioConfig, remoteConfig)),
            clientFactory = { config ->
                created += config.id
                client
            },
        )
        return Triple(manager, created, client)
    }

    @Test
    fun `stdio 配置保留可见性且标记 pc_only`() = runTest {
        val (manager, _, _) = managerWith()
        val views = manager.listServerViews()
        assertEquals(2, views.size, "stdio 配置必须与远程配置一起可见，不得被隐藏")
        val stdioView = views.first { it.id == "stdio-1" }
        assertEquals(PlatformSupport.PC_ONLY, stdioView.platformSupport, "stdio 条目必须标记 platformSupport=pc_only")
        assertEquals(false, stdioView.connectableOnAndroid, "stdio 条目在 Android 上必须显示为不可连接")
        assertTrue(stdioView.note!!.contains("pc_only"), "stdio 条目必须给出明确的仅 PC 说明")
    }

    @Test
    fun `stdio 启动被拒绝且不触碰任何连接路径`() = runTest {
        val (manager, created, _) = managerWith()
        assertFailsWith<McpStdioForbiddenException>("启动 stdio 必须被拒绝，Android 不启动本地进程") {
            manager.startServer("stdio-1")
        }
        assertTrue(created.isEmpty(), "stdio 条目绝不能进入客户端创建/连接路径")
    }

    @Test
    fun `startEnabled 跳过 stdio 只连接远程`() = runTest {
        val (manager, created, client) = managerWith()
        manager.startEnabled()
        assertEquals(listOf("http-1"), created, "自动启动只允许连接远程 MCP，stdio 必须原样跳过")
        assertTrue(client.isConnected(), "远程 MCP 应正常连接")
    }

    @Test
    fun `工具清单与调用路由到已连接客户端`() = runTest {
        val (manager, _, client) = managerWith()
        // 清单来自**已连接**客户端：必须先建立连接（与 startEnabled 用例同口径）
        manager.startEnabled()
        val tools = manager.listTools()
        assertEquals(1, tools.size, "工具清单必须来自已连接客户端")
        assertEquals("search", tools[0].name, "工具清单解析错误")

        manager.callTool("http-1", "search", buildJsonObject { put("query", "轻语") }, 60_000)
        assertEquals(1, client.calls.size, "工具调用必须路由到对应客户端")
        assertEquals("search", client.calls[0].first, "调用的工具名错误")
    }

    @Test
    fun `未连接服务器的调用按断线终局`() = runTest {
        val (manager, _, _) = managerWith()
        assertFailsWith<McpDisconnectedException>("未连接服务器的调用必须明确失败，不能静默无响应") {
            manager.callTool("http-1", "search", buildJsonObject { put("query", "x") }, 60_000)
        }
    }

    @Test
    fun `配置增删改与校验`() = runTest {
        val (manager, _, _) = managerWith()
        val added = McpServerConfig(id = "sse-1", name = "SSE 工具服", transport = McpTransportKind.SSE, url = "https://example.com/sse")
        manager.addServer(added)
        assertEquals(3, manager.listServers().size, "新增配置必须保存")

        val invalid = McpServerConfig(id = "bad", name = "坏配置", transport = McpTransportKind.SSE, url = "ftp://example.com")
        assertFailsWith<McpConfigInvalidException>("非 http(s) 的远程 URL 必须被拒绝") {
            manager.addServer(invalid)
        }

        manager.updateServer("sse-1") { it.copy(enabled = false) }
        assertEquals(false, manager.listServers().first { it.id == "sse-1" }.enabled, "更新必须持久化")

        manager.removeServer("stdio-1")
        assertEquals(2, manager.listServers().size, "删除必须持久化")
    }

    @Test
    fun `状态视图带平台标记`() = runTest {
        val (manager, _, _) = managerWith()
        manager.startServer("http-1")
        val statuses = manager.listServerStatuses().associateBy { it.id }
        assertEquals(PlatformSupport.SAME, statuses["http-1"]!!.platformSupport, "远程条目状态必须带 same 标记")
        assertEquals(PlatformSupport.PC_ONLY, statuses["stdio-1"]!!.platformSupport, "stdio 条目状态必须带 pc_only 标记")
        assertEquals(false, statuses["stdio-1"]!!.connected, "stdio 条目永远处于未连接")
        assertEquals(1, statuses["http-1"]!!.toolCount, "状态视图必须报告工具数")
    }
}
