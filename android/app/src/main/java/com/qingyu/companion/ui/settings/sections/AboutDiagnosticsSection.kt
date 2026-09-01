package com.qingyu.companion.ui.settings.sections

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.qingyu.companion.BuildConfig
import com.qingyu.companion.R
import com.qingyu.companion.ui.settings.SettingsViewModel
import com.qingyu.companion.ui.settings.components.SettingsNavRow
import com.qingyu.companion.ui.settings.components.SettingsSection
import com.qingyu.companion.ui.theme.qyColors

/**
 * 关于/诊断区：用量统计 / 公告 / 版本 / 检查更新 / 诊断信息
 * E-03 从 SettingsScreen 抽出
 */
@Composable
fun AboutDiagnosticsSection(
    vm: SettingsViewModel,
    ui: SettingsViewModel.UiState,
    onOpenUsage: () -> Unit,
    onOpenAnnouncements: () -> Unit,
) {
    val qy = qyColors()
    val context = LocalContext.current

    SettingsSection(title = stringResource(R.string.settings_section_about)) {
        SettingsNavRow(
            title = stringResource(R.string.settings_about_usage),
            subtitle = stringResource(R.string.settings_about_usage_desc),
            onClick = onOpenUsage,
        )
        SettingsNavRow(
            title = stringResource(R.string.settings_about_announcements),
            subtitle = stringResource(R.string.settings_about_announcements_desc),
            onClick = onOpenAnnouncements,
        )
        SettingsNavRow(
            title = stringResource(R.string.settings_about_app),
            subtitle = stringResource(R.string.settings_about_app_desc, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE),
        )
        SettingsNavRow(
            title = stringResource(R.string.settings_about_check_update),
            subtitle = when {
                ui.checkingVersion -> stringResource(R.string.settings_about_check_update_checking)
                ui.latestVersion != null -> stringResource(R.string.settings_about_check_update_latest, ui.latestVersion!!.effectiveVersion)
                else -> stringResource(R.string.settings_about_check_update_idle)
            },
            onClick = vm::checkVersion,
            busy = ui.checkingVersion,
        )
    }

    ui.latestVersion?.let { info ->
        AlertDialog(
            onDismissRequest = vm::clearLatestVersion,
            containerColor = qy.card,
            title = { Text(stringResource(R.string.settings_dialog_update_title, info.effectiveVersion), color = qy.text) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        stringResource(R.string.settings_dialog_update_current, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE),
                        color = qy.soft,
                    )
                    if (info.effectiveChangelog.isNotBlank()) {
                        Text(
                            stringResource(R.string.settings_dialog_update_changelog_title),
                            style = MaterialTheme.typography.labelLarge,
                            color = qy.accent,
                        )
                        Text(
                            info.effectiveChangelog,
                            style = MaterialTheme.typography.bodySmall,
                            color = qy.soft,
                        )
                    }
                    if (info.effectiveDownloadUrl.isBlank()) {
                        Text(
                            stringResource(R.string.settings_dialog_update_no_url),
                            style = MaterialTheme.typography.bodySmall,
                            color = qy.soft,
                        )
                    }
                }
            },
            confirmButton = {
                if (info.effectiveDownloadUrl.isNotBlank()) {
                    TextButton(onClick = {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(info.effectiveDownloadUrl)))
                    }) { Text(stringResource(R.string.action_download), color = qy.accent) }
                }
            },
            dismissButton = {
                TextButton(onClick = vm::clearLatestVersion) { Text(stringResource(R.string.action_close), color = qy.soft) }
            },
        )
    }
}
