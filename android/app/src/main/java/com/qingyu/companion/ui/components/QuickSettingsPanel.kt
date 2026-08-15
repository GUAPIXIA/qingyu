package com.qingyu.companion.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.model.LorebookDto
import com.qingyu.companion.model.PresetDto
import com.qingyu.companion.ui.theme.Accent
import com.qingyu.companion.ui.theme.Lantern
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * 对话快捷设置面板（桥接层第一批端点）：
 * - 世界书选择：勾选当前会话激活的世界书，保存后写会话（PATCH /sessions/:id/lorebooks）；
 * - 预设切换：点击即切换全局 activePresetId（PATCH /sessions/:id/preset）。
 * 数据来自 GET /settings、/lorebooks、/presets、会话级端点。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuickSettingsPanel(sessionId: String, onDismiss: () -> Unit) {
    val container = LocalAppContainer.current
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
    var translationLang by remember { mutableStateOf("") }

    LaunchedEffect(Unit) {
        runCatching {
            val lb = container.repository.listLorebooks()
            val ps = container.repository.listPresets()
            val activeLb = container.repository.getSessionLorebooks(sessionId)
            val activePs = container.repository.getSessionPreset(sessionId)
            val settings = container.repository.getSettings()
            val mem = container.repository.getSessionMemory(sessionId)
            lorebooks = lb
            presets = ps
            activeLorebookIds = activeLb.toSet()
            activePresetId = activePs
            activeModel = settings.activeModel
            memory = mem
            translationLang = settings.translationTargetLang
        }
            .onSuccess { loading = false }
            .onFailure { error = it.message ?: "加载失败" }
    }

    // 模型列表单独拉取（依赖 PC 端 API 连接，可能失败或较慢）
    LaunchedEffect(Unit) {
        modelsLoading = true
        runCatching { container.repository.listModels() }
            .onSuccess { models = it }
        modelsLoading = false
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
        ) {
            Text("对话设置", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(4.dp))
            Text(
                "设置会同步到 PC 端，下次对话生效",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(16.dp))

            when {
                loading -> Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(24.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(color = Accent)
                }

                error != null -> {
                    Text(
                        error ?: "加载失败",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = onDismiss) { Text("关闭") }
                }

                else -> {
                    // ---- 世界书 ----
                    SectionTitle("📚", "世界书")
                    if (lorebooks.isEmpty()) {
                        Text(
                            "暂无世界书",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        LazyColumn(
                            Modifier.heightIn(max = 190.dp),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            items(lorebooks, key = { it.id }) { lb ->
                                val checked = lb.id in activeLorebookIds
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(8.dp))
                                        .clickable {
                                            activeLorebookIds =
                                                if (checked) activeLorebookIds - lb.id else activeLorebookIds + lb.id
                                        }
                                        .padding(vertical = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Checkbox(
                                        checked = checked,
                                        onCheckedChange = { c ->
                                            activeLorebookIds =
                                                if (c) activeLorebookIds + lb.id else activeLorebookIds - lb.id
                                        },
                                    )
                                    Column(Modifier.weight(1f)) {
                                        Text(
                                            lb.name,
                                            style = MaterialTheme.typography.bodyMedium,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                        if (lb.description.isNotBlank()) {
                                            Text(
                                                lb.description,
                                                style = MaterialTheme.typography.labelSmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                        }
                                    }
                                    Text(
                                        "${lb.entryCount}条",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                        Spacer(Modifier.height(4.dp))
                        TextButton(
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
                                        .onFailure { error = it.message ?: "保存失败" }
                                    saving = false
                                }
                            },
                            enabled = !saving,
                        ) {
                            if (saving) {
                                CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                            } else {
                                Text(if (savedFlash) "已保存 ✓" else "保存世界书")
                            }
                        }
                    }

                    Spacer(Modifier.height(18.dp))

                    // ---- 预设 ----
                    SectionTitle("🎛️", "预设")
                    if (presets.isEmpty()) {
                        Text(
                            "暂无预设",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        LazyColumn(
                            Modifier.heightIn(max = 240.dp),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            items(presets, key = { it.id }) { p ->
                                val selected = p.id == activePresetId
                                val apply: () -> Unit = {
                                    activePresetId = p.id
                                    scope.launch {
                                        runCatching { container.repository.setSessionPreset(sessionId, p.id) }
                                            .onFailure { error = it.message ?: "切换失败" }
                                    }
                                    Unit
                                }
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(8.dp))
                                        .clickable(onClick = apply)
                                        .padding(vertical = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    RadioButton(selected = selected, onClick = apply)
                                    Column(Modifier.weight(1f)) {
                                        Text(
                                            p.name,
                                            style = MaterialTheme.typography.bodyMedium,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                        Text(
                                            "温度 ${p.temperature} · TopP ${p.topP} · ${p.maxTokens} tokens",
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                        }
                    }

                    Spacer(Modifier.height(18.dp))

                    // ---- 模型 ----
                    SectionTitle("🤖", "模型")
                    if (modelsLoading) {
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .padding(8.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Accent)
                        }
                    } else if (models.isEmpty()) {
                        Text(
                            "模型列表加载失败（请确认 PC 端已配置 API 连接）",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        Text(
                            "当前：${activeModel.ifBlank { "未设置" }}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(4.dp))
                        LazyColumn(
                            Modifier.heightIn(max = 200.dp),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            items(models) { model ->
                                val selected = model == activeModel
                                val applyModel: () -> Unit = {
                                    activeModel = model
                                    scope.launch {
                                        runCatching { container.repository.updateSettings(mapOf("activeModel" to model)) }
                                            .onFailure { error = it.message ?: "切换失败" }
                                    }
                                    Unit
                                }
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(8.dp))
                                        .clickable(onClick = applyModel)
                                        .padding(vertical = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    RadioButton(selected = selected, onClick = applyModel)
                                    Text(
                                        model,
                                        style = MaterialTheme.typography.bodyMedium,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }

                    Spacer(Modifier.height(18.dp))

                    // ---- 采样参数（对齐 PC 端：温度/TopP 只读展示，MaxToken 可调） ----
                    SectionTitle("⚙️", "采样参数")
                    val activePresetObj = presets.firstOrNull { it.id == activePresetId }
                    if (activePresetObj != null) {
                        Text(
                            "当前预设：${activePresetObj.name}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            "温度 ${activePresetObj.temperature} · TopP ${activePresetObj.topP}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
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
                                                    .onFailure { error = it.message ?: "调整失败" }
                                            }
                                        }
                                    },
                                    shape = RoundedCornerShape(8.dp),
                                    color = if (selected) {
                                        Accent.copy(alpha = 0.2f)
                                    } else {
                                        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
                                    },
                                    border = BorderStroke(
                                        1.dp,
                                        if (selected) Accent.copy(alpha = 0.5f)
                                        else MaterialTheme.colorScheme.outline.copy(alpha = 0.3f),
                                    ),
                                ) {
                                    Text(
                                        "$n",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = if (selected) Accent else MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                                    )
                                }
                            }
                        }
                    } else {
                        Text(
                            "未激活预设（使用默认参数）",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }

                    Spacer(Modifier.height(18.dp))

                    // ---- 长记忆 ----
                    SectionTitle("🧠", "长记忆")
                    val mem = memory
                    if (mem == null) {
                        Text(
                            "加载中…",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        // 启用开关
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("启用长记忆", style = MaterialTheme.typography.bodyMedium)
                            Spacer(Modifier.weight(1f))
                            Switch(
                                checked = mem.memoryEnabled,
                                onCheckedChange = { c ->
                                    memory = mem.copy(memoryEnabled = c)
                                    scope.launch {
                                        runCatching { container.repository.patchSessionMemory(sessionId, memoryEnabled = c) }
                                            .onFailure { error = it.message ?: "保存失败" }
                                    }
                                },
                            )
                        }
                        // 模式
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("模式", style = MaterialTheme.typography.bodyMedium)
                            Spacer(Modifier.weight(1f))
                            listOf("manual" to "手动", "auto" to "自动").forEach { (mode, label) ->
                                val selected = mem.memoryMode == mode
                                Surface(
                                    onClick = {
                                        memory = mem.copy(memoryMode = mode)
                                        scope.launch {
                                            runCatching { container.repository.patchSessionMemory(sessionId, memoryMode = mode) }
                                                .onFailure { error = it.message ?: "保存失败" }
                                        }
                                    },
                                    shape = RoundedCornerShape(8.dp),
                                    color = if (selected) Accent.copy(alpha = 0.2f)
                                    else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                                    border = BorderStroke(
                                        1.dp,
                                        if (selected) Accent.copy(alpha = 0.5f)
                                        else MaterialTheme.colorScheme.outline.copy(alpha = 0.3f),
                                    ),
                                ) {
                                    Text(
                                        label,
                                        style = MaterialTheme.typography.labelMedium,
                                        color = if (selected) Accent else MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                                    )
                                }
                            }
                        }
                        // 自动模式：间隔
                        if (mem.memoryMode == "auto") {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("自动总结间隔", style = MaterialTheme.typography.bodyMedium)
                                Spacer(Modifier.width(8.dp))
                                var intervalText by remember(mem.autoMemoryInterval) { mutableStateOf(mem.autoMemoryInterval.toString()) }
                                OutlinedTextField(
                                    value = intervalText,
                                    onValueChange = { intervalText = it.filter { c -> c.isDigit() }.take(3) },
                                    modifier = Modifier.width(72.dp),
                                    singleLine = true,
                                    textStyle = MaterialTheme.typography.bodyMedium,
                                )
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    "条消息",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                TextButton(
                                    onClick = {
                                        val n = intervalText.toIntOrNull()?.coerceIn(4, 50) ?: return@TextButton
                                        memory = mem.copy(autoMemoryInterval = n)
                                        scope.launch {
                                            runCatching { container.repository.patchSessionMemory(sessionId, autoMemoryInterval = n) }
                                                .onFailure { error = it.message ?: "保存失败" }
                                        }
                                    },
                                ) { Text("保存", style = MaterialTheme.typography.labelSmall) }
                            }
                        }
                        // 立即总结
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            TextButton(
                                onClick = {
                                    scope.launch {
                                        runCatching { container.repository.summarizeMemory(sessionId) }
                                            .onSuccess { (summary, facts) ->
                                                memory = mem.copy(memory = summary, memoryFacts = facts)
                                            }
                                            .onFailure { error = it.message ?: "总结失败" }
                                    }
                                },
                            ) { Text("立即总结", style = MaterialTheme.typography.labelMedium) }
                            Text(
                                "消息 ${mem.messageCount} 条",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        // 摘要与事实展示
                        if (mem.memory.isNotBlank()) {
                            Text(
                                "当前摘要",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                mem.memory,
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = 5,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        if (mem.memoryFacts.isNotEmpty()) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                "关键事实",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            mem.memoryFacts.take(8).forEach { f ->
                                Text(
                                    "• $f",
                                    style = MaterialTheme.typography.bodySmall,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }

                    Spacer(Modifier.height(18.dp))

                    // ---- 翻译设置 ----
                    Text("翻译设置", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("翻译目标语言", style = MaterialTheme.typography.bodyMedium)
                        Spacer(Modifier.width(8.dp))
                        var langText by remember(translationLang) { mutableStateOf(translationLang.ifBlank { "中文" }) }
                        OutlinedTextField(
                            value = langText,
                            onValueChange = { langText = it.take(12) },
                            modifier = Modifier.weight(1f),
                            singleLine = true,
                            textStyle = MaterialTheme.typography.bodyMedium,
                        )
                        TextButton(
                            onClick = {
                                val lang = langText.trim()
                                if (lang.isNotEmpty()) {
                                    translationLang = lang
                                    scope.launch {
                                        runCatching { container.repository.updateSettings(mapOf("translationTargetLang" to lang)) }
                                            .onFailure { error = it.message ?: "保存失败" }
                                    }
                                }
                            },
                        ) { Text("保存", style = MaterialTheme.typography.labelSmall) }
                    }
                    Text(
                        "例：中文 / 英语 / 日语…（翻译消息时使用）",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}


/**
 * 对话设置分区标题：图标 + 琥珀色标题 + 渐变分隔线（强化栏与栏边界）。
 */
@Composable
private fun SectionTitle(icon: String, title: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            icon,
            style = MaterialTheme.typography.titleMedium,
        )
        Spacer(Modifier.width(6.dp))
        Text(
            title,
            style = MaterialTheme.typography.titleMedium,
            color = Lantern,
        )
    }
    Spacer(Modifier.height(6.dp))
    Box(
        Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(
                Brush.horizontalGradient(
                    listOf(Lantern.copy(alpha = 0.55f), Lantern.copy(alpha = 0.05f), Color.Transparent)
                )
            )
    )
    Spacer(Modifier.height(10.dp))
}
