package com.qingyu.companion.network.connection

import kotlinx.serialization.Serializable

/**
 * 传输安全分级（A-04 端点规范化）。
 * - [LOCAL_CLEARTEXT]：明确判定为本地（私网 IPv4 / 加密隧道 100.64/10 / loopback /
 *   IPv6 ULA・link-local / .local mDNS）的地址，允许 http/ws 明文直连。
 * - [TLS_SYSTEM]：公网域名与公网 IP，强制 https/wss，走系统信任链。
 * - [TLS_PINNED]：预留（阶段 D 局域网 TLS 证书 + QR v2 指纹 pinning），构造时要求携带 [ConnectionEndpoint.certificatePin]。
 */
enum class TransportSecurity { LOCAL_CLEARTEXT, TLS_PINNED, TLS_SYSTEM }

/**
 * 规范化后的连接端点：REST / WS / Coil / TTS 的**唯一** URL 出口。
 * 构造即校验安全不变量（见 [EndpointNormalizer.validateConstruction]）：
 * 公网地址无法构造出 [TransportSecurity.LOCAL_CLEARTEXT]，调用方无法手工拼出公网 http。
 *
 * [host] 存储清洗后的裸主机（无 scheme、无路径、无方括号、无端口）；
 * IPv6 含 zone id 时以 `fe80::1%wlan0` 形式存储，生成 URL 时转为 `[fe80::1%25wlan0]`。
 */
@Serializable
data class ConnectionEndpoint(
    val host: String,
    val port: Int,
    val security: TransportSecurity,
    /** 证书公钥/SPKI 指纹（base64），仅 [TransportSecurity.TLS_PINNED] 使用（阶段 D）。 */
    val certificatePin: String? = null,
) {
    init {
        EndpointNormalizer.validateConstruction(host, port, security, certificatePin)
    }

    /** 是否为 IPv6 字面量（含 zone id），生成 URL 需加方括号。 */
    val isIpv6: Boolean get() = host.indexOf(':') >= 0

    /** URL 主机形式：IPv6 加 `[...]`，zone id 的 `%` 按 RFC 6874 编码为 `%25`。 */
    val hostForUrl: String
        get() = if (isIpv6) '[' + host.replace("%", "%25") + ']' else host

    /** 明文/密文协议前缀的唯一裁决点。 */
    fun httpScheme(): String = if (security == TransportSecurity.LOCAL_CLEARTEXT) "http" else "https"

    fun wsScheme(): String = if (security == TransportSecurity.LOCAL_CLEARTEXT) "ws" else "wss"

    /** REST baseUrl 唯一出口（Retrofit 要求尾斜杠）。 */
    fun toHttpUrl(): String = "${httpScheme()}://$hostForUrl:$port/"

    /** WebSocket URL 唯一出口（对齐既有 /ws 路由约定）。 */
    fun toWsUrl(): String = "${wsScheme()}://$hostForUrl:$port/ws"
}
