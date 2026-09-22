package com.qingyu.companion.tts

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import java.io.File
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * [SystemTtsBridge] 的 Android 实现：`android.speech.tts.TextToSpeech`。
 *
 * - 音色/语言列表直接取自系统引擎（不构造、不猜测任何音色名）；
 * - 合成走 `synthesizeToFile`，产物进入统一缓存/完整性/ExoPlayer 播放路径
 *   （因此暂停/恢复/队列/音频焦点行为与网络 TTS 一致）；
 * - [SpeakRequest.voiceId] 只按 `Voice.name` **精确**匹配；匹配不到时仅按显式
 *   `localeTag` 兜底，绝不按名字相似度挑音色。
 *
 * 真机验证项（不进本轮 JVM 单测）：TTS 引擎初始化时序、各厂商引擎的 synthesizeToFile 完成回调、
 * 蓝牙/耳机路由、后台进程被杀后的恢复（见报告遗留清单）。
 */
class AndroidSystemTtsBridge(context: Context) : SystemTtsBridge {

    private val appContext = context.applicationContext

    private val utteranceSeq = AtomicInteger(0)
    private val pending = ConcurrentHashMap<String, SynthCallback>()

    private val utteranceListener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String) = Unit

        override fun onDone(utteranceId: String) {
            pending.remove(utteranceId)?.onResult(SynthResult.Ok)
        }

        @Deprecated("Java 侧单参 onError 仍被部分旧引擎调用，必须保留")
        override fun onError(utteranceId: String) {
            pending.remove(utteranceId)?.onResult(
                SynthResult.Failure(TtsError("SYNTH_FAILED", "系统 TTS 合成失败")),
            )
        }
    }

    @Volatile
    private var engine: TextToSpeech? = null

    @Volatile
    private var ready = false

    init {
        engine = TextToSpeech(appContext) { status -> onEngineInit(status) }
    }

    private fun onEngineInit(status: Int) {
        val tts = engine ?: return
        ready = status == TextToSpeech.SUCCESS
        if (ready) {
            tts.setOnUtteranceProgressListener(utteranceListener)
        }
    }

    override fun isReady(): Boolean = ready && engine != null

    override fun voices(): List<TtsVoice> {
        val tts = engine ?: return emptyList()
        return tts.voices?.map { it.toTtsVoice() } ?: emptyList()
    }

    override fun languages(): List<TtsLanguage> {
        val tts = engine ?: return emptyList()
        val locales = tts.availableLanguages ?: return emptyList()
        return locales.sortedBy { it.toLanguageTag() }.map {
            TtsLanguage(tag = it.toLanguageTag(), displayName = it.getDisplayName(Locale.getDefault()))
        }
    }

    override fun synthesizeToFile(request: SpeakRequest, targetPath: String, callback: SynthCallback) {
        val tts = engine
        if (!ready || tts == null) {
            callback.onResult(
                SynthResult.Failure(TtsError("TTS_NOT_READY", "系统 TTS 引擎尚未就绪")),
            )
            return
        }
        val utteranceId = "qy-tts-${utteranceSeq.incrementAndGet()}"
        val target = File(targetPath).apply { parentFile?.mkdirs() }

        // 音色：只按 Voice.name 精确匹配；不猜名字
        val matched: Voice? = request.voiceId
            .takeIf { it.isNotBlank() }
            ?.let { id -> tts.voices?.firstOrNull { it.name == id } }
        val configured = when {
            matched != null -> tts.setVoice(matched) == TextToSpeech.SUCCESS

            !request.localeTag.isNullOrBlank() ->
                tts.setLanguage(Locale.forLanguageTag(request.localeTag)) >= 0

            else -> true // 未指定则用引擎默认
        }
        if (!configured) {
            callback.onResult(
                SynthResult.Failure(
                    TtsError("UNSUPPORTED_VOICE", "系统 TTS 不支持所选音色/语言（不按名字猜测替代音色）"),
                ),
            )
            return
        }
        tts.setSpeechRate(request.speed.coerceIn(0.25f, 4.0f))

        pending[utteranceId] = callback
        val started = tts.synthesizeToFile(request.text, Bundle(), target, utteranceId)
        if (started != TextToSpeech.SUCCESS) {
            pending.remove(utteranceId)
            callback.onResult(
                SynthResult.Failure(TtsError("SYNTH_FAILED", "系统 TTS 合成请求被拒绝")),
            )
        }
    }

    /** 释放 TTS 引擎（应用退出 / 重建时调用）。 */
    fun shutdown() {
        pending.values.forEach {
            it.onResult(SynthResult.Failure(TtsError("TTS_SHUTDOWN", "系统 TTS 引擎已释放")))
        }
        pending.clear()
        ready = false
        engine?.shutdown()
        engine = null
    }
}

private fun Voice.toTtsVoice(): TtsVoice = TtsVoice(
    id = name,
    engine = TtsEngineKind.SYSTEM,
    displayName = name,
    localeTag = locale?.toLanguageTag(),
    quality = quality,
    networkRequired = isNetworkConnectionRequired,
)
