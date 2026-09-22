package com.qingyu.companion.mcp.schema

import com.qingyu.companion.mcp.McpProtocolException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject

/**
 * 工具参数 schema（与 PC `McpTool.inputSchema` 同构的 JSON Schema 子集）：
 * type=object + properties + required；属性支持 string/number/integer/boolean/array/object 与 enum。
 *
 * 校验目标（阶段 6 §S6-06 / §3 第 5 条）：**参数不合法必须在发出网络请求前被拒绝**，
 * 越权参数（未知参数、enum 越界）同样拒绝。这是纯 JVM 逻辑，可直接单测。
 */
sealed class ToolSchemaNode {
    /** object 节点。[additionalProperties]=false 时为封闭对象：未知参数一律拒绝。 */
    data class ObjectNode(
        val properties: Map<String, ToolSchemaNode> = emptyMap(),
        val required: List<String> = emptyList(),
        val additionalProperties: Boolean = false,
    ) : ToolSchemaNode()

    data class StringNode(val enum: List<String>? = null) : ToolSchemaNode()
    data class NumberNode(val integer: Boolean = false, val enum: List<String>? = null) : ToolSchemaNode()
    data object BooleanNode : ToolSchemaNode()
    data class ArrayNode(val items: ToolSchemaNode?) : ToolSchemaNode()
    /** 未声明 type 的宽松节点：不校验（与 PC 透传行为一致）。 */
    data object AnyNode : ToolSchemaNode()
}

/** 从 JSON 解析工具参数 schema。结构非法（properties 非对象等）抛 [McpProtocolException]。 */
object ToolSchemaParser {

    fun parse(element: JsonElement): ToolSchemaNode {
        if (element !is JsonObject) throw McpProtocolException("工具 inputSchema 必须是对象")
        return parseObject(element)
    }

    private fun parseObject(obj: JsonObject): ToolSchemaNode {
        val type = (obj["type"] as? JsonPrimitive)?.content ?: return ToolSchemaNode.AnyNode
        return when (type.lowercase()) {
            "object" -> {
                val propsElement = obj["properties"]
                val properties = when {
                    propsElement == null || propsElement is JsonNull -> emptyMap()
                    propsElement is JsonObject -> propsElement.entries.associate { (key, value) -> key to parse(value) }
                    else -> throw McpProtocolException("工具 inputSchema.properties 必须是对象")
                }
                val required = when (val requiredElement = obj["required"]) {
                    null, is JsonNull -> emptyList()
                    is JsonArray -> requiredElement.map {
                        (it as? JsonPrimitive)?.content ?: throw McpProtocolException("工具 inputSchema.required 必须是字符串数组")
                    }
                    else -> throw McpProtocolException("工具 inputSchema.required 必须是字符串数组")
                }
                val additional = (obj["additionalProperties"] as? JsonPrimitive)?.booleanOrNull ?: false
                ToolSchemaNode.ObjectNode(properties, required, additional)
            }
            "string" -> ToolSchemaNode.StringNode(parseEnum(obj))
            "number" -> ToolSchemaNode.NumberNode(integer = false, enum = parseEnum(obj))
            "integer" -> ToolSchemaNode.NumberNode(integer = true, enum = parseEnum(obj))
            "boolean" -> ToolSchemaNode.BooleanNode
            "array" -> ToolSchemaNode.ArrayNode(obj["items"]?.let { if (it is JsonNull) null else parse(it) })
            else -> ToolSchemaNode.AnyNode
        }
    }

    private fun parseEnum(obj: JsonObject): List<String>? {
        val enumElement = obj["enum"] ?: return null
        if (enumElement !is JsonArray) throw McpProtocolException("工具 inputSchema.enum 必须是数组")
        return enumElement.map { (it as? JsonPrimitive)?.content ?: throw McpProtocolException("工具 inputSchema.enum 必须是标量数组") }
    }
}

/**
 * 参数校验器：返回违规描述列表（空 = 合法）。
 * 任何违规都意味着**拒绝调用**（INVALID_ARGUMENTS），不会被修正或静默裁剪。
 */
object ToolSchemaValidator {

    fun validate(schema: ToolSchemaNode, args: JsonObject): List<String> =
        validateAt(schema, args, path = "")

    private fun validateAt(schema: ToolSchemaNode, value: JsonElement, path: String): List<String> {
        val label = if (path.isEmpty()) "参数" else "参数 $path"
        return when (schema) {
            is ToolSchemaNode.ObjectNode -> {
                if (value !is JsonObject) return listOf("$label 必须是对象")
                val violations = mutableListOf<String>()
                for (key in schema.required) {
                    if (!value.containsKey(key)) violations += "$label 缺少必填参数: $key"
                }
                for ((key, child) in value) {
                    val childSchema = schema.properties[key]
                    if (childSchema == null) {
                        if (!schema.additionalProperties) violations += "$label 含未声明参数: $key"
                        continue
                    }
                    violations += validateAt(childSchema, child, if (path.isEmpty()) key else "$path.$key")
                }
                violations
            }
            is ToolSchemaNode.StringNode -> {
                if (value is JsonNull) return listOf("$label 必须是字符串")
                val primitive = value as? JsonPrimitive ?: return listOf("$label 必须是字符串")
                if (!primitive.isString) return listOf("$label 必须是字符串")
                val text = primitive.content
                val violations = mutableListOf<String>()
                schema.enum?.let { allowed ->
                    if (text !in allowed) violations += "$label 取值越界: \"$text\" 不在允许列表"
                }
                violations
            }
            is ToolSchemaNode.NumberNode -> {
                if (value is JsonNull) return listOf("$label 必须是数值")
                val primitive = value as? JsonPrimitive ?: return listOf("$label 必须是数值")
                val violations = mutableListOf<String>()
                val asDouble = primitive.doubleOrNull
                    ?: return listOf(if (schema.integer) "$label 必须是整数" else "$label 必须是数值")
                if (schema.integer && asDouble % 1.0 != 0.0) {
                    violations += "$label 必须是整数"
                }
                schema.enum?.let { allowed ->
                    if (primitive.content !in allowed) violations += "$label 取值越界: \"${primitive.content}\" 不在允许列表"
                }
                violations
            }
            is ToolSchemaNode.BooleanNode -> {
                if (value is JsonNull) return listOf("$label 必须是布尔值")
                val primitive = value as? JsonPrimitive ?: return listOf("$label 必须是布尔值")
                if (primitive.booleanOrNull == null) listOf("$label 必须是布尔值") else emptyList()
            }
            is ToolSchemaNode.ArrayNode -> {
                if (value !is JsonArray) return listOf("$label 必须是数组")
                val items = schema.items ?: return emptyList()
                return value.flatMapIndexed { index, item ->
                    validateAt(items, item, if (path.isEmpty()) "[$index]" else "$path[$index]")
                }
            }
            ToolSchemaNode.AnyNode -> emptyList()
        }
    }
}
