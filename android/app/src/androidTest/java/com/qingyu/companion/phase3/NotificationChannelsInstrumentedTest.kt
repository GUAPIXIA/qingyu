package com.qingyu.companion.phase3

import android.app.NotificationManager
import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.qingyu.companion.ui.notification.AppNotificationHelper
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 阶段 3 门禁回归：`AppNotificationHelper.ensureChannels` 必须在 API 26—34 全档可用。
 *
 * 背景（阶段 3 API 26 门禁实测发现，已修复）：API 26/27 上
 * `NotificationChannel.setGroup` 引用不存在的渠道组会让 `createNotificationChannel`
 * 抛 `IllegalArgumentException: NotificationChannelGroup doesn't exist`；
 * 该异常发生在 `CompanionApp.onCreate → AppContainer.start → NotificationDispatcher.start`，
 * 会让 API 26 设备**直接启动崩溃**，并使 instrumentation 0 tests 完成。
 *
 * 本测试在真实系统 NotificationManager 上调用同一入口，覆盖该回归。
 */
@RunWith(AndroidJUnit4::class)
class NotificationChannelsInstrumentedTest {

    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun ensureChannelsCreatesAllFourChannelsOnThisApiLevel() {
        // 必须在真实 NotificationManager 上执行：API 26/27 的组校验只在系统实现里发生
        AppNotificationHelper.ensureChannels(context)

        val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        listOf(
            AppNotificationHelper.CHANNEL_GENERATION,
            AppNotificationHelper.CHANNEL_MEMORY,
            AppNotificationHelper.CHANNEL_CONNECTION,
            AppNotificationHelper.CHANNEL_SECURITY,
        ).forEach { id ->
            assertNotNull("渠道 $id 必须存在（api=${android.os.Build.VERSION.SDK_INT}）", mgr.getNotificationChannel(id))
        }
        println(
            "NotificationChannelsInstrumentedTest: api=${android.os.Build.VERSION.SDK_INT} " +
                "model=${android.os.Build.MODEL} channels=4 ok",
        )
    }

    @Test
    fun ensureChannelsIsIdempotent() {
        AppNotificationHelper.ensureChannels(context)
        AppNotificationHelper.ensureChannels(context)
        val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        assertNotNull(mgr.getNotificationChannel(AppNotificationHelper.CHANNEL_GENERATION))
    }
}
