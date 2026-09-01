package com.qingyu.companion

import android.app.Activity
import android.content.Intent
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.core.view.WindowCompat
import androidx.fragment.app.FragmentActivity
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.data.ThemeMode
import com.qingyu.companion.ui.navigation.CompanionNavHost
import com.qingyu.companion.ui.notification.AppNotificationHelper
import com.qingyu.companion.ui.notification.NotificationDeepLink
import com.qingyu.companion.ui.notification.notificationTargetFromIntent
import com.qingyu.companion.ui.notification.shouldShowFirstGenerationNotificationHint
import com.qingyu.companion.ui.theme.CompanionTheme
import com.qingyu.companion.ui.theme.qyColors
import kotlinx.coroutines.delay

class MainActivity : FragmentActivity() {

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // A-03：运行中点通知（singleTop 复用 Activity）→ 提取目标，由 CompanionNavHost 立即消费
        NotificationDeepLink.post(notificationTargetFromIntent(intent))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A-06：不再于启动时申请 POST_NOTIFICATIONS；
        // 权限改为「设置-任务通知」开启时经用途说明确认后延迟申请（见 SettingsScreen）。
        // 全屏绘制：状态栏/导航栏透明，内容延伸到系统栏区域
        enableEdgeToEdge()
        val container = (application as CompanionApp).container
        // A-03：冷启动点通知 → 先暂存目标，启动决策（StartupScreen 四态）完成后再消费跳转
        NotificationDeepLink.post(notificationTargetFromIntent(intent))
        setContent {
            CompositionLocalProvider(LocalAppContainer provides container) {
                val themeMode by container.uiPrefsStore.themeMode.collectAsStateWithLifecycle(initialValue = ThemeMode.SYSTEM)
                val darkTheme = when (themeMode) {
                    ThemeMode.DARK -> true
                    ThemeMode.LIGHT -> false
                    ThemeMode.SYSTEM -> isSystemInDarkTheme()
                }
                CompanionTheme(darkTheme = darkTheme) {
                    val qy = qyColors()
                    val context = LocalContext.current
                    // 窗口背景与主题底一致：顶栏/状态栏区域透明后露出的即是页面底色
                    val hidePreview by container.uiPrefsStore.hideTaskPreview.collectAsStateWithLifecycle(initialValue = false)
                    val appLockEnabled by container.uiPrefsStore.appLockEnabled.collectAsStateWithLifecycle(initialValue = false)
                    SideEffect {
                        val window = (context as Activity).window
                        window.setBackgroundDrawable(ColorDrawable(qy.bg.toArgb()))
                        WindowCompat.getInsetsController(window, window.decorView).apply {
                            isAppearanceLightStatusBars = !darkTheme
                            isAppearanceLightNavigationBars = !darkTheme
                        }
                        if (hidePreview) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    }
                    var isUnlocked by remember(appLockEnabled) { mutableStateOf(!appLockEnabled) }
                    LaunchedEffect(appLockEnabled) { if (!appLockEnabled) isUnlocked = true }
                    if (appLockEnabled && !isUnlocked) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Button(onClick = {
                                val mgr = BiometricManager.from(context)
                                if (mgr.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL) != BiometricManager.BIOMETRIC_SUCCESS) { isUnlocked = true; return@Button }
                                val prompt = BiometricPrompt(this@MainActivity, androidx.core.content.ContextCompat.getMainExecutor(context), object : BiometricPrompt.AuthenticationCallback() { override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) { isUnlocked = true } })
                                prompt.authenticate(BiometricPrompt.PromptInfo.Builder().setTitle("验证身份").setSubtitle("解锁轻语伴侣").setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL).build())
                            }) { Text("验证以解锁") }
                        }
                    } else {
                        Box(Modifier.fillMaxSize()) {
                            CompanionNavHost()
                            FirstGenerationNotificationHint(Modifier.align(Alignment.BottomCenter))
                        }
                    }
                }
            }
        }
    }
}

/**
 * A-06：用户首次发起可能后台完成的生成任务且系统通知当前不可投递时，
 * 展示一次性的非阻塞浮层说明；拒绝/忽略授权均不阻断生成流程。
 */
@Composable
private fun FirstGenerationNotificationHint(modifier: Modifier = Modifier) {
    val container = LocalAppContainer.current
    val context = LocalContext.current
    val qy = qyColors()
    val notifEnabled by container.uiPrefsStore.notificationsEnabled.collectAsStateWithLifecycle(initialValue = true)
    val generating by container.generationTracker.state.collectAsStateWithLifecycle()
    var visible by remember { mutableStateOf(false) }
    var decided by remember { mutableStateOf(false) }
    LaunchedEffect(generating?.isGenerating) {
        if (generating?.isGenerating == true && !decided) {
            decided = true
            visible = shouldShowFirstGenerationNotificationHint(
                appNotificationsEnabled = notifEnabled,
                canPostSystem = AppNotificationHelper.canPost(context),
                alreadyShown = false,
            )
        }
    }
    if (visible) {
        LaunchedEffect(Unit) {
            delay(6_000)
            visible = false
        }
        Surface(
            modifier = modifier
                .navigationBarsPadding()
                .padding(horizontal = 24.dp, vertical = 16.dp),
            color = qy.card,
            shape = RoundedCornerShape(14.dp),
        ) {
            Text(
                stringResource(R.string.notif_first_generation_hint),
                style = MaterialTheme.typography.bodySmall,
                color = qy.soft,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
            )
        }
    }
}
