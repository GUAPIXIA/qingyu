package com.qingyu.companion.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.network.ConnectionManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 设置页 ViewModel（方案 §6.9 会话数据最小化 / §5.2 远程访问指引）。
 * - 「退出时清除」：清 Room 缓存 + DataStore 连接配置 + 断开 WS（wipeLocalData）；
 * - 「清除缓存」：仅清 Room，保留连接配置；
 * - 连接管理入口与内网穿透指引为纯 UI（见 SettingsScreen）。
 */
class SettingsViewModel(
    private val repository: ChatRepository,
    private val connectionManager: ConnectionManager,
) : ViewModel() {

    data class UiState(
        val clearingCache: Boolean = false,
        val wiping: Boolean = false,
        /** 操作结果提示（info/error 复用，设置页单行提示） */
        val message: String? = null,
        val isError: Boolean = false,
        /** 已配对连接数（关于区展示） */
        val connectionCount: Int = 0,
        /** 当前活跃连接（连接详情区展示） */
        val activeConnection: ServerConnection? = null,
    )

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    init {
        refreshConnections()
        viewModelScope.launch {
            connectionManager.activeFlow.collect { active ->
                _ui.update { it.copy(activeConnection = active) }
            }
        }
    }

    fun refreshConnections() {
        viewModelScope.launch {
            val count = connectionManager.listConnections().size
            _ui.update { it.copy(connectionCount = count) }
        }
    }

    /** 仅清本地缓存（保留连接配置） */
    fun clearCache() {
        if (_ui.value.clearingCache) return
        viewModelScope.launch {
            _ui.update { it.copy(clearingCache = true, message = null) }
            try {
                repository.clearLocalCache()
                _ui.update {
                    it.copy(clearingCache = false, message = "本地缓存已清除（连接配置保留）", isError = false)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update {
                    it.copy(clearingCache = false, message = e.message ?: "清除缓存失败", isError = true)
                }
            }
        }
    }

    /** 退出时清除：清缓存 + 移除全部连接（二次确认在 UI 层） */
    fun wipeAll() {
        if (_ui.value.wiping) return
        viewModelScope.launch {
            _ui.update { it.copy(wiping = true, message = null) }
            try {
                repository.wipeLocalData()
                _ui.update {
                    it.copy(
                        wiping = false,
                        message = "已清除全部本地数据，下次启动需重新配对",
                        isError = false,
                        connectionCount = 0,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update {
                    it.copy(wiping = false, message = e.message ?: "清除失败", isError = true)
                }
            }
        }
    }

    fun clearMessage() = _ui.update { it.copy(message = null) }
}
