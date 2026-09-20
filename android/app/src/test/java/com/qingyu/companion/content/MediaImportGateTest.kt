package com.qingyu.companion.content

import android.graphics.Bitmap
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 5 S5-01：媒体导入闸口的测试。
 *
 * 核心断言只有一句话：**没通过解码验证的字节，绝不能出现在私有目录里**。
 * 这条是方案明文要求，也是导入类功能最常见的「看起来成功了」故障源。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class MediaImportGateTest {

    @get:Rule
    val temp: TemporaryFolder = TemporaryFolder()

    /** 可控解码器：让「尺寸过大」「无法解码」这些分支不依赖真实图片资源。 */
    private class FakeDecoder(
        var info: MediaImportGate.ImageInfo? = MediaImportGate.ImageInfo(64, 64, "image/png"),
    ) : MediaImportGate.Decoder {
        override fun probe(bytes: ByteArray): MediaImportGate.ImageInfo? = info
        override fun decode(bytes: ByteArray): Bitmap? = null
    }

    private fun gate(decoder: MediaImportGate.Decoder = FakeDecoder(), limits: MediaImportGate.Limits = MediaImportGate.Limits()) =
        MediaImportGate(File(temp.root, "media"), decoder, limits)

    private fun png() = java.util.Base64.getMimeDecoder().decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    )

    @Test
    fun acceptsDecodableImageAndStoresItContentAddressed() {
        val subject = gate()
        subject.beginBatch()
        val outcome = subject.accept("character-avatar", "avatar.png", png())
        val accepted = assertIs<MediaImportGate.Outcome.Accepted>(outcome)
        assertTrue(accepted.relPath.startsWith("character-avatar/"))
        assertTrue(accepted.bytes > 0)
        // 内容寻址：同一字节重复导入必须复用而不是再存一份
        val again = subject.accept("character-avatar", "avatar-copy.png", png())
        val reused = assertIs<MediaImportGate.Outcome.Accepted>(again)
        assertEquals(accepted.relPath, reused.relPath)
        assertTrue(reused.reused, "同一内容应命中复用")
        assertNotNull(subject.read(accepted.relPath))
    }

    @Test
    fun refusesToWriteWhenDecodeProbeFails() {
        val decoder = FakeDecoder(info = null)
        val subject = gate(decoder)
        subject.beginBatch()
        val outcome = subject.accept("character-avatar", "broken.png", png())
        assertIs<MediaImportGate.Outcome.Rejected>(outcome)

        // 这才是本用例存在的理由：目录里不能留下任何文件
        val folder = File(temp.root, "media/character-avatar")
        assertTrue(!folder.exists() || folder.list().orEmpty().isEmpty(), "解码失败却留下了文件")
    }

    @Test
    fun refusesBytesThatCarryNoImageSignature() {
        val subject = gate()
        subject.beginBatch()
        // 改名为 .png 的 HTML：魔数不是图片，必须在解码之前就被挡下，
        // 且不因为 detectMimeType 的「未知回落 image/png」而蒙混过关。
        val html = "<html><body>not an image</body></html>".toByteArray()
        assertIs<MediaImportGate.Outcome.Rejected>(subject.accept("character-avatar", "fake.png", html))

        // 真实 GIF 头则应被认出来（这里只验证签名判定，不验证解码）
        val gifHeader = "GIF89a".toByteArray() + ByteArray(200)
        assertIs<MediaImportGate.Outcome.Accepted>(subject.accept("character-avatar", "real.gif", gifHeader))
    }

    @Test
    fun refusesOversizedDimensionsBeforeWriting() {
        val decoder = FakeDecoder(info = MediaImportGate.ImageInfo(8192, 8192, "image/png"))
        val subject = gate(decoder)
        subject.beginBatch()
        assertIs<MediaImportGate.Outcome.Rejected>(subject.accept("character-avatar", "huge.png", png()))
    }

    @Test
    fun refusesPixelCountOverLimitEvenWhenEachSideIsFine() {
        // 800x8000 单边都不超 4096？第二边超了。用 4000x4000 测「边内但像素总量爆表」这一类，
        // 它是最容易只校验单边而漏掉的形状。
        val decoder = FakeDecoder(info = MediaImportGate.ImageInfo(4000, 4000, "image/png"))
        val subject = gate(decoder, MediaImportGate.Limits(maxPixelCount = 2_000_000))
        subject.beginBatch()
        assertIs<MediaImportGate.Outcome.Rejected>(subject.accept("character-avatar", "square.png", png()))
    }

    @Test
    fun enforcesPerFileSizeLimit() {
        val subject = gate(limits = MediaImportGate.Limits(maxBytesPerFile = 8))
        subject.beginBatch()
        val outcome = subject.accept("character-avatar", "big.png", png())
        assertIs<MediaImportGate.Outcome.Rejected>(outcome)
        assertTrue(outcome.reason.contains("MiB") || outcome.reason.contains("超过"), "应说明是单文件上限：${outcome.reason}")
    }

    @Test
    fun enforcesPerBatchFileCountLimit() {
        val subject = gate(limits = MediaImportGate.Limits(maxFilesPerBatch = 1))
        subject.beginBatch()
        assertIs<MediaImportGate.Outcome.Accepted>(subject.accept("character-avatar", "one.png", png()))
        // 第二张内容不同（不会被内容寻址复用），必须被「一批几个文件」挡住
        assertIs<MediaImportGate.Outcome.Rejected>(subject.accept("character-avatar", "two.png", png() + byteArrayOf(0)))
    }

    @Test
    fun enforcesPerBatchTotalBytesLimit() {
        val size = png().size.toLong()
        val subject = gate(limits = MediaImportGate.Limits(maxTotalBytesPerBatch = size + 4))
        subject.beginBatch()
        assertIs<MediaImportGate.Outcome.Accepted>(subject.accept("character-avatar", "one.png", png()))
        assertIs<MediaImportGate.Outcome.Rejected>(subject.accept("character-avatar", "two.png", png() + byteArrayOf(0)))
    }

    @Test
    fun beginBatchResetsTheBatchQuota() {
        val size = png().size.toLong()
        val subject = gate(limits = MediaImportGate.Limits(maxTotalBytesPerBatch = size + 4, maxFilesPerBatch = 1))
        subject.beginBatch()
        assertIs<MediaImportGate.Outcome.Accepted>(subject.accept("character-avatar", "one.png", png()))
        assertIs<MediaImportGate.Outcome.Rejected>(subject.accept("character-avatar", "two.png", png() + byteArrayOf(0)))
        subject.beginBatch()
        assertIs<MediaImportGate.Outcome.Accepted>(subject.accept("character-avatar", "three.png", png() + byteArrayOf(1)))
    }

    @Test
    fun rejectsUnknownKindAndEmptyPayload() {
        val subject = gate()
        subject.beginBatch()
        assertIs<MediaImportGate.Outcome.Rejected>(subject.accept("secrets", "x.png", png()))
        assertIs<MediaImportGate.Outcome.Rejected>(subject.accept("character-avatar", "empty.png", ByteArray(0)))
    }

    @Test
    fun readRefusesPathEscapeEvenIfReferenceCameFromDatabase() {
        val subject = gate()
        // 库里存的引用可能是被篡改/被导入污染的，读的时候仍要按同一套路径规则约束
        assertNull(subject.read("../../outside.json"))
        assertNull(subject.read("/etc/passwd"))
        assertNull(subject.read(""))
        assertNull(subject.read(null))
    }

    @Test
    fun deleteIgnoresEscapingPathsButRemovesRealFiles() {
        val subject = gate()
        subject.beginBatch()
        val accepted = assertIs<MediaImportGate.Outcome.Accepted>(subject.accept("character-avatar", "x.png", png()))
        assertNotNull(subject.read(accepted.relPath))
        subject.delete("../../etc/passwd")
        assertNotNull(subject.read(accepted.relPath), "越权删除请求不该影响任何文件")
        subject.delete(accepted.relPath)
        assertNull(subject.read(accepted.relPath))
    }
}
