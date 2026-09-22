package com.qingyu.companion.media

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * data URL 解析与四家 provider 的图像输入构造
 * （S6-02：「模型请求按 provider 能力构造图像输入」；与 PC `vision.ts` 形状逐字段对齐）。
 */
class VisionImageInputTest {

    private val pngBase64: String = java.util.Base64.getEncoder().encodeToString(MediaFixtures.realPng1x1)
    private val pngDataUrl = "data:image/png;base64,$pngBase64"

    @Test
    fun `data URL 解析表驱动：合法、空白、非法、非图片 MIME`() {
        val ok = assertIs<ParsedImage>(
            VisionImages.parseDataUrl(pngDataUrl),
            "标准 data URL 解析失败：识图全线不可用",
        )
        assertEquals(MagicBytes.MIME_PNG, ok.mimeType, "MIME 解析错误")
        assertEquals(pngBase64, ok.base64, "base64 必须剥掉 data: 头，Ollama 直接用它")

        val withSpace = assertIs<ParsedImage>(
            VisionImages.parseDataUrl("  data:image/png;base64,${pngBase64.chunked(8).joinToString(" ")}  "),
            "带空白的 base64 必须容忍（PC 同语义），否则换行粘贴的图被误杀",
        )
        assertEquals(pngBase64, withSpace.base64, "空白剥离后必须还原原始 base64")

        val bad = listOf(
            "",
            "not-a-data-url",
            "data:image/png,rawbytes",
            "data:text/plain;base64,aGVsbG8=",
            "data:application/pdf;base64,JVBERi0=",
            "data:image/png;base64,!!!not-base64!!!",
            "data:image/png;base64,",
        )
        for (raw in bad) {
            assertNull(VisionImages.parseDataUrl(raw), "「$raw」不得解析成图片：伪 MIME/坏引用会混进请求体")
        }
    }

    @Test
    fun `OpenAI：带图消息 content 变数组，无图消息保持字符串`() {
        val messages = listOf(
            VisionMessage("user", "看图", listOf(pngDataUrl, pngDataUrl)),
            VisionMessage("assistant", "好的"),
        )
        val encoded = VisionImageInput.encode(VisionProvider.OPENAI, messages)
        val first = encoded[0]
        val parts = assertIs<List<*>>(first["content"], "OpenAI 带图消息的 content 必须是数组（content parts）")
        assertEquals("text", (parts[0] as Map<*, *>)["type"], "第一个 part 必须是 text")
        val imagePart = parts[1] as Map<*, *>
        assertEquals("image_url", imagePart["type"], "图片 part 类型错误：OpenAI 网关会拒收")
        assertEquals(pngDataUrl, ((imagePart["image_url"] as Map<*, *>)["url"]), "OpenAI 图片必须回传完整 data URL")
        assertEquals("好的", encoded[1]["content"], "无图消息必须保持 content 字符串原样（不支持视觉的服务要能继续吃）")
    }

    @Test
    fun `Claude：image source 带 media_type 与纯 base64`() {
        val encoded = VisionImageInput.encode(
            VisionProvider.ANTHROPIC,
            listOf(VisionMessage("user", "看图", listOf(pngDataUrl))),
        )
        val parts = assertIs<List<*>>(encoded[0]["content"], "Claude 带图消息的 content 必须是数组")
        val source = (parts[1] as Map<*, *>)["source"] as Map<*, *>
        assertEquals("base64", source["type"], "Claude 图片 source 类型错误")
        assertEquals(MagicBytes.MIME_PNG, source["media_type"], "Claude 必须显式传 media_type，否则 400")
        assertEquals(pngBase64, source["data"], "Claude 的 data 必须是纯 base64（不带 data: 前缀）")
    }

    @Test
    fun `Gemini：parts + inline_data，assistant 角色映射为 model`() {
        val encoded = VisionImageInput.encode(
            VisionProvider.GEMINI,
            listOf(
                VisionMessage("user", "看图", listOf(pngDataUrl)),
                VisionMessage("assistant", "描述"),
            ),
        )
        val parts = assertIs<List<*>>(encoded[0]["parts"], "Gemini 消息必须是 parts 形状")
        val inline = (parts[1] as Map<*, *>)["inline_data"] as Map<*, *>
        assertEquals(MagicBytes.MIME_PNG, inline["mime_type"], "Gemini inline_data 必须带 mime_type")
        assertEquals(pngBase64, inline["data"], "Gemini inline_data 必须是纯 base64")
        assertEquals("user", encoded[0]["role"], "Gemini user 角色保持不变")
        assertEquals("model", encoded[1]["role"], "Gemini 的 assistant 角色必须映射成 model，否则 API 400")
    }

    @Test
    fun `Ollama：消息级 images 字段是纯 base64 且无图消息不带该字段`() {
        val encoded = VisionImageInput.encode(
            VisionProvider.OLLAMA,
            listOf(
                VisionMessage("user", "看图", listOf(pngDataUrl)),
                VisionMessage("user", "纯文本"),
            ),
        )
        assertEquals(listOf(pngBase64), encoded[0]["images"], "Ollama 只收纯 base64：带 data: 前缀会被静默丢图，用户以为发了图")
        assertTrue(!encoded[1].containsKey("images"), "无图消息不得带 images 字段（与 PC toOllamaMessages 一致）")
    }

    @Test
    fun `encode 与 parseDataUrl 共用同一容错：坏引用不产出图片 part`() {
        val encoded = VisionImageInput.encode(
            VisionProvider.OPENAI,
            listOf(VisionMessage("user", "看图", listOf("data:image/png;base64,!!!"))),
        )
        assertEquals("看图", encoded[0]["content"], "坏引用必须退回纯文本 content，而不是产出残缺图片 part")
    }
}
