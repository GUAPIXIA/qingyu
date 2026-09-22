package com.qingyu.companion.media

import android.net.Uri
import java.io.ByteArrayInputStream
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * SAF 读取胶水：`content://` → 字节，且**读取时**就按上限封顶
 * （S6-02：「使用 SAF 选择图片，读取时校验……大小」）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class SafAttachmentSourceTest {

    private val uri: Uri = Uri.parse("content://com.example.provider/document/42")

    private fun source(stream: ByteArrayInputStream): SafAttachmentSource {
        val resolver = RuntimeEnvironment.getApplication().contentResolver
        shadowOf(resolver).registerInputStream(uri, stream)
        return SafAttachmentSource(resolver)
    }

    @Test
    fun 读取SAF来源并保留字节() {
        val bytes = MediaFixtures.png(8, 8)
        val outcome = source(ByteArrayInputStream(bytes)).read(uri, maxBytes = 1024 * 1024)
        val ok = assertIs<CappedByteReader.Result.Ok>(outcome, "SAF 读取失败：附件选择全线不可用")
        assertTrue(bytes.contentEquals(ok.bytes), "读出的字节必须与来源逐字节一致")
    }

    @Test
    fun 超限来源在读取阶段被拒() {
        val huge = ByteArray(4096) { 1 }
        val outcome = source(ByteArrayInputStream(huge)).read(uri, maxBytes = 1024)
        val rejected = assertIs<CappedByteReader.Result.Rejected>(outcome, "超限来源必须在读取阶段被拒，不能先读完再检查")
        assertTrue(rejected.reason.contains("上限"), "拒绝原因应指出上限（实际：${rejected.reason}）")
    }

    @Test
    fun 空来源拒绝() {
        val outcome = source(ByteArrayInputStream(ByteArray(0))).read(uri, maxBytes = 1024)
        assertIs<CappedByteReader.Result.Rejected>(outcome, "空来源必须拒绝：空附件不该生成 blob")
    }
}
