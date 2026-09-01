package com.qingyu.companion.ui.navigation

import com.qingyu.companion.ui.notification.NotificationTarget
import com.qingyu.companion.ui.notification.notificationTargetFromExtras
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A-03 通知 deep link 纯函数单测：只验证 extras 解析与"通知目标 × 启动决策 → 落地路由"映射，
 * 不涉及 Intent/NavController（依赖 android.os 的适配层不做本地单测）。
 * 覆盖：无目标、blank sessionId、openPairing 优先、决策未完成不消费、
 * 三种启动决策 × 两类通知目标的全部组合。
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
    fun `ReadyWithoutActive + OpenSession → 忽略会话目标去 CONNECTION_PICKER 不擅自猜 PC`() {
        assertEquals(
            NotificationRoute.ConnectionPicker,
            notificationRouteFor(NotificationTarget.OpenSession("s1"), StartupDecision.READY_WITHOUT_ACTIVE),
        )
    }

    @Test
    fun `NeedsPairing + OpenSession → 忽略会话目标去 PAIRING`() {
        assertEquals(
            NotificationRoute.Pairing,
            notificationRouteFor(NotificationTarget.OpenSession("s1"), StartupDecision.NEEDS_PAIRING),
        )
    }

    @Test
    fun `OpenPairing → 任何已决状态都去 PAIRING`() {
        assertEquals(
            NotificationRoute.Pairing,
            notificationRouteFor(NotificationTarget.OpenPairing, StartupDecision.READY),
        )
        assertEquals(
            NotificationRoute.Pairing,
            notificationRouteFor(NotificationTarget.OpenPairing, StartupDecision.READY_WITHOUT_ACTIVE),
        )
        assertEquals(
            NotificationRoute.Pairing,
            notificationRouteFor(NotificationTarget.OpenPairing, StartupDecision.NEEDS_PAIRING),
        )
    }
}
