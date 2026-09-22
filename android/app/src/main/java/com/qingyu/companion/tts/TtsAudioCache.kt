package com.qingyu.companion.tts

import java.io.File
import java.security.MessageDigest

/**
 * S6-03 TTS 音频缓存：默认缓存、按内容寻址、入库前完整性闸门。
 *
 * - 缓存键只由**合成参数**（引擎 / 音色 / 语言 / 语速 / 文本）决定，不含 requestId：
 *   同一段文本第二次朗读必须命中缓存而**不重复合成**；
 * - 入库（[TtsAudioCache.commit]）与命中复核（[TtsAudioCache.find]）都跑 [AudioIntegrity]，
 *   损坏产物直接拦截并清理，绝不进入播放路径；
 * - 缓存属派生数据：默认**不进 media manifest、不进用户主数据同步/备份**（见 [TtsAudioPolicy]）。
 */
data class TtsCacheKey(val hex: String)

object TtsCacheKeys {
    private const val VERSION = "v1"

    /** 同参数 → 同键；任一参数变化（含文本）→ 不同键。 */
    fun of(request: SpeakRequest): TtsCacheKey {
        val material = listOf(
            VERSION,
            request.engine.wire,
            request.voiceId,
            request.localeTag.orEmpty(),
            request.speed.toString(),
            request.text,
        ).joinToString("|")
        val digest = MessageDigest.getInstance("SHA-256").digest(material.toByteArray(Charsets.UTF_8))
        return TtsCacheKey(digest.joinToString("") { "%02x".format(it) })
    }
}

interface TtsAudioCache {
    /** 引擎合成/下载的暂存目标路径（调用方传给 [TtsEngine.synthesize]）。 */
    fun stagingPathFor(key: TtsCacheKey): String

    /** 已完整入库且通过完整性校验的可播放路径；损坏缓存按未命中处理并清理。 */
    fun find(key: TtsCacheKey): String?

    /** 把暂存文件校验后入库；损坏则删除暂存并返回 null（拦截，不入库）。 */
    fun commit(key: TtsCacheKey, stagingPath: String): String?

    /** 删除缓存条目（用户清理 / 显式保存后的管理入口）。 */
    fun remove(key: TtsCacheKey)
}

/**
 * 文件系统实现：`<root>/staging` 暂存 → 校验 → `<root>/audio/<key>.audio` 入库。
 * 只依赖 java.io，JVM 单测直接用临时目录验证。
 */
class FileTtsAudioCache(root: File) : TtsAudioCache {

    private val stagingDir = File(root, "staging").apply { mkdirs() }
    private val audioDir = File(root, "audio").apply { mkdirs() }

    override fun stagingPathFor(key: TtsCacheKey): String =
        File(stagingDir, "${key.hex}.part").absolutePath

    override fun find(key: TtsCacheKey): String? {
        val file = File(audioDir, "${key.hex}.audio")
        if (!file.isFile) return null
        return when (val check = AudioIntegrity.verifyFile(file)) {
            is AudioCheck.Ok -> file.absolutePath
            is AudioCheck.Rejected -> {
                // 缓存损坏（磁盘故障/截断写入）：按未命中处理并清理，下次重新合成
                file.delete()
                null
            }
        }
    }

    override fun commit(key: TtsCacheKey, stagingPath: String): String? {
        val staging = File(stagingPath)
        if (!staging.isFile) return null
        if (AudioIntegrity.verifyFile(staging) is AudioCheck.Rejected) {
            staging.delete()
            return null
        }
        val target = File(audioDir, "${key.hex}.audio")
        target.delete()
        if (!staging.renameTo(target)) {
            staging.copyTo(target, overwrite = true)
            staging.delete()
        }
        return target.absolutePath
    }

    override fun remove(key: TtsCacheKey) {
        File(audioDir, "${key.hex}.audio").delete()
        File(stagingDir, "${key.hex}.part").delete()
    }
}
