package com.qingyu.companion.model

import com.qingyu.companion.network.NetworkModule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** QR v2 解析测试（方案 §8 D-02/D-03：新旧格式兼容 + 逐项校验） */
class PairingQrV2Test {

    private val json = NetworkModule.json
    private val now = 1_788_000_000_000L

    private fun v2Json(
        version: String = "2",
        scheme: String = "\"qingyu-pair\"",
        expiresAt: String = (now + 300_000).toString(),
        endpoints: String = """[{"host":"192.168.1.8","port":8321,"security":"LOCAL_CLEARTEXT"}]""",
        pairingCode: String = "\"one-time-code\"",
    ) = """
        {
          "version": $version,
          "scheme": $scheme,
          "serverId": "uuid-1",
          "displayName": "我的电脑",
          "apiVersion": 1,
          "capabilities": ["settings_snapshot_v2", "task_events_v2"],
          "pairingCode": $pairingCode,
          "expiresAt": $expiresAt,
          "endpoints": $endpoints,
          "certificatePin": null
        }
    """.trimIndent()

    @Test
    fun `v2 完整载荷解析成功`() {
        val result = parsePairingQr(v2Json(), json, now)
        assertTrue(result is PairingQrResult.V2)
        val p = (result as PairingQrResult.V2).payload
        assertEquals("uuid-1", p.serverId)
        assertEquals("我的电脑", p.displayName)
        assertTrue("settings_snapshot_v2" in p.capabilities)
        assertEquals("192.168.1.8", p.firstUsableEndpoint()?.host)
        assertEquals(8321, p.firstUsableEndpoint()?.port)
        assertEquals("one-time-code", p.pairingCode)
    }

    @Test
    fun `旧格式 host-port-fingerprint 按 legacy 解析`() {
        val raw = """{"host":"10.0.0.5","port":8321,"fingerprint":"aa:bb"}"""
        val result = parsePairingQr(raw, json, now)
        assertTrue(result is PairingQrResult.Legacy)
        assertEquals("10.0.0.5", (result as PairingQrResult.Legacy).payload.host)
    }

    @Test
    fun `非 JSON 输入 Invalid`() {
        val result = parsePairingQr("not-json", json, now)
        assertTrue(result is PairingQrResult.Invalid)
        assertEquals(PairingQrInvalidReason.NOT_JSON, (result as PairingQrResult.Invalid).reason)
    }

    @Test
    fun `不支持的 version 拒绝而非误判 legacy`() {
        val result = parsePairingQr(v2Json(version = "3"), json, now)
        assertEquals(PairingQrInvalidReason.VERSION_UNSUPPORTED, (result as PairingQrResult.Invalid).reason)
    }

    @Test
    fun `scheme 不匹配拒绝`() {
        val result = parsePairingQr(v2Json(scheme = "\"other\""), json, now)
        assertEquals(PairingQrInvalidReason.SCHEME_MISMATCH, (result as PairingQrResult.Invalid).reason)
    }

    @Test
    fun `过期二维码拒绝`() {
        val result = parsePairingQr(v2Json(expiresAt = (now - 1).toString()), json, now)
        assertEquals(PairingQrInvalidReason.EXPIRED, (result as PairingQrResult.Invalid).reason)
    }

    @Test
    fun `expiresAt 为 0 视为不过期`() {
        val result = parsePairingQr(v2Json(expiresAt = "0"), json, now)
        assertTrue(result is PairingQrResult.V2)
    }

    @Test
    fun `无有效 endpoint 拒绝（host 空或端口越界）`() {
        val badHost = v2Json(endpoints = """[{"host":"","port":8321}]""")
        assertEquals(
            PairingQrInvalidReason.NO_VALID_ENDPOINT,
            (parsePairingQr(badHost, json, now) as PairingQrResult.Invalid).reason,
        )
        val badPort = v2Json(endpoints = """[{"host":"1.2.3.4","port":0}]""")
        assertEquals(
            PairingQrInvalidReason.NO_VALID_ENDPOINT,
            (parsePairingQr(badPort, json, now) as PairingQrResult.Invalid).reason,
        )
    }

    @Test
    fun `pairingCode 缺失拒绝`() {
        val result = parsePairingQr(v2Json(pairingCode = "\"\""), json, now)
        assertEquals(PairingQrInvalidReason.MISSING_PAIRING_CODE, (result as PairingQrResult.Invalid).reason)
    }

    @Test
    fun `多 endpoint 取第一个可用并跳过脏项`() {
        val raw = v2Json(
            endpoints = """[{"host":"","port":1},{"host":"192.168.1.9","port":8322,"security":"TLS_SYSTEM"}]""",
        )
        val p = (parsePairingQr(raw, json, now) as PairingQrResult.V2).payload
        assertEquals("192.168.1.9", p.firstUsableEndpoint()?.host)
        assertEquals(8322, p.firstUsableEndpoint()?.port)
    }

    @Test
    fun `旧格式字段不全归为 LEGACY_INCOMPLETE`() {
        val result = parsePairingQr("""{"host":"1.2.3.4"}""", json, now)
        assertTrue(result is PairingQrResult.Invalid)
        assertEquals(PairingQrInvalidReason.LEGACY_INCOMPLETE, (result as PairingQrResult.Invalid).reason)
    }
}
