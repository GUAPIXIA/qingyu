package com.qingyu.companion.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.qingyu.companion.model.ServerConnection
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
        return runCatching { json.decodeFromString<List<ServerConnection>>(raw) }
            .getOrDefault(emptyList())
    }

    override suspend fun save(connection: ServerConnection) {
        context.companionDataStore.edit { prefs ->
            val current = prefs[Keys.CONNECTIONS]?.let { decode(it) } ?: emptyList()
            val updated = current.filterNot { it.deviceId == connection.deviceId } + connection
            prefs[Keys.CONNECTIONS] = json.encodeToString(updated)
        }
    }

    override suspend fun remove(deviceId: String) {
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
        context.companionDataStore.edit { it.clear() }
    }

    private fun decode(raw: String): List<ServerConnection> =
        runCatching { json.decodeFromString<List<ServerConnection>>(raw) }
            .getOrDefault(emptyList())
}
