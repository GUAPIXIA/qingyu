package com.qingyu.companion.mcp.client

import com.qingyu.companion.mcp.McpContentBlock
import com.qingyu.companion.mcp.McpLimits
import com.qingyu.companion.mcp.McpProtocolException
import com.qingyu.companion.mcp.McpTool
import com.qingyu.companion.mcp.McpToolResult
import com.qingyu.companion.mcp.McpTransportKind
import com.qingyu.companion.mcp.schema.ToolSchemaNode
import com.qingyu.companion.mcp.schema.ToolSchemaParser
import com.qingyu.companion.mcp.transport.McpTransport
import com.qingyu.companion.mcp.transport.McpTransportListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** 客户端身份（initialize 握手；协议版本与 PC 相同）。 */
data class McpClientInfo(
    val name: String = "轻Tavern",
    val version: String = "android",
)

/**
 * MCP 客户端：与单个远程 MCP server 通信（JSON-RPC over Streamable HTTP / SSE）。
 *
 * 与 PC electron/mcp/client.ts 对齐：
 * - 握手 initialize（protocolVersion 2024-11-05）+ notifications/initialized；
 * - tools/list 加载工具清单与参数 schema；
 * - tools/call 超时 60s、initialize / tools/list 10s（[McpLimits]）；
 * - 断线时所有 pending 调用终局失败。
 *
 * Android 版只走远程传输：stdio 由 [com.qingyu.companion.mcp.transport.McpTransportFactory]
 * 拒绝创建（platformSupport=pc_only），本类没有任何本地进程概念。
 */
class McpClient(
    private val serverId: String,
    private val transport: McpTransport,
    private val scope: CoroutineScope,
    private val clientInfo: McpClientInfo = McpClientInfo(),
) {

    private var tools: List<McpTool> = emptyList()
    private var initialized = false

    /** 工具清单变化回调（notifications/tools/list_changed 触发的刷新完成后调用）。 */
    var onToolsChanged: (() -> Unit)? = null

    /** 连接断开回调。 */
    var onDisconnected: ((String) -> Unit)? = null

    private val transportListener = object : McpTransportListener {
        override fun onServerNotification(method: String, params: JsonElement?) {
            if (method == "notifications/tools/list_changed") {
                scope.launch { runCatching { refreshTools() } }
            }
        }

        override fun onDisconnected(cause: String) {
            initialized = false
            onDisconnected?.invoke(cause)
        }
    }

    /** 建链 + 握手 + 加载工具清单；返回工具清单（与 PC connect 后 getAllTools 语义一致）。 */
    suspend fun connect(): List<McpTool> {
        transport.listener = transportListener
        transport.connect()
        try {
            val initResult = transport.sendRequest(
                method = "initialize",
                params = buildJsonObject {
                    put("protocolVersion", McpLimits.PROTOCOL_VERSION)
                    put("capabilities", buildJsonObject { })
                    put(
                        "clientInfo",
                        buildJsonObject {
                            put("name", clientInfo.name)
                            put("version", clientInfo.version)
                        },
                    )
                },
                timeoutMs = McpLimits.INITIALIZE_TIMEOUT_MS,
            )
            val protocolVersion = ((initResult as? JsonObject)?.get("protocolVersion") as? JsonPrimitive)?.content
                ?: throw McpProtocolException("initialize 响应缺少 protocolVersion")
            if (protocolVersion != McpLimits.PROTOCOL_VERSION) {
                // MCP 允许协商版本；PC 实现只支持 2024-11-05，Android 保持相同能力边界
                throw McpProtocolException("不支持的 MCP 协议版本: $protocolVersion")
            }
            transport.sendNotification("notifications/initialized", buildJsonObject { })
            tools = fetchTools()
            initialized = true
            return tools
        } catch (err: Exception) {
            initialized = false
            runCatching { transport.close() }
            throw err
        }
    }

    fun getTools(): List<McpTool> = tools

    fun isConnected(): Boolean = initialized && transport.isConnected()

    /** 调用工具。超时/断线都是终局失败（S6-06）。 */
    suspend fun callTool(
        toolName: String,
        args: JsonObject,
        timeoutMs: Long = McpLimits.TOOL_CALL_TIMEOUT_MS,
    ): McpToolResult {
        if (!initialized) throw McpProtocolException("MCP server 未连接")
        val result = transport.sendRequest(
            method = "tools/call",
            params = buildJsonObject {
                put("name", toolName)
                put("arguments", args)
            },
            timeoutMs = timeoutMs,
        ) ?: throw McpProtocolException("tools/call 响应缺少 result")
        return parseToolResult(result)
    }

    suspend fun disconnect() {
        initialized = false
        transport.close()
    }

    private suspend fun fetchTools(): List<McpTool> {
        val result = transport.sendRequest("tools/list", buildJsonObject { }, McpLimits.TOOLS_LIST_TIMEOUT_MS)
            ?: throw McpProtocolException("tools/list 响应缺少 result")
        val toolsArray = (result as? JsonObject)?.get("tools") as? JsonArray
            ?: throw McpProtocolException("tools/list 响应缺少 tools 数组")
        return toolsArray.map { element ->
            val obj = element as? JsonObject ?: throw McpProtocolException("工具条目必须是对象")
            val name = (obj["name"] as? JsonPrimitive)?.content
                ?: throw McpProtocolException("工具条目缺少 name")
            val description = (obj["description"] as? JsonPrimitive)?.content ?: ""
            val schemaElement = obj["inputSchema"]
            val schema = when {
                schemaElement == null || schemaElement is JsonNull -> ToolSchemaNode.AnyNode
                else -> ToolSchemaParser.parse(schemaElement)
            }
            McpTool(serverId = serverId, name = name, description = description, inputSchema = schema)
        }
    }

    private suspend fun refreshTools() {
        tools = fetchTools()
        onToolsChanged?.invoke()
    }

    private fun parseToolResult(result: JsonElement): McpToolResult {
        val obj = result as? JsonObject ?: throw McpProtocolException("tools/call result 必须是对象")
        val contentArray = (obj["content"] as? JsonArray) ?: JsonArray(emptyList())
        val blocks = contentArray.map { block ->
            val blockObj = block as? JsonObject ?: McpProtocolException("工具结果块必须是对象").let { throw it }
            when ((blockObj["type"] as? JsonPrimitive)?.content) {
                "text" -> McpContentBlock.Text((blockObj["text"] as? JsonPrimitive)?.content ?: "")
                "image" -> McpContentBlock.Image(
                    data = (blockObj["data"] as? JsonPrimitive)?.content ?: "",
                    mimeType = (blockObj["mimeType"] as? JsonPrimitive)?.content ?: "",
                )
                "resource" -> McpContentBlock.Resource(
                    uri = (blockObj["uri"] as? JsonPrimitive)?.content ?: "",
                    mimeType = (blockObj["mimeType"] as? JsonPrimitive)?.content,
                )
                else -> McpContentBlock.Unknown((blockObj["type"] as? JsonPrimitive)?.content ?: "unknown")
            }
        }
        val isError = (obj["isError"] as? JsonPrimitive)?.booleanOrNull ?: false
        return McpToolResult(content = blocks, isError = isError)
    }
}

/** manager 依赖的客户端面（便于测试替身注入）。 */
interface McpClientApi {
    suspend fun connect(): List<McpTool>
    fun getTools(): List<McpTool>
    suspend fun callTool(toolName: String, args: JsonObject, timeoutMs: Long = McpLimits.TOOL_CALL_TIMEOUT_MS): McpToolResult
    suspend fun disconnect()
    fun isConnected(): Boolean
}

/** [McpClient] 即 [McpClientApi]。 */
fun McpClient.asApi(): McpClientApi = object : McpClientApi {
    override suspend fun connect(): List<McpTool> = this@asApi.connect()
    override fun getTools(): List<McpTool> = this@asApi.getTools()
    override suspend fun callTool(toolName: String, args: JsonObject, timeoutMs: Long): McpToolResult =
        this@asApi.callTool(toolName, args, timeoutMs)
    override suspend fun disconnect() = this@asApi.disconnect()
    override fun isConnected(): Boolean = this@asApi.isConnected()
}

/** 传输种类仅远程（供调用方自检；stdio 连接在工厂层就被拒绝）。 */
fun McpTransportKind.isRemote(): Boolean = this == McpTransportKind.STREAMABLE_HTTP || this == McpTransportKind.SSE
