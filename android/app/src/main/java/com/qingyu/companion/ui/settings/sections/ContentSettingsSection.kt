package com.qingyu.companion.ui.settings.sections

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.lifecycle.viewModelScope
import com.qingyu.companion.chatcore.ChatResponsePolicy
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.local.settings.DeviceSettings
import com.qingyu.companion.local.settings.DeviceSettingKey
import com.qingyu.companion.local.settings.LocalSettingsRepository
import com.qingyu.companion.local.settings.PublicSettingKey
import com.qingyu.companion.local.settings.PublicSettings
import com.qingyu.companion.ui.components.QyErrorBanner
import com.qingyu.companion.ui.components.SettingsChoiceRow
import com.qingyu.companion.ui.settings.components.SettingsSwitchRow
import com.qingyu.companion.ui.content.EditorNote
import com.qingyu.companion.ui.content.EditorNumberField
import com.qingyu.companion.ui.settings.components.SettingsNavRow
import com.qingyu.companion.ui.settings.components.SettingsSection
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 阶段 5 S5-07：PC 同步公开设置的 Android 等价入口 + 设备设置分区。
 *
 * 方案要求是两句：「PC 同步公开设置在 Android 具备等价入口；设备设置明确不参与同步」。
 * 因此这一屏的重点不是又做一遍设置页，而是把**同一张表的两半**在界面上分开：
 *
 * - [PublicSettingKey] 的 8 个键写在 `local_public_settings`，每次写入都会经
 *   `LocalStore.putPublicSetting` 产生一条 `settings_public` 变更
 *   （粒度是**整份设置一个实体** `settings-public`，与 PC 一致，见 `EntityPayloads`）；
 * - [DeviceSettingKey] 的键写在 `local_device_settings`，仓储**不写 change journal**，
 *   所以这里只做只读展示并写明「不会同步」——留成可编辑的样子最容易让人以为
 *   「改了手机，电脑上也会变」。
 */
@Composable
fun ContentSettingsSection(
    store: LocalStore,
    modifier: Modifier = Modifier,
) {
    val vm: ContentSettingsViewModel = viewModel(factory = viewModelFactory {
        initializer { ContentSettingsViewModel(LocalSettingsRepository(store)) }
    })
    val publicValues by vm.publicSettings.collectAsStateWithLifecycle()
    val deviceValues by vm.deviceSettings.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()

    Column(modifier.fillMaxWidth()) {
        error?.let { QyErrorBanner(message = it, onRetry = null) }

        SettingsSection(title = "公开设置（参与同步）", tag = "同步") {
            EditorNote(
                "改一项就是一次业务写：写入本机表的同时记一条变更，同步后其它设备看到同一个值。" +
                    "下面标注了真实的 section.key 路径，跨端排查时按这个名字找即可。",
            )
            PublicEntries.forEach { group ->
                Text(
                    group.title,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(start = 14.dp, top = 10.dp, bottom = 2.dp),
                )
                group.entries.forEach { entry ->
                    PublicEntryRow(
                        entry = entry,
                        snapshot = publicValues,
                        onBool = { value -> vm.setBool(entry.key, value) },
                        onInt = { value -> vm.setInt(entry.key, value) },
                        onChoice = { value -> vm.setString(entry.key, value) },
                    )
                }
            }
        }

        SettingsSection(title = "设备设置（不参与同步）", tag = "仅本机") {
            EditorNote(
                "这些键存在本机的 local_device_settings，不进入同步信封、不产生变更日志：" +
                    "改手机不会影响电脑，反过来也一样。",
            )
            EditorNote("此处只读，用于核对与 PC 的分工；可编辑的本机偏好在上方「外观」「通知与隐私」区。")
            DeviceSettingKey.entries.forEach { key ->
                val raw = deviceValues.asMap()[key.key]
                SettingsNavRow(
                    title = deviceLabel(key),
                    subtitle = "${key.key} = ${raw ?: key.defaultJson}" +
                        (if (raw == null) "（未写入，取默认）" else "（已写入本机）"),
                    onClick = null,
                )
            }
        }
    }
}

@Composable
private fun PublicEntryRow(
    entry: PublicEntry,
    snapshot: PublicSettings,
    onBool: (Boolean) -> Unit,
    onInt: (Int) -> Unit,
    onChoice: (String) -> Unit,
) {
    // asMap 里没有这个 path == 这行没被写过，界面必须说「取默认」而不是把默认值伪装成用户设置
    val written = snapshot.asMap().containsKey(entry.key.path)
    val suffix = if (written) "" else "（未写入，当前取默认 ${entry.key.defaultJson}）"
    when (entry.kind) {
        EntryKind.BOOL -> SettingsSwitchRow(
            title = entry.title,
            subtitle = entry.description + suffix,
            checked = snapshot.bool(entry.key),
            onCheckedChange = onBool,
        )

        EntryKind.INT -> Column(Modifier.padding(horizontal = 14.dp, vertical = 4.dp)) {
            Text(entry.title, style = MaterialTheme.typography.bodyLarge)
            Text(
                entry.description + suffix,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            // 数字键不能边打字边写库：每一次 putPublicSetting 都是一条 settings_public 变更，
            // 输入 8192 会留下 4 条 journal 并把版本向量推四下（方案 §2「不把每次键入发布成同步变更」）。
            // 所以本地暂存 + 显式「应用」= 一次业务写。
            var pending by remember(entry.key.path, written) { mutableStateOf(snapshot.int(entry.key).toDouble()) }
            EditorNumberField(
                value = pending,
                onValueChange = { pending = it },
                label = entry.title,
                range = entry.range ?: 0.0..262144.0,
                integerOnly = true,
                helper = "${entry.key.path} · token 口径，0 表示不限制",
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(
                    onClick = { onInt(pending.toLong().toInt()) },
                    enabled = pending.toLong().toInt() != snapshot.int(entry.key),
                ) { Text("应用") }
                Text(
                    "改动只在点「应用」后写入（一次写入 = 一条同步变更）",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        EntryKind.CHOICE -> {
            val current = snapshot.string(entry.key)
            SettingsChoiceRow(
                title = entry.title,
                selected = current,
                options = (listOf(current) + entry.options.orEmpty()).distinct(),
                labelOf = { value ->
                    val readable = entry.labelOf?.invoke(value) ?: ChatResponsePolicy.RESPONSE_LENGTH_LABELS[value] ?: value
                    "$readable（$value）"
                },
                onSelect = onChoice,
            )
            Text(
                entry.description + suffix,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 14.dp),
            )
        }
    }
    Text(
        entry.key.path,
        style = MaterialTheme.typography.labelSmall,
        fontFamily = FontFamily.Monospace,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 14.dp),
    )
}

private fun deviceLabel(key: DeviceSettingKey): String = when (key) {
    DeviceSettingKey.ThemeMode -> "主题跟随系统"
    DeviceSettingKey.NotificationsEnabled -> "通知开关"
    DeviceSettingKey.DownloadDirectory -> "下载目录"
    DeviceSettingKey.PerformanceTier -> "性能档位"
    DeviceSettingKey.FontScale -> "字号缩放"
    DeviceSettingKey.MessageSpacing -> "消息间距"
    DeviceSettingKey.CleartextLanEnabled -> "局域网明文传输"
}

/** 条目类型决定用哪种控件；值域一律不在这里发明，只列代码里已经出现过的取值。 */
private enum class EntryKind { BOOL, INT, CHOICE }

private class PublicEntry(
    val key: PublicSettingKey,
    val title: String,
    val description: String,
    val kind: EntryKind,
    val range: ClosedFloatingPointRange<Double>? = null,
    val options: List<String>? = null,
    val labelOf: ((String) -> String)? = null,
)

private class PublicGroup(val title: String, val entries: List<PublicEntry>)

private val PublicEntries = listOf(
    PublicGroup(
        "记忆",
        listOf(
            PublicEntry(
                PublicSettingKey.AutoMemory,
                "自动生成会话摘要",
                "开启后由本机的记忆总结任务按间隔生成摘要；关闭则只在手动触发时生成",
                EntryKind.BOOL,
            ),
            PublicEntry(
                PublicSettingKey.MemoryBudget,
                "记忆预算",
                "注入上下文的记忆部分预算上限",
                EntryKind.INT,
                range = 0.0..262144.0,
            ),
        ),
    ),
    PublicGroup(
        "上下文",
        listOf(
            PublicEntry(
                PublicSettingKey.ContextBudget,
                "上下文预算",
                "整轮请求可用的上下文 token 上限；超出后按下面的回退策略处理",
                EntryKind.INT,
                range = 0.0..262144.0,
            ),
            PublicEntry(
                PublicSettingKey.HistoryFallback,
                "历史回退策略",
                "放不下时怎么处理更早的历史；值原样写入 historyFallback，两端读取同一份",
                EntryKind.CHOICE,
                // 只列本仓库里已出现过的取值：默认 truncate，契约测试断言过 summarize
                options = listOf("truncate", "summarize"),
                labelOf = { value -> if (value == "summarize") "摘要回退" else "直接截断" },
            ),
        ),
    ),
    PublicGroup(
        "生成",
        listOf(
            PublicEntry(
                PublicSettingKey.ReplyLength,
                "回复篇幅",
                "本轮回复的篇幅模式；候选取自 ChatResponsePolicy 与 PC 同名字面量",
                EntryKind.CHOICE,
                options = ChatResponsePolicy.LENGTH_MODES,
            ),
            PublicEntry(
                PublicSettingKey.ReasoningGate,
                "推理门控",
                "为推理模型预留思考余量（阶段 8 的降级链路读同一位）",
                EntryKind.BOOL,
            ),
        ),
    ),
    PublicGroup(
        "世界书",
        listOf(
            PublicEntry(
                PublicSettingKey.SemanticWorldBook,
                "语义检索世界书",
                "Android 侧没有向量索引：这一位会照常同步给 PC，" +
                    "但本机检索仍走关键词通道（ChatLorebookRuntime 里 semanticEnabled 恒为 false）",
                EntryKind.BOOL,
            ),
        ),
    ),
    PublicGroup(
        "群聊",
        listOf(
            PublicEntry(
                PublicSettingKey.GroupAutoAdvance,
                "群聊自动推进",
                "群聊是否自动轮到下一个角色发言（阶段 6 的群聊生成读这一位）",
                EntryKind.BOOL,
            ),
        ),
    ),
)

/**
 * 这一屏的读写壳。
 *
 * 值编码不在这里重复实现：`LocalSettingsRepository` 的三个 `setPublic*` 最终都是
 * `store.putPublicSetting(section.wire, key, valueJson)`，字符串走 `CanonicalJson.encode`，
 * 自己拼 `"\"$it\""` 就会出现两种转义规则。
 */
class ContentSettingsViewModel(
    private val settings: LocalSettingsRepository,
) : ViewModel() {

    val publicSettings: StateFlow<PublicSettings> = settings.observePublic()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), PublicSettings(emptyMap()))

    val deviceSettings: StateFlow<DeviceSettings> = settings.observeDevice()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), DeviceSettings(emptyMap()))

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    fun setBool(key: PublicSettingKey, value: Boolean) =
        submit(key) { settings.setPublicBool(key, value) }

    fun setInt(key: PublicSettingKey, value: Int) =
        submit(key) { settings.setPublicInt(key, value.coerceAtLeast(0)) }

    fun setString(key: PublicSettingKey, value: String) =
        submit(key) { settings.setPublicString(key, value) }

    /**
     * 一次交互 = 一次业务写。
     *
     * 值没变时不写：`SettingsChoiceRow` 已自带去重，但开关与数字框没有，
     * 空写同样会推进版本向量并留下一条 journal，对端还会把它当成一次真实修改。
     */
    private fun submit(key: PublicSettingKey, block: suspend () -> Unit) {
        viewModelScope.launch {
            _error.value = null
            runCatching { block() }
                .onFailure { cause -> _error.update { "${key.path} 写入失败：${cause.message ?: "未知错误"}" } }
        }
    }

    private companion object {
        const val STOP_TIMEOUT_MS = 5_000L
    }
}
