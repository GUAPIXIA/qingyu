package com.qingyu.companion.tts

import java.io.File

/**
 * TTS 包 JVM 单测的共享测试替身与音频样本（无 Android 依赖，不需要 Robolectric）。
 * 测试类命名为 `XxxTest.kt`；本文件是 fixtures（与 chatcore/ChatCoreFixtures 同一惯例）。
 */

/** 合法 WAV 魔数的伪音频：只用于通过 [AudioIntegrity] 闸门。 */
fun wavLikeAudio(size: Int = 256): ByteArray {
    val bytes = ByteArray(size)
    "RIFF".toByteArray(Charsets.US_ASCII).copyInto(bytes, 0)
    "WAVE".toByteArray(Charsets.US_ASCII).copyInto(bytes, 8)
    for (i in 12 until size) bytes[i] = 0x20
    return bytes
}

fun mp3LikeAudio(size: Int = 256): ByteArray {
    val bytes = ByteArray(size)
    bytes[0] = 0xFF.toByte()
    bytes[1] = 0xFB.toByte()
    return bytes
}

fun oggLikeAudio(size: Int = 256): ByteArray {
    val bytes = ByteArray(size)
    "OggS".toByteArray(Charsets.US_ASCII).copyInto(bytes, 0)
    return bytes
}

/** 损坏音频：合法长度但魔数无法识别（截断/乱码/伪音频的典型形态）。 */
fun corruptAudio(size: Int = 100): ByteArray = ByteArray(size) { 'X'.code.toByte() }

fun speakReq(
    id: String = "r1",
    text: String = "你好，世界",
    engine: TtsEngineKind = TtsEngineKind.SYSTEM,
    voice: String = "fake-voice",
    locale: String? = null,
    speed: Float = 1.0f,
): SpeakRequest = SpeakRequest(
    requestId = id,
    text = text,
    engine = engine,
    voiceId = voice,
    localeTag = locale,
    speed = speed,
)

/** 可同步/延迟回调的合成引擎替身：统计合成次数以验证「缓存命中不重复合成」。 */
class FakeTtsEngine(
    override val kind: TtsEngineKind = TtsEngineKind.SYSTEM,
    var audio: ByteArray = wavLikeAudio(),
    var deferCompletion: Boolean = false,
    var failWith: TtsError? = null,
    private val voiceList: List<TtsVoice> = listOf(
        TtsVoice(id = "fake-voice", engine = TtsEngineKind.SYSTEM, displayName = "测试音色"),
    ),
) : TtsEngine {

    var synthesizeCount: Int = 0
        private set

    val requests = mutableListOf<SpeakRequest>()

    private class DeferredSynth(
        val request: SpeakRequest,
        val targetPath: String,
        val callback: SynthCallback,
    )

    private val deferred = mutableListOf<DeferredSynth>()

    override fun voices(): List<TtsVoice> = voiceList

    override fun languages(): List<TtsLanguage> = listOf(TtsLanguage("zh-CN", "中文（中国）"))

    override fun synthesize(request: SpeakRequest, targetPath: String, callback: SynthCallback) {
        synthesizeCount += 1
        requests += request
        if (deferCompletion) {
            deferred += DeferredSynth(request, targetPath, callback)
        } else {
            finish(request, targetPath, callback)
        }
    }

    /** 按 FIFO 完成挂起的合成（模拟异步回调，含「打断后迟到的过期回调」时序）。 */
    fun completeDeferred() {
        val item = deferred.removeAt(0)
        finish(item.request, item.targetPath, item.callback)
    }

    private fun finish(request: SpeakRequest, targetPath: String, callback: SynthCallback) {
        val error = failWith
        if (error != null) {
            callback.onResult(SynthResult.Failure(error))
            return
        }
        File(targetPath).apply { parentFile?.mkdirs() }.writeBytes(audio)
        callback.onResult(SynthResult.Ok)
    }
}

/** 系统 TTS 桥替身。 */
class FakeSystemTtsBridge(
    var ready: Boolean = true,
    private val voiceList: List<TtsVoice> = listOf(
        TtsVoice(id = "zh-CN-fake", engine = TtsEngineKind.SYSTEM, displayName = "测试音色", localeTag = "zh-CN"),
    ),
) : SystemTtsBridge {

    var synthesizeCount: Int = 0
        private set

    val requests = mutableListOf<SpeakRequest>()

    var failWith: TtsError? = null

    override fun isReady(): Boolean = ready

    override fun voices(): List<TtsVoice> = voiceList

    override fun languages(): List<TtsLanguage> = listOf(TtsLanguage("zh-CN", "中文（中国）"))

    override fun synthesizeToFile(request: SpeakRequest, targetPath: String, callback: SynthCallback) {
        synthesizeCount += 1
        requests += request
        val error = failWith
        if (error != null) {
            callback.onResult(SynthResult.Failure(error))
            return
        }
        File(targetPath).apply { parentFile?.mkdirs() }.writeBytes(wavLikeAudio())
        callback.onResult(SynthResult.Ok)
    }
}

/** 播放器替身：记录调用序列，播完/失败由测试手动触发。 */
class FakePlayback : TtsPlaybackPort {
    val calls = mutableListOf<String>()
    val playedPaths = mutableListOf<String>()
    private var listener: TtsPlaybackListener? = null

    override fun play(path: String, listener: TtsPlaybackListener) {
        calls += "play"
        playedPaths += path
        this.listener = listener
    }

    override fun pause() {
        calls += "pause"
    }

    override fun resume() {
        calls += "resume"
    }

    override fun stop() {
        calls += "stop"
        listener = null
    }

    fun completePlayback() {
        checkNotNull(listener) { "当前没有正在播放的音频，无法模拟播完" }.onPlaybackCompleted()
    }

    fun failPlayback(code: String = "DECODE") {
        checkNotNull(listener) { "当前没有正在播放的音频，无法模拟播放失败" }.onPlaybackError(code)
    }
}

/** 音频焦点替身。 */
class FakeFocus(var granted: Boolean = true) : AudioFocusPort {
    var requestCount: Int = 0
        private set
    var abandonCount: Int = 0
        private set

    private var listener: AudioFocusListener? = null

    override fun requestFocus(): Boolean {
        requestCount += 1
        return granted
    }

    override fun abandonFocus() {
        abandonCount += 1
    }

    override fun setListener(listener: AudioFocusListener?) {
        this.listener = listener
    }

    fun emit(event: FocusEvent) {
        checkNotNull(listener) { "焦点监听未注册" }.onFocusChange(event)
    }
}
