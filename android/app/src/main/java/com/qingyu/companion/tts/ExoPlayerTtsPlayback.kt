package com.qingyu.companion.tts

import android.content.Context
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import java.io.File

/**
 * [TtsPlaybackPort] 的 Media3 ExoPlayer 实现：**复用现有 ExoPlayer 播放底座**
 * （ui/tts/ExoPlayerTtsPlayer 是 PC 中转流路径，本类是本地缓存文件路径）。
 *
 * 播放源是缓存落盘文件（系统 TTS synthesizeToFile / 网络 TTS 流式落盘的产物），
 * 因此暂停/恢复语义与 PC 中转流一致且不依赖网络。
 */
class ExoPlayerTtsPlayback(context: Context) : TtsPlaybackPort {

    private val appContext = context.applicationContext

    private var player: ExoPlayer? = null

    override fun play(path: String, listener: TtsPlaybackListener) {
        stop()
        val newPlayer = ExoPlayer.Builder(appContext).build().apply {
            setMediaItem(MediaItem.fromUri(Uri.fromFile(File(path))))
            addListener(
                object : Player.Listener {
                    override fun onPlaybackStateChanged(playbackState: Int) {
                        if (playbackState == Player.STATE_ENDED) {
                            listener.onPlaybackCompleted()
                        }
                    }

                    override fun onPlayerError(error: PlaybackException) {
                        listener.onPlaybackError(error.errorCodeName)
                    }
                },
            )
            prepare()
            playWhenReady = true
        }
        player = newPlayer
    }

    override fun pause() {
        player?.pause()
    }

    override fun resume() {
        player?.play()
    }

    override fun stop() {
        player?.release()
        player = null
    }
}
