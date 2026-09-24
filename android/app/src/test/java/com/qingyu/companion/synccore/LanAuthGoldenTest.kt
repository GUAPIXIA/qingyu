package com.qingyu.companion.synccore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 阶段 7 S7-03：LanAuth 跨语言 golden 比对（对齐 shared/sync-core/lanAuth.ts）。
 */
class LanAuthGoldenTest {

    private fun loadGolden(): Map<String, Any?> {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "shared/fixtures/cross-platform/sync-core")
            if (candidate.isDirectory) {
                val text = File(candidate, "lanAuth.json").readText()
                @Suppress("UNCHECKED_CAST")
                return normalize(org.json.JSONObject(text)) as Map<String, Any?>
            }
            dir = dir.parentFile
        }
        error("找不到 sync-core fixture 目录")
    }

    private fun normalize(value: Any?): Any? = when (value) {
        null, org.json.JSONObject.NULL -> null
        is org.json.JSONObject -> {
            val map = LinkedHashMap<String, Any?>()
            for (key in value.keys()) map[key] = normalize(value.get(key))
            map
        }
        is org.json.JSONArray -> (0 until value.length()).map { normalize(value.get(it)) }
        is Int -> value.toLong()
        is Long -> value
        else -> value
    }

    @Suppress("UNCHECKED_CAST")
    private fun asMap(value: Any?): Map<String, Any?> = value as Map<String, Any?>

    private fun baseInput(sessionId: String = "sess-lan-001") = LanAuth.TranscriptInput(
        sessionId = sessionId,
        host = "192.168.1.8",
        port = 8321,
        fingerprint = "fp-abc123",
        expiresAt = 1_788_000_600_000L,
        secret = "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=",
        pcPublicKey = "ERERERERERERERERERERERERERERERERERERERERERE=",
        androidPublicKey = "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
    )

    @Test
    fun transcriptHashShortAuthAndKeysMatchGolden() {
        val g = loadGolden()
        val transcript = LanAuth.buildTranscript(baseInput())
        assertEquals("transcript", g["transcript"], transcript)
        assertEquals("transcriptHash", g["transcriptHash"], LanAuth.transcriptHash(transcript))
        assertEquals("shortAuth", g["shortAuth"], LanAuth.shortAuthString(transcript))

        val shared = ByteArray(32) { 0x55 }
        val keys = LanAuth.deriveSessionKeys(shared, transcript)
        val expectedKeys = asMap(g["keys"])
        assertEquals("sessionKey", expectedKeys["sessionKey"], keys.sessionKey)
        assertEquals("macKey", expectedKeys["macKey"], keys.macKey)

        assertEquals("shortAuthSessionB", g["shortAuthSessionB"], LanAuth.shortAuthString(LanAuth.buildTranscript(baseInput("sess-lan-002"))))
    }

    @Test
    fun parseQrMatchesGolden() {
        val g = loadGolden()
        val qr = asMap(g["qr"])
        val raw = org.json.JSONObject(qr as Map<*, *>).toString()
        val now = 1_788_000_300_000L
        val ok = LanAuth.parseQr(raw, now)
        assertTrue(ok is LanAuth.ParsedQr.Ok)
        ok as LanAuth.ParsedQr.Ok
        assertEquals("sess-lan-001", ok.payload.sessionId)
        assertEquals(LanAuth.SCOPE, ok.payload.scope)
        assertEquals("expired", (LanAuth.parseQr(org.json.JSONObject(qr).put("expiresAt", now).toString(), now) as LanAuth.ParsedQr.Invalid).reason)
    }

    @Test
    fun bindingFieldsChangeShortAuth() {
        val base = LanAuth.shortAuthString(LanAuth.buildTranscript(baseInput()))
        val variants = listOf(
            baseInput().copy(sessionId = "other"),
            baseInput().copy(host = "10.0.0.1"),
            baseInput().copy(port = 9999),
            baseInput().copy(fingerprint = "fp-zzz"),
            baseInput().copy(expiresAt = 1L),
            baseInput().copy(secret = "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6t="),
            baseInput().copy(pcPublicKey = "ERERERERERERERERERERERERERERERERERERERERERF="),
            baseInput().copy(androidPublicKey = "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiJ="),
        )
        for (v in variants) {
            assertNotEquals(base, LanAuth.shortAuthString(LanAuth.buildTranscript(v)))
        }
    }
}
