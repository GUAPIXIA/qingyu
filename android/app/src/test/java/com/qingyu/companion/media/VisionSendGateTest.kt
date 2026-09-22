package com.qingyu.companion.media

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * 发送前阻断（S6-02：「不支持时在**发送前**阻断（不是发出去等报错）」；
 * §3：恶意图片、伪 MIME 必须被拦截）。
 */
class VisionSendGateTest {

    private val pngBase64 = java.util.Base64.getEncoder().encodeToString(MediaFixtures.realPng1x1)
    private val pngDataUrl = "data:image/png;base64,$pngBase64"
    private val jpegBase64 = java.util.Base64.getEncoder().encodeToString(MediaFixtures.jpeg())
    private val visionOn = VisionCapability(supportsImages = true)
    private val visionOff = VisionCapability(supportsImages = false)

    private fun blocked(capability: VisionCapability, messages: List<VisionMessage>, label: String): List<String> =
        assertIs<SendDecision.Blocked>(
            VisionSendGate.plan(VisionProvider.OPENAI, capability, messages),
            "$label：必须在发送前阻断，不支持视觉的模型会静默忽略图片并假装看过",
        ).reasons

    @Test
    fun `不支持视觉时带图请求在发送前阻断`() {
        val reasons = blocked(visionOff, listOf(VisionMessage("user", "这是什么", listOf(pngDataUrl))), "不支持视觉")
        assertTrue(reasons.any { it.contains("不支持") }, "阻断原因必须点名「不支持图像输入」（实际：$reasons）")
    }

    @Test
    fun `纯文本请求不受视觉能力影响`() {
        val ready = assertIs<SendDecision.Ready>(
            VisionSendGate.plan(VisionProvider.OPENAI, visionOff, listOf(VisionMessage("user", "你好"))),
            "纯文本请求不得被视觉能力闸口误伤：不带图的聊天会全线瘫痪",
        )
        assertEquals(0, ready.imageCount, "无图请求的图片计数必须为 0")
    }

    @Test
    fun `伪 MIME 与恶意图片表驱动：全部在发送前阻断`() {
        val cases = listOf(
            "data:image/png;base64,$jpegBase64" to "声明 PNG 实为 JPEG",
            "data:image/png;base64,${java.util.Base64.getEncoder().encodeToString("<html>x</html>".toByteArray())}" to "声明 PNG 实为 HTML",
            "data:image/png;base64,!!!" to "非法 base64",
            "content://media/1" to "content:// 引用",
            "/data/user/0/a.png" to "本地绝对路径",
        )
        for ((raw, label) in cases) {
            val reasons = blocked(visionOn, listOf(VisionMessage("user", "图", listOf(raw))), label)
            assertTrue(reasons.isNotEmpty(), "$label：必须给出阻断原因")
        }
    }

    @Test
    fun `能力上限表驱动：图片数超限、单图超大、MIME 不受支持`() {
        val manyImages = (1..3).map { pngDataUrl }
        val overCount = blocked(
            VisionCapability(supportsImages = true, maxImagesPerMessage = 2),
            listOf(VisionMessage("user", "图", manyImages)),
            "图片数超限",
        )
        assertTrue(overCount.any { it.contains("上限") }, "图片数超限的原因必须可展示（实际：$overCount）")

        val overSize = blocked(
            VisionCapability(supportsImages = true, maxImageBytes = 8),
            listOf(VisionMessage("user", "图", listOf(pngDataUrl))),
            "单图超大",
        )
        assertTrue(overSize.any { it.contains("上限") }, "单图超大的原因必须可展示（实际：$overSize）")

        val unsupportedMime = blocked(
            VisionCapability(supportsImages = true, mimeTypes = setOf(MagicBytes.MIME_JPEG)),
            listOf(VisionMessage("user", "图", listOf(pngDataUrl))),
            "MIME 不受该供应商支持",
        )
        assertTrue(unsupportedMime.any { it.contains("不接受") }, "MIME 不支持的原因必须可展示（实际：$unsupportedMime）")
    }

    @Test
    fun `能力齐备时产出 provider 形状的图像输入`() {
        val ready = assertIs<SendDecision.Ready>(
            VisionSendGate.plan(
                VisionProvider.OPENAI,
                visionOn,
                listOf(VisionMessage("user", "这是什么", listOf(pngDataUrl))),
            ),
            "带图合法请求必须放行并构造图像输入",
        )
        assertEquals(1, ready.imageCount, "图片计数错误：用量/预算估计会失真")
        val parts = assertIs<List<*>>(ready.providerMessages[0]["content"], "OpenAI 图像输入必须是 content parts")
        assertEquals("image_url", (parts[1] as Map<*, *>)["type"], "图像输入形状错误")

        val ollama = assertIs<SendDecision.Ready>(
            VisionSendGate.plan(
                VisionProvider.OLLAMA,
                visionOn,
                listOf(VisionMessage("user", "这是什么", listOf(pngDataUrl))),
            ),
            "Ollama 带图合法请求必须放行",
        )
        assertEquals(listOf(pngBase64), ollama.providerMessages[0]["images"], "Ollama 图像输入必须是纯 base64 列表")
    }

    @Test
    fun `一条消息多张图逐张校验，坏图不会被静默丢掉`() {
        val reasons = blocked(
            visionOn,
            listOf(VisionMessage("user", "图", listOf(pngDataUrl, "data:image/png;base64,!!!"))),
            "混入坏图",
        )
        assertEquals(1, reasons.size, "只有坏图应被点名（实际：$reasons）")
        assertTrue(reasons[0].contains("第 1 条消息第 2 张图"), "阻断原因必须指出是哪张图（实际：${reasons[0]}）")
    }
}
