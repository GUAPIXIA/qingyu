package com.qingyu.companion.model

import com.qingyu.companion.data.settings.SettingsOwnership
import com.qingyu.companion.data.settings.settingsFieldValue
import com.qingyu.companion.network.NetworkModule
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 设置同步 v2 DTO 解码测试（方案 §7 C-06，契约对齐 electron/bridge/settingsSync.ts）。
 * 关键兼容：旧响应缺 capabilities 字段 → 默认空集不崩溃。
 */
class SettingsSyncSerializationTest {

    private val json = NetworkModule.json

    @Test
    fun `snapshot 完整解码`() {
        val raw = """
            {
              "schemaVersion": 2,
              "revision": "abc123",
              "updatedAt": 1788000000000,
              "values": { "activeModel": "gpt-4o", "translationTargetLang": "英语", "lorebookRatio": 0.4 },
              "capabilities": ["settings_snapshot_v2", "settings_events_v1"]
            }
        """.trimIndent()
        val dto = json.decodeFromString(SettingsSnapshotDto.serializer(), raw)
        assertEquals(2, dto.schemaVersion)
        assertEquals("abc123", dto.revision)
        assertEquals("gpt-4o", dto.values.activeModel)
        assertEquals("英语", dto.values.translationTargetLang)
        assertEquals(0.4, dto.values.lorebookRatio, 1e-9)
        assertTrue("settings_snapshot_v2" in dto.capabilities)
    }

    @Test
    fun `旧响应缺 capabilities 字段不崩溃`() {
        val raw = """
            { "schemaVersion": 2, "revision": "r1", "updatedAt": 1, "values": {} }
        """.trimIndent()
        val dto = json.decodeFromString(SettingsSnapshotDto.serializer(), raw)
        assertEquals("r1", dto.revision)
        assertTrue(dto.capabilities.isEmpty())
        // values 缺失字段取默认值（SettingsDto 全字段默认）
        assertEquals("中文", dto.values.translationTargetLang)
        assertEquals(0.3, dto.values.lorebookRatio, 1e-9)
    }

    @Test
    fun `values 未知字段被忽略（PC 新增字段向后兼容）`() {
        val raw = """
            { "schemaVersion": 2, "revision": "r", "updatedAt": 1,
              "values": { "futureField": 42, "activeModel": "m" }, "capabilities": [] }
        """.trimIndent()
        val dto = json.decodeFromString(SettingsSnapshotDto.serializer(), raw)
        assertEquals("m", dto.values.activeModel)
    }

    @Test
    fun `imageGenSize 已随 v3 整体下线`() {
        // 已退出同步白名单：旧 Android PATCH 该字段会被判 field_not_allowed
        assertFalse("imageGenSize" in SettingsOwnership.SYNCABLE_FIELDS)
        // 旧 PC 快照携带该字段时由 ignoreUnknownKeys 容错，解码不抛
        val raw = """
            { "schemaVersion": 2, "revision": "legacy", "updatedAt": 1,
              "values": { "activeModel": "m", "imageGenSize": "768x1344" }, "capabilities": [] }
        """.trimIndent()
        val dto = json.decodeFromString(SettingsSnapshotDto.serializer(), raw)
        assertEquals("m", dto.values.activeModel)
    }

    @Test
    fun `自动生图字段已随 v4 整体下线`() {
        // 移出同步白名单：旧 Android PATCH 该字段会被判 field_not_allowed
        assertFalse("imageGenAutoEnabled" in SettingsOwnership.SYNCABLE_FIELDS)
        // 冲突面板取值分支已移除
        assertNull(settingsFieldValue(SettingsDto(), "imageGenAutoEnabled"))
        // 旧 PC 快照携带该字段时由 ignoreUnknownKeys 容错，解码不抛
        val raw = """
            { "schemaVersion": 3, "revision": "legacy", "updatedAt": 1,
              "values": { "activeModel": "m", "imageGenAutoEnabled": true }, "capabilities": [] }
        """.trimIndent()
        val dto = json.decodeFromString(SettingsSnapshotDto.serializer(), raw)
        assertEquals("m", dto.values.activeModel)
    }

    @Test
    fun `patch 请求编码：baseRevision + 白名单增量 + 可选 sourceDeviceId`() {
        val req = SettingsPatchRequestDto(
            baseRevision = "rev9",
            patch = buildJsonObject {
                put("activeModel", JsonPrimitive("gpt-5"))
                put("activePresetId", JsonPrimitive(null as String?))
            },
            sourceDeviceId = "dev-1",
        )
        val encoded = json.encodeToString(SettingsPatchRequestDto.serializer(), req)
        assertTrue(encoded.contains("\"baseRevision\":\"rev9\""))
        assertTrue(encoded.contains("\"activeModel\":\"gpt-5\""))
        assertTrue(encoded.contains("\"sourceDeviceId\":\"dev-1\""))
        // explicitNulls=false：JsonNull 值保留在 patch 内（activePresetId 允许 null）
        assertTrue(encoded.contains("\"activePresetId\":null"))
    }

    @Test
    fun `patch 响应含 applied 与 rejected 字段`() {
        val raw = """
            {
              "schemaVersion": 2, "revision": "new", "updatedAt": 5,
              "values": { "activeModel": "gpt-5" },
              "appliedFields": ["activeModel"],
              "rejectedFields": [{ "field": "themeColor", "reason": "field_not_allowed" }]
            }
        """.trimIndent()
        val resp = json.decodeFromString(SettingsPatchResponseDto.serializer(), raw)
        assertEquals("new", resp.revision)
        assertEquals(listOf("activeModel"), resp.appliedFields)
        assertEquals("field_not_allowed", resp.rejectedFields.single().reason)
    }

    @Test
    fun `409 冲突体解码保留 current 快照`() {
        val raw = """
            {
              "error": "settings_conflict",
              "current": {
                "schemaVersion": 2, "revision": "remoteRev", "updatedAt": 7,
                "values": { "activeModel": "claude" }, "capabilities": ["settings_snapshot_v2"]
              }
            }
        """.trimIndent()
        val body = json.decodeFromString(SettingsConflictBodyDto.serializer(), raw)
        assertEquals("settings_conflict", body.error)
        assertEquals("remoteRev", body.current?.revision)
        assertEquals("claude", body.current?.values?.activeModel)
    }

    @Test
    fun `settings updated 载荷解码（changedFields 缺省兼容）`() {
        val raw = """{"revision":"r2","sourceDeviceId":"dev-2"}"""
        val p = json.decodeFromString(SettingsUpdatedPayload.serializer(), raw)
        assertEquals("r2", p.revision)
        assertTrue(p.changedFields.isEmpty())
        assertEquals("dev-2", p.sourceDeviceId)
    }

    @Test
    fun `serverInfo 缺 capabilities 默认空集（旧 PC 兼容）`() {
        val info = json.decodeFromString(ServerInfo.serializer(), """{"apiVersion":1,"appVersion":"0.16.0"}""")
        assertTrue(info.capabilities.isEmpty())
        val info2 = json.decodeFromString(
            ServerInfo.serializer(),
            """{"apiVersion":1,"appVersion":"0.17.0","capabilities":["settings_snapshot_v2","pairing_qr_v2"]}""",
        )
        assertTrue("settings_snapshot_v2" in info2.capabilities)
    }
}
