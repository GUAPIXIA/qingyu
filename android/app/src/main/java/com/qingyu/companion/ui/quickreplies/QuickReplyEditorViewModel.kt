package com.qingyu.companion.ui.quickreplies

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.chatcore.Ulid
import com.qingyu.companion.content.QuickReplyCodec
import com.qingyu.companion.content.QuickReplyItemExtras
import com.qingyu.companion.data.ContentDraftStore
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalPresetEntity
import com.qingyu.companion.local.db.LocalQuickReplySetEntity
import com.qingyu.companion.local.domain.EntityPayloads
import com.qingyu.companion.local.domain.JsonValues
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.model.QuickReply
import com.qingyu.companion.model.QuickReplyAction
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
 * 阶段 5 S5-06：快捷回复集合编辑。
 *
 * 三件容易被做错的事：
 *
 * 1. **条目数组就是同步 payload**。`EntityPayloads.quickReplyStorePayload` 把整库
 *    （`{global, byCharacter}`）记成 `quick-replies-root` 单实体，进同步的只有条目 JSON；
 *    集合的 `name` / `enabled` 是本机视图列。因此编辑条目必须整体经过 [QuickReplyCodec]，
 *    否则 PC 的 `hotkey` 等字段会在第一次编辑时静默消失。
 * 2. **一次保存 = 一次业务写**。条目增删改序全部只动 [EditorDraft]，只有 [saveSet]
 *    调一次 `putQuickReplySet`（方案 §2：每次落库都是一条 journal）。
 * 3. **删除的 tombstone 归仓储**。`RoomLocalSyncRepository.deleteQuickReplySet` 会在该角色
 *    不再有集合时补 `qr-char-<id>`；这里只负责把影响范围如实显示出来，不复制那段判定。
 * 4. **键入只进草稿区**（方案 §2）。条目增删改序都只动 [EditorDraft] 并写 [draftArea]，
 *    集合级删除标记 / 整库 payload 一律不碰。
 */
class QuickReplyEditorViewModel(
    private val store: LocalStore,
    drafts: ContentDraftStore,
) : ViewModel() {

    /**
     * 草稿区快照是**行**（含 `itemsJson`），不是 [SetDraft]。
     *
     * 后者带 `items` / `extras` 两份派生值，直接序列化会出现「行与派生值不一致」的草稿；
     * 存 `encodeRow` 的结果则与落库口径完全相同，恢复时再 decode 一次即可。
     */
    private val draftArea = ContentDraftAutosaver(
        store = drafts,
        kind = DRAFT_KIND,
        encode = ContentDraftCodec::encodeQuickReplySet,
        decode = ContentDraftCodec::decodeQuickReplySet,
        // 草稿被容量判定拒绝时必须说出来：静默不写会让用户以为退出还能接着写
        onSkipped = { note -> _set.update { it.copy(error = note) } }
    )

    data class ListState(
        val sets: List<LocalQuickReplySetEntity> = emptyList(),
        val characters: List<LocalCharacterEntity> = emptyList(),
        val presets: List<LocalPresetEntity> = emptyList(),
        val loading: Boolean = false,
        val busy: Boolean = false,
        val error: String? = null,
        val importReport: ImportReport? = null,
    )

    /** 导入报告：方案 §2 要求「成功、跳过、近似映射、失败、未知字段保留」五类都可见。 */
    data class ImportReport(
        val imported: Int,
        val setsWritten: Int,
        val skipped: List<String>,
        val failed: List<String>,
        val approximated: List<String>,
        val preserved: List<String>,
    )

    /**
     * 集合草稿。
     *
     * [extras] 按条目 id 保存 Android 不认识的键（PC 的 `hotkey` 等）：
     * [QuickReply] 里没有这些字段，只靠 DTO 承载就会在编辑后丢掉。
     */
    data class SetDraft(
        val row: LocalQuickReplySetEntity,
        val items: List<QuickReply>,
        val extras: Map<String, Map<String, Any?>>,
    )

    /** 删除集合前的影响范围：条目数 + 是否为该角色最后一个集合（后者会补角色级 tombstone）。 */
    data class SetDeletePreview(
        val setId: String,
        val setName: String,
        val itemCount: Int,
        val characterId: String?,
        val lastSetForCharacter: Boolean,
    )

    data class ClearCharacterPreview(
        val characterId: String,
        val characterName: String,
        val setCount: Int,
        val itemCount: Int,
    )

    data class SetState(
        val setId: String? = null,
        /** 新建行必须强制落库：`EditorDraft.commit` 在无变化时不落盘，而新集合本来就没落过盘 */
        val isNew: Boolean = false,
        /** 打开的是草稿区里未保存的内容：界面要说明来源（§2） */
        val draftRestored: Boolean = false,
        val draft: EditorDraft<SetDraft>? = null,
        /** 草稿修订号：见 [mutate]。原地可变的草稿不推进 revision 就不会触发重组 */
        val revision: Int = 0,
        val error: String? = null,
        val busy: Boolean = false,
        /** 正在编辑的条目 id；进入编辑时留一份快照，供「取消」回滚 */
        val editingItemId: String? = null,
        val entrySnapshot: SetDraft? = null,
        val deletePreview: SetDeletePreview? = null,
        val clearPreview: ClearCharacterPreview? = null,
    )

    private val _list = MutableStateFlow(ListState())
    val list: StateFlow<ListState> = _list.asStateFlow()

    private val _set = MutableStateFlow(SetState())
    val set: StateFlow<SetState> = _set.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _list.update { it.copy(loading = true, error = null) }
            runCatching {
                Triple(store.listQuickReplySets(), store.listCharacters(), _list.value.presets)
            }.fold(
                onSuccess = { (rows, characters, presets) ->
                    _list.update {
                        it.copy(sets = rows, characters = characters, presets = presets, loading = false)
                    }
                },
                onFailure = { error ->
                    _list.update { it.copy(loading = false, error = error.message ?: "快捷回复读取失败") }
                },
            )
        }
    }

    /** 角色名：找不到就退回 id（显示成原始键比显示空白更容易排查导入来的脏数据）。 */
    fun characterName(characterId: String?): String? = characterId?.let { id ->
        _list.value.characters.firstOrNull { it.id == id }?.name?.takeIf { it.isNotBlank() } ?: id
    }

    fun presetName(presetId: String?): String? = presetId?.let { id ->
        _list.value.presets.firstOrNull { it.id == id }?.name?.takeIf { it.isNotBlank() } ?: id
    }

    /** `action=preset` 的条目需要预设候选；列表页用不到，所以只在进入集合编辑时读一次。 */
    private fun loadPresets() {
        if (_list.value.presets.isNotEmpty()) return
        viewModelScope.launch {
            runCatching { store.listPresets() }
                .onSuccess { rows -> _list.update { it.copy(presets = rows) } }
                .onFailure { error -> _list.update { it.copy(error = error.message ?: "预设列表读取失败") } }
        }
    }

    // ------------------------------------------------------------ 集合：创建 / 复制 / 打开

    /** [characterId] 为 null 即全局集合（`characterId == null` 是「全局」的唯一判据）。 */
    fun startCreateSet(characterId: String?) {
        val now = System.currentTimeMillis()
        _set.update {
            SetState(
                isNew = true,
                draft = EditorDraft(
                    SetDraft(
                        row = LocalQuickReplySetEntity(
                            id = Ulid.newId(),
                            name = characterName(characterId).orEmpty(),
                            itemsJson = "[]",
                            sortIndex = (_list.value.sets.maxOfOrNull { row -> row.sortIndex } ?: -1) + 1,
                            characterId = characterId,
                            createdAt = now,
                            updatedAt = now,
                        ),
                        items = emptyList(),
                        extras = emptyMap(),
                    ),
                ),
            )
        }
        loadPresets()
        // 没落库的新集合共用一把键：按随机 id 存就永远找不回来（下次进来又是一个新 ULID）
        viewModelScope.launch {
            val restored = draftArea.restore(NEW_DRAFT_KEY) ?: return@launch
            val decoded = QuickReplyCodec.decode(restored.itemsJson)
            // IO 回来时用户可能已经加过条目了：别拿旧草稿盖掉正在写的集合
            if (_set.value.draft?.dirty == true) return@launch
            _set.update {
                SetState(
                    isNew = true,
                    draftRestored = true,
                    draft = EditorDraft(SetDraft(restored, decoded.items, decoded.unknownByKey)),
                )
            }
        }
    }

    /**
     * 草稿键：已落库的行用自身 id；「新建」和「复制集合」共用 [NEW_DRAFT_KEY]。
     *
     * 复制也归到新建那把键，因为它产生的行同样没落库、id 是临时 ULID：按该 id 存就成了
     * 一次性键，进程一回收就留下永远读不到、也永远清不掉的孤儿草稿。
     */
    private fun draftKey(state: SetState = _set.value): String = state.setId ?: NEW_DRAFT_KEY

    /**
     * 复制集合：条目 id **重新生成**。
     *
     * 集合级复制是 Android 独有能力（PC 只有平铺列表）。条目 id 在整库内必须唯一——
     * `LocalChatRepository.executeQuickReply` 是按 id 取第一条命中的，
     * 原样复制会让用户按到另一条集合里的同名回复上，所以重映射并把 extras 一起搬过去。
     */
    fun startDuplicateSet(id: String) {
        viewModelScope.launch {
            val row = store.getQuickReplySet(id) ?: return@launch
            val decoded = QuickReplyCodec.decode(row.itemsJson)
            val remapped = LinkedHashMap<String, String>()
            val copied = decoded.items.map { item ->
                val newId = Ulid.newId()
                remapped[item.id] = newId
                item.copy(id = newId)
            }
            val extras = LinkedHashMap<String, Map<String, Any?>>()
            decoded.unknownByKey.forEach { (oldId, keys) -> remapped[oldId]?.let { extras[it] = keys } }
            val now = System.currentTimeMillis()
            val nextSortIndex = (_list.value.sets.maxOfOrNull { row2 -> row2.sortIndex } ?: -1) + 1
            val copyRow = row.copy(
                id = Ulid.newId(),
                name = row.name.ifBlank { "快捷回复集合" } + " 副本",
                sortIndex = nextSortIndex,
                importedFrom = null,
                createdAt = now,
                updatedAt = now,
            )
            val copyDraft = SetDraft(row = copyRow, items = copied, extras = extras)
            _set.update { SetState(isNew = true, draft = EditorDraft(copyDraft)) }
            loadPresets()
        }
    }

    fun startEditSet(id: String) {
        viewModelScope.launch {
            val row = store.getQuickReplySet(id) ?: return@launch
            // 草稿区优先：库里那一行是上次保存的结果，用户退出时没点保存的内容只存在于草稿区
            val draft = draftArea.restore(id)?.takeIf { it != row }
            val effective = draft ?: row
            val decoded = QuickReplyCodec.decode(effective.itemsJson)
            _set.update {
                SetState(
                    setId = id,
                    draftRestored = draft != null,
                    draft = EditorDraft(SetDraft(effective, decoded.items, decoded.unknownByKey)),
                )
            }
            loadPresets()
        }
    }

    fun clearSetEditor() {
        // 只关页面：草稿留在草稿区，进程被杀也能接上
        _set.update { SetState(deletePreview = it.deletePreview, clearPreview = it.clearPreview) }
    }

    /** 离开确认里选「放弃草稿」：这时才真的清草稿（§2 的三个出口之一）。 */
    fun discardDraftAndClose() {
        val key = draftKey()
        clearSetEditor()
        viewModelScope.launch {
            draftArea.settle()
            draftArea.discard(key)
        }
    }

    // ------------------------------------------------------------ 草稿变更（一律不落库）

    /**
     * 草稿变更统一入口。
     *
     * `EditorDraft` 原地改内部值，而 `StateFlow` 按引用相等去重，
     * 所以必须推进 revision，否则表现就是「输入框打字没反应」。
     *
     * 这里也是**唯一的**草稿区写入点：条目增删改序、hotkey、集合名与顺序全部经过它，
     * 所以在落库之前就被记进草稿区——键入产生不了 journal（方案 §2）。
     */
    private fun mutate(transform: (SetDraft) -> SetDraft) {
        var edited: SetDraft? = null
        _set.update { state ->
            state.draft?.edit(transform)
            edited = state.draft?.draft
            state.copy(revision = state.revision + 1)
        }
        edited?.let { draftArea.schedule(viewModelScope, draftKey(), encodeRow(it)) }
    }

    fun editRow(transform: (LocalQuickReplySetEntity) -> LocalQuickReplySetEntity) =
        mutate { draft -> draft.copy(row = transform(draft.row)) }

    fun updateItem(id: String, transform: (QuickReply) -> QuickReply) = mutate { draft ->
        draft.copy(items = draft.items.map { item -> if (item.id == id) transform(item) else item })
    }

    /**
     * 快捷键（PC 的 Ctrl+数字，Android 只保真不回传语义）。
     *
     * 值统一存 `Long`：解码得到的就是 `Long`，存 `Int` 会让「选了原值再取消」被判成 dirty。
     * 传 null 是**删键**而不是写 null——PC 侧 `hotkey: undefined` 序列化后该键会消失。
     */
    fun setHotkey(id: String, hotkey: Long?) = mutate { draft ->
        val extras = LinkedHashMap(draft.extras)
        val entry = LinkedHashMap(extras[id].orEmpty())
        if (hotkey == null) entry.remove(HOTKEY_KEY) else entry[HOTKEY_KEY] = hotkey
        if (entry.isEmpty()) extras.remove(id) else extras[id] = entry
        draft.copy(extras = extras)
    }

    fun hotkeyOf(draft: SetDraft, id: String): Long? =
        (draft.extras[id]?.get(HOTKEY_KEY) as? Number)?.toLong()

    /** 被原样保留的未知键（编辑器要显示出来，否则用户以为 Android 改坏了 PC 数据）。 */
    fun preservedKeysOf(draft: SetDraft, id: String): List<String> = draft.extras[id].orEmpty().keys.sorted()

    fun addItem() {
        val draft = _set.value.draft?.draft ?: return
        val nextOrder = (draft.items.maxOfOrNull { it.order } ?: -1) + 1
        mutate { source ->
            source.copy(
                items = source.items + QuickReply(
                    id = Ulid.newId(),
                    label = "",
                    content = "",
                    action = QuickReplyAction.text,
                    sendWithAI = true,
                    order = nextOrder,
                    enabled = true,
                ),
            )
        }
    }

    fun removeItem(id: String) = mutate { draft ->
        draft.copy(
            items = draft.items.filterNot { it.id == id },
            extras = LinkedHashMap(draft.extras).apply { remove(id) },
        )
    }

    /**
     * 条目上移/下移。
     *
     * 聊天侧按条目 `order` 排序（PC `getEffectiveQuickReplies` 同规则），所以改的是 `order`
     * 而不是数组位置；交换后以该集合现有最小值连续重编，`order` 会进 payload，
     * 因此这一步是真实变更，必须靠保存落成一次写。
     */
    fun moveItem(id: String, up: Boolean) = mutate { draft ->
        val ordered = displayItems(draft.items).toMutableList()
        val index = ordered.indexOfFirst { it.id == id }
        val target = if (index < 0) -1 else if (up) index - 1 else index + 1
        if (index < 0 || target !in ordered.indices) return@mutate draft
        val tmp = ordered[index]
        ordered[index] = ordered[target]
        ordered[target] = tmp
        val base = ordered.minOf { it.order }
        draft.copy(items = ordered.mapIndexed { position, item -> item.copy(order = base + position) })
    }

    /** 条目展示序：`order` 升序，同值保持录入顺序（`sortedWith` 稳定）。 */
    fun displayItems(items: List<QuickReply>): List<QuickReply> = items.sortedWith(compareBy { it.order })

    /** 集合展示序：与仓储 SQL 的 `ORDER BY sort_index, id` 同口径。 */
    fun displaySets(rows: List<LocalQuickReplySetEntity>): List<LocalQuickReplySetEntity> =
        rows.sortedWith(compareBy({ it.sortIndex }, { it.id }))

    // ------------------------------------------------------------ 条目编辑页进出

    fun startItemEdit(id: String) {
        val draft = _set.value.draft?.draft ?: return
        _set.update { it.copy(editingItemId = id, entrySnapshot = draft) }
    }

    fun cancelItemEdit() {
        val snapshot = _set.value.entrySnapshot ?: return
        _set.update { state ->
            state.draft?.edit { snapshot }
            state.copy(editingItemId = null, entrySnapshot = null, revision = state.revision + 1)
        }
    }

    fun finishItemEdit() {
        _set.update { it.copy(editingItemId = null, entrySnapshot = null) }
    }

    // ------------------------------------------------------------ 保存（唯一落库点）

    /** 草稿 → 行：条目整体经 codec 重编码，extras 一并写回（PC 专用字段因此不丢）。 */
    private fun encodeRow(draft: SetDraft): LocalQuickReplySetEntity =
        draft.row.copy(itemsJson = QuickReplyCodec.encode(draft.items, draft.extras))

    fun saveSet() {
        val state = _set.value
        val draft = state.draft ?: return
        val savedKey = draftKey(state)
        viewModelScope.launch {
            _set.update { it.copy(busy = true, error = null) }
            val result = runCatching {
                if (state.isNew) {
                    // 新建无「原值」可比，commit 的 dirty 判定不成立，直接落一次
                    store.putQuickReplySet(encodeRow(draft.draft))
                } else {
                    draft.commit { target -> store.putQuickReplySet(encodeRow(target)) }
                }
            }
            result.fold(
                onSuccess = {
                    // 保存即是一次业务变更的落地：草稿必须清掉，否则下次进来会再恢复出一份
                    // 已经存进库的内容，并把「已保存」显示成「未保存的修改」。
                    draftArea.settle()
                    draftArea.discard(savedKey)
                    _set.update { SetState() }
                    refresh()
                },
                onFailure = { error -> _set.update { it.copy(busy = false, error = error.message ?: "保存失败") } },
            )
        }
    }

    // ------------------------------------------------------------ 集合排序与删除

    /**
     * 集合上移/下移：交换两行的 `sortIndex`。
     *
     * 仓储只有正则的 `reorderRegexRules`，快捷回复没有整表重排入口，所以逐行 `putQuickReplySet`。
     * 只有真正变化的行才写（多数交换只影响两行），且 journal 粒度本就是整库单实体，
     * 中间态不会让对端看到不一致的最终视图。
     */
    fun moveSet(id: String, up: Boolean) {
        viewModelScope.launch {
            val ordered = displaySets(_list.value.sets).toMutableList()
            val index = ordered.indexOfFirst { it.id == id }
            val target = if (index < 0) -1 else if (up) index - 1 else index + 1
            if (index < 0 || target !in ordered.indices) return@launch
            val tmp = ordered[index]
            ordered[index] = ordered[target]
            ordered[target] = tmp
            runCatching {
                ordered.forEachIndexed { position, row ->
                    if (row.sortIndex != position) {
                        store.putQuickReplySet(row.copy(sortIndex = position, updatedAt = System.currentTimeMillis()))
                    }
                }
            }.onSuccess { refresh() }
                .onFailure { error -> _list.update { it.copy(error = error.message ?: "排序失败") } }
        }
    }

    fun inspectDeleteSet(id: String) {
        viewModelScope.launch {
            val row = store.getQuickReplySet(id) ?: return@launch
            val characterId = row.characterId
            val remaining = characterId?.let { store.listCharacterQuickReplySets(it).count { set -> set.id != id } }
            _set.update {
                it.copy(
                    deletePreview = SetDeletePreview(
                        setId = id,
                        setName = row.name.ifBlank { "未命名集合" },
                        itemCount = QuickReplyCodec.decodeItems(row.itemsJson).size,
                        characterId = characterId,
                        lastSetForCharacter = characterId != null && remaining == 0,
                    ),
                )
            }
        }
    }

    fun clearDeletePreview() {
        _set.update { it.copy(deletePreview = null) }
    }

    /** 删除只走仓储：整库 journal 与角色级 tombstone 都由 `deleteQuickReplySet` 负责。 */
    fun confirmDeleteSet(id: String) {
        viewModelScope.launch {
            runCatching { store.deleteQuickReplySet(id) }
                .onSuccess {
                    // 行已经删掉，它的草稿没有归宿：一并清掉，不留孤儿键
                    draftArea.settle()
                    draftArea.discard(id)
                    _set.update { SetState() }
                    refresh()
                }
                .onFailure { error ->
                    _set.update { it.copy(deletePreview = null) }
                    _list.update { it.copy(error = error.message ?: "删除失败") }
                }
        }
    }

    fun inspectClearCharacter(characterId: String) {
        viewModelScope.launch {
            val rows = store.listCharacterQuickReplySets(characterId)
            if (rows.isEmpty()) {
                _list.update { it.copy(error = "该角色名下没有快捷回复集合") }
                return@launch
            }
            _set.update {
                it.copy(
                    clearPreview = ClearCharacterPreview(
                        characterId = characterId,
                        characterName = characterName(characterId) ?: characterId,
                        setCount = rows.size,
                        itemCount = rows.sumOf { row -> QuickReplyCodec.decodeItems(row.itemsJson).size },
                    ),
                )
            }
        }
    }

    fun clearClearPreview() {
        _set.update { it.copy(clearPreview = null) }
    }

    /** 同上：`deleteCharacterQuickReplies` 内部会重算整库 journal 并补该角色 tombstone。 */
    fun confirmClearCharacter(characterId: String) {
        viewModelScope.launch {
            runCatching { store.deleteCharacterQuickReplies(characterId) }
                .onSuccess {
                    _set.update { SetState() }
                    refresh()
                }
                .onFailure { error ->
                    _set.update { it.copy(clearPreview = null) }
                    _list.update { it.copy(error = error.message ?: "清空失败") }
                }
        }
    }

    // ------------------------------------------------------------ 整库导入导出

    /**
     * 导出整库。
     *
     * 直接复用 [EntityPayloads.quickReplyStorePayload]：它产出的就是 PC 的
     * `quickReplies.json` 形状（`{global, byCharacter}`，条目原样透传含 hotkey）。
     * 自己再拼一遍就会得到「导出格式」与「同步格式」两份真值，跨端往返必然对不上。
     */
    suspend fun exportStoreJson(): ByteArray =
        JsonValues.stringify(EntityPayloads.quickReplyStorePayload(store.listQuickReplySets()))
            .toByteArray(Charsets.UTF_8)

    /**
     * 导入整库（PC `quickReply:importJson` 的等价能力）。
     *
     * 与 PC 的**有意差异**：PC 导入会整体替换 `global`，这里一律「按 id 去重后追加」——
     * 移动端没有「先备份再覆盖」的确认路径，静默覆盖用户已有集合比少并几条更糟。
     * `byCharacter` 里本机不存在的角色直接跳过，否则列表会出现无人认领的孤儿集合。
     */
    fun importStore(documents: List<PickedDocument>) {
        if (documents.isEmpty()) return
        viewModelScope.launch {
            _list.update { it.copy(busy = true, error = null, importReport = null) }
            val report = runCatching { runImport(documents) }
            report.fold(
                onSuccess = { value -> _list.update { it.copy(busy = false, importReport = value) } },
                onFailure = { error -> _list.update { it.copy(busy = false, error = error.message ?: "导入失败") } },
            )
            refresh()
        }
    }

    private suspend fun runImport(documents: List<PickedDocument>): ImportReport {
        val existingSets = store.listQuickReplySets()
        val characters = store.listCharacters().associateBy { it.id }
        val usedIds = HashSet<String>()
        existingSets.forEach { row ->
            QuickReplyCodec.decodeItems(row.itemsJson).forEach { usedIds += it.id }
        }

        val skipped = ArrayList<String>()
        val failed = ArrayList<String>()
        val approximated = ArrayList<String>()
        val preserved = ArrayList<String>()
        // key = ""（全局）或角色 id；一个作用域只写一次，避免同一批导入对同一集合产生多条 journal
        val appended = LinkedHashMap<String, MutableList<QuickReply>>()
        val appendedExtras = LinkedHashMap<String, MutableMap<String, Map<String, Any?>>>()
        val appendedOrigin = LinkedHashMap<String, String>()
        var imported = 0

        for (document in documents) {
            val root = JsonValues.parseObject(document.bytes.toString(Charsets.UTF_8))
            if (root.isEmpty()) {
                failed += "${document.displayName}：不是合法的快捷回复 JSON 对象"
                continue
            }
            val scopes = ArrayList<Pair<String, List<*>>>()
            when (val global = root["global"]) {
                is List<*> -> scopes += GLOBAL_KEY to global
                else -> failed += "${document.displayName}：缺少 global 数组（PC 格式为 {global, byCharacter}）"
            }
            when (val byCharacter = root["byCharacter"]) {
                is Map<*, *> -> byCharacter.forEach { (rawId, rawList) ->
                    val characterId = rawId as? String
                    when {
                        characterId.isNullOrBlank() ->
                            failed += "${document.displayName}：byCharacter 存在非法角色键"
                        characters[characterId] == null ->
                            skipped += "${document.displayName} · $characterId：本机没有这个角色，不创建孤儿集合"
                        rawList !is List<*> ->
                            skipped += "${document.displayName} · $characterId：条目不是数组"
                        else -> scopes += characterId to rawList
                    }
                }
                else -> Unit
            }

            scopes.forEach { (scopeKey, rawList) ->
                val where = if (scopeKey == GLOBAL_KEY) "全局" else characters[scopeKey]?.name ?: scopeKey
                val accepted = ArrayList<Any>()
                // PC normalize：order 非数值时落到 0。这里先记下缺 order 的 id，
                // 不能让 codec 的 fallbackOrderBase 用数组下标顶上——那会让两端导出不同哈希。
                val orderless = HashSet<String>()
                rawList.forEachIndexed { position, element ->
                    val obj = element as? Map<*, *>
                    if (obj == null) {
                        failed += "$where 第 ${position + 1} 条：不是 JSON 对象"
                        return@forEachIndexed
                    }
                    val declaredId = (obj["id"] as? String)?.takeIf { it.isNotBlank() }
                    val id = declaredId ?: Ulid.newId()
                    if (declaredId == null) approximated += "$where 第 ${position + 1} 条缺少 id，已补新生成 id（与 PC 同规则）"
                    if (id in usedIds) {
                        skipped += "$where「${(obj["label"] as? String) ?: id}」：条目 id 已存在"
                        return@forEachIndexed
                    }
                    if (obj["order"] !is Number) orderless += id
                    if (QuickReplyCodec.isUnknownAction(obj["action"])) {
                        approximated += "$where「${(obj["label"] as? String) ?: id}」：动作「${obj["action"]}」Android 不认识，按 text 处理"
                    }
                    usedIds += id
                    accepted += obj
                }
                if (accepted.isEmpty()) return@forEach
                val decoded = QuickReplyCodec.decode(JsonValues.stringify(accepted), fallbackOrderBase = 0)
                val items = decoded.items.map { if (it.id in orderless) it.copy(order = 0) else it }
                appended.getOrPut(scopeKey) { ArrayList() }.addAll(items)
                val extras = appendedExtras.getOrPut(scopeKey) { LinkedHashMap() }
                items.forEach { item ->
                    decoded.unknownByKey[item.id]?.let { keys ->
                        extras[item.id] = keys
                        val names = keys.keys.sorted()
                        preserved += "$where「${item.label.ifBlank { item.id }}」保留了 ${names.size} 个 Android 不消费的键：${names.joinToString()}"
                    }
                }
                appendedOrigin.putIfAbsent(scopeKey, document.displayName)
                imported += items.size
            }
        }

        var setsWritten = 0
        appended.forEach { (scopeKey, items) ->
            val characterId = scopeKey.takeIf { it != GLOBAL_KEY }
            val extras = LinkedHashMap(appendedExtras[scopeKey].orEmpty())
            val existing = displaySets(existingSets.filter { it.characterId == characterId }).firstOrNull()
            val row: LocalQuickReplySetEntity
            val merged: List<QuickReply>
            if (existing == null) {
                row = LocalQuickReplySetEntity(
                    id = Ulid.newId(),
                    name = characterId?.let { characters[it]?.name ?: "角色 $it" } ?: "导入的快捷回复",
                    itemsJson = "[]",
                    sortIndex = (existingSets.maxOfOrNull { it.sortIndex } ?: -1) + 1 + setsWritten,
                    importedFrom = appendedOrigin[scopeKey],
                    characterId = characterId,
                    createdAt = 0L,
                    updatedAt = 0L,
                )
                merged = items
            } else {
                // id 冲突在分类阶段就被 usedIds 挡掉了，这里只可能追加；
                // 再解一次原集合是为了把它的 extras 一并带上（否则原集合的 PC 字段会被覆盖掉）
                val decoded = QuickReplyCodec.decode(existing.itemsJson)
                decoded.unknownByKey.forEach { (itemId, keys) -> extras.putIfAbsent(itemId, keys) }
                row = existing
                merged = decoded.items + items
            }
            store.putQuickReplySet(row.copy(itemsJson = QuickReplyCodec.encode(merged, extras)))
            setsWritten += 1
        }

        return ImportReport(
            imported = imported,
            setsWritten = setsWritten,
            skipped = skipped,
            failed = failed,
            approximated = approximated,
            preserved = preserved,
        )
    }

    companion object {
        /** 导入作用域的键：全局用空串，角色级用角色 id。 */
        private const val GLOBAL_KEY = ""

        /** 与 PC `QuickReply.hotkey` 逐字一致的键名（大小写敏感，写错就是一个新键）。 */
        const val HOTKEY_KEY = "hotkey"

        /** PC 的快捷键位是 Ctrl+1..9；`null` 表示「无」（= 删除该键，而不是写 null）。 */
        val HOTKEY_SLOTS: List<Long?> = listOf<Long?>(null) + (1L..9L).toList()

        /** 条目动作的界面名，与 PC `QuickRepliesPage.actionLabels` 同措辞。 */
        val ACTION_LABELS = mapOf(
            QuickReplyAction.text to "发送文本",
            QuickReplyAction.preset to "切换预设",
            QuickReplyAction.command to "斜杠命令",
        )

        /** Android 只保真、不生效的 PC 字段（提示文案用，避免用户以为丢了数据）。 */
        val PRESERVED_ONLY: Set<String> = QuickReplyItemExtras.PRESERVED_ONLY
    }
}

/** 草稿区分区名：与仓储里的实体类型对齐，换编辑器不会互相覆盖。 */
private const val DRAFT_KIND = "quick_reply_set"

/** 未落库行的共用草稿键：见 [QuickReplyEditorViewModel.draftKey]。 */
private const val NEW_DRAFT_KEY = "new"
