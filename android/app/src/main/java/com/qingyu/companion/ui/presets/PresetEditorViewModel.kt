package com.qingyu.companion.ui.presets

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.chatcore.Ulid
import com.qingyu.companion.content.PresetCodec
import com.qingyu.companion.local.db.LocalPresetEntity
import com.qingyu.companion.local.domain.BindingImpact
import com.qingyu.companion.local.domain.JsonValues
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.data.ContentDraftStore
import com.qingyu.companion.ui.content.ContentDraftAutosaver
import com.qingyu.companion.ui.content.ContentDraftCodec
import com.qingyu.companion.ui.content.EditorDraft
import com.qingyu.companion.ui.content.PickedDocument
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 阶段 5 S5-03：预设编辑。
 *
 * 可编辑字段集合 = PC `Preset` 的字段集合，**不增不减**：预设正文整体就是
 * `preset` 实体的同步 payload（`EntityPayloads.presetPayload` = 正文去掉 id），
 * 所以在这里加一个 PC 没有的键（阶段 5 方案 §S5-03 文字里提到的 `stop` 就是这种），
 * 会让两端对同一预设算出不同 contentHash —— 见报告 §2.5 的 D 类问题。
 *
 * 每次保存前都过 `PresetCodec.normalize`：默认值、钳位区间、可选键的存在性
 * 都必须与 PC 一致，否则同上。
 */
class PresetEditorViewModel(
    private val store: LocalStore,
    drafts: ContentDraftStore,
) : ViewModel() {

    /** 草稿区（§2）：预设正文整体是一坨 bodyJson，写到一半丢了最难手工补回来。 */
    private val draftArea = ContentDraftAutosaver(
        store = drafts,
        kind = DRAFT_KIND,
        encode = ContentDraftCodec::encodePreset,
        decode = ContentDraftCodec::decodePreset,
        // 草稿被容量判定拒绝时必须说出来：静默不写会让用户以为退出还能接着写
        onSkipped = { note -> _editor.update { it.copy(error = note) } }
    )

    data class ListState(
        val builtin: List<LocalPresetEntity> = emptyList(),
        /** 「我的预设」的**当前页**（§2：关键字与分页都在数据库层）。 */
        val user: List<LocalPresetEntity> = emptyList(),
        val query: String = "",
        /** 与当前查询同口径的用户预设总数（页码用它，不是 user.size）。 */
        val userTotal: Int = 0,
        val loading: Boolean = false,
        val error: String? = null,
        val busy: Boolean = false,
        val importReport: ImportReport? = null,
    )

    /**
     * 导入报告。方案 §2 要求五类都可见：成功、跳过、近似映射、失败、未知字段保留。
     *
     * [skipped] 是「文件读得通，但不是这个入口该吃的东西」（角色卡、世界书、预设数组）。
     * 这些原先会被当成预设**强行导入**成一个空壳——预设正文里只有 id/name 是必填，
     * 角色卡顶层恰好也有 `name`，于是一份角色卡会变成一条空白预设，比失败难查得多。
     * [approximated] 是数值被钳位/取整/回落、文本被截断的清单（见 `PresetCodec.approximateNotes`）。
     *
     * 注意这只在 Android 侧收口：PC 的 `normalizeImportedPreset` 没有同类守卫，
     * 而 payload 归一化结果两端仍然逐字节一致（守卫只决定「导不导」，不改「导成什么」）。
     */
    data class ImportReport(
        val imported: Int,
        val skipped: List<String>,
        val failed: List<String>,
        val approximated: List<String>,
        val unsupported: Map<String, List<String>>,
    )

    data class EditorState(
        /** 打开的是草稿区里未保存的内容：界面要说明来源。 */
        val draftRestored: Boolean = false,
        val presetId: String? = null,
        val draft: EditorDraft<LocalPresetEntity>? = null,
        val impact: BindingImpact? = null,
        val error: String? = null,
        val busy: Boolean = false,
        val revision: Int = 0,
    )

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
            val needle = _list.value.query.trim()
            val result = runCatching {
                Triple(
                    store.listPresetSection(true),
                    store.searchPresets(false, needle, PAGE_SIZE, 0),
                    store.countPresets(false, needle),
                )
            }
            result.fold(
                onSuccess = { (builtin, user, total) ->
                    _list.update {
                        it.copy(builtin = builtin, user = user, userTotal = total, loading = false)
                    }
                },
                onFailure = { error -> _list.update { it.copy(loading = false, error = error.message) } },
            )
        }
    }

    /**
     * 追加「我的预设」的下一页。
     *
     * 内建分区不分页：它是安装包带来的固定小集合（且整份要参与只读展示）。
     * 偏移就是当前已显示条数；中途导入/删除/改名后要先 `refresh()` 回到第一页。
     */
    fun loadMoreUser() {
        val state = _list.value
        if (state.loading || state.user.size >= state.userTotal) return
        viewModelScope.launch {
            _list.update { it.copy(loading = true, error = null) }
            val needle = state.query.trim()
            runCatching { store.searchPresets(false, needle, PAGE_SIZE, state.user.size) }.fold(
                onSuccess = { more -> _list.update { it.copy(user = it.user + more, loading = false) } },
                onFailure = { error -> _list.update { it.copy(loading = false, error = error.message) } },
            )
        }
    }

    fun onQueryChange(query: String) {
        // 查询词一变就要重问数据库：内存里那一页与新词无关
        _list.update { it.copy(query = query) }
        refresh()
    }

    // ------------------------------------------------------------ 正文读写

    /** 把正文按规范键读成编辑用值；缺失键回落到 `normalizePreset` 的默认值，不当成错误。 */
    fun bodyOf(row: LocalPresetEntity): Map<String, Any?> = PresetCodec.bodyOf(row.bodyJson)

    fun edit(transform: (LocalPresetEntity) -> LocalPresetEntity) {
        var edited: LocalPresetEntity? = null
        _editor.update { state ->
            state.draft?.edit(transform)
            edited = state.draft?.draft
            state.copy(revision = state.revision + 1)
        }
        // 键入只进草稿区（§2）
        edited?.let { draftArea.schedule(viewModelScope, draftKey(it), it) }
    }

    private fun draftKey(row: LocalPresetEntity): String =
        if (_editor.value.presetId == null) NEW_DRAFT_KEY else row.id

    /**
     * 改一个正文字段。
     *
     * `body_json` 是单一真值来源，所以先改正文再重新 normalize，
     * 而不是同时维护「列 + 正文」两份值 —— 那会出现列说一套正文说一套。
     */
    fun editBody(key: String, value: Any?) {
        val current = _editor.value.draft?.draft ?: return
        val merged = LinkedHashMap(bodyOf(current)).apply {
            if (value == null) remove(key) else put(key, value)
        }
        edit { row -> row.withBody(merged, keepIdentity = true) }
    }

    fun editText(key: String, value: String) = editBody(key, value)

    fun editNumber(key: String, value: Double) = editBody(key, value)

    private fun LocalPresetEntity.withBody(body: Map<String, Any?>, keepIdentity: Boolean): LocalPresetEntity {
        val base = LinkedHashMap(body)
        if (keepIdentity) {
            base["id"] = id
            base["name"] = name
            base["description"] = description
            base["isBuiltin"] = isBuiltin
        }
        val normalized = PresetCodec.normalize(base)
        return copy(
            bodyJson = PresetCodec.bodyJsonOf(normalized),
            name = normalized["name"] as? String ?: name,
            description = normalized["description"] as? String ?: description,
        )
    }

    // ------------------------------------------------------------ CRUD

    fun startCreate() {
        val now = System.currentTimeMillis()
        val id = Ulid.newId()
        // 种子名不能为空：`PresetCodec.normalize` 对空名抛 `PresetFormatException`，
        // 而 `startCreate` 是「新建预设」按钮的**同步**调用——空名等于一点就崩（设备用例实测到）。
        val seed = PresetCodec.normalize(
            mapOf("id" to id, "name" to NEW_PRESET_NAME, "isBuiltin" to false),
        )
        _editor.update {
            EditorState(
                draft = EditorDraft(
                    LocalPresetEntity(
                        id = id,
                        name = NEW_PRESET_NAME,
                        bodyJson = PresetCodec.bodyJsonOf(seed),
                        isDefault = false,
                        createdAt = now,
                        updatedAt = now,
                        isBuiltin = false,
                        sortIndex = (_list.value.user.size + _list.value.builtin.size),
                    ),
                ),
            )
        }
        viewModelScope.launch {
            val restored = draftArea.restore(NEW_DRAFT_KEY) ?: return@launch
            // IO 回来时用户可能已经在写了：别拿旧草稿盖掉正在写的内容
            if (_editor.value.draft?.dirty == true) return@launch
            _editor.update { it.copy(draft = EditorDraft(restored), draftRestored = true) }
        }
    }

    /**
     * 复制内建预设成用户预设。
     *
     * 内建预设属于安装包：就地改会在下次升级被覆盖，用户的调整静默消失。
     */
    fun startDuplicate(id: String) {
        viewModelScope.launch {
            val source = store.getPreset(id) ?: return@launch
            val newId = Ulid.newId()
            val now = System.currentTimeMillis()
            val body = LinkedHashMap(bodyOf(source)).apply {
                put("id", newId)
                put("isBuiltin", false)
            }
            val normalized = PresetCodec.normalize(body)
            _editor.update {
                EditorState(
                    draft = EditorDraft(
                        LocalPresetEntity(
                            id = newId,
                            name = "${source.name} 副本",
                            bodyJson = PresetCodec.bodyJsonOf(normalized),
                            description = source.description,
                            createdAt = now,
                            updatedAt = now,
                            isBuiltin = false,
                            sortIndex = (_list.value.user.size),
                        ),
                    ),
                )
            }
        }
    }

    fun startEdit(id: String) {
        viewModelScope.launch {
            val row = store.getPreset(id) ?: return@launch
            val draft = draftArea.restore(id)?.takeIf { it != row }
            _editor.update {
                EditorState(presetId = id, draft = EditorDraft(draft ?: row), draftRestored = draft != null)
            }
        }
    }

    fun clearEditor() {
        // 只关页面：草稿留在草稿区
        _editor.update { EditorState() }
    }

    /** 离开确认里选「不保存」时才真的清草稿。 */
    fun discardDraftAndClose() {
        val key = _editor.value.presetId ?: NEW_DRAFT_KEY
        clearEditor()
        viewModelScope.launch {
            draftArea.settle()
            draftArea.discard(key)
        }
    }

    /** 内建预设只读：改它要落成副本，与 `updatePreset` 的既有语义一致。 */
    fun save() {
        val draft = _editor.value.draft ?: return
        viewModelScope.launch {
            _editor.update { it.copy(busy = true, error = null) }
            val result = runCatching {
                val row = draft.draft
                if (row.isBuiltin) {
                    val copyId = Ulid.newId()
                    val body = LinkedHashMap(bodyOf(row)).apply {
                        put("id", copyId)
                        put("isBuiltin", false)
                    }
                    val now = System.currentTimeMillis()
                    store.putPreset(
                        row.copy(
                            id = copyId,
                            bodyJson = PresetCodec.bodyJsonOf(PresetCodec.normalize(body)),
                            isBuiltin = false,
                            isDefault = false,
                            createdAt = now,
                            updatedAt = now,
                        ),
                    )
                    // 不产生空变更：commit 内部的 dirty 检查在这里不适用（行换了主键）
                } else {
                    // 新建行强制落一次：从草稿区恢复出来的新预设 dirty 为假
                    draft.commit(force = _editor.value.presetId == null) { target ->
                        store.putPreset(target.copy(updatedAt = System.currentTimeMillis()))
                    }
                }
            }
            result.onSuccess {
                // 已成一次业务变更 → 草稿必须跟着清，留着会把已保存内容再当草稿恢复一次
                draftArea.settle()
                draftArea.discard(draftKey(draft.draft))
                _editor.update { EditorState() }
                refresh()
            }.onFailure { error ->
                _editor.update { it.copy(busy = false, error = error.message ?: "保存失败") }
            }
        }
    }

    fun inspectDelete(id: String) {
        viewModelScope.launch {
            _editor.update { it.copy(impact = store.presetBindingImpact(id), presetId = id) }
        }
    }

    /** 删除并解绑引用（会话的 `preset_id`、角色的 `default_preset_id`）。 */
    fun confirmDelete(id: String) {
        viewModelScope.launch {
            runCatching { store.deletePresetUnbindingReferences(id) }
                .onSuccess {
                    _editor.update { EditorState() }
                    refresh()
                }
                .onFailure { error -> _list.update { it.copy(error = error.message ?: "删除失败") } }
        }
    }

    fun toggleEnabled(id: String, enabled: Boolean) {
        viewModelScope.launch {
            val row = store.getPreset(id) ?: return@launch
            if (row.enabled == enabled) return@launch
            runCatching { store.putPreset(row.copy(enabled = enabled, updatedAt = System.currentTimeMillis())) }
                .onSuccess { refresh() }
                .onFailure { error -> _list.update { it.copy(error = error.message ?: "更新失败") } }
        }
    }

    /** 设为当前预设（写进同步公开设置，与 PC 的 `activePresetId` 同位）。 */
    fun makeDefault(id: String) {
        viewModelScope.launch {
            val target = store.getPreset(id) ?: return@launch
            runCatching {
                if (!target.isDefault) {
                    store.putPreset(target.copy(isDefault = true, updatedAt = System.currentTimeMillis()))
                }
                store.listPresets()
                    .filter { it.id != id && it.isDefault }
                    .forEach { stale -> store.putPreset(stale.copy(isDefault = false, updatedAt = System.currentTimeMillis())) }
                store.putPublicSetting(SECTION, KEY_ACTIVE_PRESET, "\"$id\"")
            }.onSuccess { refresh() }
                .onFailure { error -> _list.update { it.copy(error = error.message ?: "设为默认失败") } }
        }
    }

    fun move(id: String, up: Boolean) {
        viewModelScope.launch {
            val ordered = _list.value.user.sortedBy { it.sortIndex }.toMutableList()
            val index = ordered.indexOfFirst { it.id == id }
            if (index < 0) return@launch
            val target = if (up) index - 1 else index + 1
            if (target < 0 || target >= ordered.size) return@launch
            val tmp = ordered[index]
            ordered[index] = ordered[target]
            ordered[target] = tmp
            runCatching {
                ordered.forEachIndexed { position, row ->
                    if (row.sortIndex != position) {
                        store.putPreset(row.copy(sortIndex = position, updatedAt = System.currentTimeMillis()))
                    }
                }
            }.onSuccess { refresh() }
                .onFailure { error -> _list.update { it.copy(error = error.message ?: "排序失败") } }
        }
    }

    // ------------------------------------------------------------ 导入导出

    /**
     * 导入预设 JSON。
     *
     * `unsupportedFields` 必须显示出来：外部预设里 Android 用不到的键（酒馆的
     * promptManager 结构等）若被静默丢弃，用户会以为「导入了但没生效」。
     */
    fun importPresets(documents: List<PickedDocument>) {
        if (documents.isEmpty()) return
        viewModelScope.launch {
            _list.update { it.copy(busy = true, importReport = null, error = null) }
            var imported = 0
            val skipped = ArrayList<String>()
            val failed = ArrayList<String>()
            val approximated = ArrayList<String>()
            val unsupported = LinkedHashMap<String, List<String>>()
            val now = System.currentTimeMillis()

            for (document in documents) {
                val text = document.bytes.toString(Charsets.UTF_8)
                if (text.trimStart().startsWith("[")) {
                    skipped += "${document.displayName}：是数组（多个预设打包），本入口一次只吃单个预设 JSON"
                    continue
                }
                val body = JsonValues.parseObject(text)
                if (body.isEmpty()) {
                    failed += document.displayName
                    continue
                }
                val foreign = PresetCodec.foreignShapeNote(body)
                if (foreign != null) {
                    skipped += "${document.displayName}：$foreign"
                    continue
                }
                val id = Ulid.newId()
                val result = runCatching {
                    PresetCodec.normalizeImported(body, id, document.displayName.substringBeforeLast('.'))
                }.getOrNull()
                if (result == null) {
                    failed += document.displayName
                    continue
                }
                val written = runCatching {
                    store.putPreset(
                        LocalPresetEntity(
                            id = id,
                            name = result.body["name"] as? String ?: document.displayName,
                            bodyJson = PresetCodec.bodyJsonOf(result.body),
                            description = result.body["description"] as? String ?: "",
                            createdAt = now,
                            updatedAt = now,
                            isBuiltin = false,
                            sortIndex = imported + _list.value.user.size,
                        ),
                    )
                }.isSuccess
                if (!written) {
                    failed += document.displayName
                    continue
                }
                imported += 1
                result.approximated.forEach { note -> approximated += "${document.displayName}：$note" }
                if (result.unsupportedFields.isNotEmpty()) {
                    unsupported[result.body["name"] as? String ?: document.displayName] = result.unsupportedFields
                }
            }

            _list.update {
                it.copy(
                    busy = false,
                    importReport = ImportReport(imported, skipped, failed, approximated, unsupported),
                )
            }
            refresh()
        }
    }

    /** 导出正文（与 PC `preset:exportJson` 同形状：整个预设对象含 id）。 */
    suspend fun exportPreset(id: String): Pair<ByteArray, String>? {
        val row = store.getPreset(id) ?: return null
        val body = LinkedHashMap(bodyOf(row)).apply {
            put("id", row.id)
            put("name", row.name)
        }
        return JsonValues.stringify(body).toByteArray(Charsets.UTF_8) to "${row.name.ifBlank { "preset" }}.json"
    }

    companion object {
        const val SECTION = "chat"
        const val KEY_ACTIVE_PRESET = "activePresetId"

        val RESPONSE_LENGTH_HINTS = listOf("auto", "brief", "balanced", "detailed")
        val EXAMPLE_DIALOG_MODES = listOf("always", "first_turn", "off")

        fun string(body: Map<String, Any?>, key: String): String = body[key] as? String ?: ""

        fun number(body: Map<String, Any?>, key: String, fallback: Double): Double =
            (body[key] as? Number)?.toDouble() ?: fallback

        fun boolean(body: Map<String, Any?>, key: String): Boolean? = body[key] as? Boolean
    }
}

/** 草稿区分区名与「还没落库的新行」共用的键。 */
/** 「新建预设」的种子名：`PresetCodec.normalize` 要求名称非空，空名会在按钮点击时直接抛。 */
/** 列表页长（§2 分页）：1k 预设一次只问数据库要这么多条。 */
private const val PAGE_SIZE = 50

private const val NEW_PRESET_NAME = "未命名预设"

private const val DRAFT_KIND = "preset"
private const val NEW_DRAFT_KEY = "new"
