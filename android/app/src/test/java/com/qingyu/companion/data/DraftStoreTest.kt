package com.qingyu.companion.data

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 草稿保存/恢复（路线图 5.2）：
 * - 每会话隔离
 * - 发送后清除
 * - 空文本清除
 * 使用内存 Map 模拟 DataStore 行为，验证契约而非 Android 实现
 */
class DraftStoreTest {

    private class FakeDraftStore {
        private val map = mutableMapOf<String, String>()
        fun save(sessionId: String, text: String) {
            if (text.isEmpty()) map.remove(sessionId) else map[sessionId] = text
        }
        fun load(sessionId: String): String = map[sessionId] ?: ""
        fun clear(sessionId: String) { map.remove(sessionId) }
    }

    @Test
    fun `保存后可恢复`() {
        val store = FakeDraftStore()
        store.save("s1", "hello draft")
        assertEquals("hello draft", store.load("s1"))
    }

    @Test
    fun `不同会话隔离`() {
        val store = FakeDraftStore()
        store.save("s1", "draft s1")
        store.save("s2", "draft s2")
        assertEquals("draft s1", store.load("s1"))
        assertEquals("draft s2", store.load("s2"))
        store.save("s1", "updated s1")
        assertEquals("updated s1", store.load("s1"))
        assertEquals("draft s2", store.load("s2"))
    }

    @Test
    fun `发送后清除`() {
        val store = FakeDraftStore()
        store.save("s1", "草稿")
        store.clear("s1")
        assertEquals("", store.load("s1"))
    }

    @Test
    fun `空文本即清除`() {
        val store = FakeDraftStore()
        store.save("s1", "有内容")
        store.save("s1", "")
        assertEquals("", store.load("s1"))
    }

    @Test
    fun `切换会话恢复对应草稿`() {
        val store = FakeDraftStore()
        store.save("s1", "s1 draft")
        store.save("s2", "s2 draft")
        // 模拟切换
        assertEquals("s1 draft", store.load("s1"))
        assertEquals("s2 draft", store.load("s2"))
        // s1 发送后清除
        store.clear("s1")
        assertEquals("", store.load("s1"))
        assertEquals("s2 draft", store.load("s2"))
    }
}
