package com.qingyu.companion.network.connection

/**
 * 端点规范化与本地/公网判定（A-04/A-05）。
 *
 * 安全不变量（短期方案 §5）：
 * - 只有明确判定为本地的地址允许 LOCAL_CLEARTEXT（http/ws）；
 * - 公网域名与公网 IP 一律 TLS_SYSTEM（https/wss），构造 LOCAL_CLEARTEXT 直接失败；
 * - HTTP 重定向不得落到非本地明文，不得 HTTPS→HTTP 降级，不得公网→本地明文跳转。
 */
object EndpointNormalizer {

    /** 清洗用户输入后的主机与（可选）显式端口。 */
    data class CleanedHost(val host: String, val port: Int?)

    /**
     * 输入清洗：去除 scheme、路径/查询/片段、尾斜杠、空白与 IPv6 方括号；
     * 若 authority 自带 `:port`（IPv4 或主机名形式）则一并解析出来。
     * 返回 null 表示输入无法解析出主机。
     */
    fun sanitize(raw: String): CleanedHost? {
        var value = raw.trim().replace(Regex("\\s+"), "")
        if (value.isEmpty()) return null
        // 去 scheme（http:// https:// ws:// wss:// 等）
        value = value.substringAfter("://")
        // 去路径 / 查询 / 片段
        value = value.substringBefore('/').substringBefore('?').substringBefore('#')
        // 去 userinfo（a@b 形式取 @ 之后）
        value = value.substringAfterLast('@')
        var port: Int? = null
        if (value.startsWith('[')) {
            // IPv6 字面量 [addr]:port 或 [addr]%25zone
            val close = value.indexOf(']')
            if (close < 0) return null
            val addr = value.substring(1, close).replace("%25", "%").lowercase()
            val rest = value.substring(close + 1)
            if (rest.isNotEmpty()) {
                if (!rest.startsWith(":")) return null
                port = rest.substring(1).toIntOrNull() ?: return null
            }
            if (addr.isEmpty()) return null
            return CleanedHost(addr, port)
        }
        // 冒号处理：多冒号必为裸 IPv6（绝不做 host:port 切分，
        // 因 "fe80::1"、"::1" 的末段可能恰为纯数字）；单冒号且尾段全数字才视为 host:port。
        val firstColon = value.indexOf(':')
        if (firstColon >= 0 && firstColon != value.lastIndexOf(':')) {
            val addr = value.lowercase()
            if (addr.length <= 1) return null
            return CleanedHost(addr, null)
        }
        if (firstColon > 0) {
            val tail = value.substring(firstColon + 1)
            if (tail.isNotEmpty() && tail.all { it.isDigit() }) {
                port = tail.toIntOrNull()?.takeIf { it in 1..65535 } ?: return null
                value = value.substring(0, firstColon)
            } else {
                // 单冒号非端口形态（罕见 IPv6 片段）：整体视为地址
                return CleanedHost(value.lowercase(), null)
            }
        }
        value = value.lowercase().trim('.')
        if (value.isEmpty()) return null
        return CleanedHost(value, port)
    }

    /** 归一化输入并推断安全等级；无法解析主机时抛 [IllegalArgumentException]。 */
    fun normalize(rawHost: String, explicitPort: Int? = null): ConnectionEndpoint {
        val cleaned = sanitize(rawHost)
            ?: throw IllegalArgumentException("非法端点主机: $rawHost")
        val port = explicitPort ?: cleaned.port
            ?: throw IllegalArgumentException("缺少端口且输入未含端口: $rawHost")
        return ConnectionEndpoint(cleaned.host, port, securityFor(cleaned.host))
    }

    /** 主机类型 → 安全等级（测试表核心规则）。 */
    fun securityFor(host: String): TransportSecurity =
        if (isLocalHost(host)) TransportSecurity.LOCAL_CLEARTEXT else TransportSecurity.TLS_SYSTEM

    /** 是否本地/私网候选（允许明文直连的地址集合）。 */
    fun isLocalHost(host: String): Boolean {
        val value = sanitize(host)?.host ?: return false
        if (value == "localhost" || value.endsWith(".localhost")) return true
        // mDNS .local 视为本地候选
        if (value.endsWith(".local")) return true
        val ipv4 = parseIpv4(value)
        if (ipv4 != null) return isLocalIpv4(ipv4)
        if (value.indexOf(':') >= 0) return isLocalIpv6(value)
        return false
    }

    /** 4 段点分十进制 IPv4；不合法返回 null。 */
    fun parseIpv4(value: String): IntArray? {
        val parts = value.split('.')
        if (parts.size != 4) return null
        val octets = IntArray(4)
        for (i in 0..3) {
            val p = parts[i]
            if (p.isEmpty() || p.length > 3 || !p.all { it.isDigit() }) return null
            val n = p.toInt()
            if (n > 255) return null
            // 禁止 01 之类的前导零歧义写法被误判（保守：仅 0 单字符允许前导）
            if (p.length > 1 && p[0] == '0') return null
            octets[i] = n
        }
        return octets
    }

    fun isLocalIpv4(octets: IntArray): Boolean {
        val a = octets[0]
        val b = octets[1]
        return a == 127 /* loopback 127/8 */ ||
            a == 10 /* 10/8 */ ||
            a == 192 && b == 168 /* 192.168/16 */ ||
            a == 172 && b in 16..31 /* 172.16/12 */ ||
            a == 100 && b in 64..127 /* 100.64/10 CGNAT（Tailscale 等） */
    }

    /** 解析 IPv6（去 zone id），返回首个 hextet 与规范化地址；非 IPv6 返回 null。 */
    private fun parseIpv6(value: String): Pair<Int, String>? {
        val addr = value.substringBefore('%').removeSurrounding("[", "]")
        if (addr.isEmpty() || addr.indexOf(':') < 0) return null
        if (!addr.all { it.isDigit() || it in 'a'..'f' || it == ':' || it == '.' }) return null
        val firstGroup = if (addr.startsWith(':')) "0" else addr.substringBefore(':')
        val first = firstGroup.toIntOrNull(16) ?: return null
        return first to addr.lowercase()
        }

    fun isLocalIpv6(value: String): Boolean {
        val parsed = parseIpv6(value) ?: return false
        val (first, addr) = parsed
        // loopback ::1（含 0:0:0:0:0:0:0:1 全写）
        if (addr == "::1" || addr == "0:0:0:0:0:0:0:1") return true
        // ULA fc00::/7 → 首字节 0xFC/0xFD，即首 hextet 位于 fc00..fdff
        if (first in 0xfc00..0xfdff) return true
        // link-local fe80::/10 → 首 hextet 位于 fe80..febf
        if (first in 0xfe80..0xfebf) return true
        return false
    }

    /**
     * 构造期安全校验：由 [ConnectionEndpoint] 的 init 调用。
     * 公网 host 试图 LOCAL_CLEARTEXT → 抛异常；TLS_PINNED 必须携带指纹。
     */
    fun validateConstruction(host: String, port: Int, security: TransportSecurity, certificatePin: String?) {
        require(host.isNotBlank()) { "端点主机不能为空" }
        require(!host.any { it.isWhitespace() } && !host.contains("://")) {
            "端点主机必须是清洗后的裸主机: $host"
        }
        require(port in 1..65535) { "非法端口: $port" }
        when (security) {
            TransportSecurity.LOCAL_CLEARTEXT ->
                require(isLocalHost(host)) { "公网地址禁止明文直连: $host" }
            TransportSecurity.TLS_PINNED ->
                require(!certificatePin.isNullOrBlank()) { "TLS_PINNED 端点必须携带证书指纹" }
            TransportSecurity.TLS_SYSTEM -> Unit
        }
    }

    /**
     * 重定向安全策略（纯决策函数，JVM 可直接回归）：
     * - Location 必须可解析为 http/https 绝对地址；
     * - 目标为明文 http：仅当请求与目标**均为本地**时放行（拒绝任何降级到公网明文）；
     * - 由此隐含拒绝 HTTPS→HTTP 降级与 公网→本地明文 跳转；
     * - 升级或保持 https 一律允许。
     */
    fun decideRedirectAllowed(requestUrl: String, locationUrl: String): Boolean {
        val request = splitUrl(requestUrl) ?: return false
        val location = splitUrl(locationUrl) ?: return false
        return when (location.scheme) {
            "https" -> true
            "http" -> request.scheme == "http" &&
                isLocalHost(request.host) && isLocalHost(location.host)
            else -> false
        }
    }

    private data class UrlParts(val scheme: String, val host: String)

    /** 极简 URL 拆分（scheme + 裸主机，去 IPv6 方括号与 %25），失败返回 null。 */
    private fun splitUrl(url: String): UrlParts? {
        val scheme = url.substringBefore("://", "").lowercase()
        if (scheme != "http" && scheme != "https") return null
        val authority = url.substringAfter("://").substringBefore('/').substringBefore('?').substringBefore('#')
        val hostPart = authority.substringAfterLast('@')
        val host = if (hostPart.startsWith('[')) {
            hostPart.substringAfter('[').substringBefore(']').replace("%25", "%").lowercase()
        } else {
            hostPart.substringBefore(':').lowercase()
        }
        if (host.isEmpty()) return null
        return UrlParts(scheme, host)
    }
}
