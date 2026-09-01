package com.qingyu.companion.data.send

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * F-02：task 事件 cursor 三规则测试（方案 §10 F-02）。
 */
class TaskCursorLogicTest {

    // ---------- 三规则 ----------

    @Test
    fun `规则1-sequence等于last加1时应用并推进`() {
        assertEquals(TaskCursorLogic.Action.APPLY_ADVANCE, TaskCursorLogic.decide(lastSequence = 0, incomingSequence = 1))
        assertEquals(TaskCursorLogic.Action.APPLY_ADVANCE, TaskCursorLogic.decide(lastSequence = 4, incomingSequence = 5))
    }

    @Test
    fun `规则2-sequence小于等于last时忽略`() {
        assertEquals(TaskCursorLogic.Action.IGNORE_DUPLICATE, TaskCursorLogic.decide(lastSequence = 5, incomingSequence = 5))
        assertEquals(TaskCursorLogic.Action.IGNORE_DUPLICATE, TaskCursorLogic.decide(lastSequence = 5, incomingSequence = 3))
        assertEquals(TaskCursorLogic.Action.IGNORE_DUPLICATE, TaskCursorLogic.decide(lastSequence = 5, incomingSequence = 0))
    }

    @Test
    fun `规则3-sequence大于last加1时暂停并补拉`() {
        assertEquals(TaskCursorLogic.Action.PAUSE_GAP, TaskCursorLogic.decide(lastSequence = 5, incomingSequence = 7))
        assertEquals(TaskCursorLogic.Action.PAUSE_GAP, TaskCursorLogic.decide(lastSequence = 0, incomingSequence = 2))
    }

    // ---------- 批量应用计划 ----------

    @Test
    fun `planBatch 连续事件全部应用`() {
        val plan = TaskCursorLogic.planBatch(cursor = 2, sequences = listOf(3, 4, 5))
        assertEquals(5L, plan.appliedTo)
        assertNull(plan.gapAt)
        assertEquals(3, plan.appliedCount)
    }

    @Test
    fun `planBatch 重复事件被跳过`() {
        val plan = TaskCursorLogic.planBatch(cursor = 5, sequences = listOf(4, 5, 6))
        assertEquals(6L, plan.appliedTo)
        assertNull(plan.gapAt)
        assertEquals(1, plan.appliedCount)
    }

    @Test
    fun `planBatch 缺口处暂停应用后续事件`() {
        // 7 缺口：3、4 应用？不——3 == cursor+1 应用，4 应用，7 缺口暂停（5、6 一起缺席）
        val plan = TaskCursorLogic.planBatch(cursor = 2, sequences = listOf(3, 4, 7, 8))
        assertEquals(4L, plan.appliedTo)
        assertEquals(7L, plan.gapAt)
        assertEquals(2, plan.appliedCount)
    }

    @Test
    fun `planBatch 全重复不推进`() {
        val plan = TaskCursorLogic.planBatch(cursor = 10, sequences = listOf(8, 9, 10))
        assertEquals(10L, plan.appliedTo)
        assertNull(plan.gapAt)
        assertEquals(0, plan.appliedCount)
    }

    @Test
    fun `planBatch 空批保持 cursor`() {
        val plan = TaskCursorLogic.planBatch(cursor = 3, sequences = emptyList())
        assertEquals(3L, plan.appliedTo)
        assertNull(plan.gapAt)
        assertEquals(0, plan.appliedCount)
    }

    // ---------- checkpoint 兜底判定 ----------

    @Test
    fun `兜底判定-resyncRequired 直接兜底`() {
        assertTrue(TaskCursorLogic.needsSnapshotFallback(cursor = 3, firstEventSequence = 4, resyncRequired = true, snapshotLastSequence = 9))
    }

    @Test
    fun `兜底判定-补拉后首个事件仍越过cursor加1`() {
        assertTrue(TaskCursorLogic.needsSnapshotFallback(cursor = 3, firstEventSequence = 6, resyncRequired = false, snapshotLastSequence = 9))
    }

    @Test
    fun `兜底判定-空页但快照已越过cursor`() {
        assertTrue(TaskCursorLogic.needsSnapshotFallback(cursor = 3, firstEventSequence = null, resyncRequired = false, snapshotLastSequence = 9))
    }

    @Test
    fun `兜底判定-正常续传不兜底`() {
        assertFalse(TaskCursorLogic.needsSnapshotFallback(cursor = 3, firstEventSequence = 4, resyncRequired = false, snapshotLastSequence = 9))
        assertFalse(TaskCursorLogic.needsSnapshotFallback(cursor = 3, firstEventSequence = null, resyncRequired = false, snapshotLastSequence = null))
        assertFalse(TaskCursorLogic.needsSnapshotFallback(cursor = 9, firstEventSequence = null, resyncRequired = false, snapshotLastSequence = 9))
    }
}
