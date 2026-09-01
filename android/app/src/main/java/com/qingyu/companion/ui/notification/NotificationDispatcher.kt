package com.qingyu.companion.ui.notification

import android.content.Context
import com.qingyu.companion.data.GenerationTracker
import com.qingyu.companion.data.UiPrefsStore
import com.qingyu.companion.network.ConnectionManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class NotificationDispatcher(
    private val context: Context,
    private val uiPrefsStore: UiPrefsStore,
    private val generationTracker: GenerationTracker,
    private val connectionManager: ConnectionManager,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    fun start() {
        AppNotificationHelper.ensureChannels(context)
        // A-06：把 App 内「任务通知」开关同步到内存门控，
        // 使渠道实际投递行为与设置页开关一致（关闭即不再弹任何通知）
        scope.launch {
            uiPrefsStore.notificationsEnabled.collect { enabled ->
                NotificationGate.appEnabled = enabled
            }
        }
    }
    suspend fun notifyMemoryResult(sessionId: String?, success: Boolean) = Unit
    suspend fun notifyConnectionFailed(host: String? = null) = Unit
    suspend fun notifySecurity(detail: String? = null) = Unit
}
