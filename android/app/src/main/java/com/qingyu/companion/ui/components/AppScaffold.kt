package com.qingyu.companion.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.qingyu.companion.ui.theme.qyColors

/**
 * 方案 B · 情感极简 —— 全局视觉骨架。
 * - [AppBackground]：纯色全局底（无渐变、无光晕、无背景遮挡）
 * - [AppTopBar]：全透明顶栏（无背景、无底线，不遮挡内容）
 */

/** 页面背景：纯色（方案 B 情感极简） */
@Composable
fun AppBackground(
    content: @Composable () -> Unit,
) {
    val qy = qyColors()
    Box(
        Modifier
            .fillMaxSize()
            .background(qy.bg),
    ) {
        content()
    }
}

/**
 * 顶栏：全透明浮层（无背景、无底线），不遮挡内容。
 *
 * @param subtitle 标题下的小字副标题（如对话页「已连接」），null 时不占位
 */
@Composable
fun AppTopBar(
    title: String,
    subtitle: String? = null,
    navigationIcon: (@Composable () -> Unit)? = null,
    actions: (@Composable () -> Unit)? = null,
    compact: Boolean = true,
) {
    val qy = qyColors()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(if (subtitle != null) 56.dp else 52.dp)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (navigationIcon != null) {
            navigationIcon()
        }
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(start = if (navigationIcon != null) 4.dp else 0.dp),
        ) {
            Text(
                title,
                style = MaterialTheme.typography.titleLarge,
                color = qy.text,
                maxLines = 1,
            )
            if (subtitle != null) {
                Spacer(Modifier.height(1.dp))
                Text(
                    subtitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = qy.muted,
                    maxLines = 1,
                )
            }
        }
        actions?.invoke()
    }
}
