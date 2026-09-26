package com.qingyu.companion.ui.components

/**
 * S9-07：PC 桥接相对路径解析已删除。本地模式只接受绝对 URL 或原样返回。
 */
fun resolveImageUrl(path: String?, connection: Any? = null): String? {
    if (path.isNullOrBlank()) return null
    if (path.startsWith("http://") || path.startsWith("https://") || path.startsWith("file://")) {
        return path
    }
    return null
}
