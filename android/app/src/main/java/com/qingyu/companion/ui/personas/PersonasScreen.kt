package com.qingyu.companion.ui.personas

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import com.qingyu.companion.local.db.LocalPersonaEntity
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.QyEmptyState
import com.qingyu.companion.ui.components.QyErrorBanner
import com.qingyu.companion.ui.content.DeleteImpactDialog
import com.qingyu.companion.ui.content.EditorActionBar
import com.qingyu.companion.ui.content.EditorFormBody
import com.qingyu.companion.ui.content.EditorNote
import com.qingyu.companion.ui.content.EditorSection
import com.qingyu.companion.ui.content.EditorSwitchRow
import com.qingyu.companion.ui.content.EditorTextField
import com.qingyu.companion.ui.content.rememberEditorExitGuard
import com.qingyu.companion.ui.content.rememberMultiDocumentPicker

/**
 * 阶段 5 S5-04：人设列表与编辑页。
 *
 * 「设为默认」在列表上是直接动作（不是草稿字段）：它是互斥单值，
 * 走草稿会让人以为勾了就生效，而实际要等保存。
 */
@Composable
fun PersonasScreen(onBack: () -> Unit) {
    // 必须在组合期取容器：viewModelInitializer 在组合之外运行，那里读不到 CompositionLocal
    val appContainer = LocalAppContainer.current
    val context = LocalContext.current
    val vm: PersonaEditorViewModel = viewModel(factory = viewModelFactory {
        initializer {
            PersonaEditorViewModel(
                store = appContainer.localSyncRepository,
                mediaRoot = java.io.File(context.filesDir, "media"),
                drafts = appContainer.contentDraftStore,
            )
        }
    })

    val list by vm.list.collectAsStateWithLifecycle()
    val editor by vm.editor.collectAsStateWithLifecycle()

    if (editor.draft != null) {
        PersonaEditorPage(vm = vm, editor = editor, onBack = vm::clearEditor)
        return
    }

    Scaffold(
        topBar = {
            AppTopBar(
                title = "人设",
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
                text = { Text("新建人设") },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            list.error?.let { QyErrorBanner(message = it, onRetry = vm::refresh) }
            EditorNote("人设描述的是「我」这个角色；宏 {{user}} 会取这里的名称。")
            if (list.personas.isEmpty() && !list.loading) {
                QyEmptyState(title = "还没有人设", description = "至少建一个：会话需要默认人设来决定 {{user}} 是谁")
            } else {
                LazyColumn(contentPadding = PaddingValues(vertical = 8.dp)) {
                    items(list.personas, key = { it.id }) { persona ->
                        PersonaRow(
                            persona = persona,
                            avatarFile = vm.avatarFile(persona.avatarPath),
                            onEdit = { vm.startEdit(persona.id) },
                            onSetDefault = { vm.makeDefault(persona.id) },
                            onDelete = { vm.inspectDelete(persona.id) },
                        )
                    }
                }
            }
        }
    }

    editor.impact?.let { impact ->
        val targetId = editor.personaId
        val name = list.personas.firstOrNull { it.id == targetId }?.name ?: "该人设"
        DeleteImpactDialog(
            itemName = name,
            impact = impact,
            extraWarning = if (targetId != null && list.personas.firstOrNull { it.id == targetId }?.isDefault == true) {
                "这是当前默认人设，删除后会指定另一个人设为默认。"
            } else {
                null
            },
            onConfirm = { if (targetId != null) vm.confirmDelete(targetId) },
            onDismiss = vm::clearEditor,
        )
    }
}

@Composable
private fun PersonaRow(
    persona: LocalPersonaEntity,
    avatarFile: java.io.File?,
    onEdit: () -> Unit,
    onSetDefault: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        if (avatarFile != null) {
            AsyncImage(
                model = avatarFile,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(40.dp).clip(CircleShape),
            )
        } else {
            // 没头像时用首字占位，避免一片空圆圈看起来像加载失败
            Surface(shape = CircleShape, modifier = Modifier.size(40.dp), content = {})
        }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    persona.name.ifBlank { "(未命名人设)" },
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (persona.isDefault) {
                    Spacer(Modifier.height(0.dp))
                    TextButton(onClick = onSetDefault, enabled = false) { Text("默认") }
                } else {
                    TextButton(onClick = onSetDefault) { Text("设为默认") }
                }
            }
            if (persona.description.isNotBlank()) {
                Text(
                    persona.description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        IconButton(onClick = onEdit) { Icon(Icons.Filled.Edit, contentDescription = "编辑") }
        IconButton(onClick = onDelete) { Icon(Icons.Filled.Delete, contentDescription = "删除") }
    }
}

@Composable
private fun PersonaEditorPage(
    vm: PersonaEditorViewModel,
    editor: PersonaEditorViewModel.EditorState,
    onBack: () -> Unit,
) {
    val draft = editor.draft ?: return
    val row = draft.draft
    val exit = rememberEditorExitGuard(
        dirty = draft.dirty,
        onSaveAndClose = vm::save,
        onDiscardAndClose = vm::discardDraftAndClose,
        onLeave = onBack,
    )
    var avatarError by remember { mutableStateOf<String?>(null) }
    val pickAvatar = rememberMultiDocumentPicker(mimeTypes = AVATAR_MIME_TYPES, maxFiles = 1) { documents ->
        val first = documents.firstOrNull()
        avatarError = if (first == null) "未选择文件" else vm.attachAvatar(first)
    }

    Scaffold(
        topBar = {
            AppTopBar(
                title = if (editor.personaId == null) "新建人设" else "编辑人设",
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
                EditorSection("基本信息") {
                    EditorTextField(
                        value = row.name,
                        onValueChange = { value -> vm.edit { it.copy(name = value) } },
                        label = "名称",
                        error = if (row.name.isBlank()) "名称不能为空（{{user}} 会取它）" else null,
                    )
                    EditorTextField(
                        value = row.description,
                        onValueChange = { value -> vm.edit { it.copy(description = value) } },
                        label = "说明",
                        minLines = 2,
                        helper = "只用于列表辨认，不注入上下文",
                    )
                    EditorTextField(
                        value = row.persona,
                        onValueChange = { value -> vm.edit { it.copy(persona = value) } },
                        label = "人设内容",
                        minLines = 5,
                        helper = "注入到上下文里的「我是谁」正文",
                    )
                }
                EditorSection("头像") {
                    TextButton(onClick = { pickAvatar() }) { Text("选择头像图片") }
                    avatarError?.let { EditorNote(it, isError = true) }
                    EditorNote(
                        if (row.avatarPath != null) {
                            "已选图片（按内容寻址落盘）；若放弃本次编辑，该文件只是不再被引用"
                        } else {
                            "尚未选择"
                        },
                    )
                }
                EditorSection("默认") {
                    com.qingyu.companion.ui.content.EditorSwitchRow(
                        checked = row.isDefault,
                        onCheckedChange = { value -> vm.edit { it.copy(isDefault = value) } },
                        label = "设为默认人设",
                        description = "新会话默认使用这个人设；同一时刻只能有一个默认",
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
                // 恢复出来的内容必须说明来源，否则用户会以为库里已经是这样
                EditorNote("已恢复上次未保存的草稿（尚未保存为一次变更）")
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

private val AVATAR_MIME_TYPES = arrayOf("image/png", "image/jpeg", "image/webp", "image/gif")
