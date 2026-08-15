package com.qingyu.companion.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.qingyu.companion.ui.theme.Accent
import com.qingyu.companion.ui.theme.TavernBg
import com.qingyu.companion.ui.theme.TavernBgSoft

/**
 * 全局视觉组件：「深夜墨水与灯火」。
 * - [AppBackground]：墨蓝黑渐变 + 顶部琥珀微光 + 底部冷光晕（沉浸氛围）
 * - [AppTopBar]：半透明玻璃顶栏（毛玻璃效果）
 */

/** 页面背景：墨紫黑垂直渐变 + 顶部灯火微光 + 底部光晕（主题锁定深色，对齐 PC 端） */
@Composable
fun AppBackground(
    content: @Composable () -> Unit,
) {
    val topGlow = Accent.copy(alpha = 0.10f)
    val bottomGlow = Color(0xFF9B7EDE).copy(alpha = 0.08f)
    Box(Modifier.fillMaxSize()) {
        // 渐变基底
        Box(
            Modifier
                .fillMaxSize()
                .background(
                    Brush.verticalGradient(
                        colors = listOf(Color(0xFF14111E), TavernBg, TavernBgSoft)
                    )
                )
        )
        // 顶部灯火微光
        Box(
            Modifier
                .align(Alignment.TopCenter)
                .size(420.dp)
                .blur(90.dp)
                .background(topGlow, CircleShape)
        )
        // 底部冷光晕
        Box(
            Modifier
                .align(Alignment.BottomCenter)
                .size(380.dp)
                .blur(100.dp)
                .background(bottomGlow, CircleShape)
        )
        content()
    }
}

/** 半透明玻璃顶栏（背景渐隐，标题衬线） */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppTopBar(
    title: String,
    navigationIcon: (@Composable () -> Unit)? = null,
    actions: (@Composable () -> Unit)? = null,
) {
    TopAppBar(
        title = {
            Text(
                title,
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.onBackground,
            )
        },
        navigationIcon = { navigationIcon?.invoke() },
        actions = { actions?.invoke() },
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = Color.Transparent,
            scrolledContainerColor = Color.Transparent,
        ),
    )
}

/** 品牌标识：衬线大标题 + 灯火光点 */
@Composable
fun BrandMark(
    name: String,
    subtitle: String,
    modifier: Modifier = Modifier,
) {
    var visible by remember { mutableStateOf(false) }
    val alpha by animateFloatAsState(
        targetValue = if (visible) 1f else 0f,
        animationSpec = tween(600),
        label = "brandReveal",
    )
    LaunchedEffect(Unit) { visible = true }

    Box(
        modifier = modifier.alpha(alpha),
        contentAlignment = Alignment.Center,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                name,
                style = MaterialTheme.typography.headlineLarge,
                color = MaterialTheme.colorScheme.onBackground,
            )
            // 灯火光点：标题右上微光
            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .size(8.dp)
                    .shadow(8.dp, CircleShape)
                    .clip(CircleShape)
                    .background(Accent)
            )
        }
        Text(
            subtitle,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.align(Alignment.BottomCenter).alpha(0.85f),
        )
    }
}
