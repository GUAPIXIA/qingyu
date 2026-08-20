package com.qingyu.companion.data

import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.qingyu.companion.network.WsClient
import com.qingyu.companion.ui.notification.GenerationNotificationHelper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * P1-4.2 生命周期感知与后台策略：
 * - 前台：保持 WS，正常流式接收；
 * - 短时后台（< GRACE_MS）：允许连接继续；
 * - 长时后台（≥ GRACE_MS）：若无生成中则主动断开，回到前台后恢复；
 * - 生成中：在通知中展示“生成中/已完成/失败”，可点击回到会话（不用永久前台服务）。
 */
class WsLifecycleManager(
    private val context: Context,
    private val wsClient: WsClient,
    private val connectionManager: com.qingyu.companion.network.ConnectionManager,
    private val generationTracker: GenerationTracker,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
) : DefaultLifecycleObserver {

    companion object {
        /** 短时后台允许继续时长：60s */
        const val GRACE_MS = 60_000L
        private const val NOTIF_ID_GENERATING = 1001
    }

    private var pendingDisconnect: Job? = null
    private var wasConnectedBeforeBackground = false

    fun attach() {
        ProcessLifecycleOwner.get().lifecycle.addObserver(this)
        observeGeneration()
    }

    fun detach() {
        ProcessLifecycleOwner.get().lifecycle.removeObserver(this)
        pendingDisconnect?.cancel()
    }

    private fun observeGeneration() {
        scope.launch {
            generationTracker.state.collect { info ->
                if (info?.isGenerating == true) {
                    // 开始生成：立即展示通知，取消待断开
                    pendingDisconnect?.cancel()
                    GenerationNotificationHelper.showGenerating(context, info.sessionId, info.characterName)
                } else {
                    // 生成结束：更新通知为完成态，2s 后自动取消；不再强制保持连接
                    val cur = info
                    if (cur == null) {
                        // 无法区分完成/失败，统一展示完成并延迟取消
                        GenerationNotificationHelper.showCompleted(context, null, "生成完成")
                        scope.launch {
                            delay(2000)
                            GenerationNotificationHelper.cancel(context, NOTIF_ID_GENERATING)
                        }
                    }
                }
            }
        }
        // 错误/完成由 ChatViewModel report 时也可调用 showError，需额外监听 error 通道时再扩展
    }

    override fun onStop(owner: LifecycleOwner) {
        // 进入后台：记录是否曾连接，延迟后若无生成则断开
        wasConnectedBeforeBackground = wsClient.state.value == WsClient.State.CONNECTED
        pendingDisconnect?.cancel()
        pendingDisconnect = scope.launch {
            delay(GRACE_MS)
            if (generationTracker.isGenerating) {
                // 仍在生成中：继续保持连接，并确保通知可见
                return@launch
            }
            // 长时后台且空闲：主动断开，释放资源
            if (wsClient.state.value == WsClient.State.CONNECTED) {
                wsClient.disconnect()
            }
            GenerationNotificationHelper.cancel(context, NOTIF_ID_GENERATING)
        }
    }

    override fun onStart(owner: LifecycleOwner) {
        pendingDisconnect?.cancel()
        pendingDisconnect = null
        // 回到前台：若之前是长时后台断开的，自动重连
        if (wasConnectedBeforeBackground && wsClient.state.value == WsClient.State.DISCONNECTED) {
            scope.launch {
                // connectionManager 有自动重连逻辑，这里仅触发一次 restore 尝试
                // 若已有活跃连接，connectionManager 内部会去重
                runCatching { connectionManager.restore() }
            }
        }
        // 若仍在生成中，确保通知仍在
        generationTracker.state.value?.let { info ->
            if (info.isGenerating) {
                GenerationNotificationHelper.showGenerating(context, info.sessionId, info.characterName)
            }
        }
    }
}
