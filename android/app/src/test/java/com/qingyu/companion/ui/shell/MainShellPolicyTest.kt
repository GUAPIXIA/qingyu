package com.qingyu.companion.ui.shell

import com.qingyu.companion.ui.navigation.Routes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * E-01 / §16.1 MainShell 纯策略单测：
 * 导航形态分界、flag 回退落点、路由→主栏目解析。
 */
class MainShellPolicyTest {

    // ---- navMode：600dp 分界 ----

    @Test
    fun `narrow width uses bottom bar`() {
        assertEquals(MainNavMode.BOTTOM_BAR, MainShellPolicy.navMode(0))
        assertEquals(MainNavMode.BOTTOM_BAR, MainShellPolicy.navMode(359))
        assertEquals(MainNavMode.BOTTOM_BAR, MainShellPolicy.navMode(599))
    }

    @Test
    fun `wide width uses navigation rail`() {
        assertEquals(MainNavMode.NAVIGATION_RAIL, MainShellPolicy.navMode(600))
        assertEquals(MainNavMode.NAVIGATION_RAIL, MainShellPolicy.navMode(834))
        assertEquals(MainNavMode.NAVIGATION_RAIL, MainShellPolicy.navMode(Int.MAX_VALUE))
    }

    // ---- startupTargetRoute：flag 回退路径（§16.1） ----

    @Test
    fun `flag on targets main shell`() {
        assertEquals(Routes.MAIN_SHELL, MainShellPolicy.startupTargetRoute(true))
    }

    @Test
    fun `flag off falls back to legacy sessions route`() {
        assertEquals(Routes.SESSIONS, MainShellPolicy.startupTargetRoute(false))
    }

    // ---- fromRoute / isMainDestination ----

    @Test
    fun `main routes resolve to their destination`() {
        assertEquals(MainDestination.SESSIONS, MainDestination.fromRoute(Routes.SESSIONS))
        assertEquals(MainDestination.CHARACTERS, MainDestination.fromRoute(Routes.CHARACTERS))
        assertEquals(MainDestination.GROUPS, MainDestination.fromRoute(Routes.GROUPS))
    }

    @Test
    fun `detail and fullscreen routes are not main destinations`() {
        assertNull(MainDestination.fromRoute(null))
        assertNull(MainDestination.fromRoute(Routes.MAIN_SHELL))
        assertNull(MainDestination.fromRoute(Routes.PAIRING))
        assertNull(MainDestination.fromRoute(Routes.STARTUP))
        assertNull(MainDestination.fromRoute("chat_detail/abc"))
        assertFalse(MainShellPolicy.isMainDestination(Routes.SETTINGS))
        assertTrue(MainShellPolicy.isMainDestination(Routes.GROUPS))
    }

    @Test
    fun `all destinations carry distinct routes`() {
        val routes = MainDestination.entries.map { it.route }
        assertEquals(routes.size, routes.toSet().size)
    }
}
