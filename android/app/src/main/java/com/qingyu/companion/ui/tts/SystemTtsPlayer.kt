package com.qingyu.companion.ui.tts

import android.content.Context
import android.speech.tts.TextToSpeech
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale

/**
 * S9-07：本地系统 TTS 播放器（替代 PC 中转 /api/v1 拉流）。
 * 朗读文本由 UI 直接传入；不访问任何远程桥接端点。
 */
class SystemTtsPlayer(context: Context) : TtsPlayer {

    private val appContext = context.applicationContext

    private val _state = MutableStateFlow(TtsPlayer.State.IDLE)
    override val state: StateFlow<TtsPlayer.State> = _state.asStateFlow()

    private var engine: TextToSpeech? = null
    private var ready = false

    private fun ensureEngine(): TextToSpeech? {
        if (engine == null) {
            engine = TextToSpeech(appContext) { status ->
                ready = status == TextToSpeech.SUCCESS
                if (ready) engine?.language = Locale.getDefault()
            }
        }
        return engine
    }

    override suspend fun play(sessionId: String, messageId: String) {
        // 本地实现需要文本；ID 级 play 不可用，置 ERROR 供 UI 提示
        _state.value = TtsPlayer.State.ERROR
    }

    override suspend fun playGroup(groupId: String, sessionId: String, messageId: String) {
        _state.value = TtsPlayer.State.ERROR
    }

    /** 朗读任意文本（本地生成/角色台词用）。 */
    fun speak(text: String) {
        if (text.isBlank()) return
        val tts = ensureEngine() ?: return
        _state.value = TtsPlayer.State.SYNTHESIZING
        val rc = tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "local-tts")
        if (rc == TextToSpeech.SUCCESS) {
            _state.value = TtsPlayer.State.PLAYING
        } else {
            _state.value = TtsPlayer.State.ERROR
        }
    }

    override fun stop() {
        engine?.stop()
        _state.value = TtsPlayer.State.IDLE
    }

    override fun release() {
        engine?.stop()
        engine?.shutdown()
        engine = null
        ready = false
        _state.value = TtsPlayer.State.IDLE
    }
}
