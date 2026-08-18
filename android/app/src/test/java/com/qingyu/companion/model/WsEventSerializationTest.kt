package com.qingyu.companion.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WebSocket 事件 DTO 序列化测试（kotlinx.serialization JSON 往返）。
 * 覆盖：WsEnvelope 信封、chunk/done/error/usage 载荷、枚举与默认值。
 */
class WsEventSerializationTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `WsEnvelope 反序列化信封`() {
        val raw = """{"event":"ai:chunk","payload":{"requestId":"r1","sessionId":"s1","delta":"你好"}}"""
        val env = json.decodeFromString<WsEnvelope>(raw)
        assertEquals(WsEvents.AI_CHUNK, env.event)
        assertEquals("你好", env.payload?.get("delta")?.toString().orEmpty().removeSurrounding("\""))
    }

    @Test
    fun `AiChunkPayload 序列化往返`() {
        val payload = AiChunkPayload(requestId = "r1", sessionId = "s1", delta = "增量")
        val encoded = json.encodeToString(AiChunkPayload.serializer(), payload)
        val decoded = json.decodeFromString<AiChunkPayload>(encoded)
        assertEquals(payload, decoded)
    }

    @Test
    fun `AiDonePayload 嵌套 Message 往返`() {
        val message = Message(
            id = "m1", sessionId = "s1", characterId = "c1",
            role = Role.assistant, content = "回复", timestamp = 1000L,
        )
        val payload = AiDonePayload(requestId = "r1", sessionId = "s1", message = message)
        val encoded = json.encodeToString(AiDonePayload.serializer(), payload)
        val decoded = json.decodeFromString<AiDonePayload>(encoded)
        assertEquals(payload, decoded)
        assertEquals(Role.assistant, decoded.message.role)
    }

    @Test
    fun `AiErrorPayload 与 AiUsagePayload 往返`() {
        val err = AiErrorPayload("r1", "s1", "连接失败")
        assertEquals(err, json.decodeFromString(AiErrorPayload.serializer(), json.encodeToString(AiErrorPayload.serializer(), err)))

        val usage = AiUsagePayload("r1", 10, 20, 30)
        assertEquals(usage, json.decodeFromString(AiUsagePayload.serializer(), json.encodeToString(AiUsagePayload.serializer(), usage)))
    }

    @Test
    fun `SessionUpdatedPayload 往返`() {
        val p = SessionUpdatedPayload(sessionId = "s1", change = "message")
        assertEquals(p, json.decodeFromString(SessionUpdatedPayload.serializer(), json.encodeToString(SessionUpdatedPayload.serializer(), p)))
    }

    @Test
    fun `未知事件字段被忽略`() {
        val raw = """{"event":"ai:done","payload":{"requestId":"r","sessionId":"s","message":{},"extra":"ignored"}}"""
        // ignoreUnknownKeys 下反序列化不崩溃（Message 空对象可能失败，仅验证信封可解析）
        val env = json.decodeFromString<WsEnvelope>(raw)
        assertEquals("ai:done", env.event)
    }

    @Test
    fun `WsEvents 常量完整`() {
        assertEquals("ai:chunk", WsEvents.AI_CHUNK)
        assertEquals("ai:done", WsEvents.AI_DONE)
        assertEquals("ai:error", WsEvents.AI_ERROR)
        assertEquals("ai:usage", WsEvents.AI_USAGE)
        assertEquals("ai:stop", WsEvents.AI_STOP)
        assertEquals("session:updated", WsEvents.SESSION_UPDATED)
        assertEquals("connection:heartbeat", WsEvents.CONNECTION_HEARTBEAT)
    }

    @Test
    fun `Payload 构建 JSON 对象`() {
        val obj: JsonObject = buildJsonObject {
            put("requestId", "r1")
            put("sessionId", "s1")
            put("delta", "文本")
        }
        assertEquals("r1", obj["requestId"]?.toString().orEmpty().removeSurrounding("\""))
    }
}

/** GroupMessage 领域逻辑测试（isUser 判定） */
class GroupModelTest {

    private fun gmsg(characterId: String) = GroupMessage(
        id = "g1", groupId = "grp", characterId = characterId,
        content = "内容", timestamp = 1000L,
    )

    @Test
    fun `用户消息判定`() {
        assertTrue(gmsg("__user__").isUser)
        assertFalse(gmsg("char-1").isUser)
        assertFalse(gmsg("").isUser)
    }

    @Test
    fun `群聊模型序列化往返`() {
        val json = Json { ignoreUnknownKeys = true }
        val msg = gmsg("__user__").copy(
            images = listOf("url"),
            mentionedCharacterIds = listOf("char-1", "char-2"),
            translation = "译文",
        )
        val decoded = json.decodeFromString<GroupMessage>(
            json.encodeToString(GroupMessage.serializer(), msg)
        )
        assertEquals(msg, decoded)
        assertTrue(decoded.isUser)
        assertEquals(2, decoded.mentionedCharacterIds.size)
    }

    @Test
    fun `群聊默认字段反序列化`() {
        val raw = """{"id":"g1","groupId":"grp","characterId":"c1","content":"x","timestamp":1}"""
        val msg = Json { ignoreUnknownKeys = true }.decodeFromString<GroupMessage>(raw)
        assertTrue(msg.images.isEmpty())
        assertEquals(0, msg.round)
        assertEquals(null, msg.translation)
    }

    @Test
    fun `GroupSendRequest 带提及序列化`() {
        val req = GroupSendRequest(
            content = "@爱丽丝 在吗",
            requestId = "r1",
            mentionedCharacterIds = listOf("char-1"),
        )
        val json = Json { ignoreUnknownKeys = true }
        val decoded = json.decodeFromString<GroupSendRequest>(
            json.encodeToString(GroupSendRequest.serializer(), req)
        )
        assertEquals(req, decoded)
    }
}

/** 配对流程 DTO 序列化测试（扫码载荷/配对请求/响应/连接配置） */
class PairingSerializationTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `PairingQrPayload 解析扫码内容`() {
        val raw = """{"host":"192.168.1.5","port":3200,"fingerprint":"a1:b2:c3"}"""
        val payload = json.decodeFromString<PairingQrPayload>(raw)
        assertEquals("192.168.1.5", payload.host)
        assertEquals(3200, payload.port)
        assertEquals("a1:b2:c3", payload.fingerprint)
    }

    @Test
    fun `PairRequest 与 PairResponse 往返`() {
        val req = PairRequest(pairingCode = "code-1", deviceName = "手机", deviceFingerprint = "fp")
        assertEquals(req, json.decodeFromString(PairRequest.serializer(), json.encodeToString(PairRequest.serializer(), req)))

        val resp = PairResponse(token = "jwt-token", deviceId = "dev-1")
        assertEquals(resp, json.decodeFromString(PairResponse.serializer(), json.encodeToString(PairResponse.serializer(), resp)))
    }

    @Test
    fun `ServerConnection 持久化往返`() {
        val conn = ServerConnection(
            name = "家里的工作站", host = "192.168.1.5", port = 3200,
            token = "t", deviceId = "d", fingerprint = "fp",
        )
        val decoded = json.decodeFromString<ServerConnection>(
            json.encodeToString(ServerConnection.serializer(), conn)
        )
        assertEquals(conn, decoded)
    }
}
