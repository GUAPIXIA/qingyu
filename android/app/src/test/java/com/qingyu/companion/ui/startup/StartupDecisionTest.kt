package com.qingyu.companion.ui.startup

import com.qingyu.companion.data.StartupSnapshot
import com.qingyu.companion.model.ServerConnection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A-03 启动决策纯函数单测：只验证本地快照 → 四态映射，不涉及任何 IO。
 * 覆盖：空 store、有连接无 active、active 命中、active 丢失（无记录/指向已删除设备）、
 * token 解密失败（needsRepair / ReadyWithoutActive 分支）、列表为空但 active 有记录。
 */
class StartupDecisionTest {

    private fun conn(
        deviceId: String,
        name: String = "PC-$deviceId",
        token: String = "jwt-$deviceId",
    ) = ServerConnection(
        name = name,
        host = "192.168.1.10",
        port = 8321,
        token = token,
        deviceId = deviceId,
        fingerprint = "fp-$deviceId",
    )

    @Test
    fun `空 store → NeedsPairing`() {
        val state = decideStartupState(StartupSnapshot())
        assertEquals(StartupState.NeedsPairing, state)
    }

    @Test
    fun `有连接无 active → ReadyWithoutActive`() {
        val conns = listOf(conn("d1"), conn("d2"))
        val state = decideStartupState(StartupSnapshot(connections = conns))
        assertEquals(StartupState.ReadyWithoutActive(conns), state)
    }

    @Test
    fun `active 命中 → Ready`() {
        val conns = listOf(conn("d1"), conn("d2"))
        val state = decideStartupState(
            StartupSnapshot(connections = conns, activeConnection = conns[1]),
        )
        assertEquals(StartupState.Ready("d2", needsRepair = false), state)
    }

    @Test
    fun `active id 指向已删除设备 → ReadyWithoutActive，不自动选`() {
        val conns = listOf(conn("d1"), conn("d2"))
        // getActive() 对已删除设备返回 null（DataStoreConnectionStore 语义）
        val state = decideStartupState(
            StartupSnapshot(connections = conns, activeConnection = null),
        )
        assertEquals(StartupState.ReadyWithoutActive(conns), state)
        // 防御性：即便快照带回悬空 active 对象，交叉比对不命中仍走选择页
        val dangling = decideStartupState(
            StartupSnapshot(connections = conns, activeConnection = conn("deleted")),
        )
        assertEquals(StartupState.ReadyWithoutActive(conns), dangling)
    }

    @Test
    fun `active token 解密失败 → Ready 且 needsRepair，不删数据`() {
        val broken = conn("d1", token = "ENC:d1")
        val state = decideStartupState(
            StartupSnapshot(
                connections = listOf(broken),
                activeConnection = broken,
                corruptedDeviceIds = setOf("d1"),
            ),
        )
        assertTrue(state is StartupState.Ready)
        assertTrue((state as StartupState.Ready).needsRepair)
        assertEquals("d1", state.activeDeviceId)
    }

    @Test
    fun `非 active 连接解密失败不影响 Ready 判定`() {
        val ok = conn("d2")
        val broken = conn("d1", token = "ENC:d1")
        val state = decideStartupState(
            StartupSnapshot(
                connections = listOf(broken, ok),
                activeConnection = ok,
                corruptedDeviceIds = setOf("d1"),
            ),
        )
        assertEquals(StartupState.Ready("d2", needsRepair = false), state)
    }

    @Test
    fun `损坏连接无 active → ReadyWithoutActive 且保留损坏项`() {
        val broken = conn("d1", token = "ENC:d1")
        val state = decideStartupState(
            StartupSnapshot(
                connections = listOf(broken),
                activeConnection = null,
                corruptedDeviceIds = setOf("d1"),
            ),
        )
        assertTrue(state is StartupState.ReadyWithoutActive)
        // 数据保留：损坏连接仍在候选列表，由用户决定修复或移除
        assertEquals(listOf(broken), (state as StartupState.ReadyWithoutActive).connections)
    }

    @Test
    fun `列表为空但 active 有记录 → NeedsPairing`() {
        val state = decideStartupState(
            StartupSnapshot(connections = emptyList(), activeConnection = conn("d1")),
        )
        assertEquals(StartupState.NeedsPairing, state)
    }

    @Test
    fun `active 明文命中不算需修复`() {
        val ok = conn("d1", token = "plain-jwt")
        val state = decideStartupState(
            StartupSnapshot(connections = listOf(ok), activeConnection = ok),
        )
        assertFalse((state as StartupState.Ready).needsRepair)
    }
}
