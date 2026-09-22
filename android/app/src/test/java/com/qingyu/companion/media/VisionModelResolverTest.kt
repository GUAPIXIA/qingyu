package com.qingyu.companion.media

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 识图模型解析（与 PC `shared/chat-core/visionModel.ts` 及其单测同一语义：字段级回退）。
 */
class VisionModelResolverTest {

    private val pngDataUrl =
        "data:image/png;base64," + java.util.Base64.getEncoder().encodeToString(MediaFixtures.realPng1x1)
    private val withImages = listOf(VisionMessage("user", "看图", listOf(pngDataUrl)))
    private val noImages = listOf(VisionMessage("user", "纯文本"))
    private val fallback = ChatProfileFallback(provider = "ollama", baseUrl = "http://pc:11434", apiKey = "sk-main")

    @Test
    fun `无图上下文一律返回 null（走主对话模型）`() {
        assertNull(
            VisionModelResolver.resolve(noImages, VisionModelConfig(model = "gpt-4o-vision"), fallback),
            "无图上下文不得切识图模型：普通聊天会被错误路由",
        )
    }

    @Test
    fun `未配置识图模型返回 null，交由发送闸口判主模型能力`() {
        assertNull(
            VisionModelResolver.resolve(withImages, null, fallback),
            "未配置识图模型时应返回 null（是否可带图由 VisionSendGate 发送前判定）",
        )
        assertNull(
            VisionModelResolver.resolve(withImages, VisionModelConfig(model = "  "), fallback),
            "模型名为空白等同未配置，否则会发出空模型名请求",
        )
    }

    @Test
    fun `只填模型名：连接参数字段级回退到当前 Profile`() {
        val resolved = assertNotNull(
            VisionModelResolver.resolve(withImages, VisionModelConfig(model = "qwen-vl"), fallback),
            "带图 + 配置识图模型必须解析出连接",
        )
        assertEquals("qwen-vl", resolved.model, "模型名必须取识图模型配置")
        assertEquals("ollama", resolved.provider, "provider 未填时必须回退 Profile")
        assertEquals("http://pc:11434", resolved.baseUrl, "baseUrl 未填时必须回退 Profile")
        assertEquals("sk-main", resolved.apiKey, "apiKey 未填时必须回退 Profile")
    }

    @Test
    fun `完整独立配置生效，留空字段仍回退`() {
        val resolved = assertNotNull(
            VisionModelResolver.resolve(
                withImages,
                VisionModelConfig(provider = "openai", model = "gpt-4o", baseUrl = "https://api.openai.com/v1", apiKey = "sk-vision"),
                fallback,
            ),
            "完整配置必须解析出连接",
        )
        assertEquals("openai", resolved.provider, "显式 provider 必须覆盖 Profile")
        assertEquals("https://api.openai.com/v1", resolved.baseUrl, "显式 baseUrl 必须覆盖 Profile")
        assertEquals("sk-vision", resolved.apiKey, "显式 apiKey 必须覆盖 Profile")

        val partial = assertNotNull(
            VisionModelResolver.resolve(withImages, VisionModelConfig(model = "gpt-4o"), fallback = null),
            "没有 Profile 时也必须能解析（本地网关常无鉴权）",
        )
        assertEquals("openai", partial.provider, "provider 缺省按 PC 同语义回落 openai")
        assertEquals("", partial.baseUrl, "无 baseUrl 来源时留空由网络层报错，不得编造地址")
    }

    @Test
    fun `toString 不得泄露 apiKey（诊断与日志安全）`() {
        val config = VisionModelConfig(model = "m", apiKey = "sk-secret")
        val resolved = ResolvedVisionModel(provider = "openai", model = "m", baseUrl = "u", apiKey = "sk-secret")
        val fallbackShown = ChatProfileFallback(apiKey = "sk-secret")
        for (shown in listOf(config.toString(), resolved.toString(), fallbackShown.toString())) {
            assertTrue(!shown.contains("sk-secret"), "toString 泄露 apiKey：诊断包/日志会把密钥带出去（实际：$shown）")
        }
    }
}
