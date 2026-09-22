package com.qingyu.companion.tts

import org.junit.After
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * S6-03：音频焦点策略——被抢焦点暂停、焦点回归恢复、永久被抢放弃恢复。
 * （AudioFocusRequest 的 Android 封装行为属真机验证项，本类只验证策略状态机。）
 */
class AudioFocusPolicyTest {

    private lateinit var tempDir: java.io.File

    @Before
    fun setUp() {
        tempDir = Files.createTempDirectory("tts-focus-test").toFile()
    }

    @After
    fun tearDown() {
        tempDir.deleteRecursively()
    }

    private fun controller(
        engine: FakeTtsEngine,
        playback: FakePlayback,
        focus: FakeFocus,
    ): TtsQueueController = TtsQueueController(listOf(engine), FileTtsAudioCache(tempDir), playback, focus)

    @Test
    fun `被抢焦点暂停-焦点回归自动恢复播放`() {
        val engine = FakeTtsEngine()
        val playback = FakePlayback()
        val focus = FakeFocus()
        val controller = controller(engine, playback, focus)

        controller.enqueue(speakReq("a", "朗读内容"))
        focus.emit(FocusEvent.LOST_TRANSIENT)

        assertEquals(TtsPlayState.PAUSED, controller.snapshot.value.state, "被抢焦点（来电/导航）必须暂停，叠音会让两边都听不清")
        assertEquals(
            listOf("play", "pause"),
            playback.calls,
            "被抢焦点时必须真正暂停播放器",
        )

        focus.emit(FocusEvent.GAINED)

        assertEquals(TtsPlayState.PLAYING, controller.snapshot.value.state, "焦点回归后必须自动恢复朗读，否则用户要点两次才能听完")
        assertEquals(
            listOf("play", "pause", "resume"),
            playback.calls,
            "恢复必须从暂停点续播而不是重头开始",
        )
    }

    @Test
    fun `永久失去焦点终止播放并放弃恢复-焦点回归也不再播放`() {
        val engine = FakeTtsEngine()
        val playback = FakePlayback()
        val focus = FakeFocus()
        val controller = controller(engine, playback, focus)

        controller.enqueue(speakReq("a", "当前项"))
        controller.enqueue(speakReq("b", "排队项"))
        focus.emit(FocusEvent.LOST_PERMANENT)

        assertEquals(TtsPlayState.IDLE, controller.snapshot.value.state, "用户切走听歌时必须终止朗读，抢占别人的音频通道是严重体验事故")
        assertTrue(controller.snapshot.value.pending.isEmpty(), "永久被抢必须清空队列（放弃恢复）")
        assertEquals(1, focus.abandonCount, "终止后必须放弃音频焦点")

        focus.emit(FocusEvent.GAINED)

        assertEquals(TtsPlayState.IDLE, controller.snapshot.value.state, "放弃恢复：焦点回归后不得自动续播（用户已转向其他音频）")
        assertEquals(1, playback.playedPaths.size, "放弃恢复后不得再发起任何播放")
    }

    @Test
    fun `用户手动暂停时焦点回归不自动恢复`() {
        val engine = FakeTtsEngine()
        val playback = FakePlayback()
        val focus = FakeFocus()
        val controller = controller(engine, playback, focus)

        controller.enqueue(speakReq("a", "朗读内容"))
        controller.pause()
        focus.emit(FocusEvent.LOST_TRANSIENT)
        focus.emit(FocusEvent.GAINED)

        assertEquals(
            TtsPlayState.PAUSED,
            controller.snapshot.value.state,
            "用户手动暂停的意图优先于焦点回归，自动恢复会违背用户明确操作",
        )

        controller.resume()
        assertEquals(TtsPlayState.PLAYING, controller.snapshot.value.state, "用户主动恢复后应继续朗读")
    }

    @Test
    fun `鸭音焦点按被抢处理-暂停待回归`() {
        val engine = FakeTtsEngine()
        val playback = FakePlayback()
        val focus = FakeFocus()
        val controller = controller(engine, playback, focus)

        controller.enqueue(speakReq("a", "朗读内容"))
        focus.emit(FocusEvent.LOST_CAN_DUCK)

        assertEquals(
            TtsPlayState.PAUSED,
            controller.snapshot.value.state,
            "鸭音抢占（导航提示）同样暂停，避免 TTS 与抢占方音频叠加",
        )

        focus.emit(FocusEvent.GAINED)
        assertEquals(TtsPlayState.PLAYING, controller.snapshot.value.state, "鸭音抢占结束后应恢复朗读")
    }

    @Test
    fun `空闲时焦点变化不影响状态`() {
        val playback = FakePlayback()
        val focus = FakeFocus()
        val controller = controller(FakeTtsEngine(), playback, focus)

        focus.emit(FocusEvent.LOST_TRANSIENT)
        assertEquals(TtsPlayState.IDLE, controller.snapshot.value.state, "没有朗读任务时焦点事件不应产生状态迁移")
        focus.emit(FocusEvent.GAINED)
        assertEquals(TtsPlayState.IDLE, controller.snapshot.value.state, "没有朗读任务时焦点事件不应产生状态迁移")
        assertTrue(playback.calls.isEmpty(), "空闲时不得无故操作播放器")
    }
}
