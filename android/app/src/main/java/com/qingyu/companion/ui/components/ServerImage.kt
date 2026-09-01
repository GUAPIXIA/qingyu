package com.qingyu.companion.ui.components

import android.util.Log
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.network.NetworkModule

/**
 * 服务器资源 URL 解析：桥接层返回的相对路径（如 /static/avatars/xxx）
 * 拼接到当前连接的 baseUrl。统一经 [NetworkModule.httpBaseUrl]/[NetworkModule.endpointOf]
 * 生成（协议由 EndpointPolicy 唯一裁决）——公网 TLS 连接不再被硬编码 http 拼串破坏，
 * 且与 B 阶段「按 URL host:port 归属 token」的匹配规则（endpointOf）一致。
 */
fun resolveImageUrl(path: String?, connection: ServerConnection?): String? {
    Log.d("ServerImage", "resolveImageUrl: path=$path, connection=${connection?.host}:${connection?.port}")
    if (path.isNullOrBlank()) {
        Log.d("ServerImage", "resolveImageUrl: path is null or blank, returning null")
        return null
    }
    if (path.startsWith("http://") || path.startsWith("https://")) {
        Log.d("ServerImage", "resolveImageUrl: path is already absolute, returning $path")
        return path
    }
    val conn = connection ?: run {
        Log.d("ServerImage", "resolveImageUrl: connection is null, returning null")
        return null
    }
    val normalized = if (path.startsWith("/")) path else "/$path"
    // httpBaseUrl 以 / 结尾（toHttpUrl），先去掉再拼相对路径，保持与旧缓存键一致的"host:port/path"形态
    val result = NetworkModule.httpBaseUrl(NetworkModule.endpointOf(conn)).trimEnd('/') + normalized
    Log.d("ServerImage", "resolveImageUrl: resolved to $result")
    return result
}
