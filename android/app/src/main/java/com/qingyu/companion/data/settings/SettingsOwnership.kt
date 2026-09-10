package com.qingyu.companion.data.settings

import com.qingyu.companion.model.SettingsDto
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

/**
 * 设置所有权划分（方案 §7 / §9 E-03「仅本机」vs「同步到当前 PC」）。
 *
 * - 本机权威（Android）：主题/字号/间距/背景/应用锁/通知等，全部存 UiPrefsStore，
 *   **绝不进入 PATCH**——即使 PC 快照 values 里出现同名字段（旧 PC 兼容），
 *   UI 也不以它们渲染、不随其变更。
 * - PC 权威（同步到当前 PC）：模型、预设、翻译语言、流式输出、token 计数等，
 *   存于 PC settings.json，经快照端点（v2）或旧 /settings（legacy）读写。
 *
 * v2 可同步字段集与 PC electron/bridge/settingsSync.ts 的 MobileSafeSettings 对齐：
 * PC 显示偏好（fontSize/themeColor/bubbleStyle/messageWidth/messageSpacing）与
 * authorNote 已移出安全子集（快照里即使出现也仅容忍解码，不参与 PATCH）。
 */
object SettingsOwnership {

    /** v2 快照可 PATCH 的字段（白名单；越界字段 PC 侧进 rejectedFields） */
    val SYNCABLE_FIELDS: Set<String> = setOf(
        "userName",
        "userDescription",
        "userPersona",
        "activePresetId",
        "activeModel",
        "translationTargetLang",
        "streamOutput",
        "autoScroll",
        "showTokenCount",
        "htmlRendering",
        "imageGenAutoEnabled",
        "imageGenSize",
        "exampleDialogMode",
        "lorebookRatio",
        "autoTitle",
        "defaultNarrativeMode",
        "omniscientNarrativeRules",
    )

    /**
     * capability 门控决策（纯函数，JVM 可测）：
     * serverInfo capabilities 含 settings_snapshot_v2 才走 v2 快照端点，
     * 否则 legacy 旧 /settings（UI 标注「旧版 PC：设置仅支持直接保存」）。
     */
    fun useSnapshotProtocol(capabilities: Set<String>): Boolean =
        "settings_snapshot_v2" in capabilities
}

/** 任意 Kotlin 值 → JsonElement（标量与 null；未知类型序列化为 null） */
private fun jsonElementOf(value: Any?): JsonElement = when (value) {
    null -> JsonNull
    is JsonElement -> value
    is String -> JsonPrimitive(value)
    is Boolean -> JsonPrimitive(value)
    is Int -> JsonPrimitive(value)
    is Long -> JsonPrimitive(value)
    is Double -> JsonPrimitive(value)
    is Float -> JsonPrimitive(value.toDouble())
    else -> JsonNull
}

/**
 * 变更集 → PATCH 增量：仅保留白名单内字段（本机权威项即使误入也被过滤），
 * 值经 JSON 规范化，保证与 PC validateSettingsPatch 兼容。纯函数可测。
 */
fun buildSettingsPatch(changedFields: Map<String, Any?>): JsonObject = buildJsonObject {
    changedFields.forEach { (key, value) ->
        if (key in SettingsOwnership.SYNCABLE_FIELDS) put(key, jsonElementOf(value))
    }
}

/** 快照 values 按字段名取值（PC 设置行渲染与冲突面板共用；白名单外字段返回 null） */
fun settingsFieldValue(dto: SettingsDto, key: String): Any? = when (key) {
    "userName" -> dto.userName
    "userDescription" -> dto.userDescription
    "userPersona" -> dto.userPersona
    "activePresetId" -> dto.activePresetId
    "activeModel" -> dto.activeModel
    "translationTargetLang" -> dto.translationTargetLang
    "streamOutput" -> dto.streamOutput
    "autoScroll" -> dto.autoScroll
    "showTokenCount" -> dto.showTokenCount
    "htmlRendering" -> dto.htmlRendering
    "imageGenAutoEnabled" -> dto.imageGenAutoEnabled
    "imageGenSize" -> dto.imageGenSize
    "exampleDialogMode" -> dto.exampleDialogMode
    "lorebookRatio" -> dto.lorebookRatio
    "autoTitle" -> dto.autoTitle
    "defaultNarrativeMode" -> dto.defaultNarrativeMode
    "omniscientNarrativeRules" -> dto.omniscientNarrativeRules
    else -> null
}

/**
 * 冲突解决「再次应用本地」的合并视图：
 * 以远端快照为基底，本地改动仅覆盖白名单字段（不越权携带 PC-only 显示偏好）。
 */
fun mergeLocalOverRemote(remote: SettingsDto, localChanges: Map<String, Any?>): SettingsDto {
    val json = Json { encodeDefaults = true; explicitNulls = false; ignoreUnknownKeys = true }
    val base = json.encodeToJsonElement(SettingsDto.serializer(), remote) as? JsonObject
        ?: JsonObject(emptyMap())
    val merged = buildJsonObject {
        base.forEach { (k, v) -> put(k, v) }
        localChanges.forEach { (k, v) ->
            if (k in SettingsOwnership.SYNCABLE_FIELDS) put(k, jsonElementOf(v))
        }
    }
    return json.decodeFromJsonElement(SettingsDto.serializer(), merged)
}
