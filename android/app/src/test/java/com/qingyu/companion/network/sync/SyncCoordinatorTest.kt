package com.qingyu.companion.network.sync

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S7-07：SyncCoordinator——目标门禁、取消、未配置不建会话。
 */
class SyncCoordinatorTest {

    @Test
    fun unavailableTargetFailsFastWithoutRunner() = runBlocking {
        var lanCalls = 0
        val c = DefaultSyncCoordinator(
            lanAuthorized = { false },
            serverConfigured = { false },
            lanRunner = { lanCalls++; SyncRunResult(ok = true) },
            serverRunner = { SyncRunResult(ok = true) },
        )
        assertTrue(c.availableTargets().isEmpty())
        val r = c.run(SyncCoordinator.Target.LAN)
        assertFalse(r.ok)
        assertEquals(0, lanCalls)
    }

    @Test
    fun lanRunDelegatesAndReportsProgress() = runBlocking {
        val phases = mutableListOf<String>()
        val c = DefaultSyncCoordinator(
            lanAuthorized = { true },
            serverConfigured = { false },
            lanRunner = { onProgress ->
                onProgress("session", 0, 0)
                onProgress("push", 2, 0)
                SyncRunResult(ok = true, uploaded = 2, downloaded = 1)
            },
            serverRunner = { SyncRunResult(ok = false, error = "no") },
        )
        val r = c.run(SyncCoordinator.Target.LAN) { p, _, _ -> phases.add(p) }
        assertTrue(r.ok)
        assertEquals(2, r.uploaded)
        assertEquals(listOf("session", "push"), phases)
    }

    @Test
    fun cancelStopsBeforeNextProgress() = runBlocking {
        lateinit var coord: DefaultSyncCoordinator
        coord = DefaultSyncCoordinator(
            lanAuthorized = { true },
            serverConfigured = { false },
            lanRunner = { onProgress ->
                onProgress("push", 1, 0)
                coord.cancel()
                onProgress("pull", 1, 1)
                SyncRunResult(ok = true)
            },
            serverRunner = { SyncRunResult(ok = false) },
        )
        val r = coord.run(SyncCoordinator.Target.LAN)
        assertFalse(r.ok)
        assertEquals("cancelled", r.error)
    }
}
