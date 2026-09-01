package com.qingyu.companion.ui.shell

import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.qingyu.companion.ui.characters.CharactersScreen
import com.qingyu.companion.ui.groups.GroupsScreen
import com.qingyu.companion.ui.navigation.Routes
import com.qingyu.companion.ui.sessions.SessionsScreen

/**
 * E-01 MainShell：主区容器。
 *
 * - 手机（<600dp）：底部三主栏（会话 / 角色 / 群聊）；设置入口保留页内右上角，不进底栏。
 * - 平板（>=600dp）：左侧 NavigationRail，内容区占满剩余宽度（Shell 层列表 + 内容双栏骨架）。
 * - 不在 Shell 内重建页面 ViewModel：使用嵌套 NavHost，切栏时经
 *   `saveState / restoreState` 保存并恢复每个栏目的 back stack（VM 随 NavBackStackEntry 保留）。
 * - 聊天详情 / 角色历史 / 群聊消息 / 设置等仍为全屏路由，由外层 NavHost 承载，
 *   Shell 只通过回调把跳转交给外层控制器。
 */
@Composable
fun MainShell(
    onOpenSettings: () -> Unit,
    onOpenPairing: () -> Unit,
    onOpenChat: (sessionId: String, characterId: String) -> Unit,
    onOpenCharacterSessions: (characterId: String, characterName: String) -> Unit,
    onOpenGroupChat: (groupId: String, groupName: String, sessionId: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val innerController = rememberNavController()
    val backStackEntry by innerController.currentBackStackEntryAsState()
    // 非主栏目路由不会出现在内层图，兜底到会话栏
    val selected = MainDestination.fromRoute(backStackEntry?.destination?.route)
        ?: MainDestination.SESSIONS

    BoxWithConstraints(modifier.fillMaxSize()) {
        when (MainShellPolicy.navMode(maxWidth.value.toInt())) {
            MainNavMode.NAVIGATION_RAIL -> {
                Row(Modifier.fillMaxSize()) {
                    MainNavigationRail(
                        selected = selected,
                        onSelect = { innerController.selectTab(it) },
                    )
                    MainShellNavHost(
                        innerController = innerController,
                        onOpenSettings = onOpenSettings,
                        onOpenPairing = onOpenPairing,
                        onOpenChat = onOpenChat,
                        onOpenCharacterSessions = onOpenCharacterSessions,
                        onOpenGroupChat = onOpenGroupChat,
                        modifier = Modifier.weight(1f).fillMaxSize(),
                    )
                }
            }

            MainNavMode.BOTTOM_BAR -> {
                Scaffold(
                    modifier = Modifier.fillMaxSize(),
                    containerColor = Color.Transparent,
                    contentWindowInsets = WindowInsets(0, 0, 0, 0),
                    bottomBar = {
                        MainBottomBar(
                            selected = selected,
                            onSelect = { innerController.selectTab(it) },
                        )
                    },
                ) { padding ->
                    MainShellNavHost(
                        innerController = innerController,
                        onOpenSettings = onOpenSettings,
                        onOpenPairing = onOpenPairing,
                        onOpenChat = onOpenChat,
                        onOpenCharacterSessions = onOpenCharacterSessions,
                        onOpenGroupChat = onOpenGroupChat,
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(padding),
                    )
                }
            }
        }
    }
}

/**
 * 内层 NavHost：仅承载三个一级栏目。
 * 各页跳转详情（聊天 / 角色历史 / 群聊消息）与设置、配对均交给外层全屏路由。
 */
@Composable
private fun MainShellNavHost(
    innerController: NavHostController,
    onOpenSettings: () -> Unit,
    onOpenPairing: () -> Unit,
    onOpenChat: (sessionId: String, characterId: String) -> Unit,
    onOpenCharacterSessions: (characterId: String, characterName: String) -> Unit,
    onOpenGroupChat: (groupId: String, groupName: String, sessionId: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    NavHost(
        navController = innerController,
        startDestination = MainDestination.SESSIONS.route,
        modifier = modifier,
    ) {
        composable(Routes.SESSIONS) {
            SessionsScreen(
                onOpenChat = onOpenChat,
                onOpenCharacters = { innerController.selectTab(MainDestination.CHARACTERS) },
                onOpenPairing = onOpenPairing,
                onOpenSettings = onOpenSettings,
                onOpenGroups = { innerController.selectTab(MainDestination.GROUPS) },
                showSectionShortcuts = false,
            )
        }
        composable(Routes.CHARACTERS) {
            CharactersScreen(
                onBack = { popOrHome(innerController) },
                onOpenCharacterSessions = onOpenCharacterSessions,
                onOpenChat = onOpenChat,
            )
        }
        composable(Routes.GROUPS) {
            GroupsScreen(
                onOpenGroupChat = onOpenGroupChat,
                onBack = { popOrHome(innerController) },
            )
        }
    }
}

/**
 * 一级栏目切换：保存当前栏 back stack（含 VM 与保存态），恢复目标栏状态；
 * 单例启动避免同一栏重复入栈。
 */
internal fun NavHostController.selectTab(destination: MainDestination) {
    navigate(destination.route) {
        popUpTo(graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}

/** 栏目内返回：无可弹栈时回到起始栏（如直接以「角色」栏进入） */
private fun popOrHome(controller: NavHostController) {
    if (!controller.popBackStack()) {
        controller.selectTab(MainDestination.SESSIONS)
    }
}
