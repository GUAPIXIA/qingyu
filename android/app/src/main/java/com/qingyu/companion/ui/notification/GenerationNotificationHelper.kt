package com.qingyu.companion.ui.notification

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
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

object GenerationNotificationHelper {
    private const val CHANNEL_ID = "qingyu_generation"
    private const val CHANNEL_NAME = "生成中"
    const val NOTIF_ID = 1001

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "AI 生成中通知（可点击回到会话）"
                    setShowBadge(false)
                }
                mgr.createNotificationChannel(channel)
            }
        }
    }

    private fun canPost(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33) {
            return ActivityCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    private fun pendingIntentForSession(context: Context, sessionId: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("openSessionId", sessionId)
            putExtra("fromNotification", true)
        }
        return PendingIntent.getActivity(
            context,
            (sessionId?.hashCode() ?: 0),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    @SuppressLint("MissingPermission")
    fun showGenerating(context: Context, sessionId: String, characterName: String = "") {
        ensureChannel(context)
        if (!canPost(context)) return
        val title = if (characterName.isNotBlank()) "正在为 $characterName 生成回复…" else "正在生成回复…"
        val text = "轻语正在为你生成回复（点击回到会话）"
        val notif = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(pendingIntentForSession(context, sessionId))
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        NotificationManagerCompat.from(context).notify(NOTIF_ID, notif)
    }

    @SuppressLint("MissingPermission")
    fun showCompleted(context: Context, sessionId: String?, text: String) {
        ensureChannel(context)
        if (!canPost(context)) return
        val notif = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("生成完成")
            .setContentText(text)
            .setOngoing(false)
            .setAutoCancel(true)
            .setContentIntent(pendingIntentForSession(context, sessionId))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        NotificationManagerCompat.from(context).notify(NOTIF_ID, notif)
    }

    @SuppressLint("MissingPermission")
    fun showError(context: Context, sessionId: String?, text: String) {
        ensureChannel(context)
        if (!canPost(context)) return
        val notif = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("生成失败")
            .setContentText(text)
            .setOngoing(false)
            .setAutoCancel(true)
            .setContentIntent(pendingIntentForSession(context, sessionId))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        NotificationManagerCompat.from(context).notify(NOTIF_ID, notif)
    }

    fun cancel(context: Context, id: Int = NOTIF_ID) {
        NotificationManagerCompat.from(context).cancel(id)
    }
}
