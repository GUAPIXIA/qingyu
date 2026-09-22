package com.qingyu.companion.tts

import org.junit.After
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * S6-03：朗读队列顺序、打断、暂停/恢复/停止状态机、缓存命中不重复合成、损坏音频拦截。
 * 断言消息写「违反了会有什么后果」，便于红灯时直接定位语义。
 */
class TtsQueueControllerTest {

    private lateinit var tempDir: java.io.File
    private lateinit var cache: FileTtsAudioCache

    @Before
    fun setUp() {
        tempDir = Files.createTempDirectory("tts-cache-test").toFile()
        cache = FileTtsAudioCache(tempDir)
    }

    @After
    fun tearDown() {
        tempDir.deleteRecursively()
    }

    private fun controller(
        engine: FakeTtsEngine,
        playback: FakePlayback,
        focus: FakeFocus,
    ): TtsQueueController = TtsQueueController(listOf(engine), cache, playback, focus)

    // ------------------------------------------------------------ 队列顺序与打断

    @Test
    fun `朗读队列按入队顺序推进-完成后自动播放下一项`() {
        val engine = FakeTtsEngine()
        val playback = FakePlayback()
        val controller = controller(engine, playback, FakeFocus())

        controller.enqueue(speakReq("a", "第一段"))
        controller.enqueue(speakReq("b", "第二段"))
        controller.enqueue(speakReq("c", "第三段"))

        assertEquals(
            listOf("第一段"),
            engine.requests.map { it.text },
            "队列必须串行合成：第一项未完成前不得插队合成后续项",
        )
        assertEquals(TtsPlayState.PLAYING, controller.snapshot.value.state, "首项音频就绪后应进入播放")

        playback.completePlayback()
        playback.completePlayback()
        playback.completePlayback()

        assertEquals(
            listOf("第一段", "第二段", "第三段"),
            engine.requests.map { it.text },
            "朗读顺序必须与入队顺序一致，乱序会让用户听到错位的上下文",
        )
        assertEquals(TtsPlayState.IDLE, controller.snapshot.value.state, "队列播完必须回到 IDLE")
    }

    @Test
    fun `打断清空待播队列并立即替换当前项`() {
        val engine = FakeTtsEngine()
        val playback = FakePlayback()
        val controller = controller(engine, playback, FakeFocus())

        controller.enqueue(speakReq("a", "旧的当前项"))
        controller.enqueue(speakReq("b", "旧的排队项"))
        controller.enqueue(speakReq("z", "打断项"), EnqueueMode.INTERRUPT)

        val snapshot = controller.snapshot.value
        assertEquals("打断项", snapshot.current?.requestId, "打断必须立即替换当前项")
        assertTrue(snapshot.pending.isEmpty(), "打断不清空待播队列会让旧请求在打断项之后继续播放")
        assertEquals(TtsPlayState.PLAYING, snapshot.state, "打断项应立即进入播放")
        assertEquals(
            listOf("play", "stop", "play"),
            playback.calls,
            "打断必须先停掉当前播放再播新项，否则两段音频会叠在一起",
        )
        assertEquals(
            listOf("旧的当前项", "打断项"),
            engine.requests.map { it.text },
            "被打断前排队的项不得再被合成",
        )

        playback.completePlayback()
        assertEquals(TtsPlayState.IDLE, controller.snapshot.value.state, "被打断的旧队列不得复活")
    }

    @Test
    fun `打断后迟到的合成结果被丢弃-不污染新项状态`() {
        val engine = FakeTtsEngine(deferCompletion = true)
        val playback = FakePlayback()
        val controller = controller(engine, playback, FakeFocus())

        controller.enqueue(speakReq("a", "旧项"))
        controller.enqueue(speakReq("z", "打断项"), EnqueueMode.INTERRUPT)

        engine.completeDeferred() // 旧项 a 的过期回调
        val snapshot = controller.snapshot.value
        assertEquals("z", snapshot.current?.requestId, "过期合成回调不得覆盖打断项")
        assertEquals(TtsPlayState.LOADING, snapshot.state, "过期回调不得把状态推进到播放")

        engine.completeDeferred() // 打断项 z
        assertEquals(TtsPlayState.PLAYING, controller.snapshot.value.state, "打断项正常完成后应进入播放")
    }

    // ------------------------------------------------------------ 暂停/恢复/停止状态机

    @Test
    fun `暂停恢复停止状态机-播放中暂停进入PAUSED并下推播放器`() {
        val engine = FakeTtsEngine()
        val playback = FakePlayback()
        val controller = controller(engine, playback, FakeFocus())

        controller.enqueue(speakReq("a", "朗读内容"))
        controller.pause()
        assertEquals(TtsPlayState.PAUSED, controller.snapshot.value.state, "播放中按暂停必须进入 PAUSED")
        assertEquals(
            listOf("play", "pause"),
            playback.calls,
            "暂停不下推到播放器的话音频会继续出声，等于没有暂停",
        )

        controller.resume()
        assertEquals(TtsPlayState.PLAYING, controller.snapshot.value.state, "暂停后恢复必须回到 PLAYING")
        assertEquals(
            listOf("play", "pause", "resume"),
            playback.calls,
            "恢复必须下推播放器从暂停点续播",
        )

        controller.stop()
        assertEquals(TtsPlayState.IDLE, controller.snapshot.value.state, "停止后必须回到 IDLE")
    }

    @Test
    fun `停止清空队列回到IDLE并放弃音频焦点`() {
        val engine = FakeTtsEngine()
        val playback = FakePlayback()
        val focus = FakeFocus()
        val controller = controller(engine, playback, focus)

        controller.enqueue(speakReq("a", "当前项"))
        controller.enqueue(speakReq("b", "排队项"))
        controller.stop()

        val snapshot = controller.snapshot.value
        assertEquals(TtsPlayState.IDLE, snapshot.state, "停止后必须回到 IDLE")
        assertTrue(snapshot.pending.isEmpty(), "停止不清空队列的话会继续朗读用户已叫停的内容")
        assertEquals(1, focus.abandonCount, "停止后不放弃音频焦点会挡住其他播放器拿回焦点")
        assertEquals(1, engine.synthesizeCount, "停止后不得再合成剩余队列")
    }

    @Test
    fun `加载中暂停-合成完成后不自动播放`() {
        val engine = FakeTtsEngine(deferCompletion = true)
        val playback = FakePlayback()
        val controller = controller(engine, playback, FakeFocus())

        controller.enqueue(speakReq("a", "慢合成内容"))
        assertEquals(TtsPlayState.LOADING, controller.snapshot.value.state, "合成未完成应处于 LOADING")

        controller.pause()
        engine.completeDeferred()

        assertEquals(TtsPlayState.PAUSED, controller.snapshot.value.state, "加载中暂停后音频就绪也不得自动播放")
        assertTrue(playback.playedPaths.isEmpty(), "用户已暂停却自动出声会吓到用户")

        controller.resume()
        assertEquals(TtsPlayState.PLAYING, controller.snapshot.value.state, "恢复后应立即播已就绪的音频")
        assertEquals(1, playback.playedPaths.size, "恢复后必须开始播放就绪音频")
    }

    @Test
    fun `单项合成失败记录错误并继续下一项`() {
        val engine = FakeTtsEngine(failWith = TtsError("HTTP_500", "供应商错误", retryable = true))
        val playback = FakePlayback()
        val controller = controller(engine, playback, FakeFocus())

        controller.enqueue(speakReq("a", "失败项"))
        engine.failWith = null
        controller.enqueue(speakReq("b", "后续项"))

        assertEquals(
            listOf("a", "b"),
            engine.requests.map { it.requestId },
            "单项失败必须继续下一项，整队卡死会让用户以为功能坏了",
        )
        assertEquals("b", controller.snapshot.value.current?.requestId, "失败项不得长期占据当前位")
        assertEquals("HTTP_500", controller.snapshot.value.lastError?.code, "失败原因必须记录下来供 UI/诊断展示")
    }

    @Test
    fun `单项播放失败记录错误并继续下一项`() {
        val engine = FakeTtsEngine()
        val playback = FakePlayback()
        val controller = controller(engine, playback, FakeFocus())

        controller.enqueue(speakReq("a", "解码失败项"))
        controller.enqueue(speakReq("b", "后续项"))
        playback.failPlayback("DECODE")

        assertEquals("b", controller.snapshot.value.current?.requestId, "播放失败必须推进下一项")
        assertEquals("PLAYBACK_ERROR", controller.snapshot.value.lastError?.code, "播放失败原因必须可追溯")
    }

    // ------------------------------------------------------------ 缓存

    @Test
    fun `缓存命中不重复合成-同一文本第二次直接播缓存`() {
        val engine = FakeTtsEngine()
        val playback = FakePlayback()
        val controller = controller(engine, playback, FakeFocus())

        controller.enqueue(speakReq("a", "同一段文本"))
        playback.completePlayback()
        controller.enqueue(speakReq("b", "同一段文本"))

        assertEquals(1, engine.synthesizeCount, "缓存命中后重复合成既费电又费流量，还拖慢朗读")
        assertEquals(2, playback.playedPaths.size, "第二次朗读仍必须出声")
        assertEquals(
            playback.playedPaths[0],
            playback.playedPaths[1],
            "缓存命中必须复用同一缓存文件，而不是另存一份",
        )
    }

    // ------------------------------------------------------------ 损坏音频拦截

    @Test
    fun `损坏音频被拦截-不播放不入库并记录错误`() {
        val engine = FakeTtsEngine(audio = corruptAudio())
        val playback = FakePlayback()
        val controller = controller(engine, playback, FakeFocus())
        val request = speakReq("a", "损坏产物")

        controller.enqueue(request)
        val snapshot = controller.snapshot.value

        assertTrue(playback.playedPaths.isEmpty(), "损坏音频喂给解码器会导致爆音/崩溃，必须拦截在播放之前")
        assertEquals(TtsPlayState.IDLE, snapshot.state, "损坏音频不得进入任何播放状态")
        assertEquals("AUDIO_CORRUPT", snapshot.lastError?.code, "损坏音频必须报错而不是静默吞掉")
        assertNull(
            cache.find(TtsCacheKeys.of(request)),
            "损坏音频不得入库为缓存，否则后续朗读会反复命中坏文件",
        )
    }
}
