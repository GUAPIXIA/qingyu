package com.qingyu.companion.ui.quickreplies

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.chatcore.ChatMacros
import com.qingyu.companion.content.QuickReplyCodec
import com.qingyu.companion.content.QuickReplyPolicy
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.local.db.LocalQuickReplySetEntity
import com.qingyu.companion.local.domain.BindingImpact
import com.qingyu.companion.model.QuickReply
import com.qingyu.companion.model.QuickReplyAction
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.QyEmptyState
import com.qingyu.companion.ui.components.QyErrorBanner
import com.qingyu.companion.ui.components.SettingsChoiceRow
import com.qingyu.companion.ui.content.DeleteImpactDialog
import com.qingyu.companion.ui.content.EditorActionBar
import com.qingyu.companion.ui.content.EditorFormBody
import com.qingyu.companion.ui.content.EditorNote
import com.qingyu.companion.ui.content.EditorNumberField
import com.qingyu.companion.ui.content.EditorSection
import com.qingyu.companion.ui.content.EditorSwitchRow
import com.qingyu.companion.ui.content.EditorTextField
import com.qingyu.companion.ui.content.rememberCreateDocumentPicker
import com.qingyu.companion.ui.content.rememberEditorExitGuard
import com.qingyu.companion.ui.content.rememberMultiDocumentPicker
import com.qingyu.companion.ui.content.writeDocument

/**
 * 阶段 5 S5-06：快捷回复。
 *
 * 三层结构（集合列表 → 集合内条目 → 单条条目）是数据形状决定的：
 * 同步侧是「整库一个实体」，编辑侧是「一个集合一行、一行里一串条目」，
 * 而条目又是唯一进 payload 的部分。把这三层压平就会丢掉「哪一次改动产生哪一条 journal」。
 *
 * 命令型条目的可用性一律由 [QuickReplyPolicy] 决定并在界面上**写明原因**——
 * 方案原话是「平台专用命令显示禁用原因」。按钮亮着点了没反应，
 * 用户只能靠猜区分「没生效」和「本机压根没这个功能」。
 */
@Composable
fun QuickRepliesScreen(onBack: () -> Unit) {
    // 容器必须在组合期取出：viewModelInitializer 运行在组合之外，
    // 在那里读 CompositionLocal 只会拿到默认值（表现为页面永远拿不到数据源）
    val appContainer = LocalAppContainer.current
    val context = LocalContext.current
    val vm: QuickReplyEditorViewModel = viewModel(factory = viewModelFactory {
        initializer { QuickReplyEditorViewModel(appContainer.localSyncRepository, appContainer.contentDraftStore) }
    })

    val list by vm.list.collectAsStateWithLifecycle()
    val editor by vm.set.collectAsStateWithLifecycle()
    var exportNote by remember { mutableStateOf<String?>(null) }
    var showCharacterPicker by remember { mutableStateOf(false) }

    val pickJson = rememberMultiDocumentPicker(mimeTypes = JSON_MIME_TYPES) { documents ->
        vm.importStore(documents)
    }
    val createJson = rememberCreateDocumentPicker(mimeType = "application/json") { uri ->
        // 导出内容在回调里现取：launcher 只能在组合期创建，而字节要到点击后才生成
        val failure = writeDocument(context, uri, vm.exportStoreJson())
        exportNote = failure ?: "已导出整库（与 PC quickReplies.json 同格式）"
    }

    if (editor.draft != null) {
        QuickReplySetPage(vm = vm, list = list, editor = editor, onBack = vm::clearSetEditor)
        return
    }

    Scaffold(
        topBar = {
            AppTopBar(
                title = "快捷回复",
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { vm.startCreateSet(null) },
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("新建全局集合") },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            list.error?.let { QyErrorBanner(message = it, onRetry = vm::refresh) }
            exportNote?.let { EditorNote(it) }
            list.importReport?.let { ImportReportBlock(it) }
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            ) {
                TextButton(onClick = { pickJson() }, enabled = !list.busy) {
                    Text(if (list.busy) "导入中…" else "导入 JSON")
                }
                TextButton(onClick = { createJson(EXPORT_FILE_NAME) }) { Text("导出 JSON") }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = { showCharacterPicker = true }) { Text("为角色新建") }
            }
            EditorNote(
                "集合只是本机的分组：同步与聊天只认条目数组（PC 没有集合概念），" +
                    "所以集合名称、启用位都不会传给对端。",
            )
            if (list.sets.isEmpty() && !list.loading) {
                QyEmptyState(
                    title = "还没有快捷回复",
                    description = "一键发送问候语、动作或触发指令，支持宏展开（{{time}} / {{random:…}} 等）",
                )
            } else {
                LazyColumn(contentPadding = PaddingValues(vertical = 8.dp), modifier = Modifier.fillMaxWidth()) {
                    buildGroups(list, vm).forEach { group ->
                        item(key = "g-${group.characterId ?: "global"}") {
                            GroupHeader(
                                title = group.title,
                                subtitle = group.subtitle,
                                onClear = group.characterId?.let { id -> { vm.inspectClearCharacter(id) } },
                            )
                        }
                        items(group.sets, key = { it.id }) { row ->
                            SetRow(
                                row = row,
                                itemCount = QuickReplyCodec.decodeItems(row.itemsJson).size,
                                onEdit = { vm.startEditSet(row.id) },
                                onCopy = { vm.startDuplicateSet(row.id) },
                                onDelete = { vm.inspectDeleteSet(row.id) },
                                onMoveUp = { vm.moveSet(row.id, up = true) },
                                onMoveDown = { vm.moveSet(row.id, up = false) },
                            )
                        }
                    }
                }
            }
        }
    }

    if (showCharacterPicker) {
        PickListDialog(
            title = "为哪个角色新建集合",
            entries = list.characters.map { character -> character.id to character.name.ifBlank { character.id } },
            emptyText = "本机还没有角色；先在角色管理里创建",
            onSelect = { id ->
                vm.startCreateSet(id)
                showCharacterPicker = false
            },
            onDismiss = { showCharacterPicker = false },
        )
    }

    editor.deletePreview?.let { preview ->
        // DeleteImpactDialog 的引用计数按「被谁引用」口径；集合不被别的数据引用，
        // 真实影响（条目数、角色级删除标记）走 extraWarning，别把它塞进计数里骗人
        DeleteImpactDialog(
            itemName = preview.setName,
            impact = BindingImpact(characters = 0, sessions = 0),
            extraWarning = buildString {
                append("包含 ${preview.itemCount} 条快捷回复，删除后聊天面板立即不再显示它们。")
                if (preview.lastSetForCharacter) {
                    append("这是该角色最后一个集合：仓储会另记一条角色级删除标记，防止长期离线的设备把它带回。")
                }
            },
            onConfirm = { vm.confirmDeleteSet(preview.setId) },
            onDismiss = vm::clearDeletePreview,
        )
    }

    editor.clearPreview?.let { preview ->
        AlertDialog(
            onDismissRequest = vm::clearClearPreview,
            title = { Text("清空「${preview.characterName}」的快捷回复？") },
            text = {
                Text(
                    "共 ${preview.setCount} 个集合、${preview.itemCount} 条条目。" +
                        "全局集合不受影响。该操作会重算整库变更并为这个角色记一条删除标记，" +
                        "同步后其它设备上这个角色的专属快捷回复也会被移除。",
                )
            },
            confirmButton = {
                TextButton(onClick = { vm.confirmClearCharacter(preview.characterId) }) {
                    Text("清空", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = vm::clearClearPreview) { Text("取消") } },
        )
    }
}

@Composable
private fun ImportReportBlock(report: QuickReplyEditorViewModel.ImportReport) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        EditorNote(
            "导入完成：成功 ${report.imported} 条，写入 ${report.setsWritten} 个集合，" +
                "跳过 ${report.skipped.size} 条，失败 ${report.failed.size} 条，" +
                "近似映射 ${report.approximated.size} 条，未知字段保留 ${report.preserved.size} 条",
        )
        report.failed.forEach { EditorNote("失败：$it", isError = true) }
        report.skipped.forEach { EditorNote("跳过：$it") }
        report.approximated.forEach { EditorNote("近似映射：$it") }
        report.preserved.forEach { EditorNote(it) }
    }
}

@Composable
private fun GroupHeader(title: String, subtitle: String?, onClear: (() -> Unit)?) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            if (subtitle != null) {
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (onClear != null) TextButton(onClick = onClear) { Text("清空") }
    }
}

@Composable
private fun SetRow(
    row: LocalQuickReplySetEntity,
    itemCount: Int,
    onEdit: () -> Unit,
    onCopy: () -> Unit,
    onDelete: () -> Unit,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(row.name.ifBlank { "(未命名集合)" }, style = MaterialTheme.typography.bodyLarge)
            Text(
                buildString {
                    append("$itemCount 条条目")
                    append(" · 顺序 ${row.sortIndex}")
                    if (!row.enabled) append(" · 本机已停用（不影响同步）")
                    row.importedFrom?.let { append(" · 导入自 $it") }
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        IconButton(onClick = onMoveUp) { Icon(Icons.Filled.KeyboardArrowUp, contentDescription = "上移集合") }
        IconButton(onClick = onMoveDown) { Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "下移集合") }
        IconButton(onClick = onEdit) { Icon(Icons.Filled.Edit, contentDescription = "编辑集合") }
        IconButton(onClick = onCopy) { Icon(Icons.Filled.ContentCopy, contentDescription = "复制集合") }
        IconButton(onClick = onDelete) { Icon(Icons.Filled.Delete, contentDescription = "删除集合") }
    }
}

/** 集合编辑页：条目增删改序都只动草稿，保存才是一次业务写。 */
@Composable
private fun QuickReplySetPage(
    vm: QuickReplyEditorViewModel,
    list: QuickReplyEditorViewModel.ListState,
    editor: QuickReplyEditorViewModel.SetState,
    onBack: () -> Unit,
) {
    val draft = editor.draft ?: return
    val body = draft.draft
    val row = body.row
    // 离开确认（方案 §2）：与其余五个编辑器共用同一份判定，避免三条出口里漏接一条
    val exit = rememberEditorExitGuard(
        dirty = draft.dirty,
        onSaveAndClose = vm::saveSet,
        onDiscardAndClose = vm::discardDraftAndClose,
        onLeave = onBack,
    )
    val requestClose: () -> Unit = exit.requestLeave
    val items = vm.displayItems(body.items)

    if (editor.editingItemId != null) {
        val item = body.items.firstOrNull { it.id == editor.editingItemId }
        if (item != null) {
            QuickReplyItemPage(
                vm = vm,
                list = list,
                item = item,
                draft = body,
                onBack = vm::finishItemEdit,
            )
            return
        }
    }

    Scaffold(
        topBar = {
            AppTopBar(
                title = if (editor.isNew) "新建集合" else "编辑集合",
                subtitle = vm.characterName(row.characterId) ?: "全局（所有角色可用）",
                navigationIcon = {
                    IconButton(onClick = requestClose) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            editor.error?.let { QyErrorBanner(message = it, onRetry = null) }
            EditorFormBody {
                EditorSection("集合") {
                    EditorTextField(
                        value = row.name,
                        onValueChange = { value -> vm.editRow { it.copy(name = value) } },
                        label = "集合名称",
                        helper = "只在本机显示；同步给 PC 的只有条目数组",
                    )
                    EditorNumberField(
                        value = row.sortIndex.toDouble(),
                        onValueChange = { value -> vm.editRow { it.copy(sortIndex = value.toInt()) } },
                        label = "集合顺序",
                        range = 0.0..9999.0,
                        integerOnly = true,
                        helper = "决定条目在整库数组里的展开顺序（这一顺序会进同步 payload）",
                    )
                    EditorNote(
                        "归属：${vm.characterName(row.characterId) ?: "全局"}。创建后不能改归属——" +
                            "换角色等于换一个集合，PC 侧的角色级删除标记会失去对应关系。",
                    )
                }

                EditorSection("条目（${items.size} 条）") {
                    Button(onClick = vm::addItem, modifier = Modifier.fillMaxWidth()) { Text("添加条目") }
                    if (items.isEmpty()) {
                        EditorNote("还没有条目。文本型条目点击后作为用户消息发出，命令型按 Android 支持表判定可用性。")
                    }
                    items.forEach { entry ->
                        ItemRow(
                            vm = vm,
                            draft = body,
                            item = entry,
                            onEdit = { vm.startItemEdit(entry.id) },
                            onMoveUp = { vm.moveItem(entry.id, up = true) },
                            onMoveDown = { vm.moveItem(entry.id, up = false) },
                            onToggle = { enabled -> vm.updateItem(entry.id) { it.copy(enabled = enabled) } },
                            onDelete = { vm.removeItem(entry.id) },
                        )
                    }
                }
            }

            EditorActionBar(
                dirty = draft.dirty,
                busy = editor.busy,
                onSave = { vm.saveSet() },
                onCancel = requestClose,
            )
            if (editor.draftRestored) {
                // 恢复出来的内容必须说明来源，否则用户会以为库里已经是这样
                EditorNote("已恢复上次未保存的草稿（尚未保存为一次变更）")
            }
            Spacer(Modifier.height(24.dp))
        }
    }

}

@Composable
private fun ItemRow(
    vm: QuickReplyEditorViewModel,
    draft: QuickReplyEditorViewModel.SetDraft,
    item: QuickReply,
    onEdit: () -> Unit,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
    onToggle: (Boolean) -> Unit,
    onDelete: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
        ) {
            Column(Modifier.weight(1f)) {
                Text(item.label.ifBlank { "(未命名条目)" }, style = MaterialTheme.typography.bodyLarge)
                Text(
                    buildString {
                        append(QuickReplyEditorViewModel.ACTION_LABELS.getValue(item.action))
                        append(" · order ${item.order}")
                        vm.hotkeyOf(draft, item.id)?.let { append(" · Ctrl+$it") }
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (item.action == QuickReplyAction.text && item.content.isNotBlank()) {
                    Text(
                        item.content,
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            IconButton(onClick = onMoveUp) { Icon(Icons.Filled.KeyboardArrowUp, contentDescription = "上移条目") }
            IconButton(onClick = onMoveDown) { Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "下移条目") }
            IconButton(onClick = onEdit) { Icon(Icons.Filled.Edit, contentDescription = "编辑条目") }
            IconButton(onClick = onDelete) { Icon(Icons.Filled.Delete, contentDescription = "删除条目") }
        }
        EditorSwitchRow(checked = item.enabled, onCheckedChange = onToggle, label = "启用")
        AvailabilityLine(item)
        // 区分「PC 有、Android 不消费」与「两端都不认识的键」：
        // 前者是保真要求，后者多半是导入来的脏数据，混成一句会把人误导
        val preserved = vm.preservedKeysOf(draft, item.id)
        if (preserved.isNotEmpty()) {
            val kept = preserved.filter { QuickReplyEditorViewModel.PRESERVED_ONLY.contains(it) }
            val unknown = preserved - kept.toSet()
            if (kept.isNotEmpty()) EditorNote("保留的 PC 字段：${kept.joinToString()}（Android 不生效，导出时原样回写）")
            if (unknown.isNotEmpty()) EditorNote("未识别的键：${unknown.joinToString()}（同样原样保留）")
        }
    }
}

/**
 * 可用性一栏：[QuickReplyPolicy.resolve] 的四种结果都要有对应说法。
 *
 * 禁用态**必须**渲染成禁用按钮 + 原因文本：这是方案 S5-06 的硬要求，
 * 也让「/imagine 依赖本机 ComfyUI/SD，阶段 6」这类信息在编辑时就能看见，
 * 而不是等到聊天面板里按了才发现没反应。
 */
@Composable
private fun AvailabilityLine(item: QuickReply) {
    when (val action = QuickReplyPolicy.resolve(item)) {
        is QuickReplyPolicy.Action.Disabled -> {
            OutlinedButton(onClick = { }, enabled = false, modifier = Modifier.padding(vertical = 2.dp)) {
                Text(item.label.ifBlank { "该快捷回复" })
            }
            EditorNote("不可用：${action.reason}", isError = true)
        }

        is QuickReplyPolicy.Action.RunCommand -> {
            val args = if (action.parsed.args.isEmpty()) "" else " · ${action.parsed.args.size} 个参数"
            EditorNote("可执行命令：${action.parsed.raw}（/${action.parsed.name}$args）")
        }

        is QuickReplyPolicy.Action.SwitchPreset -> EditorNote("点击后切换到预设 ${action.presetId}")
        is QuickReplyPolicy.Action.InsertText -> EditorNote(
            if (action.sendWithAi) "点击后发送文本并触发 AI 回复" else "点击后仅发送文本，不触发 AI 回复",
        )
    }
}

@Composable
private fun QuickReplyItemPage(
    vm: QuickReplyEditorViewModel,
    list: QuickReplyEditorViewModel.ListState,
    item: QuickReply,
    draft: QuickReplyEditorViewModel.SetDraft,
    onBack: () -> Unit,
) {
    val macros = remember { ChatMacros.listMacros() }
    val presetOptions = remember(list.presets, item.presetId) {
        listOf(item.presetId ?: "") + list.presets.map { it.id }
    }
    val presetLabels = remember(list.presets) {
        list.presets.associateBy({ it.id }) { it.name.ifBlank { it.id } }
    }
    val commandDecision = QuickReplyPolicy.decideCommand(item.command)

    Scaffold(
        topBar = {
            AppTopBar(
                title = "编辑条目",
                subtitle = item.label.ifBlank { "(未命名条目)" },
                navigationIcon = {
                    IconButton(onClick = vm::cancelItemEdit) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    TextButton(onClick = onBack) { Text("完成", color = MaterialTheme.colorScheme.primary) }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            EditorFormBody {
                EditorSection("基本") {
                    EditorTextField(
                        value = item.label,
                        onValueChange = { value -> vm.updateItem(item.id) { it.copy(label = value) } },
                        label = "按钮名称",
                        helper = "聊天面板上显示的文字；留空在列表里显示为「(未命名条目)」",
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        QuickReplyAction.entries.forEach { action ->
                            FilterChip(
                                selected = item.action == action,
                                onClick = { vm.updateItem(item.id) { it.copy(action = action) } },
                                label = { Text(QuickReplyEditorViewModel.ACTION_LABELS.getValue(action)) },
                            )
                        }
                    }
                }

                when (item.action) {
                    QuickReplyAction.text -> {
                        EditorSection("发送内容") {
                            EditorTextField(
                                value = item.content,
                                onValueChange = { value -> vm.updateItem(item.id) { it.copy(content = value) } },
                                label = "文本（支持宏）",
                                minLines = 4,
                                helper = "宏在发送前展开，与 PC 同一套解析（{{char}} / {{time}} / {{random:A|B}}）",
                            )
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                macros.take(MACRO_CHIPS).forEach { macro ->
                                    FilterChip(
                                        selected = false,
                                        onClick = {
                                            vm.updateItem(item.id) { it.copy(content = it.content + "{{${macro.name}}}") }
                                        },
                                        label = { Text("{{${macro.name}}}", style = MaterialTheme.typography.labelSmall) },
                                    )
                                }
                            }
                            EditorNote(
                                "点宏名即在末尾插入占位符；需要参数的宏要自己补全，例如 random 写成 " +
                                    "{{random:选项A|选项B}}。本机共 ${macros.size} 个宏，这里放前 " +
                                    "${minOf(macros.size, MACRO_CHIPS)} 个。",
                            )
                            EditorSwitchRow(
                                checked = item.sendWithAI,
                                onCheckedChange = { value -> vm.updateItem(item.id) { it.copy(sendWithAI = value) } },
                                label = "发送后触发 AI 回复",
                                description = "关闭即「仅发送这条消息」，与 PC 的同名开关一致",
                            )
                        }
                    }

                    QuickReplyAction.preset -> {
                        EditorSection("目标预设") {
                            SettingsChoiceRow(
                                title = "切换到哪个预设",
                                selected = item.presetId ?: "",
                                options = presetOptions.distinct(),
                                labelOf = { id -> if (id.isEmpty()) "（未选择）" else presetLabels[id] ?: "已删除的预设 $id" },
                                onSelect = { id ->
                                    vm.updateItem(item.id) { it.copy(presetId = id.ifEmpty { null }) }
                                },
                            )
                            EditorNote(
                                "目标：" + (vm.presetName(item.presetId) ?: "未设置") +
                                    "（ID ${item.presetId ?: "无"}）。导入来的 ID 在本机不存在时显示为原始 ID，" +
                                    "点击只会切换失败——把它改成存在的预设再保存。",
                            )
                        }
                    }

                    QuickReplyAction.command -> {
                        EditorSection("命令") {
                            EditorTextField(
                                value = item.command.orEmpty(),
                                onValueChange = { value -> vm.updateItem(item.id) { it.copy(command = value) } },
                                label = "命令文本（含 /）",
                                helper = "例：/continue、/swipe、/imagine 一只猫",
                                error = if (item.command.isNullOrBlank()) "命令型条目必须填命令文本" else null,
                            )
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                QuickReplyPolicy.selectableCommands.forEach { name ->
                                    FilterChip(
                                        selected = QuickReplyPolicy.parseCommand(item.command.orEmpty())?.name == name,
                                        onClick = { vm.updateItem(item.id) { it.copy(command = "/$name") } },
                                        label = { Text("/$name", style = MaterialTheme.typography.labelSmall) },
                                    )
                                }
                            }
                            EditorNote(
                                "Android 支持 ${QuickReplyPolicy.selectableCommands.size} 条命令：" +
                                    QuickReplyPolicy.selectableCommands.joinToString("、") { "/$it" },
                            )
                            EditorNote(
                                "[${commandDecision.support}] ${commandDecision.reason}" +
                                    (commandDecision.scheduledFor?.let { "；计划 $it" } ?: ""),
                                isError = commandDecision.support != QuickReplyPolicy.CommandSupport.SUPPORTED,
                            )
                        }
                    }
                }

                EditorSection("快捷键与顺序") {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        QuickReplyEditorViewModel.HOTKEY_SLOTS.forEach { slot ->
                            val current = vm.hotkeyOf(draft, item.id)
                            FilterChip(
                                selected = current == slot,
                                onClick = { vm.setHotkey(item.id, slot) },
                                label = { Text(slot?.let { "Ctrl+$it" } ?: "无", style = MaterialTheme.typography.labelSmall) },
                            )
                        }
                    }
                    EditorNote(
                        "hotkey 是 PC 字段：Android 只保真回写，不在本机绑定按键。" +
                            "不选即为「无」，会删除该键而不是写 null（与 PC 序列化一致）。",
                    )
                    EditorNumberField(
                        value = item.order.toDouble(),
                        onValueChange = { value -> vm.updateItem(item.id) { it.copy(order = value.toInt()) } },
                        label = "排序（order）",
                        range = -9999.0..9999.0,
                        integerOnly = true,
                        helper = "聊天面板按这一位排序（全局与角色条目混排）",
                    )
                }

                EditorSection("启用") {
                    EditorSwitchRow(
                        checked = item.enabled,
                        onCheckedChange = { value -> vm.updateItem(item.id) { it.copy(enabled = value) } },
                        label = "启用这条快捷回复",
                        description = "停用后聊天面板不再显示它；这里显示的是保存前的预览",
                    )
                }

                EditorSection("点击后会发生什么") {
                    AvailabilityLine(item)
                }
            }

            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            ) {
                TextButton(onClick = vm::cancelItemEdit) { Text("放弃本条修改", color = MaterialTheme.colorScheme.error) }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = onBack) { Text("完成") }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

/** 分组视图：全局在前，角色级按角色表顺序，最后是本机已无此角色的集合（可见才能被删）。 */
private fun buildGroups(
    list: QuickReplyEditorViewModel.ListState,
    vm: QuickReplyEditorViewModel,
): List<SetGroup> {
    val known = list.characters.map { it.id }.toSet()
    val out = ArrayList<SetGroup>()
    out += SetGroup(
        characterId = null,
        title = "全局集合（所有角色可用）",
        subtitle = null,
        sets = vm.displaySets(list.sets.filter { it.characterId == null }),
    )
    list.characters.forEach { character ->
        val rows = list.sets.filter { it.characterId == character.id }
        if (rows.isNotEmpty()) {
            out += SetGroup(
                characterId = character.id,
                title = character.name.ifBlank { character.id },
                subtitle = "角色专属",
                sets = vm.displaySets(rows),
            )
        }
    }
    list.sets.filter { row -> row.characterId?.let { it !in known } == true }.groupBy { it.characterId }.forEach { (id, rows) ->
        out += SetGroup(
            characterId = id,
            title = "已删除的角色 ${id?.take(8) ?: ""}",
            subtitle = "这些集合不属于本机任何角色，建议删除",
            sets = vm.displaySets(rows),
        )
    }
    return out
}

private data class SetGroup(
    val characterId: String?,
    val title: String,
    val subtitle: String?,
    val sets: List<LocalQuickReplySetEntity>,
)

@Composable
private fun PickListDialog(
    title: String,
    entries: List<Pair<String, String>>,
    emptyText: String,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            if (entries.isEmpty()) {
                Text(emptyText)
            } else {
                LazyColumn(modifier = Modifier.fillMaxWidth()) {
                    items(entries, key = { it.first }) { (id, label) ->
                        TextButton(onClick = { onSelect(id) }, modifier = Modifier.fillMaxWidth()) {
                            Text(label, modifier = Modifier.fillMaxWidth())
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

private const val EXPORT_FILE_NAME = "quick-replies.json"
private const val MACRO_CHIPS = 12
private val JSON_MIME_TYPES = arrayOf("application/json", "text/plain")
