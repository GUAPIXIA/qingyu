package com.qingyu.companion.ui.notification

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A-06 通知权限延迟申请策略单测（JVM 纯函数，不 mock Compose/Android 运行时）：
 * 覆盖「开启任务通知后的动作决策」「首生成非阻塞提示条件」「App 开关与系统可投递合成」。
 */
class NotificationPermissionPolicyTest {

    @Test
    fun `Android13以下开启通知无需系统动作`() {
        assertEquals(
            TaskNotificationEnableAction.None,
            decideTaskNotificationEnableAction(
                permissionRequired = false,
                granted = false,
                shouldShowRationale = false,
                askedBefore = false,
            ),
        )
    }

    @Test
    fun `已授予权限时不再弹任何请求`() {
        assertEquals(
            TaskNotificationEnableAction.None,
            decideTaskNotificationEnableAction(
                permissionRequired = true,
                granted = true,
                shouldShowRationale = false,
                askedBefore = true,
            ),
        )
    }

    @Test
    fun `首次请求走系统权限框`() {
        assertEquals(
            TaskNotificationEnableAction.RequestSystem,
            decideTaskNotificationEnableAction(
                permissionRequired = true,
                granted = false,
                shouldShowRationale = false,
                askedBefore = false,
            ),
        )
    }

    @Test
    fun `曾请求但系统仍可再问时继续请求`() {
        assertEquals(
            TaskNotificationEnableAction.RequestSystem,
            decideTaskNotificationEnableAction(
                permissionRequired = true,
                granted = false,
                shouldShowRationale = true,
                askedBefore = true,
            ),
        )
    }

    @Test
    fun `永久拒绝不再弹系统框改走设置入口`() {
        assertEquals(
            TaskNotificationEnableAction.OpenSystemSettings,
            decideTaskNotificationEnableAction(
                permissionRequired = true,
                granted = false,
                shouldShowRationale = false,
                askedBefore = true,
            ),
        )
    }

    @Test
    fun `首生成提示仅在开关开启且不可投递且未提示过时出现`() {
        assertTrue(
            shouldShowFirstGenerationNotificationHint(
                appNotificationsEnabled = true,
                canPostSystem = false,
                alreadyShown = false,
            ),
        )
        // App 内开关关闭：用户明确不要通知，不打扰
        assertFalse(
            shouldShowFirstGenerationNotificationHint(
                appNotificationsEnabled = false,
                canPostSystem = false,
                alreadyShown = false,
            ),
        )
        // 已可投递：无需提示
        assertFalse(
            shouldShowFirstGenerationNotificationHint(
                appNotificationsEnabled = true,
                canPostSystem = true,
                alreadyShown = false,
            ),
        )
        // 本次会话已提示过：不重复
        assertFalse(
            shouldShowFirstGenerationNotificationHint(
                appNotificationsEnabled = true,
                canPostSystem = false,
                alreadyShown = true,
            ),
        )
    }

    @Test
    fun `渠道投递与App开关一致`() {
        assertTrue(canPostNotification(appEnabled = true, canPostSystem = true))
        // A-06 验收：App 内「任务通知」关闭后，即使系统权限仍在也不投递
        assertFalse(canPostNotification(appEnabled = false, canPostSystem = true))
        assertFalse(canPostNotification(appEnabled = true, canPostSystem = false))
        assertFalse(canPostNotification(appEnabled = false, canPostSystem = false))
    }
}
