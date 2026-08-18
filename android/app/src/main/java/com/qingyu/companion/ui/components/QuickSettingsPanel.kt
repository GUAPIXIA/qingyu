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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
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
    var translationLang by remember { mutableStateOf("") }

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
            .onFailure { error = it.message ?: "加载失败" }
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
                "对话设置",
                style = MaterialTheme.typography.titleLarge,
                color = qy.text,
                modifier = Modifier.fillMaxWidth(),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
            Spacer(Modifier.height(2.dp))
            Text(
                "设置会同步到 PC 端，下次对话生效",
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
                            error ?: "加载失败",
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
                            "关闭",
                            style = MaterialTheme.typography.bodySmall,
                            color = qy.soft,
                            modifier = Modifier.padding(horizontal = 20.dp, vertical = 7.dp),
                        )
                    }
                }

                else -> {
                    // ---- 世界书 ----
                    PanelSection("世界书") {
                        if (lorebooks.isEmpty()) {
                            EmptyHint("暂无世界书")
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
                                        trailing = "${lb.entryCount}条",
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
                                            .onFailure { error = it.message ?: "保存失败" }
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
                                            if (savedFlash) "已保存 ✓" else "保存世界书",
                                            style = MaterialTheme.typography.bodySmall,
                                        )
                                    }
                                }
                            }
                        }
                    }

                    // ---- 预设 ----
                    PanelSection("预设") {
                        if (presets.isEmpty()) {
                            EmptyHint("暂无预设")
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
                                                .onFailure { error = it.message ?: "切换失败" }
                                        }
                                        Unit
                                    }
                                    SelectRow(
                                        selected = selected,
                                        title = p.name,
                                        subtitle = "温度 ${p.temperature} · TopP ${p.topP} · ${p.maxTokens} tokens",
                                        onClick = apply,
                                    )
                                }
                            }
                        }
                    }

                    // ---- 模型 ----
                    PanelSection("模型") {
                        when {
                            modelsLoading -> Box(
                                Modifier
                                    .fillMaxWidth()
                                    .padding(10.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = qy.accent)
                            }

                            models.isEmpty() -> EmptyHint("模型列表加载失败（请确认 PC 端已配置 API 连接）")

                            else -> {
                                ValueRow("当前模型", activeModel.ifBlank { "未设置" })
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
                                                    .onFailure { error = it.message ?: "切换失败" }
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
                    PanelSection("采样参数") {
                        val activePresetObj = presets.firstOrNull { it.id == activePresetId }
                        if (activePresetObj != null) {
                            ValueRow("当前预设", activePresetObj.name)
                            ValueRow("温度 / TopP", "${activePresetObj.temperature} / ${activePresetObj.topP}")
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
                            EmptyHint("未激活预设（使用默认参数）")
                        }
                    }

                    // ---- 长记忆 ----
                    PanelSection("长记忆") {
                        val mem = memory
                        when {
                            mem == null -> EmptyHint("加载中…")

                            else -> {
                                // 启用开关（卡片行）
                                CardRow {
                                    Column(Modifier.weight(1f)) {
                                        Text("启用长记忆", style = MaterialTheme.typography.bodyLarge, color = qy.text)
                                        Text(
                                            "定期总结对话形成长期记忆",
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
                                                    .onFailure { error = it.message ?: "保存失败" }
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
                                        "模式",
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = qy.text,
                                        modifier = Modifier.weight(1f),
                                    )
                                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                        listOf("manual" to "手动", "auto" to "自动").forEach { (mode, label) ->
                                            val selected = mem.memoryMode == mode
                                            Surface(
                                                onClick = {
                                                    memory = mem.copy(memoryMode = mode)
                                                    scope.launch {
                                                        runCatching { container.repository.patchSessionMemory(sessionId, memoryMode = mode, characterId = characterId) }
                                                            .onFailure { error = it.message ?: "保存失败" }
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
                                            "自动总结间隔",
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
                                            "条消息",
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
                                                        .onFailure { error = it.message ?: "保存失败" }
                                                }
                                            },
                                            shape = RoundedCornerShape(50),
                                            color = qy.accentSoft,
                                        ) {
                                            Text(
                                                "保存",
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
                                        onClick = {
                                            scope.launch {
                                                runCatching { container.repository.summarizeMemory(sessionId, characterId) }
                                                    .onSuccess { (summary, facts) ->
                                                        memory = mem.copy(memory = summary, memoryFacts = facts)
                                                    }
                                                    .onFailure { error = it.message ?: "总结失败" }
                                            }
                                        },
                                        shape = RoundedCornerShape(50),
                                        color = qy.accentSoft,
                                    ) {
                                        Text(
                                            "立即总结",
                                            style = MaterialTheme.typography.labelMedium,
                                            color = qy.accent,
                                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 5.dp),
                                        )
                                    }
                                    Spacer(Modifier.weight(1f))
                                    Text(
                                        "消息 ${mem.messageCount} 条",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = qy.muted,
                                    )
                                }
                                // 摘要展示（软底卡片）
                                if (mem.memory.isNotBlank()) {
                                    Spacer(Modifier.height(6.dp))
                                    InfoCard {
                                        Text(
                                            "当前摘要",
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
                                            "关键事实",
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
                    PanelSection("翻译") {
                        CardRow(verticalPadding = 10) {
                            Text(
                                "目标语言",
                                style = MaterialTheme.typography.bodyLarge,
                                color = qy.text,
                            )
                            Spacer(Modifier.width(10.dp))
                            var langText by remember(translationLang) { mutableStateOf(translationLang.ifBlank { "中文" }) }
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
                                                .onFailure { error = it.message ?: "保存失败" }
                                        }
                                    }
                                },
                                shape = RoundedCornerShape(50),
                                color = qy.accentSoft,
                                modifier = Modifier.padding(start = 8.dp),
                            ) {
                                Text(
                                    "保存",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = qy.accent,
                                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 5.dp),
                                )
                            }
                        }
                        Text(
                            "例：中文 / 英语 / 日语…（翻译消息时使用）",
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

/** 分区：cap 小标题 + 内容，区距统一 16dp */
