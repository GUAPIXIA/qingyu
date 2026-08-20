package com.qingyu.companion

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.core.view.WindowCompat
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.data.ThemeMode
import com.qingyu.companion.ui.navigation.CompanionNavHost
import com.qingyu.companion.ui.theme.CompanionTheme
import com.qingyu.companion.ui.theme.qyColors

class MainActivity : FragmentActivity() {

    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ -> }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // P1-4.2：Android 13+ 动态申请通知权限（生成中通知）
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        // 全屏绘制：状态栏/导航栏透明，内容延伸到系统栏区域
        enableEdgeToEdge()
        val container = (application as CompanionApp).container
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
                    androidx.compose.runtime.LaunchedEffect(appLockEnabled) { if (!appLockEnabled) isUnlocked = true }
                    if (appLockEnabled && !isUnlocked) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Button(onClick = {
                                val mgr = BiometricManager.from(context)
                                if (mgr.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL) != BiometricManager.BIOMETRIC_SUCCESS) { isUnlocked = true; return@Button }
                                val prompt = BiometricPrompt(this@MainActivity, ContextCompat.getMainExecutor(context), object : BiometricPrompt.AuthenticationCallback() { override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) { isUnlocked = true } })
                                prompt.authenticate(BiometricPrompt.PromptInfo.Builder().setTitle("验证身份").setSubtitle("解锁轻语伴侣").setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL).build())
                            }) { Text("验证以解锁") }
                        }
                    } else {
                        CompanionNavHost()
                    }
                }
            }
        }
    }
}
