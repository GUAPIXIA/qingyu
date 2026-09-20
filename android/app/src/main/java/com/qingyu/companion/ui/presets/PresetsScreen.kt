package com.qingyu.companion.ui.presets

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
import androidx.compose.material3.Button
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.local.db.LocalPresetEntity
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.QyEmptyState
import com.qingyu.companion.ui.components.QyErrorBanner
import com.qingyu.companion.ui.content.DeleteImpactDialog
import com.qingyu.companion.ui.content.EditorActionBar
import com.qingyu.companion.ui.content.EditorFormBody
import com.qingyu.companion.ui.content.EditorNote
import com.qingyu.companion.ui.content.EditorNumberField
import com.qingyu.companion.ui.content.EditorSection
import com.qingyu.companion.ui.content.EditorSwitchRow
import com.qingyu.companion.ui.content.EditorTextField
import com.qingyu.companion.ui.characters.rememberFileExporter
import com.qingyu.companion.ui.content.rememberEditorExitGuard
import com.qingyu.companion.ui.content.rememberMultiDocumentPicker
import kotlinx.coroutines.launch

/**
 * 阶段 5 S5-03：预设列表与编辑页。
 *
 * 内建/用户分成两个区（方案 §S5-03 第一条）。内建预设**只读**：
 * 它属于安装包，就地修改会在下次升级被覆盖，所以编辑它落成用户副本。
 */
@Composable
fun PresetsScreen(onBack: () -> Unit) {
    // 容器必须在组合期取：viewModelInitializer 里读 CompositionLocal 只会拿到默认值
    val appContainer = LocalAppContainer.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var exportNote by remember { mutableStateOf<String?>(null) }
    val exporter = rememberFileExporter { message -> exportNote = message }

    val vm: PresetEditorViewModel = viewModel(factory = viewModelFactory {
        initializer { PresetEditorViewModel(appContainer.localSyncRepository, appContainer.contentDraftStore) }
    })

    val list by vm.list.collectAsStateWithLifecycle()
    val editor by vm.editor.collectAsStateWithLifecycle()
    var pendingExport by remember { mutableStateOf<LocalPresetEntity?>(null) }

    val pickJson = rememberMultiDocumentPicker(mimeTypes = arrayOf("application/json", "text/plain")) { documents ->
        vm.importPresets(documents)
    }

    if (editor.draft != null) {
        PresetEditorPage(vm = vm, editor = editor, onBack = vm::clearEditor)
        return
    }

    Scaffold(
        topBar = {
            AppTopBar(
                title = "预设",
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = vm::startCreate,
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("新建预设") },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            list.error?.let { QyErrorBanner(message = it, onRetry = vm::refresh) }
            exportNote?.let { EditorNote(it) }
            list.importReport?.let { report ->
                // 五类**全部**印出来，包括计数为 0 的那几类：方案 §2 要的是「显示成功、跳过、
                // 近似映射、失败和未知字段保留」。少印一类，用户就分不清「没有这回事」和
                // 「这里没告诉我」。
                EditorNote(
                    "导入完成：成功 ${report.imported} 个，跳过 ${report.skipped.size} 个，" +
                        "近似映射 ${report.approximated.size} 处，失败 ${report.failed.size} 个，" +
                        "未知字段保留 ${report.unsupported.size} 个文件",
                )
                report.skipped.forEach { EditorNote("跳过：$it") }
                report.approximated.forEach { EditorNote("近似映射：$it") }
                report.failed.forEach { EditorNote("失败：$it", isError = true) }
                report.unsupported.forEach { (name, fields) ->
                    EditorNote("「$name」有 ${fields.size} 个 Android 用不到的字段未导入：${fields.take(6).joinToString()}")
                }
            }
            EditorTextField(
                value = list.query,
                onValueChange = vm::onQueryChange,
                label = "搜索我的预设",
                helper = if (list.userTotal > 0) {
                    "已显示 ${list.user.size} / ${list.userTotal}（关键字与分页都在数据库层执行）"
                } else {
                    "按名称或说明搜索（关键字与分页都在数据库层执行）"
                },
                modifier = Modifier.padding(horizontal = 16.dp),
            )
            LazyColumn(contentPadding = PaddingValues(vertical = 8.dp), modifier = Modifier.fillMaxWidth()) {
                item {
                    SectionHeader("内建预设（只读；编辑会另存为副本）")
                }
                items(list.builtin, key = { "b-${it.id}" }) { preset ->
                    PresetRow(
                        preset = preset,
                        onEdit = { vm.startEdit(preset.id) },
                        onDuplicate = { vm.startDuplicate(preset.id) },
                        onDelete = null,
                        onExport = { pendingExport = preset },
                        onToggle = null,
                        onMoveUp = null,
                        onMoveDown = null,
                    )
                }
                item { SectionHeader("我的预设") }
                if (list.user.isEmpty()) {
                    item {
                        QyEmptyState(
                            title = "还没有自己的预设",
                            description = "可以直接新建，或从 PC / 外部 JSON 导入",
                        )
                    }
                }
                items(list.user, key = { "u-${it.id}" }) { preset ->
                    PresetRow(
                        preset = preset,
                        onEdit = { vm.startEdit(preset.id) },
                        onDuplicate = { vm.startDuplicate(preset.id) },
                        onDelete = { vm.inspectDelete(preset.id) },
                        onExport = { pendingExport = preset },
                        onToggle = { enabled -> vm.toggleEnabled(preset.id, enabled) },
                        onMoveUp = { vm.move(preset.id, up = true) },
                        onMoveDown = { vm.move(preset.id, up = false) },
                    )
                }
                if (list.user.size < list.userTotal) {
                    // 分页要看得见还剩多少：只有一个「加载更多」会被当成就这些
                    item(key = "load-more") {
                        TextButton(onClick = vm::loadMoreUser, modifier = Modifier.fillMaxWidth()) {
                            Text("加载更多我的预设（已显示 ${list.user.size} / ${list.userTotal}）")
                        }
                    }
                }
            }
            Button(onClick = { pickJson() }, modifier = Modifier.fillMaxWidth().padding(16.dp)) {
                Text("导入预设 JSON（可多选）")
            }
            Spacer(Modifier.height(80.dp))
        }
    }

    // 删除确认走服务端影响范围：preset 被会话与角色引用时要在弹窗里说清楚会解绑多少
    editor.impact?.let { impact ->
        val targetId = editor.presetId
        val name = (list.user + list.builtin).firstOrNull { it.id == targetId }?.name ?: "该预设"
        DeleteImpactDialog(
            itemName = name,
            impact = impact,
            extraWarning = if (impact.isEmpty) null else "删除会把这些会话/角色上的预设引用清空，不会删除会话本身。",
            onConfirm = {
                if (targetId != null) vm.confirmDelete(targetId)
                vm.clearEditor()
            },
            onDismiss = vm::clearEditor,
        )
    }

    pendingExport?.let { preset ->
        scope.launch {
            val payload = vm.exportPreset(preset.id)
            if (payload == null) {
                exportNote = "导出失败：预设不存在"
            } else {
                exporter(payload.first, payload.second, "application/json")
            }
        }
        pendingExport = null
    }
}

@Composable
private fun SectionHeader(title: String) {
    Text(
        title,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

@Composable
private fun PresetRow(
    preset: LocalPresetEntity,
    onEdit: () -> Unit,
    onDuplicate: () -> Unit,
    onDelete: (() -> Unit)?,
    onExport: () -> Unit,
    onToggle: ((Boolean) -> Unit)?,
    onMoveUp: (() -> Unit)?,
    onMoveDown: (() -> Unit)?,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Column(Modifier.weight(1f)) {
                Text(preset.name.ifBlank { "(未命名预设)" }, style = MaterialTheme.typography.titleSmall)
                Text(
                    buildString {
                        append("temperature ${fmt(presetTemp(preset))} · topP ${fmt(presetTopP(preset))}")
                        if (preset.isDefault) append(" · 当前默认")
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (onToggle != null) {
                EditorSwitchRow(checked = preset.enabled, onCheckedChange = onToggle, label = "")
            }
            if (onMoveUp != null) TextButton(onClick = onMoveUp) { Text("上移") }
            if (onMoveDown != null) TextButton(onClick = onMoveDown) { Text("下移") }
            IconButton(onClick = onEdit) { Icon(Icons.Filled.Edit, contentDescription = "编辑") }
            IconButton(onClick = onDuplicate) { Icon(Icons.Filled.ContentCopy, contentDescription = "复制") }
            if (onDelete != null) {
                IconButton(onClick = onDelete) { Icon(Icons.Filled.Delete, contentDescription = "删除") }
            }
            TextButton(onClick = onExport) { Text("导出") }
        }
        if (preset.description.isNotBlank()) {
            Text(
                preset.description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun PresetEditorPage(
    vm: PresetEditorViewModel,
    editor: PresetEditorViewModel.EditorState,
    onBack: () -> Unit,
) {
    val draft = editor.draft ?: return
    val row = draft.draft
    val body = vm.bodyOf(row)
    val readOnlyBuiltin = row.isBuiltin
    val exit = rememberEditorExitGuard(
        dirty = draft.dirty,
        onSaveAndClose = vm::save,
        onDiscardAndClose = vm::discardDraftAndClose,
        onLeave = onBack,
    )


    Scaffold(
        topBar = {
            AppTopBar(
                title = if (editor.presetId == null) "新建预设" else "编辑预设",
                navigationIcon = {
                    IconButton(onClick = exit.requestLeave) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            editor.error?.let { QyErrorBanner(message = it, onRetry = null) }
            if (readOnlyBuiltin) {
                EditorNote("这是内建预设。保存会另存为一个新预设，内建版本保持不变（升级不会覆盖你的副本）。")
            }
            EditorFormBody {
                EditorSection("基本信息") {
                    EditorTextField(
                        value = row.name,
                        onValueChange = { value ->
                            vm.edit { it.copy(name = value) }
                            vm.editText("name", value)
                        },
                        label = "名称",
                        error = if (row.name.isBlank()) "名称不能为空" else null,
                    )
                    EditorTextField(
                        value = row.description,
                        onValueChange = { value ->
                            vm.edit { it.copy(description = value) }
                            vm.editText("description", value)
                        },
                        label = "说明",
                        minLines = 2,
                    )
                }

                EditorSection("提示词") {
                    EditorTextField(
                        value = PresetEditorViewModel.string(body, "systemPrompt"),
                        onValueChange = { value -> vm.editText("systemPrompt", value) },
                        label = "System Prompt",
                        minLines = 6,
                    )
                    EditorTextField(
                        value = PresetEditorViewModel.string(body, "jailbreak"),
                        onValueChange = { value -> vm.editText("jailbreak", value) },
                        label = "历史后注入（jailbreak）",
                        minLines = 4,
                        helper = "注入在对话历史之后；与角色级 postHistoryInstructions 分开",
                    )
                }

                EditorSection("采样参数") {
                    EditorNumberField(
                        value = PresetEditorViewModel.number(body, "temperature", 0.8),
                        onValueChange = { vm.editNumber("temperature", it) },
                        label = "temperature",
                        range = 0.0..2.0,
                        helper = "钳位区间与 PC 一致：[0, 2]，默认 0.8",
                    )
                    EditorNumberField(
                        value = PresetEditorViewModel.number(body, "topP", 0.95),
                        onValueChange = { vm.editNumber("topP", it) },
                        label = "topP",
                        range = 0.01..1.0,
                    )
                    EditorNumberField(
                        value = PresetEditorViewModel.number(body, "frequencyPenalty", 0.0),
                        onValueChange = { vm.editNumber("frequencyPenalty", it) },
                        label = "frequencyPenalty",
                        range = -2.0..2.0,
                    )
                    EditorNumberField(
                        value = PresetEditorViewModel.number(body, "presencePenalty", 0.0),
                        onValueChange = { vm.editNumber("presencePenalty", it) },
                        label = "presencePenalty",
                        range = -2.0..2.0,
                    )
                    EditorNumberField(
                        value = PresetEditorViewModel.number(body, "maxTokens", 0.0),
                        onValueChange = { vm.editNumber("maxTokens", it) },
                        label = "maxTokens（0 = 自动动态预算）",
                        range = 0.0..262144.0,
                        integerOnly = true,
                    )
                    EditorNumberField(
                        value = PresetEditorViewModel.number(body, "maxContext", 0.0),
                        onValueChange = { vm.editNumber("maxContext", it) },
                        label = "maxContext（0 = 不额外限制）",
                        range = 0.0..2000000.0,
                        integerOnly = true,
                    )
                }

                EditorSection("生成规划与格式") {
                    EditorNote("回复篇幅")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PresetEditorViewModel.RESPONSE_LENGTH_HINTS.forEach { option ->
                            FilterChip(
                                selected = PresetEditorViewModel.string(body, "responseLengthHint") == option,
                                onClick = { vm.editText("responseLengthHint", option) },
                                label = { Text(option) },
                            )
                        }
                    }
                    EditorNote("示例对话发送方式")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PresetEditorViewModel.EXAMPLE_DIALOG_MODES.forEach { option ->
                            FilterChip(
                                selected = PresetEditorViewModel.string(body, "exampleDialogMode") == option,
                                onClick = { vm.editText("exampleDialogMode", option) },
                                label = { Text(option) },
                            )
                        }
                    }
                    val thought = PresetEditorViewModel.boolean(body, "enableThoughtFormat")
                    EditorSwitchRow(
                        checked = thought == true,
                        onCheckedChange = { value -> vm.editBody("enableThoughtFormat", value) },
                        label = "心理描写格式",
                        description = if (thought == null) "未设置：跟随全局设置" else "已在此预设固定",
                    )
                    EditorTextField(
                        value = PresetEditorViewModel.string(body, "contextTemplate"),
                        onValueChange = { value -> vm.editText("contextTemplate", value) },
                        label = "上下文模板",
                        helper = "chatml / llama3 / alpaca；留空表示不包装",
                    )
                    EditorTextField(
                        value = PresetEditorViewModel.string(body, "group"),
                        onValueChange = { value -> vm.editText("group", value) },
                        label = "分组",
                    )
                }

                EditorSection("其它", collapsedByDefault = true) {
                    EditorNote(
                        "方案 §S5-03 文字里提到的 stop 字段，PC 的 Preset 结构并不存在；" +
                            "预设正文整体就是同步 payload，擅自加键会让两端哈希不一致，" +
                            "因此这里不提供（详见阶段 5 报告的待决策项）。",
                    )
                    EditorSwitchRow(
                        checked = row.enabled,
                        onCheckedChange = { value -> vm.edit { it.copy(enabled = value) } },
                        label = "启用这个预设",
                        description = "停用后不出现在预设选择列表里",
                    )
                }
            }
            EditorActionBar(
                dirty = draft.dirty || row.isBuiltin,
                busy = editor.busy,
                saveLabel = if (readOnlyBuiltin) "另存为我的预设" else "保存",
                onSave = { vm.save() },
                onCancel = exit.requestLeave,
            )
            if (editor.draftRestored) {
                // 恢复出来的内容必须说明来源，否则用户会以为库里已经是这样
                EditorNote("已恢复上次未保存的草稿（尚未保存为一次变更）")
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

private fun fmt(value: Double): String = if (value == value.toLong().toDouble()) value.toLong().toString() else value.toString()

private fun presetTemp(preset: LocalPresetEntity): Double =
    (PresetCodecBody.number(preset, "temperature", 0.8))

private fun presetTopP(preset: LocalPresetEntity): Double =
    (PresetCodecBody.number(preset, "topP", 0.95))

/** 列表行需要读正文里的两个采样值，但列表页拿不到 ViewModel 实例，故就地解析。 */
private object PresetCodecBody {
    fun number(preset: LocalPresetEntity, key: String, fallback: Double): Double =
        (com.qingyu.companion.local.domain.JsonValues.parseObject(preset.bodyJson)[key] as? Number)?.toDouble()
            ?: fallback
}
