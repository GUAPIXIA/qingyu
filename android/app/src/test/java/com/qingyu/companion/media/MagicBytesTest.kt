package com.qingyu.companion.media

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 魔数嗅探与「声明 MIME ↔ 真实魔数」一致性（S6-02：伪 MIME 必须被拦截）。
 */
class MagicBytesTest {

    @Test
    fun `四种图片格式按魔数识别，不看扩展名`() {
        val cases = mapOf(
            "PNG" to (MediaFixtures.realPng1x1 to MagicBytes.MIME_PNG),
            "JPEG" to (MediaFixtures.jpeg() to MagicBytes.MIME_JPEG),
            "GIF" to (MediaFixtures.gif() to MagicBytes.MIME_GIF),
            "WebP" to (MediaFixtures.webp() to MagicBytes.MIME_WEBP),
        )
        for ((label, pair) in cases) {
            val (bytes, expected) = pair
            assertEquals(expected, MagicBytes.detectImageMime(bytes), "$label：魔数识别错误，会让该格式的附件被误杀或误放")
        }
    }

    @Test
    fun `伪 MIME 表驱动：声明与魔数不符一律判不一致`() {
        val png = MediaFixtures.realPng1x1
        val jpeg = MediaFixtures.jpeg()
        val html = "<html><body>not an image</body></html>".toByteArray()
        val cases = listOf(
            Triple("image/png", jpeg, "声明 PNG 实为 JPEG"),
            Triple("image/jpeg", png, "声明 JPEG 实为 PNG"),
            Triple("image/png", html, "声明 PNG 实为 HTML"),
            Triple("text/plain", png, "声明文本实为 PNG"),
            Triple("application/pdf", png, "声明 PDF 实为 PNG"),
            Triple("image/png", ByteArray(0), "空字节"),
        )
        for ((declared, bytes, label) in cases) {
            val verdict = MagicBytes.verifyDeclaredMime(declared, bytes)
            assertIs<MagicBytes.MimeVerdict.Mismatch>(verdict, "$label：伪 MIME 必须被拦截，否则恶意图片会进 blob store")
        }
    }

    @Test
    fun `声明一致或未声明时以魔数为真值`() {
        val png = MediaFixtures.realPng1x1
        val consistent = assertIs<MagicBytes.MimeVerdict.Consistent>(
            MagicBytes.verifyDeclaredMime("image/png", png),
            "声明与魔数一致却判不一致：正常图片会被误杀",
        )
        assertEquals(MagicBytes.MIME_PNG, consistent.mime, "一致性判定的 MIME 必须取魔数真值，否则下游会按假 MIME 存储")

        // 别名归一化（image/jpg 是非标准写法，不算伪 MIME）
        val alias = assertIs<MagicBytes.MimeVerdict.Consistent>(
            MagicBytes.verifyDeclaredMime("image/jpg", MediaFixtures.jpeg()),
            "image/jpg 别名必须归一化为 image/jpeg，否则正常相册图片被误杀",
        )
        assertEquals(MagicBytes.MIME_JPEG, alias.mime, "别名归一化后必须得到标准 MIME")

        // 带参数的 Content-Type
        val withParam = assertIs<MagicBytes.MimeVerdict.Consistent>(
            MagicBytes.verifyDeclaredMime("image/png; charset=binary", png),
            "带参数的 Content-Type 必须归一化后比对，否则正常图片被误杀",
        )
        assertEquals(MagicBytes.MIME_PNG, withParam.mime, "参数剥离后必须得到纯 MIME")

        // 未声明：以魔数为唯一依据
        val undeclared = assertIs<MagicBytes.MimeVerdict.Consistent>(
            MagicBytes.verifyDeclaredMime(null, png),
            "来源未声明 MIME 时应以魔数为准（无可欺骗）",
        )
        assertEquals(MagicBytes.MIME_PNG, undeclared.mime, "未声明时 MIME 必须来自魔数")
    }

    @Test
    fun `通用文件嗅探覆盖 PDF、ZIP、GZIP、文本，二进制垃圾判不出`() {
        val cases = mapOf(
            "PDF" to ("%PDF-1.7\n…".toByteArray() to MagicBytes.MIME_PDF),
            "ZIP" to (byteArrayOf(0x50, 0x4b, 0x03, 0x04, 0, 0) to MagicBytes.MIME_ZIP),
            "GZIP" to (byteArrayOf(0x1f, 0x8b.toByte(), 0x08, 0x00) to MagicBytes.MIME_GZIP),
            "TEXT" to ("你好 world".toByteArray() to MagicBytes.MIME_TEXT),
        )
        for ((label, pair) in cases) {
            val (bytes, expected) = pair
            assertEquals(expected, MagicBytes.detectFileMime(bytes), "$label：文件类型嗅探错误，附件会被误杀或误放")
        }
        assertNull(
            MagicBytes.detectFileMime(byteArrayOf(0x00, 0x01, 0x02, 0xff.toByte(), 0x00)),
            "含 NUL 的未知二进制不得回落成 text/plain，否则任意二进制都能顶着文本 MIME 入库",
        )
        assertTrue(
            MagicBytes.detectFileMime(ByteArray(0)) == null,
            "空输入不得识别出任何格式，否则空附件会绕过「附件为空」检查",
        )
    }
}
