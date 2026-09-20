package com.qingyu.companion.local.domain

import com.qingyu.companion.domain.contracts.CanonicalJson
import java.security.MessageDigest

/**
 * 阶段 1/3 同步信封（规范实体信封，总方案 §6.2）。
 *
 * - `version` 是版本向量：`{"deviceId": "<UInt64 十进制字符串>"}`。
 * - `contentHash` 对 canonical JSON 计算，排除 `updatedAt` 等非业务字段。
 * - 新 ID 使用 ULID；保留旧 ID，迁移时不批量改名。
 */
data class LocalEnvelope(
    val entityType: String,
    val entityId: String,
    val payload: Map<String, Any?>,
    val deviceId: String,
    val counter: String,
    val version: Map<String, String>,
    val deleted: Boolean = false,
    val updatedAt: Long = System.currentTimeMillis(),
    val contentHash: String = MigrationIdentity.contentHash(if (deleted) emptyMap() else payload),
) {
    fun toJson(): String = CanonicalJson.encode(
        mapOf(
            "contractVersion" to CONTRACT_VERSION,
            "entityType" to entityType,
            "entityId" to entityId,
            "deleted" to deleted,
            "updatedAt" to updatedAt,
            "contentHash" to contentHash,
            "version" to version,
            "dot" to mapOf("deviceId" to deviceId, "counter" to counter),
            "payload" to payload,
        ),
    )

    companion object {
        const val CONTRACT_VERSION = 1
    }
}

fun sha256Hex(text: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
    return buildString(digest.size * 2) {
        digest.forEach { append("%02x".format(it)) }
    }
}
