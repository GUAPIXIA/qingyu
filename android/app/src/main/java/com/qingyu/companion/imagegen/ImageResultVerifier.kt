package com.qingyu.companion.imagegen

import java.security.MessageDigest

/**
 * 生成结果下载后的校验（阶段 6 S6-04：下载、校验、保存为 media entity 的中间一步）。
 *
 * 校验项：
 * - 非空、大小上限（防超大响应撑爆存储）；
 * - magic bytes 嗅探，声明 MIME 与实际内容必须一致（防伪 MIME）；
 * - 可选 sha256 期望值比对（远端提供或调用侧已知时）。
 */
data class VerifiedImage(
    val mimeType: String,
    val bytes: ByteArray,
    val sha256Hex: String,
    val byteSize: Long,
) {
    /** 与 PC 生图结果一致的 data URL 形态（仅供展示/桥接层使用）。 */
    fun toDataUrl(): String {
        val base64 = java.util.Base64.getEncoder().encodeToString(bytes)
        return "data:$mimeType;base64,$base64"
    }

    override fun toString(): String = "VerifiedImage(mimeType=$mimeType, byteSize=$byteSize, sha256=$sha256Hex)"
}

object ImageResultVerifier {

    /** 单张生成图的大小上限（安全边界；超过即拒绝保存）。 */
    const val DEFAULT_MAX_BYTES: Long = 20L * 1024 * 1024

    val SUPPORTED_MIME_TYPES: Set<String> = setOf("image/png", "image/jpeg", "image/webp", "image/gif")

    sealed class Result {
        data class Ok(val image: VerifiedImage) : Result()
        data class Rejected(val failure: ImageGenFailure) : Result()
    }

    /**
     * 校验生成结果字节。
     *
     * @param declaredMime 端点声明的 MIME（响应 content-type 或结果约定），可空；
     *   非空时必须与 magic bytes 嗅探结果一致。
     * @param expectedSha256Hex 期望 sha256（小写十六进制）；非空时必须匹配。
     */
    fun verify(
        bytes: ByteArray,
        declaredMime: String?,
        expectedSha256Hex: String? = null,
        maxBytes: Long = DEFAULT_MAX_BYTES,
    ): Result {
        if (bytes.isEmpty()) {
            return Result.Rejected(
                ImageGenFailure(ImageGenFailureKind.EMPTY_RESULT, "EMPTY_IMAGE", "生成结果为空，已拒绝保存", false),
            )
        }
        if (bytes.size > maxBytes) {
            return Result.Rejected(
                ImageGenFailure(
                    ImageGenFailureKind.VALIDATION, "IMAGE_TOO_LARGE",
                    "生成结果超过大小上限（${bytes.size} > $maxBytes 字节），已拒绝保存", false,
                ),
            )
        }
        val sniffed = sniffMime(bytes)
            ?: return Result.Rejected(
                ImageGenFailure(
                    ImageGenFailureKind.PROTOCOL, "UNKNOWN_IMAGE_FORMAT",
                    "生成结果不是可识别的图片格式，已拒绝保存", false,
                ),
            )
        val declared = normalizeMime(declaredMime)
        if (declared != null && declared.startsWith("image/") && declared != sniffed) {
            return Result.Rejected(
                ImageGenFailure(
                    ImageGenFailureKind.PROTOCOL, "MIME_MISMATCH",
                    "声明的图片类型（$declared）与实际内容（$sniffed）不符，已拒绝保存", false,
                ),
            )
        }
        val sha256 = sha256Hex(bytes)
        if (!expectedSha256Hex.isNullOrBlank() && !expectedSha256Hex.equals(sha256, ignoreCase = true)) {
            return Result.Rejected(
                ImageGenFailure(
                    ImageGenFailureKind.VALIDATION, "IMAGE_HASH_MISMATCH",
                    "生成结果哈希校验失败（期望 $expectedSha256Hex，实际 $sha256），已拒绝保存", false,
                ),
            )
        }
        return Result.Ok(VerifiedImage(sniffed, bytes, sha256, bytes.size.toLong()))
    }

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** MIME 归一化：去参数、小写、常见别名合并；空返回 null。 */
    fun normalizeMime(raw: String?): String? {
        val base = raw?.substringBefore(';')?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        return if (base == "image/jpg") "image/jpeg" else base
    }

    /** magic bytes 嗅探；未知格式返回 null。 */
    fun sniffMime(bytes: ByteArray): String? {
        fun hasPrefix(prefix: ByteArray): Boolean {
            if (bytes.size < prefix.size) return false
            for (i in prefix.indices) if (bytes[i] != prefix[i]) return false
            return true
        }
        return when {
            hasPrefix(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)) -> "image/png"
            hasPrefix(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte())) -> "image/jpeg"
            hasPrefix("GIF87a".toByteArray()) || hasPrefix("GIF89a".toByteArray()) -> "image/gif"
            hasPrefix("RIFF".toByteArray()) &&
                bytes.size >= 12 &&
                String(bytes, 8, 4, Charsets.US_ASCII) == "WEBP" -> "image/webp"
            else -> null
        }
    }
}
