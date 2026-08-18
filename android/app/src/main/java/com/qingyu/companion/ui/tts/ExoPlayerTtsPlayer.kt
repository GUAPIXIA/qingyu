package com.qingyu.companion.ui.tts

import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.PlaybackException
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import com.qingyu.companion.network.ConnectionManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * [TtsPlayer] 的 Media3 ExoPlayer 实现（方案 §3.3：PC 中转音频流，独立 HTTP 通道）。
 *
 * 链路：长按消息「朗读」-> ExoPlayer 直接拉取 PC 侧合成音频流
 *   `GET /api/v1/sessions/{sessionId}/messages/{messageId}/tts`
 *   （Content-Type: audio/mpeg，支持 Range，边下边播；协议假设见 README）。
 * 音频通道独立于 WS：不挤占 token 流式推送。
 * 令牌经 HTTP 头 Authorization: Bearer 下发（与 REST 一致），不经 URL 传递。
 */
class ExoPlayerTtsPlayer(
    context: Context,
    private val connectionManager: ConnectionManager,
) : TtsPlayer {

    private val appContext = context.applicationContext

    private val _state = MutableStateFlow(TtsPlayer.State.IDLE)
    override val state: StateFlow<TtsPlayer.State> = _state.asStateFlow()

    private var player: ExoPlayer? = null

    override suspend fun play(sessionId: String, messageId: String) {
        val connection = connectionManager.activeConnection ?: return
        stopInternal()
        _state.value = TtsPlayer.State.SYNTHESIZING

        val url = "http://${connection.host}:${connection.port}" +
            "/api/v1/sessions/$sessionId/messages/$messageId/tts"
        val token = connection.token

        // 鉴权 DataSource：令牌走 HTTP 头，音频流独立于 WS（方案 §3.3）
        val dataSourceFactory = DefaultHttpDataSource.Factory()
            .setDefaultRequestProperties(mapOf("Authorization" to "Bearer $token"))

        val newPlayer = ExoPlayer.Builder(appContext).build().apply {
            setMediaSource(
                ProgressiveMediaSource.Factory(dataSourceFactory)
                    .createMediaSource(MediaItem.fromUri(url)),
                /* resetPosition = */ true,
            )
            addListener(playerListener)
            prepare()
            playWhenReady = true
        }
        player = newPlayer
    }

    override fun stop() {
        stopInternal()
    }

    override fun release() {
        stopInternal()
    }

    private fun stopInternal() {
        player?.removeListener(playerListener)
        player?.release()
        player = null
        _state.value = TtsPlayer.State.IDLE
    }

    private val playerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            when (playbackState) {
                Player.STATE_READY ->
                    if (_state.value != TtsPlayer.State.PLAYING) {
                        _state.value = TtsPlayer.State.PLAYING
                    }

                Player.STATE_ENDED -> _state.value = TtsPlayer.State.IDLE

                // 合成失败/流不可用：prepare 后直接回到 IDLE 视为错误
                Player.STATE_IDLE ->
                    if (_state.value == TtsPlayer.State.SYNTHESIZING) {
                        _state.value = TtsPlayer.State.ERROR
                    }

                else -> Unit
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            _state.value = TtsPlayer.State.ERROR
        }
    }
}
