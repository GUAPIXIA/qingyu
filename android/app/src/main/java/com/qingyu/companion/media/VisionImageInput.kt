package com.qingyu.companion.media

import java.util.Base64

/**
 * 识图消息模型与**各 provider 图像输入构造**（阶段 6 S6-02：
 * 「模型请求按 provider 能力构造图像输入」）。
 *
 * 形状与 PC `electron/services/adapters/vision.ts` 逐字段对齐（矩阵行
 * `chat.imageAttachVision` 的 platformPolicy=equivalent）：
 * - OpenAI 兼容：content 数组 `[{"type":"text"},{"type":"image_url","image_url":{"url":dataUrl}}]`；
 * - Claude：content 数组 `[{"type":"text"},{"type":"image","source":{"type":"base64",…}}]`；
 * - Gemini：`parts` 数组 `[{"text"},{"inline_data":{…}}]`（role：assistant→model）；
 * - Ollama：消息级 `images` 字段（**纯 base64**，不带 data: 前缀）。
 *
 * 无图片消息保持 `content` 字符串原样（与 PC 相同）：不支持视觉的服务也能继续吃纯文本消息。
 *
 * 约定：[VisionMessage.images] 是 data URL 数组（`data:image/png;base64,…`），
 * 与 PC `ChatParams.messages[].images` 同语义。
 */
enum class VisionProvider(val wire: String) {
    OPENAI("openai"),
    ANTHROPIC("anthropic"),
    GEMINI("gemini"),
    OLLAMA("ollama"),
    ;

    companion object {
        fun fromWire(value: String?): VisionProvider? =
            entries.firstOrNull { it.wire == value?.trim()?.lowercase() }
    }
}

/** 参与识图构造的消息（images 为 data URL 数组）。 */
data class VisionMessage(
    val role: String,
    val content: String,
    val images: List<String> = emptyList(),
)

/** 解析后的图片引用：[base64] 是不含 data: 前缀的纯 base64。 */
data class ParsedImage(
    val mimeType: String,
    val base64: String,
) {
    /** 规范化后的 data URL（重新序列化，不回显原始字符串里的空白/大小写噪声）。 */
    val dataUrl: String get() = "data:$mimeType;base64,$base64"
}

object VisionImages {
    /** 与 PC `vision.ts` 的 `parseImageDataUrl` 同一正则与容错语义。 */
    private val DATA_URL = Regex("^data:(image/[\\w.+-]+);base64,([A-Za-z0-9+/= \\t\\r\\n]+)$")

    fun parseDataUrl(raw: String): ParsedImage? {
        val matched = DATA_URL.matchEntire(raw.trim()) ?: return null
        val mime = MagicBytes.normalizeMime(matched.groupValues[1]) ?: return null
        if (mime !in MagicBytes.IMAGE_MIME_TYPES) return null
        val data = matched.groupValues[2].filter { !it.isWhitespace() }
        if (data.isEmpty()) return null
        // 必须真的是合法 base64：`parseImageDataUrl` 只验字符集，这里连解码一起验
        runCatching { Base64.getDecoder().decode(data) }.getOrNull() ?: return null
        return ParsedImage(mimeType = mime, base64 = data)
    }

    /** 解出图片字节（伪 MIME / 大小 / 魔数校验用）。 */
    fun decode(image: ParsedImage): ByteArray? =
        runCatching { Base64.getDecoder().decode(image.base64) }.getOrNull()

    fun contextHasImages(messages: List<VisionMessage>): Boolean =
        messages.any { it.images.isNotEmpty() }
}

/**
 * 各 provider 的消息编码。输出是「JSON 就绪」的 Map/List 结构（不绑定任何序列化库），
 * 由网络层适配器序列化进请求体。
 */
object VisionImageInput {
    fun encode(provider: VisionProvider, messages: List<VisionMessage>): List<Map<String, Any?>> =
        when (provider) {
            VisionProvider.OPENAI -> messages.map { encodeOpenAi(it) }
            VisionProvider.ANTHROPIC -> messages.map { encodeAnthropic(it) }
            VisionProvider.GEMINI -> messages.map { encodeGemini(it) }
            VisionProvider.OLLAMA -> messages.map { encodeOllama(it) }
        }

    private fun parsedOrNull(message: VisionMessage): List<ParsedImage> =
        message.images.mapNotNull { VisionImages.parseDataUrl(it) }

    private fun encodeOpenAi(message: VisionMessage): Map<String, Any?> {
        val images = parsedOrNull(message)
        if (images.isEmpty()) return mapOf("role" to message.role, "content" to message.content)
        val parts = mutableListOf<Any>(
            mapOf("type" to "text", "text" to message.content),
        )
        images.forEach { parts += mapOf("type" to "image_url", "image_url" to mapOf("url" to it.dataUrl)) }
        return mapOf("role" to message.role, "content" to parts)
    }

    private fun encodeAnthropic(message: VisionMessage): Map<String, Any?> {
        val images = parsedOrNull(message)
        if (images.isEmpty()) return mapOf("role" to message.role, "content" to message.content)
        val parts = mutableListOf<Any>(
            mapOf("type" to "text", "text" to message.content),
        )
        images.forEach {
            parts += mapOf(
                "type" to "image",
                "source" to mapOf("type" to "base64", "media_type" to it.mimeType, "data" to it.base64),
            )
        }
        return mapOf("role" to message.role, "content" to parts)
    }

    private fun encodeGemini(message: VisionMessage): Map<String, Any?> {
        val images = parsedOrNull(message)
        val role = if (message.role == "assistant") "model" else "user"
        val parts = mutableListOf<Any>(mapOf("text" to message.content))
        images.forEach {
            parts += mapOf("inline_data" to mapOf("mime_type" to it.mimeType, "data" to it.base64))
        }
        return mapOf("role" to role, "parts" to parts)
    }

    private fun encodeOllama(message: VisionMessage): Map<String, Any?> {
        val images = parsedOrNull(message)
        val base = mapOf("role" to message.role, "content" to message.content)
        if (images.isEmpty()) return base
        // Ollama 只收纯 base64：带 data: 前缀会被当成坏图悄悄丢掉，用户以为发了图
        return base + ("images" to images.map { it.base64 })
    }
}
