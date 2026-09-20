package com.qingyu.companion.ui.settings.connection

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.security.ConnectionProfileView
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.theme.qyColors

/**
 * 阶段 3 S3-06：模型管理页。
 * 保存 public 字段与 secret 是两个明确事务；界面只显示掩码与「已配置/未配置」。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConnectionProfilesScreen(onBack: () -> Unit) {
    val container = LocalAppContainer.current
    val vm: ConnectionProfilesViewModel = viewModel(
        factory = viewModelFactory {
            initializer {
                ConnectionProfilesViewModel(container.connectionProfileRepository, container.modelClient)
            }
        },
    )
    val profiles by vm.profiles.collectAsStateWithLifecycle()
    val editor by vm.editor.collectAsStateWithLifecycle()
    val testing by vm.testing.collectAsStateWithLifecycle()
    val testResult by vm.testResult.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("模型连接档案") },
                navigationIcon = { TextButton(onClick = onBack) { Text("返回") } },
                actions = {
                    IconButton(onClick = { vm.startCreate() }) {
                        Icon(Icons.Filled.Add, contentDescription = "新增连接档案")
                    }
                },
            )
        },
    ) { padding ->
        AppBackground {
            Column(Modifier.fillMaxSize().padding(padding)) {
                if (profiles.isEmpty()) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("还没有连接档案。新增一个后即可不依赖电脑直接对话。", color = qyColors().soft)
                    }
                } else {
                    LazyColumn(Modifier.fillMaxSize()) {
                        items(profiles, key = { it.id }) { view ->
                            ProfileCard(
                                view = view,
                                testing = testing,
                                onEdit = { vm.startEdit(view) },
                                onDelete = { vm.delete(view.id) },
                                onToggle = { vm.toggleEnabled(view) },
                                onTest = { vm.testSavedProfile(view) },
                                onMoveUp = { vm.move(view.id, -1) },
                                onMoveDown = { vm.move(view.id, 1) },
                            )
                        }
                    }
                }
            }
        }
    }

    editor?.let { state ->
        EditorDialog(
            state = state,
            testing = testing,
            testResult = testResult?.takeIf { it.ok || it.error != null },
            onDismiss = { vm.closeEditor() },
            onChange = { transform -> vm.update(transform) },
            onProvider = { vm.onProviderChanged(it) },
            onSave = { vm.save() },
        )
    }
}

@Composable
private fun ProfileCard(
    view: ConnectionProfileView,
    testing: Boolean,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onToggle: () -> Unit,
    onTest: () -> Unit,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
) {
    Card(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(view.displayName, fontWeight = FontWeight.SemiBold, color = qyColors().text)
                    Text(
                        "${view.provider} · ${view.model}",
                        style = MaterialTheme.typography.bodySmall,
                        color = qyColors().soft,
                    )
                    Text(
                        view.baseUrl,
                        style = MaterialTheme.typography.bodySmall,
                        color = qyColors().muted,
                    )
                    Text(
                        view.maskedSecretHint(),
                        style = MaterialTheme.typography.bodySmall,
                        color = if (view.secretConfigured) qyColors().ok else qyColors().warn,
                    )
                }
                Switch(checked = view.enabled, onCheckedChange = { onToggle() })
            }
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = onTest, enabled = !testing) {
                    if (testing) {
                        CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(14.dp))
                    } else {
                        Text("测试连接")
                    }
                }
                Spacer(Modifier.width(8.dp))
                IconButton(onClick = onEdit) { Icon(Icons.Filled.Edit, contentDescription = "编辑") }
                IconButton(onClick = onMoveUp) { Icon(Icons.Filled.KeyboardArrowUp, contentDescription = "上移") }
                IconButton(onClick = onMoveDown) { Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "下移") }
                Spacer(Modifier.weight(1f))
                IconButton(onClick = onDelete) { Icon(Icons.Filled.Delete, contentDescription = "删除") }
            }
        }
    }
}

@Composable
private fun EditorDialog(
    state: ConnectionProfilesViewModel.EditorState,
    testing: Boolean,
    testResult: com.qingyu.companion.network.models.ConnectionTestResult?,
    onDismiss: () -> Unit,
    onChange: ((ConnectionProfilesViewModel.EditorState) -> ConnectionProfilesViewModel.EditorState) -> Unit,
    onProvider: (ModelProvider) -> Unit,
    onSave: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (state.id == null) "新增连接档案" else "编辑连接档案") },
        text = {
            Column {
                OutlinedTextField(
                    value = state.displayName,
                    onValueChange = { value -> onChange { it.copy(displayName = value) } },
                    label = { Text("显示名称") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ModelProvider.entries.forEach { provider ->
                        FilterChip(
                            selected = state.provider == provider,
                            onClick = { onProvider(provider) },
                            label = { Text(provider.wire) },
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = state.baseUrl,
                    onValueChange = { value -> onChange { it.copy(baseUrl = value) } },
                    label = { Text("Base URL") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = state.model,
                    onValueChange = { value -> onChange { it.copy(model = value) } },
                    label = { Text("模型名") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = state.apiKeyInput,
                    onValueChange = { value -> onChange { it.copy(apiKeyInput = value, replacingKey = true) } },
                    label = { Text(if (state.id == null) "API Key" else "替换 API Key（留空则保留原密钥）") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(autoCorrect = false),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(
                        checked = state.allowHttp,
                        onCheckedChange = { value -> onChange { it.copy(allowHttp = value) } },
                    )
                    Spacer(Modifier.width(8.dp))
                    Text("允许明文 HTTP（Ollama / 内网网关）", style = MaterialTheme.typography.bodySmall)
                }
                state.error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = qyColors().danger, style = MaterialTheme.typography.bodySmall)
                }
                testResult?.let { result ->
                    Spacer(Modifier.height(8.dp))
                    Text(
                        if (result.ok) {
                            "连接成功（${result.latencyMs} ms）"
                        } else {
                            // 展示边界脱敏：连接测试失败时供应商响应体可能回显请求内容（含 key/路径）
                            val message = result.error?.toUserMessage() ?: "未知错误"
                            "连接失败：${com.qingyu.companion.chatcore.ChatDomainErrors.sanitizeErrorMessage(message)}"
                        },
                        color = if (result.ok) qyColors().ok else qyColors().danger,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        },
        confirmButton = {
            Button(onClick = onSave, enabled = !state.saving) { Text("保存") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        },
    )
}
