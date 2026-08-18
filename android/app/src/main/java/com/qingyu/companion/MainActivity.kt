package com.qingyu.companion

import android.app.Activity
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.core.view.WindowCompat
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.data.ThemeMode
import com.qingyu.companion.ui.navigation.CompanionNavHost
import com.qingyu.companion.ui.theme.CompanionTheme
import com.qingyu.companion.ui.theme.qyColors

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 全屏绘制：状态栏/导航栏透明，内容延伸到系统栏区域
        enableEdgeToEdge()
        val container = (application as CompanionApp).container
        setContent {
            CompositionLocalProvider(LocalAppContainer provides container) {
                val themeMode by container.uiPrefsStore.themeMode.collectAsState(initial = ThemeMode.SYSTEM)
                val darkTheme = when (themeMode) {
                    ThemeMode.DARK -> true
                    ThemeMode.LIGHT -> false
                    ThemeMode.SYSTEM -> isSystemInDarkTheme()
                }
                CompanionTheme(darkTheme = darkTheme) {
                    val qy = qyColors()
                    val context = LocalContext.current
                    // 窗口背景与主题底一致：顶栏/状态栏区域透明后露出的即是页面底色
                    SideEffect {
                        val window = (context as Activity).window
                        window.setBackgroundDrawable(ColorDrawable(qy.bg.toArgb()))
                        WindowCompat.getInsetsController(window, window.decorView).apply {
                            isAppearanceLightStatusBars = !darkTheme
                            isAppearanceLightNavigationBars = !darkTheme
                        }
                    }
                    CompanionNavHost()
                }
            }
        }
    }
}
