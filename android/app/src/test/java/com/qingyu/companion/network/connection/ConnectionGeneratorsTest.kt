package com.qingyu.companion.network.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** B-05 连接代次/租约守卫回归：旧回调必须被拒绝，语义相同的新引用必须被接受。 */
class ConnectionGeneratorsTest {

    private val epA = ConnectionEndpoint("192.168.1.10", 8321, TransportSecurity.LOCAL_CLEARTEXT)
    private val epB = ConnectionEndpoint("10.0.0.5", 8321, TransportSecurity.LOCAL_CLEARTEXT)

    @Test
    fun `advance is monotonic and publishes current lease`() {
        val gen = ConnectionGenerators()
        assertEquals(0L, gen.generation())
        val lease = gen.advance("dev-1", epA)
        assertEquals(1L, lease.generation)
        assertEquals(1L, gen.generation())
        assertEquals("dev-1", gen.current.value?.deviceId)
        val next = gen.advance("dev-2", epB)
        assertEquals(2L, next.generation)
        assertTrue(gen.generation() > lease.generation)
    }

    @Test
    fun `stale lease is rejected after newer connect`() {
        val gen = ConnectionGenerators()
        val old = gen.advance("dev-1", epA)
        assertTrue(gen.isCurrent(old))
        val fresh = gen.advance("dev-2", epB)
        // 切换 PC：旧代次的探测回调失效
        assertFalse(gen.isCurrent(old))
        assertTrue(gen.isCurrent(fresh))
        assertFalse(gen.isCurrentDevice(old))
    }

    @Test
    fun `disconnect retires lease and invalidates everything`() {
        val gen = ConnectionGenerators()
        val lease = gen.advance("dev-1", epA)
        val retired = gen.retire()
        assertFalse(gen.isCurrent(lease))
        assertNull(gen.current.value)
        assertEquals(retired, gen.generation())
        // 退役后新连接继续单调递增
        val next = gen.advance("dev-1", epB)
        assertTrue(next.generation > retired)
    }

    @Test
    fun `restamp keeps generation but updates endpoint`() {
        val gen = ConnectionGenerators()
        val lease = gen.advance("dev-1", epA)
        val stamped = gen.restamp(lease, epB)
        assertEquals(lease.generation, stamped.generation)
        assertEquals(epB, gen.current.value?.endpoint)
        // 旧 lease 仍属当前代次（同设备换端点不作废在途回调）
        assertTrue(gen.isCurrent(lease))
        assertTrue(gen.isCurrent(stamped))
    }

    @Test
    fun `restamp after advance cannot resurrect old generation`() {
        val gen = ConnectionGenerators()
        val old = gen.advance("dev-1", epA)
        val fresh = gen.advance("dev-2", epB)
        val ghost = gen.restamp(old, epA)
        assertFalse(gen.isCurrent(ghost))
        assertEquals(fresh.generation, gen.current.value?.generation)
    }

    @Test
    fun `semantic equality replaces reference equality`() {
        val gen = ConnectionGenerators()
        val lease = gen.advance("dev-1", epA)
        // 重新加载的数据类引用不同但语义相同：代次判断必须仍然通过
        val same = ConnectionLease(lease.generation, "dev-1", epA.copy())
        assertNotSameInstance(lease, same)
        assertTrue(gen.isCurrent(same))
        // deviceId 不同的同代次对象：语义校验失败
        assertFalse(gen.isCurrentDevice(same.copy(deviceId = "dev-other")))
    }

    private fun assertNotSameInstance(a: Any, b: Any) {
        assertTrue(a !== b)
    }
}
