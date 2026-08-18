package com.qingyu.companion.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 方案 B · 情感极简 —— 设计令牌（对齐 ui-samples/方案B-*.html）。
 *
 * 规范要点：
 * - Morandi 低饱和 / 暖灰暗色 / 大圆角 / 呼吸留白；无背景遮挡。
 * - 深色：bg #1b1a19 · 浅色：bg #f4f1ec（同色相仅调明度）。
 * - 字阶：title 17 / body 14.5 / sub 13 / cap 11。
 * - 圆角：lg 18 / md 12 / sm 8 / 输入栏 22 / 底部面板 24。
 * - 间距 8dp 网格：8 / 12 / 16 / 20。
 */

// ===================== 设计令牌 =====================

/** 全量色彩令牌（深浅两套，字段一一对应 HTML 中的 CSS 变量） */
@Immutable
data class QyColors(
    val isDark: Boolean,
    val bg: Color,        // 全局底
    val bg2: Color,       // 次级底：输入容器 / 设置条目 / hover
    val card: Color,      // 卡片 / 底部面板 / 用户气泡底
    val line: Color,      // 分隔线 / 描边
    val lineSoft: Color,  // 淡分隔（顶栏底线等）
    val text: Color,      // 主文字
    val soft: Color,      // 次文字
    val muted: Color,     // 弱文字
    val accent: Color,    // 强调：低饱和暖金
    val accentSoft: Color,// 强调软底（胶囊 / 心理描写底）
    val onAccent: Color,  // 强调上的前景（FAB / 发送键）
    val meBubble: Color,  // 用户气泡底（带描边）
    val aiBubble: Color,  // AI 气泡底
    val danger: Color,    // 低饱和红
    val ok: Color,        // 低饱和绿
    val warn: Color,      // 低饱和金
)

private val DarkPalette = QyColors(
    isDark = true,
    bg = Color(0xFF1B1A19),
    bg2 = Color(0xFF242220),
    card = Color(0xFF2A2725),
    line = Color(0xFF33302D),
    lineSoft = Color(0xFF2A2826),
    text = Color(0xFFECE7E0),
    soft = Color(0xFFB3ACA2),
    muted = Color(0xFF756F68),
    accent = Color(0xFFC9A483),
    accentSoft = Color(0x14C9A483), // 8%
    onAccent = Color(0xFF17130B),
    meBubble = Color(0xFF2A2725),
    aiBubble = Color(0xFF211F1D),
    danger = Color(0xFFD08A86),
    ok = Color(0xFF9ABF9C),
    warn = Color(0xFFC9B27E),
)

private val LightPalette = QyColors(
    isDark = false,
    bg = Color(0xFFF4F1EC),
    bg2 = Color(0xFFECE8E1),
    card = Color(0xFFFFFFFF),
    line = Color(0xFFE0DBD2),
    lineSoft = Color(0xFFEAE6DF),
    text = Color(0xFF2A2620),
    soft = Color(0xFF6B645A),
    muted = Color(0xFFA09A90),
    accent = Color(0xFFA88360),
    accentSoft = Color(0x1AA88360), // 10%
    onAccent = Color(0xFF17130B),
    meBubble = Color(0xFFFFFFFF),
    aiBubble = Color(0xFFEBE7DF),
    danger = Color(0xFFC47A74),
    ok = Color(0xFF7FA97F),
    warn = Color(0xFF8F7A4A),
)

val LocalQyColors = staticCompositionLocalOf { DarkPalette }

/** 组件内取令牌：`val qy = qyColors()` 后 `qy.accent` 等 */
@Composable
fun qyColors(): QyColors = LocalQyColors.current

// ===================== Material 桥接 =====================

private val LightColors = lightColorScheme(
    primary = LightPalette.accent,
    onPrimary = LightPalette.onAccent,
    primaryContainer = Color(0xFFF0E4D6),
    onPrimaryContainer = Color(0xFF2A1A0A),
    background = LightPalette.bg,
    onBackground = LightPalette.text,
    surface = LightPalette.card,
    onSurface = LightPalette.text,
    surfaceVariant = LightPalette.bg2,
    onSurfaceVariant = LightPalette.soft,
    outline = LightPalette.line,
    outlineVariant = LightPalette.lineSoft,
    error = LightPalette.danger,
    onError = Color.White,
    surfaceContainer = LightPalette.bg2,
    surfaceContainerHigh = Color(0xFFE4DFD6),
    surfaceContainerHighest = Color(0xFFDCD6CC),
    surfaceContainerLow = Color(0xFFF0ECE5),
    surfaceContainerLowest = Color.White,
)

private val DarkColors = darkColorScheme(
    primary = DarkPalette.accent,
    onPrimary = DarkPalette.onAccent,
    primaryContainer = Color(0xFF2B1A0A),
    onPrimaryContainer = DarkPalette.accent,
    background = DarkPalette.bg,
    onBackground = DarkPalette.text,
    surface = DarkPalette.card,
    onSurface = DarkPalette.text,
    surfaceVariant = DarkPalette.bg2,
    onSurfaceVariant = DarkPalette.soft,
    outline = DarkPalette.line,
    outlineVariant = DarkPalette.lineSoft,
    error = DarkPalette.danger,
    onError = Color.White,
    errorContainer = Color(0xFF4A2420),
    onErrorContainer = Color(0xFFFFD9D1),
    surfaceContainer = DarkPalette.bg2,
    surfaceContainerHigh = Color(0xFF332F2B),
    surfaceContainerHighest = Color(0xFF3A3633),
    surfaceContainerLow = Color(0xFF211F1D),
    surfaceContainerLowest = DarkPalette.bg,
)

// ===================== 形状（大圆角规范） =====================

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),   // sm
    small = RoundedCornerShape(8.dp),        // sm
    medium = RoundedCornerShape(12.dp),      // md
    large = RoundedCornerShape(18.dp),       // lg
    extraLarge = RoundedCornerShape(24.dp),  // 底部面板
)

// ===================== 字体（title 17 / body 14.5 / sub 13 / cap 11） =====================

private val AppTypography = Typography(
    headlineLarge = typography(24.sp, 32.sp, FontWeight.SemiBold),
    headlineMedium = typography(20.sp, 28.sp, FontWeight.SemiBold),
    titleLarge = typography(17.sp, 24.sp, FontWeight.SemiBold),
    titleMedium = typography(15.5.sp, 22.sp, FontWeight.SemiBold),
    titleSmall = typography(14.sp, 20.sp, FontWeight.Medium),
    bodyLarge = typography(14.5.sp, 24.sp),          // 对话正文（1.7 行距）
    bodyMedium = typography(14.sp, 22.sp),
    bodySmall = typography(13.sp, 20.sp),            // sub
    labelLarge = typography(14.sp, 20.sp, FontWeight.Medium),
    labelMedium = typography(12.sp, 16.sp, FontWeight.Medium),
    labelSmall = typography(11.sp, 15.sp),           // cap
)

private fun typography(
    fontSize: androidx.compose.ui.unit.TextUnit,
    lineHeight: androidx.compose.ui.unit.TextUnit,
    fontWeight: FontWeight = FontWeight.Normal,
) = androidx.compose.ui.text.TextStyle(
    fontWeight = fontWeight,
    fontSize = fontSize,
    lineHeight = lineHeight,
    letterSpacing = 0.2.sp,
)

// ===================== 主题入口 =====================

@Composable
fun CompanionTheme(
    // 深浅色切换：设置页「外观 → 深色模式」，默认跟随系统
    darkTheme: Boolean = true,
    content: @Composable () -> Unit,
) {
    val palette = if (darkTheme) DarkPalette else LightPalette
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        shapes = AppShapes,
        typography = AppTypography,
    ) {
        CompositionLocalProvider(
            LocalQyColors provides palette,
        ) {
            content()
        }
    }
}
