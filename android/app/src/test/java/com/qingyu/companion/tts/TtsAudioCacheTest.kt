package com.qingyu.companion.tts

import org.junit.After
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * TTS 音频缓存：缓存键稳定性、损坏拒绝入库、损坏缓存按未命中清理，
 * 以及「默认缓存不进 media manifest/同步，仅用户显式保存升级为主数据」的归属边界。
 */
class TtsAudioCacheTest {

    private lateinit var tempDir: File
    private lateinit var cache: FileTtsAudioCache

    @Before
    fun setUp() {
        tempDir = Files.createTempDirectory("tts-audio-cache-test").toFile()
        cache = FileTtsAudioCache(tempDir)
    }

    @After
    fun tearDown() {
        tempDir.deleteRecursively()
    }

    @Test
    fun `缓存键对相同请求稳定-文本音色语速引擎任一变化即不同键`() {
        val base = speakReq(id = "a", text = "同一段文本")

        assertEquals(
            TtsCacheKeys.of(base),
            TtsCacheKeys.of(speakReq(id = "b", text = "同一段文本")),
            "同参数不同 requestId 必须同键，否则缓存永远无法命中",
        )
        assertNotEquals(
            TtsCacheKeys.of(base),
            TtsCacheKeys.of(speakReq(id = "c", text = "另一段文本")),
            "文本不同的请求必须不同键，串键会播错内容",
        )
        assertNotEquals(
            TtsCacheKeys.of(base),
            TtsCacheKeys.of(speakReq(id = "d", text = "同一段文本", voice = "other-voice")),
            "音色不同的请求必须不同键",
        )
        assertNotEquals(
            TtsCacheKeys.of(base),
            TtsCacheKeys.of(speakReq(id = "e", text = "同一段文本", speed = 1.5f)),
            "语速不同的请求必须不同键",
        )
        assertNotEquals(
            TtsCacheKeys.of(base),
            TtsCacheKeys.of(speakReq(id = "f", text = "同一段文本", engine = TtsEngineKind.NETWORK)),
            "引擎不同的请求必须不同键",
        )
    }

    @Test
    fun `合法音频入库后命中-返回同一可播放路径`() {
        val key = TtsCacheKeys.of(speakReq())

        val committed = assertNotNull(cache.commit(key, writeStaging(key, wavLikeAudio())), "合法音频必须能入库")
        assertEquals(committed, cache.find(key), "命中必须返回入库的同一文件")
    }

    @Test
    fun `损坏音频拒绝入库并清理暂存`() {
        val key = TtsCacheKeys.of(speakReq())
        val staging = writeStaging(key, corruptAudio())

        val committed = cache.commit(key, staging)

        assertNull(committed, "损坏音频必须拒绝入库，否则坏文件会反复被命中播放")
        assertNull(cache.find(key), "被拒绝的音频不得可命中")
        assertEquals(false, File(staging).exists(), "被拒绝的暂存文件必须清理，避免占满存储")
    }

    @Test
    fun `损坏缓存按未命中处理并被清理`() {
        val key = TtsCacheKeys.of(speakReq())
        val committed = assertNotNull(cache.commit(key, writeStaging(key, wavLikeAudio())), "先正常入库")
        File(committed).writeBytes(corruptAudio()) // 模拟磁盘上的缓存被写坏

        assertNull(cache.find(key), "损坏缓存必须按未命中处理，命中坏文件会把爆音喂给解码器")
        assertEquals(false, File(committed).exists(), "损坏缓存必须清理，让下一次朗读重新合成")
    }

    @Test
    fun `TTS音频默认仅缓存-不进media manifest不同步不进备份`() {
        val scope = TtsAudioPolicy.scopeFor(explicitUserSave = false)

        assertEquals(TtsAudioScope.CACHE_ONLY, scope, "TTS 音频默认必须只是派生缓存")
        assertEquals(false, TtsAudioPolicy.entersMediaManifest(scope), "缓存音频不得进 media manifest，否则派生数据会被当成用户资产同步")
        assertEquals(false, TtsAudioPolicy.participatesInUserSync(scope), "缓存音频不作为用户主数据同步")
        assertEquals(false, TtsAudioPolicy.participatesInBackup(scope), "缓存音频不进备份（可随时重新合成）")
        assertEquals(false, TtsAudioPolicy.isUserPrimaryData(scope), "缓存音频不是用户主数据")
    }

    @Test
    fun `用户显式保存的音频才进media manifest并参与同步备份`() {
        val scope = TtsAudioPolicy.scopeFor(explicitUserSave = true)

        assertEquals(TtsAudioScope.USER_SAVED, scope, "用户显式保存的音频是用户数据")
        assertEquals(true, TtsAudioPolicy.entersMediaManifest(scope), "显式保存的音频必须进 media manifest，否则用户保存动作丢失")
        assertEquals(true, TtsAudioPolicy.participatesInUserSync(scope), "显式保存的音频随用户主数据同步")
        assertEquals(true, TtsAudioPolicy.participatesInBackup(scope), "显式保存的音频进备份")
    }

    private fun writeStaging(key: TtsCacheKey, bytes: ByteArray): String {
        val path = cache.stagingPathFor(key)
        File(path).apply { parentFile?.mkdirs() }.writeBytes(bytes)
        return path
    }
}
