package com.qingyu.companion.tts

import org.junit.Test
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 系统 TTS 引擎外壳：语言/音色列表透传、未就绪短路、合成委托。
 * （`android.speech.tts.TextToSpeech` 本体的桥接行为属真机验证项。）
 */
class SystemTtsEngineTest {

    @Test
    fun `系统引擎透传语言与音色列表`() {
        val voices = listOf(
            TtsVoice(id = "zh-CN-v1", engine = TtsEngineKind.SYSTEM, displayName = "中文音色", localeTag = "zh-CN"),
            TtsVoice(id = "en-US-v1", engine = TtsEngineKind.SYSTEM, displayName = "英文音色", localeTag = "en-US"),
        )
        val bridge = FakeSystemTtsBridge(voiceList = voices)
        val engine = SystemTtsEngine(bridge)

        assertEquals(voices, engine.voices(), "音色列表必须原样取自系统引擎，任何加工都可能引入名字猜测")
        assertEquals(
            listOf(TtsLanguage("zh-CN", "中文（中国）")),
            engine.languages(),
            "语言列表必须来自系统引擎实际可用语言",
        )
    }

    @Test
    fun `未就绪时直接失败不触碰桥接`() {
        val bridge = FakeSystemTtsBridge(ready = false)
        val engine = SystemTtsEngine(bridge)
        val results = mutableListOf<SynthResult>()

        engine.synthesize(speakReq(), "target.part", object : SynthCallback {
            override fun onResult(result: SynthResult) {
                results += result
            }
        })

        assertEquals(0, bridge.synthesizeCount, "未就绪时调用桥接会产生不可控行为")
        val failure = results.single() as SynthResult.Failure
        assertEquals("TTS_NOT_READY", failure.error.code, "未就绪必须显式报错，静默丢任务会让用户等一个永远不会响的朗读")
    }

    @Test
    fun `合成委托桥接并透传请求与结果`() {
        val bridge = FakeSystemTtsBridge()
        val engine = SystemTtsEngine(bridge)
        val request = speakReq(id = "a", text = "委托内容", voice = "zh-CN-fake", locale = "zh-CN")
        val results = mutableListOf<SynthResult>()
        val temp = Files.createTempDirectory("tts-system-test").toFile()

        try {
            val target = temp.resolve("out.part").absolutePath
            engine.synthesize(request, target, object : SynthCallback {
                override fun onResult(result: SynthResult) {
                    results += result
                }
            })

            assertEquals(listOf(request), bridge.requests, "合成请求必须原样委托给系统桥，不得改写文本或音色")
            assertTrue(results.single() is SynthResult.Ok, "桥接成功时结果必须透传成功")
        } finally {
            temp.deleteRecursively()
        }
    }
}
