package com.qingyu.companion.data.send

import com.qingyu.companion.data.OutboxMessage

/**
 * F-04：Outbox 八态状态机（纯函数，JVM 可测）。
 * 唯一写入权威：Repository/UseCase 一律经 [advance] 产出新行，再在 Room 事务内 upsert。
 *
 * 状态与转换（发送链路时序修复——此前 awaiting_ai 在 REST 调用前置位，时序错误）：
 * ```
 * queued ──开始发送──▶ sending ──PC 确认用户消息落盘(拿到 remoteUserMessageId)──▶ user_committed
 *   ▲                    │                                                        │
 *   │ 重试               │发送失败                    任务开始(拿到 taskId)         ▼
 *   └── failed_send ◀────┘                                     awaiting_ai ──生成完成──▶ completed
 *                                      ▲                            │
 *                                      └────生成失败──── failed_generation
 * 任意未完成态 ──用户取消──▶ cancelled；completed/cancelled 为终态。
 * ```
 * v1 兼容链路：v1 REST 单次调用即含"用户消息落盘+AI 完成"，因此 v1 走
 * queued→sending→completed 直达（sending→awaiting_ai 亦合法，供 v1 中间态接入）。
 *
 * 失败退避：retryCount 递增，nextAttemptAt = now + [backoffMs]（1s/2s/4s/8s/15s/30s 封顶）。
 */
object OutboxStateMachine {

    const val QUEUED = "queued"
    const val SENDING = "sending"
    const val RELAY_QUEUED = "relay_queued"
    const val USER_COMMITTED = "user_committed"
    const val AWAITING_AI = "awaiting_ai"
    const val COMPLETED = "completed"
    const val FAILED_SEND = "failed_send"
    const val FAILED_GENERATION = "failed_generation"
    const val CANCELLED = "cancelled"

    /** 八态全集 */
    val ALL: Set<String> = setOf(
        QUEUED, SENDING, RELAY_QUEUED, USER_COMMITTED, AWAITING_AI,
        COMPLETED, FAILED_SEND, FAILED_GENERATION, CANCELLED,
    )

    /** 终态（不再转换） */
    val TERMINAL: Set<String> = setOf(COMPLETED, CANCELLED)

    /** 发件箱视角的"未完成"态（listPending 等查询与恢复矩阵使用） */
    val PENDING: Set<String> = ALL - TERMINAL

    /** 合法转换表（from -> 可达 to 集合） */
    val ALLOWED: Map<String, Set<String>> = mapOf(
        QUEUED to setOf(SENDING, CANCELLED),
        // sending→queued 仅供 F-06 重启恢复使用（强杀时行停在 sending，回队后同 requestId 重发）
        SENDING to setOf(RELAY_QUEUED, USER_COMMITTED, AWAITING_AI, COMPLETED, FAILED_SEND, QUEUED, CANCELLED),
        RELAY_QUEUED to setOf(COMPLETED, FAILED_SEND, QUEUED, CANCELLED),
        USER_COMMITTED to setOf(AWAITING_AI, COMPLETED, FAILED_GENERATION, CANCELLED),
        AWAITING_AI to setOf(COMPLETED, FAILED_GENERATION, CANCELLED),
        FAILED_SEND to setOf(QUEUED, CANCELLED),
        FAILED_GENERATION to setOf(AWAITING_AI, CANCELLED),
        COMPLETED to emptySet(),
        CANCELLED to emptySet(),
    )

    /** 失败退避序列（毫秒，封顶 30s）：1s/2s/4s/8s/15s/30s */
    val RETRY_BACKOFF_MS: List<Long> = listOf(1_000L, 2_000L, 4_000L, 8_000L, 15_000L, 30_000L)

    /** 第 retryCount 次失败后的下次尝试延迟（超出序列取封顶值） */
    fun backoffMs(retryCount: Int): Long =
        RETRY_BACKOFF_MS.getOrElse(retryCount - 1) { RETRY_BACKOFF_MS.last() }

    /** 非法转换 */
    class IllegalTransition(from: String, to: String) :
        IllegalStateException("Outbox 非法状态转换: $from -> $to")

    /**
     * 计算状态转换后的新行（纯函数，不落库；调用方负责在 Room 事务内 upsert）。
     *
     * @param to 目标态；与当前态相同视为幂等（返回当前行，仅刷新 updatedAt）
     * @param errorCode/errorMessage 失败原因（脱敏；不含 token/配对码/消息正文）
     * @param taskId/remoteUserMessageId v5 链路标识接线（null = 保持原值）
     * @param countRetry true 时 retryCount+1 并按退避写入 nextAttemptAt（failed_* 转换用）
     * @throws IllegalTransition 转换表不允许
     */
    fun advance(
        current: OutboxMessage,
        to: String,
        now: Long,
        errorCode: String? = null,
        errorMessage: String? = null,
        taskId: String? = null,
        remoteUserMessageId: String? = null,
        countRetry: Boolean = false,
    ): OutboxMessage {
        require(to in ALL) { "未知 Outbox 状态: $to" }
        if (current.state == to) {
            // 幂等：并发双发/重复事件不产生新转换
            return current.copy(updatedAt = now)
        }
        if (to !in (ALLOWED[current.state] ?: emptySet())) {
            throw IllegalTransition(current.state, to)
        }
        val retryCount = if (countRetry) current.retryCount + 1 else current.retryCount
        val nextAttempt = when {
            countRetry -> now + backoffMs(retryCount)
            // 回队/终态：清除既有调度
            to == QUEUED || to in TERMINAL -> null
            else -> current.nextAttemptAt
        }
        // 错误字段仅在失败转换上写入；其余转换一律清除——状态机是唯一写入权威，
        // 保证"成功/中性转换后行内不残留旧错误"（避免 UI 误报失败）
        val isFailure = to == FAILED_SEND || to == FAILED_GENERATION
        return current.copy(
            state = to,
            updatedAt = now,
            retryCount = retryCount,
            nextAttemptAt = nextAttempt,
            lastErrorCode = if (isFailure) errorCode else null,
            // 错误文案截断，防异常消息膨胀（不含敏感数据，仍限长）
            lastErrorMessage = (if (isFailure) errorMessage else null)?.take(200),
            taskId = taskId ?: current.taskId,
            remoteUserMessageId = remoteUserMessageId ?: current.remoteUserMessageId,
            // v4 遗留 error 列：F-04 起统一 lastError*，旧列清空
            error = null,
        )
    }
}
