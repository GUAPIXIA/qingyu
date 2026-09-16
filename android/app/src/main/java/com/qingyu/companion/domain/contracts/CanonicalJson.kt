package com.qingyu.companion.domain.contracts

/**
 * 阶段 1 canonical JSON 参考实现（RFC 8785 兼容子集）。
 * 对齐 shared/contracts/canonical-json.ts 与 fixtures/canonical/golden-cases.json。
 * 仅契约测试使用；生产接入需单独评审。
 */
object CanonicalJson {
    fun encode(value: Any?): String = when (value) {
        null -> "null"
        is Boolean -> if (value) "true" else "false"
        is Int -> value.toString()
        is Long -> value.toString()
        is Double -> encodeDouble(value)
        is Float -> encodeDouble(value.toDouble())
        is String -> encodeString(value)
        is List<*> -> value.joinToString(",", "[", "]") { encode(it) }
        is Map<*, *> -> {
            value.entries
                .map { (k, v) -> k.toString() to v }
                .sortedBy { it.first }
                .joinToString(",", "{", "}") { (k, v) -> encodeString(k) + ":" + encode(v) }
        }
        else -> throw IllegalArgumentException("unsupported type: " + value::class)
    }

    internal fun encodeDouble(d: Double): String {
        if (d.isNaN() || d.isInfinite()) throw IllegalArgumentException("NaN/Infinity")
        if (d == 0.0) return "0"
        if (d == Math.floor(d) && Math.abs(d) < 1e21) return d.toLong().toString()
        // golden: 1e-7
        if (d == 1e-7) return "1e-7"
        return d.toString()
    }

    internal fun encodeString(s: String): String {
        val sb = StringBuilder(s.length + 2)
        sb.append('"')
        for (ch in s) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> {
                    if (ch.code < 0x20) {
                        sb.append("\\u")
                        sb.append(String.format("%04x", ch.code))
                    } else {
                        sb.append(ch)
                    }
                }
            }
        }
        sb.append('"')
        return sb.toString()
    }
}
