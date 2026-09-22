package com.qingyu.companion.tts

/**
 * S6-03 语义钉子：**PC Windows-only voice 配置同步为 public metadata 时，
 * Android 显示「不适用」，不尝试按名字猜测音色**。
 *
 * 规则（[VoiceCompat.resolve]）：
 * 1. Windows-only（Windows 系统 TTS / SAPI 音色，或 platformSupport 标记 pc_only/windows_only）
 *    → `NotApplicable`，**在查看任何本地/网络音色列表之前短路**——即使本地存在同名音色也不采用；
 * 2. 平台/引擎信息未知 → `NotApplicable`（不确定也不猜）；
 * 3. 跨平台网络音色：仅当供应商协议一致（Android 侧为 OpenAI TTS）且 `networkVoiceId`
 *    与网络音色 **id 精确相等**时才解析成功；displayName 相等不算匹配（按名字猜测被禁止）。
 *
 * 纯 Kotlin，无 Android 依赖。
 */

/** PC 侧 TTS 引擎类别（public metadata wire 值）。 */
enum class PcVoiceEngine(val wire: String) {
    WINDOWS_SYSTEM("windows_system"),
    NETWORK("network"),
    UNKNOWN("unknown"),
    ;

    companion object {
        fun fromWire(value: String?): PcVoiceEngine = when (value?.trim()?.lowercase()) {
            "windows_system", "windows", "sapi", "system_windows" -> WINDOWS_SYSTEM
            "network", "edge", "edge_tts", "edge-tts", "openai", "openai_tts" -> NETWORK
            else -> UNKNOWN
        }
    }
}

/** PC 音色的平台支持范围（public metadata wire 值）。 */
enum class PcVoicePlatformSupport {
    WINDOWS_ONLY,
    CROSS_PLATFORM,
    UNKNOWN,
    ;

    companion object {
        fun fromWire(value: String?): PcVoicePlatformSupport = when (value?.trim()?.lowercase()) {
            "windows_only", "windows", "pc_only", "pc" -> WINDOWS_ONLY
            "cross_platform", "cross-platform", "all", "any" -> CROSS_PLATFORM
            else -> UNKNOWN
        }
    }
}

/** public metadata 字段名（`settings_public` / 同步 envelope 的 TTS voice 行）。 */
object PcVoiceFields {
    const val VOICE_ID = "voiceId"
    const val DISPLAY_NAME = "displayName"
    const val ENGINE = "engine"
    const val PLATFORM_SUPPORT = "platformSupport"
    const val NETWORK_PROVIDER = "networkProvider"
    const val NETWORK_VOICE_ID = "networkVoiceId"
}

/** PC 音色配置的 public metadata 视图（不含任何凭据）。 */
data class PcVoiceMetadata(
    val voiceId: String,
    val displayName: String,
    val engine: PcVoiceEngine,
    val platformSupport: PcVoicePlatformSupport,
    val networkProvider: String? = null,
    val networkVoiceId: String? = null,
) {
    /** Windows-only 判定：Windows 系统 TTS 音色，或显式标记仅 PC 可用。 */
    val windowsOnly: Boolean
        get() = engine == PcVoiceEngine.WINDOWS_SYSTEM ||
            platformSupport == PcVoicePlatformSupport.WINDOWS_ONLY

    override fun toString(): String =
        "PcVoiceMetadata(voiceId=$voiceId, engine=$engine, platformSupport=$platformSupport)"

    companion object {
        /** 从同步过来的 public metadata 行解析；缺省字段一律按「未知」处理（未知即不猜测）。 */
        fun fromPublicMetadata(fields: Map<String, String>): PcVoiceMetadata = PcVoiceMetadata(
            voiceId = fields[PcVoiceFields.VOICE_ID].orEmpty(),
            displayName = fields[PcVoiceFields.DISPLAY_NAME].orEmpty(),
            engine = PcVoiceEngine.fromWire(fields[PcVoiceFields.ENGINE]),
            platformSupport = PcVoicePlatformSupport.fromWire(fields[PcVoiceFields.PLATFORM_SUPPORT]),
            networkProvider = fields[PcVoiceFields.NETWORK_PROVIDER]?.takeIf { it.isNotBlank() },
            networkVoiceId = fields[PcVoiceFields.NETWORK_VOICE_ID]?.takeIf { it.isNotBlank() },
        )
    }
}

/** PC 音色在 Android 侧的解析结果。 */
sealed class VoiceResolution {
    /** 可用：由网络音色 **id 精确命中**得到。 */
    data class Applicable(val voice: TtsVoice) : VoiceResolution()

    /** 不可用：UI 显示 [VoiceCompat.NOT_APPLICABLE_LABEL]（「不适用」）。 */
    data class NotApplicable(val reason: Reason) : VoiceResolution() {
        enum class Reason {
            /** PC Windows-only 音色：Android 无对应系统 TTS 音色，不猜测。 */
            WINDOWS_ONLY,

            /** 供应商协议不同（如 PC Edge TTS ↔ Android OpenAI TTS），不可互换。 */
            PROVIDER_MISMATCH,

            /** id 未精确命中；**不按名字猜相近音色**。 */
            UNKNOWN_VOICE,

            /** 平台/引擎信息未知：不猜测。 */
            PLATFORM_UNKNOWN,
        }
    }
}

object VoiceCompat {

    /** UI 展示文案（语义钉子）。 */
    const val NOT_APPLICABLE_LABEL = "不适用"

    /** Android 侧网络 TTS 供应商协议标识。 */
    const val NETWORK_PROVIDER = OpenAiTtsRequestBuilder.PROVIDER_WIRE

    /**
     * 解析 PC 音色配置。**唯一的匹配方式是网络音色 id 精确相等**；
     * [networkVoices] 里哪怕存在同名音色也不会被 Windows-only 配置采用。
     */
    fun resolve(meta: PcVoiceMetadata, networkVoices: List<TtsVoice>): VoiceResolution {
        if (meta.windowsOnly) return VoiceResolution.NotApplicable(VoiceResolution.NotApplicable.Reason.WINDOWS_ONLY)
        if (meta.engine == PcVoiceEngine.UNKNOWN ||
            meta.platformSupport == PcVoicePlatformSupport.UNKNOWN
        ) {
            return VoiceResolution.NotApplicable(VoiceResolution.NotApplicable.Reason.PLATFORM_UNKNOWN)
        }
        val provider = meta.networkProvider?.trim()?.lowercase()
        if (provider != NETWORK_PROVIDER) {
            return VoiceResolution.NotApplicable(VoiceResolution.NotApplicable.Reason.PROVIDER_MISMATCH)
        }
        val id = meta.networkVoiceId?.trim()?.takeIf { it.isNotEmpty() }
            ?: return VoiceResolution.NotApplicable(VoiceResolution.NotApplicable.Reason.UNKNOWN_VOICE)
        val match = networkVoices.firstOrNull {
            it.engine == TtsEngineKind.NETWORK && it.id == id
        } ?: return VoiceResolution.NotApplicable(VoiceResolution.NotApplicable.Reason.UNKNOWN_VOICE)
        return VoiceResolution.Applicable(match)
    }

    /** UI 展示文案：可用 → 音色显示名；不可用 → 「不适用」。 */
    fun displayLabel(meta: PcVoiceMetadata, networkVoices: List<TtsVoice>): String =
        when (val resolution = resolve(meta, networkVoices)) {
            is VoiceResolution.Applicable -> resolution.voice.displayName
            is VoiceResolution.NotApplicable -> NOT_APPLICABLE_LABEL
        }
}
