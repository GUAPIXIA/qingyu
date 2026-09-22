package com.qingyu.companion.tts

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager

/**
 * [AudioFocusPort] 的 Android 实现（AudioFocusRequest，API 26+ = 本项目 minSdk）。
 *
 * - USAGE_MEDIA + CONTENT_TYPE_SPEECH：与音乐/播客同等的语音播放通道；
 * - `setWillPauseWhenDucked(true)`：可鸭音抢占时由系统通知我们 duck，
 *   本层把 CAN_DUCK 归一化为「被抢」交给 [TtsQueueController] 统一处理（暂停待回归）；
 * - 焦点常量 → [FocusEvent] 的归一化是本类唯一职责，策略全在纯逻辑层。
 *
 * 真机验证项：蓝牙/耳机插拔、来电抢占、导航提示、后台恢复时的焦点得失（见报告遗留清单）。
 */
class AndroidAudioFocusPort(context: Context) : AudioFocusPort {

    private val appContext = context.applicationContext

    private val audioManager =
        appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    @Volatile
    private var listener: AudioFocusListener? = null

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        listener?.onFocusChange(change.toFocusEvent())
    }

    private val focusRequest: AudioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        .setWillPauseWhenDucked(true)
        .setOnAudioFocusChangeListener(focusListener)
        .build()

    override fun requestFocus(): Boolean =
        audioManager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED

    override fun abandonFocus() {
        audioManager.abandonAudioFocusRequest(focusRequest)
    }

    override fun setListener(listener: AudioFocusListener?) {
        this.listener = listener
    }
}

private fun Int.toFocusEvent(): FocusEvent = when (this) {
    AudioManager.AUDIOFOCUS_GAIN -> FocusEvent.GAINED
    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> FocusEvent.LOST_TRANSIENT
    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> FocusEvent.LOST_CAN_DUCK
    else -> FocusEvent.LOST_PERMANENT
}
