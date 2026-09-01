package com.qingyu.companion.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * F-01：Task v2 DTO 与 PC 契约对齐测试（JSON 原文取自 electron/bridge/taskRoutes.ts、
 * shared/chat-core/events.ts 实际形状；未知字段必须被忽略）。
 */
class TaskEventDtoTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `createTask 202 响应解码-含幂等命中场景`() {
        // taskRoutes.ts: res.status(202).json({ task: { taskId, state, lastSequence }, userMessage: { id, requestId } })
        val payload = json.parseToJsonElement(
            """{"task":{"taskId":"t-123","state":"streaming","lastSequence":4},"userMessage":{"id":"um-1","requestId":"req-1"}}""",
        ).jsonObject
        val resp = json.decodeFromJsonElement(CreateTaskResponse.serializer(), payload)
        assertEquals("t-123", resp.task.taskId)
        assertEquals("streaming", resp.task.state)
        assertEquals(4L, resp.task.lastSequence)
        assertEquals("um-1", resp.userMessage!!.id)
        assertEquals("req-1", resp.userMessage!!.requestId)
    }

    @Test
    fun `retry 202 响应快照子集可解码`() {
        // taskRoutes.ts retry: res.status(202).json({ task: { taskId: task.taskId, state: task.state } })
        val payload = json.parseToJsonElement("""{"task":{"taskId":"t-new","state":"queued"}}""").jsonObject
        val resp = json.decodeFromJsonElement(TaskSnapshotEnvelopeDto.serializer(), payload)
        assertEquals("t-new", resp.task.taskId)
        assertEquals("queued", resp.task.state)
        assertEquals("", resp.task.sessionId) // 缺省字段取默认值
    }

    @Test
    fun `EventPage 解码-事件页与压缩兜底两种形态`() {
        // 正常页
        val page = json.decodeFromString(
            TaskEventPageDto.serializer(),
            """{"events":[
                {"protocolVersion":2,"eventId":"e1","taskId":"t1","requestId":"r1","sessionId":"s1","sequence":2,"type":"task:chunk","timestamp":10,"payload":{"delta":"你好","accumulatedLength":2}},
                {"protocolVersion":2,"eventId":"e2","taskId":"t1","requestId":"r1","sessionId":"s1","sequence":3,"type":"task:usage","timestamp":11,"payload":{"promptTokens":1,"completionTokens":2,"totalTokens":3}}
            ],"nextAfterSequence":3}""",
        )
        assertEquals(2, page.events.size)
        assertEquals(3L, page.nextAfterSequence)
        assertFalse(page.resyncRequired)
        assertEquals("你好", page.events[0].chunkDelta)
        assertNull(page.snapshot)

        // 压缩页（resyncRequired + snapshot 兜底）
        val resync = json.decodeFromString(
            TaskEventPageDto.serializer(),
            """{"events":[],"nextAfterSequence":null,"resyncRequired":true,"snapshot":{"schemaVersion":1,"taskId":"t1","requestId":"r1","type":"send","state":"completed","sessionId":"s1","characterId":"c1","client":{"kind":"android","clientId":"x","protocolVersion":2},"accumulatedText":"最终文本","lastSequence":12,"createdAt":1,"updatedAt":2}}""",
        )
        assertTrue(resync.resyncRequired)
        assertEquals("completed", resync.snapshot!!.state)
        assertEquals("最终文本", resync.snapshot!!.accumulatedText)
        assertEquals(12L, resync.snapshot!!.lastSequence)
    }

    @Test
    fun `TaskSnapshot 终态判定与 error 投影`() {
        val failed = json.decodeFromString(
            TaskSnapshotDto.serializer(),
            """{"schemaVersion":1,"taskId":"t2","requestId":"r2","type":"send","state":"failed","sessionId":"s1","characterId":"c1","client":{"kind":"android","clientId":"x","protocolVersion":2},"accumulatedText":"","lastSequence":5,"error":{"code":"PROVIDER_ERROR","message":"模型调用失败","retryable":true,"safeDetails":{}},"createdAt":1,"updatedAt":2}""",
        )
        assertTrue(failed.isTerminal)
        assertEquals("PROVIDER_ERROR", failed.error!!.code)
        assertEquals("模型调用失败", failed.error!!.message)

        val streaming = TaskSnapshotDto(state = "streaming")
        assertFalse(streaming.isTerminal)
    }

    @Test
    fun `envelope 辅助属性-chunk与失败与部分文本`() {
        val chunk = json.decodeFromString(
            TaskEventEnvelopeDto.serializer(),
            """{"protocolVersion":2,"eventId":"e1","taskId":"t1","requestId":"r1","sessionId":"s1","sequence":1,"type":"task:chunk","timestamp":1,"payload":{"delta":"片段"}}""",
        )
        assertTrue(chunk.isChunkLike)
        assertEquals("片段", chunk.chunkDelta)
        assertNull(chunk.errorMessage)
        assertNull(chunk.partialText)

        val failedEnvelope = json.decodeFromString(
            TaskEventEnvelopeDto.serializer(),
            """{"protocolVersion":2,"eventId":"e2","taskId":"t1","requestId":"r1","sessionId":"s1","sequence":2,"type":"task:failed","timestamp":2,"payload":{"error":{"code":"X","message":"失败原因"}}}""",
        )
        assertFalse(failedEnvelope.isChunkLike)
        assertEquals("失败原因", failedEnvelope.errorMessage)

        val cancelled = json.decodeFromString(
            TaskEventEnvelopeDto.serializer(),
            """{"protocolVersion":2,"eventId":"e3","taskId":"t1","requestId":"r1","sessionId":"s1","sequence":3,"type":"task:cancelled","timestamp":3,"payload":{"partial":"部分内容"}}""",
        )
        assertEquals("部分内容", cancelled.partialText)
    }

    @Test
    fun `全默认值可解码-PC 子集响应容错`() {
        val envelope = json.decodeFromString(TaskEventEnvelopeDto.serializer(), """{"sequence":3}""")
        assertEquals(3L, envelope.sequence)
        assertEquals(2, envelope.protocolVersion)
        assertEquals("", envelope.type)
        assertNull(envelope.payload)
    }

    @Test
    fun `task subscribe 载荷序列化形态与 taskWsAdapter 期望一致`() {
        val payload = TaskSubscribePayload(
            sessionIds = listOf("s1", "s2"),
            cursors = mapOf("t1" to 3L),
        )
        val encoded = json.encodeToString(TaskSubscribePayload.serializer(), payload)
        assertEquals("""{"sessionIds":["s1","s2"],"cursors":{"t1":3}}""", encoded)
    }
}
