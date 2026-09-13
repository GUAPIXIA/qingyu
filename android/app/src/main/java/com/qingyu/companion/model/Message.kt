package com.qingyu.companion.model

import kotlinx.serialization.Serializable

/** 单条消息的 token 用量（对齐 shared/types.ts 的 MessageCharUsage 精简版） */
@Serializable
data class MessageUsage(
    val promptTokens: Int,
    val completionTokens: Int,
    val totalTokens: Int,
)

/** AI 回复后生成的“下一步方向”（对齐 shared/types.ts 的 DialogueDirection）。 */
@Serializable
data class DialogueDirection(
    val id: String,
    val label: String,
    val content: String,
    /** safe / explore / risky */
    val tendency: String,
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
    /** 生成本条回复时使用的叙事模式。 */
    val narrativeMode: String? = null,
    /** 界面显示身份；旧消息缺失或值未知时由 MessageIdentity 推导。 */
    val speakerKind: String? = null,
    /** AI 回复后生成的下一步方向；随消息持久化。 */
    val dialogueDirections: List<DialogueDirection>? = null,
    /** 收尾提示（已在完整句处收束/已自动补全结尾/已停止生成）；与 generationError 互斥。 */
    val generationNotice: String? = null,
    /** 生成失败原因（超时/网络中断等）；不进入正文，仅气泡下方提示。 */
    val generationError: String? = null,
    /**
     * 正文渲染模式（PC 阶段5）：blocks = 语义分块渲染（RoleplayBlockList，阶段7 起单聊/群聊已消费），
     * markdown/缺省 = Markdown 兼容渲染（旧消息安全回退）。
     */
    val contentRenderMode: String? = null,
)

@Serializable
enum class Role {
    user,
    assistant,
    system,
}
