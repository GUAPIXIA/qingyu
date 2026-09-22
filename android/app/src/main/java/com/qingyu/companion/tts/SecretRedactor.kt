package com.qingyu.companion.tts

/**
 * 凭据脱敏：TTS 日志 / 错误文案 / toString 的统一出口。
 *
 * 硬要求（S6-03「凭据来自本地 secret store」+ 阶段 3「明文秘密不进日志/toString」）：
 * - 已知凭据逐字抹除（包括供应商把密钥回显进错误体的情况）；
 * - 再兜底抹除 `Bearer xxx` 与 `sk-...` 样式，防止未登记的凭据形态漏进日志。
 */
object SecretRedactor {
    const val MASK = "••••"

    private val BEARER = Regex("(?i)(bearer\\s+)[A-Za-z0-9._~+/=-]{4,}")
    private val SK_STYLE = Regex("sk-[A-Za-z0-9_-]{6,}")

    fun redact(text: String, secrets: Collection<String?> = emptyList()): String {
        var out = text
        for (secret in secrets) {
            val plain = secret?.takeIf { it.isNotBlank() } ?: continue
            out = out.replace(plain, MASK)
        }
        out = BEARER.replace(out) { it.groupValues[1] + MASK }
        out = SK_STYLE.replace(out, MASK)
        return out
    }
}
