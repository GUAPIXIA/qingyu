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
        val APP_LOCK_ENABLED = booleanPreferencesKey("app_lock_enabled")
        val HIDE_TASK_PREVIEW = booleanPreferencesKey("hide_task_preview")
        val NOTIFICATIONS_ENABLED = booleanPreferencesKey("notifications_enabled")
        val NOTIFICATION_HIDE_CONTENT = booleanPreferencesKey("notification_hide_content")
        val NOTIFICATION_DND_ENABLED = booleanPreferencesKey("notification_dnd_enabled")
        val NOTIFICATION_DND_START = intPreferencesKey("notification_dnd_start")
        val NOTIFICATION_DND_END = intPreferencesKey("notification_dnd_end")
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

    /** 应用锁：启动时需生物识别/设备凭据（默认关闭，路线图 4.3） */
    val appLockEnabled: Flow<Boolean> = context.uiPrefsDataStore.data
        .map { prefs -> prefs[Keys.APP_LOCK_ENABLED] ?: false }

    /** 后台隐藏最近任务预览：离开后台后模糊/隐藏（默认关闭） */
    val hideTaskPreview: Flow<Boolean> = context.uiPrefsDataStore.data
        .map { prefs -> prefs[Keys.HIDE_TASK_PREVIEW] ?: false }

    /** 通知总开关（默认开启，Android 13+ 仍需系统权限） */
    val notificationsEnabled: Flow<Boolean> = context.uiPrefsDataStore.data
        .map { prefs -> prefs[Keys.NOTIFICATIONS_ENABLED] ?: true }

    /** 通知内容隐藏：开启后仅显示通用文案，不展示会话/消息内容（默认关闭） */
    val notificationHideContent: Flow<Boolean> = context.uiPrefsDataStore.data
        .map { prefs -> prefs[Keys.NOTIFICATION_HIDE_CONTENT] ?: false }

    /** 免打扰总开关（默认关闭） */
    val notificationDndEnabled: Flow<Boolean> = context.uiPrefsDataStore.data
        .map { prefs -> prefs[Keys.NOTIFICATION_DND_ENABLED] ?: false }

    /** 免打扰开始小时 0-23（默认 22） */
    val notificationDndStart: Flow<Int> = context.uiPrefsDataStore.data
        .map { prefs -> prefs[Keys.NOTIFICATION_DND_START] ?: 22 }

    /** 免打扰结束小时 0-23（默认 7） */
    val notificationDndEnd: Flow<Int> = context.uiPrefsDataStore.data
        .map { prefs -> prefs[Keys.NOTIFICATION_DND_END] ?: 7 }

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

    suspend fun setAppLockEnabled(enabled: Boolean) {
        context.uiPrefsDataStore.edit { it[Keys.APP_LOCK_ENABLED] = enabled }
    }

    suspend fun setHideTaskPreview(enabled: Boolean) {
        context.uiPrefsDataStore.edit { it[Keys.HIDE_TASK_PREVIEW] = enabled }
    }

    suspend fun setNotificationsEnabled(enabled: Boolean) {
        context.uiPrefsDataStore.edit { it[Keys.NOTIFICATIONS_ENABLED] = enabled }
    }

    suspend fun setNotificationHideContent(enabled: Boolean) {
        context.uiPrefsDataStore.edit { it[Keys.NOTIFICATION_HIDE_CONTENT] = enabled }
    }

    suspend fun setNotificationDndEnabled(enabled: Boolean) {
        context.uiPrefsDataStore.edit { it[Keys.NOTIFICATION_DND_ENABLED] = enabled }
    }

    suspend fun setNotificationDndWindow(startHour: Int, endHour: Int) {
        context.uiPrefsDataStore.edit {
            it[Keys.NOTIFICATION_DND_START] = startHour.coerceIn(0, 23)
            it[Keys.NOTIFICATION_DND_END] = endHour.coerceIn(0, 23)
        }
    }
}
