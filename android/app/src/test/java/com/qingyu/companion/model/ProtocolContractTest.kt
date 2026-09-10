package com.qingyu.companion.model

import com.qingyu.companion.network.NetworkModule
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@Serializable
private data class MessageIdentityFixture(
    val singleMessages: List<Message> = emptyList(),
    val groupMessages: List<GroupMessage> = emptyList(),
)

/**
 * G-05 契约测试（Android 半边）：双向共享 fixture。
 *
 * fixture 单处权威 = repo 根 shared/fixtures/（PC 侧 electron/bridge/__tests__/contractFixtures.test.ts
 * 读取同一份）；本目录 android/app/src/test/resources/fixtures/ 为**副本**。
 * 修改契约时必须先改 shared/fixtures/ 再同步副本，两端契约测试同时跑绿。
 *
 * 对齐项：
 * - SettingsSnapshotDto（GET /api/v1/settings/snapshot，契约来源 electron/bridge/settingsSync.ts）；
 * - SettingsPatchRequestDto（PATCH 请求体，sourceDeviceId 可选）；
 * - PairingQrV2Payload / parsePairingQr（契约来源 shared/pairingQr.ts + electron/bridge/index.ts）；
 * - TaskEventEnvelopeDto（WS task:* 帧 payload，契约来源 shared/chat-core/events.ts + taskWsAdapter）。
 * 解码统一用 NetworkModule.json（ignoreUnknownKeys=true / coerceInputValues=true），
 * 未知字段必须被忽略、缺失字段走默认值。
 */
class ProtocolContractTest {

    private val json = NetworkModule.json
    private val now = 1_788_000_000_000L

    private fun fixture(name: String): String {
        // 副本来源注解：shared/fixtures/<name>（单处权威，见类注释）
        val raw = javaClass.classLoader?.getResourceAsStream("fixtures/$name")
            ?.bufferedReader()?.use { it.readText() }
            ?: error("缺少契约 fixture: fixtures/$name（权威副本 shared/fixtures/$name）")
        return raw
    }

    // ===================== settings_snapshot.json =====================

    @Test
    fun `settings snapshot fixture 解码为 SettingsSnapshotDto`() {
        val dto = json.decodeFromString(SettingsSnapshotDto.serializer(), fixture("settings_snapshot.json"))
        assertEquals(2, dto.schemaVersion)
        assertEquals("612f09d3960076a09105b60db75dd852ccb69cee83f0948a7adce25a76eb8e57", dto.revision)
        assertEquals(1_788_000_000_000L, dto.updatedAt)
        assertEquals("轻语用户", dto.values.userName)
        assertEquals("gpt-4o", dto.values.activeModel)
        assertEquals("builtin-default", dto.values.activePresetId)
        assertEquals("中文", dto.values.translationTargetLang)
        assertEquals(0.3, dto.values.lorebookRatio, 1e-9)
        assertTrue("settings_snapshot_v2" in dto.capabilities)
        assertTrue("task_events_v2" !in dto.capabilities)
    }

    @Test
    fun `settings snapshot fixture 不含敏感字段且无 PC 显示偏好`() {
        val raw = fixture("settings_snapshot.json")
        // 断言点：白名单之外（apiKey/凭据/connectionProfiles/PC 显示偏好）绝不出现
        assertFalse(raw.contains("apiKey"))
        assertFalse(raw.contains("sk-", ignoreCase = true))
        assertFalse(raw.contains("connectionProfiles"))
        assertFalse(raw.contains("fontSize"))
        assertFalse(raw.contains("themeColor"))
        assertFalse(raw.contains("bubbleStyle"))
        assertFalse(raw.contains("messageWidth"))
        assertFalse(raw.contains("messageSpacing"))
        assertFalse(raw.contains("providers"))
        // values 键集与 Android 侧 SettingsDto 的安全子集一致
        val dto = json.decodeFromString(SettingsSnapshotDto.serializer(), raw)
        val keys = json.parseToJsonElement(raw).jsonObject["values"]!!.jsonObject.keys
        assertEquals(
            setOf(
                "userName", "userDescription", "userPersona", "activePresetId", "activeModel",
                "translationTargetLang", "streamOutput", "autoScroll", "showTokenCount",
                "htmlRendering", "imageGenAutoEnabled", "imageGenSize", "exampleDialogMode",
                "lorebookRatio", "autoTitle", "defaultNarrativeMode", "omniscientNarrativeRules",
            ),
            keys,
        )
        // 未知字段容错与默认值：解码不抛、缺字段取默认
        assertNotNull(dto.values.userName)
        assertEquals("中文", dto.values.translationTargetLang)
    }

    @Test
    fun `settings snapshot fixture 注入未知字段被忽略`() {
        // PC 侧新增字段（如 futureCapabilityX）不得导致 Android 解码失败
        val raw = fixture("settings_snapshot.json")
        val withUnknown = raw.substringBeforeLast("}") + ",\"futureTopLevelField\":{\"a\":1}}"
        val dto = json.decodeFromString(SettingsSnapshotDto.serializer(), withUnknown)
        assertEquals("轻语用户", dto.values.userName)
    }

    // ===================== settings_patch_request.json =====================

    @Test
    fun `settings patch fixture 解码为 SettingsPatchRequestDto`() {
        val dto = json.decodeFromString(SettingsPatchRequestDto.serializer(), fixture("settings_patch_request.json"))
        assertEquals("1a932d501546fabe3d5f38cf449da6bf2c1b611862df185d766ad343f2a1bde6", dto.baseRevision)
        assertEquals("contract-test-device-1", dto.sourceDeviceId)
        val patch = dto.patch
        assertEquals("英语", (patch["translationTargetLang"] as JsonPrimitive).content)
        assertEquals("false", (patch["streamOutput"] as JsonPrimitive).content)
        assertEquals(0.6, (patch["lorebookRatio"] as JsonPrimitive).content.toDouble(), 1e-9)
        // 非法字段保留在 patch 中由服务端校验（Android 不预过滤，仅序列化传输）
        assertEquals("sk-contract-test-leak", (patch["apiKey"] as JsonPrimitive).content)
    }

    @Test
    fun `settings patch fixture 不含真实凭据`() {
        val raw = fixture("settings_patch_request.json")
        assertFalse(raw.contains("sk-top-secret"))
        assertFalse(raw.contains("Bearer "))
    }

    // ===================== pairing_qr_v2.json =====================

    @Test
    fun `pairing qr v2 fixture 解析为 V2`() {
        val result = parsePairingQr(fixture("pairing_qr_v2.json"), json, now)
        assertTrue("应为 V2，实际 $result", result is PairingQrResult.V2)
        val p = (result as PairingQrResult.V2).payload
        assertEquals(2, p.version)
        assertEquals("qingyu-pair", p.scheme)
        assertEquals("contract-server-uuid-0001", p.serverId)
        assertEquals("轻语-契约测试机", p.displayName)
        assertEquals(1, p.apiVersion)
        assertTrue("settings_snapshot_v2" in p.capabilities)
        assertTrue("task_events_v2" in p.capabilities)
        assertEquals("contract-pairing-code-001", p.pairingCode)
        assertTrue(p.expiresAt > now)
        assertEquals(2, p.endpoints.size)
        assertEquals("192.168.1.8", p.endpoints[0].host)
        assertEquals(8321, p.endpoints[0].port)
        assertEquals("LOCAL_CLEARTEXT", p.endpoints[0].security)
        assertNull(p.certificatePin)
    }

    @Test
    fun `pairing qr v2 fixture 未知字段被忽略（DTO 直解码）`() {
        // 直接按 DTO 解码（绕过 parsePairingQr 的语义校验）：未知字段不崩溃
        val dto = json.decodeFromString(PairingQrV2Payload.serializer(), fixture("pairing_qr_v2.json"))
        assertEquals("contract-server-uuid-0001", dto.serverId)
        assertEquals(8321, dto.endpoints.first().port)
    }

    // ===================== task_event_envelope.json =====================

    @Test
    fun `task event envelope fixture 解码为 TaskEventEnvelopeDto`() {
        val dto = json.decodeFromString(TaskEventEnvelopeDto.serializer(), fixture("task_event_envelope.json"))
        assertEquals(2, dto.protocolVersion)
        assertEquals("evt-contract-0001", dto.eventId)
        assertEquals("task-contract-0001", dto.taskId)
        assertEquals("req-contract-0001", dto.requestId)
        assertEquals("session-contract-0001", dto.sessionId)
        assertEquals(4L, dto.sequence)
        assertEquals("task:chunk", dto.type)
        assertEquals(1_788_000_001_000L, dto.timestamp)
        assertEquals("这是来自 PC 侧 task:* 帧的契约测试增量文本。", dto.chunkDelta)
        assertEquals(24L, (dto.payload!!["accumulatedLength"] as JsonPrimitive).content.toLong())
        assertTrue(dto.isChunkLike)
    }

    @Test
    fun `task event envelope fixture 缺字段走默认值且未知字段忽略`() {
        val raw = fixture("task_event_envelope.json")
        val minimal = """{"taskId":"t1","sessionId":"s1","type":"task:started","payload":{"x":1},"futureField":true}"""
        val dto = json.decodeFromString(TaskEventEnvelopeDto.serializer(), minimal)
        assertEquals("t1", dto.taskId)
        assertEquals(0L, dto.sequence)          // 缺省默认 0
        assertEquals("", dto.requestId)         // 缺省默认空串
        assertEquals(2, dto.protocolVersion)    // 缺省默认 2
        assertFalse(dto.isChunkLike)
        // 原 fixture 中的 chunk 语义不受影响
        val full = json.decodeFromString(TaskEventEnvelopeDto.serializer(), raw)
        assertTrue(full.isChunkLike)
    }

    // ===================== message_identity.json =====================

    @Test
    fun `message identity fixture 单聊与群聊字段可跨端解码`() {
        val dto = json.decodeFromString(MessageIdentityFixture.serializer(), fixture("message_identity.json"))
        assertEquals(4, dto.singleMessages.size)
        assertEquals("narrator", dto.singleMessages[1].speakerKind)
        assertEquals("input_continue", dto.singleMessages[1].generationKind)
        assertEquals("character", dto.singleMessages[2].speakerKind)
        assertEquals("assistant_reply", dto.groupMessages[1].generationKind)
    }

    @Test
    fun `message identity 旧字段与非法字段使用一致回退规则`() {
        val dto = json.decodeFromString(MessageIdentityFixture.serializer(), fixture("message_identity.json"))
        val legacy = dto.singleMessages[3]
        assertEquals(
            MessageIdentity.NARRATOR,
            MessageIdentity.resolveSpeakerKind(legacy.speakerKind, legacy.role, legacy.characterId, legacy.narrativeMode),
        )
        assertEquals(
            MessageIdentity.CHARACTER,
            MessageIdentity.resolveSpeakerKind("future_unknown", Role.assistant, "c1", "omniscient"),
        )
        assertEquals(
            MessageIdentity.NARRATOR,
            MessageIdentity.resolveSpeakerKind("future_unknown", characterId = "__user__", narrativeMode = "omniscient"),
        )
    }
}
