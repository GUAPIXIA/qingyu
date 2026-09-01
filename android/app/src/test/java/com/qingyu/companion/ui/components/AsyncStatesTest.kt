package com.qingyu.companion.ui.components

import com.qingyu.companion.R
import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.network.connection.ConnectionEndpoint
import com.qingyu.companion.network.connection.ConnectionState
import com.qingyu.companion.network.connection.FailureReason
import com.qingyu.companion.network.connection.RepairReason
import com.qingyu.companion.network.connection.TransportSecurity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * E-02 统一异步页面状态纯逻辑单测：
 * - [projectLoadState] 五态投影矩阵（含 Offline 仅限网络类错误的规则）；
 * - [connectionChipUi] ConnectionState → 胶囊文案/色调映射（含重连倒计时）；
 * - [skeletonTick] 骨架屏最短展示 300ms 防抖状态机；
 * - [asyncRowStateLabelRes] 设置行同步状态徽标文案。
 */
class LoadStateProjectionTest {

    private val data = listOf("s1", "s2")
    private val hasContent = { d: List<String> -> d.isNotEmpty() }

    @Test
    fun `加载中无数据投影为Loading`() {
        assertEquals(LoadState.Loading, projectLoadState(loading = true, error = null, data = null, hasContent = hasContent))
        assertEquals(LoadState.Loading, projectLoadState(loading = true, error = null, data = emptyList(), hasContent = hasContent))
    }

    @Test
    fun `有数据且在刷新投影为ContentRefreshing`() {
        val st = projectLoadState(loading = true, error = null, data = data, hasContent = hasContent)
        assertEquals(LoadState.Content(data, refreshing = true), st)
    }

    @Test
    fun `有数据且未加载投影为Content`() {
        val st = projectLoadState(loading = false, error = null, data = data, hasContent = hasContent)
        assertEquals(LoadState.Content(data, refreshing = false), st)
    }

    @Test
    fun `未加载且无数据无错误投影为Empty`() {
        assertEquals(LoadState.Empty, projectLoadState(loading = false, error = null, data = emptyList(), hasContent = hasContent))
    }

    @Test
    fun `离线或超时错误加缓存投影为Offline`() {
        assertEquals(
            LoadState.Offline(data),
            projectLoadState(loading = false, error = CompanionError.Offline(), data = data, hasContent = hasContent),
        )
        assertEquals(
            LoadState.Offline(data),
            projectLoadState(loading = false, error = CompanionError.Timeout(), data = data, hasContent = hasContent),
        )
    }

    @Test
    fun `网络类错误无缓存投影为Error且可重试`() {
        val st = projectLoadState(loading = false, error = CompanionError.Offline(), data = emptyList(), hasContent = hasContent)
        assertTrue(st is LoadState.Error)
        st as LoadState.Error
        assertTrue(st.retryable)
        assertEquals(CompanionError.Offline::class, st.error::class)
    }

    @Test
    fun `服务端错误可重试性按状态码判定`() {
        val retryable = projectLoadState(loading = false, error = CompanionError.ServerRejected(500, "boom"), data = null, hasContent = hasContent)
        assertTrue((retryable as LoadState.Error).retryable)

        val fatal = projectLoadState(loading = false, error = CompanionError.ServerRejected(400, "bad"), data = null, hasContent = hasContent)
        assertFalse((fatal as LoadState.Error).retryable)
    }

    @Test
    fun `非网络类错误即使有缓存也投影为Error`() {
        // Unauthorized 不能伪装成离线：用户需要看到「重新配对」指引而非「显示缓存」
        val st = projectLoadState(loading = false, error = CompanionError.Unauthorized(), data = data, hasContent = hasContent)
        assertTrue(st is LoadState.Error)
        assertFalse((st as LoadState.Error).retryable)
    }

    @Test
    fun `错误优先级高于空内容`() {
        val st = projectLoadState(loading = true, error = CompanionError.ParseError(), data = emptyList(), hasContent = hasContent)
        assertTrue(st is LoadState.Error)
    }

    @Test
    fun `isNetworkKindError仅离线与超时`() {
        assertTrue(isNetworkKindError(CompanionError.Offline()))
        assertTrue(isNetworkKindError(CompanionError.Timeout()))
        assertFalse(isNetworkKindError(CompanionError.Unauthorized()))
        assertFalse(isNetworkKindError(CompanionError.IncompatibleVersion()))
        assertFalse(isNetworkKindError(CompanionError.ParseError()))
        assertFalse(isNetworkKindError(CompanionError.ServerRejected(500, "x")))
        assertFalse(isNetworkKindError(CompanionError.Unknown()))
    }
}

class ConnectionChipUiTest {

    private val endpoint = ConnectionEndpoint("192.168.1.5", 8787, TransportSecurity.TLS_SYSTEM)
    private val now = 1_000_000L

    @Test
    fun `未配对投影为未连接`() {
        val model = connectionChipUi(ConnectionState.Idle, now)
        assertEquals(R.string.connection_chip_idle, model.labelRes)
        assertEquals(ConnectionChipTone.Offline, model.tone)
    }

    @Test
    fun `建链过程态统一为连接中`() {
        val busyStates = listOf<ConnectionState>(
            ConnectionState.Discovering("d1"),
            ConnectionState.Probing("d1", listOf(endpoint)),
            ConnectionState.Authenticating(endpoint),
            ConnectionState.ConnectingRealtime(endpoint),
            ConnectionState.AwaitingApproval("my-pc", expiresAt = now + 60_000),
        )
        busyStates.forEach { state ->
            val model = connectionChipUi(state, now)
            if (state is ConnectionState.AwaitingApproval) {
                assertEquals(R.string.connection_chip_awaiting_approval, model.labelRes)
            } else {
                assertEquals(R.string.connection_chip_connecting, model.labelRes)
            }
            assertEquals(ConnectionChipTone.Busy, model.tone)
        }
    }

    @Test
    fun `已连接与降级`() {
        val connected = connectionChipUi(
            ConnectionState.Connected(deviceId = "d1", endpoint = endpoint, connectedAt = now, rttMs = 42),
            now,
        )
        assertEquals(R.string.connection_chip_connected, connected.labelRes)
        assertEquals(ConnectionChipTone.Connected, connected.tone)

        val degraded = connectionChipUi(
            ConnectionState.Degraded(restAvailable = true, wsAvailable = false, reason = FailureReason.WsClosed),
            now,
        )
        assertEquals(R.string.connection_chip_degraded, degraded.labelRes)
        assertEquals(ConnectionChipTone.Degraded, degraded.tone)
    }

    @Test
    fun `重连中带倒计时且向上取整`() {
        val model = connectionChipUi(
            ConnectionState.Reconnecting(attempt = 2, nextAttemptAt = now + 2_500, reason = FailureReason.Tcp),
            now,
        )
        assertEquals(R.string.connection_chip_reconnecting, model.labelRes)
        assertEquals(listOf<Any>(3), model.labelArgs)
        assertEquals(ConnectionChipTone.Reconnecting, model.tone)
    }

    @Test
    fun `倒计时到期归零不为负`() {
        assertEquals(3, reconnectCountdownSeconds(nextAttemptAt = now + 2_500, nowMs = now))
        assertEquals(2, reconnectCountdownSeconds(nextAttemptAt = now + 2_000, nowMs = now))
        assertEquals(1, reconnectCountdownSeconds(nextAttemptAt = now + 1, nowMs = now))
        assertEquals(0, reconnectCountdownSeconds(nextAttemptAt = now, nowMs = now))
        assertEquals(0, reconnectCountdownSeconds(nextAttemptAt = now - 9_999, nowMs = now))
    }

    @Test
    fun `需修复按原因给出明确文案`() {
        val cases = listOf(
            RepairReason.Unauthorized to R.string.settings_diag_repair_unauthorized,
            RepairReason.FingerprintChanged to R.string.settings_diag_repair_fingerprint,
            RepairReason.ApiIncompatible to R.string.settings_diag_repair_api,
            RepairReason.CertificateChanged to R.string.settings_diag_repair_certificate,
        )
        cases.forEach { (reason, expectedRes) ->
            val model = connectionChipUi(ConnectionState.NeedsRepair(deviceId = "d1", reason = reason), now)
            assertEquals(expectedRes, model.labelRes)
            assertEquals(ConnectionChipTone.Repair, model.tone)
        }
    }
}

class SkeletonDebounceTest {

    @Test
    fun `加载开始进入可见并起表`() {
        val st = skeletonTick(loading = true, previous = SkeletonClock(false, null), nowMs = 1_000)
        assertEquals(SkeletonClock(true, 1_000), st)
    }

    @Test
    fun `加载中保持可见且时间戳不重置`() {
        val st = skeletonTick(loading = true, previous = SkeletonClock(true, 1_000), nowMs = 1_500)
        assertEquals(SkeletonClock(true, 1_000), st)
    }

    @Test
    fun `加载结束但不足最短展示时保持可见`() {
        val st = skeletonTick(loading = false, previous = SkeletonClock(true, 1_000), nowMs = 1_299)
        assertEquals(SkeletonClock(true, 1_000), st)
    }

    @Test
    fun `加载结束满最短展示即隐藏`() {
        // 边界：恰好 300ms 已展示 → 立即隐藏
        val st = skeletonTick(loading = false, previous = SkeletonClock(true, 1_000), nowMs = 1_300)
        assertEquals(SkeletonClock(false, null), st)
    }

    @Test
    fun `未展示过即结束直接隐藏`() {
        val st = skeletonTick(loading = false, previous = SkeletonClock(false, null), nowMs = 5_000)
        assertEquals(SkeletonClock(false, null), st)
    }

    @Test
    fun `最短展示时长可自定义`() {
        val st = skeletonTick(loading = false, previous = SkeletonClock(true, 1_000), nowMs = 1_200, minShowMs = 500)
        assertTrue(st.visible)
        val hidden = skeletonTick(loading = false, previous = SkeletonClock(true, 1_000), nowMs = 1_500, minShowMs = 500)
        assertFalse(hidden.visible)
    }
}

class AsyncRowStateLabelResTest {
    @Test
    fun `设置行同步状态映射徽标文案`() {
        assertNull(asyncRowStateLabelRes(AsyncRowState.Idle))
        assertEquals(R.string.settings_sync_saving, asyncRowStateLabelRes(AsyncRowState.Saving))
        assertEquals(R.string.settings_sync_synced, asyncRowStateLabelRes(AsyncRowState.Synced))
        assertEquals(R.string.settings_sync_failed, asyncRowStateLabelRes(AsyncRowState.Failed))
    }
}
