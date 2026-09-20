package com.qingyu.companion.local.settings

import com.qingyu.companion.domain.contracts.CanonicalJson
import com.qingyu.companion.local.db.LocalPublicSettingEntity
import com.qingyu.companion.local.domain.LocalStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * 阶段 3 S3-04：设置分区。
 *
 * | 分区 | 进入同步 envelope | 说明 |
 * |---|---|---|
 * | `PublicSettings` | 是（`settings_public`，按 section+key 行式） | 可同步的行为设置 |
 * | `DeviceSettings` | 否 | 主题跟随、通知、下载目录、性能档位等本机设置 |
 * | `ConnectionProfilePublic` | 否 | 设备本地连接档案（[com.qingyu.companion.security.ConnectionProfileRepository]） |
 * | `SecretRef` | 否 | Keystore 包装的密文引用 |
 * | `PairingAndSyncState` | 否 | 设备令牌、空间信息、已知向量（阶段 7/8 落地） |
 */
enum class SettingSection(val wire: String) {
    Chat("chat"),
    Memory("memory"),
    Context("context"),
    Render("render"),
    Generation("generation"),
    WorldBook("worldbook"),
    Group("group"),
    Usage("usage"),
}

/** 可同步的行为设置键。新增键必须同时更新 `settings_public` payload schema（契约负责人审核）。 */
enum class PublicSettingKey(val section: SettingSection, val key: String, val defaultJson: String) {
    AutoMemory(SettingSection.Memory, "autoMemory", "false"),
    MemoryBudget(SettingSection.Memory, "memoryBudget", "4096"),
    ContextBudget(SettingSection.Context, "contextBudget", "8192"),
    HistoryFallback(SettingSection.Context, "historyFallback", "\"truncate\""),
    ReplyLength(SettingSection.Generation, "replyLength", "\"medium\""),
    ReasoningGate(SettingSection.Generation, "reasoningGate", "false"),
    SemanticWorldBook(SettingSection.WorldBook, "semanticEnabled", "false"),
    GroupAutoAdvance(SettingSection.Group, "autoAdvance", "false"),
    ;

    val path: String get() = "${section.wire}.$key"
}

/** 设备本地（不同步）的设置键。 */
enum class DeviceSettingKey(val key: String, val defaultJson: String) {
    ThemeMode("themeMode", "\"system\""),
    NotificationsEnabled("notificationsEnabled", "true"),
    DownloadDirectory("downloadDirectory", "null"),
    PerformanceTier("performanceTier", "\"balanced\""),
    FontScale("fontScale", "1.0"),
    MessageSpacing("messageSpacing", "1.0"),
    CleartextLanEnabled("cleartextLanEnabled", "false"),
    ;

    override fun toString(): String = "DeviceSettingKey($key)"
}

class PublicSettings(
    private val raw: Map<String, String>,
) {
    fun bool(key: PublicSettingKey): Boolean = raw[key.path]?.let { it == "true" } ?: (key.defaultJson == "true")

    fun int(key: PublicSettingKey): Int =
        raw[key.path]?.toIntOrNull() ?: key.defaultJson.toIntOrNull() ?: 0

    fun string(key: PublicSettingKey): String =
        raw[key.path]?.let { decodeString(it) } ?: decodeString(key.defaultJson)

    fun rawValue(key: PublicSettingKey): String = raw[key.path] ?: key.defaultJson

    fun asMap(): Map<String, String> = raw.toMap()

    /** 诊断用：只输出键，不输出值（值可能包含用户文本）。 */
    override fun toString(): String = "PublicSettings(keys=${raw.keys.sorted()})"
}

class DeviceSettings(
    private val raw: Map<String, String>,
) {
    fun bool(key: DeviceSettingKey): Boolean = raw[key.key]?.let { it == "true" } ?: (key.defaultJson == "true")

    fun int(key: DeviceSettingKey): Int = raw[key.key]?.toIntOrNull() ?: key.defaultJson.toIntOrNull() ?: 0

    fun double(key: DeviceSettingKey): Double = raw[key.key]?.toDoubleOrNull() ?: key.defaultJson.toDoubleOrNull() ?: 0.0

    fun string(key: DeviceSettingKey): String? {
        val value = raw[key.key] ?: key.defaultJson
        return if (value == "null") null else decodeString(value)
    }

    fun asMap(): Map<String, String> = raw.toMap()

    override fun toString(): String = "DeviceSettings(keys=${raw.keys.sorted()})"
}

/**
 * 设置分区读写入口。
 * - public 设置写入同时生成 journal（`settings_public`，entityId = `section.key`）。
 * - device 设置写入**不生成 journal**，也不进入同步 envelope。
 */
class LocalSettingsRepository(private val store: LocalStore) {

    fun observePublic(): Flow<PublicSettings> =
        store.observePublicSettings().map { toPublicSettings(it) }

    suspend fun publicSettings(): PublicSettings = toPublicSettings(store.listPublicSettings())

    suspend fun setPublic(key: PublicSettingKey, valueJson: String) {
        store.putPublicSetting(key.section.wire, key.key, valueJson)
    }

    suspend fun setPublicBool(key: PublicSettingKey, value: Boolean) = setPublic(key, value.toString())

    suspend fun setPublicInt(key: PublicSettingKey, value: Int) = setPublic(key, value.toString())

    suspend fun setPublicString(key: PublicSettingKey, value: String) =
        setPublic(key, CanonicalJson.encode(value))

    fun observeDevice(): Flow<DeviceSettings> =
        store.observeDeviceSettings().map { toDeviceSettings(it) }

    suspend fun deviceSettings(): DeviceSettings = toDeviceSettings(store.listDeviceSettings())

    /**
     * 设备设置写入前做一次规范化与白名单校验：
     * 未知键直接拒绝，避免把「仅 PC 支持」的设置在 Android 上静默接受。
     */
    suspend fun setDevice(rawKey: String, valueJson: String) {
        val key = DeviceSettingKey.entries.firstOrNull { it.key == rawKey }
            ?: throw IllegalArgumentException("未知设备设置键：$rawKey")
        store.putDeviceSetting(key.key, valueJson)
    }

    suspend fun setDeviceBool(key: DeviceSettingKey, value: Boolean) = setDevice(key.key, value.toString())

    suspend fun setDeviceDouble(key: DeviceSettingKey, value: Double) = setDevice(key.key, value.toString())

    suspend fun setDeviceString(key: DeviceSettingKey, value: String?) =
        setDevice(key.key, value?.let { CanonicalJson.encode(it) } ?: "null")

    private fun toPublicSettings(rows: List<LocalPublicSettingEntity>): PublicSettings =
        PublicSettings(rows.associate { "${it.section}.${it.key}" to it.valueJson })

    private fun toDeviceSettings(rows: List<com.qingyu.companion.local.db.LocalDeviceSettingEntity>): DeviceSettings =
        DeviceSettings(rows.associate { it.key to it.valueJson })
}

private fun decodeString(json: String): String {
    val trimmed = json.trim()
    if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
        return trimmed.substring(1, trimmed.length - 1)
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
            .replace("\\n", "\n")
            .replace("\\t", "\t")
    }
    return trimmed
}
