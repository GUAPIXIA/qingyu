package com.qingyu.companion.local.domain

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal

/**
 * 阶段 5：`org.json` ⇄ Kotlin 值的双向转换，供规范 payload 组装使用。
 *
 * 为什么需要它：实体哈希是对 `CanonicalJson.encode(payload)` 计算的，
 * 而 payload 里会出现嵌套结构（预设正文、世界书文档、快捷回复数组）。
 * 只要两侧对同一份数据产出的**键集合与值类型**一致，哈希才可能一致；
 * 因此这里把 JSON 文本规范化成 `Map`/`List`/`String`/`Long`/`Double`/`Boolean`/`null`
 * 这一组 `CanonicalJson` 认识的类型，不做任何隐式补字段。
 *
 * 数字规则：整数一律 `Long`，带小数的用 `Double`。
 * `org.json` 会把 `0.8` 解析成 `Double`、`8` 解析成 `Int`/`Long`；
 * 若不统一，`temperature: 1` 与 `temperature: 1.0` 在两端可能被编码成不同文本。
 */
object JsonValues {

    /**
     * 文本是否为**合法 JSON 对象**。
     *
     * [parseObject] 对「根本不是 JSON」和「就是 `{}`」都返回空 Map，两者无法区分；
     * 而写入端必须区分：坏正文若被当成空文档，`EntityPayloads` 会算出一份
     * 不含任何条目的 payload —— 数据在本地还在、同步出去就没了，
     * 且 2 MiB payload 上限也形同不存在（量的已是派生 payload 而非原始列）。
     */
    fun isJsonObjectText(text: String?): Boolean {
        val trimmed = text?.trim() ?: return false
        if (!trimmed.startsWith("{")) return false
        return runCatching { JSONObject(trimmed) }.isSuccess
    }

    /** JSON 文本 → `Map`；非法或不是对象时返回空 Map（调用方自行判定失败）。 */
    fun parseObject(text: String?): Map<String, Any?> {
        if (text.isNullOrBlank()) return emptyMap()
        val parsed = runCatching { JSONObject(text) }.getOrNull() ?: return emptyMap()
        return toMap(parsed)
    }

    /** JSON 文本 → `List`；非法或不是数组时返回空列表。 */
    fun parseArray(text: String?): List<Any?> {
        if (text.isNullOrBlank()) return emptyList()
        val parsed = runCatching { JSONArray(text) }.getOrNull() ?: return emptyList()
        return toArray(parsed)
    }

    /** JSON 文本 → 任意规范值；空文本返回 `null`，非法文本原样作为字符串。 */
    fun parseAny(text: String?): Any? {
        if (text.isNullOrBlank()) return null
        val trimmed = text.trim()
        if (trimmed.startsWith('{')) return parseObject(trimmed)
        if (trimmed.startsWith('[')) return parseArray(trimmed)
        return runCatching { JSONObject("{'v':$trimmed}").get("v") }.fold(
            onSuccess = { normalizeScalar(it) },
            onFailure = { text },
        )
    }

    /** Map → JSON 文本（用于落库列，与 `CanonicalJson.encode` 不同：这里要的是普通 JSON）。 */
    fun stringify(value: Any?): String = when (value) {
        null -> "null"
        is Map<*, *> -> JSONObject(value).toString()
        is List<*> -> JSONArray(value).toString()
        else -> JSONObject(mapOf("v" to value)).get("v").toString()
    }

    private fun toMap(obj: JSONObject): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>(obj.length())
        for (key in obj.keys()) {
            out[key] = convert(obj.get(key))
        }
        return out
    }

    private fun toArray(arr: JSONArray): List<Any?> =
        (0 until arr.length()).map { convert(arr.get(it)) }

    private fun convert(value: Any?): Any? = when (value) {
        JSONObject.NULL -> null
        is JSONObject -> toMap(value)
        is JSONArray -> toArray(value)
        else -> normalizeScalar(value)
    }

    private fun normalizeScalar(value: Any?): Any? = when (value) {
        is Int -> value.toLong()
        is Short -> value.toLong()
        is Byte -> value.toLong()
        is Float -> value.toDouble()
        is BigDecimal -> value.toLong()
        is Number -> value
        is Boolean -> value
        is String -> value
        else -> value?.toString()
    }
}
