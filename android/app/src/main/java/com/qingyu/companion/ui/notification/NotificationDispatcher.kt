package com.qingyu.companion.ui.notification

import android.content.Context
import com.qingyu.companion.data.GenerationTracker
import com.qingyu.companion.data.UiPrefsStore
import com.qingyu.companion.network.ConnectionManager

class NotificationDispatcher(
    private val context: Context,
    private val uiPrefsStore: UiPrefsStore,
    private val generationTracker: GenerationTracker,
    private val connectionManager: ConnectionManager,
) {
    fun start() { AppNotificationHelper.ensureChannels(context) }
    suspend fun notifyMemoryResult(sessionId: String?, success: Boolean) = Unit
    suspend fun notifyConnectionFailed(host: String? = null) = Unit
    suspend fun notifySecurity(detail: String? = null) = Unit
}
