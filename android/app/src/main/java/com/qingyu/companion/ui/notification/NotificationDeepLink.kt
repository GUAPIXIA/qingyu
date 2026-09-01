package com.qingyu.companion.ui.notification

import android.content.Intent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * 通知 deep link 的目标（A-03 边界收尾）：
 * 通知 PendingIntent 只携带 extras（不新增 intent-filter），MainActivity 提取为 [NotificationTarget]。
 * - [OpenSession]：点生成/记忆类通知回到对应会话（extras 仅含 sessionId，无 characterId）
 * - [OpenPairing]：点"连接失效"通知前往重新配对
 */
sealed interface NotificationTarget {
    /** 打开指定会话（聊天页自行按 sessionId 加载，characterId 未知传空） */
    data class OpenSession(val sessionId: String) : NotificationTarget

    /** 前往配对页 */
    data object OpenPairing : NotificationTarget
}

/** intent extras 键（PendingIntent 构造方 [AppNotificationHelper] / [GenerationNotificationHelper] 共用同一来源） */
object NotificationExtras {
    const val OPEN_SESSION_ID = "openSessionId"
    const val FROM_NOTIFICATION = "fromNotification"
    const val OPEN_PAIRING = "openPairing"
}

/**
 * 纯解析（单测目标）：extras 三元组 → 通知目标；两者皆缺时返回 null（普通启动，无 deep link）。
 * openPairing 优先：两类 PendingIntent 互斥写 extras，此处仅为确定性兜底。
 */
fun notificationTargetFromExtras(
    openSessionId: String?,
    openPairing: Boolean,
): NotificationTarget? = when {
    openPairing -> NotificationTarget.OpenPairing
    !openSessionId.isNullOrBlank() -> NotificationTarget.OpenSession(openSessionId.trim())
    else -> null
}

/** [notificationTargetFromExtras] 的 intent 适配层（依赖 android.os，不做单测，保持零逻辑） */
fun notificationTargetFromIntent(intent: Intent?): NotificationTarget? = intent?.let {
    notificationTargetFromExtras(
        openSessionId = it.getStringExtra(NotificationExtras.OPEN_SESSION_ID),
        openPairing = it.getBooleanExtra(NotificationExtras.OPEN_PAIRING, false),
    )
}

/**
 * 待消费通知目标 holder（进程级单例）：MainActivity onCreate/onNewIntent 写入，
 * CompanionNavHost 在启动决策完成后（A-03）或运行中消费；消费一次即 [clear]，避免重复跳转。
 * 用 StateFlow 而非 SharedFlow：冷启动时写入早于 Compose 订阅，需要让后到的订阅者拿到现值。
 */
object NotificationDeepLink {
    private val _target = MutableStateFlow<NotificationTarget?>(null)
    val target: StateFlow<NotificationTarget?> = _target.asStateFlow()

    /** 写入本次 intent 的通知目标；null 表示无 deep link（同时清掉残留，保证不串台） */
    fun post(target: NotificationTarget?) {
        _target.value = target
    }

    /** 消费完成即清空 */
    fun clear() {
        _target.value = null
    }
}
