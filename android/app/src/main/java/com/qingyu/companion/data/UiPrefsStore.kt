package com.qingyu.companion.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * 安卓端本地 UI 偏好（纯显示设置，不回写 PC——避免相互影响显示）。
 *
 * - 聊天字体大小：小 / 标准 / 大 / 特大（缩放系数）
 * - 消息间距：紧凑 / 标准 / 宽松
 */
private val Context.uiPrefsDataStore by preferencesDataStore(name = "companion_ui_prefs")

/** 聊天字体档位 */
enum class ChatFontScale(val label: String, val scale: Float) {
    COMPACT("小", 0.88f),
    STANDARD("标准", 1f),
    LOOSE("大", 1.15f),
    XLARGE("特大", 1.3f),
}

/** 消息间距档位（垂直 padding 倍数） */
enum class ChatSpacing(val label: String, val multiplier: Float) {
    COMPACT("紧凑", 0.6f),
    STANDARD("标准", 1f),
    LOOSE("宽松", 1.6f),
}

/** 主题模式（深色/浅色/跟随系统） */
enum class ThemeMode(val label: String) {
    DARK("深色"),
    LIGHT("浅色"),
    SYSTEM("跟随系统"),
}

class UiPrefsStore(private val context: Context) {

    private object Keys {
        val FONT_SCALE = stringPreferencesKey("chat_font_scale")
        val SPACING = stringPreferencesKey("chat_spacing")
        val THEME_MODE = stringPreferencesKey("theme_mode")
        val CHAT_BACKGROUND = booleanPreferencesKey("chat_background")
    }

    /** 当前字体缩放系数（默认标准 1f） */
    val fontScale: Flow<Float> = context.uiPrefsDataStore.data
        .map { prefs ->
            prefs[Keys.FONT_SCALE]?.let { name ->
                runCatching { ChatFontScale.valueOf(name).scale }.getOrNull()
            } ?: ChatFontScale.STANDARD.scale
        }

    /** 当前消息间距倍数（默认标准 1f） */
    val spacingMultiplier: Flow<Float> = context.uiPrefsDataStore.data
        .map { prefs ->
            prefs[Keys.SPACING]?.let { name ->
                runCatching { ChatSpacing.valueOf(name).multiplier }.getOrNull()
            } ?: ChatSpacing.STANDARD.multiplier
        }

    /** 当前主题模式（默认跟随系统） */
    val themeMode: Flow<ThemeMode> = context.uiPrefsDataStore.data
        .map { prefs ->
            prefs[Keys.THEME_MODE]?.let { name ->
                runCatching { ThemeMode.valueOf(name) }.getOrNull()
            } ?: ThemeMode.SYSTEM
        }

    /** 对话页是否以角色封面作背景（默认开启） */
    val chatBackground: Flow<Boolean> = context.uiPrefsDataStore.data
        .map { prefs -> prefs[Keys.CHAT_BACKGROUND] ?: true }

    suspend fun setFontScale(scale: ChatFontScale) {
        context.uiPrefsDataStore.edit { it[Keys.FONT_SCALE] = scale.name }
    }

    suspend fun setSpacing(spacing: ChatSpacing) {
        context.uiPrefsDataStore.edit { it[Keys.SPACING] = spacing.name }
    }

    suspend fun setThemeMode(mode: ThemeMode) {
        context.uiPrefsDataStore.edit { it[Keys.THEME_MODE] = mode.name }
    }

    suspend fun setChatBackground(enabled: Boolean) {
        context.uiPrefsDataStore.edit { it[Keys.CHAT_BACKGROUND] = enabled }
    }
}
