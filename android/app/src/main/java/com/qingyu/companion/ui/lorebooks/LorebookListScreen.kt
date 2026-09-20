package com.qingyu.companion.ui.lorebooks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.content.lorebook.LorebookCompatibilityReport
import com.qingyu.companion.content.lorebook.LorebookCompatibilitySeverity
import com.qingyu.companion.content.lorebook.LorebookFormatAdapter
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.local.db.LocalLorebookEntity
import com.qingyu.companion.local.db.LocalLorebookMappingTemplateEntity
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.QyEmptyState
import com.qingyu.companion.ui.components.QyErrorBanner
import com.qingyu.companion.ui.components.QySkeletonList
import com.qingyu.companion.ui.components.rememberSkeletonVisible
import com.qingyu.companion.ui.content.DeleteImpactDialog
import com.qingyu.companion.ui.content.EditorNote
import com.qingyu.companion.ui.content.EditorTextField
import com.qingyu.companion.ui.content.PickedDocument
import com.qingyu.companion.ui.content.rememberCreateDocumentPicker
import com.qingyu.companion.ui.content.rememberMultiDocumentPicker
import com.qingyu.companion.ui.content.writeDocument
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.launch

/**
 * 阶段 5 S5-02：世界书列表（搜索、多格式导入、删除影响、导出、兼容性报告）。
 *
 * ## 导出写入器为什么建在早退之前
 * SAF 的 launcher 只能在组合期创建。编辑页要用同一个导出出口（导出当前草稿），
 * 所以 `pendingExport` 与 launcher 都声明在 `if (editor.draft != null) return` 之前——
 * 放在之后会在进入编辑页时被销毁，表现为「点导出没反应或写出空文件」。
 *
 * ## 编辑态在页面内切换而不是走路由
 * 与角色/人设页一致：返回手势才能命中「未保存草稿」确认，
 * 也免得「保存后回到哪一页」变成两套导航栈。
 */
@Composable
fun LorebookListScreen(onBack: () -> Unit) {
    // 必须在组合期取容器：viewModelInitializer 运行在组合之外，那里读不到 CompositionLocal
    val container = LocalAppContainer.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val vm: LorebookEditorViewModel = viewModel(factory = viewModelFactory {
        initializer {
                LorebookEditorViewModel(
                    store = container.localSyncRepository,
                    drafts = container.contentDraftStore,
                )
            }
    })

    val list by vm.list.collectAsStateWithLifecycle()
    val editor by vm.editor.collectAsStateWithLifecycle()

    var exportNote by remember { mutableStateOf<String?>(null) }
    var pendingExport by remember { mutableStateOf<Pair<ByteArray, String>?>(null) }
    val writeExport = rememberCreateDocumentPicker(mimeType = "application/json") { uri ->
        val job = pendingExport
        pendingExport = null
        if (job != null) {
            val failure = writeDocument(context, uri, job.first)
            exportNote = failure ?: "已导出「${job.second}」"
        }
    }
    val exportTo: (ByteArray, String) -> Unit = { bytes, name ->
        pendingExport = bytes to name
        writeExport(name)
    }
    val exportFormats = remember { vm.exportableFormats() }

    if (editor.draft != null) {
        LorebookEditorScreen(
            vm = vm,
            state = editor,
            list = list,
            onBack = vm::clearEditor,
            exportTo = exportTo,
        )
        return
    }

    var templateDraft by remember { mutableStateOf<List<PickedDocument>>(emptyList()) }
    var templatePickerOpen by remember { mutableStateOf(false) }
    val pickForImport = rememberMultiDocumentPicker(mimeTypes = LOREBOOK_MIME_TYPES) { documents ->
        vm.importDocuments(documents)
    }
    val pickForTemplate = rememberMultiDocumentPicker(mimeTypes = LOREBOOK_MIME_TYPES) { documents ->
        templateDraft = documents
        templatePickerOpen = true
    }

    Scaffold(
        topBar = {
            AppTopBar(
                title = "世界书",
                subtitle = "${list.rows.size} 本",
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
                text = { Text("新建世界书") },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            list.error?.let { QyErrorBanner(message = it, onRetry = vm::refresh) }
            exportNote?.let { note ->
                // 纵向堆叠：EditorNote 自带 fillMaxWidth，横向并排会把「知道了」按钮挤没
                Column {
                    EditorNote(note)
                    TextButton(onClick = { exportNote = null }) { Text("知道了") }
                }
            }
            list.summary?.let { summary ->
                ImportSummaryCard(
                    summary = summary,
                    onDismiss = vm::dismissImportSummary,
                    onShowReport = vm::showReport,
                )
            }
            list.actionNote?.let { note ->
                Column {
                    EditorNote(note, isError = true)
                    TextButton(onClick = vm::dismissActionNote) { Text("知道了") }
                }
            }

            EditorTextField(
                value = list.query,
                onValueChange = vm::onQueryChange,
                label = "搜索世界书（名称或导入来源）",
                modifier = Modifier.padding(horizontal = 16.dp),
            )

            val skeleton = rememberSkeletonVisible(list.loading && list.rows.isEmpty())
            when {
                skeleton -> QySkeletonList(rows = 6, modifier = Modifier.padding(horizontal = 16.dp))

                list.rows.isEmpty() -> QyEmptyState(
                    title = if (list.query.isBlank()) "还没有世界书" else "没有匹配的世界书",
                    description = "可以新建，或直接导入 SillyTavern / character_book / lorebook_v3 / Risu / Agnai / NovelAI 文件",
                )

                else -> LazyColumn(contentPadding = PaddingValues(vertical = 8.dp)) {
                    items(list.rows, key = { it.id }) { row ->
                        LorebookRow(
                            row = row,
                            exportFormats = exportFormats,
                            onEdit = { vm.startEdit(row.id) },
                            onDelete = { vm.inspectDelete(row.id) },
                            onExport = { adapterId ->
                                scope.launch { vm.exportStored(row.id, adapterId, exportTo) }
                            },
                        )
                    }
                    if (list.hasMore) {
                        // 分页得让人看见还有多少没读：只放一个「加载更多」会被当成就这些
                        item(key = "load-more") {
                            TextButton(onClick = vm::loadMore, modifier = Modifier.fillMaxWidth()) {
                                Text("加载更多（已显示 ${list.rows.size} / ${list.total}）")
                            }
                        }
                    }
                }
            }

            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            ) {
                Button(onClick = pickForImport, modifier = Modifier.weight(1f), enabled = !list.busy) {
                    Text(if (list.busy) "正在导入…" else "导入世界书（可多选）")
                }
                OutlinedButton(
                    onClick = {
                        if (list.templates.isEmpty()) {
                            exportNote = "本机没有可用的映射模板：先由 PC 同步或导入标准格式"
                        } else {
                            pickForTemplate()
                        }
                    },
                    modifier = Modifier.weight(1f),
                    enabled = !list.busy,
                ) { Text("按映射模板导入") }
            }
            EditorNote(
                "标准格式优先走自动识别；识别不了或格式有歧义时会让你指定格式，" +
                    "不会替你猜一个含义不同的解释（方案 §6.1：不静默猜测）。",
            )
            Spacer(Modifier.height(88.dp))
        }
    }

    list.pendingDelete?.let { pending ->
        DeleteImpactDialog(
            itemName = pending.name.ifBlank { "(未命名世界书)" },
            impact = pending.impact,
            extraWarning = if (pending.impact.isEmpty) {
                null
            } else {
                "删除时会一并解绑这些引用；解绑与删除各自记账，中途失败只会留下一本没人引用的世界书。"
            },
            onConfirm = vm::confirmDelete,
            onDismiss = vm::dismissDelete,
        )
    }

    LorebookReportHost(vm = vm, list = list)

    if (templatePickerOpen) {
        TemplatePickerDialog(
            templates = list.templates,
            onPick = { templateId ->
                templatePickerOpen = false
                vm.importWithTemplate(templateDraft, templateId)
            },
            onDismiss = { templatePickerOpen = false },
        )
    }
}

@Composable
private fun LorebookRow(
    row: LocalLorebookEntity,
    exportFormats: List<LorebookFormatAdapter>,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onExport: (String) -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                row.name.ifBlank { "(未命名世界书)" },
                style = MaterialTheme.typography.titleSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            // 刻意不在列表里解析 canonical_json 取条目数：每刷新一次就要重解析
            // 100 本 × 5k 条的文档，而条目数只有编辑时才用得上。
            Text(
                buildString {
                    append("深度 ${row.scanDepth ?: "默认"} · 预算 ${row.tokenBudget ?: "不限"}")
                    row.importedFrom?.let { append(" · 来自 $it") }
                    append(" · ${formatUpdatedAt(row.updatedAt)}")
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        IconButton(onClick = onEdit) { Icon(Icons.Filled.Edit, contentDescription = "编辑") }
        Box {
            IconButton(onClick = { menuOpen = true }) {
                Icon(Icons.Filled.MoreVert, contentDescription = "更多操作")
            }
            // 删除藏进菜单：行内并排几个按钮在窄屏上会互相挤压，反而更容易误触删除
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                exportFormats.forEach { adapter ->
                    DropdownMenuItem(
                        text = { Text("导出为 ${adapter.label}") },
                        onClick = {
                            menuOpen = false
                            onExport(adapter.id)
                        },
                    )
                }
                DropdownMenuItem(
                    text = { Text("删除", color = MaterialTheme.colorScheme.error) },
                    onClick = {
                        menuOpen = false
                        onDelete()
                    },
                )
            }
        }
    }
}

@Composable
private fun ImportSummaryCard(
    summary: LorebookEditorViewModel.ImportSummary,
    onDismiss: () -> Unit,
    onShowReport: (String) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        EditorNote(
            "导入完成：成功 ${summary.imported} 本，近似映射 ${summary.approximated} 本，" +
                "失败 ${summary.failed} 本，跳过 ${summary.skipped.size} 份，" +
                "未知字段保留 ${summary.preservedNotes.size} 条",
        )
        summary.outcomes.forEach { outcome ->
            val prefix = when (outcome.verdict) {
                LorebookEditorViewModel.FileOutcome.Verdict.IMPORTED -> "成功"
                LorebookEditorViewModel.FileOutcome.Verdict.APPROXIMATED -> "近似"
                LorebookEditorViewModel.FileOutcome.Verdict.FAILED -> "失败"
            }
            EditorNote(
                "「${outcome.displayName}」$prefix · 《${outcome.bookName}》 · ${outcome.adapterLabel}" +
                    (outcome.reason?.let { " · $it" } ?: ""),
                isError = outcome.verdict == LorebookEditorViewModel.FileOutcome.Verdict.FAILED,
            )
            // 每条结局都能点开完整报告：只有一行结论的话，「近似映射」到底近似在哪就无从查证
            if (outcome.report != null) {
                TextButton(onClick = { onShowReport(outcome.displayName) }) { Text("看这份报告") }
            }
        }
        summary.skipped.forEach { EditorNote("跳过：$it") }
        // 检索通道差异：导入成功、报告全绿，但其中若干条目在本机不会注入（或与 PC 相反）。
        // 这是唯一此前完全无声的一类「导入成功但行为不同」，所以即使没有未知字段保留也要印。
        summary.channelNotes.forEach { EditorNote(it) }
        if (summary.preservedNotes.isNotEmpty()) {
            EditorNote("保留的未知字段：")
            summary.preservedNotes.take(8).forEach { EditorNote("  $it") }
            if (summary.preservedNotes.size > 8) {
                EditorNote("  …另有 ${summary.preservedNotes.size - 8} 条，见该文件的兼容性报告")
            }
        }
        TextButton(onClick = onDismiss) { Text("知道了") }
    }
}

// ------------------------------------------------------------------ 报告与格式选择

/**
 * 兼容性报告 + 「指定格式重导」对话框宿主。
 *
 * 列表页与编辑页都调用它（同一时刻只有一页在组合里），因此导出报告在编辑页里
 * 同样看得见，而不必为了显示一份报告把两页拼成一套状态机。
 */
@Composable
internal fun LorebookReportHost(
    vm: LorebookEditorViewModel,
    list: LorebookEditorViewModel.ListState,
) {
    var formatPickerOpen by remember { mutableStateOf(false) }
    val view = list.report
    if (view != null) {
        LorebookReportDialog(
            view = view,
            onDismiss = vm::dismissReport,
            onPickFormat = { formatPickerOpen = true },
        )
    }
    val pending = view?.pending
    if (formatPickerOpen && pending != null) {
        FormatPickerDialog(
            formats = remember { vm.selectableFormats() },
            fileDisplayName = pending.displayName,
            replacesExisting = pending.replacesLorebookId != null,
            onPick = { adapterId ->
                formatPickerOpen = false
                vm.reimportWith(adapterId)
            },
            onDismiss = { formatPickerOpen = false },
        )
    }
}

/** 兼容性报告对话框（方案 §2：导入必须显示成功/跳过/近似/失败/未知字段保留）。 */
@Composable
internal fun LorebookReportDialog(
    view: LorebookEditorViewModel.ReportView,
    onDismiss: () -> Unit,
    onPickFormat: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(view.title) },
        text = {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                EditorNote(view.subtitle)
                ReportBody(view.report)
                if (view.pending != null) {
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = onPickFormat) { Text("指定格式重新导入") }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("知道了") } },
    )
}

/** 报告正文（对话框与页内展示共用一份渲染，避免出现两种「报告长什么样」）。 */
@Composable
internal fun ReportBody(report: LorebookCompatibilityReport) {
    Column(Modifier.fillMaxWidth()) {
        EditorNote("适配器：${report.adapterId} · ${report.formatLabel} v${report.formatVersion}")
        EditorNote("结论：${report.status.jsonValue}")
        EditorNote(
            "映射 ${report.summary.mapped}，保留 ${report.summary.preserved}，近似 ${report.summary.approximated}，" +
                "丢弃 ${report.summary.dropped}，拒绝 ${report.summary.rejected}" +
                "（警告 ${report.summary.warnings}，错误 ${report.summary.errors}）",
        )
        if (report.issues.isEmpty()) {
            EditorNote("没有兼容性差异：这份文件的每个字段都被逐条映射了。")
        }
        report.issues.forEach { issue ->
            EditorNote(
                "[${issue.severity.jsonValue}/${issue.action.jsonValue}] ${issue.path} ${issue.code}：${issue.message}",
                isError = issue.severity == LorebookCompatibilitySeverity.ERROR,
            )
        }
    }
}

/**
 * 手动指定格式。
 *
 * 清单**必须**包含全部已注册适配器（含不能导出的映射向导）：被拒的文件往往正是
 * 只有映射向导才认得的形状。顺序就是 registry 的优先级顺序，与自动检测同一口径。
 */
@Composable
private fun FormatPickerDialog(
    formats: List<LorebookFormatAdapter>,
    fileDisplayName: String,
    replacesExisting: Boolean,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("指定「$fileDisplayName」的格式") },
        text = {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                EditorNote(
                    if (replacesExisting) {
                        "原先按猜测格式导入的那一本会被新结果覆盖（id 不变）。"
                    } else {
                        "选错格式只会多出一本世界书，可以在列表里删掉它再试。"
                    },
                )
                formats.forEach { adapter ->
                    TextButton(onClick = { onPick(adapter.id) }) {
                        Text("${adapter.label} · v${adapter.formatVersion}（${adapter.id}）")
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

@Composable
private fun TemplatePickerDialog(
    templates: List<LocalLorebookMappingTemplateEntity>,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("选择映射模板") },
        text = {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                EditorNote(
                    "模板是 PC 或导入产生的受限路径表（只进不出）。" +
                        "路径无法无损折叠时会报错，不会静默丢掉一条映射。",
                )
                templates.forEach { template ->
                    TextButton(onClick = { onPick(template.id) }) {
                        Text("${template.name}（${template.sourceFormat}）")
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

/** 可导入的 MIME：三种都给——同一份 JSON 在不同设备上被标成不同类型，只给 json 会让用户选不到文件。 */
private val LOREBOOK_MIME_TYPES = arrayOf("application/json", "text/plain", "application/octet-stream")

private fun formatUpdatedAt(millis: Long): String =
    SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(Date(millis))
