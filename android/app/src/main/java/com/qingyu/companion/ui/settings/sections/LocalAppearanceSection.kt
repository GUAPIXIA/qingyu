package com.qingyu.companion.ui.settings.sections

import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.qingyu.companion.R
import com.qingyu.companion.data.ChatFontScale
import com.qingyu.companion.data.ChatSpacing
import com.qingyu.companion.data.ThemeMode
import com.qingyu.companion.ui.components.SettingsChoiceRow
import com.qingyu.companion.ui.settings.components.SettingsSection
import com.qingyu.companion.ui.settings.components.SettingsSwitchRow

/**
 * 外观区（仅本机）：主题模式 / 聊天字体 / 消息间距 / 角色封面背景
 * E-03 从 SettingsScreen 抽出，参数为必要 state+回调
 */
@Composable
fun LocalAppearanceSection(
    themeMode: ThemeMode,
    fontScale: Float,
    spacingMult: Float,
    bgEnabled: Boolean,
    onThemeModeChange: (ThemeMode) -> Unit,
    onFontScaleChange: (ChatFontScale) -> Unit,
    onSpacingChange: (ChatSpacing) -> Unit,
    onBgEnabledChange: (Boolean) -> Unit,
) {
    val ctx = LocalContext.current
    SettingsSection(
        title = stringResource(R.string.settings_section_appearance),
        tag = stringResource(R.string.settings_group_local_only),
    ) {
        SettingsChoiceRow(
            title = stringResource(R.string.settings_appearance_theme_mode),
            selected = themeMode,
            options = ThemeMode.entries,
            labelOf = { it.label },
            onSelect = onThemeModeChange,
        )
        val fontOption = ChatFontScale.entries.firstOrNull { it.scale == fontScale } ?: ChatFontScale.STANDARD
        SettingsChoiceRow(
            title = stringResource(R.string.settings_appearance_chat_font_scale),
            selected = fontOption,
            options = ChatFontScale.entries,
            labelOf = { it.label },
            subtitleOf = { ctx.getString(R.string.settings_appearance_font_scale_desc, it.scale.toString()) },
            onSelect = onFontScaleChange,
        )
        val spacingOption = ChatSpacing.entries.firstOrNull { it.multiplier == spacingMult } ?: ChatSpacing.STANDARD
        SettingsChoiceRow(
            title = stringResource(R.string.settings_appearance_message_spacing),
            selected = spacingOption,
            options = ChatSpacing.entries,
            labelOf = { it.label },
            subtitleOf = { ctx.getString(R.string.settings_appearance_spacing_desc, it.multiplier.toString()) },
            onSelect = onSpacingChange,
        )
        SettingsSwitchRow(
            title = stringResource(R.string.settings_appearance_chat_bg),
            subtitle = stringResource(R.string.settings_appearance_chat_bg_desc),
            checked = bgEnabled,
            onCheckedChange = onBgEnabledChange,
        )
    }
}
