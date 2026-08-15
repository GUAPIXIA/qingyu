package com.qingyu.companion.model

import kotlinx.serialization.Serializable

/** 单条消息的 token 用量（对齐 shared/types.ts 的 MessageCharUsage 精简版） */
@Serializable
data class MessageUsage(
    val promptTokens: Int,
    val completionTokens: Int,
    val totalTokens: Int,
)

/**
 * 聊天消息。对齐 shared/types.ts 的 Message。
 * 注意：images 在 PC 侧为 base64 数组，桥接层应转为静态路由 URL
 * 后下发（避免 REST 分页响应过大，见方案 §4.3 分页策略）。
 */
@Serializable
data class Message(
    val id: String,
    val sessionId: String,
    val characterId: String,
    val role: Role,
    val content: String,
    /** 图片 URL 列表（桥接层转换后） */
    val images: List<String> = emptyList(),
    val timestamp: Long,
    val translation: String? = null,
    /** 所有候选回复（仅 assistant）- Swipe 多候选 */
    val swipes: List<String>? = null,
    val swipeIndex: Int? = null,
    /** 引用回复的目标消息 ID */
    val replyToId: String? = null,
    /** 本次 AI 回复的 token 用量（仅 assistant，来自 ai:usage 事件） */
    val usage: MessageUsage? = null,
)

@Serializable
enum class Role {
    user,
    assistant,
    system,
}
