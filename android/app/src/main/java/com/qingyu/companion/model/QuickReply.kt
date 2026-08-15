package com.qingyu.companion.model

import kotlinx.serialization.Serializable

/**
 * 快捷回复。对齐 shared/types.ts 的 QuickReply。
 * 宏展开在 PC 侧完成（安卓端发的是用户消息，不是 prompt）。
 */
@Serializable
data class QuickReply(
    val id: String,
    val label: String,
    val content: String,
    /** text = 发送文本；preset = 切换预设；command = 触发斜杠命令 */
    val action: QuickReplyAction,
    val sendWithAI: Boolean,
    val order: Int,
    val enabled: Boolean,
    /** action=preset 时：目标预设 id */
    val presetId: String? = null,
    /** action=command 时：斜杠命令文本（如 /imagine） */
    val command: String? = null,
)

@Serializable
enum class QuickReplyAction {
    text,
    preset,
    command,
}

/** 快捷回复列表响应：全局 + 按角色专属（byCharacter 为角色 id → 列表） */
@Serializable
data class QuickReplyListResponse(
    val global: List<QuickReply>,
    val byCharacter: Map<String, List<QuickReply>> = emptyMap(),
)
