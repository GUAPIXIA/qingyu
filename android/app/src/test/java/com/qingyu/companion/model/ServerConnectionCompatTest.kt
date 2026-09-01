package com.qingyu.companion.model

import com.qingyu.companion.network.NetworkModule
import com.qingyu.companion.network.connection.TransportSecurity
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * B-02 兼容基线：旧版本（阶段 A 前）写盘的五字段 JSON 必须无损解码，
 * 新增字段全部落到声明的默认值；读取阶段不删旧数据。
 */
class ServerConnectionCompatTest {

    // 阶段 A 及以前的真实落盘格式（固定字符串，防止字段名/默认值漂移）
    private val legacyJson =
        """{"name":"家里的工作站","host":"192.168.10.3","port":8321,"token":"jwt-secret","deviceId":"dev-9","fingerprint":"fp-9"}"""

    @Test
    fun `legacy record decodes with new field defaults`() {
        val conn = NetworkModule.json.decodeFromString<ServerConnection>(legacyJson)
        // 旧字段原样保留
        assertEquals("家里的工作站", conn.name)
        assertEquals("192.168.10.3", conn.host)
        assertEquals(8321, conn.port)
        assertEquals("jwt-secret", conn.token)
        assertEquals("dev-9", conn.deviceId)
        assertEquals("fp-9", conn.fingerprint)
        // B-02 新字段默认值
        assertNull(conn.serverId)
        assertEquals(1, conn.pairingProtocolVersion)
        assertTrue(conn.endpoints.isEmpty())
        assertNull(conn.lastSuccessfulEndpoint)
        assertEquals(0L, conn.lastConnectedAt)
        assertTrue(conn.capabilities.isEmpty())
    }

    @Test
    fun `legacy list json decodes as list`() {
        val list = NetworkModule.json.decodeFromString<List<ServerConnection>>("[$legacyJson]")
        assertEquals(1, list.size)
        assertEquals("dev-9", list[0].deviceId)
    }

    @Test
    fun `new fields round trip and legacy host port synthesis still works`() {
        val conn = NetworkModule.json.decodeFromString<ServerConnection>(legacyJson)
        assertEquals("http://192.168.10.3:8321/", conn.legacyEndpoint.toHttpUrl())
        val enriched = conn.copy(
            serverId = "srv-1",
            pairingProtocolVersion = 2,
            endpoints = listOf(conn.legacyEndpoint),
            lastSuccessfulEndpoint = conn.legacyEndpoint,
            lastConnectedAt = 123L,
            capabilities = setOf("settings-snapshot-v2"),
        )
        val text = NetworkModule.json.encodeToString(enriched)
        val back = NetworkModule.json.decodeFromString<ServerConnection>(text)
        assertEquals(enriched, back)
        assertEquals("srv-1", back.serverId)
        assertEquals(listOf(conn.legacyEndpoint), back.endpoints)
        assertEquals(setOf("settings-snapshot-v2"), back.capabilities)
    }

    @Test
    fun `lastSuccessfulEndpoint takes precedence in endpointOf`() {
        val conn = NetworkModule.json.decodeFromString<ServerConnection>(legacyJson)
        assertEquals(
            NetworkModule.endpointOf(conn),
            com.qingyu.companion.network.connection.EndpointNormalizer.normalize("192.168.10.3", 8321),
        )
        val migrated = conn.copy(
            lastSuccessfulEndpoint = com.qingyu.companion.network.connection.ConnectionEndpoint(
                "100.80.20.30", 8321, TransportSecurity.LOCAL_CLEARTEXT,
            ),
        )
        assertEquals("100.80.20.30", NetworkModule.endpointOf(migrated).host)
        // 旧记录（未回填）仍走 host/port 合成，不因新语义破坏
        assertEquals("192.168.10.3", NetworkModule.endpointOf(conn).host)
    }

    @Test
    fun `unknown future fields are ignored when reading`() {
        val futureJson = legacyJson.removeSuffix("}") + ""","serverId":"s","brandNew":"x","pairingProtocolVersion":3}"""
        val conn = NetworkModule.json.decodeFromString<ServerConnection>(futureJson)
        assertEquals("s", conn.serverId)
        assertEquals(3, conn.pairingProtocolVersion)
    }
}
