package com.qingyu.companion.data.settings

import android.content.Context
import com.qingyu.companion.model.SettingsSnapshotDto
import com.qingyu.companion.network.NetworkModule
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json

/**
 * 设置快照磁盘缓存（方案 §7 C-07）：按 deviceId 隔离，文件名
 * `settings_snapshot_<deviceIdHash>.json`（deviceId 哈希防文件名泄露设备记录 ID）。
 *
 * 刻意不用 Room（CacheDatabase 是阶段 F 战场）；纯文件 JSON，
 * 与 [SettingsSyncRepository] 的"切换 PC 先清内存再加载目标缓存"配合。
 */
class SettingsCacheStore(
    private val dir: File,
    private val json: Json = NetworkModule.json,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {

    constructor(context: Context, json: Json = NetworkModule.json) : this(
        dir = File(context.applicationContext.filesDir, "settings_cache"),
        json = json,
        ioDispatcher = Dispatchers.IO,
    )

    private fun fileFor(deviceId: String): File =
        File(dir, "settings_snapshot_${sha256Hex(deviceId)}.json")

    suspend fun load(deviceId: String): SettingsSnapshot? = withContext(ioDispatcher) {
        runCatching {
            val text = fileFor(deviceId).readText()
            val dto = json.decodeFromString(SettingsSnapshotDto.serializer(), text)
            dto.toDomain()
        }.getOrNull()
    }

    suspend fun save(deviceId: String, snapshot: SettingsSnapshot) = withContext(ioDispatcher) {
        runCatching {
            dir.mkdirs()
            fileFor(deviceId).writeText(
                json.encodeToString(SettingsSnapshotDto.serializer(), snapshot.toDto()),
            )
        }
        Unit
    }

    suspend fun clear(deviceId: String) = withContext(ioDispatcher) {
        runCatching { fileFor(deviceId).delete() }
        Unit
    }

    /** 「退出时清除」用：清空全部设备快照缓存 */
    suspend fun clearAll() = withContext(ioDispatcher) {
        runCatching { dir.listFiles()?.forEach { it.delete() } }
        Unit
    }

    private fun SettingsSnapshot.toDto() = SettingsSnapshotDto(
        revision = revision,
        updatedAt = updatedAt,
        values = values,
        capabilities = capabilities,
    )

    /** 缓存只存数据；protocol 由仓库在 capability 协商后覆盖（LEGACY 快照 revision=""） */
    private fun SettingsSnapshotDto.toDomain() = SettingsSnapshot(
        revision = revision,
        updatedAt = updatedAt,
        values = values,
        capabilities = capabilities,
        protocol = SettingsProtocol.SNAPSHOT_V2,
    )

    companion object {
        fun sha256Hex(value: String): String =
            MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
                .joinToString("") { "%02x".format(it) }
    }
}
