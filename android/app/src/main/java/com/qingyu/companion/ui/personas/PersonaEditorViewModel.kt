package com.qingyu.companion.ui.personas

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.chatcore.Ulid
import com.qingyu.companion.content.MediaImportGate
import com.qingyu.companion.local.db.LocalPersonaEntity
import com.qingyu.companion.local.domain.BindingImpact
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.data.ContentDraftStore
import com.qingyu.companion.ui.content.ContentDraftAutosaver
import com.qingyu.companion.ui.content.ContentDraftCodec
import com.qingyu.companion.ui.content.EditorDraft
import com.qingyu.companion.ui.content.PickedDocument
import java.io.File
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 阶段 5 S5-04：人设管理。
 *
 * 「默认人设」是**互斥单值**，所以设为默认必须是一次显式业务写而不是本地布尔翻转：
 * 直接把新一行的 `isDefault` 置 true、旧行留在 true 上，会出现两个默认人设，
 * PC 侧读到的就是自相矛盾的数据。这里在写入前清掉其它行的默认位。
 */
class PersonaEditorViewModel(
    private val store: LocalStore,
    private val mediaRoot: File,
    drafts: ContentDraftStore,
) : ViewModel() {

    /** 草稿区（§2）：写到一半的人设正文只进这里，不落库也不记账。 */
    private val draftArea = ContentDraftAutosaver(
        store = drafts,
        kind = DRAFT_KIND,
        encode = ContentDraftCodec::encodePersona,
        decode = ContentDraftCodec::decodePersona,
        // 草稿被容量判定拒绝时必须说出来：静默不写会让用户以为退出还能接着写
        onSkipped = { note -> _editor.update { it.copy(error = note) } }
    )

    data class ListState(
        val personas: List<LocalPersonaEntity> = emptyList(),
        val loading: Boolean = false,
        val error: String? = null,
    )

    data class EditorState(
        /** 打开的是草稿区里未保存的内容：界面要说明来源。 */
        val draftRestored: Boolean = false,
        val personaId: String? = null,
        val draft: EditorDraft<LocalPersonaEntity>? = null,
        val impact: BindingImpact? = null,
        val error: String? = null,
        val busy: Boolean = false,
        /** 草稿修订号：见 [edit] 的说明，用于让原地可变草稿能被 StateFlow 观察到 */
        val revision: Int = 0,
    )

    private val media = MediaImportGate(mediaRoot)

    private val _list = MutableStateFlow(ListState())
    val list: StateFlow<ListState> = _list.asStateFlow()

    private val _editor = MutableStateFlow(EditorState())
    val editor: StateFlow<EditorState> = _editor.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _list.update { it.copy(loading = true, error = null) }
            runCatching { store.listPersonas() }
                .onSuccess { rows -> _list.update { it.copy(personas = rows, loading = false) } }
                .onFailure { error -> _list.update { it.copy(loading = false, error = error.message) } }
        }
    }

    fun startCreate() {
        val now = System.currentTimeMillis()
        // 第一个人设成为默认：与 PC 一致，安装后不该出现「没有任何默认人设」的状态
        val first = _list.value.personas.isEmpty()
        _editor.update {
            EditorState(
                draft = EditorDraft(
                    LocalPersonaEntity(
                        id = Ulid.newId(),
                        name = "",
                        isDefault = first,
                        createdAt = now,
                        updatedAt = now,
                    ),
                ),
            )
        }
        // 还没落库的新行共用一把键：按随机 id 存的话，进程被杀那半篇永远找不回
        viewModelScope.launch {
            val restored = draftArea.restore(NEW_DRAFT_KEY) ?: return@launch
            // IO 回来时用户可能已经在写了：别拿旧草稿盖掉正在写的内容
            if (_editor.value.draft?.dirty == true) return@launch
            _editor.update { it.copy(draft = EditorDraft(restored), draftRestored = true) }
        }
    }

    fun startEdit(id: String) {
        viewModelScope.launch {
            val row = store.getPersona(id) ?: return@launch
            val draft = draftArea.restore(id)?.takeIf { it != row }
            _editor.update {
                EditorState(personaId = id, draft = EditorDraft(draft ?: row), draftRestored = draft != null)
            }
        }
    }

    /**
     * 草稿变更。
     *
     * [EditorDraft] 是原地改的可变对象，`StateFlow` 按引用相等去重，
     * 所以不推进 [EditorState.revision] 的话这里**不会触发重组**——
     * 表现就是「输入框打字没反应」。
     */
    fun edit(transform: (LocalPersonaEntity) -> LocalPersonaEntity) {
        var edited: LocalPersonaEntity? = null
        _editor.update { state ->
            state.draft?.edit(transform)
            edited = state.draft?.draft
            state.copy(revision = state.revision + 1)
        }
        // 键入只进草稿区（§2）
        edited?.let { draftArea.schedule(viewModelScope, draftKey(it), it) }
    }

    private fun draftKey(row: LocalPersonaEntity): String =
        if (_editor.value.personaId == null) NEW_DRAFT_KEY else row.id

    fun clearEditor() {
        // 只关页面：草稿留在草稿区，进程被杀也接得回来
        _editor.update { EditorState() }
    }

    /** 离开确认里选「不保存」时才真的清草稿。 */
    fun discardDraftAndClose() {
        val key = _editor.value.personaId ?: NEW_DRAFT_KEY
        clearEditor()
        viewModelScope.launch {
            draftArea.settle()
            draftArea.discard(key)
        }
    }

    /**
     * 保存。默认位是互斥单值，因此要么清掉别人的默认位，要么在被取消时补一个兜底默认。
     *
     * 每一条取消/补位都**单独走 putPersona**，因此各有一条 journal：
     * 若只写「新默认 = true」而不写「旧默认 = false」，对端会看到两个默认人设。
     */
    fun save() {
        val draft = _editor.value.draft ?: return
        // 必须在 commit 之前读：commit 会把 original 同步成 draft，之后再比就永远相等
        val wasDefault = draft.original.isDefault
        val nowDefault = draft.draft.isDefault
        // 新建的人设强制落一次：从草稿区恢复出来的新行 dirty 恒为假
        val isNewRow = _editor.value.personaId == null
        viewModelScope.launch {
            _editor.update { it.copy(busy = true, error = null) }
            val result = runCatching {
                val changed = draft.commit(force = isNewRow) { row ->
                    store.putPersona(row.copy(updatedAt = System.currentTimeMillis()))
                }
                if (nowDefault) {
                    store.listPersonas()
                        .filter { it.id != draft.draft.id && it.isDefault }
                        .forEach { stale -> store.putPersona(stale.copy(isDefault = false, updatedAt = System.currentTimeMillis())) }
                } else if (wasDefault && !nowDefault) {
                    // 用户主动取消默认：补一个兜底，避免留下「无默认人设」的状态
                    store.listPersonas().firstOrNull { it.id != draft.draft.id }?.let { fallback ->
                        store.putPersona(fallback.copy(isDefault = true, updatedAt = System.currentTimeMillis()))
                    }
                } else if (!changed) {
                    // 无变化时直接退出，不产生空变更
                    return@runCatching
                }
            }
            result.fold(
                onSuccess = {
                    // 落成了业务变更，草稿必须跟着清：留着会把「已保存的内容」当草稿再恢复一次
                    draftArea.settle()
                    draftArea.discard(draftKey(draft.draft))
                    _editor.update { EditorState() }
                    refresh()
                },
                onFailure = { error -> _editor.update { it.copy(busy = false, error = error.message ?: "保存失败") } },
            )
        }
    }

    /**
     * 列表上直接设默认。
     *
     * 不走草稿：默认位是互斥单值，勾了就该立刻生效。
     * 新默认与旧取消各自是一条 journal——只写「新默认 = true」会让对端同时看到两个默认。
     */
    fun makeDefault(id: String) {
        viewModelScope.launch {
            val target = store.getPersona(id) ?: return@launch
            runCatching {
                if (!target.isDefault) {
                    store.putPersona(target.copy(isDefault = true, updatedAt = System.currentTimeMillis()))
                }
                store.listPersonas()
                    .filter { it.id != id && it.isDefault }
                    .forEach { stale -> store.putPersona(stale.copy(isDefault = false, updatedAt = System.currentTimeMillis())) }
            }.onSuccess { refresh() }
                .onFailure { error -> _list.update { it.copy(error = error.message ?: "设置默认失败") } }
        }
    }

    fun inspectDelete(id: String) {
        viewModelScope.launch {
            val impact = runCatching { store.personaBindingImpact(id) }.getOrNull() ?: return@launch
            _editor.update { it.copy(impact = impact, personaId = id) }
        }
    }

    /** 删除并安全解绑引用（会话与角色上的默认人设位）。 */
    fun confirmDelete(id: String) {
        viewModelScope.launch {
            val wasDefault = store.getPersona(id)?.isDefault == true
            runCatching { store.deletePersonaUnbindingReferences(id) }
                .onSuccess {
                    // 删掉的是默认人设时补一个新的默认，理由同 save()：不能留下无默认状态
                    if (wasDefault) {
                        store.listPersonas().firstOrNull()?.let { candidate ->
                            store.putPersona(candidate.copy(isDefault = true, updatedAt = System.currentTimeMillis()))
                        }
                    }
                    _editor.update { EditorState() }
                    refresh()
                }
                .onFailure { error -> _list.update { it.copy(error = error.message ?: "删除失败") } }
        }
    }

    /** 头像落盘（先解码验证再写入私有目录）。返回错误信息，`null` 表示成功。 */
    fun attachAvatar(document: PickedDocument): String? {
        val draft = _editor.value.draft ?: return "未打开人设"
        val outcome = media.accept("persona-avatar", document.displayName, document.bytes)
        return when (outcome) {
            is MediaImportGate.Outcome.Accepted -> {
                draft.edit { it.copy(avatarPath = outcome.relPath) }
                null
            }
            is MediaImportGate.Outcome.Rejected -> outcome.reason
        }
    }

    fun avatarFile(relPath: String?): File? = relPath?.let { File(mediaRoot, it) }
}

/** 草稿区分区名与「还没落库的新行」共用的键。 */
private const val DRAFT_KIND = "persona"
private const val NEW_DRAFT_KEY = "new"
