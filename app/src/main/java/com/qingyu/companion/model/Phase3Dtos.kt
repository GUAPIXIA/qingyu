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
