package com.qingyu.companion.imagegen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-04：生成结果下载后的校验（大小/哈希/MIME），失败一律拒绝保存。
 */
class ImageResultVerifierTest {

    private fun pngBytes(size: Int = 16): ByteArray =
        ByteArray(size) { i -> if (i < 8) PNG_MAGIC[i] else (i % 251).toByte() }

    private val PNG_MAGIC = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)

    @Test
    fun `valid png verified with hash and mime`() {
        val bytes = pngBytes()
        val result = ImageResultVerifier.verify(bytes, "image/png")
        result as ImageResultVerifier.Result.Ok
        assertEquals("MIME 必须取嗅探结果", "image/png", result.image.mimeType)
        assertEquals("哈希必须是 sha256 小写十六进制", ImageResultVerifier.sha256Hex(bytes), result.image.sha256Hex)
        assertEquals("大小必须记录", bytes.size.toLong(), result.image.byteSize)
    }

    @Test
    fun `hash mismatch rejected`() {
        val bytes = pngBytes()
        val result = ImageResultVerifier.verify(bytes, "image/png", expectedSha256Hex = "0".repeat(64))
        result as ImageResultVerifier.Result.Rejected
        assertEquals("哈希不匹配必须拒绝保存", "IMAGE_HASH_MISMATCH", result.failure.code)
        assertTrue("拒绝原因必须写明哈希校验失败", result.failure.message.contains("哈希校验失败"))
    }

    @Test
    fun `oversize result rejected`() {
        val result = ImageResultVerifier.verify(pngBytes(64), "image/png", maxBytes = 16)
        result as ImageResultVerifier.Result.Rejected
        assertEquals("超上限结果必须拒绝保存", "IMAGE_TOO_LARGE", result.failure.code)
    }

    @Test
    fun `empty result rejected`() {
        val result = ImageResultVerifier.verify(ByteArray(0), "image/png")
        result as ImageResultVerifier.Result.Rejected
        assertEquals("空结果必须拒绝保存", "EMPTY_IMAGE", result.failure.code)
    }

    @Test
    fun `declared mime mismatch with content rejected`() {
        val result = ImageResultVerifier.verify(pngBytes(), "image/jpeg")
        result as ImageResultVerifier.Result.Rejected
        assertEquals("伪 MIME 必须拒绝", "MIME_MISMATCH", result.failure.code)
    }

    @Test
    fun `unknown content rejected`() {
        val result = ImageResultVerifier.verify(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 9), "image/png")
        result as ImageResultVerifier.Result.Rejected
        assertEquals("不可识别内容必须拒绝", "UNKNOWN_IMAGE_FORMAT", result.failure.code)
    }

    @Test
    fun `jpeg sniffing works`() {
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte(), 0, 0, 0)
        val result = ImageResultVerifier.verify(jpeg, "image/jpeg")
        assertTrue("JPEG magic 必须识别", result is ImageResultVerifier.Result.Ok)
    }
}
