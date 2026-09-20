package com.qingyu.companion.ui.settings.connection

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.network.models.ChatMessageDto
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ConnectionTestResult
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelClient
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.network.models.adapterFor
import com.qingyu.companion.security.ConnectionProfileRepository
import com.qingyu.companion.security.ConnectionProfileView
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * 阶段 3 S3-06：模型连接档案管理（新增、编辑、删除、排序、启用、选择、测试）。
 *
 * 秘密处理：
 * - UI 只持有 `apiKeyInput` 作为一次性输入，保存后立即清空；
 * - 列表项只显示 [ConnectionProfileView]（掩码 / 已配置）；
 * - public 与 secret 分两次事务保存，secret 保存失败保留旧值并把错误回显给用户。
 */
class ConnectionProfilesViewModel(
    private val repository: ConnectionProfileRepository,
    private val modelClient: ModelClient,
) : ViewModel() {

    data class EditorState(
        val id: String? = null,
        val displayName: String = "",
        val provider: ModelProvider = ModelProvider.OpenAI,
        val baseUrl: String = "",
        val model: String = "",
        val allowHttp: Boolean = false,
        val enabled: Boolean = true,
        val apiKeyInput: String = "",
        val replacingKey: Boolean = false,
        val error: String? = null,
        val saving: Boolean = false,
    ) {
        override fun toString(): String =
            "EditorState(id=$id, provider=$provider, baseUrl=$baseUrl, model=$model, apiKey=***)"
    }

    private val _profiles = MutableStateFlow<List<ConnectionProfileView>>(emptyList())
    val profiles: StateFlow<List<ConnectionProfileView>> = _profiles.asStateFlow()

    private val _editor = MutableStateFlow<EditorState?>(null)
    val editor: StateFlow<EditorState?> = _editor.asStateFlow()

    private val _testing = MutableStateFlow(false)
    val testing: StateFlow<Boolean> = _testing.asStateFlow()

    private val _testResult = MutableStateFlow<ConnectionTestResult?>(null)
    val testResult: StateFlow<ConnectionTestResult?> = _testResult.asStateFlow()

    init {
        viewModelScope.launch {
            repository.observeProfileViews().collect { _profiles.value = it }
        }
    }

    fun startCreate() {
        _testResult.value = null
        _editor.value = EditorState(
            provider = ModelProvider.OpenAI,
            baseUrl = DEFAULT_BASE_URLS[ModelProvider.OpenAI] ?: "",
            model = "",
        )
    }

    fun startEdit(view: ConnectionProfileView) {
        _testResult.value = null
        _editor.value = EditorState(
            id = view.id,
            displayName = view.displayName,
            provider = ModelProvider.fromWire(view.provider) ?: ModelProvider.OpenAI,
            baseUrl = view.baseUrl,
            model = view.model,
            allowHttp = view.allowHttp,
            enabled = view.enabled,
            apiKeyInput = "",
            replacingKey = false,
        )
    }

    fun closeEditor() {
        _editor.value = null
        _testResult.value = null
    }

    fun update(transform: (EditorState) -> EditorState) {
        _editor.value = _editor.value?.let(transform)
    }

    fun onProviderChanged(provider: ModelProvider) {
        update { current ->
            val currentDefault = DEFAULT_BASE_URLS[current.provider]
            val nextDefault = DEFAULT_BASE_URLS[provider] ?: ""
            current.copy(
                provider = provider,
                baseUrl = if (current.baseUrl.isBlank() || current.baseUrl == currentDefault) nextDefault else current.baseUrl,
            )
        }
    }

    /** 保存：public 与 secret 分离；secret 为空且未选择「替换密钥」时不触碰旧 secret。 */
    fun save() {
        val current = _editor.value ?: return
        val id = current.id ?: "profile-${UUID.randomUUID()}"
        if (current.baseUrl.isBlank()) {
            update { it.copy(error = "请填写 base URL") }
            return
        }
        update { it.copy(saving = true, error = null) }
        viewModelScope.launch {
            try {
                repository.savePublic(
                    id = id,
                    displayName = current.displayName.ifBlank { current.model.ifBlank { current.provider.wire } },
                    provider = current.provider.wire,
                    baseUrl = current.baseUrl.trim(),
                    model = current.model.trim(),
                    enabled = current.enabled,
                    sortIndex = profiles.value.firstOrNull { it.id == id }?.sortIndex
                        ?: profiles.value.size,
                    allowHttp = current.allowHttp,
                )
                if (current.replacingKey || current.id == null) {
                    if (current.apiKeyInput.isNotEmpty()) {
                        repository.saveSecret(id, current.apiKeyInput)
                    }
                }
                // 保存成功后立即清空明文输入
                _editor.value = null
                _testResult.value = null
            } catch (error: Throwable) {
                update {
                    it.copy(
                        saving = false,
                        error = "保存失败：${error.message ?: error::class.simpleName}（原密钥仍然有效）",
                    )
                }
            }
        }
    }

    fun delete(profileId: String) {
        viewModelScope.launch { repository.deleteProfile(profileId) }
    }

    fun toggleEnabled(view: ConnectionProfileView) {
        viewModelScope.launch {
            repository.savePublic(
                id = view.id,
                displayName = view.displayName,
                provider = view.provider,
                baseUrl = view.baseUrl,
                model = view.model,
                enabled = !view.enabled,
                sortIndex = view.sortIndex,
                allowHttp = view.allowHttp,
            )
        }
    }

    fun move(profileId: String, delta: Int) {
        val current = profiles.value.map { it.id }.toMutableList()
        val index = current.indexOf(profileId)
        if (index < 0) return
        val target = index + delta
        if (target < 0 || target >= current.size) return
        current[index] = current[target].also { current[target] = current[index] }
        viewModelScope.launch { repository.reorder(current) }
    }

    /** 连接测试：与真实生成走同一个 adapter、同一认证头构造。 */
    fun testSavedProfile(view: ConnectionProfileView) {
        _testing.value = true
        _testResult.value = null
        viewModelScope.launch {
            val apiKey = repository.readSecret(view.id)
            val adapter = adapterFor(ModelProvider.fromWire(view.provider) ?: ModelProvider.OpenAI, view.allowHttp)
            val profile = ConnectionProfilePublic(
                id = view.id,
                provider = ModelProvider.fromWire(view.provider) ?: ModelProvider.OpenAI,
                baseUrl = view.baseUrl,
                model = view.model,
                allowHttp = view.allowHttp,
            )
            _testResult.value = modelClient.testConnection(
                adapter = adapter,
                profile = profile,
                request = ModelChatRequest(
                    model = view.model,
                    messages = listOf(ChatMessageDto("user", TEST_PROMPT)),
                    stream = false,
                    maxTokens = 16,
                ),
                apiKey = apiKey,
            )
            _testing.value = false
        }
    }

    fun clearTestResult() {
        _testResult.value = null
    }

    companion object {
        const val TEST_PROMPT = "ping"

        val DEFAULT_BASE_URLS: Map<ModelProvider, String> = mapOf(
            ModelProvider.OpenAI to "https://api.openai.com/v1",
            ModelProvider.Anthropic to "https://api.anthropic.com",
            ModelProvider.Gemini to "https://generativelanguage.googleapis.com",
            ModelProvider.Ollama to "http://192.168.1.10:11434",
        )
    }
}
