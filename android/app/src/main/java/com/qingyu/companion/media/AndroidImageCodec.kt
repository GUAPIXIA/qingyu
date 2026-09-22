package com.qingyu.companion.media

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix

/**
 * [ImageCodec] 的 Android 生产实现（BitmapFactory 两段式解码）。
 *
 * 唯一允许触碰 `android.graphics` 的地方：纯逻辑侧（校验/剥离/尺寸解析）全部无 Android 依赖，
 * 便于 JVM 直测；这里只负责「真的把像素解出来再压回去」。
 *
 * 大图保护与 `ImageUtils.decodeSampledBitmap` 同一思路：先 `inJustDecodeBounds` 读边界，
 * 再按 [ThumbnailSpec.maxDimension] 计算 `inSampleSize`，最后精确缩放——
 * 绝不为一张注定超限的图分配整幅位图。
 */
class AndroidImageCodec : ImageCodec {

    override fun probe(bytes: ByteArray): ImageProbe? {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) }.getOrNull()
        val width = options.outWidth
        val height = options.outHeight
        if (width <= 0 || height <= 0) return null
        val mime = MagicBytes.detectImageMime(bytes) ?: return null
        return ImageProbe(width = width, height = height, mime = mime)
    }

    override fun thumbnail(bytes: ByteArray, spec: ThumbnailSpec): Thumbnail? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val (targetW, targetH) = ThumbnailMath.fit(bounds.outWidth, bounds.outHeight, spec.maxDimension)

        var sample = 1
        while (bounds.outWidth / sample > targetW * 2 || bounds.outHeight / sample > targetH * 2) {
            sample *= 2
        }
        val sampled = runCatching {
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
        }.getOrNull() ?: return null
        val scaled = if (sampled.width == targetW && sampled.height == targetH) {
            sampled
        } else {
            val resized = runCatching { Bitmap.createScaledBitmap(sampled, targetW, targetH, true) }.getOrNull()
            if (resized == null) {
                sampled.recycle()
                return null
            }
            resized
        }
        val encoded = compress(scaled, spec)
        if (scaled !== sampled) scaled.recycle()
        sampled.recycle()
        if (encoded == null || encoded.isEmpty()) return null
        return Thumbnail(bytes = encoded, mime = spec.mimeType, width = targetW, height = targetH)
    }

    /**
     * 解码 → 应用方向变换 → 重编码（JPEG）。
     *
     * 产物是全新编码的 JPEG：EXIF（含 Orientation 本身）天然不存在，
     * 「保留方向」通过烘焙进像素实现，而不是把 EXIF 标签留下来。
     */
    override fun reencodeWithOrientation(bytes: ByteArray, transform: OrientationTransform): ByteArray? {
        val bitmap = runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }.getOrNull() ?: return null
        val matrix = Matrix()
        if (transform.flipHorizontal) matrix.postScale(-1f, 1f)
        if (transform.rotationDegrees != 0) matrix.postRotate(transform.rotationDegrees.toFloat())
        val transformed = if (matrix.isIdentity) {
            bitmap
        } else {
            val mapped = runCatching {
                Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
            }.getOrNull()
            if (mapped == null) {
                bitmap.recycle()
                return null
            }
            mapped
        }
        val out = encodeJpeg(transformed, quality = 92)
        if (transformed !== bitmap) transformed.recycle()
        bitmap.recycle()
        return out
    }

    private fun compress(bitmap: Bitmap, spec: ThumbnailSpec): ByteArray? {
        val format = if (spec.mimeType == MagicBytes.MIME_PNG) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
        return encode(bitmap, format, spec.quality.coerceIn(1, 100))
    }

    private fun encodeJpeg(bitmap: Bitmap, quality: Int): ByteArray? =
        encode(bitmap, Bitmap.CompressFormat.JPEG, quality)

    private fun encode(bitmap: Bitmap, format: Bitmap.CompressFormat, quality: Int): ByteArray? {
        val stream = java.io.ByteArrayOutputStream()
        val ok = runCatching { bitmap.compress(format, quality, stream) }.getOrDefault(false)
        return if (ok) stream.toByteArray() else null
    }
}
