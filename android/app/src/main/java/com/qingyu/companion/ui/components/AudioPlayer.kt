package com.qingyu.companion.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer

/**
 * 消息内嵌音频播放器（HTML `<audio src=... controls loop>`）。
 *
 * 从消息内容提取 `<audio>` 标签的 URL 后渲染：ExoPlayer 播放，
 * 播放/暂停 + 进度 + 时长，循环播放对齐 PC 端 controls loop 语义。
 */
@Composable
fun AudioPlayerItem(
    url: String,
    modifier: Modifier = Modifier,
    loop: Boolean = true,
) {
    val context = LocalContext.current
    val player = remember {
        ExoPlayer.Builder(context).build().apply {
            repeatMode = if (loop) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
        }
    }
    val mediaItem = remember(url) { MediaItem.fromUri(url) }

    var isPlaying by remember { mutableStateOf(false) }
    var durationMs by remember { mutableFloatStateOf(0f) }
    var positionMs by remember { mutableFloatStateOf(0f) }
    var error by remember { mutableStateOf<String?>(null) }

    DisposableEffect(player, mediaItem) {
        player.setMediaItem(mediaItem)
        player.prepare()
        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(playing: Boolean) {
                isPlaying = playing
            }
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_READY) {
                    durationMs = player.duration.coerceAtLeast(0L).toFloat()
                }
            }
            override fun onPlayerError(err: androidx.media3.common.PlaybackException) {
                error = "音频加载失败"
                isPlaying = false
            }
        })
        onDispose {
            player.release()
        }
    }

    LaunchedEffect(player) {
        while (true) {
            kotlinx.coroutines.delay(500)
            if (player.duration > 0) {
                positionMs = player.currentPosition.toFloat()
                durationMs = player.duration.toFloat()
            }
        }
    }

    val accent = MaterialTheme.colorScheme.primary

    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(
                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                RoundedCornerShape(10.dp),
            )
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // 播放/暂停按钮
        Box(
            modifier = Modifier
                .size(38.dp)
                .background(accent, CircleShape)
                .clickable {
                    if (error != null) {
                        error = null
                        player.seekTo(0)
                        player.prepare()
                        player.play()
                    } else if (isPlaying) {
                        player.pause()
                    } else {
                        player.play()
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = if (isPlaying) "⏸" else "▶",
                style = MaterialTheme.typography.titleMedium,
                color = Color.White,
            )
        }

        Column(Modifier.weight(1f)) {
            Text(
                text = error ?: "音频消息",
                style = MaterialTheme.typography.labelMedium,
                color = if (error != null) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
            Spacer(Modifier.height(4.dp))
            // 进度条（简单线性示意）
            val progress = if (durationMs > 0) (positionMs / durationMs).coerceIn(0f, 1f) else 0f
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(3.dp)
                    .background(MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(2.dp)),
            ) {
                Box(
                    Modifier
                        .fillMaxWidth(progress.coerceIn(0.01f, 1f))
                        .height(3.dp)
                        .background(accent, RoundedCornerShape(2.dp)),
                )
            }
            Spacer(Modifier.height(3.dp))
            Text(
                text = formatAudioTime(positionMs.toLong()) + " / " + formatAudioTime(durationMs.toLong()),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.outline,
            )
        }
    }
}

/** 提取 HTML 消息中的 <audio src="..."> URL 列表（安全：仅 http/https） */
fun extractHtmlAudios(html: String): List<String> {
    val regex = Regex("""<audio\s+[^>]*?src\s*=\s*["']([^"']+)["'][^>]*>""", RegexOption.IGNORE_CASE)
    return regex.findAll(html)
        .map { it.groupValues[1] }
        .filter { it.startsWith("http://") || it.startsWith("https://") }
        .toList()
}

private fun formatAudioTime(ms: Long): String {
    val totalSec = (ms / 1000).coerceAtLeast(0)
    val m = totalSec / 60
    val s = totalSec % 60
    return "%d:%02d".format(m, s)
}
