package com.qingyu.companion.ui.groups

import com.qingyu.companion.chatcore.LocalGroupGenerationUseCase

/**
 * 群生成流式显示状态（S6-01(f) 停止按钮 + 流式事件转发）。
 *
 * 纯函数归约，JVM 可测。语义钉子（阶段 6 §2.4，禁止「顺手修复」）：
 * - [LocalGroupGenerationUseCase.Delta.Chunk] 实时上屏（累积到 [streamingText]）；
 * - [LocalGroupGenerationUseCase.Delta.TurnFinished] 落库可见（正文由仓库消息承载），
 *   流式缓冲清零，`generationNotice`／`generationError` 只进 [notice]／[error] 提示字段；
 * - **错误／提示绝不拼入正文**（[streamingText] 永不含错误串——本文件从不把提示写进正文）；
 * - [LocalGroupGenerationUseCase.Delta.WaitingUser] 交还用户（active 置 false）；
 * - [LocalGroupGenerationUseCase.Delta.Stopped] **保留已见正文**（[streamingText] 不清）
 *   并标「已停止生成」（写 [notice] 提示字段，不写正文）。
 */
data class GroupStreamingUi(
    /** 是否正在生成（决定停止按钮可见）。 */
    val active: Boolean = false,
    /** 当前流式发言者（成员 id；free 无固定发言者为 null）。 */
    val streamingSpeakerId: String? = null,
    /** 已见流式正文（Chunk 累积；TurnFinished 清零；Stopped 保留）。 */
    val streamingText: String = "",
    /** 已完成轮数（TurnFinished 计数）。 */
    val finishedTurns: Int = 0,
    /** 交还用户原因（WaitingUser）。 */
    val waitingUserReason: String? = null,
    /** 拒绝原因（Rejected）。 */
    val rejectedReason: String? = null,
    /** 收尾提示（generationNotice / 「已停止生成」）；绝不进正文。 */
    val notice: String? = null,
    /** 生成失败原因（generationError）；绝不进正文。 */
    val error: String? = null,
    /** 是否已停止（Stopped）。 */
    val stopped: Boolean = false,
) {
    /** 停止按钮可见性：仅生成中可停。 */
    val showStop: Boolean get() = active

    /** 渲染纯函数：气泡下方的结构化收尾行（正文保持干净）。 */
    fun footer(): GroupStreamingFooter = GroupStreamingFooter(
        showSpinner = active,
        showStop = showStop,
        notice = notice,
        error = error,
        stopped = stopped,
    )
}

/** 结构化收尾状态（供 Compose 状态渲染纯函数消费；截图不作门槛）。 */
data class GroupStreamingFooter(
    val showSpinner: Boolean,
    val showStop: Boolean,
    val notice: String?,
    val error: String?,
    val stopped: Boolean,
)

object GroupStreamingReducer {
    /** 停止时的收尾提示字面量（对齐 Message.generationNotice 语义「已停止生成」）。 */
    const val STOPPED_NOTICE: String = "已停止生成"

    fun initial(): GroupStreamingUi = GroupStreamingUi()

    /** 逐事件归约：Delta -> 显示状态。 */
    fun reduce(state: GroupStreamingUi, delta: LocalGroupGenerationUseCase.Delta): GroupStreamingUi =
        when (delta) {
            is LocalGroupGenerationUseCase.Delta.TurnStarted -> state.copy(
                active = true,
                streamingSpeakerId = delta.turn.speakerId,
                streamingText = "",
                waitingUserReason = null,
                rejectedReason = null,
                stopped = false,
            )

            is LocalGroupGenerationUseCase.Delta.Chunk -> state.copy(
                active = true,
                streamingText = state.streamingText + delta.text,
            )

            is LocalGroupGenerationUseCase.Delta.TurnFinished -> state.copy(
                active = true,
                streamingText = "",
                finishedTurns = state.finishedTurns + 1,
                notice = delta.noticeFields["generationNotice"] ?: state.notice,
                error = delta.noticeFields["generationError"] ?: state.error,
            )

            is LocalGroupGenerationUseCase.Delta.WaitingUser -> state.copy(
                active = false,
                waitingUserReason = delta.reason,
            )

            is LocalGroupGenerationUseCase.Delta.Rejected -> state.copy(
                active = false,
                rejectedReason = delta.reason,
            )

            is LocalGroupGenerationUseCase.Delta.Stopped -> state.copy(
                active = false,
                stopped = true,
                // 保留已见正文（streamingText 不清）；提示只进提示字段
                notice = STOPPED_NOTICE,
            )
        }
}
