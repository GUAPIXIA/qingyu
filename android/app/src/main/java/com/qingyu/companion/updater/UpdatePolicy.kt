package com.qingyu.companion.updater

/**
 * S6-07 更新策略（纯函数，JVM 可测）：版本比较、按发布渠道选包、checksum 文本解析。
 */
object UpdatePolicy {

    /** 版本比较：数字段按数值、字母段按字典序；预发布（1.2.3-beta）小于正式（1.2.3）。 */
    fun compareVersions(a: String, b: String): Int {
        val ta = tokenize(a)
        val tb = tokenize(b)
        val n = minOf(ta.size, tb.size)
        for (i in 0 until n) {
            val xa = ta[i]
            val xb = tb[i]
            val cmp = if (xa.isNum && xb.isNum) {
                xa.num.compareTo(xb.num)
            } else if (xa.isNum != xb.isNum) {
                // 数字段大于字母段（1.2.3 > 1.2.3-beta 的尾段场景）
                if (xa.isNum) 1 else -1
            } else {
                xa.text.compareTo(xb.text, ignoreCase = true)
            }
            if (cmp != 0) return cmp
        }
        // 公共前缀相同：更长的一方若剩余首段是字母（预发布标记）则更小，否则更大
        if (ta.size == tb.size) return 0
        val longer = if (ta.size > tb.size) ta else tb
        val shorterIsA = ta.size < tb.size
        val restIsWord = !longer[n].isNum
        return when {
            restIsWord && shorterIsA -> 1   // a 短但 b 带预发布尾 → a 大
            restIsWord && !shorterIsA -> -1
            shorterIsA -> -1
            else -> 1
        }
    }

    /** candidate 是否比 current 更新 */
    fun isNewer(candidate: String, current: String): Boolean = compareVersions(candidate, current) > 0

    /**
     * 按发布渠道选包：
     * 1. 优先精确匹配当前渠道；
     * 2. 非 STABLE 渠道无匹配时回落 STABLE（安全侧回落正式渠道）；
     * 3. STABLE 渠道不接受其它渠道的包。
     */
    fun selectForChannel(releases: List<UpdatePackage>, channel: ReleaseChannel): UpdatePackage? =
        releases.firstOrNull { it.channel == channel }
            ?: if (channel != ReleaseChannel.STABLE) {
                releases.firstOrNull { it.channel == ReleaseChannel.STABLE }
            } else {
                null
            }

    /**
     * 解析 checksum sidecar 文本（`<sha256>` 或 `<sha256>  文件名` 或 `SHA256(文件)= <sha256>`）。
     * 取首个 64 位十六进制串并归一为小写；没有则 null（→ 拒绝安装）。
     */
    fun parseChecksumText(text: String?): String? {
        if (text == null) return null
        return SHA256_REGEX.find(text.trim())?.value?.lowercase()
    }

    private val SHA256_REGEX = Regex("""(?i)(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])""")

    private class Token(val text: String, val isNum: Boolean) {
        val num: Long by lazy { text.toLongOrNull() ?: 0L }
    }

    /** 版本串切分为数字/字母 token（丢弃 v 前缀与 +build 元数据） */
    private fun tokenize(version: String): List<Token> {
        val cleaned = version.trim().removePrefix("v").removePrefix("V").substringBefore('+')
        return TOKEN_REGEX.findAll(cleaned)
            .map { Token(it.value, it.value[0].isDigit()) }
            .toList()
    }

    private val TOKEN_REGEX = Regex("""[0-9]+|[A-Za-z]+""")
}
