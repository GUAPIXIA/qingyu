package com.qingyu.companion.ui.regex

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.chatcore.ChatRegex
import com.qingyu.companion.chatcore.Ulid
import com.qingyu.companion.content.RegexCompatibility
import com.qingyu.companion.local.db.LocalRegexRuleEntity
import com.qingyu.companion.local.domain.JsonValues
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.data.ContentDraftStore
import com.qingyu.companion.ui.content.ContentDraftAutosaver
import com.qingyu.companion.ui.content.ContentDraftCodec
import com.qingyu.companion.ui.content.EditorDraft
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONArray

/**
 * 阶段 5 S5-05：正则规则编辑与测试台。
 *
 * 测试台**必须**走 [RegexCompatibility.matchWithWorkLimit] 而不是直接 `Regex(...)`：
 * 用户正在编辑的模式是半成品，一条 `(a+)+` 会让匹配循环挂死，
 * 而挂死的编辑器比报错糟得多（方案 §S5-05「对灾难性回溯设置执行超时或安全限制」）。
 */
class RegexEditorViewModel(
    private val store: LocalStore,
    drafts: ContentDraftStore,
) : ViewModel() {

    /** 草稿区（§2）：半成品正则只写这里。一条没写完的模式既不该落库也不该记账。 */
    private val draftArea = ContentDraftAutosaver(
        store = drafts,
        kind = DRAFT_KIND,
        encode = ContentDraftCodec::encodeRegexRule,
        decode = ContentDraftCodec::decodeRegexRule,
        // 草稿被容量判定拒绝时必须说出来：静默不写会让用户以为退出还能接着写
        onSkipped = { note -> _editor.update { it.copy(error = note) } }
    )

    data class ListState(
        val rules: List<LocalRegexRuleEntity> = emptyList(),
        val loading: Boolean = false,
        val error: String? = null,
    )

    data class EditorState(
        val ruleId: String? = null,
        /** 打开的是草稿区里未保存的内容：界面要说明来源。 */
        val draftRestored: Boolean = false,
        val draft: EditorDraft<LocalRegexRuleEntity>? = null,
        /** 草稿修订号：见 [edit] */
        val revision: Int = 0,
        val error: String? = null,
        val busy: Boolean = false,
    )

    /** 测试台一次执行的结果。 */
    data class TestRun(
        val input: String,
        val output: String,
        val matched: Boolean,
        /** 工作量计数：让用户看到「这条规则吃了多少功」 */
        val work: Long,
        /** 被预算拦下 */
        val aborted: Boolean,
        val analysis: RegexCompatibility.Analysis,
    )

    private val _list = MutableStateFlow(ListState())
    val list: StateFlow<ListState> = _list.asStateFlow()

    private val _editor = MutableStateFlow(EditorState())
    val editor: StateFlow<EditorState> = _editor.asStateFlow()

    private val _test = MutableStateFlow<TestRun?>(null)
    val test: StateFlow<TestRun?> = _test.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _list.update { it.copy(loading = true, error = null) }
            runCatching { store.listRegexRules() }
                .onSuccess { rows -> _list.update { it.copy(rules = rows, loading = false) } }
                .onFailure { error -> _list.update { it.copy(loading = false, error = error.message) } }
            _list.update { it.copy(loading = false) }
        }
    }

    private fun draftKey(row: LocalRegexRuleEntity): String =
        if (_editor.value.ruleId == null) NEW_DRAFT_KEY else row.id

    fun startCreate() {
        val now = System.currentTimeMillis()
        val nextOrder = (_list.value.rules.maxOfOrNull { it.sortIndex } ?: -1) + 1
        _editor.update {
            EditorState(
                draft = EditorDraft(
                    LocalRegexRuleEntity(
                        id = Ulid.newId(),
                        name = "",
                        pattern = "",
                        sortIndex = nextOrder,
                        createdAt = now,
                        updatedAt = now,
                    ),
                ),
            )
        }
        // 没落库的新行共用一把键：按随机 id 存就永远找不回来
        viewModelScope.launch {
            val restored = draftArea.restore(NEW_DRAFT_KEY) ?: return@launch
            // IO 回来时用户可能已经在写了：别拿旧草稿盖掉正在写的内容
            if (_editor.value.draft?.dirty == true) return@launch
            _editor.update { it.copy(draft = EditorDraft(restored), draftRestored = true) }
        }
    }

    fun startEdit(id: String) {
        viewModelScope.launch {
            val row = store.getRegexRule(id) ?: return@launch
            val draft = draftArea.restore(id)?.takeIf { it != row }
            _editor.update {
                EditorState(ruleId = id, draft = EditorDraft(draft ?: row), draftRestored = draft != null)
            }
            _test.value = null
        }
    }

    fun clearEditor() {
        // 只关页面：草稿留在草稿区，进程被杀也能接上
        _editor.update { EditorState() }
        _test.value = null
    }

    /** 离开确认里选「不保存」：这时候才真的清草稿。 */
    fun discardDraftAndClose() {
        val key = _editor.value.ruleId ?: NEW_DRAFT_KEY
        clearEditor()
        viewModelScope.launch {
            draftArea.settle()
            draftArea.discard(key)
        }
    }

    fun edit(transform: (LocalRegexRuleEntity) -> LocalRegexRuleEntity) {
        // 草稿原地可变，StateFlow 按引用去重：不推进 revision 就不会重组
        var edited: LocalRegexRuleEntity? = null
        _editor.update { state ->
            state.draft?.edit(transform)
            edited = state.draft?.draft
            state.copy(revision = state.revision + 1)
        }
        // 键入只进草稿区
        edited?.let { draftArea.schedule(viewModelScope, draftKey(it), it) }
        _test.value = null
    }

    fun save() {
        val draft = _editor.value.draft ?: return
        val savedKey = draftKey(draft.draft)
        // 新建规则强制落一次：从草稿区恢复出来的半成品 dirty 恒为假，
        // 而「半成品」恰恰是草稿区最主要的用途——那条没写完的模式必须能存下来。
        val isNewRow = _editor.value.ruleId == null
        viewModelScope.launch {
            _editor.update { it.copy(busy = true, error = null) }
            val result = runCatching {
                draft.commit(force = isNewRow) { row ->
                    store.putRegexRule(row.copy(updatedAt = System.currentTimeMillis()))
                }
            }
            result.fold(
                onSuccess = {
                    draftArea.settle()
                    savedKey?.let { draftArea.discard(it) }
                    _editor.update { EditorState() }
                    refresh()
                },
                onFailure = { error -> _editor.update { it.copy(busy = false, error = error.message ?: "保存失败") } },
            )
        }
    }

    fun delete(id: String) {
        viewModelScope.launch {
            runCatching { store.deleteRegexRule(id) }
                .onSuccess { refresh() }
                .onFailure { error -> _list.update { it.copy(error = error.message ?: "删除失败") } }
        }
    }

    /**
     * 列表里直接开关一条规则。
     *
     * 不复用 `startEdit + edit`：那条路径只会把改动留在草稿里，
     * 用户以为已经关掉了规则，实际什么都没写进去（列表看起来「关着」，一刷新又亮回来）。
     */
    fun toggleEnabled(id: String, enabled: Boolean) {
        viewModelScope.launch {
            val row = store.getRegexRule(id) ?: return@launch
            if (row.enabled == enabled) return@launch
            runCatching { store.putRegexRule(row.copy(enabled = enabled, updatedAt = System.currentTimeMillis())) }
                .onSuccess { refresh() }
                .onFailure { error -> _list.update { it.copy(error = error.message ?: "更新失败") } }
        }
    }

    /** 上移/下移：整表顺序是一次业务写，每条被改动的规则各进一条 journal。 */
    fun move(id: String, up: Boolean) {
        viewModelScope.launch {
            val ordered = _list.value.rules.sortedBy { it.sortIndex }.toMutableList()
            val index = ordered.indexOfFirst { it.id == id }
            if (index < 0) return@launch
            val target = if (up) index - 1 else index + 1
            if (target < 0 || target >= ordered.size) return@launch
            val tmp = ordered[index]
            ordered[index] = ordered[target]
            ordered[target] = tmp
            runCatching { store.reorderRegexRules(ordered.map { it.id }) }
                .onSuccess { refresh() }
                .onFailure { error -> _list.update { it.copy(error = error.message ?: "排序失败") } }
        }
    }

    // ------------------------------------------------------------ 测试台

    /**
     * 用当前草稿跑一遍测试。
     *
     * 先做静态分析再执行：`compiles=false` 时不必进入匹配；
     * 高风险模式仍然执行，但要带着预算跑，并把中止原因显示出来
     * ——「超时」与「没匹配上」必须分开呈现，否则用户会以为规则写错了。
     */
    fun runTest(input: String, scope: String, stage: String) {
        val row = _editor.value.draft?.draft ?: return
        val analysis = RegexCompatibility.analyze(row.pattern, row.flags, row.sourceFormat.ifBlank { "javascript" })
        if (!analysis.compiles) {
            _test.value = TestRun(input, input, matched = false, work = 0, aborted = false, analysis = analysis)
            return
        }
        val outcome = RegexCompatibility.matchWithWorkLimit(row.pattern, row.flags, input)
        if (outcome is RegexCompatibility.MatchOutcome.Aborted) {
            _test.value = TestRun(
                input = input,
                output = input,
                matched = false,
                work = outcome.work,
                aborted = true,
                analysis = analysis,
            )
            return
        }
        val matched = (outcome as? RegexCompatibility.MatchOutcome.Completed)?.matched == true
        // 复用真正的执行引擎，而不是在测试台里另写一份替换逻辑：
        // 两份实现漂移会让「测试台说会改」而实际发送时不改。
        val rule = ChatRegex.Rule(
            id = row.id,
            name = row.name,
            pattern = row.pattern,
            replacement = row.replacement,
            flags = row.flags,
            // 强制 enabled：测试台要预览「这条规则会怎么改」，
            // 而引擎会跳过未启用规则 —— 否则刚写好还没勾上的规则永远显示「无变化」。
            enabled = true,
            scope = row.scope,
            group = row.group,
            stage = row.stage,
            triggerPattern = row.triggerPattern,
            triggerFlags = row.triggerFlags,
            stopStrings = JsonValues.parseArray(row.stopStringsJson).filterIsInstance<String>(),
        )
        val applied = runCatching {
            ChatRegex.applyRegexRules(input, listOf(rule), scope, stage)
        }.getOrNull()
        _test.value = TestRun(
            input = input,
            output = applied?.text ?: input,
            matched = applied?.let { it.matched > 0 } ?: matched,
            work = (outcome as? RegexCompatibility.MatchOutcome.Completed)?.work ?: 0L,
            aborted = false,
            analysis = analysis,
        )
    }

    companion object {
        /** 与 PC `RegexRule.scope` 同枚举。 */
        val SCOPES = listOf("input", "output", "both")
        val STAGES = listOf("text", "markdown")

        fun stopStringsJson(values: List<String>): String = JSONArray(values).toString()

        fun parseStopStrings(json: String): List<String> =
            JsonValues.parseArray(json).filterIsInstance<String>()
    }
}

/** 草稿区分区名与「还没落库的新行」共用的键。 */
private const val DRAFT_KIND = "regex_rule"
private const val NEW_DRAFT_KEY = "new"
