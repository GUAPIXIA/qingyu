package com.qingyu.companion.ui.lorebooks

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.chatcore.ChatLorebookChannels
import com.qingyu.companion.chatcore.ChatLorebookCompile
import com.qingyu.companion.chatcore.ChatLorebookRuntime
import com.qingyu.companion.chatcore.Ulid
import com.qingyu.companion.content.lorebook.CanonicalLoreEntry
import com.qingyu.companion.content.lorebook.CanonicalLorebook
import com.qingyu.companion.content.lorebook.LorebookCompatibilityAction
import com.qingyu.companion.content.lorebook.LorebookCompatibilityIssue
import com.qingyu.companion.content.lorebook.LorebookCompatibilityReport
import com.qingyu.companion.content.lorebook.LorebookCompatibilitySeverity
import com.qingyu.companion.content.lorebook.LorebookCompatibilityStatus
import com.qingyu.companion.content.lorebook.LorebookDefaults
import com.qingyu.companion.content.lorebook.LorebookFormatAdapter
import com.qingyu.companion.content.lorebook.LorebookImportExport
import com.qingyu.companion.content.lorebook.LorebookInsertion
import com.qingyu.companion.content.lorebook.LorebookJson
import com.qingyu.companion.content.lorebook.LorebookMappingAction
import com.qingyu.companion.content.lorebook.LorebookMappingImportResult
import com.qingyu.companion.content.lorebook.LorebookMappingSeverity
import com.qingyu.companion.content.lorebook.LorebookMappingTemplates
import com.qingyu.companion.content.lorebook.LorebookNativeMigration
import com.qingyu.companion.content.lorebook.LorebookScheduling
import com.qingyu.companion.content.lorebook.LorebookValidation
import com.qingyu.companion.local.db.LocalLorebookEntity
import com.qingyu.companion.local.db.LocalLorebookMappingTemplateEntity
import com.qingyu.companion.local.domain.BindingImpact
import com.qingyu.companion.local.domain.JsonValues
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.data.ContentDraftStore
import com.qingyu.companion.ui.content.ContentDraftAutosaver
import com.qingyu.companion.ui.content.ContentDraftCodec
import com.qingyu.companion.ui.content.EditorDraft
import com.qingyu.companion.ui.content.PickedDocument
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 阶段 5 S5-02：世界书列表 + canonical v2 编辑器 + 导入导出 + 触发测试台的状态层。
 *
 * ## 单一真值是 `canonical_json`
 * 行上的 `name/scanDepth/tokenBudget/schemaVersion/importedFrom` 都只是文档的**投影**，
 * 保存时由 [projectOf] 从文档整体重算。同步 payload 就是 `canonical_json` 去掉 `id`
 * （`EntityPayloads.lorebookPayload`），列不参与跨端比对，但「列说一套、文档说另一套」
 * 会让本机列表与生成路径读到不同的深度/预算。因此这里不为条目另建表、也不另存一份 JSON。
 *
 * ## 一次用户保存 = 一次业务写（方案 §2）
 * 键入只改内存草稿；[save] 才调用一次 `putLorebook`（Repository 内同事务写 journal）。
 * 每次键入落库会把同一实体推成成百上千个版本，同步端全部判为并发修改。
 *
 * ## revision 的算法照抄 PC `lorebookDocumentStore`
 * 「磁盘上已是合法 canonical v2 → +1」，否则（新建、或从 native v1 迁移上来）保持原值。
 * 这不是内部记账：revision 在 payload 里，两端算法不一致会让同一本书在两机上算出不同的
 * 内容哈希，首次同步就产生伪冲突。
 *
 * ## 打开损坏文档时拒绝编辑，而不是给一份空文档
 * 用空文档顶上去，用户点一次保存就把原内容抹了——那是不可恢复的数据丢失。
 * 所以解析/迁移失败一律停在列表并如实报错。
 */
class LorebookEditorViewModel(
    private val store: LocalStore,
    drafts: ContentDraftStore,
) : ViewModel() {

    /** 草稿区（§2）：世界书正文是一整篇 canonical JSON，丢一篇比丢一个字段疼得多。 */
    private val draftArea = ContentDraftAutosaver(
        store = drafts,
        kind = DRAFT_KIND,
        encode = ContentDraftCodec::encodeLorebook,
        decode = ContentDraftCodec::decodeLorebook,
        // 草稿被容量判定拒绝时必须说出来：静默不写会让用户以为退出还能接着写
        onSkipped = { note -> _editor.update { it.copy(error = note) } }
    )

    // ------------------------------------------------------------------ 列表状态

    /**
     * 列表状态。
     *
     * 方案 §2「大型列表分页/搜索在数据库层执行」：查询词与页长都下推到 SQL
     * （`LocalStore.searchLorebooks` + `countLorebooks`，与角色列表同一形状）。
     * [rows] 就是**当前页**，[total] 是同口径总数。早先那版是全表读进来再 filter——
     * 世界书一本正文是 MiB 级，压力口径（100 本）下等于把整个文档树读进进程。
     */
    data class ListState(
        val rows: List<LocalLorebookEntity> = emptyList(),
        val query: String = "",
        /** 与当前查询同口径的总数（页码用它，不是 rows.size）。 */
        val total: Int = 0,
        val loading: Boolean = false,
        val busy: Boolean = false,
        val error: String? = null,
        /**
         * 动作级提示（解绑失败、模板缺失等），与页面级 [error] 分开：
         * [refresh] 会清掉 error，混在一起会让一次删除的告警在下一次刷新时凭空消失。
         */
        val actionNote: String? = null,
        val summary: ImportSummary? = null,
        val report: ReportView? = null,
        /** 等待用户指定格式后重导的那一份文件（见 [PendingFile]）。 */
        val pending: PendingFile? = null,
        val templates: List<LocalLorebookMappingTemplateEntity> = emptyList(),
        val pendingDelete: PendingDelete? = null,
    ) {
        /** 还有下一页吗：由 SQL 侧总数与本页长度算，不靠「这次少给了几条」猜。 */
        val hasMore: Boolean get() = rows.size < total
    }

    /** 删除确认所需的一行数据（影响范围来自数据库计数，不是猜的）。 */
    data class PendingDelete(val lorebookId: String, val name: String, val impact: BindingImpact)

    /**
     * 待重导文件。
     *
     * 只保留**一份**：批量导入里同时出现多份歧义文件是罕见情况，而把 N 份原文
     * （单文件上限 20 MiB）长期挂在 ViewModel 状态里是明确的内存风险。
     * 其余文件用户重选一次即可。
     */
    data class PendingFile(val displayName: String, val text: String, val replacesLorebookId: String?)

    /** 兼容性报告的展示载体（导入与导出共用同一个对话框）。 */
    data class ReportView(
        val title: String,
        val subtitle: String,
        val report: LorebookCompatibilityReport,
        /** 非空表示这份报告背后还有一份可以「改选格式重导」的文件。 */
        val pending: PendingFile?,
    )

    /** 单个文件的导入结局。 */
    data class FileOutcome(
        val displayName: String,
        val lorebookId: String?,
        val bookName: String,
        val verdict: Verdict,
        val adapterLabel: String,
        val reason: String?,
        val report: LorebookCompatibilityReport?,
        val ambiguous: Boolean,
        /**
         * 检索通道差异（S5-02 收口）。
         *
         * 兼容性报告与 PC 逐字节相同，加不进这一条（见 [ChatLorebookChannels] 类注释），
         * 所以它单独成字段、走界面提示。null 表示这本书没有任何通道差异。
         */
        val channelNote: String? = null,
    ) {
        enum class Verdict { IMPORTED, APPROXIMATED, FAILED }
    }

    /**
     * 一批导入的汇总（方案 §2：导入必须显示成功、跳过、近似映射、失败与未知字段保留）。
     *
     * 计数全部从 [outcomes]/[skipped] 现算而不各存一份整数：分开存会出现
     * 「列表三条、标题写两个」这种永远对不上的报告，而用户正是靠这份报告决定要不要重试。
     */
    data class ImportSummary(val outcomes: List<FileOutcome>, val skipped: List<String>) {
        val imported: Int get() = outcomes.count { it.verdict == FileOutcome.Verdict.IMPORTED }
        val approximated: Int get() = outcomes.count { it.verdict == FileOutcome.Verdict.APPROXIMATED }
        val failed: Int get() = outcomes.count { it.verdict == FileOutcome.Verdict.FAILED }

        /** 未知字段保留说明（`action == preserved` 的 issue）。 */
        val preservedNotes: List<String>
            get() = outcomes.flatMap { outcome ->
                outcome.report?.issues
                    ?.filter { it.action == LorebookCompatibilityAction.PRESERVED }
                    ?.map { "${outcome.bookName} ${it.path}：${it.message}" }
                    .orEmpty()
            }

        /**
         * 检索通道差异说明（Android 侧读数，不进 PC 那份兼容性报告）。
         *
         * 这是「本机能触发什么」里唯一此前**完全无声**的一类：
         * 世界书绑定了、导入成功了、报告也是绿的，但其中若干条目因为要求语义/词法通道
         * 而在这台设备上永不注入（或与 PC 行为相反）。用户不看这一行就无从知道。
         */
        val channelNotes: List<String>
            get() = outcomes.mapNotNull { outcome ->
                outcome.channelNote?.let { "${outcome.bookName}：$it" }
            }
    }

    // ------------------------------------------------------------------ 编辑状态

    data class EditorState(
        val lorebookId: String? = null,
        /** 这次打开的是草稿区里未保存的内容：界面必须说明白来源。 */
        val draftRestored: Boolean = false,
        /** 标题用：新建的草稿存一次就变成已存在的书，但标题不该跟着跳。 */
        val isNewDraft: Boolean = false,
        val draft: EditorDraft<LocalLorebookEntity>? = null,
        /** 正在编辑的 canonical 文档；与 `draft.draft.canonicalJson` 同步（见 [applyDocument]）。 */
        val document: CanonicalLorebook? = null,
        /** 磁盘上原本是合法 canonical v2（决定 revision 是否 +1，与 PC 同规则）。 */
        val hadValidV2OnDisk: Boolean = false,
        /** 正在编辑的条目下标；null 表示停在书级表单。 */
        val entryIndex: Int? = null,
        val error: String? = null,
        val saved: Boolean = false,
        val busy: Boolean = false,
        val revision: Int = 0,
        /** 绑定这本书的角色名（只读展示；删除时会一并解绑）。 */
        val boundCharacters: List<String> = emptyList(),
        /** 本机所有角色名，供条目的「角色过滤」当候选。 */
        val characterNames: List<String> = emptyList(),
        val test: TriggerTest? = null,
    ) {
        val entries: List<CanonicalLoreEntry> get() = document?.entries ?: emptyList()
    }

    /** 条目命中结果（测试台的一行）。 */
    data class TriggeredEntry(
        val entryId: String,
        val label: String,
        val keywords: List<String>,
        val bucket: String,
        val preview: String,
    )

    /**
     * 触发测试台的结论。
     *
     * 判定完全来自 [ChatLorebookRuntime]（生成时用的同一个执行器），这里只做展示映射。
     * 自己再写一份关键词匹配就会有两套触发口径——那正是本项目按 P0 处理的漂移类型。
     */
    data class TriggerTest(
        val sample: String,
        val generationType: String,
        val characterName: String,
        val triggered: List<TriggeredEntry>,
        val keptCount: Int,
        val totalEntries: Int,
        val note: String?,
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
            val needle = _list.value.query.trim()
            val result = runCatching {
                Triple(
                    store.searchLorebooks(needle, PAGE_SIZE, 0),
                    store.countLorebooks(needle),
                    store.listLorebookMappingTemplates().filter { it.enabled },
                )
            }
            result.fold(
                onSuccess = { (rows, total, templates) ->
                    _list.update {
                        it.copy(rows = rows, total = total, templates = templates, loading = false)
                    }
                },
                onFailure = { error ->
                    _list.update { it.copy(loading = false, error = error.message ?: "加载世界书失败") }
                },
            )
        }
    }

    /**
     * 追加下一页。
     *
     * 偏移量就是当前已显示条数；中途导入/删除之后必须先 `refresh()`（它回到第一页），
     * 不能在旧偏移上续页，否则会跳过或重复插入。
     */
    fun loadMore() {
        val state = _list.value
        if (state.loading || !state.hasMore) return
        viewModelScope.launch {
            _list.update { it.copy(loading = true, error = null) }
            runCatching { store.searchLorebooks(state.query.trim(), PAGE_SIZE, state.rows.size) }.fold(
                onSuccess = { more ->
                    _list.update { it.copy(rows = it.rows + more, loading = false) }
                },
                onFailure = { error ->
                    _list.update { it.copy(loading = false, error = error.message ?: "加载世界书失败") }
                },
            )
        }
    }

    fun onQueryChange(query: String) {
        // 查询词一变就要重问数据库：内存里这一页与新词无关
        _list.update { it.copy(query = query) }
        refresh()
    }

    fun dismissImportSummary() {
        _list.update { it.copy(summary = null) }
    }

    fun dismissActionNote() {
        _list.update { it.copy(actionNote = null) }
    }

    fun dismissReport() {
        _list.update { it.copy(report = null, pending = null) }
    }

    /**
     * 主动查看某一份已导入文件的完整报告。
     *
     * 汇总卡片只显示一行结论；方案 §2 要求的是「显示报告」，所以每条结局都要能点开看，
     * 而不是只在失败时才给用户看一次。
     */
    fun showReport(displayName: String) {
        val outcome = _list.value.summary?.outcomes?.firstOrNull { it.displayName == displayName } ?: return
        val report = outcome.report ?: return
        _list.update {
            it.copy(
                report = ReportView(
                    title = "兼容性报告",
                    subtitle = "「${outcome.displayName}」→《${outcome.bookName}》 · ${outcome.adapterLabel}",
                    report = report,
                    pending = it.pending?.takeIf { file -> file.displayName == outcome.displayName },
                ),
            )
        }
    }

    // ------------------------------------------------------------ 新建 / 打开

    fun startCreate() {
        val now = System.currentTimeMillis()
        val id = Ulid.newId()
        val document = emptyDocument(id, now)
        _editor.update {
            EditorState(
                isNewDraft = true,
                draft = EditorDraft(projectOf(newRow(id, now), document, now)),
                document = document,
            )
        }
        // 新建态用固定键找草稿：新文档的 id 还没落库，按 id 找等于永远找不到
        viewModelScope.launch {
            restoreDraftIntoNew(id, now)
            loadBindings(id)
        }
    }

    fun startEdit(id: String) {
        viewModelScope.launch {
            val row = store.getLorebook(id) ?: return@launch
            val parsed = LorebookJson.parse(row.canonicalJson)
            if (parsed == null) {
                _list.update { it.copy(error = "「${row.name}」的文档无法解析，已拒绝打开（保存会覆盖原内容）") }
                return@launch
            }
            // 迁移失败即拒绝进入编辑器：见类注释「打开损坏文档时拒绝编辑」
            val migrated = runCatching { migrate(parsed) }
            if (migrated.isFailure) {
                _list.update {
                    it.copy(error = "「${row.name}」无法读成 canonical v2：${migrated.exceptionOrNull()?.message}")
                }
                return@launch
            }
            val draft = draftArea.restore(id)?.takeIf { it != row }
            val base = draft ?: row
            val baseParsed = if (draft != null) LorebookJson.parse(base.canonicalJson) else parsed
            val baseDocument = if (draft != null) {
                runCatching { migrate(baseParsed ?: return@launch) }.getOrElse {
                    // 草稿解析不出来时退回库里的版本，别把编辑器锁死
                    _list.update { it.copy(error = "未保存草稿无法解析，已改用库里的版本") }
                    migrated.getOrThrow()
                }
            } else {
                migrated.getOrThrow()
            }
            _editor.update {
                EditorState(
                    lorebookId = id,
                    draft = EditorDraft(base),
                    document = baseDocument,
                    hadValidV2OnDisk = LorebookValidation.isCanonicalV2(baseParsed ?: parsed),
                    draftRestored = draft != null,
                )
            }
            loadBindings(id)
        }
    }

    /** 绑定这本书的角色名 + 全部角色名（条目角色过滤的候选）。 */
    private suspend fun loadBindings(id: String) {
        val characters = runCatching { store.listCharacters() }.getOrDefault(emptyList())
        _editor.update { state ->
            state.copy(
                characterNames = characters.map { it.name }.filter { it.isNotBlank() }.distinct(),
                boundCharacters = characters.filter { character ->
                    character.lorebookId == id || stringListOf(character.boundLorebookIdsJson).contains(id)
                }.map { it.name },
            )
        }
    }

    fun clearEditor() {
        // 只是关页面：草稿留在草稿区。明确放弃由 [discardDraftAndClose] 负责。
        _editor.update { EditorState() }
    }

    /** 草稿区的键：已落库的书按 id，没落库的新书共用一把键。 */
    private fun draftKey(): String = _editor.value.lorebookId ?: NEW_DRAFT_KEY

    /** 新建态恢复草稿：解析成功才用，解析不了就当没有（坏草稿不该挡住编辑器）。 */
    private suspend fun restoreDraftIntoNew(id: String, now: Long) {
        val restored = draftArea.restore(NEW_DRAFT_KEY) ?: return
        val parsed = LorebookJson.parse(restored.canonicalJson) ?: return
        val document = runCatching { migrate(parsed) }.getOrNull() ?: return
        // 取草稿是一次 IO：等回来时用户可能已经在写了，那种情况下不能盖掉正在写的内容
        if (_editor.value.draft?.dirty == true) return
        _editor.update {
            it.copy(
                lorebookId = null,
                isNewDraft = true,
                draft = EditorDraft(restored.copy(id = id)),
                document = document,
                draftRestored = true,
            )
        }
    }

    /** 用户在离开确认里选「不保存」：清草稿再关，避免下次进来恢复出一份已被放弃的内容。 */
    fun discardDraftAndClose() {
        val key = draftKey()
        _editor.update { EditorState() }
        viewModelScope.launch {
            draftArea.settle()
            draftArea.discard(key)
        }
    }

    /** 从条目页回到书页。 */
    fun closeEntry() {
        _editor.update { it.copy(entryIndex = null, error = null) }
    }

    fun openEntry(index: Int) {
        _editor.update { state ->
            if (state.document?.entries?.getOrNull(index) == null) state else state.copy(entryIndex = index, error = null)
        }
    }

    // ------------------------------------------------------------ 文档编辑

    /**
     * 把新文档镜像进草稿行。
     *
     * 每次编辑都重新序列化一次，而不是只改内存里的 [EditorState.document]：
     * 那样 `EditorDraft.dirty` 看不见条目级改动，保存会被 `commit` 判成「无变化」而整次丢失
     * （用户表现为「改了十条、点保存、回来发现还是旧的」）。
     */
    private fun applyDocument(next: CanonicalLorebook) {
        val json = next.toJson()
        _editor.update { state ->
            val row = state.draft ?: return@update state
            row.edit { current -> current.copy(name = next.name, canonicalJson = json) }
            state.copy(document = next, revision = state.revision + 1, saved = false)
        }
        // 键入只进草稿区，不碰库也不记账（§2）
        _editor.value.let { state ->
            val row = state.draft?.draft
            val document = state.document
            if (row != null && document != null) {
                draftArea.schedule(viewModelScope, draftKey(), projectOf(row, document, System.currentTimeMillis()))
            }
        }
    }

    /** 书级字段：名称、说明、启用与整本替换。 */
    fun editDocument(transform: (CanonicalLorebook) -> CanonicalLorebook) {
        val current = _editor.value.document ?: return
        applyDocument(transform(current))
    }

    fun editDefaults(transform: (LorebookDefaults) -> LorebookDefaults) {
        val current = _editor.value.document ?: return
        applyDocument(current.copy(defaults = transform(current.defaults)))
    }

    // ------------------------------------------------------------ 条目编辑

    /** 新增一条条目并立刻进入它的编辑页。 */
    fun addEntry() {
        val document = _editor.value.document ?: return
        val index = document.entries.size
        applyDocument(document.copy(entries = document.entries + newEntry(Ulid.newId(), index)))
        _editor.update { it.copy(entryIndex = index) }
    }

    fun duplicateEntry(index: Int) {
        val document = _editor.value.document ?: return
        val source = document.entries.getOrNull(index) ?: return
        val copy = source.copy(
            id = Ulid.newId(),
            scheduling = source.scheduling.copy(order = document.entries.size.toDouble()),
        )
        val entries = document.entries.toMutableList()
        entries.add(index + 1, copy)
        applyDocument(document.copy(entries = entries))
    }

    fun deleteEntry(index: Int) {
        val document = _editor.value.document ?: return
        if (document.entries.getOrNull(index) == null) return
        applyDocument(document.copy(entries = document.entries.filterIndexed { position, _ -> position != index }))
        _editor.update { it.copy(entryIndex = null) }
    }

    /**
     * 条目重排。
     *
     * 换的是文档里条目的**物理顺序**（同时跟着挪编辑焦点），否则用户点了「下移」
     * 会被留在同一个下标上、实际改到了别的条目。
     */
    fun moveEntry(index: Int, up: Boolean) {
        val document = _editor.value.document ?: return
        val target = if (up) index - 1 else index + 1
        if (index < 0 || target < 0 || target >= document.entries.size) return
        val entries = document.entries.toMutableList()
        val moved = entries[index]
        entries[index] = entries[target]
        entries[target] = moved
        applyDocument(document.copy(entries = entries))
        _editor.update { state -> if (state.entryIndex == index) state.copy(entryIndex = target) else state }
    }

    fun editEntry(index: Int, transform: (CanonicalLoreEntry) -> CanonicalLoreEntry) {
        val document = _editor.value.document ?: return
        val current = document.entries.getOrNull(index) ?: return
        val entries = document.entries.toMutableList()
        entries[index] = transform(current)
        applyDocument(document.copy(entries = entries))
    }

    fun toggleEntry(index: Int, enabled: Boolean) {
        editEntry(index) { it.copy(enabled = enabled) }
    }

    // ------------------------------------------------------------ 保存

    /**
     * 保存：校验 → 推进 revision → 一次 `putLorebook`。
     *
     * 校验放在落库前而不是表单上：文档里任何一处枚举值不合法都会让 Android 与 PC
     * 的读取口径分叉（这边读得懂、那边判非法），而这种分叉只有在这里才会被拦住。
     */
    fun save() {
        val state = _editor.value
        val draft = state.draft ?: return
        val document = state.document ?: return
        if (document.name.isBlank()) {
            _editor.update { it.copy(error = "世界书名称不能为空") }
            return
        }
        // 先判 dirty 再做任何草稿写入：把 revision/updatedAt 注进草稿会让
        // 「什么都没改」的保存也变成一次真实业务写（推进版本向量 + 一条空 journal）。
        // 新建的书要放行：从草稿区恢复出来的新文档 dirty 恒为假，
        // 不放行就是「显示已保存、库里没有这一本」。
        if (!draft.dirty && !state.isNewDraft) {
            _editor.update { it.copy(saved = true, error = null) }
            return
        }
        val validation = LorebookValidation.validateCanonicalV2(document.toJsonMap())
        if (!validation.valid) {
            val head = validation.issues.take(4).joinToString("；") { issue -> "${issue.path} ${issue.message}" }
            val tail = if (validation.issues.size > 4) "；另有 ${validation.issues.size - 4} 条" else ""
            _editor.update { it.copy(error = "文档不合法：$head$tail") }
            return
        }
        val now = System.currentTimeMillis()
        val stored = Math.floor(document.revision).toLong().coerceAtLeast(1L)
        val finalDocument = document.copy(
            revision = (if (state.hadValidV2OnDisk) stored + 1L else stored).toDouble(),
            createdAt = document.createdAt.takeIf { it > 0.0 } ?: now.toDouble(),
            updatedAt = now.toDouble(),
        )
        val json = finalDocument.toJson()
        draft.edit { current -> current.copy(name = finalDocument.name, canonicalJson = json) }
        val keyAtSave = draftKey()
        viewModelScope.launch {
            _editor.update { it.copy(busy = true, error = null) }
            val result = runCatching {
                draft.commit(force = state.isNewDraft) { row -> store.putLorebook(projectOf(row, finalDocument, now)) }.also {
                    if (it) {
                        // 落成了业务变更，草稿必须跟着清，否则下次打开会恢复出一份「已保存」的草稿
                        draftArea.settle()
                        draftArea.discard(keyAtSave)
                    }
                }
            }
            result.fold(
                onSuccess = {
                    _editor.update {
                        it.copy(
                            busy = false,
                            saved = true,
                            lorebookId = draft.draft.id,
                            isNewDraft = false,
                            document = finalDocument,
                            hadValidV2OnDisk = true,
                        )
                    }
                    refresh()
                },
                onFailure = { error ->
                    _editor.update { it.copy(busy = false, error = error.message ?: "保存世界书失败") }
                },
            )
        }
    }

    // ------------------------------------------------------------ 删除与影响范围

    fun inspectDelete(id: String) {
        viewModelScope.launch {
            val row = store.getLorebook(id) ?: return@launch
            val impact = runCatching { store.lorebookBindingImpact(id) }.getOrNull() ?: return@launch
            _list.update { it.copy(pendingDelete = PendingDelete(id, row.name, impact)) }
        }
    }

    fun dismissDelete() {
        _list.update { it.copy(pendingDelete = null) }
    }

    /**
     * 删除并解绑引用（方案 §2「有引用的数据先解绑或阻止删除」）。
     *
     * 存储层现在有 [LocalStore.deleteLorebookUnbindingReferences]（同一事务 + 逐行 journal），
     * 但这里**暂时保留逐条写法**，因为它还承担一件存储层版本没做的事：
     * `putSession` 会拒绝「父角色已被 tombstone」的会话，那类引用本身是死引用，
     * 放进单个事务里会让整次删除永久失败。要切到原子版本，得先决定死引用怎么处置（报告 D-6）。
     * 因此顺序刻意是「先解绑、后删书」——中途失败只会留下一本没人引用的世界书（可再删），
     * 而不是留下一堆指向已删除实体的引用。
     */
    fun confirmDelete() {
        val pending = _list.value.pendingDelete ?: return
        val doomed = pending.lorebookId
        viewModelScope.launch {
            _list.update { it.copy(busy = true, error = null) }
            var unbindFailures = 0
            val result = runCatching {
                if (pending.impact.characters > 0) {
                    store.listCharacters().forEach { character ->
                        val before = stringListOf(character.boundLorebookIdsJson)
                        val after = before.filter { it != doomed }
                        val nextSingle = character.lorebookId?.takeIf { it != doomed }
                        if (after == before && nextSingle == character.lorebookId) return@forEach
                        val written = runCatching {
                            store.putCharacter(character.copy(lorebookId = nextSingle, boundLorebookIdsJson = encodeStringList(after)))
                        }.isSuccess
                        if (!written) unbindFailures += 1
                    }
                }
                if (pending.impact.sessions > 0) {
                    store.listSessions().forEach { session ->
                        val before = stringListOf(session.lorebookIdsJson)
                        val after = before.filter { it != doomed }
                        if (after == before) return@forEach
                        // putSession 会拒绝「父角色已被 tombstone」的会话：那类引用本身就是死引用，
                        // 不能让它把整次删除卡住，所以逐条容错并如实计数。
                        val written = runCatching {
                            store.putSession(session.copy(lorebookIdsJson = encodeStringList(after)))
                        }.isSuccess
                        if (!written) unbindFailures += 1
                    }
                }
                store.deleteLorebook(doomed)
            }
            result.onSuccess {
                if (_editor.value.draft?.draft?.id == doomed) clearEditor()
                _list.update { state ->
                    state.copy(
                        busy = false,
                        pendingDelete = null,
                        actionNote = if (unbindFailures == 0) {
                            null
                        } else {
                            "已删除，但 $unbindFailures 处引用解绑失败（父实体已被删除等）：请在对应角色或会话里重新选择世界书。"
                        },
                    )
                }
                refresh()
            }.onFailure { error ->
                _list.update { it.copy(busy = false, pendingDelete = null, error = error.message ?: "删除失败") }
            }
        }
    }

    // ------------------------------------------------------------ 导入

    /**
     * 批量导入（SAF 多选）。
     *
     * 每个文件独立成败：一批里一份损坏是常态，整批回滚会把用户已经拿到的结果带走。
     * 未识别的格式**不猜**：适配器层按置信度阈值拒绝，这里把拒绝原因如实显示，
     * 并留下「指定格式重导」的入口（方案 §6.1「不静默猜测」）。
     */
    fun importDocuments(documents: List<PickedDocument>) {
        if (documents.isEmpty()) return
        viewModelScope.launch {
            _list.update { it.copy(busy = true, error = null, summary = null, report = null, pending = null) }
            val outcomes = ArrayList<FileOutcome>(documents.size)
            val skipped = ArrayList<String>()
            var pending: PendingFile? = null
            for (document in documents) {
                val text = document.bytes.toString(Charsets.UTF_8)
                if (text.isBlank()) {
                    skipped += "${document.displayName}：空文件"
                    continue
                }
                if (LorebookMappingTemplates.isMappingTemplate(LorebookJson.parse(text))) {
                    skipped += "${document.displayName}：这是一份映射模板，请用「按映射模板导入」"
                    continue
                }
                val fallbackName = document.displayName.substringBeforeLast('.').ifBlank { document.displayName }
                val id = Ulid.newId()
                val result = LorebookImportExport.importFromText(
                    text = text,
                    fallbackName = fallbackName,
                    id = id,
                    fileName = document.displayName,
                    extension = document.displayName.substringAfterLast('.', "").takeIf { it != document.displayName },
                )
                when (result) {
                    is LorebookImportExport.Result.Imported -> {
                        val written = runCatching {
                            store.putLorebook(projectOf(newRow(id), result.document, System.currentTimeMillis()))
                        }.isSuccess
                        if (!written) {
                            outcomes += failedOutcome(document.displayName, fallbackName, result.report, "写入本地库失败")
                            continue
                        }
                        val ambiguous = result.report.issues.any { it.code == AMBIGUITY_CODE }
                        outcomes += FileOutcome(
                            displayName = document.displayName,
                            lorebookId = id,
                            bookName = result.document.name,
                            verdict = if (result.report.status == LorebookCompatibilityStatus.APPROXIMATED) {
                                FileOutcome.Verdict.APPROXIMATED
                            } else {
                                FileOutcome.Verdict.IMPORTED
                            },
                            adapterLabel = "${result.report.formatLabel}（${result.detection.confidence}%）",
                            reason = null,
                            report = result.report,
                            ambiguous = ambiguous,
                            channelNote = channelNoteOf(result.document, id),
                        )
                        if (ambiguous) pending = PendingFile(document.displayName, text, replacesLorebookId = id)
                    }

                    is LorebookImportExport.Result.Rejected -> {
                        outcomes += failedOutcome(document.displayName, fallbackName, result.report, result.reason)
                        pending = PendingFile(document.displayName, text, replacesLorebookId = null)
                    }
                }
            }
            val summary = ImportSummary(outcomes, skipped)
            _list.update { state ->
                state.copy(busy = false, summary = summary, pending = pending, report = summary.reportViewFor(pending))
            }
            refresh()
        }
    }

    /**
     * 按映射模板导入（方案 S5-02：首版 Android 只消费 PC/导入产生的模板）。
     *
     * `templateJson` 存的是节点式受限 DSL，`fromDslJson` 对无法无损折叠的节点
     * （`index`/`const`）直接抛错而不是猜——静默丢一条映射比拒绝更糟，用户会以为模板生效了。
     */
    fun importWithTemplate(documents: List<PickedDocument>, templateId: String) {
        if (documents.isEmpty()) return
        viewModelScope.launch {
            val template = store.getLorebookMappingTemplate(templateId)
            if (template == null) {
                _list.update { it.copy(error = "映射模板不存在，请刷新后重试") }
                return@launch
            }
            _list.update { it.copy(busy = true, error = null, summary = null, report = null, pending = null) }
            val outcomes = ArrayList<FileOutcome>(documents.size)
            val skipped = ArrayList<String>()
            for (document in documents) {
                val fallbackName = document.displayName.substringBeforeLast('.').ifBlank { document.displayName }
                val parsed = LorebookJson.parse(document.bytes.toString(Charsets.UTF_8))
                if (parsed == null) {
                    skipped += "${document.displayName}：不是合法 JSON"
                    continue
                }
                val id = Ulid.newId()
                val attempted = runCatching {
                    val mapping = LorebookMappingTemplates.fromDslJson(template.templateJson)
                    val result = LorebookMappingTemplates.importWithTemplate(
                        raw = parsed,
                        template = mapping,
                        id = id,
                        fallbackName = fallbackName,
                        contentHash = LorebookJson.sha256Hex(LorebookJson.stringify(parsed)),
                    )
                    result to result.toReport(template.name)
                }
                if (attempted.isFailure) {
                    outcomes += failedOutcome(
                        document.displayName,
                        fallbackName,
                        null,
                        "模板「${template.name}」无法用于导入：${attempted.exceptionOrNull()?.message}",
                    )
                    continue
                }
                val (result, report) = attempted.getOrThrow()
                if (report.isRejected) {
                    outcomes += FileOutcome(
                        displayName = document.displayName,
                        lorebookId = null,
                        bookName = result.document.name,
                        verdict = FileOutcome.Verdict.FAILED,
                        adapterLabel = "映射模板「${template.name}」",
                        reason = report.issues.firstOrNull { it.severity == LorebookCompatibilitySeverity.ERROR }?.message
                            ?: "映射结果无法导入",
                        report = report,
                        ambiguous = false,
                    )
                    continue
                }
                val written = runCatching {
                    store.putLorebook(projectOf(newRow(id), result.document, System.currentTimeMillis()))
                }.isSuccess
                if (!written) {
                    outcomes += failedOutcome(document.displayName, result.document.name, report, "写入本地库失败")
                    continue
                }
                outcomes += FileOutcome(
                    displayName = document.displayName,
                    lorebookId = id,
                    bookName = result.document.name,
                    verdict = if (report.summary.dropped > 0) {
                        FileOutcome.Verdict.APPROXIMATED
                    } else {
                        FileOutcome.Verdict.IMPORTED
                    },
                    adapterLabel = "映射模板「${template.name}」",
                    reason = null,
                    report = report,
                    ambiguous = false,
                    channelNote = channelNoteOf(result.document, id),
                )
            }
            val summary = ImportSummary(outcomes, skipped)
            _list.update { it.copy(busy = false, summary = summary, report = summary.reportViewFor(null)) }
            refresh()
        }
    }

    /** 歧义或被拒后由用户指定格式重导这一份文件（不静默猜测，但要给出口）。 */
    fun reimportWith(adapterId: String) {
        val pending = _list.value.pending ?: return
        viewModelScope.launch {
            _list.update { it.copy(busy = true, error = null, report = null, pending = null) }
            val replaces = pending.replacesLorebookId
            val id = replaces ?: Ulid.newId()
            val fallbackName = pending.displayName.substringBeforeLast('.').ifBlank { pending.displayName }
            val result = LorebookImportExport.importFromText(
                text = pending.text,
                fallbackName = fallbackName,
                id = id,
                fileName = pending.displayName,
                adapterId = adapterId,
            )
            when (result) {
                is LorebookImportExport.Result.Imported -> {
                    val written = runCatching {
                        store.putLorebook(projectOf(newRow(id), result.document, System.currentTimeMillis()))
                    }.isSuccess
                    _list.update { state ->
                        state.copy(
                            busy = false,
                            summary = state.summary?.withReplacement(pending.displayName, result, id),
                            // 走 actionNote：紧随其后的 refresh 会清掉 error，写在这里才不会一闪而过
                            actionNote = if (written) state.actionNote else "已识别，但写入本地库失败",
                            report = ReportView(
                                title = "已按指定格式导入",
                                subtitle = "「${pending.displayName}」→《${result.document.name}》" +
                                    if (replaces != null) "（覆盖原先那本）" else "（新增一本）",
                                report = result.report,
                                pending = null,
                            ),
                        )
                    }
                }

                is LorebookImportExport.Result.Rejected -> _list.update { state ->
                    state.copy(
                        busy = false,
                        pending = pending,
                        report = ReportView(
                            title = "指定格式后仍无法导入",
                            subtitle = "「${pending.displayName}」：${result.reason}",
                            report = result.report ?: emptyReport(adapterId, result.reason),
                            pending = pending,
                        ),
                    )
                }
            }
            refresh()
        }
    }

    /** 可手动指定的格式（registry 的排序即 PC 的优先级顺序）。 */
    fun selectableFormats(): List<LorebookFormatAdapter> = LorebookImportExport.availableFormats()

    /** 可导出的格式（方案 S5-02「对支持格式导出」；映射向导只进不出，不在其中）。 */
    fun exportableFormats(): List<LorebookFormatAdapter> = LorebookImportExport.exportableFormats()

    // ------------------------------------------------------------ 导出

    /** 导出库里已存的某一本。 */
    suspend fun exportStored(id: String, adapterId: String, target: (ByteArray, String) -> Unit) {
        val row = store.getLorebook(id) ?: return
        val document = migrateOrNull(row.canonicalJson) ?: return
        exportDocument(document, adapterId, row.name, target)
    }

    /** 导出编辑器里的当前草稿（含未保存改动：用户就是想在落库前先看一眼产物）。 */
    suspend fun exportDraft(adapterId: String, target: (ByteArray, String) -> Unit) {
        val document = _editor.value.document ?: return
        exportDocument(document, adapterId, document.name.ifBlank { "世界书" }, target)
    }

    private suspend fun exportDocument(
        document: CanonicalLorebook,
        adapterId: String,
        bookName: String,
        target: (ByteArray, String) -> Unit,
    ) {
        val built = withContext(Dispatchers.Default) {
            LorebookImportExport.exportToText(document = document, adapterId = adapterId, pretty = true)
        }
        when (built) {
            is LorebookImportExport.ExportResult.Exported -> {
                val fileName = "${sanitizeFileName(bookName)}.json"
                _list.update {
                    it.copy(report = ReportView("导出兼容性报告", "「${built.formatLabel}」→ $fileName", built.report, null))
                }
                target(built.json.toByteArray(Charsets.UTF_8), fileName)
            }

            is LorebookImportExport.ExportResult.Unsupported ->
                _list.update { it.copy(error = built.reason) }
        }
    }

    // ------------------------------------------------------------ 触发测试台

    /**
     * 用生成时的同一个执行器回答「这段文本会让哪些条目触发」。
     *
     * 面板按**当前草稿**测试（含未保存改动），否则用户改完关键词要先生成一轮才能验证。
     *
     * 预算刻意给到远大于现实（[TEST_BUDGET_TOKENS]）：面板回答的是「会不会触发」，
     * 不是「挤不挤得进本轮上下文」——后者由会话预设与上下文预算决定，在这里模拟只会给出
     * 一个看起来精确其实无关的数字。随机源固定 0 是为了可复现：同一段文本连点两次结果不同，
     * 用户就没法判断是自己改对了还是运气好；面板上如实写着「概率判定按必然通过处理」。
     */
    fun runTriggerTest(sample: String, generationType: String, characterName: String) {
        val state = _editor.value
        val document = state.document ?: return
        val id = state.draft?.draft?.id ?: return
        if (sample.isBlank()) {
            _editor.update { it.copy(test = null, error = "请输入用于触发测试的文本") }
            return
        }
        viewModelScope.launch {
            val runtime = withContext<ChatLorebookRuntime.Result?>(Dispatchers.Default) {
                val book = ChatLorebookCompile.compile(document.toJson(), id, document.name) ?: return@withContext null
                ChatLorebookRuntime.execute(
                    ChatLorebookRuntime.Input(
                        lorebooks = listOf(book),
                        scanText = sample,
                        scanMessages = listOf(sample),
                        userName = "",
                        charName = characterName,
                        characterNames = listOf(characterName),
                        characterTags = emptyList(),
                        generationType = generationType,
                        messageCount = 1,
                        budget = TEST_BUDGET_TOKENS,
                        model = "",
                        random = { 0.0 },
                    ),
                )
            }
            if (runtime == null) {
                _editor.update { it.copy(test = null, error = "当前文档无法编译成运行时输入，请先修掉非法字段") }
                return@launch
            }
            val triggeredIds = runtime.triggeredEntryKeys.map { key -> key.substringAfter(':') }.toSet()
            val triggered = document.entries.filter { triggeredIds.contains(it.id) }.map { entry ->
                TriggeredEntry(
                    entryId = entry.id,
                    label = entry.title?.takeIf { it.isNotBlank() } ?: "(无标题条目)",
                    keywords = entry.activation.primaryKeys + entry.activation.aliases,
                    bucket = when {
                        entry.activation.mode == "constant" -> "常驻"
                        entry.activation.budgetTier == "supplemental" -> "细节"
                        else -> "条件"
                    },
                    preview = entry.content.replace('\n', ' ').take(60),
                )
            }
            _editor.update {
                it.copy(
                    test = TriggerTest(
                        sample = sample,
                        generationType = generationType,
                        characterName = characterName,
                        triggered = triggered,
                        keptCount = runtime.kept.size,
                        totalEntries = document.entries.size,
                        note = if (triggered.isEmpty()) {
                            "没有条目命中：检查关键词是否出现在文本里、条目是否启用、扫描深度是否为 0。"
                        } else {
                            null
                        },
                    ),
                    error = null,
                )
            }
        }
    }

    fun dismissTriggerTest() {
        _editor.update { it.copy(test = null) }
    }

    // ------------------------------------------------------------ 内部工具

    private fun migrate(input: Any?): CanonicalLorebook = LorebookNativeMigration.migrateToLatest(
        input,
        LorebookNativeMigration.Options(
            now = System.currentTimeMillis().toDouble(),
            contentHash = LorebookJson.sha256Hex(LorebookJson.stringify(input)),
        ),
    )

    private fun migrateOrNull(canonicalJson: String): CanonicalLorebook? =
        runCatching { migrate(LorebookJson.parse(canonicalJson) ?: return null) }.getOrNull()

    /** 文档 → 行投影（列是文档的派生值，不是第二份真相）。 */
    private fun projectOf(row: LocalLorebookEntity, document: CanonicalLorebook, now: Long): LocalLorebookEntity =
        row.copy(
            name = document.name,
            canonicalJson = document.toJson(),
            schemaVersion = CanonicalLorebook.SCHEMA_VERSION,
            scanDepth = document.defaults.scanDepth.toInt(),
            tokenBudget = document.defaults.tokenBudget?.toInt(),
            importedFrom = document.source?.adapterId ?: row.importedFrom,
            updatedAt = now,
        )

    private fun failedOutcome(
        displayName: String,
        bookName: String,
        report: LorebookCompatibilityReport?,
        reason: String,
    ): FileOutcome = FileOutcome(
        displayName = displayName,
        lorebookId = null,
        bookName = bookName,
        verdict = FileOutcome.Verdict.FAILED,
        adapterLabel = report?.formatLabel ?: "未识别",
        reason = reason,
        report = report,
        ambiguous = false,
    )

    /** 重导成功后替换汇总里同一份文件的结局：一份文件只应有一个结论。 */
    private fun ImportSummary.withReplacement(
        displayName: String,
        result: LorebookImportExport.Result.Imported,
        id: String,
    ): ImportSummary = copy(
        outcomes = outcomes.map { outcome ->
            if (outcome.displayName != displayName) {
                outcome
            } else {
                FileOutcome(
                    displayName = displayName,
                    lorebookId = id,
                    bookName = result.document.name,
                    verdict = FileOutcome.Verdict.IMPORTED,
                    adapterLabel = result.report.formatLabel,
                    reason = null,
                    report = result.report,
                    ambiguous = false,
                    channelNote = channelNoteOf(result.document, id),
                )
            }
        },
    )

    /**
     * 检索通道差异读数（S5-02「不静默改变含义」在 Android 侧的落点）。
     *
     * 用**同一条编译路径**（`ChatLorebookCompile`）得到运行时形状的条目再分类，
     * 而不是另写一遍 canonical 解析——否则读数会和真实触发用的条目对不上，
     * 那种「读数说 A、运行做 B」的偏差正是本文件要消灭的东西。
     */
    private fun channelNoteOf(document: CanonicalLorebook, lorebookId: String): String? {
        val book = ChatLorebookCompile.compile(document.toJson(), lorebookId, document.name) ?: return null
        return ChatLorebookChannels.analyze(book).summaryLine()
    }

    /** 挑一份最需要用户处理的文件作为报告（失败优先，其次歧义）；都没问题就不弹框。 */
    private fun ImportSummary.reportViewFor(pending: PendingFile?): ReportView? {
        val failing = outcomes.firstOrNull { it.verdict == FileOutcome.Verdict.FAILED }
        val ambiguous = outcomes.firstOrNull { it.ambiguous }
        val target = failing ?: ambiguous ?: return null
        val report = target.report ?: emptyReport("unknown", target.reason ?: "导入失败")
        return ReportView(
            title = if (failing != null) "导入兼容性报告（有文件被拒绝）" else "导入兼容性报告（格式存在歧义）",
            subtitle = "「${target.displayName}」→《${target.bookName}》· 判定为 ${target.adapterLabel}",
            report = report,
            pending = pending?.takeIf { it.displayName == target.displayName },
        )
    }

    private fun emptyReport(adapterId: String, reason: String): LorebookCompatibilityReport =
        LorebookCompatibilityReport.create(
            adapterId = adapterId,
            formatLabel = adapterId,
            formatVersion = "unknown",
            issues = listOf(
                LorebookCompatibilityIssue.of(
                    LorebookCompatibilitySeverity.ERROR,
                    LorebookCompatibilityAction.REJECTED,
                    "import_rejected",
                    "$",
                    reason,
                ),
            ),
        )

    private fun newRow(id: String, at: Long = System.currentTimeMillis()): LocalLorebookEntity =
        LocalLorebookEntity(id = id, name = "", createdAt = at, updatedAt = at)

    companion object {
        /** 草稿区分区名；新建态共用一把键（见 [NEW_DRAFT_KEY]）。 */
        const val DRAFT_KIND = "lorebook"
        const val NEW_DRAFT_KEY = "new"

        /** registry 在格式歧义时写进报告的 issue code（跨端契约，不能改）。 */
        const val AMBIGUITY_CODE = "ambiguous_format"

        /** 测试台用的宽松预算（见 [runTriggerTest]）。 */
        const val TEST_BUDGET_TOKENS = 200_000

        /** 编辑中一页渲染的条目数上限（见 [LorebookEditorScreen] 的条目列表说明）。 */
        const val ENTRY_PAGE_SIZE = 200

        /** 列表页长（§2 分页）：一次只问数据库要这么多本。 */
        const val PAGE_SIZE = 60

        /**
         * 与 `LorebookValidation` 里那组私有白名单一一对应。
         *
         * 校验的权威出处始终是那一份（这里只负责把选项画出来）；两处万一漂移的后果由
         * [save] 的 `validateCanonicalV2` 兜住——非法值会拒绝落库并点名路径，
         * 而不是静默写进文档让 PC 读出另一种含义。
         */
        val ACTIVATION_MODES = listOf("conditional", "constant")
        val BUDGET_TIERS = listOf("protected", "standard", "supplemental")
        val RETRIEVAL_MODES = listOf("keyword", "semanticPreferred", "semanticRequired", "hybrid")
        val KEY_LOGICS = listOf("any", "all")
        val SECONDARY_LOGICS = listOf("and_any", "and_all", "not_any", "not_all")
        val PROMPT_ANCHORS = listOf(
            "before_character", "after_character", "before_examples", "after_examples",
            "authors_note_top", "authors_note_bottom", "prompt_end",
        )
        val CHAT_ROLES = listOf("system", "user", "assistant")
        val INSERTION_KINDS = listOf("prompt", "chat", "outlet", "custom")
        val GENERATION_TRIGGERS = listOf("normal", "continue", "impersonate", "swipe", "regenerate", "quiet")

        /** 可缺省字段的「显式未设置」选项（比留空更可辨：空串本身是一个合法值）。 */
        const val UNSET = "未设置"

        fun emptyDocument(id: String, now: Long): CanonicalLorebook = CanonicalLorebook(
            id = id,
            revision = 1.0,
            name = "",
            description = "",
            enabled = true,
            defaults = LorebookDefaults(),
            entries = emptyList(),
            createdAt = now.toDouble(),
            updatedAt = now.toDouble(),
        )

        /**
         * 新条目的默认值。
         *
         * 刻意显式给出 `insertion` 锚点：`LorebookInsertion()` 的零值是
         * `kind = "prompt"` 且 `anchor = null`，而 canonical 校验要求 prompt 锚点落在白名单内，
         * 直接用零值构造会让整本文档判非法。选 `before_character` 与运行时条目默认位置一致。
         */
        fun newEntry(id: String, index: Int): CanonicalLoreEntry = CanonicalLoreEntry(
            id = id,
            enabled = true,
            title = "",
            content = "",
            insertion = LorebookInsertion.prompt("before_character"),
            scheduling = LorebookScheduling(order = index.toDouble()),
        )

        fun stringListOf(json: String): List<String> = JsonValues.parseArray(json).filterIsInstance<String>()

        fun sanitizeFileName(name: String): String =
            name.replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1F]"), "_").trim().ifBlank { "lorebook" }

        fun encodeStringList(values: List<String>): String = org.json.JSONArray(values).toString()
    }
}

/**
 * S5-01 的交接点：角色卡内嵌 `character_book` → canonical v2 JSON。
 *
 * `CharacterEditorViewModel.LorebookImportBridge.canonicalizer` 就是为这个形状准备的注入位：
 * 角色导入只需要「文本 → canonical JSON」，落库与绑定由角色侧完成（它拿到的是同一个事务）。
 * 装配点必须在 app 启动时打一行
 * `LorebookImportBridge.canonicalizer = LorebookEmbeddedImport::canonicalJsonOf`，
 * 否则角色卡的内嵌世界书会被静默跳过——不报错、也不建书。
 *
 * 强制走 `character-card.character-book` 适配器（见 [LorebookImportExport.importEmbeddedCharacterBook]）：
 * 卡规范里格式已经写死，再检测一遍会让「一张卡同时像 ST」的输入在两端绑定出不同的书。
 */
object LorebookEmbeddedImport {
    fun canonicalJsonOf(embeddedJson: String, id: String, name: String, now: Long): String? {
        val result = LorebookImportExport.importEmbeddedCharacterBook(
            json = embeddedJson,
            lorebookId = id.takeIf { it.isNotBlank() },
            fallbackName = name.ifBlank { "角色卡世界书" },
            now = now.toDouble(),
        )
        return (result as? LorebookImportExport.Result.Imported)?.document?.toJson()
    }
}

/**
 * 映射向导的结果报告折进通用兼容性报告。
 *
 * 两套 issue 类型是并行移植的产物（映射侧没有 `approximated` 这一档）。对话框只需要一种
 * 模型，所以这里显式转换，而不是在 UI 里写两套分支——两套分支会各自演进成两种导入报告。
 */
internal fun LorebookMappingImportResult.toReport(templateLabel: String): LorebookCompatibilityReport =
    LorebookCompatibilityReport.create(
        adapterId = "lorebook.mapping-template",
        formatLabel = "映射模板「$templateLabel」",
        formatVersion = "dsl",
        issues = issues.map { issue ->
            LorebookCompatibilityIssue.of(
                severity = when (issue.severity) {
                    LorebookMappingSeverity.INFO -> LorebookCompatibilitySeverity.INFO
                    LorebookMappingSeverity.WARNING -> LorebookCompatibilitySeverity.WARNING
                    LorebookMappingSeverity.ERROR -> LorebookCompatibilitySeverity.ERROR
                },
                action = when (issue.action) {
                    LorebookMappingAction.MAPPED -> LorebookCompatibilityAction.MAPPED
                    LorebookMappingAction.PRESERVED -> LorebookCompatibilityAction.PRESERVED
                    LorebookMappingAction.DROPPED -> LorebookCompatibilityAction.DROPPED
                    LorebookMappingAction.REJECTED -> LorebookCompatibilityAction.REJECTED
                },
                code = issue.code,
                path = issue.path,
                message = issue.message,
            )
        },
    )
