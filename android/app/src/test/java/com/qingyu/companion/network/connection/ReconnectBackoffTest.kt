package com.qingyu.companion.network.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/** B-06 退避序列（含 jitter 边界）回归。 */
class ReconnectBackoffTest {

    @Test
    fun `base sequence is 0 1 2 4 8 15 30 then capped`() {
        assertEquals(0L, ReconnectBackoff.baseDelayMs(1))
        assertEquals(1_000L, ReconnectBackoff.baseDelayMs(2))
        assertEquals(2_000L, ReconnectBackoff.baseDelayMs(3))
        assertEquals(4_000L, ReconnectBackoff.baseDelayMs(4))
        assertEquals(8_000L, ReconnectBackoff.baseDelayMs(5))
        assertEquals(15_000L, ReconnectBackoff.baseDelayMs(6))
        assertEquals(30_000L, ReconnectBackoff.baseDelayMs(7))
        // 之后维持 30s
        assertEquals(30_000L, ReconnectBackoff.baseDelayMs(8))
        assertEquals(30_000L, ReconnectBackoff.baseDelayMs(999))
    }

    @Test
    fun `zero attempt and negative clamp to first slot`() {
        assertEquals(0L, ReconnectBackoff.baseDelayMs(0))
        assertEquals(0L, ReconnectBackoff.baseDelayMs(-5))
    }

    @Test
    fun `jitter boundaries are exactly ±20 percent`() {
        // base=1000：下界 800，上界 1200
        assertEquals(800L, ReconnectBackoff.delayMs(2, -1.0))
        assertEquals(1_000L, ReconnectBackoff.delayMs(2, 0.0))
        assertEquals(1_200L, ReconnectBackoff.delayMs(2, 1.0))
        // base=30000 封顶：±20% → 24000 / 36000
        assertEquals(24_000L, ReconnectBackoff.delayMs(7, -1.0))
        assertEquals(36_000L, ReconnectBackoff.delayMs(7, 1.0))
    }

    @Test
    fun `out of range jitter factor clamps to boundary`() {
        assertEquals(800L, ReconnectBackoff.delayMs(2, -99.0))
        assertEquals(1_200L, ReconnectBackoff.delayMs(2, 99.0))
    }

    @Test
    fun `first attempt base zero keeps delay exactly zero regardless of jitter`() {
        assertEquals(0L, ReconnectBackoff.delayMs(1, 1.0))
        assertEquals(0L, ReconnectBackoff.delayMs(1, -1.0))
        assertEquals(0L, ReconnectBackoff.delayMs(1, Random(7)))
    }

    @Test
    fun `randomized delay always within ±20 percent band for many seeds`() {
        for (attempt in 2..12) {
            val base = ReconnectBackoff.baseDelayMs(attempt)
            repeat(50) {
                val value = ReconnectBackoff.delayMs(attempt, Random(it * 31 + attempt))
                assertTrue(
                    "attempt=$attempt value=$value base=$base",
                    value in (base * 0.8).toLong()..(base * 1.2).toLong(),
                )
            }
        }
    }
}
