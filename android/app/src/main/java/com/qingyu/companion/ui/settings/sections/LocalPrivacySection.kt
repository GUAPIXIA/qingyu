package com.qingyu.companion.ui.settings.sections

import android.Manifest
import android.content.Context
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.qingyu.companion.R
import com.qingyu.companion.ui.notification.TaskNotificationEnableAction
import com.qingyu.companion.ui.notification.decideTaskNotificationEnableAction
import com.qingyu.companion.ui.notification.findActivity
import com.qingyu.companion.ui.notification.hasAskedNotificationPermission
import com.qingyu.companion.ui.notification.markNotificationPermissionAsked
import com.qingyu.companion.ui.settings.components.SettingsSection
import com.qingyu.companion.ui.settings.components.SettingsNavRow
import com.qingyu.companion.ui.settings.components.SettingsSwitchRow
import com.qingyu.companion.ui.settings.openSystemNotificationSettings
import com.qingyu.companion.ui.theme.qyColors
import kotlinx.coroutines.launch

/**
 * 隐私/通知区（仅本机）：任务通知开关 + 隐藏内容 + 免打扰 + 系统设置 + 应用锁 + 隐藏预览
 * E-03 从 SettingsScreen 抽出
 */
@Composable
fun LocalPrivacySection(
    notifEnabled: Boolean,
    notifHideContent: Boolean,
    notifDndEnabled: Boolean,
    notifDndStart: Int,
    notifDndEnd: Int,
    appLockEnabled: Boolean,
    hidePreview: Boolean,
    onNotifEnabledChange: (Boolean) -> Unit,
    onNotifHideContentChange: (Boolean) -> Unit,
    onNotifDndEnabledChange: (Boolean) -> Unit,
    onNotifDndWindowChange: (Int, Int) -> Unit,
    onAppLockChange: (Boolean) -> Unit,
    onHidePreviewChange: (Boolean) -> Unit,
) {
    val qy = qyColors()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    SettingsSection(
        title = stringResource(R.string.settings_section_notification),
        tag = stringResource(R.string.settings_group_local_only),
    ) {
        val activity = remember(context) { context.findActivity() }
        var showNotifPurpose by remember { mutableStateOf(false) }
        var notifPermissionDenied by remember { mutableStateOf(false) }
        val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            notifPermissionDenied = !granted
        }
        SettingsSwitchRow(
            title = stringResource(R.string.settings_notification_task),
            subtitle = stringResource(R.string.notif_task_switch_subtitle),
            checked = notifEnabled,
            onCheckedChange = { enabled ->
                if (!enabled) {
                    onNotifEnabledChange(false)
                } else {
                    showNotifPurpose = true
                }
            },
        )
        if (notifPermissionDenied) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(R.string.notif_permission_denied),
                    style = MaterialTheme.typography.bodySmall,
                    color = qy.soft,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = {
                    openSystemNotificationSettings(context)
                }) { Text(stringResource(R.string.notif_open_settings), color = qy.accent) }
            }
        }
        if (showNotifPurpose) {
            AlertDialog(
                onDismissRequest = { showNotifPurpose = false },
                containerColor = qy.card,
                title = { Text(stringResource(R.string.notif_purpose_title), color = qy.text) },
                text = { Text(stringResource(R.string.notif_purpose_message), color = qy.soft) },
                confirmButton = {
                    TextButton(onClick = {
                        showNotifPurpose = false
                        onNotifEnabledChange(true)
                        val permissionRequired = Build.VERSION.SDK_INT >= 33
                        val granted = androidx.core.content.ContextCompat.checkSelfPermission(
                            context, Manifest.permission.POST_NOTIFICATIONS,
                        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
                        when (decideTaskNotificationEnableAction(
                            permissionRequired = permissionRequired,
                            granted = granted,
                            shouldShowRationale = activity?.let {
                                androidx.core.app.ActivityCompat.shouldShowRequestPermissionRationale(
                                    it, Manifest.permission.POST_NOTIFICATIONS,
                                )
                            } ?: false,
                            askedBefore = hasAskedNotificationPermission(context),
                        )) {
                            TaskNotificationEnableAction.None -> Unit
                            TaskNotificationEnableAction.RequestSystem -> {
                                markNotificationPermissionAsked(context)
                                permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                            }
                            TaskNotificationEnableAction.OpenSystemSettings -> {
                                notifPermissionDenied = true
                                openSystemNotificationSettings(context)
                            }
                        }
                    }) { Text(stringResource(R.string.notif_purpose_confirm), color = qy.accent) }
                },
                dismissButton = {
                    TextButton(onClick = { showNotifPurpose = false }) { Text(stringResource(R.string.action_cancel), color = qy.soft) }
                },
            )
        }
        SettingsSwitchRow(
            title = stringResource(R.string.settings_notification_hide_content),
            subtitle = stringResource(R.string.settings_notification_hide_content_desc),
            checked = notifHideContent,
            onCheckedChange = onNotifHideContentChange,
        )
        SettingsSwitchRow(
            title = stringResource(R.string.settings_notification_dnd),
            subtitle = stringResource(R.string.settings_notification_dnd_desc, notifDndStart, notifDndEnd),
            checked = notifDndEnabled,
            onCheckedChange = onNotifDndEnabledChange,
        )
        if (notifDndEnabled) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(stringResource(R.string.settings_notification_dnd_period), style = MaterialTheme.typography.bodySmall, color = qy.soft)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(22 to 7, 23 to 7, 0 to 8).forEach { (s, e) ->
                        val selected = notifDndStart == s && notifDndEnd == e
                        FilterChip(
                            selected = selected,
                            onClick = { onNotifDndWindowChange(s, e) },
                            label = { Text(stringResource(R.string.settings_notification_dnd_chip, s, e), style = MaterialTheme.typography.labelSmall) },
                        )
                    }
                }
            }
        }
        SettingsNavRow(
            title = stringResource(R.string.settings_notification_system_settings),
            subtitle = stringResource(R.string.settings_notification_system_settings_desc),
            onClick = { openSystemNotificationSettings(context) },
        )
    }

    SettingsSection(
        title = stringResource(R.string.settings_section_privacy),
        tag = stringResource(R.string.settings_group_local_only),
    ) {
        SettingsSwitchRow(
            title = stringResource(R.string.settings_privacy_app_lock),
            subtitle = stringResource(R.string.settings_privacy_app_lock_desc),
            checked = appLockEnabled,
            onCheckedChange = onAppLockChange,
        )
        SettingsSwitchRow(
            title = stringResource(R.string.settings_privacy_hide_preview),
            subtitle = stringResource(R.string.settings_privacy_hide_preview_desc),
            checked = hidePreview,
            onCheckedChange = onHidePreviewChange,
        )
        Text(
            stringResource(R.string.msg_token_encrypted),
            style = MaterialTheme.typography.labelSmall,
            color = qy.soft,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
        )
    }
}

/**
 * 判定 DND 时段 chip 是否选中（纯函数，可单测）
 */
fun isDndWindowSelected(currentStart: Int, currentEnd: Int, candidateStart: Int, candidateEnd: Int): Boolean =
    currentStart == candidateStart && currentEnd == candidateEnd
