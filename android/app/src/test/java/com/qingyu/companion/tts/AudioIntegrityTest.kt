package com.qingyu.companion.tts

import org.junit.Test
import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 损坏音频输入拦截（阶段 6 §3 矩阵）：魔数嗅探 + 大小边界，
 * 截断/乱码/伪音频必须拦在解码器之前。
 */
class AudioIntegrityTest {

    @Test
    fun `损坏音频拒绝-未知魔数`() {
        val check = AudioIntegrity.verify(corruptAudio(), corruptAudio().size.toLong())

        assertTrue(check is AudioCheck.Rejected, "无法识别魔数的音频必须拒绝，伪音频喂给解码器会爆音甚至崩溃")
    }

    @Test
    fun `损坏音频拒绝-空文件与截断头`() {
        assertTrue(AudioIntegrity.verify(ByteArray(0), 0) is AudioCheck.Rejected, "空文件必须拒绝")
        val truncated = AudioIntegrity.verify("RIFF".toByteArray(), 4)
        assertTrue(truncated is AudioCheck.Rejected, "只有 4 字节的截断头必须拒绝，不能当成合法 WAV")
    }

    @Test
    fun `合法音频头放行-WAV-MP3-OGG-FLAC-M4A-AAC`() {
        val cases = listOf(
            "WAV" to wavLikeAudio(),
            "MP3" to mp3LikeAudio(),
            "OGG" to oggLikeAudio(),
            "FLAC" to flacLikeAudio(),
            "M4A" to m4aLikeAudio(),
            "AAC" to aacLikeAudio(),
        )
        for ((name, bytes) in cases) {
            val check = AudioIntegrity.verify(bytes, bytes.size.toLong())
            assertTrue(check is AudioCheck.Ok, "$name 是合法音频容器，误拦会让用户听不到朗读")
        }
    }

    @Test
    fun `超大音频拒绝-保护低存储`() {
        val check = AudioIntegrity.verify(wavLikeAudio(64), AudioIntegrity.MAX_BYTES + 1)

        assertTrue(check is AudioCheck.Rejected, "超限音频必须拒绝，否则会把用户存储写满")
    }

    @Test
    fun `文件级校验拦截损坏文件`() {
        val dir = Files.createTempDirectory("tts-integrity-test").toFile()
        try {
            val good = dir.resolve("good.audio").apply { writeBytes(wavLikeAudio()) }
            val bad = dir.resolve("bad.audio").apply { writeBytes(corruptAudio()) }

            assertTrue(AudioIntegrity.verifyFile(good) is AudioCheck.Ok, "合法音频文件必须放行")
            val badCheck = AudioIntegrity.verifyFile(bad)
            assertTrue(badCheck is AudioCheck.Rejected, "损坏音频文件必须拦截")
            assertEquals(false, AudioIntegrity.verifyFile(dir.resolve("missing.audio")) is AudioCheck.Ok, "不存在的文件必须拒绝")
        } finally {
            dir.deleteRecursively()
        }
    }

    private fun flacLikeAudio(size: Int = 256): ByteArray {
        val bytes = ByteArray(size)
        "fLaC".toByteArray(Charsets.US_ASCII).copyInto(bytes, 0)
        return bytes
    }

    private fun m4aLikeAudio(size: Int = 256): ByteArray {
        val bytes = ByteArray(size)
        "ftyp".toByteArray(Charsets.US_ASCII).copyInto(bytes, 4)
        return bytes
    }

    private fun aacLikeAudio(size: Int = 256): ByteArray {
        val bytes = ByteArray(size)
        bytes[0] = 0xFF.toByte()
        bytes[1] = 0xF1.toByte() // ADTS：layer 位全 0
        return bytes
    }
}
