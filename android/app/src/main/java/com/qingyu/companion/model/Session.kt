package com.qingyu.companion.model

import kotlinx.serialization.Serializable

/**
 * 会话预览（列表用）。对齐 shared/types.ts 的 SessionPreview。
 * 记忆/压缩等 PC 侧内部字段不下发给安卓端（会话数据最小化，方案 §6.9）。
 */
@Serializable
data class SessionPreview(
    val id: String,
    val characterId: String,
    /** 角色名（PC 端 /sessions 下发，用于全局会话列表展示「角色名 + 会话名」） */
    val characterName: String = "",
    val title: String,
    val createdAt: Long,
    val updatedAt: Long,
    val messageCount: Int,
    /** 对话中按时间排序的最后一条消息摘要（由 PC 桥接层生成） */
    val lastMessage: String,
    /** 当前会话实际叙事模式。 */
    val narrativeMode: String = "immersive",
    /** 全局叙事下是否启用游戏主持格式。 */
    val gameMasterMode: Boolean = false,
    /** 旁白维护的当前世界局势。 */
    val memoryCurrentState: String = "",
)
