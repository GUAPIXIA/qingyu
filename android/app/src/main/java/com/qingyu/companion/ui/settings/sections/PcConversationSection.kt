package com.qingyu.companion.ui.settings.sections

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.qingyu.companion.R
import com.qingyu.companion.data.settings.ConflictStrategy
import com.qingyu.companion.data.settings.FieldSyncState
import com.qingyu.companion.data.settings.SettingsProtocol
import com.qingyu.companion.data.settings.SettingsSyncStatus
import com.qingyu.companion.data.settings.renderFieldValue
import com.qingyu.companion.data.settings.settingsFieldValue
import com.qingyu.companion.ui.settings.SettingsViewModel
import com.qingyu.companion.ui.settings.components.SettingsNavRow
import com.qingyu.companion.ui.settings.components.SettingsSection
import com.qingyu.companion.ui.settings.fieldSyncStateWithRejections
import com.qingyu.companion.ui.settings.rejectionReasonFor
import com.qingyu.companion.ui.theme.qyColors

/**
 * PC 会话区（同步到当前 PC）+ 当前会话快捷入口
 * E-03 从 SettingsScreen 抽出，保留"同步到当前 PC"/"当前会话"分组文案与 chip 逻辑不动
 */
@Composable
fun PcConversationSection(
    vm: SettingsViewModel,
    ui: SettingsViewModel.UiState,
    onOpenChat: (() -> Unit)? = null,
) {
    val qy = qyColors()

    SettingsSection(
        title = stringResource(R.string.settings_section_pc_settings),
        tag = stringResource(R.string.settings_group_pc_sync),
    ) {
        PcSettingsContent(vm = vm, ui = ui)
    }

    if (onOpenChat != null) {
        SettingsSection(
            title = stringResource(R.string.settings_section_current_session),
            tag = stringResource(R.string.settings_group_current_session),
        ) {
            SettingsNavRow(
                title = stringResource(R.string.settings_current_session_jump),
                subtitle = stringResource(R.string.settings_current_session_jump_desc),
                onClick = onOpenChat,
            )
        }
    }
}

@Composable
private fun PcSettingsContent(vm: SettingsViewModel, ui: SettingsViewModel.UiState) {
    val qy = qyColors()
    val settings = ui.pcSettings
    val protocol = ui.syncProtocol
    val rejections = ui.rejectedFields
    fun stateFor(field: String): FieldSyncState = fieldSyncStateWithRejections(ui.syncStatus, field, rejections)
    fun reasonFor(field: String): String? = rejectionReasonFor(rejections, field)

    if (ui.activeConnection == null) {
        Text(
            stringResource(R.string.settings_pc_sync_disconnected_hint),
            style = MaterialTheme.typography.bodySmall,
            color = qy.muted,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
        )
        return
    }
    if (protocol == SettingsProtocol.LEGACY) {
        Text(
            stringResource(R.string.settings_pc_sync_legacy_hint),
            style = MaterialTheme.typography.labelSmall,
            color = qy.accent,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
        )
    }
    if (settings == null) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (ui.syncStatus is SettingsSyncStatus.Failed) {
                SyncFailedLabel(onRetry = vm::retrySync)
            } else {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = qy.accent)
                Spacer(Modifier.width(10.dp))
                Text(
                    stringResource(R.string.settings_sync_saving),
                    style = MaterialTheme.typography.bodySmall,
                    color = qy.soft,
                )
            }
        }
        return
    }
    if (ui.pcListsError != null) {
        Text(
            stringResource(R.string.settings_pc_lists_error, ui.pcListsError!!),
            style = MaterialTheme.typography.labelSmall,
            color = qy.danger,
            modifier = Modifier
                .padding(horizontal = 14.dp, vertical = 4.dp)
                .clickable { vm.refreshPcSettings() },
        )
    }

    PcTranslationLangRow(
        snapshotValue = settings.translationTargetLang,
        pending = ui.pendingChanges["translationTargetLang"] as? String,
        fieldState = stateFor("translationTargetLang"),
        failureDetail = reasonFor("translationTargetLang"),
        onRetry = vm::retrySync,
        onSave = { vm.commitPcField("translationTargetLang", it) },
    )
    val models = ui.pcModels
    if (ui.pcListsLoading) {
        Text(
            stringResource(R.string.settings_pc_active_model),
            style = MaterialTheme.typography.bodySmall,
            color = qy.muted,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
        )
    } else if (models.isNotEmpty()) {
        PcChoiceFieldRow(
            title = stringResource(R.string.settings_pc_active_model),
            displayValue = settings.activeModel.ifBlank {
                stringResource(R.string.settings_pc_active_model_empty)
            },
            options = models.map { it to it },
            selectedKey = settings.activeModel,
            fieldState = stateFor("activeModel"),
            failureDetail = reasonFor("activeModel"),
            onRetry = vm::retrySync,
            onSelect = { vm.commitPcField("activeModel", it) },
        )
    }
    PcSwitchRow(
        title = stringResource(R.string.settings_pc_stream_output),
        subtitle = stringResource(R.string.settings_pc_stream_output_desc),
        checked = (ui.pendingChanges["streamOutput"] as? Boolean) ?: settings.streamOutput,
        fieldState = stateFor("streamOutput"),
        failureDetail = reasonFor("streamOutput"),
        onRetry = vm::retrySync,
        onToggle = { vm.commitPcField("streamOutput", it) },
    )
    PcSwitchRow(
        title = stringResource(R.string.settings_pc_show_token_count),
        subtitle = stringResource(R.string.settings_pc_show_token_count_desc),
        checked = (ui.pendingChanges["showTokenCount"] as? Boolean) ?: settings.showTokenCount,
        fieldState = stateFor("showTokenCount"),
        failureDetail = reasonFor("showTokenCount"),
        onRetry = vm::retrySync,
        onToggle = { vm.commitPcField("showTokenCount", it) },
    )
    val ratioValue = ((ui.pendingChanges["lorebookRatio"] as? Double) ?: settings.lorebookRatio).toFloat()
    PcSliderRow(
        title = stringResource(R.string.settings_pc_lorebook_ratio),
        subtitle = stringResource(R.string.settings_pc_lorebook_ratio_desc, (ratioValue * 100).toInt()),
        value = ratioValue,
        fieldState = stateFor("lorebookRatio"),
        failureDetail = reasonFor("lorebookRatio"),
        onRetry = vm::retrySync,
        onValueChange = { v -> vm.changePcSlider("lorebookRatio", v.toDouble()) },
    )
    val presets = ui.pcPresets
    if (presets.isNotEmpty()) {
        val activePresetName = presets.firstOrNull { it.first == settings.activePresetId }?.second
        PcChoiceFieldRow(
            title = stringResource(R.string.settings_pc_preset),
            displayValue = activePresetName ?: stringResource(R.string.settings_pc_preset_default),
            options = presets.map { (id, name) -> name to id },
            selectedKey = settings.activePresetId ?: "",
            fieldState = stateFor("activePresetId"),
            failureDetail = reasonFor("activePresetId"),
            onRetry = vm::retrySync,
            onSelect = { vm.commitPcField("activePresetId", it) },
        )
    }

    (ui.syncStatus as? SettingsSyncStatus.Conflict)?.let { conflict ->
        ConflictPanel(
            conflict = conflict,
            onUseRemote = { vm.resolveConflict(ConflictStrategy.KeepLocalUseRemote) },
            onApplyLocal = { vm.resolveConflict(ConflictStrategy.ApplyLocalAgain) },
            onDismiss = { vm.resolveConflict(ConflictStrategy.Dismiss) },
        )
    }
}

@Composable
private fun SyncStateIndicator(state: FieldSyncState, failureDetail: String? = null, onRetry: () -> Unit) {
    val qy = qyColors()
    when (state) {
        FieldSyncState.Editing -> CircularProgressIndicator(
            Modifier.size(14.dp),
            strokeWidth = 2.dp,
            color = qy.accent,
        )
        FieldSyncState.Synced -> Icon(
            Icons.Filled.Check,
            contentDescription = stringResource(R.string.settings_sync_synced),
            tint = qy.ok,
            modifier = Modifier.size(16.dp),
        )
        FieldSyncState.Failed -> Text(
            if (failureDetail != null) {
                stringResource(R.string.settings_sync_rejected, failureDetail)
            } else {
                stringResource(R.string.settings_sync_failed)
            },
            style = MaterialTheme.typography.labelSmall,
            color = qy.danger,
            modifier = Modifier.clickable(onClick = onRetry),
        )
        FieldSyncState.Idle -> Unit
    }
}

@Composable
private fun SyncFailedLabel(onRetry: () -> Unit) {
    val qy = qyColors()
    Text(
        stringResource(R.string.settings_sync_failed),
        style = MaterialTheme.typography.bodySmall,
        color = qy.danger,
        modifier = Modifier.clickable(onClick = onRetry),
    )
}

@Composable
private fun PcSwitchRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    fieldState: FieldSyncState,
    failureDetail: String? = null,
    onRetry: () -> Unit,
    onToggle: (Boolean) -> Unit,
) {
    val qy = qyColors()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = qy.text)
            Spacer(Modifier.height(2.dp))
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = qy.soft)
        }
        Spacer(Modifier.width(8.dp))
        SyncStateIndicator(fieldState, failureDetail = failureDetail, onRetry = onRetry)
        Spacer(Modifier.width(8.dp))
        Switch(checked = checked, onCheckedChange = onToggle)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PcChoiceFieldRow(
    title: String,
    displayValue: String,
    options: List<Pair<String, String>>,
    selectedKey: String,
    fieldState: FieldSyncState,
    failureDetail: String? = null,
    onRetry: () -> Unit,
    onSelect: (String) -> Unit,
) {
    val qy = qyColors()
    var showSheet by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .clickable { showSheet = true }
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = qy.text)
            Spacer(Modifier.height(2.dp))
            Text(
                displayValue,
                style = MaterialTheme.typography.bodySmall,
                color = qy.soft,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        SyncStateIndicator(fieldState, failureDetail = failureDetail, onRetry = onRetry)
        Icon(
            Icons.Filled.ChevronRight,
            contentDescription = null,
            tint = qy.muted,
            modifier = Modifier.padding(start = 8.dp),
        )
    }
    if (showSheet) {
        ModalBottomSheet(
            onDismissRequest = { showSheet = false },
            containerColor = qy.card,
        ) {
            Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
                Text(
                    title,
                    style = MaterialTheme.typography.titleMedium,
                    color = qy.text,
                    modifier = Modifier.padding(start = 16.dp, top = 4.dp, bottom = 8.dp),
                )
                options.forEach { (label, value) ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                showSheet = false
                                if (value != selectedKey) onSelect(value)
                            }
                            .padding(horizontal = 20.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            label,
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (value == selectedKey) qy.accent else qy.text,
                            modifier = Modifier.weight(1f),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (value == selectedKey) {
                            Icon(Icons.Filled.Check, null, tint = qy.accent, modifier = Modifier.size(16.dp))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PcSliderRow(
    title: String,
    subtitle: String,
    value: Float,
    fieldState: FieldSyncState,
    failureDetail: String? = null,
    onRetry: () -> Unit,
    onValueChange: (Float) -> Unit,
) {
    val qy = qyColors()
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = qy.text, modifier = Modifier.weight(1f))
            Text(
                "${(value * 100).toInt()}%",
                style = MaterialTheme.typography.labelMedium,
                color = qy.accent,
            )
            Spacer(Modifier.width(8.dp))
            SyncStateIndicator(fieldState, failureDetail = failureDetail, onRetry = onRetry)
        }
        Text(
            subtitle,
            style = MaterialTheme.typography.bodySmall,
            color = qy.soft,
        )
        Slider(
            value = value.coerceIn(0f, 1f),
            onValueChange = onValueChange,
            valueRange = 0f..1f,
            colors = SliderDefaults.colors(
                thumbColor = qy.accent,
                activeTrackColor = qy.accent,
                inactiveTrackColor = qy.line,
            ),
        )
    }
}

@Composable
private fun PcTranslationLangRow(
    snapshotValue: String,
    pending: String?,
    fieldState: FieldSyncState,
    failureDetail: String? = null,
    onRetry: () -> Unit,
    onSave: (String) -> Unit,
) {
    val qy = qyColors()
    var text by remember(snapshotValue) { mutableStateOf(pending ?: snapshotValue) }
    Column(Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.settings_pc_translation_lang),
                style = MaterialTheme.typography.bodyLarge,
                color = qy.text,
                modifier = Modifier.weight(1f),
            )
            SyncStateIndicator(fieldState, failureDetail = failureDetail, onRetry = onRetry)
        }
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it.take(32) },
                modifier = Modifier.weight(1f),
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = qy.text),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = qy.accent,
                    unfocusedBorderColor = qy.line,
                    focusedContainerColor = qy.bg,
                    unfocusedContainerColor = qy.bg,
                    cursorColor = qy.accent,
                ),
            )
            Spacer(Modifier.width(8.dp))
            Surface(
                onClick = {
                    val trimmed = text.trim()
                    if (trimmed.isNotEmpty()) onSave(trimmed)
                },
                shape = RoundedCornerShape(50),
                color = qy.accentSoft,
            ) {
                Text(
                    stringResource(R.string.action_save),
                    style = MaterialTheme.typography.labelMedium,
                    color = qy.accent,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                )
            }
        }
        Text(
            stringResource(R.string.settings_pc_translation_lang_hint),
            style = MaterialTheme.typography.labelSmall,
            color = qy.muted,
            modifier = Modifier.padding(top = 4.dp),
        )
    }
}

@Composable
private fun ConflictPanel(
    conflict: SettingsSyncStatus.Conflict,
    onUseRemote: () -> Unit,
    onApplyLocal: () -> Unit,
    onDismiss: () -> Unit,
) {
    val qy = qyColors()
    Surface(
        color = qy.danger.copy(alpha = 0.10f),
        shape = RoundedCornerShape(14.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, qy.danger.copy(alpha = 0.5f)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
            Text(
                stringResource(R.string.settings_sync_conflict_title),
                style = MaterialTheme.typography.titleSmall,
                color = qy.danger,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                stringResource(R.string.settings_sync_conflict_message),
                style = MaterialTheme.typography.bodySmall,
                color = qy.text,
            )
            Spacer(Modifier.height(8.dp))
            conflict.local.fields.sorted().forEach { field ->
                val remoteValue = settingsFieldValue(conflict.remote.values, field)
                val localValue = conflict.local.values[field]
                Column(Modifier.padding(vertical = 4.dp)) {
                    Text(field, style = MaterialTheme.typography.labelMedium, color = qy.text)
                    Text(
                        stringResource(R.string.settings_sync_conflict_pc_value, renderFieldValue(remoteValue)),
                        style = MaterialTheme.typography.bodySmall,
                        color = qy.soft,
                    )
                    Text(
                        stringResource(R.string.settings_sync_conflict_local_value, renderFieldValue(localValue)),
                        style = MaterialTheme.typography.bodySmall,
                        color = qy.accent,
                    )
                }
            }
            Spacer(Modifier.height(10.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onDismiss) {
                    Text(stringResource(R.string.action_close), color = qy.soft)
                }
                TextButton(onClick = onApplyLocal) {
                    Text(stringResource(R.string.settings_sync_conflict_apply_local), color = qy.danger)
                }
                TextButton(onClick = onUseRemote) {
                    Text(stringResource(R.string.settings_sync_conflict_use_remote), color = qy.accent)
                }
            }
        }
    }
}
