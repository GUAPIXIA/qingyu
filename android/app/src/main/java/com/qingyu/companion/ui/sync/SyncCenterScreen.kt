package com.qingyu.companion.ui.sync

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.qingyu.companion.R
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.QyErrorBanner

/**
 * S7-07：同步中心（Android）。
 *
 * - 本地 backlog + 最近一次结果；
 * - 「局域网」入口（S7-05 授权流）；
 * - 「我的服务器」入口（阶段 8；未配置只占位，不自动连网）；
 * - 手动开始/取消；进度只在本页。
 */
@Composable
fun SyncCenterScreen(
    onBack: () -> Unit,
    onOpenLanAuth: () -> Unit,
    onOpenServerSetup: () -> Unit,
    onStartSync: () -> Unit,
    vm: SyncCenterViewModel = viewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()

    AppBackground {
        Column(Modifier.fillMaxSize()) {
            AppTopBar(
                title = stringResource(R.string.sync_center_title),
                navigationIcon = {
                    TextButton(onClick = onBack) {
                        Text(stringResource(R.string.sync_auth_cancel))
                    }
                },
            )
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (state.error != null) {
                    QyErrorBanner(message = state.error.orEmpty(), onRetry = { vm.refreshBacklog() })
                }

                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            stringResource(R.string.sync_center_backlog_title),
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(
                            stringResource(R.string.sync_center_backlog_value, state.localBacklog),
                            style = MaterialTheme.typography.bodyLarge,
                        )
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(stringResource(R.string.sync_center_remind))
                            Switch(
                                checked = state.remindUnsynced,
                                onCheckedChange = vm::setRemindUnsynced,
                            )
                        }
                        Text(
                            stringResource(R.string.sync_center_remind_hint),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            stringResource(R.string.sync_center_targets),
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable(onClick = onOpenLanAuth)
                                .padding(vertical = 8.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(stringResource(R.string.sync_center_lan))
                                Text(
                                    if (state.lanAuthorized) {
                                        stringResource(R.string.sync_center_lan_authorized)
                                    } else {
                                        stringResource(R.string.sync_center_lan_need_auth)
                                    },
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Text(stringResource(R.string.sync_auth_continue))
                        }
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable(onClick = onOpenServerSetup)
                                .padding(vertical = 8.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(stringResource(R.string.sync_center_server))
                                Text(
                                    if (state.serverConfigured) {
                                        stringResource(R.string.sync_center_server_ready)
                                    } else {
                                        stringResource(R.string.sync_center_server_placeholder)
                                    },
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }

                if (state.running) {
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(
                                stringResource(
                                    R.string.sync_center_progress,
                                    state.progressLabel ?: "…",
                                    state.sent,
                                    state.received,
                                ),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            OutlinedButton(onClick = vm::cancelSync, modifier = Modifier.fillMaxWidth()) {
                                Text(stringResource(R.string.sync_center_cancel))
                            }
                        }
                    }
                } else {
                    Button(
                        onClick = {
                            val target = when {
                                state.lanAuthorized -> com.qingyu.companion.network.sync.SyncCoordinator.Target.LAN
                                state.serverConfigured -> com.qingyu.companion.network.sync.SyncCoordinator.Target.SERVER
                                else -> return@Button
                            }
                            vm.startSync(target)
                        },
                        modifier = Modifier.fillMaxWidth(),
                        enabled = state.lanAuthorized || state.serverConfigured,
                    ) {
                        Text(stringResource(R.string.sync_center_start))
                    }
                    if (!state.lanAuthorized && !state.serverConfigured) {
                        Text(
                            stringResource(R.string.sync_center_need_target),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                if (state.lastSyncAt != null) {
                    Text(
                        stringResource(
                            R.string.sync_center_last,
                            state.lastSyncResult ?: "-",
                            state.sent,
                            state.received,
                        ),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                Spacer(Modifier.height(24.dp))
            }
        }
    }
}
