package com.qingyu.companion.ui.regex

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.content.RegexCompatibility
import com.qingyu.companion.local.db.LocalRegexRuleEntity
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.QyEmptyState
import com.qingyu.companion.ui.components.QyErrorBanner
import com.qingyu.companion.local.domain.BindingImpact
import com.qingyu.companion.ui.content.DeleteImpactDialog
import com.qingyu.companion.ui.content.EditorActionBar
import com.qingyu.companion.ui.content.EditorFormBody
import com.qingyu.companion.ui.content.EditorNote
import com.qingyu.companion.ui.content.EditorSection
import com.qingyu.companion.ui.content.EditorSwitchRow
import com.qingyu.companion.ui.content.EditorTextField
import com.qingyu.companion.ui.content.rememberEditorExitGuard

/**
 * 阶段 5 S5-05：正则规则列表 + 编辑器 + 测试台。
 *
 * 测试台是这一页的核心而不是附件：正则的可读性差，
 * 没有「输入 → 输出」预览时用户只能靠发送消息去试，而一旦规则进同步就是全端生效。
 */
@Composable
fun RegexScreen(onBack: () -> Unit) {
    // 必须在组合期取出容器：viewModelInitializer 运行在组合之外，
    // 在那里读 CompositionLocal 只会拿到默认值（表现为页面永远拿不到数据源）。
    val appContainer = com.qingyu.companion.data.LocalAppContainer.current
    val vm: RegexEditorViewModel = viewModel(factory = viewModelFactory {
        initializer { RegexEditorViewModel(appContainer.localSyncRepository, appContainer.contentDraftStore) }
    })

    val list by vm.list.collectAsStateWithLifecycle()
    val editor by vm.editor.collectAsStateWithLifecycle()
    val test by vm.test.collectAsStateWithLifecycle()

    if (editor.draft != null) {
        RegexEditorPage(vm = vm, editor = editor, test = test, onBack = vm::clearEditor)
        return
    }

    var pendingDelete by remember { mutableStateOf<LocalRegexRuleEntity?>(null) }

    androidx.compose.material3.Scaffold(
        topBar = {
            AppTopBar(
                title = "正则规则",
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
                text = { Text("新建规则") },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            list.error?.let { QyErrorBanner(message = it, onRetry = vm::refresh) }
            EditorNote("规则按顺序链式应用：上一条的输出是下一条的输入。")
            if (list.rules.isEmpty() && !list.loading) {
                QyEmptyState(title = "还没有正则规则", description = "可用于清理格式、屏蔽越狱残留、修复翻译重复等")
            } else {
                LazyColumn(modifier = Modifier.fillMaxWidth()) {
                    items(list.rules, key = { it.id }) { rule ->
                        RegexRuleRow(
                            rule = rule,
                            onEdit = { vm.startEdit(rule.id) },
                            onMoveUp = { vm.move(rule.id, up = true) },
                            onMoveDown = { vm.move(rule.id, up = false) },
                            onToggle = { enabled -> vm.toggleEnabled(rule.id, enabled) },
                            onDelete = { pendingDelete = rule },
                        )
                    }
                }
            }
        }
    }

    pendingDelete?.let { rule ->
        // 方案 §2「删除均显示影响范围」：正则规则走同一个确认框。
        // 引用计数这里是**真的零**——没有任何列存正则规则 id（本地库里没有 rule_id 类字段），
        // 所以骗人的「被 N 处引用」不该出现；真正的后果写在 extraWarning 里：
        // 停用/删除一条规则会改掉文本改写的链，而那串链是同步到别的设备上的。
        DeleteImpactDialog(
            itemName = rule.name.ifBlank { rule.pattern },
            impact = BindingImpact(characters = 0, sessions = 0),
            extraWarning = "它是「${rule.scope}」作用域、阶段「${rule.stage}」" +
                (if (rule.group.isBlank()) "" else "、分组「${rule.group}」") +
                (if (rule.enabled) "、当前启用" else "、当前已停用（停用不影响同步，只影响本机是否应用）") +
                "。删除后这条规则不再改写任何文本，其余规则的顺序**不会被重排**" +
                "（顺序就是链式替换的语义，对端也会看到同样的顺序）。",
            onConfirm = {
                pendingDelete = null
                vm.delete(rule.id)
            },
            onDismiss = { pendingDelete = null },
        )
    }
}

@Composable
private fun RegexRuleRow(
    rule: LocalRegexRuleEntity,
    onEdit: () -> Unit,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
    onToggle: (Boolean) -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(rule.name.ifBlank { "(未命名规则)" }, style = MaterialTheme.typography.titleSmall)
            Text(
                "/${rule.pattern}/${rule.flags}  ·  ${rule.scope}/${rule.stage}",
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        EditorSwitchRow(checked = rule.enabled, onCheckedChange = onToggle, label = "")
        IconButton(onClick = onMoveUp) {
            Icon(Icons.Filled.KeyboardArrowUp, contentDescription = "上移")
        }
        IconButton(onClick = onMoveDown) {
            Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "下移")
        }
        TextButton(onClick = onEdit) { Text("编辑") }
        IconButton(onClick = onDelete) { Icon(Icons.Filled.Delete, contentDescription = "删除") }
    }
}

@Composable
private fun RegexEditorPage(
    vm: RegexEditorViewModel,
    editor: RegexEditorViewModel.EditorState,
    test: RegexEditorViewModel.TestRun?,
    onBack: () -> Unit,
) {
    val draft = editor.draft ?: return
    val row = draft.draft
    var sample by remember { mutableStateOf("示例文本：把这段替换掉 {{var}}") }
    var scope by remember { mutableStateOf(row.scope) }
    var stage by remember { mutableStateOf(row.stage) }
    val exit = rememberEditorExitGuard(
        dirty = draft.dirty,
        onSaveAndClose = vm::save,
        onDiscardAndClose = vm::discardDraftAndClose,
        onLeave = onBack,
    )


    androidx.compose.material3.Scaffold(
        topBar = {
            AppTopBar(
                title = if (editor.ruleId == null) "新建规则" else "编辑规则",
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
            EditorFormBody {
                EditorSection("规则") {
                    EditorTextField(
                        value = row.name,
                        onValueChange = { value -> vm.edit { it.copy(name = value) } },
                        label = "名称",
                    )
                    EditorTextField(
                        value = row.pattern,
                        onValueChange = { value -> vm.edit { it.copy(pattern = value) } },
                        label = "匹配模式",
                        error = if (row.pattern.isBlank()) "模式不能为空" else null,
                        helper = "待处理文本上限 ${RegexCompatibility.MAX_TEXT_LENGTH} 字符，模式长度上限 $ChatRegexLimitNote 字符",
                    )
                    EditorTextField(
                        value = row.replacement,
                        onValueChange = { value -> vm.edit { it.copy(replacement = value) } },
                        label = "替换串",
                        helper = "支持 \$1..\$9、\$&、\$\$；其余字符（含反斜杠）按字面量处理，与 PC 一致",
                    )
                    EditorTextField(
                        value = row.flags,
                        onValueChange = { value -> vm.edit { it.copy(flags = value) } },
                        label = "标志",
                        helper = "g / i / m / s / y / u；其它字符视为非法",
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        RegexEditorViewModel.SCOPES.forEach { option ->
                            FilterChip(
                                selected = row.scope == option,
                                onClick = { vm.edit { it.copy(scope = option) } },
                                label = { Text(option) },
                            )
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        RegexEditorViewModel.STAGES.forEach { option ->
                            FilterChip(
                                selected = row.stage == option,
                                onClick = { vm.edit { it.copy(stage = option) } },
                                label = { Text(option) },
                            )
                        }
                    }
                }

                EditorSection("触发条件与停止符", collapsedByDefault = true) {
                    EditorTextField(
                        value = row.group,
                        onValueChange = { value -> vm.edit { it.copy(group = value) } },
                        label = "分组",
                        helper = "按用途组织（翻译修复 / 格式清理 / 越狱清理），空表示未分组",
                    )
                    EditorTextField(
                        value = row.triggerPattern,
                        onValueChange = { value -> vm.edit { it.copy(triggerPattern = value) } },
                        label = "触发条件模式",
                        helper = "留空表示总是执行",
                    )
                    EditorTextField(
                        value = row.triggerFlags,
                        onValueChange = { value -> vm.edit { it.copy(triggerFlags = value) } },
                        label = "触发条件标志",
                    )
                    EditorTextField(
                        value = RegexEditorViewModel.parseStopStrings(row.stopStringsJson).joinToString("\n"),
                        onValueChange = { value ->
                            vm.edit {
                                it.copy(
                                    stopStringsJson = RegexEditorViewModel.stopStringsJson(
                                        value.lines().map { line -> line.trim() }.filter { line -> line.isNotEmpty() },
                                    ),
                                )
                            }
                        },
                        label = "停止字符串（每行一条）",
                        minLines = 3,
                        helper = "仅 output 生效：命中即截断并终止输出",
                    )
                }

                EditorSection("启用") {
                    EditorSwitchRow(
                        checked = row.enabled,
                        onCheckedChange = { value -> vm.edit { it.copy(enabled = value) } },
                        label = "启用这条规则",
                        description = "未启用的规则不参与替换；测试台仍会预览它启用后的效果",
                    )
                }

                EditorSection("测试台") {
                    EditorTextField(
                        value = sample,
                        onValueChange = { sample = it },
                        label = "测试输入",
                        minLines = 3,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        RegexEditorViewModel.SCOPES.forEach { option ->
                            FilterChip(selected = scope == option, onClick = { scope = option }, label = { Text("作用域 $option") })
                        }
                    }
                    androidx.compose.material3.Button(
                        onClick = { vm.runTest(sample, scope, stage) },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("运行测试") }

                    test?.let { run -> TestResult(run) }
                }
            }

            EditorActionBar(
                dirty = draft.dirty,
                busy = editor.busy,
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

@Composable
private fun TestResult(run: RegexEditorViewModel.TestRun) {
    Column {
        EditorNote("工作量计数：${run.work}")
        when {
            !run.analysis.compiles -> EditorNote("模式无法编译：请把标志与语法改到两端都支持", isError = true)
            run.aborted -> EditorNote(
                "已按安全预算中止匹配（不是「没匹配上」）：这条规则会造成灾难性回溯，请改写",
                isError = true,
            )
            else -> {
                if (run.matched) {
                    EditorNote("命中。输出：")
                    Text(
                        run.output,
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    )
                } else {
                    EditorNote("未命中，输出与输入相同。")
                }
            }
        }
        if (run.analysis.backtrackingRisk.level != RegexCompatibility.RiskLevel.NONE) {
            EditorNote("回溯风险：${run.analysis.backtrackingRisk.reason}")
        }
        run.analysis.findings
            .filter { it.verdict != RegexCompatibility.Verdict.SUPPORTED }
            .forEach { finding ->
                EditorNote(
                    "[${finding.verdict}] ${finding.feature}：${finding.message}" +
                        (finding.suggestion?.let { "（建议：$it）" } ?: ""),
                    isError = finding.verdict == RegexCompatibility.Verdict.REJECTED,
                )
            }
    }
}

private const val ChatRegexLimitNote = 500
