package com.qingyu.companion.data.send

/**
 * F-02：task 事件 cursor 处理规则（纯函数，JVM 可测）。
 *
 * 规则（方案 §10 F-02）：
 * - sequence == last + 1：应用并更新 cursor；
 * - sequence <= last：重复事件，忽略；
 * - sequence > last + 1：暂停应用后续事件，REST 补拉
 *   `/api/v2/tasks/:taskId/events?afterSequence=<last>`；
 * - 补拉仍缺失：取 task 快照（checkpoint/最终结果）兜底（调用方处理）。
 *
 * cursor 以 (deviceId, taskId) 持久化（Room task_cursors），切换 PC 不共享。
 */
object TaskCursorLogic {

    enum class Action {
        /** 应用事件并把 cursor 推进到该 sequence */
        APPLY_ADVANCE,

        /** 重复事件（sequence <= last），忽略 */
        IGNORE_DUPLICATE,

        /** 缺口（sequence > last + 1）：暂停应用，先 REST 补拉 */
        PAUSE_GAP,
    }

    /** 逐事件判定（纯函数）。 */
    fun decide(lastSequence: Long, incomingSequence: Long): Action = when {
        incomingSequence <= lastSequence -> Action.IGNORE_DUPLICATE
        incomingSequence == lastSequence + 1 -> Action.APPLY_ADVANCE
        else -> Action.PAUSE_GAP
    }

    /**
     * 对一批按 sequence 升序排列的事件计算应用计划（批量场景：REST 补拉页/WS 连发）。
     *
     * @param cursor 当前已应用到的最后 sequence
     * @param sequences 事件 sequence 列表（调用方保证升序；乱序由调用方先排序）
     * @return [Plan]
     *   - appliedTo：连续应用后的新 cursor（无应用时等于入参 cursor）；
     *   - gapAt：首个缺口的 sequence（其余事件一律不应用——"暂停应用"），无缺口为 null；
     *   - appliedCount：应应用的事件数。
     */
    data class Plan(
        val appliedTo: Long,
        val gapAt: Long?,
        val appliedCount: Int,
    )

    fun planBatch(cursor: Long, sequences: List<Long>): Plan {
        var applied = cursor
        var count = 0
        var gap: Long? = null
        for (seq in sequences) {
            when (decide(applied, seq)) {
                Action.APPLY_ADVANCE -> {
                    applied = seq
                    count += 1
                }
                Action.IGNORE_DUPLICATE -> Unit
                Action.PAUSE_GAP -> {
                    gap = seq
                    break // 暂停应用后续事件
                }
            }
        }
        return Plan(appliedTo = applied, gapAt = gap, appliedCount = count)
    }

    /**
     * 兜底判定：REST 补拉后仍缺失时，是否需要取 task 快照（checkpoint/最终结果）重建。
     * 条件：补拉页声明 resyncRequired（事件日志压缩），或首个返回事件仍越过 cursor+1，
     * 或页面为空但快照 lastSequence 已越过 cursor（事件已不可得）。
     */
    fun needsSnapshotFallback(
        cursor: Long,
        firstEventSequence: Long?,
        resyncRequired: Boolean,
        snapshotLastSequence: Long?,
    ): Boolean {
        if (resyncRequired) return true
        if (firstEventSequence != null && firstEventSequence > cursor + 1) return true
        if (firstEventSequence == null && snapshotLastSequence != null && snapshotLastSequence > cursor) return true
        return false
    }
}
