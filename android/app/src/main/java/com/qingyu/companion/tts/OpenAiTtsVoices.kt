package com.qingyu.companion.tts

/**
 * OpenAI TTS（`POST {base}/v1/audio/speech`，官方公开 REST 协议）静态音色表。
 *
 * 网络 TTS 的音色匹配同样只允许 id 精确命中（见 [VoiceCompat]）。
 */
object OpenAiTtsVoices {
    const val DEFAULT_ID = "alloy"

    private val IDS = listOf(
        "alloy", "ash", "ballad", "coral", "echo",
        "fable", "nova", "onyx", "sage", "shimmer",
    )

    val ALL: List<TtsVoice> = IDS.map {
        TtsVoice(
            id = it,
            engine = TtsEngineKind.NETWORK,
            displayName = it.replaceFirstChar { c -> c.uppercase() },
            localeTag = null, // 多语言音色，不绑定单一语言
        )
    }
}
