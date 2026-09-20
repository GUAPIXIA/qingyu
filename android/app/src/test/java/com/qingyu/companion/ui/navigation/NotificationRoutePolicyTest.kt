package com.qingyu.companion.ui.navigation

import com.qingyu.companion.ui.notification.NotificationTarget
import com.qingyu.companion.ui.notification.notificationTargetFromExtras
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A-03 通知 deep link 纯函数单测：只验证 extras 解析与"通知目标 × 启动决策 → 落地路由"映射，
 * 不涉及 Intent/NavController（依赖 android.os 的适配层不做本地单测）。
 * 覆盖：无目标、blank sessionId、openPairing 优先、决策未完成不消费，
 * 以及两种启动决策 × 两类通知目标的全部组合。
 *
 * 阶段 4 收口：启动决策只剩 PENDING / READY，且**不再有「会话通知落到配对页」的分支**——
 * 会话通知在决策就绪时直达会话；配对只由通知里显式选择的 OpenPairing 触发。
 */
class NotificationRoutePolicyTest {

    // ---------- notificationTargetFromExtras：extras 解析 ----------

    @Test
    fun `无 extras → null 不产生 deep link`() {
        assertNull(notificationTargetFromExtras(openSessionId = null, openPairing = false))
    }

    @Test
    fun `sessionId 为空白 → null 不产生 deep link`() {
        assertNull(notificationTargetFromExtras(openSessionId = "", openPairing = false))
        assertNull(notificationTargetFromExtras(openSessionId = "   ", openPairing = false))
    }

    @Test
    fun `openSessionId 有值 → OpenSession`() {
        assertEquals(
            NotificationTarget.OpenSession("s1"),
            notificationTargetFromExtras(openSessionId = "s1", openPairing = false),
        )
    }

    @Test
    fun `openPairing 有值 → OpenPairing`() {
        assertEquals(
            NotificationTarget.OpenPairing,
            notificationTargetFromExtras(openSessionId = null, openPairing = true),
        )
    }

    @Test
    fun `openPairing 与 sessionId 同时存在 → OpenPairing 优先（确定性）`() {
        assertEquals(
            NotificationTarget.OpenPairing,
            notificationTargetFromExtras(openSessionId = "s1", openPairing = true),
        )
    }

    // ---------- notificationRouteFor：通知目标 × 启动决策 → 落地路由 ----------

    @Test
    fun `无通知目标 → null 不干预启动路由`() {
        assertNull(notificationRouteFor(null, StartupDecision.READY))
        assertNull(notificationRouteFor(null, StartupDecision.PENDING))
    }

    @Test
    fun `决策未完成 PENDING → null 通知目标不消费（A-03 启动决策完成后再消费）`() {
        assertNull(notificationRouteFor(NotificationTarget.OpenSession("s1"), StartupDecision.PENDING))
        assertNull(notificationRouteFor(NotificationTarget.OpenPairing, StartupDecision.PENDING))
    }

    @Test
    fun `Ready + OpenSession → 直达对应会话`() {
        assertEquals(
            NotificationRoute.Chat("s1"),
            notificationRouteFor(NotificationTarget.OpenSession("s1"), StartupDecision.READY),
        )
    }

    @Test
    fun `OpenPairing → 已决状态去 PAIRING（仅由显式配对目标触发）`() {
        assertEquals(
            NotificationRoute.Pairing,
            notificationRouteFor(NotificationTarget.OpenPairing, StartupDecision.READY),
        )
    }
}
