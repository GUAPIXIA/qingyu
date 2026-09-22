package com.qingyu.companion.media

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * 同步引用纪律（S6-02：「同步只传加密 blob，不传 content://、绝对路径或 PC /static URL」；
 * 总方案 §6.2：payload 上限 2 MiB）。
 */
class SyncAttachmentPolicyTest {

    private val goodHash = ContentHashing.sha256Hex(MediaFixtures.png(4, 4))
    private val goodToken = SyncAttachmentPolicy.tokenOf(goodHash)

    @Test
    fun `blob 引用是唯一合法形态`() {
        val verdict = assertIs<SyncAttachmentPolicy.RefVerdict.Ok>(
            SyncAttachmentPolicy.validateRef(goodToken),
            "合法 blob 引用被拒：同步会全线失败",
        )
        assertEquals(goodHash, verdict.hash, "解析出的 hash 必须与 token 一致")
        assertEquals(goodToken, AttachmentRef(blobHash = goodHash, mime = "image/png", byteSize = 1).syncToken(),
            "syncToken 必须与校验器同一形态，否则发出的引用自己都过不了闸")
    }

    @Test
    fun `禁止的引用形状表驱动：content 引用、绝对路径、盘符、static URL、穿越一律拒绝`() {
        val cases = listOf(
            "content://com.android.providers.media.documents/document/image%3A1234",
            "file:///data/user/0/com.qingyu.companion/files/a.png",
            "/data/user/0/com.qingyu.companion/files/a.png",
            "/storage/emulated/0/DCIM/a.png",
            "C:\\Users\\someone\\Pictures\\a.png",
            "\\\\server\\share\\a.png",
            "http://192.168.1.5:8321/static/avatar.png",
            "https://pc.local/static/img/1.png",
            "..\\..\\secret.png",
            "../secret.png",
            "data:image/png;base64,iVBORw0KGgo=",
            "blob:sha256:not-a-hash",
            "blob:sha256:" + goodHash.uppercase(),
            "images/a.png",
            "",
        )
        for (token in cases) {
            val verdict = assertIs<SyncAttachmentPolicy.RefVerdict.Rejected>(
                SyncAttachmentPolicy.validateRef(token),
                "引用「$token」不得通过同步闸口：content://、本机路径或 PC /static URL 泄露到同步通道后，对端永远解不开还会泄露本机布局",
            )
            assertTrue(verdict.reason.isNotBlank(), "引用「$token」：拒绝原因不能为空")
        }
    }

    @Test
    fun `批量 scrub 不挑食：一条非法即整批不合格`() {
        val verdicts = SyncAttachmentPolicy.scrubRefs(listOf(goodToken, "content://media/1"))
        assertTrue(
            verdicts.any { it is SyncAttachmentPolicy.RefVerdict.Rejected },
            "混入 content:// 的批次必须留下拒绝记录，否则脏引用会静默上行",
        )
        assertEquals(2, verdicts.size, "每个引用都要有判定，不许静默丢弃")
    }

    @Test
    fun `2MiB payload 上限边界：等于上限可内联，超过一字节必须走 blob`() {
        val limit = SyncAttachmentPolicy.MAX_PAYLOAD_BYTES
        assertEquals(2L * 1024 * 1024, limit, "payload 上限必须是总方案 §6.2 的 2 MiB")
        assertFalse(
            SyncAttachmentPolicy.requiresBlob(limit),
            "恰好 2 MiB 的二进制应可内联（边界值属于允许侧），否则上限语义错位",
        )
        assertTrue(
            SyncAttachmentPolicy.requiresBlob(limit + 1),
            "超过 2 MiB 一字节也必须走 blob 传输：payload 解密后超限会被同步层直接拒收，整条实体同步失败",
        )
        assertFalse(
            SyncAttachmentPolicy.requiresBlob(limit - 1),
            "上限以下必须允许内联，否则小图全部绕道 blob，流量翻倍",
        )
    }
}
