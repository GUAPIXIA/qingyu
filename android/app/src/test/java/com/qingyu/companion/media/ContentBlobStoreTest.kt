package com.qingyu.companion.media

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.rules.TemporaryFolder

/**
 * 内容寻址 blob store：hash 寻址、去重、私有目录、键不可穿越。
 * （S6-02：「原图进入内容寻址私有 blob store（内容 hash 寻址、去重、私有目录）」）
 */
class ContentBlobStoreTest {

    @get:Rule
    val temp: TemporaryFolder = TemporaryFolder()

    private fun store(): ContentBlobStore = ContentBlobStore(File(temp.root, "blobs"))

    @Test
    fun `内容寻址与去重：同字节同 hash 只存一份`() {
        val subject = store()
        val bytes = MediaFixtures.png(4, 4)
        val first = assertNotNull(subject.put(bytes), "写入失败：blob store 不可用")
        val second = assertNotNull(subject.put(bytes.copyOf()), "同内容重复写入失败")
        assertEquals(first.hash, second.hash, "内容寻址必须由字节决定，否则去重失效、手机存储被同一只猫塞满")
        assertTrue(second.reused, "同内容必须命中去重，而不是再存一份")
        assertTrue(bytes.contentEquals(subject.read(first.hash)), "读回内容必须与写入逐字节一致")

        val other = assertNotNull(subject.put(MediaFixtures.png(5, 5)), "写入失败")
        assertTrue(other.hash != first.hash, "不同内容不得撞同一地址")
    }

    @Test
    fun `键格式即防线：路径穿越与非法键碰不到任何文件`() {
        val subject = store()
        val stored = assertNotNull(subject.put(MediaFixtures.png(4, 4)), "写入失败")
        // 私有目录外放一个哨兵文件：任何穿越尝试都不得碰到它
        val sentinel = File(temp.root, "sentinel.txt")
        sentinel.writeText("do not touch")
        val evilKeys = listOf(
            "../../sentinel.txt",
            "../blobs/objects/${stored.hash}",
            "..",
            "/etc/passwd",
            "C:\\evil",
            "",
            stored.hash.uppercase(), // 大写不是合法键（规范是小写十六进制）
            stored.hash + ".png",
            "zz" + stored.hash.substring(2),
            stored.hash.substring(1), // 长度不对
        )
        for (key in evilKeys) {
            assertNull(subject.read(key), "非法键「$key」不得读出内容：路径穿越会泄露私有目录之外的文件")
            assertFalse(subject.has(key), "非法键「$key」不得被判定存在")
            assertFalse(subject.delete(key), "非法键「$key」不得触发删除")
        }
        assertTrue(sentinel.readText() == "do not touch", "越权读写/删除不得影响私有目录外的任何文件")
        assertTrue(bytes4x4StillReadable(subject, stored.hash), "非法键检查不得误伤合法内容")
    }

    private fun bytes4x4StillReadable(subject: ContentBlobStore, hash: String): Boolean =
        subject.has(hash)

    @Test
    fun `删除只影响目标 blob`() {
        val subject = store()
        val a = assertNotNull(subject.put(MediaFixtures.png(4, 4)), "写入失败")
        val b = assertNotNull(subject.put(MediaFixtures.png(6, 6)), "写入失败")
        assertTrue(subject.delete(a.hash), "删除合法 blob 必须成功")
        assertNull(subject.read(a.hash), "删除后必须读不到")
        assertTrue(subject.has(b.hash), "删除不得殃及相邻 blob")
    }

    @Test
    fun `写入是原子的：不留 ．tmp 半成品`() {
        val subject = store()
        assertNotNull(subject.put(MediaFixtures.png(4, 4)), "写入失败")
        assertNotNull(subject.put(MediaFixtures.png(5, 5)), "写入失败")
        val tmpDir = File(temp.root, "blobs/tmp")
        val leftovers = tmpDir.listFiles().orEmpty().filter { it.name.endsWith(".tmp") }
        assertTrue(leftovers.isEmpty(), "临时文件未清理：崩溃恢复时会被误当成有效 blob")
    }

    @Test
    fun `空内容拒绝写入（占地址不放内容的攻击形状）`() {
        val subject = store()
        assertNull(subject.put(ByteArray(0)), "空内容不得占一个 blob 地址")
    }
}
