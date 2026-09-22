package com.qingyu.companion.media

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * 图片结构解析：真实尺寸 + 截断/损坏拦截（S6-02 §3：恶意图片、超大像素、损坏输入必须被拦截）。
 */
class ImageInspectionTest {

    private fun header(bytes: ByteArray, label: String): ImageInspection.Header =
        assertIs<ImageInspection.Header>(ImageInspector.inspect(bytes), "$label：结构合法却被拒，正常图片会被误杀")

    private fun rejected(bytes: ByteArray, label: String): String {
        val verdict = assertIs<ImageInspection.Rejected>(ImageInspector.inspect(bytes), "$label：损坏/恶意输入必须被拦截，否则会进 blob store")
        return verdict.reason
    }

    @Test
    fun `四种格式都能解析出真实尺寸`() {
        val png = header(MediaFixtures.png(37, 19), "PNG")
        assertEquals(37 to 19, png.width to png.height, "PNG 尺寸解析错误：像素上限判断会失真")

        val jpeg = header(MediaFixtures.jpeg(width = 640, height = 480), "JPEG")
        assertEquals(640 to 480, jpeg.width to jpeg.height, "JPEG 尺寸解析错误：像素上限判断会失真")

        val gif = header(MediaFixtures.gif(width = 5, height = 7), "GIF")
        assertEquals(5 to 7, gif.width to gif.height, "GIF 尺寸解析错误：像素上限判断会失真")

        val webp = header(MediaFixtures.webp(width = 300, height = 200), "WebP")
        assertEquals(300 to 200, webp.width to webp.height, "WebP 尺寸解析错误：像素上限判断会失真")
    }

    @Test
    fun `解压炸弹：小文件声明巨像素必须被尺寸读数暴露`() {
        // 几十字节的 PNG 声明 46340×46340 ≈ 21.5 亿像素；解码前必须先看到这个数字
        val bomb = MediaFixtures.png(46340, 46340)
        assertTrue(bomb.size < 200, "前置条件：炸弹文件本体必须很小（实际 ${bomb.size} 字节）")
        val inspected = header(bomb, "解压炸弹 PNG")
        assertEquals(46340 to 46340, inspected.width to inspected.height, "尺寸读数必须暴露声明像素，否则解压炸弹拦不住")
    }

    @Test
    fun `截断与损坏输入表驱动一律拒绝`() {
        val goodPng = MediaFixtures.png(8, 8, extraChunks = listOf(MediaFixtures.pngTextChunk()))
        val cases = listOf(
            "PNG 截断（砍掉尾部）" to goodPng.copyOfRange(0, goodPng.size - 30),
            "PNG 缺 IEND" to MediaFixtures.png(8, 8, includeIend = false),
            "PNG 缺 IDAT" to MediaFixtures.png(8, 8, includeIdat = false),
            "PNG 头部只有签名" to goodPng.copyOfRange(0, 8),
            "PNG 尾部被挂数据" to goodPng + byteArrayOf(0x00, 0x01),
            "JPEG 截断（无 EOI）" to MediaFixtures.jpeg(withEoi = false),
            "JPEG 砍半" to MediaFixtures.jpeg().let { it.copyOfRange(0, it.size / 2) },
            "GIF 无 trailer" to MediaFixtures.gif(withTrailer = false),
            "GIF 砍半" to MediaFixtures.gif().let { it.copyOfRange(0, it.size / 2) },
            "WebP RIFF 长度大于文件（截断）" to MediaFixtures.webp().let { it.copyOfRange(0, it.size - 4) },
            "WebP 尾部挂数据" to MediaFixtures.webp() + byteArrayOf(0, 0, 0, 0),
            "HTML 冒充图片" to "<html><script>alert(1)</script>".toByteArray(),
            "随机二进制" to ByteArray(64) { (it * 37).toByte() },
            "空输入" to ByteArray(0),
        )
        for ((label, bytes) in cases) {
            val reason = rejected(bytes, label)
            assertTrue(reason.isNotBlank(), "$label：拒绝原因不能为空，用户需要知道发生了什么")
        }
    }

    @Test
    fun `PNG IHDR CRC 改坏必须拒绝（头部损坏不可放行）`() {
        val png = MediaFixtures.png(16, 9)
        val corrupted = png.copyOf()
        corrupted[19] = (corrupted[19].toInt() xor 0x01).toByte() // 改高度最低位但不修 CRC
        val reason = rejected(corrupted, "IHDR CRC 损坏")
        assertTrue(reason.contains("校验") || reason.contains("损坏"), "拒绝原因应指出损坏（实际：$reason）")
    }

    @Test
    fun `JPEG 段长度越界必须拒绝`() {
        val jpeg = MediaFixtures.jpeg(app1 = MediaFixtures.exifApp1Payload(orientation = 6))
        val corrupted = jpeg.copyOf()
        // 布局：SOI(2) + APP0(18) 起，APP1 标记在 [20..21]、段长度在 [22..23]
        assertEquals(0xff, corrupted[20].toInt() and 0xFF, "前置条件：APP1 标记位置变了，测试要跟着改")
        assertEquals(0xe1, corrupted[21].toInt() and 0xFF, "前置条件：APP1 标记位置变了，测试要跟着改")
        corrupted[22] = 0x7f
        corrupted[23] = 0xff.toByte() // 段长度 0x7fff，远超文件剩余
        val reason = rejected(corrupted, "JPEG 段长度越界")
        assertTrue(reason.contains("越界") || reason.contains("截断"), "拒绝原因应指出段越界（实际：$reason）")
    }

    @Test
    fun `GIF 非法块标记必须拒绝`() {
        val gif = MediaFixtures.gif()
        val corrupted = gif.copyOf()
        corrupted[13] = 0x99.toByte() // 既不是扩展、图像块也不是 trailer
        val reason = rejected(corrupted, "GIF 非法块标记")
        assertTrue(reason.contains("GIF"), "拒绝原因应指明格式（实际：$reason）")
    }
}
