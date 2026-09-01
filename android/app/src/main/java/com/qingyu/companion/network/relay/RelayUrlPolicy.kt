package com.qingyu.companion.network.relay

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

object RelayUrlPolicy {
    const val DEFAULT_BASE_URL = "https://cjbtj.xyz"

    fun normalizeBaseUrl(value: String): HttpUrl {
        val url = value.trim().toHttpUrlOrNull() ?: throw IllegalArgumentException("Relay 地址无效")
        require(url.scheme == "https") { "Relay 仅允许 HTTPS" }
        require(url.username.isEmpty() && url.password.isEmpty()) { "Relay 地址不能包含账号" }
        require(url.query == null && url.fragment == null) { "Relay 地址不能包含 query/fragment" }
        return url.newBuilder().encodedPath(url.encodedPath.trimEnd('/') + "/").build()
    }

    fun bridgeBaseUrl(value: String): String = normalizeBaseUrl(value).newBuilder()
        .encodedPath("/relay/v1/bridge/").build().toString()

    fun androidWsUrl(value: String): String = normalizeBaseUrl(value).newBuilder()
        .encodedPath("/relay/v1/ws/android").build().toString()
        .replaceFirst("https://", "wss://")
}
