package com.qingyu.companion.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.data.userMessage
import com.qingyu.companion.model.VersionInfo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 设置页 ViewModel（S9-07 本地化）。
 * - 缓存清除 / 全量抹除 / 版本检查；
 * - 旧 PC 权威设置同步（/api/v1 settings snapshot）已删除，本机设置走 LocalSettingsRepository / UiPrefsStore。
 */
class SettingsViewModel(
    private val repository: ChatRepository,
) : ViewModel() {

    data class UiState(
        val clearingCache: Boolean = false,
        val wiping: Boolean = false,
        val message: String? = null,
        val isError: Boolean = false,
        val latestVersion: VersionInfo? = null,
        val checkingVersion: Boolean = false,
    )

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    /** 仅清本地缓存（保留用户数据） */
    fun clearCache() {
        if (_ui.value.clearingCache) return
        viewModelScope.launch {
            _ui.update { it.copy(clearingCache = true, message = null) }
            try {
                repository.clearLocalCache()
                _ui.update {
                    it.copy(clearingCache = false, message = "本地缓存已清除", isError = false)
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

    /** 退出时清除：清缓存 + 移除全部本地数据（二次确认在 UI 层） */
    fun wipeAll() {
        if (_ui.value.wiping) return
        viewModelScope.launch {
            _ui.update { it.copy(wiping = true, message = null) }
            try {
                repository.wipeLocalData()
                _ui.update {
                    it.copy(wiping = false, message = "已清除全部本地数据", isError = false)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update { it.copy(wiping = false, message = e.message ?: "清除失败", isError = true) }
            }
        }
    }

    fun clearMessage() = _ui.update { it.copy(message = null) }

    /** 检查更新（本地仓库可能返回 null 表示不支持） */
    fun checkVersion() {
        if (_ui.value.checkingVersion) return
        viewModelScope.launch {
            _ui.update { it.copy(checkingVersion = true, message = null) }
            try {
                val info = repository.fetchVersionInfo()
                _ui.update { it.copy(checkingVersion = false, latestVersion = info) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val msg = if (e is CompanionError) e.userMessage() else e.message ?: "检查更新失败"
                _ui.update { it.copy(checkingVersion = false, message = msg, isError = true) }
            }
        }
    }

    fun clearLatestVersion() = _ui.update { it.copy(latestVersion = null) }
}
