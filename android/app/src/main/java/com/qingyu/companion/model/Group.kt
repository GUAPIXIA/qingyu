package com.qingyu.companion.model

import kotlinx.serialization.Serializable

/**
 * 群聊 DTO（阶段二：查看与发言，对齐 shared/types.ts GroupChat/GroupSession/GroupMessage）。
 */

/**
 * 群聊。安卓端只做浏览与发言，未消费的协议镜像字段
 * （chatMode/autoMode/maxRounds/defaultNarrativeMode/createdAt/updatedAt）已移除，
 * 由 ignoreUnknownKeys 容忍 PC 继续下发；后续 UI 需要时随用随加。
 */
@Serializable
data class GroupChat(
    val id: String,
    val name: String,
    val memberIds: List<String> = emptyList(),
)

/** 群聊会话（同上：narrativeMode/gameMasterMode/memoryCurrentState/personaId 等未消费镜像字段已移除） */
@Serializable
data class GroupSession(
    val id: String,
    val groupId: String,
    val title: String,
    val messageCount: Int = 0,
    /** 会话级“下一步方向”开关：AI 回复后生成 3 个可选方向。 */
    val dialogueDirectionsEnabled: Boolean = false,
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
    val narrativeMode: String? = null,
    val speakerKind: String? = null,
    /** AI 回复后生成的下一步方向；随消息持久化。 */
    val dialogueDirections: List<DialogueDirection>? = null,
    /** 收尾提示（已在完整句处收束/已自动补全结尾/已停止生成）；与 generationError 互斥。 */
    val generationNotice: String? = null,
    /** 生成失败原因（超时/网络中断等）；不进入正文，仅气泡下方提示。 */
    val generationError: String? = null,
    /** 正文渲染模式（PC 阶段5）：blocks = 语义分块渲染（RoleplayBlockList），其他/缺省 = Markdown 兼容渲染。 */
    val contentRenderMode: String? = null,
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
)

/** 群聊发言响应 */
@Serializable
data class GroupSendResponse(
    val ok: Boolean,
    val messageId: String? = null,
)
