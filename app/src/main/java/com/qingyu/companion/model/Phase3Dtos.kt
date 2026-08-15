package com.qingyu.companion.model

import kotlinx.serialization.Serializable

/**
 * 阶段三只读 DTO：用量统计与公告同步（方案 §7 阶段三，安卓端只读查看）。
 */

/** GET /api/v1/usage/summary 响应 */
@Serializable
data class UsageSummaryResponse(
    val today: UsageSummary,
    val total: UsageSummary,
)

/** 用量汇总 */
@Serializable
data class UsageSummary(
    val totalInput: Long,
    val totalOutput: Long,
    val totalChars: Long,
    val count: Int,
)

/** 用量记录（对齐 shared/types.ts UsageRecord 精简） */
@Serializable
data class UsageRecordDto(
    val id: String,
    val timestamp: Long,
    val characterId: String,
    val sessionId: String,
    val model: String,
    val inputChars: Int,
    val outputChars: Int,
    val totalChars: Int,
)

/** 公告（对齐 shared/types.ts Announcement） */
@Serializable
data class Announcement(
    val id: Int,
    val title: String,
    val content: String,
    val createdAt: String,
    val updatedAt: String,
)

/** GET /api/v1/announcements 响应 */
@Serializable
data class AnnouncementPage(
    val items: List<Announcement>,
    val total: Int,
    val page: Int,
    val pageSize: Int,
)

/** 版本信息（GET /api/v1/version 响应：PC 桥接层转发公告服务器 /api/version） */
@Serializable
data class VersionInfo(
    /** PC 端版本 */
    val version: String = "",
    val changelog: String = "",
    val downloadUrl: String = "",
    /** 安卓端（伴侣端）版本，管理后台可单独配置；空表示服务器未配置 */
    val androidVersion: String = "",
    val androidChangelog: String = "",
    val androidDownloadUrl: String = "",
) {
    /** 安卓端有效版本号：优先 androidVersion，空则回退 PC 端 version（兼容未配置安卓字段的旧服务器） */
    val effectiveVersion: String get() = androidVersion.ifBlank { version }

    val effectiveChangelog: String get() = androidChangelog.ifBlank { changelog }

    val effectiveDownloadUrl: String get() = androidDownloadUrl.ifBlank { downloadUrl }
}
