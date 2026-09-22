package com.qingyu.companion.chatcore

/**
 * 阶段 6 S6-01：派生记忆（历史摘要/当前状态/关键事实/事实向量/压缩摘要）的
 * 失效决策（对齐 `shared/chat-core/derivedMemory.ts`，单聊与群聊同一检查点语义）。
 *
 * 编辑/删除/清空消息后是否废止派生记忆，决定「保留派生数据」还是
 * 「全量失效 + memoryVersion 归零」。两端判定不一致会导致一端保留旧摘要、
 * 另一端重建，群记忆的 CAS（memoryVersion 乐观锁）也随之漂移。
 *
 * 检查点语义（阶段五检查点，与 PC 逐字一致）：
 * - 无派生数据 → 保留；
 * - `changedMessageId` 为空（clearChat 等）→ 全量失效；
 * - 无检查点（memoryLastMessageId 空 / memoryVersion 0）→ 全量失效；
 * - 变更消息在游标**之后** → 保留派生记忆；
 * - 变更在游标之前或等于游标、游标或消息找不到 → 保守全量失效。
 *
 * variant 语义钉子：'chat'（单聊）把 `memoryFactParseFailureCount` /
 * `memoryFactRetryAfterVersion` 计入「有派生数据」；'group'（群聊）不计。
 * 这是 PC 两侧现状差异（已知行为，不是缺陷），fixture 钉死，任何一端改变
 * 都必须先改契约。
 */
object ChatMemoryInvalidation {

    /** 派生记忆快照；缺失键按 null/空处理（与 TS 侧 truthiness 判定对齐）。 */
    data class Snapshot(
        val memory: String? = null,
        val memoryCurrentState: String? = null,
        val memoryFacts: List<Any?>? = null,
        val memoryFactHistory: List<Any?>? = null,
        val factsVectors: List<Any?>? = null,
        val memoryLastMessageId: String? = null,
        val memoryVersion: Long? = null,
        val compressedSummary: String? = null,
        val memoryFactParseFailureCount: Long? = null,
        val memoryFactRetryAfterVersion: Long? = null,
    )

    sealed interface Decision {
        object Keep : Decision
        /** 全量失效：以 expectedVersion 走 CAS 提交 resetPatch（键序与 PC 逐字一致）。 */
        data class Invalidate(val expectedVersion: Long, val patch: Map<String, Any?>) : Decision
    }

    /** 全量失效写入的字段集合（13 键，含归零与置空）。 */
    fun resetPatch(): Map<String, Any?> = linkedMapOf(
        "memory" to "",
        "memoryCurrentState" to "",
        "memoryFacts" to emptyList<Any>(),
        "memoryFactHistory" to emptyList<Any>(),
        "memoryFactParseFailureCount" to 0L,
        "memoryFactRetryAfterVersion" to 0L,
        "factsVectors" to emptyList<Any>(),
        "memoryUpdatedAt" to 0L,
        "memoryLastMessageId" to null,
        "memoryVersion" to 0L,
        "factsVectorVersion" to 0L,
        "compressedSummary" to null,
        "compressedRange" to null,
    )

    fun plan(
        variant: String,
        session: Snapshot,
        messageIds: List<String>,
        changedMessageId: String?,
    ): Decision {
        val parseFailureCounts = if (variant == "chat") {
            (session.memoryFactParseFailureCount ?: 0L) != 0L ||
                (session.memoryFactRetryAfterVersion ?: 0L) != 0L
        } else {
            false
        }
        val hasDerived = !session.memory.isNullOrEmpty() ||
            !session.memoryCurrentState.isNullOrEmpty() ||
            !session.memoryFacts.isNullOrEmpty() ||
            !session.memoryFactHistory.isNullOrEmpty() ||
            !session.factsVectors.isNullOrEmpty() ||
            !session.memoryLastMessageId.isNullOrEmpty() ||
            (session.memoryVersion ?: 0L) != 0L ||
            parseFailureCounts ||
            !session.compressedSummary.isNullOrEmpty()
        if (!hasDerived) return Decision.Keep

        if (!changedMessageId.isNullOrEmpty()) {
            val cursor = session.memoryLastMessageId
            val version = session.memoryVersion ?: 0L
            if (cursor.isNullOrEmpty() || version == 0L) {
                // 无检查点 → 全量失效
            } else {
                val cursorIndex = messageIds.indexOf(cursor)
                val changedIndex = messageIds.indexOf(changedMessageId)
                if (cursorIndex == -1 || changedIndex == -1) {
                    // 消息或游标找不到 → 保守全量失效
                } else if (changedIndex > cursorIndex) {
                    // 变更在已总结范围之后，保留记忆
                    return Decision.Keep
                }
                // 变更在游标前或等于游标 → 全量失效
            }
        }

        return Decision.Invalidate(
            expectedVersion = session.memoryVersion ?: 0L,
            patch = resetPatch(),
        )
    }
}
