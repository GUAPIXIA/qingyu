package com.qingyu.companion.ui.tts

import kotlinx.coroutines.flow.StateFlow

/**
 * TTS 音频播放器（方案 §3.3 消费型能力）。
 * 链路：安卓发「朗读」指令 -> PC 合成 -> 独立 HTTP 音频流回传
 * （Content-Type: audio/mpeg，支持 Range），WS 仅传状态信号。
 * 音频通道独立于 WS，避免阻塞 token 流式推送。
 * 实现基于 Media3 ExoPlayer 边下边播（见 [ExoPlayerTtsPlayer]）。
 */
interface TtsPlayer {

    enum class State { IDLE, SYNTHESIZING, PLAYING, ERROR }

    /** 响应式状态，供 UI 收集（Compose collectAsState） */
    val state: StateFlow<State>

    /** 请求朗读指定消息（PC 侧合成，独立 HTTP 流） */
    suspend fun play(sessionId: String, messageId: String)

    /** 请求朗读群聊消息。 */
    suspend fun playGroup(groupId: String, sessionId: String, messageId: String)

    fun stop()

    fun release()
}
