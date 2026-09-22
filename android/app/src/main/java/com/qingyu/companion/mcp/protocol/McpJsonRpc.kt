package com.qingyu.companion.mcp.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * JSON-RPC 2.0 消息编解码（MCP 线协议，纯 JVM）。
 * 与 PC electron/mcp/client.ts 的消息形状一致：`{jsonrpc, id, method, params}` / `{jsonrpc, id, result|error}`。
 */

sealed class McpMessage {
    /** 响应（id + result / error）。 */
    data class Response(
        val id: String,
        val result: JsonElement?,
        val errorCode: Long?,
        val errorMessage: String?,
    ) : McpMessage()

    /** 服务端通知（如 notifications/tools/list_changed）。 */
    data class Notification(val method: String, val params: JsonElement?) : McpMessage()

    /**
     * 服务端发起的请求（sampling / roots 等）。Android 不声明任何能力，
     * 统一以 method not found 回绝——服务端请求绝不可能在 Android 上触发工具执行。
     */
    data class ServerRequest(val id: String, val method: String, val params: JsonElement?) : McpMessage()

    /** 非法消息：按 PC 行为忽略（client.ts「忽略非 JSON」），但绝不影响权限判定。 */
    data class Malformed(val reason: String) : McpMessage()
}

object McpJsonRpc {

    private val json = Json { ignoreUnknownKeys = true }

    fun request(id: String, method: String, params: JsonElement?): String = buildJsonObject {
        put("jsonrpc", "2.0")
        put("id", id)
        put("method", method)
        put("params", params ?: JsonNull)
    }.toString()

    fun notification(method: String, params: JsonElement?): String = buildJsonObject {
        put("jsonrpc", "2.0")
        put("method", method)
        put("params", params ?: JsonNull)
    }.toString()

    /** 对服务端请求的回绝（error -32601 method not found）。 */
    fun methodNotFound(id: String): String = buildJsonObject {
        put("jsonrpc", "2.0")
        put("id", id)
        put(
            "error",
            buildJsonObject {
                put("code", -32601)
                put("message", "method not found")
            },
        )
    }.toString()

    fun parse(text: String): McpMessage {
        val element = runCatching { json.parseToJsonElement(text) }.getOrElse {
            return McpMessage.Malformed("非法 JSON")
        }
        if (element !is JsonObject) return McpMessage.Malformed("消息必须是对象")
        val id = (element["id"] as? JsonPrimitive)?.content
        val method = (element["method"] as? JsonPrimitive)?.content
        val params = element["params"]?.takeIf { it !is JsonNull }
        return when {
            method != null && id != null -> McpMessage.ServerRequest(id, method, params)
            method != null -> McpMessage.Notification(method, params)
            id != null -> {
                val error = element["error"] as? JsonObject
                McpMessage.Response(
                    id = id,
                    result = element["result"]?.takeIf { it !is JsonNull },
                    errorCode = (error?.get("code") as? JsonPrimitive)?.content?.toLongOrNull(),
                    errorMessage = (error?.get("message") as? JsonPrimitive)?.content,
                )
            }
            else -> McpMessage.Malformed("消息缺少 id 与 method")
        }
    }
}
