package com.qingyu.companion.ui.components

import android.util.Log
import com.qingyu.companion.model.ServerConnection

/**
 * 服务器资源 URL 解析：桥接层返回的相对路径（如 /static/avatars/xxx）
 * 拼接到当前连接的 baseUrl（http://host:port）。
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
    val result = "http://${conn.host}:${conn.port}$normalized"
    Log.d("ServerImage", "resolveImageUrl: resolved to $result")
    return result
}
