package com.qingyu.companion.media

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * 附件校验闸口（S6-02：读取时校验 MIME、magic bytes、尺寸、大小；
 * §3：伪 MIME、超大像素、损坏输入、路径穿越必须被拦截）。
 */
class AttachmentValidatorTest {

    private fun rejectedImage(
        fileName: String? = "a.png",
        declaredMime: String? = MagicBytes.MIME_PNG,
        bytes: ByteArray = MediaFixtures.png(8, 8),
        limits: AttachmentLimits = AttachmentLimits(),
        label: String = "",
    ): String {
        val verdict = AttachmentValidator.validateImage(fileName, declaredMime, bytes, limits)
        return assertIs<AttachmentVerdict.Rejected>(verdict, "$label：必须在写盘前被拦截，否则恶意图片会进 blob store").reason
    }

    @Test
    fun `合法图片通过并携带真实尺寸`() {
        val verdict = assertIs<AttachmentVerdict.Accepted>(
            AttachmentValidator.validateImage("照片.png", "image/png", MediaFixtures.png(320, 240)),
            "合法图片被拒：正常导入会全线失败",
        )
        assertEquals(MagicBytes.MIME_PNG, verdict.mime, "MIME 必须取魔数真值，否则下游按假 MIME 存储")
        assertEquals(320 to 240, verdict.width to verdict.height, "尺寸必须来自文件头，供像素上限与 UI 使用")
    }

    @Test
    fun `路径穿越文件名表驱动一律拦截`() {
        val cases = listOf(
            "../../etc/passwd",
            "..\\..\\windows\\system32\\evil.png",
            "/etc/passwd",
            "C:\\evil.png",
            "\\\\server\\share\\evil.png",
            "sub/dir/a.png",
            "..",
            ".hidden.png",
            "a\u0000.png",
            "a\nb.png",
        )
        for (name in cases) {
            val reason = rejectedImage(fileName = name, label = "文件名「$name」")
            assertTrue(
                reason.contains("文件名") || reason.contains("路径"),
                "文件名「$name」：拒绝原因应指出文件名问题（实际：$reason）",
            )
        }
    }

    @Test
    fun `伪 MIME 表驱动拦截，缺失声明按魔数放行`() {
        val png = MediaFixtures.png(8, 8)
        val cases = listOf(
            Triple(png, "image/jpeg", "声明 JPEG 实为 PNG"),
            Triple(png, "text/plain", "声明文本实为 PNG"),
            Triple(MediaFixtures.jpeg(), "image/png", "声明 PNG 实为 JPEG"),
            Triple(MediaFixtures.gif(), "image/webp", "声明 WebP 实为 GIF"),
            Triple("<html><script>x</script>".toByteArray(), "image/png", "声明 PNG 实为 HTML"),
        )
        for ((bytes, declared, label) in cases) {
            val reason = rejectedImage(declaredMime = declared, bytes = bytes, label = label)
            assertTrue(reason.contains("伪 MIME"), "$label：拒绝原因必须点名伪 MIME（实际：$reason）")
        }
        // 完全未声明：无可欺骗，按魔数放行
        val verdict = AttachmentValidator.validateImage("a.png", null, png)
        assertIs<AttachmentVerdict.Accepted>(verdict, "未声明 MIME 时应按魔数判定，否则 SAF 不给类型的来源会全军覆没")
    }

    @Test
    fun `超大像素与解压炸弹拦截`() {
        val overSide = rejectedImage(
            bytes = MediaFixtures.png(5000, 100),
            label = "宽 5000 超单边上限",
        )
        assertTrue(overSide.contains("尺寸"), "拒绝原因应指出尺寸（实际：$overSide）")

        val overTotal = rejectedImage(
            bytes = MediaFixtures.png(4000, 4000),
            limits = AttachmentLimits(maxPixelCount = 2_000_000),
            label = "像素总量爆表",
        )
        assertTrue(overTotal.contains("像素"), "拒绝原因应指出像素总量（实际：$overTotal）")

        // 几十字节的文件声明 21 亿像素：解压炸弹在解码前就必须死
        val bomb = rejectedImage(bytes = MediaFixtures.png(46340, 46340), label = "解压炸弹")
        assertTrue(bomb.contains("像素") || bomb.contains("尺寸"), "拒绝原因应指出像素/尺寸（实际：$bomb）")
    }

    @Test
    fun `大小上限边界：恰好等于上限放行，超过一字节拒绝`() {
        val pdf = "%PDF-1.7\n".toByteArray() + ByteArray(990) { 0x20 }
        val exact = pdf.size.toLong()
        val atLimit = AttachmentValidator.validateFile("a.pdf", "application/pdf", pdf, AttachmentLimits(maxFileBytes = exact))
        assertIs<AttachmentVerdict.Accepted>(atLimit, "恰好等于大小上限必须放行，否则边界语义是错的")

        val overLimit = AttachmentValidator.validateFile("a.pdf", "application/pdf", pdf, AttachmentLimits(maxFileBytes = exact - 1))
        val reason = assertIs<AttachmentVerdict.Rejected>(overLimit, "超过大小上限一字节也必须拒绝，否则上限形同虚设").reason
        assertTrue(reason.contains("上限"), "拒绝原因应指出上限（实际：$reason）")
    }

    @Test
    fun `损坏与截断图片在闸口被拒`() {
        val truncatedPng = MediaFixtures.png(8, 8).let { it.copyOfRange(0, it.size - 20) }
        assertTrue(
            rejectedImage(bytes = truncatedPng, label = "截断 PNG").isNotBlank(),
            "截断 PNG：必须给出明确拒绝原因",
        )
        val truncatedJpeg = MediaFixtures.jpeg(withEoi = false)
        assertTrue(
            rejectedImage(declaredMime = "image/jpeg", bytes = truncatedJpeg, label = "截断 JPEG").isNotBlank(),
            "截断 JPEG：必须给出明确拒绝原因",
        )
    }

    @Test
    fun `通用文件通道拒绝空文件与未知二进制`() {
        assertTrue(
            rejectedImage(bytes = ByteArray(0), label = "空文件").isNotBlank(),
            "空文件：必须拒绝",
        )
        val unknown = ByteArray(16) { (it * 31).toByte() }
        val verdict = AttachmentValidator.validateFile("a.bin", "application/pdf", unknown)
        assertIs<AttachmentVerdict.Rejected>(verdict, "未知二进制不得进 blob store")
    }
}
