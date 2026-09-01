package com.qingyu.companion.ui.settings

import com.qingyu.companion.data.settings.FieldSyncState
import com.qingyu.companion.data.settings.SettingsRejectionRegistry
import com.qingyu.companion.data.settings.SettingsSyncStatus
import com.qingyu.companion.data.settings.fieldSyncStateFor
import com.qingyu.companion.model.RejectedFieldDto
import com.qingyu.companion.network.connection.ConnectionDiagnostics
import com.qingyu.companion.network.connection.DiagnosticsFailure
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 设置页纯投影单测（阶段 B-07 诊断卡片 + 阶段 C rejectedFields 行级反馈）：
 * - 重试倒计时秒数（向上取整、过期归零）；
 * - 失败原因键映射；
 * - 「复制诊断信息」脱敏文本（无 token/无明文 host）；
 * - rejectedFields 行级投影：PC 拒绝优先于仓库状态机；
 * - SettingsRejectionRegistry：记录/自愈（applied 清账）/按设备隔离/清理。
 */
class SettingsDiagnosticsProjectionTest {

    // ---------- 重试倒计时 ----------

    @Test
    fun `倒计时向上取整`() {
        assertEquals(3, retryCountdownSeconds(nowMs = 1_000L, nextAttemptAt = 3_500L))
        assertEquals(2, retryCountdownSeconds(nowMs = 1_000L, nextAttemptAt = 3_000L))
        assertEquals(1, retryCountdownSeconds(nowMs = 1_000L, nextAttemptAt = 1_001L))
    }

    @Test
    fun `倒计时已到期归零不为负`() {
        assertEquals(0, retryCountdownSeconds(nowMs = 5_000L, nextAttemptAt = 4_999L))
        assertEquals(0, retryCountdownSeconds(nowMs = 5_000L, nextAttemptAt = 5_000L))
    }

    // ---------- 失败原因键映射 ----------

    @Test
    fun `失败原因映射到稳定键`() {
        assertEquals("no_network", failureReasonKey("NoNetwork"))
        assertEquals("dns", failureReasonKey("Dns"))
        assertEquals("tcp", failureReasonKey("Tcp"))
        assertEquals("tls", failureReasonKey("Tls"))
        assertEquals("timeout", failureReasonKey("Timeout"))
        assertEquals("server_stopped", failureReasonKey("ServerStopped"))
        assertEquals("ws_closed", failureReasonKey("WsClosed"))
        assertEquals("repair", failureReasonKey("repair"))
        assertEquals("unknown", failureReasonKey("SomethingElse"))
        assertEquals("unknown", failureReasonKey(null))
    }

    // ---------- 复制诊断信息文本 ----------

    private fun diagnostics(
        stateLabel: String = "connected(rtt=45ms)",
        lastFailure: DiagnosticsFailure? = null,
    ) = ConnectionDiagnostics(
        stateLabel = stateLabel,
        endpointType = "TLS_SYSTEM",
        securityMode = "https",
        serverId = "srv-123",
        apiVersion = 1,
        pairingProtocolVersion = 2,
        lastRttMs = 45L,
        lastConnectedAt = 1_760_000_000_000L,
        lastFailure = lastFailure,
        recentAttempts = 3,
        recentResults = listOf("connected", "failed", "connected"),
    )

    @Test
    fun `诊断文本包含关键键值`() {
        val text = formatConnectionDiagnosticsText(
            diagnostics(lastFailure = DiagnosticsFailure(1L, "TLS_SYSTEM", "Timeout")),
            nowMs = 61_000L,
        )
        assertTrue(text.contains("state: connected(rtt=45ms)"))
        assertTrue(text.contains("endpointType: TLS_SYSTEM"))
        assertTrue(text.contains("securityMode: https"))
        assertTrue(text.contains("lastRttMs: 45"))
        assertTrue(text.contains("lastFailure: Timeout"))
        assertTrue(text.contains("recentAttempts: 3"))
        assertTrue(text.contains("recentResults: connected,failed,connected"))
    }

    @Test
    fun `诊断文本无失败时显示 none 且不泄漏敏感信息`() {
        val text = formatConnectionDiagnosticsText(diagnostics(), nowMs = 0L)
        assertTrue(text.contains("lastFailure: none"))
        assertFalse(text.contains("token", ignoreCase = true))
        assertFalse(text.contains("Bearer", ignoreCase = true))
        assertFalse(text.contains("pairingCode", ignoreCase = true))
        assertFalse(text.contains("192.168."))
    }

    // ---------- rejectedFields 行级投影 ----------

    @Test
    fun `PC 拒绝优先于仓库 Synced 状态`() {
        val rejections = mapOf("activeModel" to "not in whitelist")
        val synced = SettingsSyncStatus.Synced("r1", at = 1L, fields = setOf("activeModel", "streamOutput"))
        // 仓库认为 Synced，但 PC 拒绝了 activeModel → 行级显示 Failed
        assertEquals(FieldSyncState.Failed, fieldSyncStateWithRejections(synced, "activeModel", rejections))
        // 未被拒绝的字段仍走常规状态机
        assertEquals(FieldSyncState.Synced, fieldSyncStateWithRejections(synced, "streamOutput", rejections))
        assertEquals("not in whitelist", rejectionReasonFor(rejections, "activeModel"))
        assertNull(rejectionReasonFor(rejections, "streamOutput"))
    }

    @Test
    fun `无拒绝时行级状态与仓库状态机一致`() {
        val saving = SettingsSyncStatus.Saving(setOf("lorebookRatio"))
        assertEquals(
            fieldSyncStateFor(saving, "lorebookRatio"),
            fieldSyncStateWithRejections(saving, "lorebookRatio", emptyMap()),
        )
        val failed = SettingsSyncStatus.Failed(
            com.qingyu.companion.data.settings.SettingsChange(mapOf("lorebookRatio" to 0.5)),
            com.qingyu.companion.data.CompanionError.Offline(),
        )
        assertEquals(
            fieldSyncStateFor(failed, "lorebookRatio"),
            fieldSyncStateWithRejections(failed, "lorebookRatio", emptyMap()),
        )
        assertEquals(FieldSyncState.Idle, fieldSyncStateWithRejections(SettingsSyncStatus.Idle, "activeModel", emptyMap()))
    }

    // ---------- SettingsRejectionRegistry ----------

    @Test
    fun `registry 记录拒绝字段并可按设备读取`() {
        val registry = SettingsRejectionRegistry()
        registry.onPatchResponse(
            sourceDeviceId = "dev-1",
            applied = emptyList(),
            rejected = listOf(RejectedFieldDto("activeModel", "invalid value")),
        )
        assertEquals(mapOf("activeModel" to "invalid value"), registry.reasonsFor("dev-1"))
        assertTrue(registry.reasonsFor("dev-2").isEmpty())
        assertTrue(registry.reasonsFor(null).isEmpty())
    }

    @Test
    fun `registry 重新保存被应用后撤销拒绝态`() {
        val registry = SettingsRejectionRegistry()
        registry.onPatchResponse("dev-1", emptyList(), listOf(RejectedFieldDto("streamOutput", "range")))
        assertEquals(mapOf("streamOutput" to "range"), registry.reasonsFor("dev-1"))
        // 重新保存成功：appliedFields 带回该字段 → 拒绝态清除
        registry.onPatchResponse("dev-1", applied = listOf("streamOutput"), rejected = emptyList())
        assertTrue(registry.reasonsFor("dev-1").isEmpty())
    }

    @Test
    fun `registry 按设备隔离互不串台`() {
        val registry = SettingsRejectionRegistry()
        registry.onPatchResponse("dev-1", emptyList(), listOf(RejectedFieldDto("activeModel", "a")))
        registry.onPatchResponse("dev-2", emptyList(), listOf(RejectedFieldDto("streamOutput", "b")))
        assertEquals(mapOf("activeModel" to "a"), registry.reasonsFor("dev-1"))
        assertEquals(mapOf("streamOutput" to "b"), registry.reasonsFor("dev-2"))
        registry.clearDevice("dev-1")
        assertTrue(registry.reasonsFor("dev-1").isEmpty())
        assertEquals(mapOf("streamOutput" to "b"), registry.reasonsFor("dev-2"))
    }

    @Test
    fun `registry clearAll 清空且无 deviceId 的响应被忽略`() {
        val registry = SettingsRejectionRegistry()
        registry.onPatchResponse(null, emptyList(), listOf(RejectedFieldDto("activeModel", "x")))
        assertTrue(registry.reasonsFor("").isEmpty())
        registry.onPatchResponse("dev-1", emptyList(), listOf(RejectedFieldDto("activeModel", "x")))
        registry.clearAll()
        assertTrue(registry.reasonsFor("dev-1").isEmpty())
    }
}
