package com.qingyu.companion.media

import java.io.ByteArrayInputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * 读取上限（S6-02：「读取时校验……大小」）：边读边封顶，超限不进内存。
 */
class CappedByteReaderTest {

    @Test
    fun `恰好读满上限放行，多一字节拒绝`() {
        val exact = ByteArray(1024) { 1 }
        val ok = assertIs<CappedByteReader.Result.Ok>(
            CappedByteReader.read(ByteArrayInputStream(exact), 1024),
            "恰好等于读取上限必须放行，否则边界语义错位",
        )
        assertEquals(1024, ok.bytes.size, "读出的字节数必须与输入一致")

        val over = assertIs<CappedByteReader.Result.Rejected>(
            CappedByteReader.read(ByteArrayInputStream(exact), 1023),
            "超过读取上限一字节也必须拒绝，否则超大附件能撑爆内存",
        )
        assertTrue(over.reason.contains("上限"), "拒绝原因应指出上限（实际：${over.reason}）")
    }

    @Test
    fun `无限流在超限处被掐断，不读到天荒地老`() {
        // 永不结束的流：只有边读边封顶才能在有限字节内返回
        val endless = object : java.io.InputStream() {
            override fun read(): Int = 0
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                b.fill(0, off, off + len)
                return len
            }
        }
        val outcome = CappedByteReader.read(endless, 64 * 1024)
        assertIs<CappedByteReader.Result.Rejected>(outcome, "无限流必须在上限处被拒绝：否则内存先耗尽")
    }

    @Test
    fun `空流拒绝（空附件不该生成 blob）`() {
        val outcome = CappedByteReader.read(ByteArrayInputStream(ByteArray(0)), 1024)
        val rejected = assertIs<CappedByteReader.Result.Rejected>(outcome, "空输入必须拒绝")
        assertTrue(rejected.reason.contains("空"), "拒绝原因应指出为空（实际：${rejected.reason}）")
    }
}
