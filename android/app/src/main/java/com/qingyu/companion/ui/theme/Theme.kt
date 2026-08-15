package com.qingyu.companion.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 主题：完全对齐 PC 端「轻语」深色配色（src/index.css :root.dark）。
 *
 * 关键色（与 PC 端一致）：
 * - 背景 #1a1625（深紫黑）/ 卡片 #2a2440（紫灰）/ 描边 #3d3458
 * - 主色 accent #d4a574（暖金）/ hover #e0b585 / soft rgba(212,165,116,0.15)
 * - 用户气泡 #d4a574（暖金）/ AI 气泡 #9b7ede（紫罗兰）
 * - 文字 #e8e0f0 / #a89db8 / #6b6280
 */

// ===================== PC 端配色（深色） =====================

val TavernBg = Color(0xFF1A1625)        // --tavern-bg
val TavernBgSoft = Color(0xFF221D33)    // --tavern-bg-soft
val TavernBgCard = Color(0xFF2A2440)    // --tavern-bg-card
val TavernBgHover = Color(0xFF332B4D)   // --tavern-bg-hover
val TavernBorder = Color(0xFF3D3458)    // --tavern-border
val TavernBorderSoft = Color(0xFF2F2848) // --tavern-border-soft
val TavernText = Color(0xFFE8E0F0)      // --tavern-text
val TavernTextSoft = Color(0xFFA89DB8)  // --tavern-text-soft
val TavernTextMuted = Color(0xFF6B6280) // --tavern-text-muted

val Accent = Color(0xFFD4A574)          // --color-accent（暖金）
val AccentHover = Color(0xFFE0B585)     // --color-accent-hover
val AccentSoft = Color(0x26D4A574)      // rgba(212,165,116,0.15)

val UserBubble = Color(0xFFD4A574)      // --tavern-user
val AssistantBubble = Color(0xFF9B7EDE) // --tavern-assistant

val DangerRed = Color(0xFFC75450)       // --tavern-danger
val SuccessGreen = Color(0xFF7EC97E)    // --tavern-success
val WarningGold = Color(0xFFE0C068)     // --tavern-warning

// ===================== 浅色（可读降级，对齐 PC 端 light） =====================

private val LightColors = lightColorScheme(
    primary = Accent,
    onPrimary = Color(0xFF3B2410),
    primaryContainer = Color(0xFF2B1A0A),
    onPrimaryContainer = Color(0xFFFFE2C8),
    secondary = AssistantBubble,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFF3B2F5C),
    onSecondaryContainer = Color(0xFFE4DAFF),
    background = Color(0xFFF8F7FA),
    onBackground = Color(0xFF201A14),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF201A14),
    surfaceVariant = Color(0xFFF0E8DE),
    onSurfaceVariant = Color(0xFF5C5248),
    outline = Color(0xFFD8CFC3),
    error = DangerRed,
    onError = Color.White,
)

private val DarkColors = darkColorScheme(
    primary = Accent,
    onPrimary = Color(0xFF3B2410),
    primaryContainer = Color(0xFF2B1A0A),
    onPrimaryContainer = AccentHover,
    secondary = AssistantBubble,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFF3B2F5C),
    onSecondaryContainer = Color(0xFFE4DAFF),
    tertiary = Color(0xFFD8C0FF),
    background = TavernBg,
    onBackground = TavernText,
    surface = TavernBgCard,
    onSurface = TavernText,
    surfaceVariant = TavernBgSoft,
    onSurfaceVariant = TavernTextSoft,
    outline = TavernBorder,
    outlineVariant = TavernBorderSoft,
    error = DangerRed,
    onError = Color.White,
    errorContainer = Color(0xFF4A2420),
    onErrorContainer = Color(0xFFFFD9D1),
    surfaceContainer = TavernBgSoft,
    surfaceContainerHigh = TavernBgHover,
    surfaceContainerHighest = Color(0xFF3A3152),
    surfaceContainerLow = TavernBgSoft,
    surfaceContainerLowest = TavernBg,
)

// ===================== 形状（对齐 PC 端圆角风格） =====================

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(18.dp),
    extraLarge = RoundedCornerShape(24.dp),
)

// ===================== 字体（对齐 PC 端：Noto Sans SC 正文 + 衬线 display） =====================

private val AppTypography = Typography(
    // display 用衬线（PC 端 Cinzel 的移动端降级：中文走系统衬线）
    headlineLarge = androidx.compose.ui.text.TextStyle(
        fontFamily = FontFamily.Serif,
        fontWeight = FontWeight.Bold,
        fontSize = 30.sp,
        lineHeight = 38.sp,
    ),
    headlineMedium = androidx.compose.ui.text.TextStyle(
        fontFamily = FontFamily.Serif,
        fontWeight = FontWeight.Bold,
        fontSize = 24.sp,
        lineHeight = 32.sp,
    ),
    titleLarge = androidx.compose.ui.text.TextStyle(
        fontFamily = FontFamily.Serif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 20.sp,
        lineHeight = 28.sp,
    ),
    titleMedium = androidx.compose.ui.text.TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 16.sp,
        lineHeight = 24.sp,
    ),
    titleSmall = androidx.compose.ui.text.TextStyle(
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
    bodyLarge = androidx.compose.ui.text.TextStyle(
        fontSize = 16.sp,
        lineHeight = 24.sp,
        letterSpacing = 0.2.sp,
    ),
    bodyMedium = androidx.compose.ui.text.TextStyle(
        fontSize = 14.sp,
        lineHeight = 21.sp,
        letterSpacing = 0.2.sp,
    ),
    bodySmall = androidx.compose.ui.text.TextStyle(
        fontSize = 12.sp,
        lineHeight = 18.sp,
        letterSpacing = 0.2.sp,
    ),
    labelLarge = androidx.compose.ui.text.TextStyle(
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
    labelMedium = androidx.compose.ui.text.TextStyle(
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
        lineHeight = 16.sp,
    ),
    labelSmall = androidx.compose.ui.text.TextStyle(
        fontSize = 11.sp,
        lineHeight = 15.sp,
    ),
)

@Composable
fun CompanionTheme(
    // 浅色模式为后续待办（见 docs/安卓视觉升级方案.md）；当前锁定深色，对齐 PC 端。
    // 组件层（卡片/气泡/背景）均按深色设计，跟随系统浅色会导致深浅混用、文字不可读。
    darkTheme: Boolean = true,
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        shapes = AppShapes,
        typography = AppTypography,
    ) {
        // 根级默认内容色：未显式指定颜色的 Text/图标在深色背景上保持亮色，
        // 避免回退到 Compose 默认前景黑导致不可读。
        CompositionLocalProvider(LocalContentColor provides TavernText) {
            content()
        }
    }
}

// ===================== 兼容别名（旧命名 -> 新 PC 端配色） =====================
// 迁移期保留旧常量名，指向对齐后的 PC 端配色，避免大面积编译错误

@Deprecated("使用 Accent", ReplaceWith("Accent"))
val Lantern = Accent
@Deprecated("使用 AccentHover", ReplaceWith("AccentHover"))
val LanternSoft = AccentHover
@Deprecated("使用 Accent", ReplaceWith("Accent"))
val LanternDeep = Color(0xFFC49060)
@Deprecated("使用 onPrimary", ReplaceWith("Color(0xFF3B2410)"))
val OnLantern = Color(0xFF3B2410)
@Deprecated("使用 AssistantBubble", ReplaceWith("AssistantBubble"))
val NightSky = AssistantBubble
@Deprecated("使用 AssistantBubble", ReplaceWith("AssistantBubble"))
val NightSkySoft = Color(0xFFD8C0FF)
@Deprecated("使用 AssistantBubble", ReplaceWith("AssistantBubble"))
val NightSkyDeep = Color(0xFF7B5EA7)
@Deprecated("使用 TavernBg", ReplaceWith("TavernBg"))
val Ink950 = TavernBg
@Deprecated("使用 TavernBg", ReplaceWith("TavernBg"))
val Ink900 = TavernBg
@Deprecated("使用 TavernBgCard", ReplaceWith("TavernBgCard"))
val Ink850 = TavernBgCard
@Deprecated("使用 TavernBgSoft", ReplaceWith("TavernBgSoft"))
val Ink800 = TavernBgSoft
@Deprecated("使用 TavernBorder", ReplaceWith("TavernBorder"))
val Ink700 = TavernBorder
@Deprecated("使用 SuccessGreen", ReplaceWith("SuccessGreen"))
val MintGreen = SuccessGreen
@Deprecated("使用 TavernText", ReplaceWith("TavernText"))
val PaperBright = TavernText
@Deprecated("使用 TavernTextSoft", ReplaceWith("TavernTextSoft"))
val PaperMuted = TavernTextSoft
@Deprecated("使用 TavernTextMuted", ReplaceWith("TavernTextMuted"))
val PaperDim = TavernTextMuted
@Deprecated("使用 DangerRed", ReplaceWith("DangerRed"))
val CoralRed = DangerRed
