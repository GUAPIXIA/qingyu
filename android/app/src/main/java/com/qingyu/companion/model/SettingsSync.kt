package com.qingyu.companion.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * 设置同步 v2 DTO（实施文档 §7 C-06）。
 * 契约来源：electron/bridge/settingsSync.ts（PC 侧并行实现，以文档为准）：
 * - revision 为内容寻址的不透明字符串（sha256(安全子集)），客户端不解析；
 * - values 为 MobileSafeSettings 子集（不含凭据、不含 fontSize/themeColor/bubbleStyle/
 *   messageWidth/messageSpacing 等 PC 显示偏好）；解码进 [SettingsDto]，缺失字段取默认值；
 * - 409 body：{ error: "settings_conflict", current: SettingsSnapshot }。
 */

/** GET /api/v1/settings/snapshot 响应（schemaVersion 解码默认值；当前 PC 为 3） */
@Serializable
data class SettingsSnapshotDto(
    val schemaVersion: Int = 3,
    val revision: String = "",
    val updatedAt: Long = 0,
    val values: SettingsDto = SettingsDto(),
    /** 旧版响应可能缺失该字段，默认空集 */
    val capabilities: Set<String> = emptySet(),
)

/** PATCH /api/v1/settings/snapshot 请求体 */
@Serializable
data class SettingsPatchRequestDto(
    /** 客户端当前已知 revision；服务端不匹配时返回 409 */
    val baseRevision: String,
    /** 增量字段（仅白名单内可同步字段） */
    val patch: JsonObject,
    val sourceDeviceId: String? = null,
)

/** PATCH /api/v1/settings/snapshot 成功响应（快照 + 字段应用结果） */
@Serializable
data class SettingsPatchResponseDto(
    val schemaVersion: Int = 3,
    val revision: String = "",
    val updatedAt: Long = 0,
    val values: SettingsDto = SettingsDto(),
    val appliedFields: List<String> = emptyList(),
    val rejectedFields: List<RejectedFieldDto> = emptyList(),
    val capabilities: Set<String> = emptySet(),
)

/** PATCH 中被服务端拒绝的字段（类型/范围校验失败或非白名单） */
@Serializable
data class RejectedFieldDto(
    val field: String,
    val reason: String = "",
)

/** 409 冲突响应体（error = "settings_conflict" 时携带 current 快照） */
@Serializable
data class SettingsConflictBodyDto(
    val error: String = "",
    val current: SettingsSnapshotDto? = null,
)
