package com.qingyu.companion.tts

/**
 * S6-03 TTS：端口抽象。
 *
 * [TextToSpeech] / [android.media.AudioManager] / Media3 ExoPlayer 全部收敛到这些接口之后，
 * 队列、状态机、音频焦点策略、缓存策略都能用测试替身在纯 JVM 上验证（不用 Robolectric）。
 *
 * 线程契约：
 * - [TtsEngine.synthesize] 是**异步**的：实现自行决定执行线程，结果只能经 [SynthCallback]
 *   上报一次（可从任意线程回调）；[TtsQueueController] 用 `@Synchronized` 串行化状态迁移。
 */

/** 合成完成回调。实现必须恰好调用一次。 */
interface SynthCallback {
    fun onResult(result: SynthResult)
}

/** TTS 引擎（系统 TTS / 网络 TTS 统一契约）。 */
interface TtsEngine {
    val kind: TtsEngineKind

    /** 本引擎可用音色。任何按名字「猜」音色的行为都禁止发生在这里与上层。 */
    fun voices(): List<TtsVoice>

    /** 语言列表（系统 TTS 提供；网络 TTS 默认不提供语言维度）。 */
    fun languages(): List<TtsLanguage> = emptyList()

    /** 异步合成到 [targetPath]，结果经 [callback] 上报。 */
    fun synthesize(request: SpeakRequest, targetPath: String, callback: SynthCallback)
}

/** 系统 TTS 桥：`android.speech.tts.TextToSpeech` 的最小可替身接口。 */
interface SystemTtsBridge {
    fun isReady(): Boolean

    fun voices(): List<TtsVoice>

    fun languages(): List<TtsLanguage>

    fun synthesizeToFile(request: SpeakRequest, targetPath: String, callback: SynthCallback)
}

/** 音频播放完成/失败回调。 */
interface TtsPlaybackListener {
    fun onPlaybackCompleted()

    fun onPlaybackError(code: String)
}

/** 音频播放端口（ExoPlayer 实现见 ExoPlayerTtsPlayback）。 */
interface TtsPlaybackPort {
    fun play(path: String, listener: TtsPlaybackListener)

    fun pause()

    fun resume()

    fun stop()
}

/** 音频焦点变化（语义归一化，屏蔽 AudioManager 常量差异）。 */
enum class FocusEvent {
    /** 焦点回归（其他应用放弃焦点 / 系统归还）。 */
    GAINED,

    /** 被短暂抢占（来电、导航提示）：暂停，等待回归。 */
    LOST_TRANSIENT,

    /** 被「可鸭音」抢占：本实现同样按被抢处理（暂停），避免与抢占方音频叠加。 */
    LOST_CAN_DUCK,

    /** 被永久抢占（用户切到其他播放器）：停止并**放弃恢复**，回归也不自动续播。 */
    LOST_PERMANENT,
}

interface AudioFocusListener {
    fun onFocusChange(event: FocusEvent)
}

/** 音频焦点端口（AudioFocusRequest 实现见 AndroidAudioFocusPort）。 */
interface AudioFocusPort {
    /** 请求焦点；false 表示被拒。 */
    fun requestFocus(): Boolean

    fun abandonFocus()

    fun setListener(listener: AudioFocusListener?)
}

/**
 * 网络 TTS 凭据来源：实现从本地 secret store 解密注入。
 * 明文凭据只允许出现在请求头构造的一刻，**绝不进日志 / toString / 错误文案**（见 [SecretRedactor]）。
 */
fun interface TtsSecretSource {
    fun networkTtsApiKey(): String?
}
