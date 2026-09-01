package com.qingyu.companion.ui.chat

/**
 * ============================================================================
 * 阶段 E · E-05 滚动跟随与新增计数（纯函数，JVM 可测）
 * ============================================================================
 *
 * 消息列表为 `LazyColumn(reverseLayout = true)`：index 0 = 视觉底部（最新消息），
 * 且 reverseLayout 会把视口钉在 index 0——用户在底部时新 chunk 插入 index 0
 * 会自动贴底（无需手动 scrollToItem，即天然跟随）。
 *
 * 语义约定（E-05）：
 * - 用户上滑超过 [FOLLOW_DETACH_THRESHOLD_ITEMS] 后停止自动跟随（实际表现为
 *   视口钉在旧位置，不追新），底部显示「回到最新」+ 新增内容计数；
 * - 新 chunk/消息到达时：跟随中不计数；脱离后每批增量 +1；
 * - 点击「回到最新」回到底部并清零计数，恢复跟随；
 * - 位于底部（index 0）恒为跟随态、计数清零。
 */

/** 用户上滑超过该阈值（条数）后停止自动跟随并显示「回到最新」 */
const val FOLLOW_DETACH_THRESHOLD_ITEMS = 3

/** 滚动跟随状态（不可变快照） */
data class ChatFollowState(
    /** 是否自动跟随（贴底） */
    val following: Boolean = true,
    /** 脱离底部后累计的新增内容计数（chunk 批次/新消息），跳回底部清零 */
    val newCount: Int = 0,
)

/** 滚动位置输入（由 LazyListState 投影，保持纯函数可测） */
data class ScrollSnapshot(
    /** reverseLayout 下的 firstVisibleItemIndex；0 = 视觉底部（最新） */
    val firstVisibleItemIndex: Int,
)

/**
 * 滚动跟随状态机（纯函数）。
 *
 * @param scroll 当前滚动位置
 * @param newContent 本帧到达的新内容批次数（流式 chunk 批次或新消息，0 表示无）
 * @param previous 上一帧状态
 */
fun chatFollowTick(
    scroll: ScrollSnapshot,
    newContent: Int,
    previous: ChatFollowState,
): ChatFollowState {
    val atBottom = scroll.firstVisibleItemIndex == 0
    // 计数累计：跟随中不计数；脱离跟随后每批新内容记 1
    val accrued = if (previous.following) 0 else maxOf(newContent, 0)
    return when {
        // 位于底部：保持/恢复跟随，计数清零
        atBottom -> ChatFollowState(following = true, newCount = 0)

        // 上滑超过阈值：脱离跟随，累计计数
        scroll.firstVisibleItemIndex >= FOLLOW_DETACH_THRESHOLD_ITEMS ->
            ChatFollowState(following = false, newCount = previous.newCount + accrued)

        // 未达阈值：保持原状（跟随中不计，已脱离则累计）
        else -> ChatFollowState(
            following = previous.following,
            newCount = if (previous.following) 0 else previous.newCount + accrued,
        )
    }
}

/** 点击「回到最新」：恢复跟随并清零计数（调用方同时执行 scrollToItem(0)） */
fun chatFollowReset(previous: ChatFollowState): ChatFollowState =
    ChatFollowState(following = true, newCount = 0)

/** 是否应显示「回到最新」浮层：仅脱离跟随后显示 */
fun chatFollowOverlayVisible(state: ChatFollowState): Boolean = !state.following
