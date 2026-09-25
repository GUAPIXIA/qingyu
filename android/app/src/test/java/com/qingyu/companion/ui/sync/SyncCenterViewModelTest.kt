package com.qingyu.companion.ui.sync

import com.qingyu.companion.local.testing.FakeLocalStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * S7-07 同步中心：本地 backlog 刷新、手动进度/取消、禁止静默自动同步语义。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SyncCenterViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun vm(): SyncCenterViewModel =
        SyncCenterViewModel(store = FakeLocalStore("sync-center"), backlogCounter = { 3 })

    @Test
    fun refreshBacklogReadsLocalOnly() = runTest {
        val vm = vm()
        vm.refreshBacklog()
        advanceUntilIdle()
        assertEquals(3, vm.state.value.localBacklog)
        assertFalse("未点击同步不得进入 running", vm.state.value.running)
    }

    @Test
    fun progressAndCancelDoNotLeaveRunning() {
        val vm = vm()
        vm.onProgress("push", sent = 2, received = 0)
        assertTrue(vm.state.value.running)
        assertEquals(2, vm.state.value.sent)
        vm.cancelSync()
        assertFalse(vm.state.value.running)
        assertEquals("cancelled", vm.state.value.lastSyncResult)
    }

    @Test
    fun successClearsBacklogAndFailureKeepsIt() {
        val vm = vm()
        vm.onProgress("commit", 1, 1)
        vm.onSyncSuccess(uploaded = 5, downloaded = 2)
        assertEquals(0, vm.state.value.localBacklog)
        assertEquals("ok", vm.state.value.lastSyncResult)
        assertNull(vm.state.value.error)

        vm.onSyncFailed("network", retryable = true)
        assertEquals("retryable", vm.state.value.lastSyncResult)
        assertEquals("network", vm.state.value.error)
    }

    @Test
    fun remindToggleIsLocalOnly() {
        val vm = vm()
        vm.setRemindUnsynced(true)
        assertTrue(vm.state.value.remindUnsynced)
        assertFalse(vm.state.value.running)
    }

    @Test
    fun startSyncWithoutCoordinatorDoesNothing() {
        val vm = SyncCenterViewModel(store = FakeLocalStore("sync-center"), backlogCounter = { 0 })
        vm.startSync()
        assertFalse(vm.state.value.running)
    }

    @Test
    fun startSyncCallsCoordinatorOnlyWhenAuthorized() = runTest {
        var runs = 0
        val coordinator = com.qingyu.companion.network.sync.DefaultSyncCoordinator(
            lanAuthorized = { true },
            serverConfigured = { false },
            lanRunner = { onProgress ->
                runs++
                onProgress("push", 3, 1)
                com.qingyu.companion.network.sync.SyncRunResult(ok = true, uploaded = 3, downloaded = 1)
            },
            serverRunner = { com.qingyu.companion.network.sync.SyncRunResult(ok = false) },
        )
        val vm = SyncCenterViewModel(
            store = FakeLocalStore("sync-center"),
            backlogCounter = { 2 },
            coordinator = coordinator,
        )
        vm.startSync(com.qingyu.companion.network.sync.SyncCoordinator.Target.LAN)
        advanceUntilIdle()
        assertEquals(1, runs)
        assertEquals("ok", vm.state.value.lastSyncResult)
        assertEquals(0, vm.state.value.localBacklog)
    }
}
