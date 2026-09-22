package com.qingyu.companion.updater

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * S6-07 更新包校验单测（红线）：
 * - hash 校验失败必须拒绝安装；
 * - 缺失可信 checksum 必须拒绝（fail closed）；
 * - 损坏更新包（非 APK/ZIP 形态、截断）必须拒绝。
 */
class UpdateVerifierTest {

    private lateinit var tempDir: File

    @Before
    fun setUp() {
        tempDir = Files.createTempDirectory("qy-updater-test").toFile()
    }

    @After
    fun tearDown() {
        tempDir.deleteRecursively()
    }

    private fun validZipBytes(): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            zip.putNextEntry(ZipEntry("classes.dex"))
            zip.write(byteArrayOf(1, 2, 3, 4))
            zip.closeEntry()
        }
        return out.toByteArray()
    }

    @Test
    fun `hash校验失败必须拒绝安装否则任意文件可冒充更新包`() {
        val apk = validZipBytes()
        val wrongExpected = UpdateVerifier.sha256("something else".toByteArray())
        val result = UpdateVerifier.verifyBytes(apk, wrongExpected)
        assertTrue(
            "hash 不符却放行，任意文件都能冒充更新包送进安装（红线）",
            result is VerificationResult.HashMismatch,
        )
        val mismatch = result as VerificationResult.HashMismatch
        assertEquals("期望哈希记录错位会导致排障误判", wrongExpected, mismatch.expected)
        assertEquals("实测哈希记录错位会导致排障误判", UpdateVerifier.sha256(apk), mismatch.actual)
    }

    @Test
    fun `缺失可信checksum必须拒绝安装`() {
        val apk = validZipBytes()
        assertTrue("缺失 checksum 不能安装，下载链路可被中间人替换", UpdateVerifier.verifyBytes(apk, null) is VerificationResult.MissingChecksum)
        assertTrue("空白 checksum 视同缺失", UpdateVerifier.verifyBytes(apk, "  ") is VerificationResult.MissingChecksum)
        assertTrue("文件形态同样执行缺失校验", UpdateVerifier.verifyFile(File(tempDir, "none.apk"), null) is VerificationResult.MissingChecksum)
    }

    @Test
    fun `损坏更新包必须拒绝安装`() {
        val garbage = "corrupt-package-not-a-zip-at-all".repeat(4)
        val expected = UpdateVerifier.sha256(garbage.toByteArray())
        val result = UpdateVerifier.verifyBytes(garbage.toByteArray(), expected)
        assertTrue(
            "哈希对但包本体损坏（非 APK 形态）仍放行，会把坏包送进安装器",
            result is VerificationResult.Corrupt,
        )
    }

    @Test
    fun `截断的更新包必须拒绝安装`() {
        val full = validZipBytes()
        val truncated = full.copyOf(full.size - 30) // 掐掉 EOCD 结构尾
        val expected = UpdateVerifier.sha256(truncated)
        val result = UpdateVerifier.verifyBytes(truncated, expected)
        assertTrue("下载中断截断的包会装成半砖，必须拒绝", result is VerificationResult.Corrupt)
    }

    @Test
    fun `zip头损坏的更新包必须拒绝安装`() {
        val full = validZipBytes()
        val brokenHead = full.copyOf().also { it[0] = 0x00 }
        val expected = UpdateVerifier.sha256(brokenHead)
        val result = UpdateVerifier.verifyBytes(brokenHead, expected)
        assertTrue("包头魔数损坏的包不是合法 APK，必须拒绝", result is VerificationResult.Corrupt)
    }

    @Test
    fun `合法zip且hash正确才放行`() {
        val apk = validZipBytes()
        val expected = UpdateVerifier.sha256(apk)
        val result = UpdateVerifier.verifyBytes(apk, expected)
        assertTrue("合法更新包被误拒会让用户永远无法升级", result is VerificationResult.Ok)
        assertEquals("放行结果应带实测哈希供安装前对账", expected, (result as VerificationResult.Ok).actualSha256)
    }

    @Test
    fun `文件形态校验与内存形态一致`() {
        val apk = validZipBytes()
        val file = File(tempDir, "update.apk")
        file.writeBytes(apk)
        val expected = UpdateVerifier.sha256(apk)
        assertTrue("文件形态合法包应放行", UpdateVerifier.verifyFile(file, expected) is VerificationResult.Ok)
        assertTrue(
            "文件形态 hash 不符应拒绝",
            UpdateVerifier.verifyFile(file, UpdateVerifier.sha256("other".toByteArray())) is VerificationResult.HashMismatch,
        )
        assertTrue(
            "文件形态 hash 不符后不得再送安装",
            UpdateVerifier.verifyFile(file, "0".repeat(64)) is VerificationResult.HashMismatch,
        )
    }

    @Test
    fun `过小的文件直接判损坏`() {
        val tiny = File(tempDir, "tiny.apk")
        tiny.writeBytes(byteArrayOf(0x50, 0x4B, 0x05))
        val expected = UpdateVerifier.sha256(tiny.readBytes())
        val result = UpdateVerifier.verifyFile(tiny, expected)
        assertTrue("几字节的残包不可能是 APK，必须拒绝", result is VerificationResult.Corrupt)
        assertEquals("损坏原因键被改动会让 UI 无法提示", "too_small", (result as VerificationResult.Corrupt).reason)
    }

    @Test
    fun `sha256计算稳定且与JDK一致`() {
        val data = "qingyu".toByteArray()
        val expected = java.security.MessageDigest.getInstance("SHA-256")
            .digest(data)
            .joinToString("") { "%02x".format(it) }
        assertEquals("哈希实现与 JDK 不一致会让校验全部失效", expected, UpdateVerifier.sha256(data))
        assertFalse("空输入也不该抛错崩溃", UpdateVerifier.sha256(ByteArray(0)).isEmpty())
    }
}
