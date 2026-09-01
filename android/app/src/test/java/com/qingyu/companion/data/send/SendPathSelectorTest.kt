package com.qingyu.companion.data.send

import org.junit.Assert.assertEquals
import org.junit.Test

/** F-01：发送链路能力门控测试（同一 requestId 只走一条链路）。 */
class SendPathSelectorTest {

    @Test
    fun `capabilities 含 task_events_v2 时走 v2 task 链路`() {
        assertEquals(
            SendPathSelector.SendPath.TASK_V2,
            SendPathSelector.select(setOf("settings_snapshot_v2", "task_events_v2")),
        )
        assertEquals(SendPathSelector.SendPath.TASK_V2, SendPathSelector.select(setOf("task_events_v2")))
    }

    @Test
    fun `capabilities 缺失或未命中时完全走 v1 ai 链路`() {
        assertEquals(SendPathSelector.SendPath.LEGACY_V1, SendPathSelector.select(emptySet()))
        assertEquals(SendPathSelector.SendPath.LEGACY_V1, SendPathSelector.select(setOf("settings_snapshot_v2", "pairing_qr_v2")))
    }
}
