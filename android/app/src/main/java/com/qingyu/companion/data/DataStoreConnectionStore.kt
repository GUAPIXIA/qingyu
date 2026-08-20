package com.qingyu.companion.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.qingyu.companion.model.ServerConnection
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
        val list = runCatching { json.decodeFromString<List<ServerConnection>>(raw) }
            .getOrDefault(emptyList())
        // 解密：若 token 为 ENC:<deviceId> 占位，则从 EncryptedSharedPreferences 读取明文
        return list.map { conn ->
            if (conn.token.startsWith("ENC:")) {
                val key = conn.token.removePrefix("ENC:")
                val plain = TokenCrypto.getDecrypted(context, key) ?: conn.token
                // 兼容：若 EncryptedPrefs 丢失，回退原 token（仍为占位则保持）
                if (plain.startsWith("ENC:")) conn else conn.copy(token = plain)
            } else {
                // 迁移：明文 token 尝试在 EncryptedPrefs 中查找已加密副本，优先使用
                val encrypted = TokenCrypto.getDecrypted(context, conn.deviceId)
                if (encrypted != null && encrypted != conn.token) conn.copy(token = encrypted) else conn
            }
        }
    }

    override suspend fun save(connection: ServerConnection) {
        // 加密落盘：尝试将 token 写入 EncryptedSharedPreferences，DataStore 仅存占位
        val toSave = runCatching {
            val encryptedPrefs = TokenCrypto.getEncryptedPrefs(context)
            if (encryptedPrefs != null) {
                TokenCrypto.putEncrypted(context, connection.deviceId, connection.token)
                connection.copy(token = "ENC:${connection.deviceId}")
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
            .getOrDefault(emptyList())
}
