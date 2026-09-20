package com.qingyu.companion.local.domain

import com.qingyu.companion.domain.contracts.CanonicalJson
import java.security.MessageDigest

/**
 * 阶段 1/3 同步信封（规范实体信封，总方案 §6.2）。
 *
 * - `version` 是版本向量：`{"deviceId": "<UInt64 十进制字符串>"}`。
 * - `contentHash` 对 canonical JSON 计算，排除 `updatedAt` 等非业务字段。
 * - 新 ID 使用 ULID；保留旧 ID，迁移时不批量改名。
 * - **`parentId` 与 `schemaVersion` 是契约必填键**（`shared/contracts/schemas/sync-envelope.schema.json`
 *   的 `required` 里有它们，`additionalProperties:false`）：`parentId` 是 §6.3 跨实体不变量
 *   （角色—会话—消息、会话—记忆…）的唯一来源，Sync Core 要靠它做 delete fence / 孤儿检测；
 *   `schemaVersion` 是 payload 迁移注册表（`shared/contracts/migrations.ts` 只允许 N→N+1）的入口。
 *   本类此前**两个键都没发**——PC 的 `makeEnvelope` 一直有，属 Android 单边不合契约。
 */
data class LocalEnvelope(
    val entityType: String,
    val entityId: String,
    val payload: Map<String, Any?>,
    val deviceId: String,
    val counter: String,
    val version: Map<String, String>,
    val parentId: String? = null,
    val schemaVersion: Int = DEFAULT_SCHEMA_VERSION,
    val deleted: Boolean = false,
    val updatedAt: Long = System.currentTimeMillis(),
    val contentHash: String = MigrationIdentity.contentHash(if (deleted) emptyMap() else payload),
) {
    fun toJson(): String = CanonicalJson.encode(
        mapOf(
            "contractVersion" to CONTRACT_VERSION,
            "entityType" to entityType,
            "entityId" to entityId,
            "parentId" to parentId,
            "schemaVersion" to schemaVersion,
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

        /** PC 的 `makeEnvelope` 缺省也是 1；目前所有实体类型都还没有 N→N+1 迁移步骤。 */
        const val DEFAULT_SCHEMA_VERSION = 1
    }
}

fun sha256Hex(text: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
    return buildString(digest.size * 2) {
        digest.forEach { append("%02x".format(it)) }
    }
}
