package com.qingyu.companion.imagegen

/**
 * 生图端点 URL 安全边界（阶段 6 §3 SSRF 矩阵；纯 JVM 可测）。
 *
 * 规则：
 * - 只接受 `http` / `https` scheme；`file://`、`javascript:`、`data:`、`ftp:`、`ws:` 等一律拒绝；
 * - 拒绝 userinfo（`https://user:pass@host`）凭据夹带；
 * - 拒绝链路本地/内网元数据目标（`169.254.0.0/16`、`fe80::/10`、IPv4-mapped `::ffff:169.254.*`、
 *   `metadata.google.internal`），云元数据端点即使走 TLS 也不得作为跳转目标；
 * - 重定向沿用仓库既有 A-05 不变量（`EndpointNormalizer.decideRedirectAllowed` 同语义）：
 *   不允许 HTTPS→HTTP 降级、不允许公网→本地明文跳转，本地 http→本地 http 放行。
 *
 * 用户配置的局域网/公网端点（含 10/8、192.168/16 等私网）是合法目标——生图端点本来就在 LAN 上。
 */
object ImageGenUrlPolicy {

    sealed class UrlDecision {
        data class Allowed(val normalizedUrl: String) : UrlDecision()
        data class Blocked(val code: String, val reason: String) : UrlDecision()
    }

    /**
     * 端点 base URL 校验（不允许 query/fragment；尾斜杠被归一化去掉）。
     * 不做 localhost 阻断——那是 [LocalhostEndpointPolicy] 的迁移提示职责。
     */
    fun checkBaseUrl(raw: String): UrlDecision {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return UrlDecision.Blocked("EMPTY_URL", "base URL 不能为空")
        if (trimmed.contains('?') || trimmed.contains('#')) {
            return UrlDecision.Blocked("BAD_URL", "base URL 不允许包含 query 或 fragment")
        }
        return checkUrl(trimmed.trimEnd('/'))
    }

    /** 单个 URL 校验（允许 query，供 /view 等带查询的下载地址使用）。 */
    fun checkUrl(raw: String): UrlDecision {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return UrlDecision.Blocked("EMPTY_URL", "URL 不能为空")
        val schemeEnd = trimmed.indexOf("://")
        val scheme = if (schemeEnd > 0) trimmed.substring(0, schemeEnd).lowercase() else ""
        if (scheme != "http" && scheme != "https") {
            val shown = scheme.ifEmpty { "（缺少 scheme）" }
            return UrlDecision.Blocked("UNSUPPORTED_SCHEME", "仅支持 http/https 地址，已拒绝 $shown")
        }
        val rest = trimmed.substring(schemeEnd + 3)
        val authority = rest.substringBefore('/').substringBefore('?').substringBefore('#')
        if (authority.isEmpty()) return UrlDecision.Blocked("BAD_URL", "URL 缺少主机")
        if (authority.contains('@')) {
            return UrlDecision.Blocked("BAD_URL", "URL 不允许包含用户名/密码（userinfo），请把凭据配置在 API Key 中")
        }
        val host = bareHost(authority) ?: return UrlDecision.Blocked("BAD_URL", "URL 主机无法解析")
        if (host.isEmpty()) return UrlDecision.Blocked("BAD_URL", "URL 缺少主机")
        if (ImageGenHosts.isLinkLocalOrMetadata(host)) {
            return UrlDecision.Blocked("METADATA_ENDPOINT", "拒绝访问链路本地/内网元数据地址（$host）")
        }
        return UrlDecision.Allowed(trimmed)
    }

    /**
     * 重定向判定。[locationUrl] 必须是**已相对解析后的绝对 URL**（相对 Location 由执行层解析后调用）。
     */
    fun checkRedirect(requestUrl: String, locationUrl: String): UrlDecision {
        val location = when (val decision = checkUrl(locationUrl)) {
            is UrlDecision.Blocked -> return decision
            is UrlDecision.Allowed -> decision.normalizedUrl
        }
        val requestParts = splitSchemeHost(requestUrl) ?: return UrlDecision.Blocked("BAD_URL", "原请求 URL 无法解析")
        val locationParts = splitSchemeHost(location) ?: return UrlDecision.Blocked("BAD_URL", "重定向目标无法解析")
        val allowed = when (locationParts.scheme) {
            "https" -> true
            "http" -> requestParts.scheme == "http" &&
                ImageGenHosts.isLocalHost(requestParts.host) && ImageGenHosts.isLocalHost(locationParts.host)
            else -> false
        }
        return if (allowed) {
            UrlDecision.Allowed(location)
        } else {
            UrlDecision.Blocked(
                "REDIRECT_BLOCKED",
                "拒绝重定向：禁止 HTTPS→HTTP 降级或公网→本地明文跳转（$requestUrl → $location）",
            )
        }
    }

    internal data class SchemeHost(val scheme: String, val host: String)

    internal fun splitSchemeHost(url: String): SchemeHost? {
        val schemeEnd = url.indexOf("://")
        if (schemeEnd <= 0) return null
        val scheme = url.substring(0, schemeEnd).lowercase()
        if (scheme != "http" && scheme != "https") return null
        val authority = url.substring(schemeEnd + 3).substringBefore('/').substringBefore('?').substringBefore('#')
        val host = bareHost(authority.substringAfterLast('@')) ?: return null
        return if (host.isEmpty()) null else SchemeHost(scheme, host)
    }

    /** authority → 裸主机（去端口、去 IPv6 方括号与 %25 zone），无法解析返回 null。 */
    internal fun bareHost(authority: String): String? {
        if (authority.isEmpty()) return null
        if (authority.startsWith("[")) {
            val close = authority.indexOf(']')
            if (close < 0) return null
            return authority.substring(1, close).replace("%25", "%").lowercase()
        }
        val firstColon = authority.indexOf(':')
        return when {
            firstColon < 0 -> authority.lowercase()
            // 多冒号 = 裸 IPv6，整体为地址
            firstColon != authority.lastIndexOf(':') -> authority.lowercase()
            else -> authority.substring(0, firstColon).lowercase()
        }
    }
}

/**
 * 主机分类（纯函数）：loopback / 本地私网 / 链路本地与元数据。
 *
 * 与 `network.connection.EndpointNormalizer` 同口径（后者用于连接端点与 A-05 重定向策略），
 * 但把链路本地（169.254/16、fe80::/10）与云元数据主机单独归为**禁止目标**。
 */
object ImageGenHosts {

    /** `localhost`/`127.0.0.0/8`/`::1`/`0.0.0.0` 等“指向本机”的地址。 */
    fun isLoopback(host: String): Boolean {
        val value = host.trim().lowercase().removeSurrounding("[", "]").substringBefore('%')
        if (value.isEmpty()) return false
        if (value == "localhost" || value.endsWith(".localhost")) return true
        if (value == "0.0.0.0" || value == "::" || value == "0:0:0:0:0:0:0:0") return true
        val ipv4 = parseIpv4(value)
        if (ipv4 != null) return ipv4[0] == 127
        if (value == "::1" || value == "0:0:0:0:0:0:0:1") return true
        return false
    }

    /** 链路本地（169.254/16、fe80::/10）或云元数据主机——SSRF 边界禁止目标。 */
    fun isLinkLocalOrMetadata(host: String): Boolean {
        val value = host.trim().lowercase().removeSurrounding("[", "]").substringBefore('%')
        if (value.isEmpty()) return false
        if (value == "metadata.google.internal" || value == "metadata.goog") return true
        val ipv4 = parseIpv4(value)
        if (ipv4 != null) return ipv4[0] == 169 && ipv4[1] == 254
        if (value.startsWith("::ffff:")) {
            val mapped = parseIpv4(value.removePrefix("::ffff:"))
            if (mapped != null) return mapped[0] == 169 && mapped[1] == 254
        }
        val first = parseIpv6FirstHextet(value) ?: return false
        // fe80::/10 → 首 hextet 位于 fe80..febf
        return first in 0xfe80..0xfebf
    }

    /** 本地/私网候选（允许明文直连的地址集合，与 EndpointNormalizer.isLocalHost 同口径）。 */
    fun isLocalHost(host: String): Boolean {
        val value = host.trim().lowercase().removeSurrounding("[", "]").substringBefore('%')
        if (value.isEmpty()) return false
        if (isLoopback(value)) return true
        if (value.endsWith(".local")) return true
        val ipv4 = parseIpv4(value)
        if (ipv4 != null) {
            val a = ipv4[0]
            val b = ipv4[1]
            return a == 10 ||
                (a == 192 && b == 168) ||
                (a == 172 && b in 16..31) ||
                (a == 100 && b in 64..127)
        }
        if (value.indexOf(':') >= 0) {
            val first = parseIpv6FirstHextet(value) ?: return false
            return first in 0xfc00..0xfdff // ULA fc00::/7
        }
        return false
    }

    /** 4 段点分十进制 IPv4（禁止前导零歧义）；不合法返回 null。 */
    internal fun parseIpv4(value: String): IntArray? {
        val parts = value.split('.')
        if (parts.size != 4) return null
        val octets = IntArray(4)
        for (i in 0..3) {
            val p = parts[i]
            if (p.isEmpty() || p.length > 3 || !p.all { it.isDigit() }) return null
            val n = p.toInt()
            if (n > 255) return null
            if (p.length > 1 && p[0] == '0') return null
            octets[i] = n
        }
        return octets
    }

    /** IPv6 首 hextet（十进制值）；非 IPv6 返回 null。 */
    internal fun parseIpv6FirstHextet(value: String): Int? {
        val addr = value.removeSurrounding("[", "]")
        if (addr.isEmpty() || addr.indexOf(':') < 0) return null
        if (!addr.all { it.isDigit() || it in 'a'..'f' || it == ':' || it == '.' }) return null
        val firstGroup = if (addr.startsWith(':')) "0" else addr.substringBefore(':')
        return firstGroup.toIntOrNull(16)
    }
}
