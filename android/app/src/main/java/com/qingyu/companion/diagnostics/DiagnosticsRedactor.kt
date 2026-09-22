package com.qingyu.companion.diagnostics

/**
 * S6-07 诊断脱敏器（纯函数，JVM 可测）。
 *
 * 三条防线（红线：导出里搜不到 API Key / token / 消息正文 / 路径里的用户名）：
 * 1. **结构级排除**：诊断模型根本没有正文字段（见 [DiagnosticsModels.kt]）；
 * 2. **已知秘密注册**：收集方接触过的秘密（API Key、token、消息正文样本等）注册进
 *    [knownSecrets]，脱敏时按最长优先逐个精确抹除——正文这类无法用模式识别的自由文本
 *    只能靠这条防线；
 * 3. **模式清洗**：常见密钥形态（sk- / ghp_ / JWT / Bearer / kv 形式 / 长随机串）、
 *    URL 内嵌凭据、路径用户名、邮箱本地部分一律抹除。
 *
 * [DiagnosticsLeakGuard] 是导出前的最后验收：扫描成品里是否还残留原串或密钥形态。
 */
class DiagnosticsRedactor(
    /** 已知秘密原串（API Key、token、消息正文等）；空串会被忽略 */
    val knownSecrets: List<String> = emptyList(),
) {
    /** 最长优先，避免短串先替换后长串匹配不到 */
    private val secretsByLength: List<String> =
        knownSecrets.filter { it.isNotBlank() }.distinct().sortedByDescending { it.length }

    /** 脱敏自由文本（错误摘要、能力值等）；超长截断避免整段正文混入 */
    fun redact(text: String): String {
        var out = text
        for (secret in secretsByLength) {
            if (secret in out) out = out.replace(secret, MASK)
        }
        out = scrubPatterns(out)
        return if (out.length > MAX_TEXT_LENGTH) out.take(MAX_TEXT_LENGTH) + "…" else out
    }

    /** 脱敏路径：抹掉用户名段（C:\Users\x / /home/x / /Users/x）与已知秘密 */
    fun redactPath(path: String): String {
        var out = path
        for (secret in secretsByLength) {
            if (secret in out) out = out.replace(secret, MASK)
        }
        return USER_HOME_REGEX.replace(out, "$1$MASK")
    }

    /** 对 Map 的键值逐个脱敏（键名同样清洗，防止秘密被当键名塞入） */
    fun redactMap(map: Map<String, String>): Map<String, String> =
        map.entries.associate { redact(it.key) to redact(it.value) }

    /** 对计数 Map：键名清洗，值是数字不动 */
    fun redactCounters(map: Map<String, Long>): Map<String, Long> =
        map.entries.associate { redact(it.key) to it.value }

    companion object {
        const val MASK: String = "***"
        const val MAX_TEXT_LENGTH: Int = 500

        /**
         * /Users/xxx、/home/xxx、C:\Users\xxx、/Documents and Settings/xxx 的用户名段。
         * 用户名字符类排除星号，保证脱敏后的掩码占位不会被再次命中（幂等）。
         */
        private val USER_HOME_REGEX =
            Regex("""((?:[A-Za-z]:)?(?:/|\\)(?:Users|users|home|Documents and Settings)(?:/|\\))([^/\\:\s"'|*]+)""")

        /** URL 内嵌凭据 scheme://user:pass@host → scheme://＊＊＊@host（星号全角：避免 //＊ 触发 Kotlin 嵌套注释吞代码） */
        private val URL_CREDENTIALS_REGEX =
            Regex("""([a-zA-Z][a-zA-Z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@""")

        /** key=value / "key": "value" / key: value 形式的秘密字段 */
        private val KV_SECRET_REGEX = Regex(
            """(?i)\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|session[_-]?id|signature)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&})\]]+)""",
        )

        /** Authorization 头：Bearer xxx / Basic xxx */
        private val AUTH_HEADER_REGEX =
            Regex("""(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}""")

        /** 认证类头字段（authorization / cookie）：整行值抹掉 */
        private val HEADER_KV_REGEX =
            Regex("""(?i)\b(authorization|cookie)(\s*[=:]\s*).+""")

        /** 公开云/代码平台密钥形态 */
        private val KNOWN_KEY_REGEXES = listOf(
            Regex("""\bsk-[A-Za-z0-9_-]{16,}"""),                 // OpenAI 风格
            Regex("""\bgh[pousr]_[A-Za-z0-9]{16,}"""),            // GitHub token
            Regex("""\bgithub_pat_[A-Za-z0-9_]{20,}"""),          // GitHub fine-grained
            Regex("""\bxox[baprs]-[A-Za-z0-9-]{10,}"""),          // Slack
            Regex("""\bAKIA[0-9A-Z]{16}\b"""),                    // AWS access key
            Regex("""\bAIza[0-9A-Za-z_-]{30,}"""),                // Google API key
            Regex("""\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"""), // JWT
        )

        /** 通用长随机串（32+ hex / 40+ base64ish）：token、密钥、签名兜底 */
        private val LONG_HEX_REGEX = Regex("""(?i)\b[a-f0-9]{32,}\b""")
        private val LONG_RANDOMISH_REGEX = Regex("""[A-Za-z0-9+/_-]{40,}={0,2}""")

        /** 邮箱本地部分脱敏，保留域名便于排障 */
        private val EMAIL_REGEX =
            Regex("""([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})""")

        /** 模式清洗（顺序：先具体形态，后通用兜底） */
        fun scrubPatterns(text: String): String {
            var out = text
            out = URL_CREDENTIALS_REGEX.replace(out, "$1$MASK@")
            out = USER_HOME_REGEX.replace(out, "$1$MASK")
            out = AUTH_HEADER_REGEX.replace(out, "$1 $MASK")
            out = HEADER_KV_REGEX.replace(out, "$1$2$MASK")
            out = KV_SECRET_REGEX.replace(out, "$1$2$MASK")
            for (regex in KNOWN_KEY_REGEXES) out = regex.replace(out, MASK)
            out = LONG_HEX_REGEX.replace(out, MASK)
            out = LONG_RANDOMISH_REGEX.replace(out, MASK)
            out = EMAIL_REGEX.replace(out, "$1$MASK$2")
            return out
        }

        /** 稳定短哈希（12 hex）：serverId / deviceId 等标识只以哈希形态入包 */
        fun hashId(value: String): String =
            java.security.MessageDigest.getInstance("SHA-256")
                .digest(value.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
                .take(12)
    }
}

/**
 * 导出前最后验收（纯函数，JVM 可测）：
 * 成品文本里不得再出现任何已知秘密原串（含 JSON 转义形态），也不得再出现密钥形态。
 */
object DiagnosticsLeakGuard {

    /** 返回成品中仍能搜到的已知秘密原串（含 JSON 转义形态）；空 = 干净 */
    fun findKnownSecrets(text: String, secrets: List<String>): List<String> =
        secrets.filter { it.isNotBlank() }
            .filter { secret -> secret in text || jsonEscape(secret) in text }
            .distinct()

    /** 返回成品中残留的密钥形态片段（token / API key / 用户名路径）；空 = 干净 */
    fun findSuspiciousPatterns(text: String): List<String> {
        val hits = mutableListOf<String>()
        for (regex in SUSPICIOUS_REGEXES) {
            regex.findAll(text).forEach { hits += it.value }
        }
        return hits
    }

    /** 兜底抹除残留原串（字段级脱敏后理论上不应触发；触发说明收集方漏注册） */
    fun scrubResiduals(text: String, secrets: List<String>): String {
        var out = text
        for (secret in secrets.filter { it.isNotBlank() }.distinct().sortedByDescending { it.length }) {
            val escaped = jsonEscape(secret)
            if (escaped in out) out = out.replace(escaped, jsonEscape(DiagnosticsRedactor.MASK))
            if (secret in out) out = out.replace(secret, DiagnosticsRedactor.MASK)
        }
        return out
    }

    /** 最小 JSON 字符串转义（与 kotlinx.serialization 输出形态一致，仅用于扫描/替换） */
    fun jsonEscape(value: String): String = buildString {
        for (c in value) {
            when (c) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (c < ' ') append("\\u%04x".format(c.code)) else append(c)
            }
        }
    }

    /** 与脱敏器一致的密钥形态（用于验收扫描） */
    private val SUSPICIOUS_REGEXES = listOf(
        Regex("""\bsk-[A-Za-z0-9_-]{16,}"""),
        Regex("""\bgh[pousr]_[A-Za-z0-9]{16,}"""),
        Regex("""\bgithub_pat_[A-Za-z0-9_]{20,}"""),
        Regex("""\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"""),
        Regex("""(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"""),
        Regex("""((?:[A-Za-z]:)?(?:/|\\)(?:Users|users|home|Documents and Settings)(?:/|\\))([^/\\:\s"'|*]+)"""),
    )
}
