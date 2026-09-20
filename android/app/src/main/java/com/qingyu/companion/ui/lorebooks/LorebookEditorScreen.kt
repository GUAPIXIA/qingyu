package com.qingyu.companion.ui.lorebooks

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.qingyu.companion.content.lorebook.CanonicalLoreEntry
import com.qingyu.companion.content.lorebook.LorebookCharacterFilter
import com.qingyu.companion.content.lorebook.LorebookGroup
import com.qingyu.companion.content.lorebook.LorebookInsertion
import com.qingyu.companion.content.lorebook.LorebookJson
import com.qingyu.companion.content.lorebook.LorebookLimits
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.QyErrorBanner
import com.qingyu.companion.ui.content.EditorActionBar
import com.qingyu.companion.ui.content.EditorCheckboxRow
import com.qingyu.companion.ui.content.EditorFormBody
import com.qingyu.companion.ui.content.EditorNote
import com.qingyu.companion.ui.content.EditorNumberField
import com.qingyu.companion.ui.content.EditorSection
import com.qingyu.companion.ui.content.EditorSwitchRow
import com.qingyu.companion.ui.content.EditorTextField
import kotlinx.coroutines.launch
import kotlin.math.floor

/**
 * 阶段 5 S5-02：canonical v2 世界书编辑器（书页 + 条目页 + 触发测试台）。
 *
 * ## 为什么这些字段一个都不藏
 * 方案 §2：「不因移动端屏幕小而隐藏关键高级字段，可放入折叠高级区」。
 * [EditorSection] 的折叠默认是**展开**，所以高级字段是「可以收起」而不是「发现不了」；
 * 真正会改变注入结果的字段（key logic、secondary logic、retrieval、递归、时效、预算档、
 * 包含组、角色过滤）全部留在展开区。唯一收进折叠区的是「绑定与来源」——它是只读元数据，
 * 收起不会让人漏掉一个能改坏数据的开关。
 *
 * ## 条目改动只进草稿
 * 条目页的「完成」只是回书页；只有 [LorebookEditorViewModel.save] 才落库一次（方案 §2）。
 */
@Composable
fun LorebookEditorScreen(
    vm: LorebookEditorViewModel,
    state: LorebookEditorViewModel.EditorState,
    list: LorebookEditorViewModel.ListState,
    onBack: () -> Unit,
    exportTo: (ByteArray, String) -> Unit,
) {
    val index = state.entryIndex
    if (index != null && state.entries.getOrNull(index) != null) {
        LorebookEntryScreen(vm = vm, state = state, index = index)
    } else {
        LorebookBookScreen(vm = vm, state = state, onBack = onBack, exportTo = exportTo)
    }
    // 报告与「指定格式」对话框由当前可见的那一页托管：同一份状态不会同时弹两次
    LorebookReportHost(vm = vm, list = list)
}

// ---------------------------------------------------------------------- 书页

@Composable
private fun LorebookBookScreen(
    vm: LorebookEditorViewModel,
    state: LorebookEditorViewModel.EditorState,
    onBack: () -> Unit,
    exportTo: (ByteArray, String) -> Unit,
) {
    val draft = state.draft ?: return
    val document = state.document ?: return
    val scope = rememberCoroutineScope()
    var confirmDiscard by remember { mutableStateOf(false) }
    var exportMenuOpen by remember { mutableStateOf(false) }
    val requestClose: () -> Unit = { if (draft.dirty) confirmDiscard = true else onBack() }
    // 系统返回键与返回箭头走同一条判断：少接一条就留下「没被问就丢了半篇内容」的路径
    BackHandler(enabled = !confirmDiscard) { requestClose() }

    Scaffold(
        topBar = {
            AppTopBar(
                title = if (state.isNewDraft) "新建世界书" else "编辑世界书",
                subtitle = "${document.entries.size} 条 · 默认深度 ${floor(document.defaults.scanDepth).toInt()}",
                navigationIcon = {
                    IconButton(onClick = requestClose) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            state.error?.let { QyErrorBanner(message = it, onRetry = null) }
            EditorFormBody {
                EditorSection("书信息") {
                    EditorTextField(
                        value = document.name,
                        onValueChange = { value -> vm.editDocument { it.copy(name = value) } },
                        label = "世界书名称",
                        error = if (document.name.isBlank()) "名称不能为空（列表与同步都靠它辨认）" else null,
                    )
                    EditorTextField(
                        value = document.description,
                        onValueChange = { value -> vm.editDocument { it.copy(description = value) } },
                        label = "说明",
                        minLines = 2,
                        helper = "只用于辨认，不注入上下文",
                    )
                    EditorSwitchRow(
                        checked = document.enabled,
                        onCheckedChange = { value -> vm.editDocument { it.copy(enabled = value) } },
                        label = "启用这本书",
                        description = "关闭后不再参与激活；整本文档仍然完整保留",
                    )
                }

                EditorSection("默认值") {
                    IntegerField(
                        label = "默认扫描深度（条）",
                        value = document.defaults.scanDepth,
                        range = 0.0..DEPTH_MAX,
                        helper = "从最近多少条消息里取扫描文本；0 表示只有常驻条目能触发。条目级深度允许低于这个值",
                        onValueChange = { value -> vm.editDefaults { it.copy(scanDepth = value) } },
                    )
                    OptionalIntegerField(
                        label = "全书 token 预算",
                        value = document.defaults.tokenBudget,
                        range = 0.0..BUDGET_MAX,
                        helper = "不设置即不限；设置后按书级预算比例分配全局配额",
                        onValueChange = { value -> vm.editDefaults { it.copy(tokenBudget = value) } },
                    )
                    EditorSwitchRow(
                        checked = document.defaults.recursiveScanning,
                        onCheckedChange = { value -> vm.editDefaults { it.copy(recursiveScanning = value) } },
                        label = "递归扫描",
                        description = "已触发的条目正文再参与下一轮关键词扫描",
                    )
                }

                EntryListSection(vm = vm, state = state)

                EditorSection("触发测试台") {
                    TriggerTestPanel(vm = vm, state = state)
                }

                EditorSection("绑定与来源", collapsedByDefault = true) {
                    EditorNote(
                        if (state.boundCharacters.isEmpty()) {
                            "当前没有角色绑定这本书"
                        } else {
                            "被 ${state.boundCharacters.size} 个角色绑定：" +
                                state.boundCharacters.take(8).joinToString("、") +
                                if (state.boundCharacters.size > 8) " 等" else ""
                        },
                    )
                    val source = document.source
                    if (source == null) {
                        EditorNote("这本书在本机创建，没有导入来源")
                    } else {
                        EditorNote("导入来源：${source.adapterId}")
                        source.originalName?.let { EditorNote("原始文件：$it") }
                        source.formatVersion?.let { EditorNote("原始格式版本：$it") }
                        EditorNote("内容哈希：${source.contentHash.take(12)}")
                    }
                    EditorNote("文档 revision ${floor(document.revision).toInt()}：每次保存 +1，与 PC 同规则（它在同步 payload 里）")
                }
            }

            EditorActionBar(
                dirty = draft.dirty,
                busy = state.busy,
                onSave = { vm.save() },
                onCancel = requestClose,
                saveLabel = "保存世界书",
                trailing = {
                    Box {
                        OutlinedButton(onClick = { exportMenuOpen = true }) { Text("导出") }
                        DropdownMenu(expanded = exportMenuOpen, onDismissRequest = { exportMenuOpen = false }) {
                            vm.exportableFormats().forEach { adapter ->
                                DropdownMenuItem(
                                    text = { Text("${adapter.label} · v${adapter.formatVersion}") },
                                    onClick = {
                                        exportMenuOpen = false
                                        scope.launch { vm.exportDraft(adapter.id) { bytes, name -> exportTo(bytes, name) } }
                                    },
                                )
                            }
                        }
                    }
                },
            )
            if (state.saved) {
                EditorNote(if (draft.dirty) "已保存；之后的改动还在草稿里" else "已保存，没有待写入的改动")
            }
            if (state.draftRestored) {
                // 恢复出来的内容必须说明来源，否则用户会以为库里已经是这样
                EditorNote("已恢复上次未保存的草稿（尚未保存为一次变更）")
            }
            Spacer(Modifier.height(24.dp))
        }
    }

    if (confirmDiscard) {
        AlertDialog(
            onDismissRequest = { confirmDiscard = false },
            title = { Text("有未保存的改动") },
            text = {
                Text(
                    "改动目前只在这份草稿里，还没有产生任何同步变更。" +
                        "放弃会丢掉本次编辑（名称、默认值、条目正文与关键词等）。",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDiscard = false
                        vm.save()
                        onBack()
                    },
                ) { Text("保存并退出") }
            },
            dismissButton = {
                Column {
                    TextButton(
                        onClick = {
                            confirmDiscard = false
                            // 放弃 = 清草稿区再退出：只 clearEditor 会留下恢复不完的草稿
                            vm.discardDraftAndClose()
                            onBack()
                        },
                    ) { Text("放弃改动", color = MaterialTheme.colorScheme.error) }
                    TextButton(onClick = { confirmDiscard = false }) { Text("继续编辑") }
                }
            },
        )
    }
}

/**
 * 条目列表。
 *
 * 一页最多渲染 [LorebookEditorViewModel.ENTRY_PAGE_SIZE] 行：书页整体是 `verticalScroll`
 * 的 Column（不是 LazyColumn，表单里嵌套无限高懒加载会崩），5k 条直接展开会让组合层比
 * 文档本身还重。筛选与截断在 UI 层做，条目的真相仍然只有一份 `canonical_json`。
 * 下标按**原数组**保留（`mapIndexed` 后再筛），否则筛选状态下点删除会删掉别的条目。
 */
@Composable
private fun EntryListSection(vm: LorebookEditorViewModel, state: LorebookEditorViewModel.EditorState) {
    var filter by remember(state.document?.id) { mutableStateOf("") }
    val pageSize = LorebookEditorViewModel.ENTRY_PAGE_SIZE
    EditorSection("条目（${state.entries.size} 条）") {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            EditorTextField(
                value = filter,
                onValueChange = { filter = it },
                label = "按标题、关键词或正文筛选",
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = vm::addEntry) { Icon(Icons.Filled.Add, contentDescription = "新增条目") }
        }
        val needle = filter.trim()
        val matched = state.entries.mapIndexed { index, entry -> index to entry }.filter { (index, entry) ->
            if (needle.isEmpty()) return@filter true
            entry.title.orEmpty().contains(needle, ignoreCase = true) ||
                entry.activation.primaryKeys.any { it.contains(needle, ignoreCase = true) } ||
                entry.content.contains(needle, ignoreCase = true) ||
                index.toString() == needle
        }
        if (matched.isEmpty()) {
            EditorNote(if (state.entries.isEmpty()) "还没有条目" else "没有匹配「$filter」的条目")
        }
        matched.take(pageSize).forEach { (index, entry) ->
            EntryRow(
                index = index,
                entry = entry,
                onEdit = { vm.openEntry(index) },
                onToggle = { enabled -> vm.toggleEntry(index, enabled) },
                onMoveUp = { vm.moveEntry(index, up = true) },
                onMoveDown = { vm.moveEntry(index, up = false) },
                onDelete = { vm.deleteEntry(index) },
            )
        }
        if (matched.size > LorebookEditorViewModel.ENTRY_PAGE_SIZE) {
            EditorNote("只渲染前 ${LorebookEditorViewModel.ENTRY_PAGE_SIZE} 条（共匹配 ${matched.size} 条）；用上面的筛选缩小范围")
        }
    }
}

@Composable
private fun EntryRow(
    index: Int,
    entry: CanonicalLoreEntry,
    onEdit: () -> Unit,
    onToggle: (Boolean) -> Unit,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
    onDelete: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("${index + 1}", style = MaterialTheme.typography.labelSmall, modifier = Modifier.width(28.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    entry.title?.takeIf { it.isNotBlank() } ?: "(无标题条目)",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    (entry.activation.primaryKeys + entry.activation.aliases).take(6).joinToString("、")
                        .ifBlank { "无关键词" },
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            EditorCheckboxRow(checked = entry.enabled, onCheckedChange = onToggle, label = "")
            IconButton(onClick = onMoveUp) { Icon(Icons.Filled.KeyboardArrowUp, contentDescription = "上移") }
            IconButton(onClick = onMoveDown) { Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "下移") }
            IconButton(onClick = onEdit) { Icon(Icons.Filled.Edit, contentDescription = "编辑条目") }
            IconButton(onClick = onDelete) { Icon(Icons.Filled.Delete, contentDescription = "删除条目") }
        }
        HorizontalDivider()
    }
}

// ---------------------------------------------------------------------- 条目页

@Composable
private fun LorebookEntryScreen(
    vm: LorebookEditorViewModel,
    state: LorebookEditorViewModel.EditorState,
    index: Int,
) {
    val draft = state.draft ?: return
    val entry = state.entries.getOrNull(index) ?: return
    val activation = entry.activation
    val insertion = entry.insertion
    val scheduling = entry.scheduling

    Scaffold(
        topBar = {
            AppTopBar(
                title = "条目 ${index + 1}",
                subtitle = entry.title?.takeIf { it.isNotBlank() } ?: "未命名条目",
                navigationIcon = {
                    IconButton(onClick = vm::closeEntry) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "回书页")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            state.error?.let { QyErrorBanner(message = it, onRetry = null) }
            EditorFormBody {
                EditorSection("正文") {
                    EditorSwitchRow(
                        checked = entry.enabled,
                        onCheckedChange = { value -> vm.editEntry(index) { it.copy(enabled = value) } },
                        label = "启用这条条目",
                        description = "未启用的条目不参与扫描，也不会注入",
                    )
                    EditorTextField(
                        value = entry.title.orEmpty(),
                        onValueChange = { value -> vm.editEntry(index) { it.copy(title = value) } },
                        label = "条目标题",
                        helper = "只用于辨认与检索加权，不进正文",
                    )
                    EditorTextField(
                        value = entry.content,
                        onValueChange = { value -> vm.editEntry(index) { it.copy(content = value) } },
                        label = "条目正文",
                        minLines = 6,
                        error = entry.content.takeIf { it.isBlank() }?.let { "正文为空：这条不会注入任何内容" },
                        helper = "{{user}} / {{char}} 会按会话替换；导入时单条上限 ${LorebookLimits.MAX_ENTRY_CONTENT_CHARS} 字符",
                    )
                    EditorTextField(
                        value = entry.summary.orEmpty(),
                        onValueChange = { value -> vm.editEntry(index) { it.copy(summary = value) } },
                        label = "手写摘要",
                        minLines = 2,
                        helper = "预算紧张时代替全文注入",
                    )
                    EditorTextField(
                        value = entry.translation.orEmpty(),
                        onValueChange = { value -> vm.editEntry(index) { it.copy(translation = value) } },
                        label = "译文",
                        minLines = 2,
                        helper = "界面优先显示译文，AI 上下文仍用原文",
                    )
                }

                EditorSection("关键词与匹配") {
                    StringListField(
                        label = "主关键词（每行一个）",
                        value = activation.primaryKeys,
                        helper = "别名与主关键词同权参与触发；命中个数进入相关度",
                        onValueChange = { list -> vm.editEntry(index) { it.copy(activation = it.activation.copy(primaryKeys = list)) } },
                    )
                    StringListField(
                        label = "二级关键词（每行一个）",
                        value = activation.secondaryKeys,
                        helper = "配合下面的 secondary logic 做「且 / 非」过滤",
                        onValueChange = { list -> vm.editEntry(index) { it.copy(activation = it.activation.copy(secondaryKeys = list)) } },
                    )
                    StringListField(
                        label = "别名（每行一个）",
                        value = activation.aliases,
                        helper = "与主关键词同权",
                        onValueChange = { list -> vm.editEntry(index) { it.copy(activation = it.activation.copy(aliases = list)) } },
                    )
                    ChoiceRow(
                        label = "主关键词逻辑 keyLogic",
                        options = LorebookEditorViewModel.KEY_LOGICS,
                        selected = activation.keyLogic,
                        onPick = { value -> vm.editEntry(index) { it.copy(activation = it.activation.copy(keyLogic = value)) } },
                    )
                    ChoiceRow(
                        label = "二级关键词逻辑 secondaryLogic",
                        options = listOf(LorebookEditorViewModel.UNSET) + LorebookEditorViewModel.SECONDARY_LOGICS,
                        selected = activation.secondaryLogic ?: LorebookEditorViewModel.UNSET,
                        onPick = { value ->
                            vm.editEntry(index) {
                                it.copy(
                                    activation = it.activation.copy(
                                        secondaryLogic = value.takeIf { picked -> picked != LorebookEditorViewModel.UNSET },
                                    ),
                                )
                            }
                        },
                    )
                    EditorSwitchRow(
                        checked = activation.caseSensitive,
                        onCheckedChange = { value ->
                            vm.editEntry(index) { it.copy(activation = it.activation.copy(caseSensitive = value)) }
                        },
                        label = "区分大小写",
                    )
                    EditorSwitchRow(
                        checked = activation.wholeWords,
                        onCheckedChange = { value -> vm.editEntry(index) { it.copy(activation = it.activation.copy(wholeWords = value)) } },
                        label = "整词匹配",
                        description = "关闭后子串也算命中（例如 key 能命中 monkey）",
                    )
                }

                EditorSection("正则关键词") {
                    EditorSwitchRow(
                        checked = activation.regex.enabled,
                        onCheckedChange = { value ->
                            vm.editEntry(index) {
                                it.copy(activation = it.activation.copy(regex = it.activation.regex.copy(enabled = value)))
                            }
                        },
                        label = "把关键词当正则处理",
                        description = "开启后主关键词与别名按正则匹配",
                    )
                    val badFlags = activation.regex.flags
                        .takeIf { flags -> flags.isNotEmpty() && !flags.all { flag -> flag in LorebookLimits.REGEX_ALLOWED_FLAGS } }
                    EditorTextField(
                        value = activation.regex.flags,
                        onValueChange = { value ->
                            vm.editEntry(index) {
                                it.copy(activation = it.activation.copy(regex = it.activation.regex.copy(flags = value.trim())))
                            }
                        },
                        label = "正则标志",
                        helper = "只允许 ${LorebookLimits.REGEX_ALLOWED_FLAGS} 的组合；单个关键词长度上限 ${LorebookLimits.MAX_REGEX_PATTERN_LENGTH} 字符",
                        error = badFlags?.let { "含不在白名单里的标志：$it" },
                        enabled = activation.regex.enabled,
                    )
                    EditorNote(
                        if (activation.regex.enabled) {
                            "非法表达式不会崩，但该关键词这一轮不命中——测试台会显示它没触发。"
                        } else {
                            "关闭时关键词按字面量匹配。"
                        },
                    )
                }

                EditorSection("激活方式与检索") {
                    ChoiceRow(
                        label = "激活方式 mode",
                        options = LorebookEditorViewModel.ACTIVATION_MODES,
                        selected = activation.mode,
                        onPick = { value -> vm.editEntry(index) { it.copy(activation = it.activation.copy(mode = value)) } },
                    )
                    ChoiceRow(
                        label = "预算档 budgetTier",
                        options = LorebookEditorViewModel.BUDGET_TIERS,
                        selected = activation.budgetTier,
                        onPick = { value -> vm.editEntry(index) { it.copy(activation = it.activation.copy(budgetTier = value)) } },
                    )
                    ChoiceRow(
                        label = "检索模式 retrieval",
                        options = LorebookEditorViewModel.RETRIEVAL_MODES,
                        selected = activation.retrieval,
                        onPick = { value -> vm.editEntry(index) { it.copy(activation = it.activation.copy(retrieval = value)) } },
                    )
                    EditorNote(
                        "constant = 常驻（无需关键词）；protected / standard / supplemental 决定它在预算里的档位。" +
                            "Android 首版没有 embeddings，也不接 BM25 通道：semanticPreferred / semanticRequired / " +
                            "hybrid 目前只按关键词通道触发（与生成链路同一口径，不是这一页的近似）。",
                    )
                    EditorSwitchRow(
                        checked = scheduling.ignoreBudget,
                        onCheckedChange = { value ->
                            vm.editEntry(index) { it.copy(scheduling = it.scheduling.copy(ignoreBudget = value)) }
                        },
                        label = "不受预算裁剪",
                        description = "用于必须出现在上下文里的条目；开太多会把别条挤光",
                    )
                }

                EditorSection("插入位置") {
                    ChoiceRow(
                        label = "位置类型 kind",
                        options = LorebookEditorViewModel.INSERTION_KINDS,
                        selected = insertion.kind,
                        onPick = { kind -> vm.editEntry(index) { it.copy(insertion = insertionOf(it.insertion, kind)) } },
                    )
                    when (insertion.kind) {
                        "prompt" -> {
                            ChoiceRow(
                                label = "prompt 锚点 anchor",
                                options = LorebookEditorViewModel.PROMPT_ANCHORS,
                                selected = insertion.anchor,
                                onPick = { anchor ->
                                    vm.editEntry(index) { it.copy(insertion = it.insertion.copy(kind = "prompt", anchor = anchor)) }
                                },
                            )
                            // 外部文件可以带着 `kind = prompt` 却没有 anchor 进来（模型宽容读取），
                            // 而 canonical 校验要求锚点落在白名单内：这里如实标出来而不是假装选中了一个
                            insertion.anchor?.takeIf { !LorebookEditorViewModel.PROMPT_ANCHORS.contains(it) }?.let {
                                EditorNote("锚点「$it」不在白名单里，保存会被拒绝；点一个上面的合法值。", isError = true)
                            }
                            if (insertion.anchor == null) {
                                EditorNote("这条还没有 prompt 锚点：保存会被判非法，点一个上面的合法值。", isError = true)
                            }
                        }

                        "chat" -> {
                            IntegerField(
                                label = "对话深度 depth（倒数第几条）",
                                value = insertion.depth ?: 0.0,
                                range = 0.0..DEPTH_MAX,
                                helper = "0 表示最新一条的位置",
                                onValueChange = { value ->
                                    vm.editEntry(index) { it.copy(insertion = it.insertion.copy(kind = "chat", depth = value)) }
                                },
                            )
                            ChoiceRow(
                                label = "消息角色 role",
                                options = listOf(LorebookEditorViewModel.UNSET) + LorebookEditorViewModel.CHAT_ROLES,
                                selected = insertion.role ?: LorebookEditorViewModel.UNSET,
                                onPick = { role ->
                                    vm.editEntry(index) {
                                        it.copy(
                                            insertion = it.insertion.copy(
                                                kind = "chat",
                                                role = role.takeIf { picked -> picked != LorebookEditorViewModel.UNSET },
                                            ),
                                        )
                                    }
                                },
                            )
                        }

                        "outlet" -> EditorTextField(
                            value = insertion.name.orEmpty(),
                            onValueChange = { value ->
                                vm.editEntry(index) { it.copy(insertion = it.insertion.copy(kind = "outlet", name = value)) }
                            },
                            label = "outlet 名称",
                            helper = "生成链路没有原生 outlet 槽位：Android 与 PC 都回退到 prompt 末尾",
                            error = insertion.name?.takeIf { it.isBlank() }?.let { "outlet 名称不能为空" },
                        )

                        else -> CustomInsertionFields(
                            insertion = insertion,
                            onSourceChange = { value ->
                                vm.editEntry(index) { it.copy(insertion = it.insertion.copy(kind = "custom", source = value)) }
                            },
                            onValueText = { text ->
                                val parsed = LorebookJson.parse(text)
                                vm.editEntry(index) {
                                    it.copy(insertion = it.insertion.copy(kind = "custom", value = parsed, hasValue = true))
                                }
                            },
                        )
                    }
                    EditorNote("切换 kind 不会清掉其它字段（canonical 只序列化当前 kind 的字段），切错了可以再切回来。")
                }

                EditorSection("调度") {
                    IntegerField(
                        label = "顺序 order",
                        value = scheduling.order,
                        range = -ORDER_MAX..ORDER_MAX,
                        helper = "同一插入位置内的排序键（升序）",
                        onValueChange = { value -> vm.editEntry(index) { it.copy(scheduling = it.scheduling.copy(order = value)) } },
                    )
                    EditorNumberField(
                        value = scheduling.probability,
                        onValueChange = { value -> vm.editEntry(index) { it.copy(scheduling = it.scheduling.copy(probability = value)) } },
                        label = "触发概率（%）",
                        range = 0.0..100.0,
                        helper = "命中关键词后按该概率放行；测试台把它按必然通过处理",
                    )
                    OptionalIntegerField(
                        label = "条目扫描深度",
                        value = scheduling.scanDepth,
                        range = 0.0..DEPTH_MAX,
                        helper = "不设置就跟随书级默认；设置后可以低于书级默认（不会被抬回去）",
                        onValueChange = { value -> vm.editEntry(index) { it.copy(scheduling = it.scheduling.copy(scanDepth = value)) } },
                    )
                    EditorNote("时效字段会保留并同步；Android 生成链路目前尚未据此保持或抑制触发（见测试台的差异说明）。")
                    OptionalIntegerField(
                        label = "sticky（轮）",
                        value = scheduling.sticky,
                        range = 0.0..DEPTH_MAX,
                        helper = "触发后继续在后续轮次保留的轮数",
                        onValueChange = { value -> vm.editEntry(index) { it.copy(scheduling = it.scheduling.copy(sticky = value)) } },
                    )
                    OptionalIntegerField(
                        label = "cooldown（轮）",
                        value = scheduling.cooldown,
                        range = 0.0..DEPTH_MAX,
                        helper = "触发后抑制若干轮",
                        onValueChange = { value -> vm.editEntry(index) { it.copy(scheduling = it.scheduling.copy(cooldown = value)) } },
                    )
                    OptionalIntegerField(
                        label = "delay（轮）",
                        value = scheduling.delay,
                        range = 0.0..DEPTH_MAX,
                        helper = "命中后延迟若干轮才注入",
                        onValueChange = { value -> vm.editEntry(index) { it.copy(scheduling = it.scheduling.copy(delay = value)) } },
                    )
                }

                EditorSection("递归") {
                    EditorSwitchRow(
                        checked = scheduling.recursion.exclude,
                        onCheckedChange = { value ->
                            vm.editEntry(index) { it.copy(scheduling = it.scheduling.copy(recursion = it.scheduling.recursion.copy(exclude = value))) }
                        },
                        label = "排除递归扫描 exclude",
                        description = "这条的正文不再参与下一轮关键词扫描",
                    )
                    EditorSwitchRow(
                        checked = scheduling.recursion.prevent,
                        onCheckedChange = { value ->
                            vm.editEntry(index) { it.copy(scheduling = it.scheduling.copy(recursion = it.scheduling.recursion.copy(prevent = value))) }
                        },
                        label = "阻止后续递归 prevent",
                        description = "它触发后本轮不再继续递归",
                    )
                    IntegerField(
                        label = "最小递归深度 minDepth",
                        value = scheduling.recursion.minDepth,
                        range = 0.0..DEPTH_MAX,
                        helper = "早于此轮数的对话里不激活这条",
                        onValueChange = { value ->
                            vm.editEntry(index) {
                                it.copy(scheduling = it.scheduling.copy(recursion = it.scheduling.recursion.copy(minDepth = value)))
                            }
                        },
                    )
                }

                GroupsSection(
                    groups = scheduling.groups,
                    groupScoring = scheduling.groupScoring,
                    onGroupScoring = { value ->
                        vm.editEntry(index) { it.copy(scheduling = it.scheduling.copy(groupScoring = value)) }
                    },
                    onGroups = { next -> vm.editEntry(index) { it.copy(scheduling = it.scheduling.copy(groups = next)) } },
                )

                CharacterFilterSection(
                    filter = scheduling.characterFilter,
                    characterNames = state.characterNames,
                    onChange = { next -> vm.editEntry(index) { it.copy(scheduling = it.scheduling.copy(characterFilter = next)) } },
                )

                GenerationTriggersSection(
                    triggers = scheduling.generationTriggers,
                    onChange = { next -> vm.editEntry(index) { it.copy(scheduling = it.scheduling.copy(generationTriggers = next)) } },
                )
            }

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            ) {
                TextButton(onClick = { vm.duplicateEntry(index) }) { Text("复制这条") }
                TextButton(onClick = { vm.deleteEntry(index) }) {
                    Text("删除条目", color = MaterialTheme.colorScheme.error)
                }
                Spacer(Modifier.weight(1f))
                Button(onClick = vm::closeEntry) { Text("完成") }
            }
            EditorNote(
                if (draft.dirty) {
                    "条目改动还在草稿里：回书页点「保存世界书」才落库，整次编辑只产生一条变更。"
                } else {
                    "当前草稿与磁盘一致。"
                },
            )
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun CustomInsertionFields(
    insertion: LorebookInsertion,
    onSourceChange: (String) -> Unit,
    onValueText: (String) -> Unit,
) {
    var valueText by remember(insertion.source, insertion.hasValue) {
        mutableStateOf(LorebookJson.stringify(insertion.value))
    }
    var invalid by remember(insertion.source) { mutableStateOf<String?>(null) }
    EditorTextField(
        value = insertion.source.orEmpty(),
        onValueChange = onSourceChange,
        label = "custom source",
        helper = "自定义槽位标识；Android 与 PC 都会把 custom 回退到 prompt 末尾",
        error = insertion.source?.takeIf { it.isBlank() }?.let { "custom source 不能为空" },
    )
    EditorTextField(
        value = valueText,
        onValueChange = { next ->
            valueText = next
            if (next.trim() == "null" || LorebookJson.parse(next) != null) {
                invalid = null
                onValueText(next)
            } else {
                // 非法 JSON 只报错、不改文档：把半截输入写进 value 会毁掉原始导入的结构
                invalid = "不是合法 JSON，已保留原值"
            }
        },
        label = "custom value（JSON 值）",
        minLines = 3,
        helper = "字符串、数字、对象、数组或 null 都原样往返，不做解释",
        error = invalid,
    )
}

@Composable
private fun GroupsSection(
    groups: List<LorebookGroup>,
    groupScoring: Boolean,
    onGroups: (List<LorebookGroup>) -> Unit,
    onGroupScoring: (Boolean) -> Unit,
) {
    EditorSection("包含组（${groups.size} 个）") {
        EditorSwitchRow(
            checked = groupScoring,
            onCheckedChange = onGroupScoring,
            label = "参与分组的条目参与组级评分",
            description = "Android 生成链路尚未实现组仲裁：同组条目会全部触发而不是按权重择一",
        )
        groups.forEachIndexed { position, group ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                EditorTextField(
                    value = group.name,
                    onValueChange = { value -> onGroups(groups.replaceAt(position) { it.copy(name = value) }) },
                    label = "组名",
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = { onGroups(groups.filterIndexed { i, _ -> i != position }) }) {
                    Icon(Icons.Filled.Delete, contentDescription = "删除这个组")
                }
            }
            EditorNumberField(
                value = group.weight,
                onValueChange = { value -> onGroups(groups.replaceAt(position) { it.copy(weight = value) }) },
                label = "权重",
                range = 0.0..1000.0,
                helper = "canonical 要求权重是非负数（允许小数）；组仲裁在 Android 尚未生效",
            )
            EditorCheckboxRow(
                checked = group.prioritized,
                onCheckedChange = { value -> onGroups(groups.replaceAt(position) { it.copy(prioritized = value) }) },
                label = "优先组",
            )
            HorizontalDivider()
        }
        TextButton(onClick = { onGroups(groups + LorebookGroup(name = "", weight = 0.0, prioritized = false)) }) {
            Text("新增分组")
        }
    }
}

@Composable
private fun CharacterFilterSection(
    filter: LorebookCharacterFilter?,
    characterNames: List<String>,
    onChange: (LorebookCharacterFilter?) -> Unit,
) {
    EditorSection("角色过滤") {
        EditorCheckboxRow(
            checked = filter != null,
            onCheckedChange = { enabled -> onChange(if (enabled) LorebookCharacterFilter() else null) },
            label = "只对部分角色生效",
        )
        if (filter == null) {
            EditorNote("未设置：所有角色都一样触发")
            return@EditorSection
        }
        EditorSwitchRow(
            checked = filter.exclude,
            onCheckedChange = { value -> onChange(filter.copy(exclude = value)) },
            label = "反向：除列出者之外的角色才生效",
        )
        StringListField(
            label = "角色名（每行一个）",
            value = filter.names,
            helper = if (characterNames.isEmpty()) "本机还没有角色可候选" else "候选：${characterNames.take(6).joinToString("、")}",
            onValueChange = { list -> onChange(filter.copy(names = list)) },
        )
        StringListField(
            label = "角色标签（每行一个）",
            value = filter.tags,
            helper = "标签匹配要求会话带上标签；Android 单聊目前不带标签",
            onValueChange = { list -> onChange(filter.copy(tags = list)) },
        )
    }
}

@Composable
private fun GenerationTriggersSection(
    triggers: List<String>?,
    onChange: (List<String>?) -> Unit,
) {
    EditorSection("生成类型过滤") {
        EditorCheckboxRow(
            checked = triggers != null,
            onCheckedChange = { enabled -> onChange(if (enabled) listOf(DEFAULT_TRIGGER) else null) },
            label = "限制生效的生成类型",
        )
        if (triggers == null) {
            EditorNote("未设置：任何生成类型都可以触发")
            return@EditorSection
        }
        MultiChoiceRow(
            label = "生效类型（可多选）",
            options = LorebookEditorViewModel.GENERATION_TRIGGERS,
            selected = triggers,
            onToggle = { value ->
                val next = if (triggers.contains(value)) triggers.filter { it != value } else triggers + value
                // 空数组在运行时等价于「不限制」，与未设置同义：退回 null，而不是留下两种表示法
                onChange(next.takeIf { it.isNotEmpty() })
            },
        )
        TextButton(onClick = { onChange(null) }) { Text("清除限制") }
    }
}

// ---------------------------------------------------------------------- 测试台

/**
 * 触发测试台（方案 S5-02「条目启用、关键词、正则…与 PC 一致」的可验证入口）。
 *
 * 判定来自 [com.qingyu.companion.chatcore.ChatLorebookRuntime]，也就是生成时跑的那一段，
 * 所以这里命中什么、真实触发就是什么。面板上同时把 Android 尚未接入的通道写明，
 * 免得用户把「没命中」当成关键词写错了。
 */
@Composable
private fun TriggerTestPanel(
    vm: LorebookEditorViewModel,
    state: LorebookEditorViewModel.EditorState,
) {
    var sample by remember(state.document?.id) { mutableStateOf("") }
    var characterName by remember(state.document?.id) { mutableStateOf(state.boundCharacters.firstOrNull().orEmpty()) }
    var generationType by remember(state.document?.id) { mutableStateOf(DEFAULT_TRIGGER) }

    EditorTextField(
        value = sample,
        onValueChange = { sample = it },
        label = "模拟文本（当作一条消息）",
        minLines = 3,
        helper = "按当前草稿测试，含未保存改动",
    )
    EditorTextField(
        value = characterName,
        onValueChange = { characterName = it },
        label = "角色名（用于角色过滤与 {{char}}）",
    )
    ChoiceRow(
        label = "生成类型",
        options = LorebookEditorViewModel.GENERATION_TRIGGERS,
        selected = generationType,
        onPick = { generationType = it },
    )
    Button(
        onClick = { vm.runTriggerTest(sample, generationType, characterName) },
        modifier = Modifier.fillMaxWidth(),
    ) { Text("运行测试") }

    val test = state.test
    if (test == null) {
        EditorNote("还没测试。判定用的是生成时的同一个执行器，所以这里的命中与真实触发同一口径。")
        return
    }
    HorizontalDivider(Modifier.padding(vertical = 8.dp))
    TextButton(onClick = vm::dismissTriggerTest) { Text("清除测试结果") }
    EditorNote("输入：${test.sample.take(40)} · 生成类型 ${test.generationType}")
    EditorNote("命中 ${test.triggered.size}/${test.totalEntries} 条（宽松预算下保留 ${test.keptCount} 条）")
    test.note?.let { EditorNote(it) }
    test.triggered.forEach { hit ->
        Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
            Text("${hit.label} · ${hit.bucket}", style = MaterialTheme.typography.bodyMedium)
            Text(
                "关键词：${hit.keywords.take(8).joinToString("、").ifBlank { "常驻，无需关键词" }}",
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (hit.preview.isNotBlank()) {
                Text(hit.preview, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
    EditorNote(
        "与真实生成的已知差异：语义/BM25 通道未接入（纯语义条目不会命中）、" +
            "sticky / cooldown / delay 与包含组仲裁未实现、概率按必然通过处理。",
    )
}

// ---------------------------------------------------------------------- 表单小工具

/**
 * 每行一个值的列表字段。
 *
 * 不用逗号分隔：世界书关键词与正则表达式里逗号是合法字符，按逗号切分会让用户写不进
 * `A, B` 这种关键词，还会把它静默拆成两条（触发结果就此与 PC 分叉）。
 */
@Composable
private fun StringListField(
    label: String,
    value: List<String>,
    onValueChange: (List<String>) -> Unit,
    helper: String? = null,
) {
    EditorTextField(
        value = value.joinToString("\n"),
        onValueChange = { text -> onValueChange(text.lines().map { it.trim() }.filter { it.isNotEmpty() }.distinct()) },
        label = label,
        minLines = 3,
        helper = helper,
    )
}

/** 单选胶囊组：枚举值一律显式点选，下拉里看不见当前值的全集。 */
@Composable
private fun ChoiceRow(
    label: String,
    options: List<String>,
    selected: String?,
    onPick: (String) -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        ) {
            options.forEach { option ->
                FilterChip(
                    selected = selected == option,
                    onClick = { onPick(option) },
                    label = { Text(option) },
                )
            }
        }
    }
}

@Composable
private fun MultiChoiceRow(
    label: String,
    options: List<String>,
    selected: List<String>,
    onToggle: (String) -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        ) {
            options.forEach { option ->
                FilterChip(
                    selected = selected.contains(option),
                    onClick = { onToggle(option) },
                    label = { Text(option) },
                )
            }
        }
    }
}

/**
 * 整数域字段。
 *
 * `floor` 后再交给调用方：canonical 校验要求深度、order、sticky 这类字段是**非负整数**，
 * 让 2.5 进了文档只会在保存时报一句「必须是整数」，用户还得回头找是哪一格填错。
 */
@Composable
private fun IntegerField(
    label: String,
    value: Double,
    range: ClosedFloatingPointRange<Double>,
    onValueChange: (Double) -> Unit,
    helper: String? = null,
) {
    EditorNumberField(
        value = value,
        onValueChange = { next -> onValueChange(floor(next)) },
        label = label,
        range = range,
        helper = helper,
        integerOnly = true,
    )
}

/**
 * 可缺省的整数字段（书级预算、条目深度、sticky / cooldown / delay）。
 *
 * 「没设置」与「设为 0」在 canonical 里是两件事：`0` 会真的生效（预算 0 让整本失效），
 * 缺键才表示跟随默认。单个数字输入框表达不了这两态，所以显式加一个存在性开关。
 */
@Composable
private fun OptionalIntegerField(
    label: String,
    value: Double?,
    range: ClosedFloatingPointRange<Double>,
    onValueChange: (Double?) -> Unit,
    helper: String? = null,
) {
    EditorCheckboxRow(
        checked = value != null,
        onCheckedChange = { enabled -> onValueChange(if (enabled) 0.0 else null) },
        label = "$label（单独设置）",
    )
    val current = value ?: return
    IntegerField(
        label = label,
        value = current,
        range = range,
        helper = helper,
        onValueChange = { next -> onValueChange(next) },
    )
}

/** 位置类型切换：只换 `kind`，并按新 kind 补齐合法默认值（其它字段留着，序列化时不写）。 */
private fun insertionOf(current: LorebookInsertion, kind: String): LorebookInsertion = when (kind) {
    "chat" -> current.copy(kind = "chat", depth = current.depth ?: 0.0)
    "outlet" -> current.copy(kind = "outlet", name = current.name ?: "")
    "custom" -> current.copy(kind = "custom", source = current.source ?: "", hasValue = true)
    else -> current.copy(
        kind = "prompt",
        anchor = current.anchor?.takeIf { LorebookEditorViewModel.PROMPT_ANCHORS.contains(it) }
            ?: LorebookEditorViewModel.PROMPT_ANCHORS.first(),
    )
}

/** 按下标替换列表元素（只读 List 没有 `set`，而 `mapIndexed` 到处重写容易各自漂移）。 */
private fun <T> List<T>.replaceAt(position: Int, transform: (T) -> T): List<T> {
    if (position < 0 || position >= size) return this
    val out = toMutableList()
    out[position] = transform(out[position])
    return out
}

private const val DEPTH_MAX = 500.0
private const val BUDGET_MAX = 262_144.0
private const val ORDER_MAX = 99_999.0
private const val DEFAULT_TRIGGER = "normal"
