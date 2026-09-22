package com.qingyu.companion.model

import kotlinx.serialization.Serializable

/**
 * 群聊 DTO（阶段二：查看与发言，对齐 shared/types.ts GroupChat/GroupSession/GroupMessage）。
 */

/**
 * 群聊。阶段 6 S6-01 起安卓为独立客户端，需要调度与绑定字段
 * （chatMode/autoMode/maxRounds/speakerInterval/currentSpeakerIndex/presetId/
 * systemPrompt/lorebookIds/defaultNarrativeMode）；此前它们因「未消费」被裁剪，
 * 由 ignoreUnknownKeys 容忍 PC 下发。视觉字段（chatBackground/themeColor/bubbleOpacity）
 * 仍未消费，继续容忍不建模。
 */
@Serializable
data class GroupChat(
    val id: String,
    val name: String,
    val memberIds: List<String> = emptyList(),
    /** 发言调度模式：mention | polling | free（缺省 polling，与 PC 新建群一致）。 */
    val chatMode: String = "polling",
    /** polling 模式是否自动接力。 */
    val autoMode: Boolean = false,
    /** 自动接力最大 AI 轮数（语义见 shared/fixtures/cross-platform/chat-core/group-scheduling.json）。 */
    val maxRounds: Int = 1,
    /** 接力间隔毫秒。 */
    val speakerInterval: Int = 2000,
    /** 轮转发言索引（PC 为运行时态；本地落盘用于冷启动恢复）。 */
    val currentSpeakerIndex: Int = 0,
    /** 群预设 id（PC 新建默认 `builtin-default`）。 */
    val presetId: String? = null,
    /** 群自定义系统提示。 */
    val systemPrompt: String = "",
    /** 群级世界书 id。 */
    val lorebookIds: List<String> = emptyList(),
    /** 新建群会话的默认叙事模式；空串 = 跟随全局默认。 */
    val defaultNarrativeMode: String = "",
)

/**
 * 群聊会话。S6-01 补回身份/叙事/记忆配置字段（PC `GroupSession`）；
 * 记忆内容（摘要/事实）走记忆域，不在本 DTO。
 */
@Serializable
data class GroupSession(
    val id: String,
    val groupId: String,
    val title: String,
    val messageCount: Int = 0,
    /** 会话级“下一步方向”开关：AI 回复后生成 3 个可选方向。 */
    val dialogueDirectionsEnabled: Boolean = false,
    /** 会话绑定的用户身份；null = 不使用身份。 */
    val personaId: String? = null,
    /** 会话叙事模式；空串 = 未设置（回退群默认/全局默认/immersive）。 */
    val narrativeMode: String = "",
    val memoryEnabled: Boolean = false,
    /** manual | auto */
    val memoryMode: String = "manual",
    val autoMemoryInterval: Int = 10,
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
    /** 本条内容的生成来源：manual | input_continue | assistant_reply | regenerate | message_continue。 */
    val generationKind: String? = null,
    /** 用户消息发送状态：sending | sent。 */
    val status: String? = null,
    /** @提及的角色 id（仅元数据，不决定发言者）。 */
    val mentionedCharacterIds: List<String> = emptyList(),
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
