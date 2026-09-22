package com.qingyu.companion.media

/**
 * 识图模型解析（与 PC `shared/chat-core/visionModel.ts` 逐字段对齐，矩阵行
 * `chat.imageAttachVision` 的模型选择语义保持 same）。
 *
 * PC 的规则：上下文含图片且配置了激活的识图模型 → 本轮请求走识图模型；
 * 否则回退主对话模型。识图模型支持两种配置（字段级回退）：
 * - 只填模型名：provider/baseUrl/apiKey 复用当前对话 Profile；
 * - 完整独立配置：留空的字段仍回退 Profile。
 *
 * 与 PC 同样不读任何 store：识图模型与回退 Profile 由调用方显式传入。
 * 与 PC 的差别只有一处（S6-02 要求）：解析结果为空且上下文带图时，
 * 由 `VisionSendGate` 按主模型能力**发送前阻断**，而不是发出去等报错。
 */
data class VisionModelConfig(
    val provider: String? = null,
    val model: String? = null,
    val baseUrl: String? = null,
    val apiKey: String? = null,
) {
    // 密钥不得进日志/诊断
    override fun toString(): String =
        "VisionModelConfig(provider=$provider, model=$model, baseUrl=$baseUrl, apiKey=<redacted>)"
}

data class ChatProfileFallback(
    val provider: String? = null,
    val baseUrl: String? = null,
    val apiKey: String? = null,
) {
    override fun toString(): String =
        "ChatProfileFallback(provider=$provider, baseUrl=$baseUrl, apiKey=<redacted>)"
}

data class ResolvedVisionModel(
    val provider: String,
    val model: String,
    val baseUrl: String,
    val apiKey: String,
) {
    override fun toString(): String =
        "ResolvedVisionModel(provider=$provider, model=$model, baseUrl=$baseUrl, apiKey=<redacted>)"
}

object VisionModelResolver {
    const val DEFAULT_PROVIDER = "openai"

    /**
     * 解析本轮请求应使用的识图模型连接：
     * 上下文含图片且激活了识图模型 → 完整连接（缺省字段回退当前 Profile）；
     * 否则 null（使用主对话模型，是否可带图交给 `VisionSendGate` 判）。
     */
    fun resolve(
        messages: List<VisionMessage>,
        vision: VisionModelConfig?,
        fallback: ChatProfileFallback?,
    ): ResolvedVisionModel? {
        if (!VisionImages.contextHasImages(messages)) return null
        if (vision == null) return null
        val model = vision.model?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val provider = vision.provider?.trim()?.takeIf { it.isNotEmpty() }
            ?: fallback?.provider?.trim()?.takeIf { it.isNotEmpty() }
            ?: DEFAULT_PROVIDER
        val baseUrl = vision.baseUrl?.trim()?.takeIf { it.isNotEmpty() }
            ?: fallback?.baseUrl?.trim()?.takeIf { it.isNotEmpty() }
            ?: ""
        val apiKey = vision.apiKey?.trim()?.takeIf { it.isNotEmpty() }
            ?: fallback?.apiKey?.trim()?.takeIf { it.isNotEmpty() }
            ?: ""
        return ResolvedVisionModel(
            provider = provider,
            model = model,
            baseUrl = baseUrl,
            apiKey = apiKey,
        )
    }
}
