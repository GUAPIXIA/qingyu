package com.qingyu.companion.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * P1-4.2：全局生成状态跟踪（单聊 + 群聊）。
 * ViewModel 在 Streaming.Generating 时更新，提供给 WsLifecycleManager 与通知使用；
 * 不用永久前台服务，仅在有生成时展示可点击通知。
 */
data class GenerationInfo(
    val sessionId: String,
    val characterName: String = "",
    val isGenerating: Boolean = false,
)

class GenerationTracker {
    private val _state = MutableStateFlow<GenerationInfo?>(null)
    val state: StateFlow<GenerationInfo?> = _state.asStateFlow()

    val isGenerating: Boolean get() = _state.value?.isGenerating == true

    fun onStarted(sessionId: String, characterName: String = "") {
        _state.value = GenerationInfo(sessionId, characterName, true)
    }

    fun onStopped(sessionId: String? = null) {
        // 仅当停止的会话与当前记录一致时清空，避免多会话竞态误删
        val cur = _state.value ?: return
        if (sessionId == null || cur.sessionId == sessionId) {
            _state.value = null
        }
    }

    fun onCompleted(sessionId: String) {
        onStopped(sessionId)
    }
}
