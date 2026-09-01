package com.qingyu.companion.ui.settings

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.R
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.data.ThemeMode
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.settings.sections.AboutDiagnosticsSection
import com.qingyu.companion.ui.settings.sections.ConnectionDataSection
import com.qingyu.companion.ui.settings.sections.LocalAppearanceSection
import com.qingyu.companion.ui.settings.sections.LocalPrivacySection
import com.qingyu.companion.ui.settings.sections.PcConversationSection
import com.qingyu.companion.ui.theme.qyColors
import kotlinx.coroutines.launch

/**
 * 设置页编排容器（E-03 精简后：Scaffold + Sections 调用，不再膨胀）
 * 各分区抽至 ui/settings/sections/，行级组件抽至 ui/settings/components/
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onOpenPairing: () -> Unit,
    onOpenUsage: () -> Unit = {},
    onOpenAnnouncements: () -> Unit = {},
    onOpenChat: (() -> Unit)? = null,
) {
    val qy = qyColors()
    val context = LocalContext.current
    val container = LocalAppContainer.current
    val vm: SettingsViewModel = viewModel(factory = viewModelFactory {
        initializer {
            SettingsViewModel(
                repository = container.repository,
                connectionManager = container.connectionManager,
                settingsSync = container.settingsSyncRepository,
                settingsSyncOwned = false,
                diagnosticsProvider = { container.connectionCoordinator.snapshotForDiagnostics() },
                rejectionRegistry = container.settingsRejectionRegistry,
            )
        }
    })
    val ui by vm.ui.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    val fontScale by container.uiPrefsStore.fontScale.collectAsStateWithLifecycle(initialValue = 1f)
    val spacingMult by container.uiPrefsStore.spacingMultiplier.collectAsStateWithLifecycle(initialValue = 1f)
    val themeMode by container.uiPrefsStore.themeMode.collectAsStateWithLifecycle(initialValue = ThemeMode.SYSTEM)
    val bgEnabled by container.uiPrefsStore.chatBackground.collectAsStateWithLifecycle(initialValue = true)
    val appLockEnabled by container.uiPrefsStore.appLockEnabled.collectAsStateWithLifecycle(initialValue = false)
    val hidePreview by container.uiPrefsStore.hideTaskPreview.collectAsStateWithLifecycle(initialValue = false)
    val notifEnabled by container.uiPrefsStore.notificationsEnabled.collectAsStateWithLifecycle(initialValue = true)
    val notifHideContent by container.uiPrefsStore.notificationHideContent.collectAsStateWithLifecycle(initialValue = false)
    val notifDndEnabled by container.uiPrefsStore.notificationDndEnabled.collectAsStateWithLifecycle(initialValue = false)
    val notifDndStart by container.uiPrefsStore.notificationDndStart.collectAsStateWithLifecycle(initialValue = 22)
    val notifDndEnd by container.uiPrefsStore.notificationDndEnd.collectAsStateWithLifecycle(initialValue = 7)

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            AppTopBar(
                title = stringResource(R.string.settings_title),
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.cd_back),
                            tint = qy.soft,
                        )
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
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                LocalAppearanceSection(
                    themeMode = themeMode,
                    fontScale = fontScale,
                    spacingMult = spacingMult,
                    bgEnabled = bgEnabled,
                    onThemeModeChange = { mode -> scope.launch { container.uiPrefsStore.setThemeMode(mode) } },
                    onFontScaleChange = { option -> scope.launch { container.uiPrefsStore.setFontScale(option) } },
                    onSpacingChange = { option -> scope.launch { container.uiPrefsStore.setSpacing(option) } },
                    onBgEnabledChange = { enabled -> scope.launch { container.uiPrefsStore.setChatBackground(enabled) } },
                )

                PcConversationSection(vm = vm, ui = ui, onOpenChat = onOpenChat)

                LocalPrivacySection(
                    notifEnabled = notifEnabled,
                    notifHideContent = notifHideContent,
                    notifDndEnabled = notifDndEnabled,
                    notifDndStart = notifDndStart,
                    notifDndEnd = notifDndEnd,
                    appLockEnabled = appLockEnabled,
                    hidePreview = hidePreview,
                    onNotifEnabledChange = { enabled -> scope.launch { container.uiPrefsStore.setNotificationsEnabled(enabled) } },
                    onNotifHideContentChange = { enabled -> scope.launch { container.uiPrefsStore.setNotificationHideContent(enabled) } },
                    onNotifDndEnabledChange = { enabled -> scope.launch { container.uiPrefsStore.setNotificationDndEnabled(enabled) } },
                    onNotifDndWindowChange = { s, e -> scope.launch { container.uiPrefsStore.setNotificationDndWindow(s, e) } },
                    onAppLockChange = { enabled -> scope.launch { container.uiPrefsStore.setAppLockEnabled(enabled) } },
                    onHidePreviewChange = { enabled -> scope.launch { container.uiPrefsStore.setHideTaskPreview(enabled) } },
                )

                ConnectionDataSection(vm = vm, ui = ui, onOpenPairing = onOpenPairing)

                AboutDiagnosticsSection(vm = vm, ui = ui, onOpenUsage = onOpenUsage, onOpenAnnouncements = onOpenAnnouncements)

                ui.message?.let { message ->
                    Text(
                        text = message,
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (ui.isError) qy.danger else qy.accent,
                    )
                }
            }
        }
    }
}

/** 跳转系统「应用通知设置」（渠道与权限管理）；低版本回退到应用详情页 — 供 LocalPrivacySection 复用 */
internal fun openSystemNotificationSettings(context: Context) {
    val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
            putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
        }
    } else {
        Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.parse("package:${context.packageName}")
        }
    }
    context.startActivity(intent)
}
