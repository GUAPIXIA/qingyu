package com.qingyu.companion.ui.notification

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.qingyu.companion.MainActivity
import com.qingyu.companion.R
import java.util.Calendar

/**
 * 通知中心（P1-C 5.3）：
 * - 4 条渠道：生成完成 / 长记忆 / 连接 / 安全确认
 * - 仅用户发起任务时触发，可点击回到对应会话
 * - 尊重 UiPrefsStore：总开关 / 内容隐藏 / 免打扰
 * - Android 13+ 动态申请 POST_NOTIFICATIONS
 */
object AppNotificationHelper {

    const val CHANNEL_GENERATION = "qingyu_generation"
    const val CHANNEL_MEMORY = "qingyu_memory"
    const val CHANNEL_CONNECTION = "qingyu_connection"
    const val CHANNEL_SECURITY = "qingyu_security"
    private const val GROUP_ID = "qingyu_tasks"
    private const val GROUP_NAME = "任务通知"

    const val NOTIF_ID_GENERATION = 1001
    const val NOTIF_ID_MEMORY = 1002
    const val NOTIF_ID_CONNECTION = 1003
    const val NOTIF_ID_SECURITY = 1004

    @SuppressLint("NewApi")
    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 28) {
            if (mgr.getNotificationChannelGroup(GROUP_ID) == null) {
                mgr.createNotificationChannelGroup(NotificationChannelGroup(GROUP_ID, GROUP_NAME))
            }
        }
        val channels = listOf(
            NotificationChannel(CHANNEL_GENERATION, "AI 生成", NotificationManager.IMPORTANCE_LOW).apply {
                description = "AI 回复完成（可点击回到会话）"
                group = GROUP_ID
                setShowBadge(false)
            },
            NotificationChannel(CHANNEL_MEMORY, "长记忆", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "长记忆总结完成/失败"
                group = GROUP_ID
                setShowBadge(false)
            },
            NotificationChannel(CHANNEL_CONNECTION, "连接", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "连接失效，需要重新配对"
                group = GROUP_ID
                setShowBadge(false)
            },
            NotificationChannel(CHANNEL_SECURITY, "安全确认", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "PC 端需要手机确认的安全事件"
                group = GROUP_ID
                setShowBadge(true)
            },
        )
        channels.forEach { ch ->
            if (mgr.getNotificationChannel(ch.id) == null) mgr.createNotificationChannel(ch)
        }
    }

    fun canPost(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33) {
            return ActivityCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    fun isDndActive(startHour: Int, endHour: Int, nowHour: Int = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)): Boolean {
        if (startHour == endHour) return false
        return if (startHour < endHour) {
            nowHour in startHour until endHour
        } else {
            nowHour >= startHour || nowHour < endHour
        }
    }

    fun shouldPost(
        notificationsEnabled: Boolean,
        dndEnabled: Boolean,
        dndStart: Int,
        dndEnd: Int,
        canPostSystem: Boolean,
    ): Boolean {
        if (!notificationsEnabled) return false
        if (!canPostSystem) return false
        if (dndEnabled && isDndActive(dndStart, dndEnd)) return false
        return true
    }

    private fun pendingForSession(context: Context, sessionId: String?, extra: String? = null): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("openSessionId", sessionId)
            putExtra("fromNotification", true)
            if (extra != null) putExtra("notification_extra", extra)
        }
        return PendingIntent.getActivity(
            context,
            (sessionId?.hashCode() ?: extra?.hashCode() ?: 0),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun pendingForPairing(context: Context): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("openPairing", true)
        }
        return PendingIntent.getActivity(context, 2001, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    @SuppressLint("MissingPermission")
    fun showGenerating(context: Context, sessionId: String, characterName: String = "") {
        ensureChannels(context)
        if (!canPost(context)) return
        val title = if (characterName.isNotBlank()) "正在为 $characterName 生成回复…" else "正在生成回复…"
        val text = "轻语正在为你生成回复（点击回到会话）"
        val notif = NotificationCompat.Builder(context, CHANNEL_GENERATION)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(pendingForSession(context, sessionId))
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        NotificationManagerCompat.from(context).notify(NOTIF_ID_GENERATION, notif)
    }

    @SuppressLint("MissingPermission")
    fun showGenerationCompleted(
        context: Context,
        sessionId: String?,
        preview: String,
        hideContent: Boolean,
        characterName: String = "",
    ) {
        ensureChannels(context)
        val resolvedText = if (hideContent) "AI 回复已完成（点击查看）" else preview.take(80).ifBlank { "AI 回复已完成" }
        val title = if (characterName.isNotBlank() && !hideContent) "$characterName 回复完成" else "生成完成"
        val notif = NotificationCompat.Builder(context, CHANNEL_GENERATION)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(resolvedText)
            .setOngoing(false)
            .setAutoCancel(true)
            .setContentIntent(pendingForSession(context, sessionId, "generation"))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()
        NotificationManagerCompat.from(context).notify(NOTIF_ID_GENERATION, notif)
    }

    @SuppressLint("MissingPermission")
    fun showMemoryResult(context: Context, sessionId: String?, success: Boolean, hideContent: Boolean) {
        ensureChannels(context)
        val title = if (success) "长记忆总结完成" else "长记忆总结失败"
        val text = if (hideContent) {
            if (success) "已完成（点击查看）" else "失败，可重试"
        } else {
            if (success) "本轮对话已归档到长记忆" else "总结失败，请稍后重试"
        }
        val notif = NotificationCompat.Builder(context, CHANNEL_MEMORY)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .setContentIntent(pendingForSession(context, sessionId, "memory"))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        NotificationManagerCompat.from(context).notify(NOTIF_ID_MEMORY, notif)
    }

    @SuppressLint("MissingPermission")
    fun showConnectionFailed(context: Context, hideContent: Boolean, host: String? = null) {
        ensureChannels(context)
        val title = "连接失效"
        val text = if (hideContent) "需要重新配对（点击前往）" else {
            if (host != null) "与 $host 的连接已失效，需重新配对" else "与 PC 的连接已失效，需重新配对"
        }
        val notif = NotificationCompat.Builder(context, CHANNEL_CONNECTION)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .setContentIntent(pendingForPairing(context))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .build()
        NotificationManagerCompat.from(context).notify(NOTIF_ID_CONNECTION, notif)
    }

    @SuppressLint("MissingPermission")
    fun showSecurityConfirmation(context: Context, hideContent: Boolean, detail: String? = null) {
        ensureChannels(context)
        val title = "需要确认"
        val text = if (hideContent) "PC 端请求确认（点击处理）" else detail?.take(80) ?: "PC 端需要手机确认"
        val notif = NotificationCompat.Builder(context, CHANNEL_SECURITY)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .setContentIntent(pendingForSession(context, null, "security"))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_EVENT)
            .build()
        NotificationManagerCompat.from(context).notify(NOTIF_ID_SECURITY, notif)
    }

    fun cancel(context: Context, id: Int) {
        NotificationManagerCompat.from(context).cancel(id)
    }

    fun cancelAll(context: Context) {
        val mgr = NotificationManagerCompat.from(context)
        mgr.cancel(NOTIF_ID_GENERATION)
        mgr.cancel(NOTIF_ID_MEMORY)
        mgr.cancel(NOTIF_ID_CONNECTION)
        mgr.cancel(NOTIF_ID_SECURITY)
    }
}
