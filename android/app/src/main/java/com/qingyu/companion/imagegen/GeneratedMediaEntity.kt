package com.qingyu.companion.imagegen

/**
 * 生成结果保存为 media entity 的数据形状与校验（阶段 6 S6-04）。
 *
 * 本文件只定义**数据形状与校验**；落库/媒体清单（media manifest）接线由主代理完成。
 * 可选绑定消息或角色：[MediaEntityBinding]。
 */
sealed class MediaEntityBinding {
    data class Message(val messageId: String) : MediaEntityBinding()
    data class Character(val characterId: String) : MediaEntityBinding()
}

/**
 * 生图结果的 media entity 视图（与同步实体 `media_manifest` 的本地侧形状对齐）。
 *
 * `sha256` 为内容寻址标识（小写十六进制）；`bytes` 不随同步实体传输（blob 另走加密通道）。
 */
data class GeneratedMediaEntity(
    val entityId: String,
    val mimeType: String,
    val byteSize: Long,
    val sha256: String,
    val sourceProvider: String,
    val prompt: String?,
    val createdAt: Long,
    val binding: MediaEntityBinding?,
)

object GeneratedMediaEntityFactory {

    /** 显式保存的提示词长度上限（超出截断由调用侧决定，这里直接拒绝畸形输入）。 */
    const val MAX_PROMPT_CHARS: Int = 4000

    sealed class BuildResult {
        data class Ok(val entity: GeneratedMediaEntity) : BuildResult()
        data class Rejected(val failure: ImageGenFailure) : BuildResult()
    }

    private fun reject(code: String, message: String): BuildResult.Rejected =
        BuildResult.Rejected(ImageGenFailure(ImageGenFailureKind.VALIDATION, code, message, false))

    /**
     * 由已校验图片构造 media entity 数据形状。
     *
     * 校验：entityId 非空且不含路径/URI 特征（同步 envelope 禁止绝对路径、`file://` 等）；
     * MIME 必须是支持的图片类型；大小与哈希与 [VerifiedImage] 自洽；绑定目标 ID 同样不得含路径特征。
     */
    fun create(
        entityId: String,
        image: VerifiedImage,
        sourceProvider: String,
        prompt: String?,
        createdAt: Long,
        binding: MediaEntityBinding? = null,
    ): BuildResult {
        if (!isSafeEntityId(entityId)) {
            return reject("BAD_ENTITY_ID", "media entity ID 为空或包含非法字符，已拒绝保存")
        }
        val mime = ImageResultVerifier.normalizeMime(image.mimeType)
        if (mime == null || mime !in ImageResultVerifier.SUPPORTED_MIME_TYPES) {
            return reject("BAD_MIME", "media entity 的图片类型不受支持（${image.mimeType}），已拒绝保存")
        }
        if (image.bytes.isEmpty() || image.byteSize <= 0 || image.byteSize != image.bytes.size.toLong()) {
            return reject("BAD_SIZE", "media entity 的大小与图片内容不一致，已拒绝保存")
        }
        if (!image.sha256Hex.matches(Regex("[0-9a-f]{64}"))) {
            return reject("BAD_HASH", "media entity 的哈希不是合法 sha256（小写十六进制），已拒绝保存")
        }
        if (ImageResultVerifier.sha256Hex(image.bytes) != image.sha256Hex) {
            return reject("HASH_MISMATCH", "media entity 的哈希与图片内容不一致，已拒绝保存")
        }
        if (createdAt <= 0) {
            return reject("BAD_TIMESTAMP", "media entity 的创建时间非法，已拒绝保存")
        }
        if (prompt != null && prompt.length > MAX_PROMPT_CHARS) {
            return reject("PROMPT_TOO_LONG", "media entity 的提示词超过 $MAX_PROMPT_CHARS 字符，已拒绝保存")
        }
        val bindingError = validateBinding(binding)
        if (bindingError != null) return BuildResult.Rejected(bindingError)
        return BuildResult.Ok(
            GeneratedMediaEntity(
                entityId = entityId,
                mimeType = mime,
                byteSize = image.byteSize,
                sha256 = image.sha256Hex,
                sourceProvider = sourceProvider,
                prompt = prompt,
                createdAt = createdAt,
                binding = binding,
            ),
        )
    }

    /** 绑定接口的独立校验（消息/角色二选一或不绑）；合法返回 null。 */
    fun validateBinding(binding: MediaEntityBinding?): ImageGenFailure? = when (binding) {
        null -> null
        is MediaEntityBinding.Message ->
            if (isSafeEntityId(binding.messageId)) {
                null
            } else {
                ImageGenFailure(
                    ImageGenFailureKind.VALIDATION, "BAD_BINDING",
                    "消息绑定 ID 为空或包含非法字符，已拒绝保存", false,
                )
            }
        is MediaEntityBinding.Character ->
            if (isSafeEntityId(binding.characterId)) {
                null
            } else {
                ImageGenFailure(
                    ImageGenFailureKind.VALIDATION, "BAD_BINDING",
                    "角色绑定 ID 为空或包含非法字符，已拒绝保存", false,
                )
            }
    }

    /** ID 安全形状：非空、无空白、无路径分隔符、无 scheme（禁 `file://` 等 URI 特征）。 */
    internal fun isSafeEntityId(id: String): Boolean {
        if (id.isBlank()) return false
        if (id.any { it.isWhitespace() }) return false
        if (id.contains('/') || id.contains('\\') || id.contains("..")) return false
        if (id.contains("://") || id.contains(':')) return false
        return true
    }
}
