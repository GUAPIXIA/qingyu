package com.qingyu.companion.utils

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import java.io.ByteArrayOutputStream

/**
 * 图片工具：相册选图 -> 采样解码 -> 压缩 -> base64（发送给 PC 桥接层）。
 */

/** 图片最长边（压缩上限，兼顾清晰度与传输体积） */
private const val MAX_DIMENSION = 1280

/** JPEG 压缩质量 */
private const val JPEG_QUALITY = 80

/**
 * 读取 Uri 图片并压缩为 base64（JPEG）。
 * @return base64 字符串（不含 data: 前缀），失败返回 null
 */
fun uriToCompressedBase64(context: Context, uri: Uri): String? {
    return try {
        val bitmap = decodeSampledBitmap(context, uri, MAX_DIMENSION) ?: return null
        val scaled = scaleToMax(bitmap, MAX_DIMENSION)
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
        if (scaled !== bitmap) scaled.recycle()
        bitmap.recycle()
        Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    } catch (e: Exception) {
        null
    }
}

/** 采样解码（先读尺寸再按需采样，防大图 OOM） */
private fun decodeSampledBitmap(context: Context, uri: Uri, maxDim: Int): Bitmap? {
    val resolver = context.contentResolver
    // 第一次：只读尺寸
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

    var sample = 1
    while (bounds.outWidth / sample > maxDim * 2 || bounds.outHeight / sample > maxDim * 2) {
        sample *= 2
    }
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    return resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) }
}

/** 等比缩放到最长边不超过 maxDim */
private fun scaleToMax(bitmap: Bitmap, maxDim: Int): Bitmap {
    val w = bitmap.width
    val h = bitmap.height
    val max = maxOf(w, h)
    if (max <= maxDim) return bitmap
    val scale = maxDim.toFloat() / max
    return Bitmap.createScaledBitmap(bitmap, (w * scale).toInt(), (h * scale).toInt(), true)
}
