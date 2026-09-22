package com.qingyu.companion.imagegen

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 工作流 JSON 的值桥接（纯 JVM 可测）。
 *
 * ComfyUI 工作流是动态 JSON（节点 inputs 的值是任意 JSON），
 * 这里用 kotlinx.serialization 的 [JsonElement] 做解析（保序 LinkedHashMap 语义），
 * 再与 Kotlin `Any?` 树互转，供分析/覆盖逻辑做原地修改。
 *
 * 数字保留**原始字面量**（[RawNumber]）：工作流快照 round-trip 后序列化结果与原文一致，
 * 避免 `3` 被改写成 `3.0` 造成快照漂移。
 */

/** 原始数字字面量（如 `3`、`3.5`、`1e3`），序列化时按原文输出。 */
class RawNumber(val literal: String) : Number() {
    override fun toByte(): Byte = literal.toDouble().toInt().toByte()
    override fun toDouble(): Double = literal.toDouble()
    override fun toFloat(): Float = literal.toFloat()
    override fun toInt(): Int = literal.toDouble().toInt()
    override fun toLong(): Long = literal.toDouble().toLong()
    override fun toShort(): Short = literal.toDouble().toInt().toShort()
    override fun toString(): String = literal
    override fun equals(other: Any?): Boolean = other is RawNumber && other.literal == literal
    override fun hashCode(): Int = literal.hashCode()
}

private val json = Json

internal fun parseJsonElement(text: String): JsonElement = json.parseToJsonElement(text)

internal fun encodeJsonElement(element: JsonElement): String =
    json.encodeToString(JsonElement.serializer(), element)

/** JSON → Kotlin `Any?`（对象保序为 LinkedHashMap，数组为 ArrayList）。 */
internal fun jsonToValue(element: JsonElement): Any? = when (element) {
    is JsonNull -> null
    is JsonPrimitive -> when {
        element.isString -> element.content
        element.content == "true" -> true
        element.content == "false" -> false
        else -> RawNumber(element.content)
    }
    is JsonObject -> LinkedHashMap<String, Any?>(element.size).apply {
        for ((key, value) in element) put(key, jsonToValue(value))
    }
    is JsonArray -> ArrayList<Any?>(element.size).apply {
        for (value in element) add(jsonToValue(value))
    }
    else -> throw IllegalArgumentException("无法解析的 JSON 值类型: ${element::class.simpleName}")
}

/** Kotlin `Any?` → JSON（Map/List 按迭代顺序输出）。 */
internal fun valueToJson(value: Any?): JsonElement = when (value) {
    null -> JsonNull
    is JsonElement -> value
    is Boolean -> JsonPrimitive(value)
    is String -> JsonPrimitive(value)
    is RawNumber -> JsonPrimitive(value)
    is Int -> JsonPrimitive(value)
    is Long -> JsonPrimitive(value)
    is Short -> JsonPrimitive(value.toLong())
    is Byte -> JsonPrimitive(value.toLong())
    is Double -> JsonPrimitive(value)
    is Float -> JsonPrimitive(value.toDouble())
    is Map<*, *> -> JsonObject(value.entries.associate { (key, item) ->
        (key as? String ?: throw IllegalArgumentException("JSON 对象键必须是字符串: $key")) to valueToJson(item)
    })
    is List<*> -> JsonArray(value.map { valueToJson(it) })
    is Array<*> -> JsonArray(value.map { valueToJson(it) })
    else -> throw IllegalArgumentException("无法序列化为 JSON 的值类型: ${value::class.simpleName}")
}

/** JSON 字符串转义（手工拼请求体时共用，对齐 network.models.escapeJson 语义）。 */
internal fun escapeJson(text: String): String = buildString(text.length + 8) {
    for (ch in text) {
        when (ch) {
            '\\' -> append("\\\\")
            '"' -> append("\\\"")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (ch.code < 0x20) append("\\u%04x".format(ch.code)) else append(ch)
        }
    }
}
