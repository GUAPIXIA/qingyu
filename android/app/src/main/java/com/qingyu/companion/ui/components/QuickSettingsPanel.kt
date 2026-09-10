package com.qingyu.companion.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.qingyu.companion.R
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.model.LorebookDto
import com.qingyu.companion.model.PresetDto
import com.qingyu.companion.ui.theme.qyColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch


/**
 * 对话快捷设置面板（桥接层第一批端点）：
 * - 世界书选择：勾选当前会话激活的世界书，保存后写会话（PATCH /sessions/:id/lorebooks）；
 * - 预设切换：点击即切换全局 activePresetId（PATCH /sessions/:id/preset）。
 * 数据来自 GET /settings、/lorebooks、/presets、会话级端点。
 * 全部文案走 strings.xml（qs_*）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuickSettingsPanel(sessionId: String, characterId: String? = null, onDismiss: () -> Unit) {
    val container = LocalAppContainer.current
    val qy = qyColors()
    val scope = rememberCoroutineScope()
    var lorebooks by remember { mutableStateOf<List<LorebookDto>>(emptyList()) }
    var presets by remember { mutableStateOf<List<PresetDto>>(emptyList()) }
    var activeLorebookIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var activePresetId by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var savedFlash by remember { mutableStateOf(false) }
    var models by remember { mutableStateOf<List<String>>(emptyList()) }
    var activeModel by remember { mutableStateOf("") }
    var modelsLoading by remember { mutableStateOf(false) }
    var memory by remember { mutableStateOf<com.qingyu.companion.model.MemoryDto?>(null) }
    var summarizingMemory by remember { mutableStateOf(false) }
    var translationLang by remember { mutableStateOf("") }

    // 错误回退文案（composable 上下文取好，供协程 lambda 使用）
    val loadFailedLabel = stringResource(R.string.qs_load_failed)
    val saveFailedLabel = stringResource(R.string.qs_save_failed)
    val switchFailedLabel = stringResource(R.string.qs_switch_failed)
    val adjustFailedLabel = stringResource(R.string.qs_adjust_failed)
    val summarizeFailedLabel = stringResource(R.string.qs_summarize_failed)
    val summarizeLoadingLabel = stringResource(R.string.qs_memory_summarizing)

    LaunchedEffect(Unit) {
        runCatching {
            val lb = container.repository.listLorebooks()
            val ps = container.repository.listPresets()
            val activeLb = container.repository.getSessionLorebooks(sessionId)
            val activePs = container.repository.getSessionPreset(sessionId)
            val settings = container.repository.getSettings()
            val mem = container.repository.getSessionMemory(sessionId, characterId)
            lorebooks = lb
            presets = ps
            activeLorebookIds = activeLb.toSet()
            activePresetId = activePs
            activeModel = settings.activeModel
            memory = mem
            translationLang = settings.translationTargetLang
        }
            .onSuccess { loading = false }
            .onFailure { error = it.message ?: loadFailedLabel }
    }

    // 模型列表单独拉取（依赖 PC 端 API 连接，可能失败或较慢）
    LaunchedEffect(Unit) {
        modelsLoading = true
        runCatching { container.repository.listModels() }
            .onSuccess { models = it }
        modelsLoading = false
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = qy.card,
        shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
        tonalElevation = 0.dp,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(bottom = 28.dp),
        ) {
            // 标题区（居中）
            Text(
                stringResource(R.string.qs_title),
                style = MaterialTheme.typography.titleLarge,
                color = qy.text,
                modifier = Modifier.fillMaxWidth(),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
            Spacer(Modifier.height(2.dp))
            Text(
                stringResource(R.string.qs_subtitle),
                style = MaterialTheme.typography.labelSmall,
                color = qy.muted,
                modifier = Modifier.fillMaxWidth(),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
            Spacer(Modifier.height(14.dp))

            when {
                loading -> Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(24.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(color = qy.accent)
                }

                error != null -> {
                    Surface(
                        color = qy.danger.copy(alpha = 0.12f),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            error ?: loadFailedLabel,
                            color = qy.danger,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                        )
                    }
                    Spacer(Modifier.height(10.dp))
                    Surface(
                        onClick = onDismiss,
                        shape = RoundedCornerShape(50),
                        color = qy.bg2,
                        modifier = Modifier.align(Alignment.CenterHorizontally),
                    ) {
                        Text(
                            stringResource(R.string.qs_close),
                            style = MaterialTheme.typography.bodySmall,
                            color = qy.soft,
                            modifier = Modifier.padding(horizontal = 20.dp, vertical = 7.dp),
                        )
                    }
                }

                else -> {
                    // ---- 世界书 ----
                    PanelSection(stringResource(R.string.qs_section_lorebook)) {
                        if (lorebooks.isEmpty()) {
                            EmptyHint(stringResource(R.string.qs_lorebook_empty))
                        } else {
                            LazyColumn(
                                Modifier.heightIn(max = 200.dp),
                                verticalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                items(lorebooks, key = { it.id }) { lb ->
                                    val checked = lb.id in activeLorebookIds
                                    CheckRow(
                                        checked = checked,
                                        title = lb.name,
                                        subtitle = lb.description.takeIf { it.isNotBlank() },
                                        trailing = stringResource(R.string.qs_lorebook_count_fmt, lb.entryCount),
                                        onToggle = {
                                            activeLorebookIds =
                                                if (checked) activeLorebookIds - lb.id else activeLorebookIds + lb.id
                                        },
                                    )
                                }
                            }
                            Spacer(Modifier.height(8.dp))
                            // 保存按钮（胶囊）
                            Surface(
                                onClick = {
                                    scope.launch {
                                        saving = true
                                        runCatching {
                                            container.repository.setSessionLorebooks(sessionId, activeLorebookIds.toList())
                                        }
                                            .onSuccess {
                                                savedFlash = true
                                                delay(1500)
                                                savedFlash = false
                                            }
                                            .onFailure { error = it.message ?: saveFailedLabel }
                                        saving = false
                                    }
                                },
                                enabled = !saving,
                                shape = RoundedCornerShape(50),
                                color = if (savedFlash) qy.ok.copy(alpha = 0.15f) else qy.accent,
                                contentColor = if (savedFlash) qy.ok else qy.onAccent,
                            ) {
                                Row(
                                    Modifier.padding(horizontal = 18.dp, vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    if (saving) {
                                        CircularProgressIndicator(
                                            Modifier.size(14.dp),
                                            strokeWidth = 2.dp,
                                            color = qy.onAccent,
                                        )
                                    } else {
                                        Text(
                                            stringResource(if (savedFlash) R.string.qs_lorebook_saved else R.string.qs_lorebook_save),
                                            style = MaterialTheme.typography.bodySmall,
                                        )
                                    }
                                }
                            }
                        }
                    }

                    // ---- 预设 ----
                    PanelSection(stringResource(R.string.qs_section_preset)) {
                        if (presets.isEmpty()) {
                            EmptyHint(stringResource(R.string.qs_preset_empty))
                        } else {
                            LazyColumn(
                                Modifier.heightIn(max = 250.dp),
                                verticalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                items(presets, key = { it.id }) { p ->
                                    val selected = p.id == activePresetId
                                    val apply: () -> Unit = {
                                        activePresetId = p.id
                                        scope.launch {
                                            runCatching { container.repository.setSessionPreset(sessionId, p.id) }
                                                .onFailure { error = it.message ?: switchFailedLabel }
                                        }
                                        Unit
                                    }
                                    SelectRow(
                                        selected = selected,
                                        title = p.name,
                                        subtitle = stringResource(R.string.qs_preset_params_fmt, p.temperature, p.topP, p.maxTokens),
                                        onClick = apply,
                                    )
                                }
                            }
                        }
                    }

                    // ---- 模型 ----
                    PanelSection(stringResource(R.string.qs_section_model)) {
                        when {
                            modelsLoading -> Box(
                                Modifier
                                    .fillMaxWidth()
                                    .padding(10.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = qy.accent)
                            }

                            models.isEmpty() -> EmptyHint(stringResource(R.string.qs_model_empty_fmt))

                            else -> {
                                ValueRow(stringResource(R.string.settings_pc_active_model), activeModel.ifBlank { stringResource(R.string.qs_model_unset) })
                                Spacer(Modifier.height(6.dp))
                                LazyColumn(
                                    Modifier.heightIn(max = 210.dp),
                                    verticalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    items(models) { model ->
                                        val selected = model == activeModel
                                        val applyModel: () -> Unit = {
                                            activeModel = model
                                            scope.launch {
                                                runCatching { container.repository.updateSettings(mapOf("activeModel" to model)) }
                                                    .onFailure { error = it.message ?: switchFailedLabel }
                                            }
                                            Unit
                                        }
                                        SelectRow(
                                            selected = selected,
                                            title = model,
                                            onClick = applyModel,
                                        )
                                    }
                                }
                            }
                        }
                    }

                    // ---- 采样参数（对齐 PC 端：温度/TopP 只读展示，MaxToken 可调） ----
                    PanelSection(stringResource(R.string.qs_section_sampling)) {
                        val activePresetObj = presets.firstOrNull { it.id == activePresetId }
                        if (activePresetObj != null) {
                            ValueRow(stringResource(R.string.qs_current_preset), activePresetObj.name)
                            ValueRow(stringResource(R.string.qs_temp_top_p), "${activePresetObj.temperature} / ${activePresetObj.topP}")
                            Spacer(Modifier.height(8.dp))
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                listOf(512, 1024, 2048, 4096).forEach { n ->
                                    val selected = activePresetObj.maxTokens == n
                                    Surface(
                                        onClick = {
                                            val targetId = activePresetId
                                            if (targetId != null) {
                                                scope.launch {
                                                    runCatching {
                                                        val newId = container.repository.updatePreset(targetId, maxTokens = n)
                                                        // 内置预设变副本：更新会话指向副本
                                                        if (newId != null && newId != targetId) {
                                                            activePresetId = newId
                                                            container.repository.setSessionPreset(sessionId, newId)
                                                        }
                                                        presets = container.repository.listPresets()
                                                    }
                                                        .onFailure { error = it.message ?: adjustFailedLabel }
                                                }
                                            }
                                        },
                                        shape = RoundedCornerShape(50),
                                        color = if (selected) qy.accentSoft else qy.bg2,
                                        border = if (selected) {
                                            androidx.compose.foundation.BorderStroke(1.dp, qy.accent.copy(alpha = 0.6f))
                                        } else {
                                            null
                                        },
                                        modifier = Modifier.weight(1f),
                                    ) {
                                        Text(
                                            "$n",
                                            style = MaterialTheme.typography.labelMedium,
                                            color = if (selected) qy.accent else qy.soft,
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .padding(vertical = 7.dp),
                                            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                                        )
                                    }
                                }
                            }
                        } else {
                            EmptyHint(stringResource(R.string.qs_sampling_none))
                        }
                    }

                    // ---- 长记忆 ----
                    PanelSection(stringResource(R.string.qs_section_memory)) {
                        val mem = memory
                        when {
                            mem == null -> EmptyHint(stringResource(R.string.qs_memory_loading))

                            else -> {
                                // 启用开关（卡片行）
                                CardRow {
                                    Column(Modifier.weight(1f)) {
                                        Text(stringResource(R.string.msg_enable_long_memory), style = MaterialTheme.typography.bodyLarge, color = qy.text)
                                        Text(
                                            stringResource(R.string.qs_memory_enable_desc),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = qy.muted,
                                        )
                                    }
                                    Switch(
                                        checked = mem.memoryEnabled,
                                        onCheckedChange = { c ->
                                            memory = mem.copy(memoryEnabled = c)
                                            scope.launch {
                                                runCatching { container.repository.patchSessionMemory(sessionId, memoryEnabled = c, characterId = characterId) }
                                                    .onFailure { error = it.message ?: saveFailedLabel }
                                            }
                                        },
                                        colors = SwitchDefaults.colors(
                                            checkedTrackColor = qy.accent,
                                            checkedThumbColor = qy.onAccent,
                                            uncheckedTrackColor = qy.line,
                                            uncheckedThumbColor = qy.soft,
                                        ),
                                    )
                                }
                                Spacer(Modifier.height(6.dp))
                                // 模式选择（卡片行）
                                CardRow(verticalPadding = 10) {
                                    Text(
                                        stringResource(R.string.qs_memory_mode),
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = qy.text,
                                        modifier = Modifier.weight(1f),
                                    )
                                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                        listOf(
                                            "manual" to stringResource(R.string.qs_memory_mode_manual),
                                            "auto" to stringResource(R.string.qs_memory_mode_auto),
                                        ).forEach { (mode, label) ->
                                            val selected = mem.memoryMode == mode
                                            Surface(
                                                onClick = {
                                                    memory = mem.copy(memoryMode = mode)
                                                    scope.launch {
                                                        runCatching { container.repository.patchSessionMemory(sessionId, memoryMode = mode, characterId = characterId) }
                                                            .onFailure { error = it.message ?: saveFailedLabel }
                                                    }
                                                },
                                                shape = RoundedCornerShape(50),
                                                color = if (selected) qy.accentSoft else qy.bg,
                                                border = if (selected) {
                                                    androidx.compose.foundation.BorderStroke(1.dp, qy.accent.copy(alpha = 0.6f))
                                                } else {
                                                    null
                                                },
                                            ) {
                                                Text(
                                                    label,
                                                    style = MaterialTheme.typography.labelMedium,
                                                    color = if (selected) qy.accent else qy.soft,
                                                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 5.dp),
                                                )
                                            }
                                        }
                                    }
                                }
                                // 自动模式：间隔（卡片行）
                                if (mem.memoryMode == "auto") {
                                    Spacer(Modifier.height(6.dp))
                                    CardRow(verticalPadding = 10) {
                                        Text(
                                            stringResource(R.string.qs_memory_interval),
                                            style = MaterialTheme.typography.bodyLarge,
                                            color = qy.text,
                                        )
                                        Spacer(Modifier.width(10.dp))
                                        var intervalText by remember(mem.autoMemoryInterval) { mutableStateOf(mem.autoMemoryInterval.toString()) }
                                        OutlinedTextField(
                                            value = intervalText,
                                            onValueChange = { intervalText = it.filter { c -> c.isDigit() }.take(3) },
                                            modifier = Modifier.width(64.dp),
                                            singleLine = true,
                                            textStyle = MaterialTheme.typography.bodySmall.copy(color = qy.text),
                                            colors = OutlinedTextFieldDefaults.colors(
                                                focusedBorderColor = qy.accent,
                                                unfocusedBorderColor = qy.line,
                                                focusedContainerColor = qy.bg,
                                                unfocusedContainerColor = qy.bg,
                                                cursorColor = qy.accent,
                                            ),
                                        )
                                        Text(
                                            stringResource(R.string.qs_memory_interval_msgs),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = qy.muted,
                                            modifier = Modifier.padding(horizontal = 6.dp),
                                        )
                                        Spacer(Modifier.weight(1f))
                                        Surface(
                                            onClick = {
                                                val n = intervalText.toIntOrNull()?.coerceIn(4, 50) ?: return@Surface
                                                memory = mem.copy(autoMemoryInterval = n)
                                                scope.launch {
                                                    runCatching { container.repository.patchSessionMemory(sessionId, autoMemoryInterval = n, characterId = characterId) }
                                                        .onFailure { error = it.message ?: saveFailedLabel }
                                                }
                                            },
                                            shape = RoundedCornerShape(50),
                                            color = qy.accentSoft,
                                        ) {
                                            Text(
                                                stringResource(R.string.qs_save),
                                                style = MaterialTheme.typography.labelMedium,
                                                color = qy.accent,
                                                modifier = Modifier.padding(horizontal = 14.dp, vertical = 5.dp),
                                            )
                                        }
                                    }
                                }
                                Spacer(Modifier.height(6.dp))
                                // 立即总结（卡片行）
                                CardRow(verticalPadding = 10) {
                                    Surface(
                                        enabled = !summarizingMemory,
                                        onClick = {
                                            summarizingMemory = true
                                            scope.launch {
                                                runCatching { container.repository.summarizeMemory(sessionId, characterId) }
                                                    .onSuccess { (summary, facts) ->
                                                        memory = mem.copy(memory = summary, memoryFacts = facts)
                                                    }
                                                    .onFailure { error = it.message ?: summarizeFailedLabel }
                                                summarizingMemory = false
                                            }
                                        },
                                        shape = RoundedCornerShape(50),
                                        color = qy.accentSoft,
                                    ) {
                                        Row(
                                            verticalAlignment = Alignment.CenterVertically,
                                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 5.dp),
                                        ) {
                                            if (summarizingMemory) {
                                                CircularProgressIndicator(
                                                    modifier = Modifier.size(11.dp),
                                                    strokeWidth = 1.5.dp,
                                                    color = qy.accent,
                                                )
                                                Spacer(Modifier.width(6.dp))
                                            }
                                            Text(
                                                if (summarizingMemory) summarizeLoadingLabel else stringResource(R.string.qs_memory_summarize_now),
                                                style = MaterialTheme.typography.labelMedium,
                                                color = qy.accent,
                                            )
                                        }
                                    }
                                    Spacer(Modifier.weight(1f))
                                    Text(
                                        stringResource(R.string.qs_memory_message_count_fmt, mem.messageCount),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = qy.muted,
                                    )
                                }
                                // 摘要展示（软底卡片）
                                if (mem.memory.isNotBlank()) {
                                    Spacer(Modifier.height(6.dp))
                                    InfoCard {
                                        Text(
                                            stringResource(R.string.qs_memory_summary),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = qy.accent,
                                        )
                                        Spacer(Modifier.height(3.dp))
                                        Text(
                                            mem.memory,
                                            style = MaterialTheme.typography.bodySmall.copy(color = qy.soft),
                                            maxLines = 5,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                }
                                // 关键事实（软底卡片）
                                if (mem.memoryFacts.isNotEmpty()) {
                                    Spacer(Modifier.height(6.dp))
                                    InfoCard {
                                        Text(
                                            stringResource(R.string.qs_memory_facts),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = qy.accent,
                                        )
                                        Spacer(Modifier.height(3.dp))
                                        mem.memoryFacts.take(8).forEach { f ->
                                            Text(
                                                "• ${f.displayText}",
                                                style = MaterialTheme.typography.bodySmall.copy(color = qy.soft),
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // ---- 翻译 ----
                    PanelSection(stringResource(R.string.qs_section_translate)) {
                        CardRow(verticalPadding = 10) {
                            Text(
                                stringResource(R.string.qs_translate_target),
                                style = MaterialTheme.typography.bodyLarge,
                                color = qy.text,
                            )
                            Spacer(Modifier.width(10.dp))
                            val translateLangDefault = stringResource(R.string.qs_translate_lang_default)
                            var langText by remember(translationLang) { mutableStateOf(translationLang.ifBlank { translateLangDefault }) }
                            OutlinedTextField(
                                value = langText,
                                onValueChange = { langText = it.take(12) },
                                modifier = Modifier.weight(1f),
                                singleLine = true,
                                textStyle = MaterialTheme.typography.bodySmall.copy(color = qy.text),
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = qy.accent,
                                    unfocusedBorderColor = qy.line,
                                    focusedContainerColor = qy.bg,
                                    unfocusedContainerColor = qy.bg,
                                    cursorColor = qy.accent,
                                ),
                            )
                            Surface(
                                onClick = {
                                    val lang = langText.trim()
                                    if (lang.isNotEmpty()) {
                                        translationLang = lang
                                        scope.launch {
                                            runCatching { container.repository.updateSettings(mapOf("translationTargetLang" to lang)) }
                                                .onFailure { error = it.message ?: saveFailedLabel }
                                        }
                                    }
                                },
                                shape = RoundedCornerShape(50),
                                color = qy.accentSoft,
                                modifier = Modifier.padding(start = 8.dp),
                            ) {
                                Text(
                                    stringResource(R.string.qs_save),
                                    style = MaterialTheme.typography.labelMedium,
                                    color = qy.accent,
                                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 5.dp),
                                )
                            }
                        }
                        Text(
                            stringResource(R.string.settings_pc_translation_lang_hint),
                            style = MaterialTheme.typography.labelSmall,
                            color = qy.muted,
                            modifier = Modifier.padding(start = 6.dp, top = 4.dp),
                        )
                    }
                }
            }
        }
    }
}
