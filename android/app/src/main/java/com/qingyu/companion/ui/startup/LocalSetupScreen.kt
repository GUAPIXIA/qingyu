package com.qingyu.companion.ui.startup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.local.migration.LegacyImportChoice
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.theme.qyColors

/**
 * 阶段 3 S3-07：本地初始化 / 旧伴侣缓存一次性迁移向导。
 *
 * 完成后进入主界面；本页**不**提供「进入旧伴侣模式」入口，
 * 也不在用户选择前自动升级或改写旧缓存。
 */
@Composable
fun LocalSetupScreen(
    onDone: () -> Unit,
    onAborted: () -> Unit,
) {
    val container = LocalAppContainer.current
    val vm: LocalSetupViewModel = viewModel(
        factory = viewModelFactory {
            initializer {
                LocalSetupViewModel(
                    store = container.localSyncRepository,
                    reader = container.legacyCacheReader,
                    importer = container.legacyCacheImporter,
                )
            }
        },
    )
    val state by vm.state.collectAsStateWithLifecycle()

    AppBackground {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                "开始使用轻语",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                color = qyColors().text,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "轻语在手机上独立运行：本地资料、模型配置与聊天记录都在本机。与电脑的数据同步由你在「同步中心」主动触发。",
                style = MaterialTheme.typography.bodyMedium,
                color = qyColors().soft,
            )
            Spacer(Modifier.height(24.dp))

            when (val current = state) {
                LocalSetupState.Scanning -> Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.width(20.dp))
                    Spacer(Modifier.width(12.dp))
                    Text("正在检查本机旧版本数据…", color = qyColors().text)
                }

                LocalSetupState.FreshLocal -> {
                    Text("未检测到旧版本缓存，将直接创建新的本地资料。", color = qyColors().text)
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = onDone, modifier = Modifier.fillMaxWidth()) {
                        Text("创建本地资料并进入")
                    }
                }

                is LocalSetupState.DecideMigration -> {
                    Text("检测到旧版本缓存", fontWeight = FontWeight.SemiBold, color = qyColors().text)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "角色 ${current.scan.characterCount} · 会话 ${current.scan.sessionCount} · " +
                            "消息 ${current.scan.messageCount} · 未确认发送 ${current.scan.outboxUnsentCount}",
                        style = MaterialTheme.typography.bodySmall,
                        color = qyColors().soft,
                    )
                    Spacer(Modifier.height(12.dp))
                    current.warnings.forEach { warning ->
                        Text(
                            "• ${warning.message}",
                            style = MaterialTheme.typography.bodySmall,
                            color = qyColors().warn,
                        )
                        Spacer(Modifier.height(4.dp))
                    }
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = { vm.choose(LegacyImportChoice.ImportAsLocalCopy) }, modifier = Modifier.fillMaxWidth()) {
                        Text("导入为新的本地副本")
                    }
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(
                        onClick = { vm.choose(LegacyImportChoice.BackupAndSkip) },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("备份旧缓存后不导入")
                    }
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = { vm.choose(LegacyImportChoice.AbortUpgrade) }, modifier = Modifier.fillMaxWidth()) {
                        Text("退出升级，暂不启动新版")
                    }
                }

                LocalSetupState.Importing -> Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.width(20.dp))
                    Spacer(Modifier.width(12.dp))
                    Text("正在导入旧缓存（不会改写旧数据）…", color = qyColors().text)
                }

                is LocalSetupState.Done -> {
                    Text("导入完成", fontWeight = FontWeight.SemiBold, color = qyColors().text)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "角色 ${current.result.importedCharacters} · 会话 ${current.result.importedSessions} · " +
                            "消息 ${current.result.importedMessages} · 保留草稿 ${current.result.outboxDrafts}",
                        style = MaterialTheme.typography.bodySmall,
                        color = qyColors().soft,
                    )
                    if (current.result.warnings.isNotEmpty()) {
                        Spacer(Modifier.height(12.dp))
                        Text(
                            "缺失内容已列入报告，可在首次同步后补齐。",
                            style = MaterialTheme.typography.bodySmall,
                            color = qyColors().warn,
                        )
                    }
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = onDone, modifier = Modifier.fillMaxWidth()) {
                        Text("进入主界面")
                    }
                }

                is LocalSetupState.ImportFailed -> {
                    Text("迁移未完成", fontWeight = FontWeight.SemiBold, color = qyColors().warn)
                    Spacer(Modifier.height(8.dp))
                    Text(current.message, color = qyColors().text)
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = { vm.scan() }, modifier = Modifier.fillMaxWidth()) {
                        Text("修复后重试")
                    }
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = onAborted, modifier = Modifier.fillMaxWidth()) {
                        Text("暂不启动新版")
                    }
                }

                LocalSetupState.BackedUpAndSkipped -> {
                    Text("已备份旧缓存并跳过导入", fontWeight = FontWeight.SemiBold, color = qyColors().text)
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = onDone, modifier = Modifier.fillMaxWidth()) {
                        Text("进入主界面")
                    }
                }

                LocalSetupState.Aborted -> {
                    Text("已选择暂不启动新版", fontWeight = FontWeight.SemiBold, color = qyColors().text)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "旧缓存的备份仍然保留。可以重新进入本页再做选择。",
                        style = MaterialTheme.typography.bodySmall,
                        color = qyColors().soft,
                    )
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = { vm.scan() }, modifier = Modifier.fillMaxWidth()) {
                        Text("返回选择")
                    }
                }
            }
        }
    }
}
