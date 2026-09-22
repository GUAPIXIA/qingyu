package com.qingyu.companion.tts

/**
 * Android 系统 TTS 引擎（`android.speech.tts.TextToSpeech` 的纯逻辑外壳）。
 *
 * - 语言/音色列表：经 [SystemTtsBridge] 透传（Android 实现见 AndroidSystemTtsBridge）；
 * - 合成：`synthesizeToFile` 产出音频文件 → 走统一缓存/完整性/播放路径，
 *   这样暂停/恢复/队列/音频焦点在两种引擎上行为一致；
 * - 未就绪（TTS 服务初始化中/被停用）直接失败，不静默丢任务。
 */
class SystemTtsEngine(private val bridge: SystemTtsBridge) : TtsEngine {

    override val kind: TtsEngineKind = TtsEngineKind.SYSTEM

    override fun voices(): List<TtsVoice> = bridge.voices()

    override fun languages(): List<TtsLanguage> = bridge.languages()

    override fun synthesize(request: SpeakRequest, targetPath: String, callback: SynthCallback) {
        if (!bridge.isReady()) {
            callback.onResult(
                SynthResult.Failure(
                    TtsError("TTS_NOT_READY", "系统 TTS 引擎尚未就绪（初始化中或引擎被系统停用）"),
                ),
            )
            return
        }
        bridge.synthesizeToFile(request, targetPath, callback)
    }
}
