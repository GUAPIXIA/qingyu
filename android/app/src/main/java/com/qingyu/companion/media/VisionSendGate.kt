package com.qingyu.companion.media

/**
 * 发送前的识图闸口（阶段 6 S6-02：
 * 「模型请求按 provider 能力构造图像输入；**不支持时在发送前阻断**」）。
 *
 * 为什么必须是「发送前阻断」而不是「发出去等报错」：
 * 1. PC 侧 `imageErrorHint` 是**事后**补提示的兜底（请求已经发出去了）；S6-02 对 Android
 *    的要求更严——用户点了发送才发现「白等 30 秒 + 一条供应商报错」是最糟的反馈路径；
 * 2. 不支持视觉的模型收到图片请求，行为由网关决定：有的报错、有的**静默忽略图片**。
 *    静默忽略意味着模型回答里假装看过图——比报错更糟，必须在客户端就拦住；
 * 3. 伪 MIME / 坏引用同理：拼进请求体才炸，不如在闸口就给出中文原因。
 *
 * 本类只做决策与构造，不持有网络/存储；调用方拿到 [SendDecision.Blocked] 就地终止发送。
 */
data class VisionCapability(
    /** 当前解析出的模型/网关是否接受图像输入。 */
    val supportsImages: Boolean,
    /** 单条消息图片数上限。 */
    val maxImagesPerMessage: Int = 8,
    /** 单张图片解码后字节上限。 */
    val maxImageBytes: Long = 10L * 1024 * 1024,
    /** 该 provider 接受的图片 MIME 集合。 */
    val mimeTypes: Set<String> = MagicBytes.IMAGE_MIME_TYPES,
)

sealed interface SendDecision {
    /** 可以发送：[providerMessages] 已按 provider 能力构造好图像输入。 */
    data class Ready(
        val providerMessages: List<Map<String, Any?>>,
        val imageCount: Int,
    ) : SendDecision

    /** 发送前阻断：[reasons] 一条图片一条原因，全部可直接展示给用户。 */
    data class Blocked(val reasons: List<String>) : SendDecision
}

object VisionSendGate {
    /**
     * 决策：构造图像输入，或在**发出之前**阻断。
     *
     * 逐条校验顺序：能力 → 每条消息图片数 → 单图合法性（data URL、伪 MIME、MIME 支持、大小）。
     */
    fun plan(
        provider: VisionProvider,
        capability: VisionCapability,
        messages: List<VisionMessage>,
    ): SendDecision {
        val imageCount = messages.sumOf { it.images.size }
        if (imageCount == 0) {
            // 纯文本消息不需要任何视觉能力，永远放行
            return SendDecision.Ready(VisionImageInput.encode(provider, messages), imageCount = 0)
        }
        if (!capability.supportsImages) {
            return SendDecision.Blocked(
                listOf(
                    "当前模型不支持图像输入：带图消息已在发送前阻断" +
                        "（不支持视觉的模型可能静默忽略图片并假装看过，绝不允许发出后等报错）",
                ),
            )
        }
        val reasons = mutableListOf<String>()
        messages.forEachIndexed { messageIndex, message ->
            if (message.images.size > capability.maxImagesPerMessage) {
                reasons += "第 ${messageIndex + 1} 条消息带 ${message.images.size} 张图，超过单条上限 ${capability.maxImagesPerMessage} 张：发送前阻断"
            }
            message.images.forEachIndexed { imageIndex, raw ->
                checkImage(raw, capability)?.let { problem ->
                    reasons += "第 ${messageIndex + 1} 条消息第 ${imageIndex + 1} 张图：$problem"
                }
            }
        }
        if (reasons.isNotEmpty()) return SendDecision.Blocked(reasons)
        return SendDecision.Ready(VisionImageInput.encode(provider, messages), imageCount)
    }

    /** 单图校验：返回 null 表示通过，否则是中文原因。 */
    private fun checkImage(raw: String, capability: VisionCapability): String? {
        val parsed = VisionImages.parseDataUrl(raw)
            ?: return "不是合法的图片 data URL（伪 MIME/坏引用在发送前阻断，避免模型收到残缺输入）"
        val bytes = VisionImages.decode(parsed)
            ?: return "图片 base64 无法解码（损坏输入在发送前阻断）"
        val sniffed = MagicBytes.detectImageMime(bytes)
            ?: return "图片字节不含真实图片签名（伪 MIME 在发送前阻断，恶意图片不得进请求体）"
        if (sniffed != parsed.mimeType) {
            return "伪 MIME：data URL 声明 ${parsed.mimeType} 与真实格式 $sniffed 不符（发送前阻断）"
        }
        if (parsed.mimeType !in capability.mimeTypes) {
            return "该供应商不接受 ${parsed.mimeType} 图片输入（发送前阻断）"
        }
        if (bytes.size.toLong() > capability.maxImageBytes) {
            return "图片解码后 ${bytes.size / 1024} KiB，超过单图上限 ${capability.maxImageBytes / 1024} KiB（发送前阻断）"
        }
        return null
    }
}
