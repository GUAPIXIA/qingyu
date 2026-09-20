package com.qingyu.companion.content.lorebook

import com.qingyu.companion.local.domain.JsonValues
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/**
 * 世界书适配层的 JSON ⇄ Kotlin 值约定（`shared/lorebook` 目录里 `JsonValue` /
 * `Record<string, unknown>` 那一套的落地形式）。
 *
 * 为什么单独一个文件：整个 lorebook 层（模型、校验、上限、8 个格式适配器、
 * 映射模板）都在同一组类型上工作——`Map<String, Any?>` 表示对象、`List<Any?>`
 * 表示数组、`String`/`Boolean`/`Long`/`Double`/`null` 表示标量。
 * 只要有一处偷偷用别的表示法参与比较，「同一份数据两端算出不同哈希」就会在阶段 7
 * 变成现实问题，所以这里把判定与转换收在一处。
 *
 * 键序：`JsonValues.parseObject` 返回 `LinkedHashMap`（Android 的 `JSONObject`
 * 内部就是 `LinkedHashMap`），所以 **输入里的键序会被保留**。这对 `foreign`
 * 预算裁剪（超限时按遍历顺序决定丢哪一个）和 SillyTavern 的 uid 键控对象条目
 * 顺序都有实际影响，不能换成无序 Map。
 */
object LorebookJson {

    /** 与 PC 各文件的 `DANGEROUS_KEYS` 一致：原型链键一律不入保留区。 */
    val DANGEROUS_KEYS: Set<String> = setOf("__proto__", "constructor", "prototype")

    /**
     * JSON 文本 → Kotlin 值；**解析失败返回 null**（区别于合法的空对象/空数组）。
     *
     * `JsonValues.parseObject` 对非法文本与 `{}` 都返回空 Map，用它做格式检测会把
     * 「文件根本不是 JSON」误判成「认不出格式」，所以这里先用 `org.json` 探一次。
     */
    fun parse(text: String): Any? {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return null
        return when {
            trimmed.startsWith("{") ->
                runCatching { JSONObject(trimmed) }.getOrNull()?.let { JsonValues.parseObject(trimmed) }
            trimmed.startsWith("[") ->
                runCatching { JSONArray(trimmed) }.getOrNull()?.let { JsonValues.parseArray(trimmed) }
            else -> JsonValues.parseAny(trimmed)
        }
    }

    /** Kotlin 值 → JSON 文本（紧凑格式，与 `JSON.stringify` 同义）。 */
    fun stringify(value: Any?): String = JsonValues.stringify(normalizeForWrite(value))

    /**
     * 人类可读导出文本（缩进 2）。
     *
     * 只对 Map/List 走 `org.json` 的 `toString(indent)`；标量沿用 [stringify]，
     * 因为「导出成文件」的场景里根节点一定是对象或数组。
     */
    fun stringifyPretty(value: Any?): String {
        val normalized = normalizeForWrite(value)
        return runCatching {
            when (normalized) {
                is Map<*, *> -> JSONObject(normalized).toString(PRETTY_INDENT)
                is List<*> -> JSONArray(normalized).toString(PRETTY_INDENT)
                else -> JsonValues.stringify(normalized)
            }
        }.getOrElse { JsonValues.stringify(normalized) }
    }

    /** 对象判定（PC `isRecord`）：数组与 null 都不是对象。 */
    @Suppress("UNCHECKED_CAST")
    fun record(value: Any?): Map<String, Any?>? = value as? Map<String, Any?>

    @Suppress("UNCHECKED_CAST")
    fun list(value: Any?): List<Any?>? = value as? List<Any?>

    /** `raw[key] !== undefined`：Map 里键不存在即视为 JS 的 `undefined`。 */
    fun has(record: Map<String, Any?>?, key: String): Boolean = record?.containsKey(key) == true

    /**
     * 模型外的键（未知键）：保留原样、原序，供 `toJsonMap` 回填。
     *
     * 这是 `structuredClone` 语义的等价物——PC 的 canonical 适配器导入会整份克隆输入，
     * 顶层与嵌套的未知键都存活。丢了这一步，「PC 导出 → Android 导入 → 再导出」
     * 就会静默瘦身，而这正是方案 §2 要求「未知字段保留报告」要防的事。
     */
    fun extrasOf(record: Map<String, Any?>, known: Set<String>): Map<String, Any?> {
        if (record.keys.all { known.contains(it) }) return emptyMap()
        val out = LinkedHashMap<String, Any?>()
        record.forEach { (key, value) -> if (!known.contains(key)) out[key] = value }
        return out
    }

    /** 字符串读取（PC `typeof v === 'string'`）。 */
    fun string(value: Any?): String? = value as? String

    /** 布尔读取（PC `typeof v === 'boolean'`）。 */
    fun boolean(value: Any?): Boolean? = value as? Boolean

    /**
     * 有限数字读取（PC `typeof v === 'number' && Number.isFinite(v)`）。
     *
     * 刻意不做字符串隐式转换：TS 侧这些字段一律显式判 `typeof === 'number'`，
     * 若这里接受 `"80"`，Android 就会把 PC 拒绝的输入导入成功，跨端结果分叉。
     */
    fun number(value: Any?): Double? {
        val double = when (value) {
            is Double -> value
            is Number -> value.toDouble()
            else -> return null
        }
        return if (double.isNaN() || double.isInfinite()) null else double
    }

    /** 字符串数组（PC `Array.isArray(v) && v.every(x => typeof x === 'string')`）。 */
    fun stringArray(value: Any?): List<String>? {
        val items = list(value) ?: return null
        return items.map { it as? String ?: return null }
    }

    /**
     * 递归清洗为可持久化 JSON 值（PC `toJsonValue`）。
     *
     * 语义细节：数组里遇到不可转换的成员是**跳过**而不是整体失败（`[1, <fn>]` → `[1]`），
     * 对象里同样跳过该键；`null` 是合法 JSON 值必须保留。
     * 解析自 JSON 的值不存在 JS 的 `undefined`，所以返回 `null` 只可能是
     * 「值本身是 null」或「该值不可持久化」，后者用 [isPersistable] 判定。
     */
    fun toJsonValue(value: Any?): Any? = when {
        value == null -> null
        value is String -> value
        value is Boolean -> value
        value is Number -> number(value)
        list(value) != null -> list(value)!!
            .filter { it == null || isPersistable(it) }
            .map { toJsonValue(it) }
        record(value) != null -> {
            val out = LinkedHashMap<String, Any?>()
            record(value)!!.forEach { (key, item) ->
                if (DANGEROUS_KEYS.contains(key)) return@forEach
                if (item == null || isPersistable(item)) out[key] = toJsonValue(item)
            }
            out
        }
        else -> null
    }

    /** 该值是否能进 JSON（数字必须有限，容器递归判定）。 */
    fun isPersistable(value: Any?): Boolean = when {
        value == null -> true
        value is String || value is Boolean -> true
        value is Number -> number(value) != null
        list(value) != null -> true
        record(value) != null -> true
        else -> false
    }

    /** PC `isJsonValue`：结构合法（含危险键判否）的 JSON 值。 */
    fun isJsonValue(value: Any?): Boolean = when {
        value == null -> true
        value is String || value is Boolean -> true
        value is Number -> number(value) != null
        list(value) != null -> list(value)!!.all { isJsonValue(it) }
        record(value) != null -> record(value)!!.all { (key, item) ->
            !DANGEROUS_KEYS.contains(key) && isJsonValue(item)
        }
        else -> false
    }

    /** 与 PC 的 `JSON.stringify(x).length` 同口径的体积估算（foreign 上限用）。 */
    fun charsOf(value: Any?): Int = if (value == null) 0 else stringify(value).length

    /** JS `String(number)`：整数值不带 `.0`，否则用十进制表示。 */
    fun jsNumberText(value: Double): String =
        if (value == Math.floor(value) && !value.isInfinite()) value.toLong().toString() else value.toString()

    /** SHA-256 hex（registry 未显式给 `contentHash` 时的兜底，对齐 `createHash('sha256')`）。 */
    fun sha256Hex(text: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        val out = StringBuilder(digest.size * 2)
        for (byte in digest) {
            val unsigned = byte.toInt() and 0xFF
            out.append(HEX_DIGITS[unsigned shr 4]).append(HEX_DIGITS[unsigned and 0x0F])
        }
        return out.toString()
    }

    /**
     * 写前归一化：把「整数值的双精度」还原成 `Long`，避免 `2.0` 被写成 `2.0`。
     *
     * 为什么要刻意做这一步：模型里数字统一用 `Double`（`revision`、`order`、
     * `createdAt` 都可能是整数），而 PC 的 `JSON.stringify` 对 `2` 和 `2.0` 都写 `2`。
     * 不还原的话，导出的文本与 PC 不同形——跨端比较虽然走 canonical 哈希，
     * 但 fixture 逐字节比对与用户手工 diff 都会失真。
     */
    private fun normalizeForWrite(value: Any?): Any? = when {
        value is Double ->
            if (value == Math.floor(value) && !value.isInfinite() && kotlin.math.abs(value) <= MAX_SAFE_INTEGER) {
                value.toLong()
            } else {
                value
            }
        value is Float -> normalizeForWrite(value.toDouble())
        value is Int -> value.toLong()
        value is Short || value is Byte -> value.toLong()
        list(value) != null -> list(value)!!.map { normalizeForWrite(it) }
        record(value) != null -> {
            val items = record(value)!!
            val out = LinkedHashMap<String, Any?>(items.size)
            items.forEach { (key, item) -> out[key] = normalizeForWrite(item) }
            out
        }
        else -> value
    }

    private const val PRETTY_INDENT = 2
    private const val MAX_SAFE_INTEGER = 9.007199254740991E15
    private const val HEX_DIGITS = "0123456789abcdef"
}
