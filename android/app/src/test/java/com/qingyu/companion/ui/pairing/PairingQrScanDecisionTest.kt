package com.qingyu.companion.ui.pairing

import com.qingyu.companion.R
import com.qingyu.companion.model.PairingQrInvalidReason
import com.qingyu.companion.network.NetworkModule
import com.qingyu.companion.network.connection.TransportSecurity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 扫码三分支决策（D-02/D-03）纯函数单测：
 * v2 成功（首个 endpoint 填连接字段 + 候选/元数据齐全）/ legacy 回退 / 无效拒绝（含文案映射）。
 */
class PairingQrScanDecisionTest {

    private val json = NetworkModule.json
    private val now = 1_700_000_000_000L

    @Test
    fun `v2 二维码解析为 V2 决策并映射候选端点与元数据`() {
        val raw = """
            {"version":2,"scheme":"qingyu-pair","serverId":"srv-1","displayName":"测试PC",
             "apiVersion":1,"capabilities":["settings_snapshot_v2","settings_events_v1"],
             "pairingCode":"code-123","expiresAt":1799999999999,
             "endpoints":[{"host":"192.168.1.10","port":8321,"security":"LOCAL_CLEARTEXT"},
                          {"host":"qingyu.local","port":8322}]}
        """.trimIndent()

        val decision = decideQrScan(raw, json, now) as QrScanDecision.V2

        // 首个可用 endpoint 填连接字段
        assertEquals("192.168.1.10", decision.host)
        assertEquals(8321, decision.port)
        assertEquals("code-123", decision.pairingCode)
        // 全部候选端点规范化入库（顺序保持）
        assertEquals(2, decision.endpoints.size)
        assertEquals(TransportSecurity.LOCAL_CLEARTEXT, decision.endpoints[0].security)
        assertEquals(8322, decision.endpoints[1].port)
        // 元数据
        assertEquals("srv-1", decision.serverId)
        assertEquals(setOf("settings_snapshot_v2", "settings_events_v1"), decision.capabilities)
        assertEquals(1799999999999L, decision.expiresAt)
        assertEquals("测试PC", decision.displayName)
    }

    @Test
    fun `expiresAt 为 0 表示不过期`() {
        val raw = """
            {"version":2,"scheme":"qingyu-pair","pairingCode":"c","expiresAt":0,
             "endpoints":[{"host":"127.0.0.1","port":8321}]}
        """.trimIndent()

        assertTrue(decideQrScan(raw, json, now) is QrScanDecision.V2)
    }

    @Test
    fun `v2 声明 LOCAL_CLEARTEXT 的公网地址按安全不变量转 TLS_SYSTEM`() {
        val raw = """
            {"version":2,"scheme":"qingyu-pair","pairingCode":"c","expiresAt":0,
             "endpoints":[{"host":"8.8.8.8","port":443,"security":"LOCAL_CLEARTEXT"}]}
        """.trimIndent()

        val decision = decideQrScan(raw, json, now) as QrScanDecision.V2

        assertEquals(TransportSecurity.TLS_SYSTEM, decision.endpoints.single().security)
        assertEquals("8.8.8.8", decision.host)
        assertEquals(443, decision.port)
    }

    @Test
    fun `旧格式二维码回退 Legacy 且 fingerprint 兼任配对码`() {
        val decision = decideQrScan("""{"host":"10.0.0.2","port":8321,"fingerprint":"fp-pc"}""", json, now)

        decision as QrScanDecision.Legacy
        assertEquals("10.0.0.2", decision.host)
        assertEquals(8321, decision.port)
        assertEquals("fp-pc", decision.pairingCode)
    }

    @Test
    fun `无效二维码拒绝并携带原因`() {
        fun reject(raw: String, expected: PairingQrInvalidReason): QrScanDecision.Rejected {
            val decision = decideQrScan(raw, json, now)
            assertEquals(expected, (decision as QrScanDecision.Rejected).reason)
            return decision
        }

        reject("not-json", PairingQrInvalidReason.NOT_JSON)
        // 未来版本明确拒绝，不误当旧格式
        reject("""{"version":3,"scheme":"qingyu-pair"}""", PairingQrInvalidReason.VERSION_UNSUPPORTED)
        // scheme 不匹配
        reject(
            """{"version":2,"scheme":"other","pairingCode":"c","endpoints":[{"host":"127.0.0.1","port":8321}]}""",
            PairingQrInvalidReason.SCHEME_MISMATCH,
        )
        // 已过期（0 < expiresAt < now）
        reject(
            """{"version":2,"scheme":"qingyu-pair","pairingCode":"c","expiresAt":1699000000000,
                "endpoints":[{"host":"127.0.0.1","port":8321}]}""",
            PairingQrInvalidReason.EXPIRED,
        )
        // 无可用端点（端口越界）
        reject(
            """{"version":2,"scheme":"qingyu-pair","pairingCode":"c","expiresAt":0,
                "endpoints":[{"host":"127.0.0.1","port":70000}]}""",
            PairingQrInvalidReason.NO_VALID_ENDPOINT,
        )
        // 缺配对码
        reject(
            """{"version":2,"scheme":"qingyu-pair","pairingCode":"","expiresAt":0,
                "endpoints":[{"host":"127.0.0.1","port":8321}]}""",
            PairingQrInvalidReason.MISSING_PAIRING_CODE,
        )
        // 旧格式但字段残缺
        reject("""{"port":8321,"fingerprint":"x"}""", PairingQrInvalidReason.LEGACY_INCOMPLETE)
    }

    @Test
    fun `拒绝原因映射 strings xml 文案`() {
        assertEquals(
            R.string.pairing_qr_invalid,
            PairingQrInvalidReason.NOT_JSON.errorResId(),
        )
        assertEquals(
            R.string.pairing_qr_invalid,
            PairingQrInvalidReason.LEGACY_INCOMPLETE.errorResId(),
        )
        assertEquals(
            R.string.pairing_qr_version_unsupported,
            PairingQrInvalidReason.VERSION_UNSUPPORTED.errorResId(),
        )
        assertEquals(
            R.string.pairing_qr_scheme_mismatch,
            PairingQrInvalidReason.SCHEME_MISMATCH.errorResId(),
        )
        assertEquals(R.string.pairing_qr_expired, PairingQrInvalidReason.EXPIRED.errorResId())
        assertEquals(
            R.string.pairing_qr_no_endpoint,
            PairingQrInvalidReason.NO_VALID_ENDPOINT.errorResId(),
        )
        assertEquals(
            R.string.pairing_qr_missing_code,
            PairingQrInvalidReason.MISSING_PAIRING_CODE.errorResId(),
        )
    }

    @Test
    fun `v2 serverId 为空时决策不携带 serverId`() {
        val raw = """
            {"version":2,"scheme":"qingyu-pair","serverId":"","pairingCode":"c","expiresAt":0,
             "endpoints":[{"host":"127.0.0.1","port":8321}]}
        """.trimIndent()

        val decision = decideQrScan(raw, json, now) as QrScanDecision.V2

        assertNull(decision.serverId)
        assertTrue(decision.capabilities.isEmpty())
    }
}
