package com.qingyu.companion.ui.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.ui.notification.NotificationDeepLink
import com.qingyu.companion.ui.announcements.AnnouncementsScreen
import com.qingyu.companion.ui.characters.CharactersScreen
import com.qingyu.companion.ui.chat.ChatScreen
import com.qingyu.companion.ui.groups.GroupChatScreen
import com.qingyu.companion.ui.groups.GroupsScreen
import com.qingyu.companion.ui.pairing.PairingScreen
import com.qingyu.companion.ui.sessions.CharacterSessionsScreen
import com.qingyu.companion.ui.sessions.SessionsScreen
import com.qingyu.companion.ui.settings.SettingsScreen
import com.qingyu.companion.ui.shell.MainShell
import com.qingyu.companion.ui.shell.MainShellPolicy
import com.qingyu.companion.ui.startup.StartupConnectionPickerScreen
import com.qingyu.companion.ui.startup.StartupScreen
import com.qingyu.companion.ui.usage.UsageScreen

/**
 * 导航宿主（A-03 / E-01）。
 * 起始页为启动决策页：只读本地快照分发——
 * NeedsPairing -> PAIRING；Ready -> 主区（pop STARTUP）；
 * ReadyWithoutActive / active token 需修复 -> CONNECTION_PICKER。
 * 决策不等待任何网络请求，有效连接冷启动不闪现配对页。
 *
 * 通知 deep link（A-03 边界收尾）：MainActivity 把通知 extras 解析为 NotificationTarget 写入
 * [NotificationDeepLink]；本宿主在启动决策完成后（或运行中）经 `notificationRouteFor` 消费一次即清空——
 * READY+会话通知直达会话，ReadyWithoutActive/NeedsPairing 时忽略会话目标（不擅自猜 PC），
 * 配对通知始终去 PAIRING。
 *
 * 主区落点由 §16.1 `useMainShell` 决定（MainShellPolicy.startupTargetRoute）：
 * - 开（默认）：MAIN_SHELL，内嵌 NavHost 承载 SESSIONS/CHARACTERS/GROUPS 三栏切换；
 * - 关：SESSIONS（旧顶级导航，可回退）。
 * PAIRING / STARTUP / CONNECTION_PICKER / SETTINGS / 聊天详情等非主栏页始终为全屏路由，不进 Shell。
 */
@Composable
fun CompanionNavHost(
    navController: NavHostController = rememberNavController(),
) {
    // §16.1 本地开关：仅在启动分发时读取（切换后下次冷启动生效）
    val container = LocalAppContainer.current
    val useMainShell by container.uiPrefsStore.useMainShell
        .collectAsStateWithLifecycle(initialValue = MainShellPolicy.DEFAULT_USE_MAIN_SHELL)
    val mainEntryRoute = MainShellPolicy.startupTargetRoute(useMainShell)

    // A-03 通知 deep link：MainActivity 经 NotificationDeepLink 写入目标；
    // 只在启动决策完成（非 PENDING）后消费，消费一次即清空，冷启动/运行中两条路径共用。
    // 决策结果用 rememberSaveable：Activity 重建（旋转等）后 STARTUP 已不在返回栈，
    // 决策值必须存活，否则运行中点通知将永远不消费。
    val pendingNotificationTarget by NotificationDeepLink.target.collectAsStateWithLifecycle()
    var startupDecision by rememberSaveable { mutableStateOf(StartupDecision.PENDING) }

    LaunchedEffect(pendingNotificationTarget, startupDecision) {
        val route = notificationRouteFor(pendingNotificationTarget, startupDecision)
            ?: return@LaunchedEffect
        NotificationDeepLink.clear()
        when (route) {
            is NotificationRoute.Chat ->
                navController.navigate(Routes.chat(route.sessionId, "")) { launchSingleTop = true }
            NotificationRoute.ConnectionPicker ->
                navController.navigate(Routes.CONNECTION_PICKER) { launchSingleTop = true }
            NotificationRoute.Pairing ->
                navController.navigate(Routes.PAIRING) { launchSingleTop = true }
        }
    }

    NavHost(navController = navController, startDestination = Routes.STARTUP) {
        composable(Routes.STARTUP) {
            StartupScreen(
                onNeedsPairing = {
                    startupDecision = StartupDecision.NEEDS_PAIRING
                    navController.navigate(Routes.PAIRING) {
                        popUpTo(Routes.STARTUP) { inclusive = true }
                        launchSingleTop = true
                    }
                },
                onReady = { needsRepair ->
                    // needsRepair：active token 解密失败，以 CONNECTION_PICKER 作为"需要修复连接"入口（A-03 简化）
                    startupDecision = StartupDecision.READY
                    val target = if (needsRepair) Routes.CONNECTION_PICKER else mainEntryRoute
                    navController.navigate(target) {
                        popUpTo(Routes.STARTUP) { inclusive = true }
                        launchSingleTop = true
                    }
                },
                onReadyWithoutActive = {
                    startupDecision = StartupDecision.READY_WITHOUT_ACTIVE
                    navController.navigate(Routes.CONNECTION_PICKER) {
                        popUpTo(Routes.STARTUP) { inclusive = true }
                        launchSingleTop = true
                    }
                },
            )
        }
        composable(Routes.CONNECTION_PICKER) {
            StartupConnectionPickerScreen(
                onOpenPairing = {
                    navController.navigate(Routes.PAIRING) {
                        popUpTo(Routes.CONNECTION_PICKER) { inclusive = true }
                    }
                },
                onPicked = {
                    navController.navigate(mainEntryRoute) {
                        popUpTo(Routes.CONNECTION_PICKER) { inclusive = true }
                        launchSingleTop = true
                    }
                },
            )
        }
        composable(Routes.PAIRING) {
            PairingScreen(
                onPaired = {
                    navController.navigate(mainEntryRoute) {
                        popUpTo(Routes.PAIRING) { inclusive = true }
                    }
                },
            )
        }
        composable(Routes.MAIN_SHELL) {
            MainShell(
                onOpenSettings = { navController.navigate(Routes.SETTINGS) },
                onOpenPairing = { navController.navigate(Routes.PAIRING) },
                onOpenChat = { sessionId, characterId ->
                    navController.navigate(Routes.chat(sessionId, characterId))
                },
                onOpenCharacterSessions = { characterId, characterName ->
                    navController.navigate(Routes.characterSessions(characterId, characterName))
                },
                onOpenGroupChat = { groupId, groupName, sessionId ->
                    navController.navigate(Routes.groupChat(groupId, groupName, sessionId))
                },
            )
        }
        // ---- flag 回退路径（§16.1）：useMainShell=false 时 SESSIONS/CHARACTERS/GROUPS 为旧顶级路由 ----
        composable(Routes.SESSIONS) {
            SessionsScreen(
                onOpenChat = { sessionId, characterId ->
                    navController.navigate(Routes.chat(sessionId, characterId))
                },
                onOpenCharacters = { navController.navigate(Routes.CHARACTERS) },
                onOpenPairing = { navController.navigate(Routes.PAIRING) },
                onOpenSettings = { navController.navigate(Routes.SETTINGS) },
                onOpenGroups = { navController.navigate(Routes.GROUPS) },
            )
        }
        composable(
            route = Routes.CHAT,
            arguments = listOf(
                navArgument("sessionId") { type = NavType.StringType },
                navArgument("characterId") {
                    type = NavType.StringType
                    defaultValue = ""
                },
            ),
        ) { backStackEntry ->
            ChatScreen(
                sessionId = backStackEntry.arguments?.getString("sessionId").orEmpty(),
                characterId = backStackEntry.arguments?.getString("characterId"),
                onBack = { navController.popBackStack() },
                onOpenBranch = { sessionId, characterId ->
                    navController.navigate(Routes.chat(sessionId, characterId))
                },
            )
        }
        composable(Routes.CHARACTERS) {
            CharactersScreen(
                onBack = { navController.popBackStack() },
                onOpenCharacterSessions = { characterId, characterName ->
                    navController.navigate(Routes.characterSessions(characterId, characterName))
                },
                onOpenChat = { sessionId, characterId ->
                    navController.navigate(Routes.chat(sessionId, characterId))
                },
            )
        }
        composable(
            route = Routes.CHARACTER_SESSIONS,
            arguments = listOf(
                navArgument("characterId") { type = NavType.StringType },
                navArgument("characterName") { type = NavType.StringType; defaultValue = "角色" },
            ),
        ) { backStackEntry ->
            CharacterSessionsScreen(
                characterId = backStackEntry.arguments?.getString("characterId").orEmpty(),
                characterName = backStackEntry.arguments?.getString("characterName").orEmpty(),
                onOpenChat = { sessionId, sessionCharacterId ->
                    navController.navigate(Routes.chat(sessionId, sessionCharacterId))
                },
                onBack = { navController.popBackStack() },
            )
        }
        composable(Routes.SETTINGS) {
            SettingsScreen(
                onBack = { navController.popBackStack() },
                onOpenPairing = { navController.navigate(Routes.PAIRING) },
                onOpenUsage = { navController.navigate(Routes.USAGE) },
                onOpenAnnouncements = { navController.navigate(Routes.ANNOUNCEMENTS) },
            )
        }
        composable(Routes.USAGE) {
            UsageScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.ANNOUNCEMENTS) {
            AnnouncementsScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.GROUPS) {
            GroupsScreen(
                onOpenGroupChat = { groupId, groupName, sessionId ->
                    navController.navigate(Routes.groupChat(groupId, groupName, sessionId))
                },
                onBack = { navController.popBackStack() },
            )
        }
        composable(
            route = Routes.GROUP_CHAT,
            arguments = listOf(
                navArgument("groupId") { type = NavType.StringType },
                navArgument("sessionId") { type = NavType.StringType },
                navArgument("groupName") { type = NavType.StringType; defaultValue = "群聊" },
            ),
        ) { backStackEntry ->
            GroupChatScreen(
                groupId = backStackEntry.arguments?.getString("groupId").orEmpty(),
                groupName = backStackEntry.arguments?.getString("groupName").orEmpty(),
                sessionId = backStackEntry.arguments?.getString("sessionId").orEmpty(),
                onBack = { navController.popBackStack() },
            )
        }
    }
}
