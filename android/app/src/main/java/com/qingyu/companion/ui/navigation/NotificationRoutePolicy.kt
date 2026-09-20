package com.qingyu.companion.ui.navigation

import com.qingyu.companion.ui.notification.NotificationTarget

/**
 * 启动决策的导航视角抽象：CompanionNavHost 在 StartupScreen 决策回调处记录。
 *
 * **阶段 4 收口**：启动决策现在只有两种结果（本地就绪 / 需要本地初始化），
 * 因此这里只剩 `PENDING` 与 `READY`。旧的 `READY_WITHOUT_ACTIVE` / `NEEDS_PAIRING`
 * 已无法被产出，却仍被通知深链策略映射到连接选择页/配对页——那是又一条
 * 「旧伴侣模式回退入口」，按完成定义一并删除。
 * [PENDING] 表示决策尚未完成——通知 deep link 在此期间一律不消费。
 */
enum class StartupDecision {
    PENDING,
    READY,
}

/**
 * 通知目标消费后应落地的路由（抽象描述，与 Routes 字符串解耦以便纯函数单测）。
 */
sealed interface NotificationRoute {
    /** 打开会话聊天页（notification extras 不含 characterId，传空由聊天页自行解析） */
    data class Chat(val sessionId: String) : NotificationRoute

    /** 用户主动进入配对流程（通知里显式点击「配对」时才走这里，不作为启动回退） */
    data object Pairing : NotificationRoute
}

/**
 * 通知目标 × 启动决策 → 落地路由（纯函数，单测目标）。
 * - 决策未完成（PENDING）或无通知目标 → null：不干预常规启动路由
 * - READY + OpenSession → 对应会话
 * - OpenPairing → PAIRING（**仅**由通知里显式选择的配对目标触发）
 */
fun notificationRouteFor(
    target: NotificationTarget?,
    decision: StartupDecision,
): NotificationRoute? {
    if (target == null || decision == StartupDecision.PENDING) return null
    return when (target) {
        is NotificationTarget.OpenSession -> when (decision) {
            StartupDecision.READY -> NotificationRoute.Chat(target.sessionId)
            StartupDecision.PENDING -> null
        }
        NotificationTarget.OpenPairing -> NotificationRoute.Pairing
    }
}
