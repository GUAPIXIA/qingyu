package com.qingyu.companion

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.ui.navigation.CompanionNavHost
import com.qingyu.companion.ui.theme.CompanionTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val container = (application as CompanionApp).container
        setContent {
            CompositionLocalProvider(LocalAppContainer provides container) {
                CompanionTheme {
                    CompanionNavHost()
                }
            }
        }
    }
}
