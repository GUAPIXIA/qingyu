package com.qingyu.companion.ui.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.qingyu.companion.ui.announcements.AnnouncementsScreen
import com.qingyu.companion.ui.characters.CharactersScreen
import com.qingyu.companion.ui.chat.ChatScreen
import com.qingyu.companion.ui.groups.GroupChatScreen
import com.qingyu.companion.ui.groups.GroupsScreen
import com.qingyu.companion.ui.pairing.PairingScreen
import com.qingyu.companion.ui.sessions.CharacterSessionsScreen
import com.qingyu.companion.ui.sessions.SessionsScreen
import com.qingyu.companion.ui.settings.SettingsScreen
import com.qingyu.companion.ui.usage.UsageScreen

/**
 * 导航宿主。
 * 起始页为配对页：已配对时展示设备列表并可一键进入会话，未配对时进入添加流程。
 */
@Composable
fun CompanionNavHost(
    navController: NavHostController = rememberNavController(),
) {
    NavHost(navController = navController, startDestination = Routes.PAIRING) {
        composable(Routes.PAIRING) {
            PairingScreen(
                onPaired = {
                    navController.navigate(Routes.SESSIONS) {
                        popUpTo(Routes.PAIRING) { inclusive = true }
                    }
                },
            )
        }
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
