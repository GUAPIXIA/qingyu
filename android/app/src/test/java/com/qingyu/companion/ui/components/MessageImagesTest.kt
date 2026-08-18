package com.qingyu.companion.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Base64

/**
 * 图片源归一化单测：URL / data URI / 纯 base64 的识别与容错。
 * （方案 §3.3 生图结果回传消费侧：桥接层转 URL 优先，base64 兜底）
 */
class MessageImagesTest {

    /** 1x1 透明 PNG */
    private val pngBytes = Base64.getDecoder().decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    )

    private fun pngBase64(): String = Base64.getEncoder().encodeToString(pngBytes)

    @Test
    fun `http URL 识别为 Url`() {
        val src = resolveImageSource("http://192.168.1.5:8321/static/avatar.png")
        assertEquals(ImageSource.Url("http://192.168.1.5:8321/static/avatar.png"), src)
    }

    @Test
    fun `https URL 识别为 Url`() {
        val src = resolveImageSource("https://example.com/a.jpg")
        assertEquals(ImageSource.Url("https://example.com/a.jpg"), src)
    }

    @Test
    fun `空串与空白返回 null`() {
        assertNull(resolveImageSource(""))
        assertNull(resolveImageSource("   "))
    }

    @Test
    fun `纯 base64 图片字节识别为 Base64`() {
        val src = resolveImageSource(pngBase64())
        assertNotNull(src)
        assert(src is ImageSource.Base64)
        (src as ImageSource.Base64).bytes.contentEquals(pngBytes)
    }

    @Test
    fun `data URI 识别为 Base64`() {
        val src = resolveImageSource("data:image/png;base64,${pngBase64()}")
        assertNotNull(src)
        assert(src is ImageSource.Base64)
    }

    @Test
    fun `非图片纯文本 base64 返回 null`() {
        // 可解码但解码后不是图片 -> 判空
        val b64 = Base64.getEncoder().encodeToString("not an image".toByteArray())
        assertNull(resolveImageSource(b64))
    }

    @Test
    fun `非法 base64 返回 null`() {
        assertNull(resolveImageSource("!!!not-base64!!!"))
        assertNull(resolveImageSource("data:image/png;base64,"))
    }
}
