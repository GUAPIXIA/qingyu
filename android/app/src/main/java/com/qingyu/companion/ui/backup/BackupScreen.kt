package com.qingyu.companion.ui.backup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.qingyu.companion.BuildConfig
import com.qingyu.companion.content.backup.BackupOrchestrator
import com.qingyu.companion.content.backup.BackupV3
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.ui.characters.rememberFileExporter
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 阶段 5 S5-08：跨平台备份 V3 的用户入口。
 *
 * 恢复刻意做成**两步**（总方案 §S5-08「整包校验 + 预览 → 检查点 + 原子应用」）：
 * 先只读校验并展示来源平台、条目数、默认排除项，用户确认后才落库。
 * 只读那一步不写任何字节，所以「选错文件」不会留下半成品；
 * 应用那一步在 `BackupOrchestrator` 里是一个事务 + 媒体后移，失败整体回滚。
 */
@Composable
fun BackupScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val store = LocalAppContainer.current.localSyncRepository
    val mediaRoot = remember { File(context.filesDir, "media") }
    val appVersion = remember { BuildConfig.VERSION_NAME }

    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var preview by remember { mutableStateOf<BackupV3.Preview?>(null) }
    var pendingBytes by remember { mutableStateOf<ByteArray?>(null) }

    val exporter = rememberFileExporter { message ->
        busy = false
        note = message
    }
    val picker = com.qingyu.companion.ui.content.rememberMultiDocumentPicker(
        mimeTypes = arrayOf("*/*"),
        maxFiles = 1,
    ) { documents ->
        // 选择器回调只做只读校验与暂存；恢复动作必须等用户在确认框上点下去
        val document = documents.firstOrNull()
        if (document == null) {
            problem = "未选择文件"
            return@rememberMultiDocumentPicker
        }
        busy = true
        problem = null
        val result = withContext(Dispatchers.IO) { BackupV3.inspect(document.bytes) }
        busy = false
        when (result) {
            is BackupV3.InspectResult.Ok -> {
                pendingBytes = document.bytes
                preview = result.preview
            }
            is BackupV3.InspectResult.Rejected -> problem = "备份不可恢复：${result.reason}"
        }
    }

    Scaffold(
        topBar = {
            AppTopBar(
                title = "备份与恢复",
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        AppBackground {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    "备份包含角色、世界书、预设、人设、正则、快捷回复、会话与用量，可在 PC 与 Android 之间互相恢复。",
                    style = MaterialTheme.typography.bodySmall,
                )
                Text(
                    "默认**不**包含：API Key、设备身份与空间密钥、令牌、向量索引、日志。这些留在本机。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Button(
                    enabled = !busy,
                    onClick = {
                        busy = true
                        problem = null
                        note = null
                        scope.launch {
                            val result = runCatching {
                                withContext(Dispatchers.IO) {
                                    BackupOrchestrator(store, mediaRoot, appVersion).create()
                                }
                            }
                            val bundle = result.getOrNull()
                            if (bundle == null) {
                                busy = false
                                problem = "打包失败：${result.exceptionOrNull()?.message ?: "未知错误"}"
                                return@launch
                            }
                            exporter(
                                bundle.bytes,
                                "qingyu-backup-${backupStamp()}.zip",
                                "application/zip",
                            )
                        }
                    },
                ) { Text(if (busy) "处理中…" else "导出备份（Backup V3）") }

                OutlinedButton(
                    enabled = !busy,
                    onClick = { picker() },
                ) { Text("选择备份文件并预览") }

                if (busy) CircularProgressIndicator()
                note?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                problem?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }

    val shown = preview
    if (shown != null) {
        AlertDialog(
            onDismissRequest = { preview = null },
            title = { Text("确认恢复这个备份？") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("来源平台：${shown.manifest.platform}")
                    Text("备份时间：${shown.manifest.createdAt}")
                    Text("条目数（不含重复文件）：${shown.duplicateFreeCount}")
                    Text("包含：")
                    shown.manifest.counts.toSortedMap().forEach { (key, value) ->
                        Text("  $key：$value")
                    }
                    HorizontalDivider()
                    Text("已排除：${shown.manifest.excluded.joinToString("、")}")
                    Text(
                        "恢复会替换本机同名实体，并在一个事务里完成；任一步失败整体回滚。",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        val bytes = pendingBytes
                        preview = null
                        if (bytes == null) {
                            problem = "备份内容已失效，请重新选择文件"
                            return@Button
                        }
                        busy = true
                        scope.launch {
                            val outcome = runCatching {
                                withContext(Dispatchers.IO) {
                                    BackupOrchestrator(store, mediaRoot, appVersion).restore(bytes)
                                }
                            }
                            busy = false
                            val applied = outcome.getOrNull()
                            if (applied == null || !applied.ok) {
                                // 失败有两种，措辞不能共用一种：
                                // 事务回滚了（库一行没动）与库已经按备份更新、只有媒体没落位。
                                // 后者说成「恢复失败」会让人以为没动过而不去核对。
                                val partial = applied?.takeIf { !it.rolledBack && it.applied.isNotEmpty() }
                                problem = if (partial == null) {
                                    "恢复失败：${applied?.error ?: outcome.exceptionOrNull()?.message ?: "未知错误"}"
                                } else {
                                    "数据库已按这份备份更新，且不会自动撤销：" +
                                        partial.applied.entries.joinToString("、") { "${it.key} ${it.value}" } +
                                        "。未完成的原因：${partial.error}"
                                }
                            } else {
                                note = "已恢复：" + applied.applied.entries.joinToString("、") { "${it.key} ${it.value}" }
                            }
                        }
                    },
                ) { Text("确认恢复") }
            },
            dismissButton = { OutlinedButton(onClick = { preview = null }) { Text("取消") } },
        )
    }
}

/** 文件名里的时间戳用本地时区的 `yyyy-MM-dd-HHmm`，与 PC 的备份命名同样可读。 */
private fun backupStamp(): String =
    SimpleDateFormat("yyyy-MM-dd-HHmm", Locale.US).format(Date())
