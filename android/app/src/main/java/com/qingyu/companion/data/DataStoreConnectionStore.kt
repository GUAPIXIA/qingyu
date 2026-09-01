package com.qingyu.companion.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.model.ConnectionMode
import com.qingyu.companion.security.TokenCrypto
import kotlinx.coroutines.flow.first
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

private val Context.companionDataStore by preferencesDataStore(name = "companion_connections")

/**
 * [ConnectionStore] 的 DataStore Preferences 实现。
 * 连接列表整体序列化为单个 JSON 字符串键，避免多键写读的不一致。
 * 令牌为敏感数据，存储于应用私有 DataStore（非 root 环境不可读）；
 * 不设云端备份（方案 §6.9）。
 */
class DataStoreConnectionStore(
    private val context: Context,
    private val json: Json,
) : ConnectionStore {

    private object Keys {
        val CONNECTIONS = stringPreferencesKey("connections")
        val ACTIVE = stringPreferencesKey("active_device_id")
    }

    override suspend fun loadAll(): List<ServerConnection> {
        val raw = context.companionDataStore.data.first()[Keys.CONNECTIONS] ?: return emptyList()
        // B-02 兼容读取：常规整表解码；一旦失败（如含无法构造的 endpoint 记录），
        // 降级为逐条解码——单条坏数据不拖垮整表；旧格式（缺新字段）走默认值。
        // 读取阶段绝不删除旧 fingerprint/token/host/port。
        val list = runCatching { json.decodeFromString<List<ServerConnection>>(raw) }
            .getOrNull() ?: decodeLenient(raw)
        // 解密：若 token 为 ENC:<deviceId> 占位，则从 EncryptedSharedPreferences 读取明文
        return list.map { conn ->
            if (conn.token.startsWith("ENC:")) {
                val key = conn.token.removePrefix("ENC:")
                val plain = TokenCrypto.getDecrypted(context, key)
                    ?: TokenCrypto.getDecrypted(context, "connection:${conn.deviceId}:access")
                    ?: conn.token
                // 兼容：若 EncryptedPrefs 丢失，回退原 token（仍为占位则保持）
                if (plain.startsWith("ENC:")) conn else conn.copy(token = plain)
            } else {
                // 迁移：明文 token 尝试在 EncryptedPrefs 中查找已加密副本，优先使用
                val encrypted = TokenCrypto.getDecrypted(context, "connection:${conn.deviceId}:access")
                    ?: TokenCrypto.getDecrypted(context, conn.deviceId)
                if (encrypted != null && encrypted != conn.token) conn.copy(token = encrypted) else conn
            }
        }
    }

    /**
     * 逐条容错解码（B-02）：JSON 数组手写拆分成本过高，这里退化为
     * 整表失败后按元素正则定位 `"deviceId"` 边界再逐条 decode 的兜底路径，
     * 仅保证"旧数据可读"而非"坏数据可修"。
     */
    private fun decodeLenient(raw: String): List<ServerConnection> {
        val elements = splitJsonArray(raw)
        return elements.mapNotNull { element ->
            runCatching { json.decodeFromString(ServerConnection.serializer(), element) }
                .getOrElse {
                    // endpoints 字段损坏（未知 security 等）：丢弃该字段、保留核心凭据（不删数据）
                    val stripped = stripField(element, "endpoints")
                        .let { stripField(it, "lastSuccessfulEndpoint") }
                    runCatching { json.decodeFromString(ServerConnection.serializer(), stripped) }.getOrNull()
                }
        }
    }

    /** 顶层 JSON 数组按大括号深度切分元素（字符串感知）。 */
    private fun splitJsonArray(raw: String): List<String> {
        val trimmed = raw.trim().removePrefix("[").removeSuffix("]")
        if (trimmed.isBlank()) return emptyList()
        val out = mutableListOf<String>()
        var depth = 0
        var inString = false
        var escaped = false
        var start = 0
        for (i in trimmed.indices) {
            val c = trimmed[i]
            when {
                escaped -> escaped = false
                c == '\\' && inString -> escaped = true
                c == '"' -> inString = !inString
                inString -> Unit
                c == '{' || c == '[' -> depth++
                c == '}' || c == ']' -> depth--
                c == ',' && depth == 0 -> {
                    out += trimmed.substring(start, i).trim()
                    start = i + 1
                }
            }
        }
        out += trimmed.substring(start).trim()
        return out.filter { it.isNotEmpty() }
    }

    /** 移除顶层键字段（值可为数组/对象/标量；字符串感知扫描）。 */
    private fun stripField(element: String, key: String): String {
        val marker = "\"$key\""
        val at = element.indexOf(marker)
        if (at < 0) return element
        var i = element.indexOf(':', at + marker.length)
        if (i < 0) return element
        i++
        while (i < element.length && element[i] == ' ') i++
        val end = when (element.getOrNull(i)) {
            '{', '[' -> {
                var depth = 0
                var inString = false
                var escaped = false
                var j = i
                while (j < element.length) {
                    val c = element[j]
                    when {
                        escaped -> escaped = false
                        c == '\\' && inString -> escaped = true
                        c == '"' -> inString = !inString
                        inString -> Unit
                        c == '{' || c == '[' -> depth++
                        c == '}' || c == ']' -> {
                            depth--
                            if (depth == 0) { j++; break }
                        }
                    }
                    j++
                }
                j
            }
            '"' -> {
                var j = i + 1
                var escaped = false
                while (j < element.length) {
                    val c = element[j]
                    if (escaped) escaped = false
                    else if (c == '\\') escaped = true
                    else if (c == '"') { j++; break }
                    j++
                }
                j
            }
            else -> {
                var j = i
                while (j < element.length && element[j] != ',' && element[j] != '}') j++
                j
            }
        }
        // 一并吞掉尾随逗号
        var cutEnd = end
        while (cutEnd < element.length && (element[cutEnd] == ' ')) cutEnd++
        if (cutEnd < element.length && element[cutEnd] == ',') cutEnd++
        else if (end < element.length && element[end - 1] == ',') { /* 前逗号 */ }
        // 若移除后出现 "key":value,} 形态的悬空前逗号，做一次简单规整
        val removed = (element.substring(0, at) + element.substring(cutEnd))
        return removed.replace(Regex(",\\s*}"), "}").replace(Regex("\\{\\s*,"), "{")
    }

    override suspend fun save(connection: ServerConnection) {
        // 加密落盘：尝试将 token 写入 EncryptedSharedPreferences，DataStore 仅存占位
        val toSave = runCatching {
            val encryptedPrefs = TokenCrypto.getEncryptedPrefs(context)
            if (encryptedPrefs != null) {
                val accessKey = "connection:${connection.deviceId}:access"
                TokenCrypto.putEncrypted(context, accessKey, connection.token)
                if (connection.mode == ConnectionMode.LAN) TokenCrypto.putEncrypted(context, connection.deviceId, connection.token)
                connection.copy(token = "ENC:$accessKey")
            } else connection
        }.getOrDefault(connection)
        context.companionDataStore.edit { prefs ->
            val current = prefs[Keys.CONNECTIONS]?.let { decode(it) } ?: emptyList()
            val updated = current.filterNot { it.deviceId == toSave.deviceId } + toSave
            prefs[Keys.CONNECTIONS] = json.encodeToString(updated)
        }
    }

    override suspend fun remove(deviceId: String) {
        TokenCrypto.removeEncrypted(context, deviceId)
        TokenCrypto.removeEncrypted(context, "connection:$deviceId:access")
        TokenCrypto.removeEncrypted(context, "connection:$deviceId:refresh")
        context.companionDataStore.edit { prefs ->
            val current = prefs[Keys.CONNECTIONS]?.let { decode(it) } ?: emptyList()
            prefs[Keys.CONNECTIONS] = json.encodeToString(
                current.filterNot { it.deviceId == deviceId }
            )
            if (prefs[Keys.ACTIVE] == deviceId) prefs.remove(Keys.ACTIVE)
        }
    }

    override suspend fun setActive(deviceId: String?) {
        context.companionDataStore.edit { prefs ->
            if (deviceId == null) prefs.remove(Keys.ACTIVE) else prefs[Keys.ACTIVE] = deviceId
        }
    }

    override suspend fun getActive(): ServerConnection? {
        val id = context.companionDataStore.data.first()[Keys.ACTIVE] ?: return null
        return loadAll().firstOrNull { it.deviceId == id }
    }

    override suspend fun wipe() {
        TokenCrypto.clearEncrypted(context)
        context.companionDataStore.edit { it.clear() }
    }

    private fun decode(raw: String): List<ServerConnection> =
        runCatching { json.decodeFromString<List<ServerConnection>>(raw) }
            .getOrElse { decodeLenient(raw) }
}
