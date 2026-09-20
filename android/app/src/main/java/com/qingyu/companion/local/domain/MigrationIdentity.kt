package com.qingyu.companion.local.domain

import com.qingyu.companion.domain.contracts.CanonicalJson

/**
 * 阶段 3 S3-02/S3-03：迁移身份辅助。
 *
 * 总方案 §9.1 要求 PC 与 Android 从同一旧 PC 数据集迁移时共享 `migrationGenesisId`
 * 和规范内容哈希：
 * - 旧缓存里的同内容投影**不得**被赋予独立并发祖先；
 * - 只有离线独有内容才生成 Android 本地 dot。
 */
object MigrationIdentity {

    /**
     * 单条 payload 解密后上限 2 MiB（总方案 §6.2；与 PC `DEFAULT_MAX_PAYLOAD_BYTES` 对齐）。
     * 更大的二进制内容必须走 blob / app-private files（见 `LocalMediaManifestEntity`）。
     */
    const val MAX_PAYLOAD_BYTES = 2 * 1024 * 1024

    /**
     * 实体 ID 合法性（与 `shared/contracts/repositoryContract.ts` 的 `invalid-entity-id-is-rejected`
     * 用例对齐，阶段 1 冻结契约）：
     * - 必须非空，长度 ≤ 512；
     * - 不允许路径分隔符 `/` `\`（PC 端会映射为文件路径，必须具备路径穿越防护）；
     * - 不允许 `..` 片段与 NUL；
     * - 不允许控制字符。
     */
    fun isValidEntityId(entityId: String): Boolean {
        if (entityId.isEmpty() || entityId.length > 512) return false
        if (entityId.contains('/') || entityId.contains('\\')) return false
        if (entityId.contains("..")) return false
        if (entityId.contains('\u0000')) return false
        if (entityId.any { it.isISOControl() }) return false
        return true
    }

    fun requireValidEntityId(entityId: String): String {
        if (!isValidEntityId(entityId)) {
            throw IllegalArgumentException("非法实体 ID：$entityId")
        }
        return entityId
    }

    /** 规范业务哈希（排除 updatedAt 等非业务字段，总方案 §6.2）。 */
    fun contentHash(payload: Map<String, Any?>): String =
        "sha256:" + sha256Hex(CanonicalJson.encode(payload))

    /** 单条 payload 的体积检查（>2 MiB 必须走 blob，不得进入实体信封）。 */
    fun requirePayloadWithinLimit(payload: Map<String, Any?>): String {
        val canonical = CanonicalJson.encode(payload)
        val bytes = canonical.toByteArray(Charsets.UTF_8).size
        if (bytes > MAX_PAYLOAD_BYTES) {
            throw PayloadTooLargeException(bytes, MAX_PAYLOAD_BYTES)
        }
        return canonical
    }

    fun normalizeHash(hash: String?): String? {
        val value = hash?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return if (value.startsWith("sha256:")) value else "sha256:$value"
    }

    /**
     * 旧缓存投影是否与 PC 投影同源（相同 ID + 相同业务哈希）。
     * 同源时导入不生成新的并发版本。
     */
    fun isSameProjection(genesisContentHash: String?, computedContentHash: String): Boolean =
        normalizeHash(genesisContentHash) == normalizeHash(computedContentHash)

    /** 解析 PC migration genesis manifest（只读导入用）：entityType/entityId -> contentHash。 */
    fun parseGenesisManifest(json: String): Map<Pair<String, String>, String> {
        val result = mutableMapOf<Pair<String, String>, String>()
        for (entry in jsonArrayObjects(json)) {
            val type = flatString(entry, "entityType") ?: continue
            val id = flatString(entry, "entityId") ?: continue
            val hash = flatString(entry, "contentHash") ?: continue
            result[type to id] = hash
        }
        return result
    }

    fun parseGenesisId(json: String): String? = flatString(json, "migrationGenesisId")

    // ---------------------------------------------------------------- 最小 JSON 读取
    // 旧缓存导入只读取扁平的字符串字段；不引入完整 JSON 解析器（避免依赖与攻击面）。

    internal fun flatString(json: String, key: String): String? {
        val marker = "\"$key\""
        val idx = json.indexOf(marker)
        if (idx < 0) return null
        var i = idx + marker.length
        while (i < json.length && json[i].isWhitespace()) i++
        if (i >= json.length || json[i] != ':') return null
        i++
        while (i < json.length && json[i].isWhitespace()) i++
        if (i >= json.length || json[i] != '"') return null
        i++
        val sb = StringBuilder()
        while (i < json.length) {
            val c = json[i]
            if (c == '\\' && i + 1 < json.length) {
                when (json[i + 1]) {
                    'n' -> sb.append('\n')
                    't' -> sb.append('\t')
                    'r' -> sb.append('\r')
                    '"' -> sb.append('"')
                    '\\' -> sb.append('\\')
                    else -> sb.append(json[i + 1])
                }
                i += 2
                continue
            }
            if (c == '"') return sb.toString()
            sb.append(c)
            i++
        }
        return sb.toString()
    }

    /** 极简顶层对象数组切分；元素必须是 `{...}`，不支持嵌套对象数组以外的结构。 */
    internal fun jsonArrayObjects(json: String): List<String> {
        val start = json.indexOf('[')
        if (start < 0) return emptyList()
        val result = mutableListOf<String>()
        var depth = 0
        var objStart = -1
        var inString = false
        var i = start + 1
        while (i < json.length) {
            val c = json[i]
            if (inString) {
                if (c == '\\') {
                    i += 2
                    continue
                }
                if (c == '"') inString = false
            } else {
                when (c) {
                    '"' -> inString = true
                    '{' -> {
                        if (depth == 0) objStart = i
                        depth++
                    }
                    '}' -> {
                        depth--
                        if (depth == 0 && objStart >= 0) {
                            result += json.substring(objStart, i + 1)
                            objStart = -1
                        }
                    }
                    ']' -> if (depth == 0) return result
                }
            }
            i++
        }
        return result
    }
}

/** payload 超过 2 MiB：调用方必须改为走 blob / app-private files，不得静默截断。 */
class PayloadTooLargeException(val actualBytes: Int, val limitBytes: Int) :
    IllegalArgumentException("单条 payload $actualBytes 字节超过上限 $limitBytes 字节，必须走 blob 传输")
