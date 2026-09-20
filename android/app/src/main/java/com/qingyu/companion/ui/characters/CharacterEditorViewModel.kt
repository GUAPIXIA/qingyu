package com.qingyu.companion.ui.characters

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.chatcore.Ulid
import com.qingyu.companion.content.CharacterCardCodec
import com.qingyu.companion.content.MediaImportGate
import com.qingyu.companion.content.PngTextChunks
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.domain.CharacterSortColumn
import com.qingyu.companion.local.domain.BindingImpact
import com.qingyu.companion.data.ContentDraftStore
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.ui.content.ContentDraftAutosaver
import com.qingyu.companion.ui.content.ContentDraftCodec
import com.qingyu.companion.ui.content.EditorDraft
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File

/**
 * 阶段 5 S5-01：角色管理（列表、搜索、排序、创建、复制、编辑、删除、导入导出）。
 *
 * 与阶段 3/4 的「只读浏览 + 切换当前角色」并存：浏览页保持原样，
 * 编辑能力放在这个独立 ViewModel 里，避免把只读页改成一个巨大的状态机。
 *
 * 分层（总方案 §5.1）：UI 只调本类；本类只依赖 [LocalStore] 接口，
 * 不碰 Room/DAO/文件细节（媒体落盘经 [MediaImportGate]，它是内容层而非数据层）。
 */
class CharacterEditorViewModel(
    private val store: LocalStore,
    private val mediaRoot: File,
    drafts: ContentDraftStore,
) : ViewModel() {

    /** 列表页状态。搜索与排序都在数据库层完成（方案 §2）。 */
    data class ListState(
        val characters: List<LocalCharacterEntity> = emptyList(),
        val query: String = "",
        val sortBy: String = SORT_BY_UPDATED,
        val total: Int = 0,
        val loading: Boolean = false,
        val error: String? = null,
        /** 批量导入的结果报告（方案 §2：显示成功、跳过、失败与未知字段保留） */
        val importReport: ImportReport? = null,
        val busy: Boolean = false,
    )

    /**
     * 导入报告：方案 §2 的五类一类不少——成功、跳过、近似映射、失败、未知字段保留。
     *
     * [approximated] 对角色卡只有一种来源：PNG 里带 `zTXt` / 压缩 `iTXt` 文本段。
     * 这类段**两端都读不出内容**（PC 同规则，跨端 fixture `itxt-compressed-skipped` 钉着），
     * 所以它不是缺陷；但卡导入成功后内容比作者写的少，这件事必须说出来，
     * 否则用户分不清「卡本来就没写」和「写了但被导入丢掉了」。
     */
    data class ImportReport(
        val imported: Int,
        val skipped: List<String>,
        val approximated: List<String>,
        val failed: List<String>,
        /** 每张卡保留下来的未知字段（来源字段名） */
        val unmapped: Map<String, List<String>>,
        val boundLorebooks: Int,
    )

    /** 编辑器状态：一个草稿 + 影响范围 + 保存结果。 */
    data class EditorState(
        val characterId: String? = null,
        val draft: EditorDraft<LocalCharacterEntity>? = null,
        val impact: BindingImpact? = null,
        val error: String? = null,
        val saved: Boolean = false,
        val busy: Boolean = false,
        /** 草稿修订号：见 [edit] —— 原地可变草稿需要它才能被 StateFlow 观察到 */
        val revision: Int = 0,
        /** 这次打开的是**从草稿区恢复**的未保存内容：界面要说明白，不能让用户以为是库里存的版本 */
        val draftRestored: Boolean = false,
    )

    private val media = MediaImportGate(mediaRoot)

    /**
     * 草稿区（§2）。角色行有 30 多列，所以走 [ContentDraftCodec] 的全列快照而不是同步 payload：
     * payload 是稀疏白名单，用它存草稿会把「用户刚填到一半的头像路径/内嵌世界书」丢掉。
     */
    private val draftArea = ContentDraftAutosaver(
        store = drafts,
        kind = DRAFT_KIND,
        encode = ContentDraftCodec::encodeCharacter,
        decode = ContentDraftCodec::decodeCharacter,
        // 草稿被容量判定拒绝时必须说出来：静默不写会让用户以为退出还能接着写
        onSkipped = { note -> _editor.update { it.copy(error = note) } }
    )

    private val _list = MutableStateFlow(ListState())
    val list: StateFlow<ListState> = _list.asStateFlow()

    private val _editor = MutableStateFlow(EditorState())
    val editor: StateFlow<EditorState> = _editor.asStateFlow()

    init {
        refresh()
    }

    // ------------------------------------------------------------ 列表

    fun refresh() {
        viewModelScope.launch {
            _list.update { it.copy(loading = true, error = null) }
            runCatching { load() }
                .onSuccess { page ->
                    _list.update { it.copy(characters = page.first, total = page.second, loading = false) }
                }
                .onFailure { error ->
                    _list.update { it.copy(loading = false, error = error.message ?: "加载角色失败") }
                }
        }
    }

    private suspend fun load(): Pair<List<LocalCharacterEntity>, Int> {
        val state = _list.value
        val rows = store.searchCharacters(state.query.trim(), state.sortBy, PAGE_SIZE, 0)
        return rows to store.countCharacters(state.query.trim())
    }

    fun onQueryChange(query: String) {
        _list.update { it.copy(query = query) }
        refresh()
    }

    fun onSortChange(sortBy: String) {
        _list.update { it.copy(sortBy = CharacterSortColumn.resolve(sortBy)) }
        refresh()
    }

    // ------------------------------------------------------------ 新建 / 复制 / 编辑

    fun startCreate() {
        // 先**同步**把空编辑器立起来，再去异步取草稿。整段都写在 launch 里会丢输入：
        // 草稿区读一次是 IO，用户在 IO 回来之前打的字，会被随后那句
        // `_editor.update { EditorState(...) }` 整体盖掉（设备用例实测红过一次）。
        val row = newCharacterRow(Ulid.newId(), System.currentTimeMillis())
        _editor.update { EditorState(characterId = null, draft = EditorDraft(row)) }
        // 新建的草稿键固定用 NEW_DRAFT_KEY：新建时行 id 还没落地就换了页面，
        // 用随机 id 当键等于每次进来都是新草稿，进程被杀的那半篇永远找不回来。
        viewModelScope.launch {
            val restored = draftArea.restore(NEW_DRAFT_KEY) ?: return@launch
            // 回来时用户可能已经动笔了：那份旧草稿马上会被当前编辑的自动保存覆盖，
            // 拿它盖掉正在写的内容才是真的丢数据。
            if (_editor.value.draft?.dirty == true) return@launch
            _editor.update { it.copy(draft = EditorDraft(restored), draftRestored = true) }
        }
    }

    /**
     * 复制角色。
     *
     * 复制的是**内容**，不复制会话与引用：新角色行必须拿新 ULID，
     * 且 `defaultPersonaId/defaultPresetId` 这类绑定按 PC 语义保留（它们是跨角色可共享的资产），
     * 而 `lorebookId` 保留也符合直觉——用户复制角色通常是要同一套设定继续聊。
     */
    fun startDuplicate(sourceId: String) {
        viewModelScope.launch {
            val source = store.getCharacter(sourceId) ?: return@launch
            val now = System.currentTimeMillis()
            val row = source.copy(id = Ulid.newId(), name = "${source.name} 副本", createdAt = now, updatedAt = now)
            // 复制**不**恢复 "new" 草稿：这里要展示的是刚复制出来的那一行，
            // 拿另一份未保存内容盖上去，用户看到的就是「复制把我原来的东西改了」。
            _editor.update { EditorState(characterId = null, draft = EditorDraft(row)) }
        }
    }

    fun startEdit(id: String) {
        viewModelScope.launch {
            val row = store.getCharacter(id) ?: return@launch
            val restored = draftArea.restore(id)
            // 草稿与库里那一行完全一致时不算「有草稿」：那种残留是上次保存后没清干净，
            // 提示「已恢复未保存草稿」反而是误导。
            val useful = restored?.takeIf { it != row }
            _editor.update {
                EditorState(characterId = id, draft = EditorDraft(useful ?: row), draftRestored = useful != null)
            }
        }
    }

    fun edit(transform: (LocalCharacterEntity) -> LocalCharacterEntity) {
        // 草稿是原地改的可变对象，StateFlow 按引用相等去重；不推进 revision
        // 就不会触发重组，表现是「输入框打字没反应」。
        var edited: LocalCharacterEntity? = null
        _editor.update { state ->
            state.draft?.edit(transform)
            state.draft?.draft?.let { edited = it }
            state.copy(revision = state.revision + 1)
        }
        // 键入只进草稿区，不进库、不进 journal（§2）。
        edited?.let { draftArea.schedule(viewModelScope, draftKey(it), it) }
    }

    /** 新建与复制都写在同一把「未落地」键下；编辑中的角色按自己的 id 存。 */
    private fun draftKey(row: LocalCharacterEntity): String =
        if (_editor.value.characterId == null) NEW_DRAFT_KEY else row.id

    /** 离开确认里选「保存并离开」：先落成那一次业务变更，成功后再关编辑器。 */
    fun saveAndClose() {
        closeAfterSave = true
        save()
    }

    private var closeAfterSave = false

    /**
     * 离开确认里选「不保存」：丢掉草稿并关掉编辑器。
     *
     * 只有**用户明确放弃**才清草稿。进程被杀、页面被回收都不会走到这里，
     * 那种中断正是草稿区要救的场景。
     */
    fun discardDraftAndClose() {
        val row = _editor.value.draft?.draft
        _editor.update { EditorState() }
        viewModelScope.launch {
            draftArea.settle()
            row?.let { draftArea.discard(draftKey(it)) }
        }
    }

    fun clearEditor() {
        // 只是关掉页面：草稿留在草稿区。进程被杀、系统回收页面都走这里之外的路径，
        // 而「明确不保存」由 [discardDraftAndClose] 负责清草稿。
        closeAfterSave = false
        _editor.update { EditorState() }
    }

    /** 保存：无变化时不产生业务写（见 [EditorDraft.commit]）。 */
    fun save() {
        val state = _editor.value.draft ?: return
        // 已在保存中：第二次提交必须直接返回。
        //
        // 为什么这道闸是必要的而不是「UI 已经禁用了保存按钮」——`isNewRow` 取的是
        // **调用这一刻**的 `characterId`，而它是在保存成功的回调里才升上去的。
        // 于是「第一次提交还没落地时又提交一次」会拿着 `isNewRow = true` 再 force 落一次：
        // 两条 journal、版本向量多推一格，正是 §2 禁止的重复业务变更。
        // 触发路径不止连点按钮：`saveAndClose()`（离开确认里的「保存并离开」）
        // 与在途保存撞车时同样会走到这里。
        // 设备用例 `CharacterEditorSaveIdempotenceInstrumentedTest` 在满载的全量套件里
        // 就是**时序上刚好撞上**才红过（单跑绿、复跑绿）——不加闸时这条不变式靠运气成立。
        if (_editor.value.busy) return
        // 新行必须强制落一次：从草稿区恢复出来的新建草稿 dirty 恒为假，
        // 不 force 就是「显示已保存、库里没有这一行」。
        val isNewRow = _editor.value.characterId == null
        // 草稿键必须在这里就算好：成功回调会把 characterId 升成行 id，
        // 之后再算就拿着 行id 去清一个从来没写过的槽，而真正该清的 new 槽留在原地。
        val savedKey = draftKey(state.draft)
        viewModelScope.launch {
            _editor.update { it.copy(busy = true, error = null) }
            val result = runCatching {
                state.commit(force = isNewRow) { row ->
                    store.putCharacter(row.copy(updatedAt = System.currentTimeMillis()))
                }
            }
            result.fold(
                onSuccess = {
                    if (closeAfterSave) {
                        closeAfterSave = false
                        _editor.update { EditorState() }
                    } else {
                        // 落库成功后这一行已经是「已存在」的实体：把编辑器的 characterId 升上去。
                        // 不升就会留着 §2.12 为「草稿恢复后保存」加的 force 再落一次——
                        // 连点两次保存 = 两条 journal、版本向量推到 2（设备用例实测红过）。
                        // 升上去之后重复提交走 dirty 判定：没改过就什么都不产生。
                        _editor.update {
                            it.copy(
                                busy = false,
                                saved = true,
                                draftRestored = false,
                                characterId = it.characterId ?: state.draft.id,
                            )
                        }
                    }
                    // 内容已经落成一次业务变更，草稿必须跟着清掉：
                    // 留着的话下次打开会被当成「未保存的改动」恢复出来，比丢草稿更糟。
                    draftArea.settle()
                    draftArea.discard(savedKey)
                },
                onFailure = { error ->
                    _editor.update { it.copy(busy = false, error = error.message ?: "保存失败") }
                },
            )
        }
    }

    // ------------------------------------------------------------ 删除与影响范围

    fun inspectDelete(id: String) {
        viewModelScope.launch {
            val impact = runCatching { store.characterBindingImpact(id) }.getOrNull()
            _editor.update { it.copy(impact = impact) }
        }
    }

    /**
     * 执行删除。
     *
     * 影响范围只是**展示**用途，不在这里再挡一次：引用会话/消息的清理与 tombstone
     * 由 [LocalStore.deleteCharacter] 在同一事务内完成（含角色级快捷回复），
     * UI 层重复判断会出现两套删除规则。
     */
    fun confirmDelete(id: String) {
        viewModelScope.launch {
            _list.update { it.copy(busy = true) }
            runCatching { store.deleteCharacter(id) }
                .onSuccess {
                    _editor.update { EditorState() }
                    _list.update { it.copy(busy = false) }
                    refresh()
                }
                .onFailure { error ->
                    _list.update { it.copy(busy = false, error = error.message ?: "删除失败") }
                }
        }
    }

    // ------------------------------------------------------------ 导入

    /**
     * 批量导入（JSON 与 PNG 混合）。
     *
     * 每张卡失败只影响它自己：一批 50 张卡里 1 张损坏是常态，
     * 整批回滚会把用户已经拿到的结果也带走。
     *
     * 报告分五类：成功、跳过（格式认识但这台设备处理不了）、近似映射（导入了但内容比原文少）、
     * 失败（解析或写入出错）、未知字段保留。方案 §2 要求导入显示这五种，而不是只报「成功 N 个」。
     */
    fun importDocuments(documents: List<com.qingyu.companion.ui.content.PickedDocument>) {
        if (documents.isEmpty()) return
        viewModelScope.launch {
            _list.update { it.copy(busy = true, error = null) }
            media.beginBatch()
            var imported = 0
            var boundLorebooks = 0
            val skipped = ArrayList<String>()
            val approximated = ArrayList<String>()
            val failed = ArrayList<String>()
            val unmapped = LinkedHashMap<String, List<String>>()

            for (document in documents) {
                // 近似清单先收到局部变量：这一份到底算不算数，要等写入结果出来才定，
                // 否则一个「失败」的文件会同时在「近似映射」里留一条，报告自相矛盾。
                val dropped = ArrayList<String>()
                val draft = parseCard(document, dropped)
                if (draft == null) {
                    failed += document.displayName
                    continue
                }
                val id = Ulid.newId()
                val now = System.currentTimeMillis()
                val avatarRelPath = storeAvatar(draft, skipped)
                val written = runCatching {
                    store.putCharacter(CharacterCardCodec.entityOf(draft, id, now, avatarRelPath))
                }.isSuccess
                if (!written) {
                    failed += document.displayName
                    continue
                }
                imported += 1
                approximated += dropped
                if (draft.unmappedFields.isNotEmpty()) unmapped[draft.name] = draft.unmappedFields
                // 内嵌世界书：提取成独立 lorebook 实体并绑定（方案 S5-01「内嵌世界书提取与绑定」）
                if (bindEmbeddedLorebook(draft, id)) boundLorebooks += 1
            }

            _list.update {
                it.copy(
                    busy = false,
                    importReport = ImportReport(imported, skipped, approximated, failed, unmapped, boundLorebooks),
                )
            }
            refresh()
        }
    }

    private fun parseCard(
        document: com.qingyu.companion.ui.content.PickedDocument,
        approximated: MutableList<String>,
    ): CharacterCardCodec.Draft? {
        val looksPng = PngTextChunks.isPng(document.bytes)
        val result = if (looksPng) {
            CharacterCardCodec.importPng(document.bytes)
        } else {
            CharacterCardCodec.importJson(document.bytes.toString(Charsets.UTF_8))
        }
        return when (result) {
            is CharacterCardCodec.ImportResult.Success -> {
                if (looksPng) {
                    // 只在卡**确实导入成功**之后报：被拒的文件已经在「失败」那一类里了。
                    PngTextChunks.unreadTextChunkKeys(document.bytes).forEach { chunk ->
                        approximated += "${document.displayName}：文本段 $chunk 读不出内容，未导入"
                    }
                }
                result.draft
            }
            is CharacterCardCodec.ImportResult.Rejected -> null
        }
    }

    /**
     * 头像落地：data URL → 解码 → 先验后写。
     *
     * 远程 URL 型封面**不在这里下载**：移动端首版不自动拉外网图片，
     * 记进 [skipped] 让用户看到「这张卡的封面没有带过来」而不是静默丢图。
     */
    private fun storeAvatar(
        draft: CharacterCardCodec.Draft,
        skipped: MutableList<String>,
    ): String? {
        val reference = draft.imageReference ?: return null
        if (!reference.startsWith("data:image/")) {
            skipped += "${draft.name}：封面是远程引用，未自动下载"
            return null
        }
        val bytes = runCatching {
            java.util.Base64.getMimeDecoder().decode(reference.substringAfter(','))
        }.getOrNull()
        if (bytes == null || bytes.isEmpty()) {
            skipped += "${draft.name}：封面数据无法解码"
            return null
        }
        val outcome = media.accept("character-avatar", "avatar.png", bytes)
        return when (outcome) {
            is MediaImportGate.Outcome.Accepted -> outcome.relPath
            is MediaImportGate.Outcome.Rejected -> {
                // 角色本身仍然导入成功，封面按跳过报告：两者不应互相绑架
                skipped += "${draft.name}：${outcome.reason}"
                null
            }
        }
    }

    private suspend fun bindEmbeddedLorebook(draft: CharacterCardCodec.Draft, characterId: String): Boolean {
        val embedded = draft.embeddedCharacterBook ?: return false
        val lorebookId = Ulid.newId()
        val now = System.currentTimeMillis()
        val name = "${draft.name}的世界书"
        // 导入器由世界书侧提供（S5-02）；这里只保证「提取出的文档能落成独立实体并绑定」。
        val canonical = LorebookImportBridge.canonicalJsonOf(embedded, lorebookId, name, now) ?: return false
        runCatching {
            store.putLorebook(
                com.qingyu.companion.local.db.LocalLorebookEntity(
                    id = lorebookId,
                    name = name,
                    canonicalJson = canonical,
                    createdAt = now,
                    updatedAt = now,
                    importedFrom = "character-card",
                ),
            )
        }.onFailure { return false }
        runCatching {
            store.getCharacter(characterId)?.let { existing ->
                store.putCharacter(
                    existing.copy(
                        lorebookId = lorebookId,
                        boundLorebookIdsJson = encodeStringList(stringListOf(existing.boundLorebookIdsJson) + lorebookId),
                    ),
                )
            }
        }
        return true
    }

    // ------------------------------------------------------------ 导出

    /** 导出为 JSON（V2/V3）或 PNG。返回错误信息，`null` 表示成功。 */
    suspend fun export(id: String, format: String, targetBytes: (ByteArray, String, String) -> Unit) {
        val row = store.getCharacter(id) ?: return
        val draft = CharacterCardCodec.draftOf(row)
        val fileName = sanitizeFileName(draft.name)
        when (format) {
            "json-v2" -> targetBytes(CharacterCardCodec.exportV2Json(draft).toByteArray(Charsets.UTF_8), "$fileName.json", "application/json")
            "json-v3" -> targetBytes(CharacterCardCodec.exportV3Json(draft).toByteArray(Charsets.UTF_8), "$fileName.json", "application/json")
            "png" -> {
                val base = media.read(row.avatarPath)
                val bytes = CharacterCardCodec.exportPng(draft, base?.takeIf { PngTextChunks.isPng(it) })
                targetBytes(bytes, "$fileName.png", "image/png")
            }
            "cover" -> {
                val bytes = media.read(row.avatarPath)
                if (bytes != null) {
                    val ext = extensionOf(bytes)
                    targetBytes(bytes, "$fileName.$ext", "image/${if (ext == "jpg") "jpeg" else ext}")
                }
            }
        }
    }

    private fun extensionOf(bytes: ByteArray): String =
        PngTextChunks.detectMimeType(bytes).substringAfter('/').let { if (it == "jpeg") "jpg" else it }

    private fun sanitizeFileName(name: String): String =
        name.replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1F]"), "_").trim().ifBlank { "character" }

    companion object {
        const val SORT_BY_NAME = "name"
        const val SORT_BY_CREATED = "created"
        const val SORT_BY_UPDATED = "updated"
        private const val PAGE_SIZE = 200

        /** 草稿区分区名与「还没落地的新行」共用的键。 */
        const val DRAFT_KIND = "character"
        const val NEW_DRAFT_KEY = "new"

        fun newCharacterRow(id: String, now: Long): LocalCharacterEntity = LocalCharacterEntity(
            id = id,
            name = "",
            createdAt = now,
            updatedAt = now,
            // 新角色按 V2 建：它是当前跨端共同支持的导出格式
            cardSpecVersion = "chara_card_v2",
        )

        fun stringListOf(json: String?): List<String> =
            com.qingyu.companion.local.domain.JsonValues.parseArray(json).filterIsInstance<String>()

        private fun encodeStringList(values: List<String>): String =
            org.json.JSONArray(values).toString()
    }
}

/**
 * 内嵌世界书 → canonical v2 文档的桥接。
 *
 * 真正的多格式导入在 `content/lorebook` 里（S5-02）；本桥接的存在只是为了让
 * 角色导入不依赖那一层的完成顺序——它把 `character_book` 原文交给世界书导入器，
 * 导入器缺席时返回 null，角色导入仍然成功（内嵌世界书属于「可延后补齐」而不是「必需」）。
 */
object LorebookImportBridge {
    /** 由世界书层在启动时注入，避免内容层与角色层相互直接依赖造成环。 */
    var canonicalizer: ((embeddedJson: String, id: String, name: String, now: Long) -> String?)? = null

    fun canonicalJsonOf(embeddedJson: String, id: String, name: String, now: Long): String? =
        canonicalizer?.invoke(embeddedJson, id, name, now)
}
