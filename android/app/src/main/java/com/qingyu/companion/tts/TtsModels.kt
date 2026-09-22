package com.qingyu.companion.tts

/**
 * S6-03 TTS：平台无关的领域模型（纯 Kotlin，无 Android 依赖，JVM 单测直测）。
 *
 * 设计约束（阶段 6 §S6-03 / §0）：
 * - Android 系统 TTS 与网络 TTS 共用同一 [SpeakRequest] / [TtsVoice] 抽象；
 * - PC Windows-only 音色只以 public metadata 形式进入（见 [PcVoiceMetadata]），Android 侧
 *   **显示「不适用」且不按名字猜测音色**（语义钉子，见 [VoiceCompat]）；
 * - TTS 音频默认是派生缓存而非用户主数据（见 [TtsAudioPolicy]）。
 */

/** TTS 引擎类别：Android 系统 TTS / 网络 TTS（OpenAI TTS 供应商协议）。 */
enum class TtsEngineKind(val wire: String) {
    SYSTEM("system"),
    NETWORK("network"),
    ;

    companion object {
        fun fromWire(value: String): TtsEngineKind? =
            entries.firstOrNull { it.wire == value.trim().lowercase() }
    }
}

/**
 * 统一音色模型。
 * - [id]：引擎内精确标识（系统 TTS 为 `Voice.name`，网络 TTS 为供应商 voice id）；
 *   **任何匹配都只允许按 [id] 精确命中，禁止按 [displayName] 猜测**。
 * - [localeTag]：BCP-47 语言标签；网络音色可为 null（多语言）。
 */
data class TtsVoice(
    val id: String,
    val engine: TtsEngineKind,
    val displayName: String,
    val localeTag: String? = null,
    val quality: Int? = null,
    val networkRequired: Boolean = false,
)

/** 系统 TTS 语言条目（语言/音色列表能力）。 */
data class TtsLanguage(
    val tag: String,
    val displayName: String,
    val available: Boolean = true,
)

/**
 * 一次朗读请求。
 * [requestId] 只用于追踪/状态汇报，**不参与缓存键**（同文本同音色必须命中同一缓存）。
 */
data class SpeakRequest(
    val requestId: String,
    val text: String,
    val engine: TtsEngineKind,
    val voiceId: String,
    val localeTag: String? = null,
    val speed: Float = 1.0f,
)

/** 入队模式：追加到队尾，或打断（清空待播并立即替换当前项）。 */
enum class EnqueueMode { APPEND, INTERRUPT }

/** 播放状态机状态。 */
enum class TtsPlayState { IDLE, LOADING, PLAYING, PAUSED }

/** 对 UI 暴露的只读快照（StateFlow 发布）。 */
data class TtsControllerSnapshot(
    val state: TtsPlayState,
    val current: SpeakRequest?,
    val pending: List<SpeakRequest>,
    val lastError: TtsError? = null,
)

/** 合成结果。 */
sealed class SynthResult {
    /** 合成完成，产物已写入调用方给定的目标路径（完整性校验由缓存入库时统一执行）。 */
    object Ok : SynthResult()

    data class Failure(val error: TtsError) : SynthResult()
}

/**
 * TTS 错误。[toString] 只输出 code/retryable，**message 永远不进 toString**：
 * message 可能携带供应商返回片段，日志/诊断只能打印 [toString] 或经 [SecretRedactor] 的文本。
 */
data class TtsError(
    val code: String,
    val message: String,
    val retryable: Boolean = false,
) {
    override fun toString(): String = "TtsError(code=$code, retryable=$retryable)"
}

/**
 * TTS 偏好（设备本地，不进同步 envelope）。
 * UI/装配层负责把 DeviceSettings 映射进来（键名建议见报告「建议接线点」）。
 */
data class TtsPreferences(
    val engine: TtsEngineKind = TtsEngineKind.SYSTEM,
    val systemVoiceId: String? = null,
    val systemLocaleTag: String? = null,
    val networkVoiceId: String = OpenAiTtsVoices.DEFAULT_ID,
    val speed: Float = 1.0f,
) {
    /** 按当前偏好构造朗读请求。 */
    fun toSpeakRequest(requestId: String, text: String): SpeakRequest = when (engine) {
        TtsEngineKind.SYSTEM -> SpeakRequest(
            requestId = requestId,
            text = text,
            engine = TtsEngineKind.SYSTEM,
            voiceId = systemVoiceId.orEmpty(),
            localeTag = systemLocaleTag,
            speed = speed,
        )

        TtsEngineKind.NETWORK -> SpeakRequest(
            requestId = requestId,
            text = text,
            engine = TtsEngineKind.NETWORK,
            voiceId = networkVoiceId,
            localeTag = null,
            speed = speed,
        )
    }
}
