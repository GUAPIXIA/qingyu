package com.qingyu.companion.data.send

import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.model.Message
import com.qingyu.companion.model.PendingMessage
import kotlinx.coroutines.flow.Flow
import java.util.UUID

/**
 * F-06：可靠发送 UseCase 拆分。
 * ChatViewModel 的发送/重试/取消改走本组用例；ViewModel 只投影状态，
 * 网络与状态机逻辑全部下沉到 Repository（状态转换在其 Room 事务内完成）。
 * 引用/图片/requestId 在所有重试路径保持（imagesJson/replyToId 原样从 outbox 行回读）。
 */

/** 发送用户消息：requestId 为幂等键（缺省时生成），重试复用同一键由 PC 去重。 */
class SendMessageUseCase(private val repository: ChatRepository) {

    suspend operator fun invoke(
        sessionId: String,
        content: String,
        replyToId: String? = null,
        images: List<String> = emptyList(),
        requestId: String = UUID.randomUUID().toString(),
    ): Message = repository.sendMessage(sessionId, requestId, content, replyToId, images)
}

/** 观察发件箱：sessionId -> 未完成消息列表（已按当前活跃 PC 过滤）。 */
class ObserveOutboxUseCase(private val repository: ChatRepository) {

    operator fun invoke(sessionId: String): Flow<List<PendingMessage>> =
        repository.observeOutbox(sessionId)
}

/**
 * 重试发送：从发件箱行原样回读 content/imagesJson/replyToId，复用原 requestId。
 * - failed_send（发送失败）→ 重新走完整发送（PC 按 requestId 幂等去重）；
 * - failed_generation / user_committed / awaiting_ai（用户消息已落盘）→ 转生成重试，
 *   绝不重发用户消息（防重复消息）。
 */
class RetrySendUseCase(private val repository: ChatRepository) {

    suspend operator fun invoke(sessionId: String, requestId: String): Message {
        val entry = repository.outboxEntry(requestId)
            ?: throw CompanionError.Offline("该消息已不在发件箱中")
        return repository.sendMessage(
            sessionId = sessionId,
            requestId = requestId,
            content = entry.content,
            replyToId = entry.replyToId,
            images = entry.images,
        )
    }
}

/** 仅重试 AI 生成（不重发用户消息）：v2 任务走 /api/v2/tasks/:taskId/retry。 */
class RetryGenerationUseCase(private val repository: ChatRepository) {

    suspend operator fun invoke(requestId: String): Message =
        repository.retryGeneration(requestId)
}

/** 取消：queued/sending 本地取消；已有 taskId 的 v2 任务同时请求 PC 取消生成。 */
class CancelQueuedMessageUseCase(private val repository: ChatRepository) {

    suspend operator fun invoke(requestId: String): Boolean =
        repository.cancelOutbox(requestId)
}
