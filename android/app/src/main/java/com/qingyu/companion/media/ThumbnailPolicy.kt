package com.qingyu.companion.media

import kotlin.math.roundToInt

/**
 * 缩略图规格与尺寸计算（纯逻辑）。
 *
 * S6-02 要求「生成缩略图」——列表/草稿区只应加载缩略图，原图按需读，
 * 否则消息列表滚动就是内存压力测试。缩略图默认转 JPEG：输入可能是 PNG/WebP/GIF，
 * 统一成一种格式可以让消息列表的解码路径只有一条。
 */
data class ThumbnailSpec(
    /** 最长边上限（像素）。 */
    val maxDimension: Int = 512,
    val mimeType: String = MagicBytes.MIME_JPEG,
    val quality: Int = 80,
)

/** 缩略图产物（不含元数据）。 */
data class Thumbnail(
    val bytes: ByteArray,
    val mime: String,
    val width: Int,
    val height: Int,
) {
    override fun equals(other: Any?): Boolean =
        other is Thumbnail && mime == other.mime && width == other.width &&
            height == other.height && bytes.contentEquals(other.bytes)

    override fun hashCode(): Int {
        var result = bytes.contentHashCode()
        result = 31 * result + mime.hashCode()
        result = 31 * result + width
        result = 31 * result + height
        return result
    }
}

object ThumbnailMath {
    /** 等比缩放到最长边不超过 [maxDimension]；小图不放大（放大只添噪点不添信息）。 */
    fun fit(width: Int, height: Int, maxDimension: Int): Pair<Int, Int> {
        require(width > 0 && height > 0) { "尺寸必须为正：${width}x$height" }
        require(maxDimension > 0) { "缩略图上限必须为正：$maxDimension" }
        val longest = maxOf(width, height)
        if (longest <= maxDimension) return width to height
        val scale = maxDimension.toDouble() / longest
        // 四舍五入（非截断）：3x1000@512 的宽度 1.536 必须进到 2，截断会把列表图压成 1 像素
        val w = maxOf(1, (width * scale).roundToInt())
        val h = maxOf(1, (height * scale).roundToInt())
        return w to h
    }
}
