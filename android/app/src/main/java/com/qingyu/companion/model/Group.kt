package com.qingyu.companion.model

import kotlinx.serialization.Serializable

/**
 * 群聊 DTO（阶段二：查看与发言，对齐 shared/types.ts GroupChat/GroupSession/GroupMessage）。
 */

/** 群聊 */
@Serializable
data class GroupChat(
    val id: String,
    val name: String,
    val memberIds: List<String> = emptyList(),
    val chatMode: String = "free",
    val autoMode: Boolean = false,
    val maxRounds: Int = 0,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
)

/** 群聊会话 */
@Serializable
data class GroupSession(
    val id: String,
    val groupId: String,
    val title: String,
    val messageCount: Int = 0,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
)

/** 群聊消息 */
@Serializable
data class GroupMessage(
    val id: String,
    val groupId: String,
    val characterId: String,
    val content: String,
    val images: List<String> = emptyList(),
    val timestamp: Long,
    val round: Int = 0,
    val translation: String? = null,
    val replyToId: String? = null,
    /** 提及的角色 ID 列表 */
    val mentionedCharacterIds: List<String> = emptyList(),
) {
    /** 是否用户消息 */
    val isUser: Boolean get() = characterId == "__user__"
}

/** 群聊发言请求 */
@Serializable
data class GroupSendRequest(
    val content: String,
    val requestId: String,
    val images: List<String> = emptyList(),
    val mentionedCharacterIds: List<String> = emptyList(),
)

/** 群聊发言响应 */
@Serializable
data class GroupSendResponse(
    val ok: Boolean,
    val messageId: String? = null,
)
