package com.qingyu.companion.ui.characters

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExtendedFloatingActionButton
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import coil.compose.AsyncImage
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.QyEmptyState
import com.qingyu.companion.ui.components.QyErrorBanner
import com.qingyu.companion.ui.components.QySkeletonList
import com.qingyu.companion.ui.components.rememberSkeletonVisible
import com.qingyu.companion.ui.content.DeleteImpactDialog
import com.qingyu.companion.ui.content.EditorActionBar
import com.qingyu.companion.ui.content.EditorCheckboxRow
import com.qingyu.companion.ui.content.EditorFormBody
import com.qingyu.companion.ui.content.EditorNote
import com.qingyu.companion.ui.content.EditorSection
import com.qingyu.companion.ui.content.EditorSwitchRow
import com.qingyu.companion.ui.content.EditorTextField
import com.qingyu.companion.ui.content.rememberEditorExitGuard
import com.qingyu.companion.ui.content.rememberMultiDocumentPicker
import com.qingyu.companion.ui.content.writeDocument
import kotlinx.coroutines.launch

/**
 * 阶段 5 S5-01：角色列表 + 编辑器。
 *
 * 一个文件里放两个页面是有意的：新建/编辑/复制/删除/导入导出这条链
 * 共用同一个 ViewModel 状态，拆成两个路由会把「保存后回到哪一页」变成两套导航栈。
 *
 * 只读浏览页（`CharactersScreen`）保持不变——那是阶段 3/4 已验收的入口，
 * 本页面是编辑入口（从设置页或角色页的「管理角色」进入）。
 */
@Composable
fun CharacterManagerScreen(
    onBack: () -> Unit,
) {
    val container = LocalAppContainer.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var exportNote by remember { mutableStateOf<String?>(null) }
    val exporter = rememberFileExporter { message -> exportNote = message }
    val vm: CharacterEditorViewModel = viewModel(factory = viewModelFactory {
        initializer {
            CharacterEditorViewModel(
                store = container.localSyncRepository,
                mediaRoot = java.io.File(context.filesDir, "media"),
                drafts = container.contentDraftStore,
            )
        }
    })

    val list by vm.list.collectAsStateWithLifecycle()
    val editor by vm.editor.collectAsStateWithLifecycle()

    // 编辑态在页面内切换，而不是走路由：这样返回手势能命中「未保存草稿」确认
    val editing = editor.draft != null

    if (editing) {
        CharacterEditorPage(vm = vm, editor = editor, onBack = vm::clearEditor)
        return
    }

    Scaffold(
        topBar = { AppTopBar(
                title = "角色管理",
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            ) },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = vm::startCreate,
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("新建角色") },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            list.error?.let { message -> QyErrorBanner(message = message, onRetry = vm::refresh) }
            exportNote?.let { note -> EditorNote(note); }
            list.importReport?.let { ImportReportCard(it) { vm.refresh() } }

            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            ) {
                EditorTextField(
                    value = list.query,
                    onValueChange = vm::onQueryChange,
                    label = "搜索角色",
                    modifier = Modifier.weight(1f),
                )
                SortMenu(current = list.sortBy, onPick = vm::onSortChange)
            }

            val skeleton = rememberSkeletonVisible(list.loading && list.characters.isEmpty())
            if (skeleton) {
                QySkeletonList(rows = 6)
            } else if (list.characters.isEmpty()) {
                QyEmptyState(
                    title = if (list.query.isBlank()) "还没有角色" else "没有匹配的角色",
                    description = "可以从 PC 同步，或直接导入 Character Card（PNG / JSON）",
                )
            } else {
                LazyColumn(
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(list.characters, key = { it.id }) { row ->
                        CharacterRow(
                            row = row,
                            onEdit = { vm.startEdit(row.id) },
                            onDuplicate = { vm.startDuplicate(row.id) },
                            onDelete = { vm.inspectDelete(row.id) },
                            onExport = { format ->
                                scope.launch {
                                    vm.export(row.id, format) { bytes, name, mime -> exporter(bytes, name, mime) }
                                }
                            },
                        )
                    }
                }
            }

            ImportButton(
                onPicked = { documents -> vm.importDocuments(documents) },
            )
            Spacer(Modifier.height(80.dp))
        }
    }

    // 删除确认：影响范围来自数据库计数，不是猜的
    editor.impact?.let { impact ->
        val targetId = editor.characterId
        if (targetId != null) {
            DeleteImpactDialog(
                itemName = list.characters.firstOrNull { it.id == targetId }?.name ?: "该角色",
                impact = impact,
                extraWarning = if (impact.sessions > 0) "这些会话及其消息会保留，但不再归属任何角色。" else null,
                onConfirm = { vm.confirmDelete(targetId) },
                onDismiss = { vm.clearEditor() },
            )
        }
    }
}

@Composable
private fun CharacterRow(
    row: LocalCharacterEntity,
    onEdit: () -> Unit,
    onDuplicate: () -> Unit,
    onDelete: () -> Unit,
    onExport: (String) -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
    ) {
        Avatar(row.avatarPath)
        Column(Modifier.weight(1f)) {
            Text(row.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (row.description.isNotBlank()) {
                Text(
                    row.description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        IconButton(onClick = onEdit) { Icon(Icons.Filled.Edit, contentDescription = "编辑") }
        IconButton(onClick = onDuplicate) { Icon(Icons.Filled.ContentPaste, contentDescription = "复制") }
        Box {
            IconButton(onClick = { menuOpen = true }) {
                Icon(Icons.Filled.Delete, contentDescription = "更多操作")
            }
            // 删除藏在这个菜单里，导出三种格式共用一个出口：
            // 行内堆 5 个按钮在窄屏上会互相挤压，反而更容易误触删除。
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(text = { Text("导出为 JSON（V2）") }, onClick = { menuOpen = false; onExport("json-v2") })
                DropdownMenuItem(text = { Text("导出为 JSON（V3）") }, onClick = { menuOpen = false; onExport("json-v3") })
                DropdownMenuItem(text = { Text("导出为 PNG 角色卡") }, onClick = { menuOpen = false; onExport("png") })
                DropdownMenuItem(text = { Text("导出封面图") }, onClick = { menuOpen = false; onExport("cover") })
                DropdownMenuItem(
                    text = { Text("删除", color = MaterialTheme.colorScheme.error) },
                    onClick = { menuOpen = false; onDelete() },
                )
            }
        }
    }
}

@Composable
private fun Avatar(path: String?) {
    if (path == null) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(48.dp)
                .clip(RoundedCornerShape(10.dp))
                .padding(0.dp),
        ) { Text("无", style = MaterialTheme.typography.labelSmall) }
        return
    }
    AsyncImage(
        model = path,
        contentDescription = null,
        contentScale = ContentScale.Crop,
        modifier = Modifier.size(48.dp).clip(RoundedCornerShape(10.dp)),
    )
}

@Composable
private fun SortMenu(current: String, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { open = true }) {
            Text("排序：" + when (current) {
                CharacterEditorViewModel.SORT_BY_NAME -> "名称"
                CharacterEditorViewModel.SORT_BY_CREATED -> "创建时间"
                else -> "最近更新"
            })
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text("名称") }, onClick = { open = false; onPick(CharacterEditorViewModel.SORT_BY_NAME) })
            DropdownMenuItem(text = { Text("创建时间") }, onClick = { open = false; onPick(CharacterEditorViewModel.SORT_BY_CREATED) })
            DropdownMenuItem(text = { Text("最近更新") }, onClick = { open = false; onPick(CharacterEditorViewModel.SORT_BY_UPDATED) })
        }
    }
}

@Composable
private fun ImportButton(onPicked: (List<com.qingyu.companion.ui.content.PickedDocument>) -> Unit) {
    // application/json 与 image/png 一起给：社区卡两种都有，让用户先选类型再选文件是多余的步骤
    val pick = rememberMultiDocumentPicker(mimeTypes = arrayOf("application/json", "image/png")) { documents ->
        onPicked(documents)
    }
    Button(onClick = pick, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        Text("导入角色卡（PNG / JSON，可多选）")
    }
}

@Composable
private fun ImportReportCard(report: CharacterEditorViewModel.ImportReport, onDismiss: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        EditorNote(
            "导入完成：成功 ${report.imported} 个，跳过 ${report.skipped.size} 个，" +
                "近似映射 ${report.approximated.size} 处，失败 ${report.failed.size} 个，" +
                "未知字段保留 ${report.unmapped.size} 个文件，绑定内嵌世界书 ${report.boundLorebooks} 个",
        )
        report.skipped.forEach { EditorNote("跳过：$it") }
        report.approximated.forEach { EditorNote("近似映射：$it") }
        report.failed.forEach { EditorNote("失败：$it", isError = true) }
        report.unmapped.forEach { (name, fields) ->
            EditorNote("「$name」保留了 ${fields.size} 个未识别字段：${fields.take(6).joinToString()}")
        }
        TextButton(onClick = onDismiss) { Text("知道了") }
    }
}

/** 编辑页：所有字段都可编辑，关键高级字段用折叠区而不是藏起来。 */
@Composable
private fun CharacterEditorPage(
    vm: CharacterEditorViewModel,
    editor: CharacterEditorViewModel.EditorState,
    onBack: () -> Unit,
) {
    val draft = editor.draft ?: return
    val row = draft.draft
    // 方案 §2「点击保存或**离开确认后**生成一个业务变更」：脏了就问，不脏才静默退出。
    // 返回箭头 / 系统返回键 / 操作行的「取消」共用一份判定——六个编辑器同一条规则，
    // 少接一处就等于给用户留一条「没被问就丢了半篇内容」的路径。
    val dirty = draft.dirty
    val exit = rememberEditorExitGuard(
        dirty = dirty,
        onSaveAndClose = vm::saveAndClose,
        onDiscardAndClose = vm::discardDraftAndClose,
        onLeave = onBack,
    )
    Scaffold(
        topBar = { AppTopBar(
                title = if (editor.characterId == null) "新建角色" else "编辑角色",
                navigationIcon = {
                    IconButton(onClick = exit.requestLeave) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            ) },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            if (editor.error != null) QyErrorBanner(message = editor.error, onRetry = null)
            EditorFormBody {
                EditorSection("基础信息") {
                    EditorTextField(
                        value = row.name,
                        onValueChange = { name -> vm.edit { it.copy(name = name) } },
                        label = "角色名",
                        error = if (row.name.isBlank()) "角色名不能为空" else null,
                    )
                    EditorTextField(
                        value = row.description,
                        onValueChange = { value -> vm.edit { it.copy(description = value) } },
                        label = "角色描述",
                        minLines = 4,
                    )
                    EditorTextField(
                        value = row.personality,
                        onValueChange = { value -> vm.edit { it.copy(personality = value) } },
                        label = "性格特征",
                        minLines = 3,
                    )
                    EditorTextField(
                        value = row.scenario,
                        onValueChange = { value -> vm.edit { it.copy(scenario = value) } },
                        label = "场景设定",
                        minLines = 2,
                    )
                }

                EditorSection("开场白与示例") {
                    EditorTextField(
                        value = row.firstMessage,
                        onValueChange = { value -> vm.edit { it.copy(firstMessage = value) } },
                        label = "首条消息",
                        minLines = 3,
                        helper = "备选开场白按顺序使用；只有备选没有首条消息时，导入会把第一条当首条",
                    )
                    val alternates = CharacterEditorViewModel.stringListOf(row.alternateGreetingsJson)
                    EditorNote("备选开场白：${alternates.size} 条")
                    EditorTextField(
                        value = row.exampleDialog,
                        onValueChange = { value -> vm.edit { it.copy(exampleDialog = value) } },
                        label = "对话示例（exampleDialog）",
                        minLines = 4,
                        helper = "与 PC 同为 <START> 分段的纯文本；这是规范字段，旧的 JSON 数组字段不再写入",
                    )
                }

                EditorSection("提示词与元数据", collapsedByDefault = true) {
                    EditorTextField(
                        value = row.systemPrompt,
                        onValueChange = { value -> vm.edit { it.copy(systemPrompt = value) } },
                        label = "角色级系统提示词",
                        minLines = 3,
                        helper = "非空时覆盖预设的系统提示",
                    )
                    EditorTextField(
                        value = row.postHistoryInstructions,
                        onValueChange = { value -> vm.edit { it.copy(postHistoryInstructions = value) } },
                        label = "对话历史后注入指令",
                        minLines = 2,
                    )
                    EditorTextField(
                        value = row.creatorNotes,
                        onValueChange = { value -> vm.edit { it.copy(creatorNotes = value) } },
                        label = "创作者备注",
                        minLines = 2,
                        helper = "隐藏元数据，导入导出保留，不进 AI 上下文",
                    )
                    EditorTextField(
                        value = row.creator,
                        onValueChange = { value -> vm.edit { it.copy(creator = value) } },
                        label = "作者",
                    )
                    EditorTextField(
                        value = row.characterVersion,
                        onValueChange = { value -> vm.edit { it.copy(characterVersion = value) } },
                        label = "角色卡版本",
                    )
                    EditorTextField(
                        value = CharacterEditorViewModel.stringListOf(row.tagsJson).joinToString(", "),
                        onValueChange = { value ->
                            vm.edit { it.copy(tagsJson = tagsFrom(value)) }
                        },
                        label = "标签（逗号分隔）",
                    )
                }

                EditorSection("绑定与继承", collapsedByDefault = true) {
                    EditorSwitchRow(
                        checked = row.embeddedLorebookJson.isNotBlank(),
                        onCheckedChange = { },
                        label = "含内嵌世界书",
                        description = if (row.embeddedLorebookJson.isNotBlank()) {
                            "导入时已提取，可在世界书页编辑"
                        } else {
                            "该角色没有内嵌世界书"
                        },
                        enabled = false,
                    )
                    EditorTextField(
                        value = row.defaultNarrativeMode,
                        onValueChange = { value -> vm.edit { it.copy(defaultNarrativeMode = value.trim()) } },
                        label = "新会话默认叙事模式",
                        helper = "immersive（代入式）/ omniscient（全局叙事）；留空表示跟随全局设置",
                    )
                    EditorTextField(
                        value = row.defaultMemoryMode,
                        onValueChange = { value -> vm.edit { it.copy(defaultMemoryMode = value.trim()) } },
                        label = "新会话默认记忆模式",
                        helper = "manual / auto；留空表示跟随全局设置",
                    )
                }
            }

            EditorActionBar(
                dirty = draft.dirty,
                busy = editor.busy,
                onSave = { vm.save() },
                onCancel = exit.requestLeave,
            )
            if (editor.draftRestored) {
                // 恢复出来的东西必须说清楚来源，否则用户以为库里已经是这样了
                EditorNote("已恢复上次未保存的草稿（尚未保存为一次变更）")
            }
            if (editor.saved) {
                EditorNote("已保存")
                Spacer(Modifier.height(12.dp))
            }
            if (editor.busy) {
                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(24.dp))
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

/** 标签输入 → 规范 JSON 数组（去空白、去空项、上限与 schema 的 64 项一致）。 */
private fun tagsFrom(input: String): String {
    val tags = input.split(',', '，', '、', '\n').map { it.trim() }.filter { it.isNotEmpty() }.take(64)
    return org.json.JSONArray(tags).toString()
}

/**
 * 导出写入器。
 *
 * 难点在于时序：SAF 的 launcher 只能在组合期创建，而要导出的字节是点击之后才生成的。
 * 所以这里把「待写内容」放进状态，launcher 回调发生时再取出来写。
 *
 * 早先的写法是在协程里现造一个 launcher——那样拿到的是未注册的 launcher，
 * 点击后什么都不发生（或者崩溃），导出会「静默产出空文件」。
 * 契约用通配 MIME 而不是按格式切换，避免 mimeType 变化导致 launcher 在组合期被重建。
 */
@Composable
fun rememberFileExporter(onResult: (String?) -> Unit): (ByteArray, String, String) -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var pending by remember { mutableStateOf<Pair<ByteArray, String>?>(null) }
    val launcher = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.CreateDocument("*/*"),
    ) { uri ->
        val (bytes, _) = pending ?: return@rememberLauncherForActivityResult
        pending = null
        if (uri == null) {
            onResult("已取消导出")
            return@rememberLauncherForActivityResult
        }
        scope.launch { onResult(writeDocument(context, uri, bytes)) }
    }
    return { bytes, name, _ ->
        pending = bytes to name
        launcher.launch(name)
    }
}
