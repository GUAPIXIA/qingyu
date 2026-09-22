package com.qingyu.companion.tts

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * S6-03 语义钉子：PC Windows-only voice 配置同步为 public metadata 时，
 * Android 显示「不适用」，**不尝试按名字猜测音色**。
 */
class VoiceCompatTest {

    private val networkVoices = listOf(
        TtsVoice(id = "alloy", engine = TtsEngineKind.NETWORK, displayName = "Alloy"),
        // 故意放一个与 Windows 音色同名的条目：仍不得被 Windows-only 配置采用
        TtsVoice(id = "huihui", engine = TtsEngineKind.NETWORK, displayName = "Microsoft Huihui"),
    )

    @Test
    fun `PC Windows-only 音色显示不适用-不按名字猜测本地音色`() {
        val meta = PcVoiceMetadata(
            voiceId = "TTS_MS_ZH-CN_HUIHUI_11.0",
            displayName = "Microsoft Huihui",
            engine = PcVoiceEngine.WINDOWS_SYSTEM,
            platformSupport = PcVoicePlatformSupport.CROSS_PLATFORM,
        )

        val resolution = VoiceCompat.resolve(meta, networkVoices)

        assertTrue(
            resolution is VoiceResolution.NotApplicable && resolution.reason == VoiceResolution.NotApplicable.Reason.WINDOWS_ONLY,
            "Windows-only 音色在 Android 必须判「不适用」；按名字匹配同名音色会让朗读音色静默走样",
        )
        assertEquals(
            VoiceCompat.NOT_APPLICABLE_LABEL,
            VoiceCompat.displayLabel(meta, networkVoices),
            "UI 必须显示「不适用」，显示猜测出的音色名等于向用户承诺了一个不存在的映射",
        )
    }

    @Test
    fun `platformSupport标记pc_only时即使网络音色id恰好可用也不采用`() {
        val meta = PcVoiceMetadata(
            voiceId = "pc-only-voice",
            displayName = "Xiaoxiao",
            engine = PcVoiceEngine.NETWORK,
            platformSupport = PcVoicePlatformSupport.WINDOWS_ONLY,
            networkProvider = "openai",
            networkVoiceId = "alloy",
        )

        val resolution = VoiceCompat.resolve(meta, networkVoices)

        assertTrue(
            resolution is VoiceResolution.NotApplicable && resolution.reason == VoiceResolution.NotApplicable.Reason.WINDOWS_ONLY,
            "platformSupport=windows_only 是「仅 PC 适用」的显式标记，Android 不得私自挪用其网络音色",
        )
    }

    @Test
    fun `跨平台网络音色只按精确ID解析`() {
        val meta = PcVoiceMetadata(
            voiceId = "openai-alloy",
            displayName = "Alloy",
            engine = PcVoiceEngine.NETWORK,
            platformSupport = PcVoicePlatformSupport.CROSS_PLATFORM,
            networkProvider = "openai",
            networkVoiceId = "alloy",
        )

        val resolution = VoiceCompat.resolve(meta, networkVoices)

        assertTrue(resolution is VoiceResolution.Applicable, "供应商协议一致且 id 精确命中的跨平台音色应可解析")
        assertEquals("alloy", (resolution as VoiceResolution.Applicable).voice.id, "必须采用 id 精确命中的音色")
    }

    @Test
    fun `同名不同ID不猜测-未知音色判不适用`() {
        val meta = PcVoiceMetadata(
            voiceId = "openai-alloy",
            displayName = "Alloy", // 显示名与网络音色一致
            engine = PcVoiceEngine.NETWORK,
            platformSupport = PcVoicePlatformSupport.CROSS_PLATFORM,
            networkProvider = "openai",
            networkVoiceId = "Alloy", // id 大小写不同：不是精确命中
        )

        val resolution = VoiceCompat.resolve(meta, networkVoices)

        assertTrue(
            resolution is VoiceResolution.NotApplicable && resolution.reason == VoiceResolution.NotApplicable.Reason.UNKNOWN_VOICE,
            "音色匹配只允许 id 精确命中；按名字/大小写近似猜测音色是语义红线",
        )
    }

    @Test
    fun `网络音色缺ID时不用名字顶替-判不适用`() {
        val meta = PcVoiceMetadata(
            voiceId = "alloy",
            displayName = "Alloy",
            engine = PcVoiceEngine.NETWORK,
            platformSupport = PcVoicePlatformSupport.CROSS_PLATFORM,
            networkProvider = "openai",
            networkVoiceId = null,
        )

        val resolution = VoiceCompat.resolve(meta, networkVoices)

        assertTrue(
            resolution is VoiceResolution.NotApplicable && resolution.reason == VoiceResolution.NotApplicable.Reason.UNKNOWN_VOICE,
            "没有网络音色 id 时不得拿 voiceId/displayName 去顶替猜测",
        )
    }

    @Test
    fun `供应商协议不同标记不适用`() {
        val meta = PcVoiceMetadata(
            voiceId = "zh-CN-XiaoxiaoNeural",
            displayName = "Xiaoxiao",
            engine = PcVoiceEngine.NETWORK,
            platformSupport = PcVoicePlatformSupport.CROSS_PLATFORM,
            networkProvider = "edge",
            networkVoiceId = "alloy",
        )

        val resolution = VoiceCompat.resolve(meta, networkVoices)

        assertTrue(
            resolution is VoiceResolution.NotApplicable && resolution.reason == VoiceResolution.NotApplicable.Reason.PROVIDER_MISMATCH,
            "PC Edge TTS 的音色配置不能套到 Android OpenAI TTS 音色表上，供应商协议不可互换",
        )
    }

    @Test
    fun `平台信息未知不猜测-判不适用`() {
        val meta = PcVoiceMetadata(
            voiceId = "mystery",
            displayName = "神秘音色",
            engine = PcVoiceEngine.UNKNOWN,
            platformSupport = PcVoicePlatformSupport.UNKNOWN,
        )

        val resolution = VoiceCompat.resolve(meta, networkVoices)

        assertTrue(
            resolution is VoiceResolution.NotApplicable && resolution.reason == VoiceResolution.NotApplicable.Reason.PLATFORM_UNKNOWN,
            "平台/引擎信息未知时不得猜测兼容性，错判会静默改写用户听感",
        )
    }

    @Test
    fun `公开元数据解析-缺字段按未知处理并显示不适用`() {
        val meta = PcVoiceMetadata.fromPublicMetadata(
            mapOf(
                PcVoiceFields.VOICE_ID to "v1",
                PcVoiceFields.DISPLAY_NAME to "旧配置音色",
            ),
        )

        assertEquals(PcVoiceEngine.UNKNOWN, meta.engine, "缺 engine 字段必须按未知处理，不得默认当成兼容")
        assertEquals(
            PcVoicePlatformSupport.UNKNOWN,
            meta.platformSupport,
            "缺 platformSupport 字段必须按未知处理",
        )
        assertEquals(
            VoiceCompat.NOT_APPLICABLE_LABEL,
            VoiceCompat.displayLabel(meta, networkVoices),
            "字段缺失的 PC 音色配置在 Android 必须显示「不适用」",
        )
    }
}
