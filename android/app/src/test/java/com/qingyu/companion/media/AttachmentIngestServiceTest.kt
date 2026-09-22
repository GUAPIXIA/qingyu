package com.qingyu.companion.media

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.rules.TemporaryFolder

/**
 * 附件导入编排（S6-02 主线）：先验后写、EXIF 默认剥离、保留方向必重编码、缩略图必产、内容寻址去重。
 *
 * 用假 [ImageCodec] 把「解码器行为」从断言里摘出去：本文件测的是**管线纪律**——
 * 任何一步失败都不许在 blob store 留下字节。
 */
class AttachmentIngestServiceTest {

    @get:Rule
    val temp: TemporaryFolder = TemporaryFolder()

    private class FakeCodec(
        var probeResult: ImageProbe? = ImageProbe(32, 32, MagicBytes.MIME_PNG),
        var thumbResult: Thumbnail? = Thumbnail(ByteArray(8) { 9 }, MagicBytes.MIME_JPEG, 16, 16),
        var reencodeBytes: ByteArray? = ByteArray(8) { 7 },
    ) : ImageCodec {
        val reencodeCalls = mutableListOf<OrientationTransform>()

        override fun probe(bytes: ByteArray): ImageProbe? = probeResult
        override fun thumbnail(bytes: ByteArray, spec: ThumbnailSpec): Thumbnail? = thumbResult
        override fun reencodeWithOrientation(bytes: ByteArray, transform: OrientationTransform): ByteArray? {
            reencodeCalls += transform
            return reencodeBytes
        }
    }

    private val codec = FakeCodec()
    private val storeRoot = File(temp.root, "store")
    private val store = ContentBlobStore(storeRoot)
    private val service = AttachmentIngestService(store, codec)

    private fun storedObjectCount(): Int =
        File(storeRoot, "objects").walkTopDown().count { it.isFile }

    private val jpegWithExif = MediaFixtures.jpeg(
        width = 32, height = 32,
        app1 = MediaFixtures.exifApp1Payload(orientation = 6, withGpsTag = true),
    )

    @Test
    fun `图片导入全链路：EXIF 默认剥离 + 缩略图 + 双 blob 内容寻址`() {
        val outcome = service.importImage("照片.jpg", "image/jpeg", jpegWithExif)
        val imported = assertIs<AttachmentIngestService.ImportOutcome.Imported>(outcome, "合法图片导入失败：附件功能不可用")
        val ref = imported.ref
        assertEquals(2, storedObjectCount(), "必须写入原图 + 缩略图两份 blob（内容寻址）")
        assertTrue(ref.thumbnailHash != null, "缩略图引用缺失：消息列表会去加载原图，滚动性能崩掉")

        val stored = assertNotNull(store.read(ref.blobHash), "原图 blob 必须可读回")
        val text = String(stored, Charsets.ISO_8859_1)
        assertTrue(!text.contains("Exif"), "EXIF 默认剥离失败：GPS 会随同步泄露到其他设备")
        assertTrue(stored.size < jpegWithExif.size, "剥离后字节数必须变小，否则 EXIF 没被真正剥掉")
    }

    @Test
    fun `保留方向必须走解码重编码，产物不含任何 EXIF`() {
        val outcome = service.importImage(
            "照片.jpg", "image/jpeg", jpegWithExif,
            handling = ExifHandling.KEEP_ORIENTATION_THEN_REENCODE,
        )
        val imported = assertIs<AttachmentIngestService.ImportOutcome.Imported>(outcome, "保留方向导入失败")
        assertEquals(1, codec.reencodeCalls.size, "保留方向必须触发一次解码重编码")
        assertEquals(
            OrientationTransform(rotationDegrees = 90, flipHorizontal = false),
            codec.reencodeCalls[0],
            "方向 6 必须映射为顺时针 90°：竖拍照片会横着显示",
        )
        val stored = assertNotNull(store.read(imported.ref.blobHash), "重编码产物必须可读回")
        assertTrue(stored.contentEquals(codec.reencodeBytes), "落盘必须是重编码产物，而不是「留个 Orientation 标签」的原字节")
    }

    @Test
    fun `无方向信息时保留方向退化为无损剥离（不白白重编码损画质）`() {
        val outcome = service.importImage(
            "a.jpg", "image/jpeg", MediaFixtures.jpeg(width = 32, height = 32),
            handling = ExifHandling.KEEP_ORIENTATION_THEN_REENCODE,
        )
        assertIs<AttachmentIngestService.ImportOutcome.Imported>(outcome, "无方向 JPEG 导入失败")
        assertTrue(codec.reencodeCalls.isEmpty(), "没有方向信息不得触发重编码：重编码必有画质损失")
    }

    @Test
    fun `解码探测失败：拒绝且 blob store 一个字节都不许有`() {
        codec.probeResult = null
        val outcome = service.importImage("a.png", "image/png", MediaFixtures.png(8, 8))
        val rejected = assertIs<AttachmentIngestService.ImportOutcome.Rejected>(outcome, "损坏图片必须被拒")
        assertTrue(rejected.reason.contains("解码"), "拒绝原因应指出无法解码（实际：${rejected.reason}）")
        assertEquals(0, storedObjectCount(), "拒绝的输入却写了盘：恶意图片进 blob store 了")
    }

    @Test
    fun `缩略图失败：拒绝且不写任何字节（半套产物等于脏数据）`() {
        codec.thumbResult = null
        val outcome = service.importImage("a.png", "image/png", MediaFixtures.png(8, 8))
        assertIs<AttachmentIngestService.ImportOutcome.Rejected>(outcome, "缩略图失败必须拒绝导入")
        assertEquals(0, storedObjectCount(), "缩略图失败却写了原图：引用与缩略图会永远对不上")
    }

    @Test
    fun `解码器报出的超大像素同样拦截（解压炸弹双保险）`() {
        codec.probeResult = ImageProbe(9000, 9000, MagicBytes.MIME_PNG)
        val outcome = service.importImage("a.png", "image/png", MediaFixtures.png(8, 8))
        val rejected = assertIs<AttachmentIngestService.ImportOutcome.Rejected>(outcome, "解压炸弹必须被拦截")
        assertTrue(rejected.reason.contains("尺寸") || rejected.reason.contains("像素"), "拒绝原因应指出尺寸/像素（实际：${rejected.reason}）")
        assertEquals(0, storedObjectCount(), "解压炸弹却写了盘")
    }

    @Test
    fun `恶意输入表驱动：伪 MIME、路径穿越、截断、解压炸弹一律不落盘`() {
        val cases: List<Triple<String?, String?, ByteArray>> = listOf(
            Triple("a.png", "image/jpeg", MediaFixtures.png(8, 8)),
            Triple("../../etc/passwd", "image/png", MediaFixtures.png(8, 8)),
            Triple("a.png", "image/png", MediaFixtures.png(8, 8).let { it.copyOfRange(0, it.size - 20) }),
            Triple("a.png", "image/png", MediaFixtures.png(46340, 46340)),
            Triple("a.png", "image/png", "<html>x</html>".toByteArray()),
            Triple("a.png", "image/png", ByteArray(0)),
        )
        for ((name, mime, bytes) in cases) {
            val outcome = service.importImage(name, mime, bytes)
            assertIs<AttachmentIngestService.ImportOutcome.Rejected>(outcome, "「$name/$mime」恶意输入必须被拒")
            assertEquals(0, storedObjectCount(), "「$name/$mime」被拒却写了盘：恶意内容进 blob store 了")
        }
    }

    @Test
    fun `重复导入命中内容去重`() {
        val first = assertIs<AttachmentIngestService.ImportOutcome.Imported>(
            service.importImage("a.jpg", "image/jpeg", jpegWithExif),
            "首次导入失败",
        )
        val second = assertIs<AttachmentIngestService.ImportOutcome.Imported>(
            service.importImage("b.jpg", "image/jpeg", jpegWithExif.copyOf()),
            "重复导入失败",
        )
        assertEquals(first.ref.blobHash, second.ref.blobHash, "同内容必须同地址，否则去重失效")
        assertTrue(second.deduplicated, "重复导入必须命中去重")
    }

    @Test
    fun `通用文件走文件通道，图片被强制分流回图片通道`() {
        val pdf = "%PDF-1.7\n%binary".toByteArray() + ByteArray(64) { 0x11 }
        val fileOutcome = service.importFile("doc.pdf", "application/pdf", pdf)
        val fileRef = assertIs<AttachmentIngestService.ImportOutcome.Imported>(fileOutcome, "PDF 导入失败").ref
        assertNull(fileRef.thumbnailHash, "非图片附件不生成缩略图")
        assertEquals("doc.pdf", fileRef.fileName, "展示名必须保留（已过文件名安全判定）")

        val routed = service.importFile("x.png", "image/png", MediaFixtures.png(8, 8))
        assertIs<AttachmentIngestService.ImportOutcome.Rejected>(routed, "图片必须走图片通道：否则绕过缩略图与 EXIF 处理")

        val anyImage = assertIs<AttachmentIngestService.ImportOutcome.Imported>(
            service.importAny("x.png", "image/png", MediaFixtures.png(8, 8)),
            "importAny 对图片必须分流到图片通道",
        )
        assertTrue(anyImage.ref.thumbnailHash != null, "importAny 的图片产物必须带缩略图")
        val anyFile = assertIs<AttachmentIngestService.ImportOutcome.Imported>(
            service.importAny("doc.pdf", "application/pdf", pdf),
            "importAny 对文件必须分流到文件通道",
        )
        assertNull(anyFile.ref.thumbnailHash, "importAny 的文件产物不该有缩略图")
    }
}
