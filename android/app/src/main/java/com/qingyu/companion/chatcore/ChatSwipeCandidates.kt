package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-04：消息候选（swipe）语义
 * （对齐 `shared/chat-core/swipeCandidates.ts`）。
 *
 * 语义是「**同一条消息**持有多个候选，当前内容与索引指向其中一个」，
 * 不是「每次重生成新建一条消息」。这条区分不是风格问题：
 * 消息数量会直接进入导出、分页与上下文预算，一端实现成新建就会让两端数据不同。
 *
 * Android 侧此前正是「新建一条消息」的实现（本轮修正）。
 */
object ChatSwipeCandidates {

    data class Target(
        val content: String,
        val swipes: List<String>? = null,
        val swipeIndex: Int? = null,
    )

    data class Update(
        val content: String,
        val swipes: List<String>,
        val swipeIndex: Int,
    )

    /**
     * 重新生成：**追加**新候选（不删除原内容），并把当前内容指向新候选。
     * 原消息 id 不变——这是「同一条消息的多个候选」。
     */
    fun appendRegeneratedCandidate(target: Target, newContent: String): Update {
        val swipes = target.swipes ?: listOf(target.content)
        return Update(
            swipes = swipes + newContent,
            swipeIndex = swipes.size,
            content = newContent,
        )
    }

    /**
     * 在已有候选之间切换。
     * - `direction == 0` 不属于本函数（那是重新生成）；
     * - 候选少于 2 个时无可切换，原样返回；
     * - 循环取模，支持任意正负方向。
     *
     * 注意越界索引的处理：PC 是 `(current + direction + len) % len`，
     * Kotlin 的 `%` 对负数返回负值，必须显式取正后再取模。
     */
    fun rotateSwipe(target: Target, direction: Int): Update {
        val swipes = target.swipes ?: listOf(target.content)
        val current = target.swipeIndex ?: 0
        if (swipes.size < 2) {
            return Update(content = target.content, swipes = swipes, swipeIndex = current)
        }
        val next = (((current + direction) % swipes.size) + swipes.size) % swipes.size
        return Update(content = swipes[next], swipes = swipes, swipeIndex = next)
    }

    /** 候选视图（供界面显示「第 i / n 个」）。 */
    fun candidatePosition(target: Target): Pair<Int, Int> {
        val swipes = target.swipes ?: listOf(target.content)
        val index = target.swipeIndex ?: 0
        return maxOf(0, minOf(index, swipes.size - 1)) to swipes.size
    }
}
