package com.qingyu.companion.ui.shell

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.outlined.Chat
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Person
import androidx.compose.ui.graphics.vector.ImageVector
import com.qingyu.companion.R
import com.qingyu.companion.ui.navigation.Routes

/**
 * E-01 MainShell 一级主栏目。
 *
 * 只承载「会话 / 角色 / 群聊」三个一级栏目；设置保留页内右上角，
 * 聊天详情、角色历史、群聊消息、设置等均为全屏路由（不进底栏，见 Routes）。
 */
enum class MainDestination(
    val route: String,
    val labelRes: Int,
) {
    SESSIONS(Routes.SESSIONS, R.string.shell_tab_sessions),
    CHARACTERS(Routes.CHARACTERS, R.string.shell_tab_characters),
    GROUPS(Routes.GROUPS, R.string.shell_tab_groups),
    ;

    companion object {
        /**
         * 由路由字符串解析主栏目；非主栏目路由（聊天详情 / 设置 / 配对等）返回 null。
         * 路由字符串与 Routes 常量一一对应，不做模式匹配——细节页永不进底栏。
         */
        fun fromRoute(route: String?): MainDestination? =
            entries.firstOrNull { it.route == route }
    }
}

/** 导航形态：手机底栏 / 平板侧边 Rail */
enum class MainNavMode {
    BOTTOM_BAR,
    NAVIGATION_RAIL,
}

/**
 * E-01 / §16.1 纯策略决策（便于 JVM 单测）：
 * - 窗口宽度分界（<600dp 底栏，>=600dp Rail）；
 * - `useMainShell` flag 的回退路径（关闭时回到旧 SESSIONS 顶级路由）。
 */
object MainShellPolicy {

    /** 平板（NavigationRail）最小宽度分界（dp） */
    const val RAIL_MIN_WIDTH_DP = 600

    /** `useMainShell` 默认值（§16.1：开发阶段允许回退，默认启用新 Shell） */
    const val DEFAULT_USE_MAIN_SHELL = true

    /** 依据可用窗口宽度选择导航形态 */
    fun navMode(availableWidthDp: Int): MainNavMode =
        if (availableWidthDp >= RAIL_MIN_WIDTH_DP) {
            MainNavMode.NAVIGATION_RAIL
        } else {
            MainNavMode.BOTTOM_BAR
        }

    /**
     * 启动决策完成后的主区落点：
     * flag 开 -> MAIN_SHELL（Shell 内三栏切换）；
     * flag 关 -> SESSIONS（旧顶级路由，可回退）。
     */
    fun startupTargetRoute(useMainShell: Boolean): String =
        if (useMainShell) Routes.MAIN_SHELL else Routes.SESSIONS

    /** 当前路由是否属于主栏目（用于选中态兜底判断） */
    fun isMainDestination(route: String?): Boolean = MainDestination.fromRoute(route) != null
}

/** 主栏目的选中/未选中图标（底栏与 Rail 共用） */
internal fun MainDestination.icon(selected: Boolean): ImageVector = when (this) {
    MainDestination.SESSIONS -> if (selected) Icons.Filled.Chat else Icons.Outlined.Chat
    MainDestination.CHARACTERS -> if (selected) Icons.Filled.Person else Icons.Outlined.Person
    MainDestination.GROUPS -> if (selected) Icons.Filled.Group else Icons.Outlined.Group
}
