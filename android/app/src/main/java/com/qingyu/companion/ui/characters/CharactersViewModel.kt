package com.qingyu.companion.ui.characters

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.R
import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.data.toCompanionError
import com.qingyu.companion.model.Character
import com.qingyu.companion.ui.components.LoadState
import com.qingyu.companion.ui.components.projectLoadState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 角色浏览 ViewModel：只读浏览 + 切换当前角色（方案 §3.1）。
 * 「切换当前角色」走 `POST /api/v1/characters/{id}/activate`（协议假设，
 * PC 桥接层落地前先留入口，失败降级为提示）。
 *
 * E-02：页面渲染统一消费 [loadState]（LoadState 投影，纯函数 [projectCharactersLoadState]）；
 * [UiState.actionError] 为动作级错误（切换/新建失败），不参与页面 LoadState 投影。
 * 角色列表无本地缓存（repository 无角色缓存回退），失败且无数据 → Error。
 */
class CharactersViewModel(
    private val repository: ChatRepository,
) : ViewModel() {

    data class UiState(
        val characters: List<Character> = emptyList(),
        /** 初始即 true：投影起点为 LoadState.Loading，避免首帧误判 Empty（E-02） */
        val loading: Boolean = true,
        /** 页面级加载错误：参与 [loadState] 投影（E-02）；刷新开始时清空 */
        val pageError: CompanionError? = null,
        /** 正在切换的角色 id（按钮 loading 反馈） */
        val activatingId: String? = null,
        /** 正在为角色创建会话的 id */
        val creatingId: String? = null,
        /** 动作级错误（切换/新建失败）：不参与页面 LoadState 投影，页面底部横幅展示 */
        val actionError: CompanionError? = null,
        /** 操作成功提示（资源 id + 可选参数，UI 层格式化） */
        val infoResId: Int? = null,
        val infoResArg: String? = null,
    )

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    /**
     * E-02 统一异步页面状态：loading/pageError/characters → LoadState 五态投影。
     * Screen 只需 `when (loadState)` 分发到 Qy 组件，不再手写状态 if/else。
     */
    val loadState: StateFlow<LoadState<List<Character>>> = _ui
        .map { state -> projectCharactersLoadState(state.loading, state.pageError, state.characters) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, LoadState.Loading)

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, pageError = null) }
            try {
                val characters = repository.listCharacters()
                _ui.update { it.copy(characters = characters, loading = false, pageError = null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update { it.copy(loading = false, pageError = e.toCompanionError()) }
            }
        }
    }

    /** 切换当前角色：PC 侧创建新会话并激活该角色（协议假设，失败仅提示） */
    fun activate(characterId: String, characterName: String) {
        if (_ui.value.activatingId != null) return
        viewModelScope.launch {
            _ui.update { it.copy(activatingId = characterId, actionError = null, infoResId = null, infoResArg = null) }
            try {
                repository.activateCharacter(characterId)
                _ui.update {
                    it.copy(
                        activatingId = null,
                        infoResId = R.string.characters_activate_success,
                        infoResArg = characterName,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update {
                    it.copy(
                        activatingId = null,
                        actionError = e.toActionError(ACTIVATE_FALLBACK_MESSAGE),
                    )
                }
            }
        }
    }

    /** 从角色详情直接创建会话，避免必须先切换角色再返回会话页。 */
    fun startChat(characterId: String, onCreated: (sessionId: String) -> Unit) {
        if (_ui.value.creatingId != null) return
        viewModelScope.launch {
            _ui.update { it.copy(creatingId = characterId, actionError = null, infoResId = null, infoResArg = null) }
            try {
                val session = repository.createSession(characterId)
                _ui.update { it.copy(creatingId = null) }
                onCreated(session.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update {
                    it.copy(
                        creatingId = null,
                        actionError = e.toActionError(START_CHAT_FALLBACK_MESSAGE),
                    )
                }
            }
        }
    }

    fun clearInfo() = _ui.update { it.copy(infoResId = null, infoResArg = null) }

    /**
     * 动作失败 → 动作级错误（E-02：不进页面 LoadState）。
     * CompanionError 直接携带（UI 走统一 userMessage()）；其他异常且无 message 时
     * 用领域语义兜底文案（与 data 层 CompanionError 默认文案同约定，非 UI 硬编码）。
     */
    private fun Exception.toActionError(fallbackMessage: String): CompanionError =
        (this as? CompanionError) ?: CompanionError.Unknown(message ?: fallbackMessage)

    companion object {
        /** PC 桥接层未实现 activate 端点时的降级提示 */
        private const val ACTIVATE_FALLBACK_MESSAGE = "切换失败（PC 桥接层可能未实现该端点）"

        /** 新建会话失败兜底提示 */
        private const val START_CHAT_FALLBACK_MESSAGE = "新建对话失败"
    }
}

/**
 * 角色页 LoadState 投影（纯函数，JVM 单测覆盖）：非空角色列表即「有内容」。
 */
internal fun projectCharactersLoadState(
    loading: Boolean,
    error: CompanionError?,
    characters: List<Character>,
): LoadState<List<Character>> = projectLoadState(
    loading = loading,
    error = error,
    data = characters,
    hasContent = { it.isNotEmpty() },
)
