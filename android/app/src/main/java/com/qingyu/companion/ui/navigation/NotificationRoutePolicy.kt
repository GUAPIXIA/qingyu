package com.qingyu.companion.ui.navigation

import com.qingyu.companion.ui.notification.NotificationTarget

/**
 * 启动决策的导航视角抽象（A-03）：CompanionNavHost 在 StartupScreen 决策回调处记录。
 * [PENDING] 表示决策尚未完成——通知 deep link 在此期间一律不消费。
 */
enum class StartupDecision {
    PENDING,
    READY,
    READY_WITHOUT_ACTIVE,
    NEEDS_PAIRING,
}

/**
 * 通知目标消费后应落地的路由（抽象描述，与 Routes 字符串解耦以便纯函数单测）。
 */
sealed interface NotificationRoute {
    /** 打开会话聊天页（notification extras 不含 characterId，传空由聊天页自行解析） */
    data class Chat(val sessionId: String) : NotificationRoute

    data object ConnectionPicker : NotificationRoute

    data object Pairing : NotificationRoute
}

/**
 * 通知目标 × 启动决策 → 落地路由（纯函数，单测目标；A-03"启动决策完成后再消费"）。
 * - 决策未完成（PENDING）或无通知目标 → null：不干预常规启动路由
 * - READY + OpenSession → 对应会话
 * - READY_WITHOUT_ACTIVE + OpenSession → CONNECTION_PICKER（不擅自猜 PC）
 * - NEEDS_PAIRING + OpenSession → PAIRING
 * - OpenPairing → 任何已决状态都去 PAIRING
 */
fun notificationRouteFor(
    target: NotificationTarget?,
    decision: StartupDecision,
): NotificationRoute? {
    if (target == null || decision == StartupDecision.PENDING) return null
    return when (target) {
        is NotificationTarget.OpenSession -> when (decision) {
            StartupDecision.READY -> NotificationRoute.Chat(target.sessionId)
            StartupDecision.READY_WITHOUT_ACTIVE -> NotificationRoute.ConnectionPicker
            StartupDecision.NEEDS_PAIRING,
            StartupDecision.PENDING,
            -> NotificationRoute.Pairing
        }
        NotificationTarget.OpenPairing -> NotificationRoute.Pairing
    }
}
