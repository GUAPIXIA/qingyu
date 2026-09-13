package com.qingyu.companion.model

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * S6：消息结构化收尾状态字段的序列化兼容测试。
 * - 新字段可解码（generationNotice / generationError / contentRenderMode）；
 * - 旧 PC 返回或旧缓存缺少字段时解码为 null（不当成解码失败）；
 * - 往返保持一致，群聊 DTO 同样支持。
 */
class MessageGenerationStatusTest {

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
        coerceInputValues = true
    }

    @Test
    fun `缺省字段解码为 null（旧 PC 返回兼容）`() {
        val raw = """{"id":"m1","sessionId":"s1","characterId":"c1","role":"assistant","content":"你好","timestamp":1000}"""
        val message = json.decodeFromString<Message>(raw)
        assertNull(message.generationNotice)
        assertNull(message.generationError)
        assertNull(message.contentRenderMode)
    }

    @Test
    fun `收尾状态字段解码与往返`() {
        val raw = """{"id":"m1","sessionId":"s1","characterId":"c1","role":"assistant","content":"被截断前的内容。","timestamp":1000,""" +
            """"generationNotice":"内容已在完整句处收束","contentRenderMode":"blocks"}"""
        val message = json.decodeFromString<Message>(raw)
        assertEquals("内容已在完整句处收束", message.generationNotice)
        assertEquals("blocks", message.contentRenderMode)
        assertNull(message.generationError)

        val roundTrip = json.decodeFromString<Message>(
            json.encodeToString(Message.serializer(), message),
        )
        assertEquals(message, roundTrip)
    }

    @Test
    fun `失败原因单独字段，不污染正文`() {
        val raw = """{"id":"m2","sessionId":"s1","characterId":"c1","role":"assistant","content":"半句正文。","timestamp":1000,""" +
            """"generationError":"请求超时"}"""
        val message = json.decodeFromString<Message>(raw)
        assertEquals("请求超时", message.generationError)
        assertEquals("半句正文。", message.content)
        assertNull(message.generationNotice)
    }

    @Test
    fun `群聊 DTO 同样消费收尾状态字段`() {
        val raw = """{"id":"g1","groupId":"grp","characterId":"c1","content":"正文。","timestamp":1000,""" +
            """"generationError":"请求超时","contentRenderMode":"blocks"}"""
        val message = json.decodeFromString<GroupMessage>(raw)
        assertEquals("请求超时", message.generationError)
        assertEquals("blocks", message.contentRenderMode)
        assertNull(message.generationNotice)
    }
}
