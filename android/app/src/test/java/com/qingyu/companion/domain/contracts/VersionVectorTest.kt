package com.qingyu.companion.domain.contracts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VersionVectorTest {

    @Test
    fun counterDecimalNoLeadingZero() {
        assertTrue("0".matches(Regex("^(0|[1-9][0-9]*)$")))
        assertTrue("18446744073709551615".matches(Regex("^(0|[1-9][0-9]*)$")))
        assertFalse("01".matches(Regex("^(0|[1-9][0-9]*)$")))
    }

    @Test
    fun compareDominance() {
        val a = mapOf("pc" to 3)
        val b = mapOf("pc" to 3, "and" to 1)
        assertEquals("dominated", compare(a, b))
        assertEquals("dominates", compare(b, a))
        assertEquals("equal", compare(a, a))
        assertEquals("concurrent", compare(mapOf("pc" to 1), mapOf("and" to 1)))
    }

    private fun compare(x: Map<String, Int>, y: Map<String, Int>): String {
        var xGe = true
        var yGe = true
        val keys = x.keys + y.keys
        for (k in keys) {
            val xv = x[k] ?: 0
            val yv = y[k] ?: 0
            if (xv > yv) yGe = false
            if (yv > xv) xGe = false
        }
        return when {
            xGe && yGe -> "equal"
            xGe -> "dominates"
            yGe -> "dominated"
            else -> "concurrent"
        }
    }
}
