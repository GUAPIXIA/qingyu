package com.qingyu.companion.synccore

import com.qingyu.companion.domain.contracts.CanonicalJson
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * 阶段 7 S7-03：LAN 一次性授权纯逻辑（Kotlin 侧）。
 *
 * 与 `shared/sync-core/lanAuth.ts` 逐语义对齐；同一 golden
 * `shared/fixtures/cross-platform/sync-core/lanAuth.json`。
 * 禁止访问网络、磁盘、时钟和随机数——密钥/secret/now 由调用方注入。
 */
object LanAuth {

    const val AUTH_TTL_MS = 5 * 60 * 1000L
    const val SCOPE = "sync"
    const val QR_VERSION = 1
    const val QR_SCHEME = "qingyu-sync-auth"
    const val TRANSCRIPT_DOMAIN = "qingyu-sync-auth/v1"

    data class TranscriptInput(
        val sessionId: String,
        val host: String,
        val port: Int,
        val fingerprint: String,
        val expiresAt: Long,
        val secret: String,
        val pcPublicKey: String,
        val androidPublicKey: String,
        val protocolVersion: Int = QR_VERSION,
        val scope: String = SCOPE,
    )

    data class SessionKeys(val sessionKey: String, val macKey: String)

    /** 完整 transcript 的规范字符串（两端逐字节一致） */
    fun buildTranscript(input: TranscriptInput): String = CanonicalJson.encode(
        linkedMapOf(
            "domain" to TRANSCRIPT_DOMAIN,
            "protocolVersion" to input.protocolVersion.toLong(),
            "scope" to input.scope,
            "sessionId" to input.sessionId,
            "host" to input.host,
            "port" to input.port.toLong(),
            "fingerprint" to input.fingerprint,
            "expiresAt" to input.expiresAt,
            "secret" to input.secret,
            "pcPublicKey" to input.pcPublicKey,
            "androidPublicKey" to input.androidPublicKey,
        ),
    )

    fun transcriptHash(transcript: String): String = sha256HexUtf8(transcript)

    /** 短认证串：SHA-256(transcript) 前 3 字节 → 6 位十进制 */
    fun shortAuthString(transcript: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(transcript.toByteArray(Charsets.UTF_8))
        val n = (((digest[0].toInt() and 0xff) shl 16) or
            ((digest[1].toInt() and 0xff) shl 8) or
            (digest[2].toInt() and 0xff)) % 1_000_000
        return n.toString().padStart(6, '0')
    }

    /** HKDF-SHA256 会话密钥（salt=域常量，info 含 transcriptHash） */
    fun deriveSessionKeys(sharedSecret: ByteArray, transcript: String): SessionKeys {
        val th = transcriptHash(transcript)
        val salt = TRANSCRIPT_DOMAIN.toByteArray(Charsets.UTF_8)
        val sessionKey = hkdfSha256(sharedSecret, salt, "session-key|$th".toByteArray(Charsets.UTF_8), 32)
        val macKey = hkdfSha256(sharedSecret, salt, "mac-key|$th".toByteArray(Charsets.UTF_8), 32)
        return SessionKeys(
            sessionKey = java.util.Base64.getEncoder().encodeToString(sessionKey),
            macKey = java.util.Base64.getEncoder().encodeToString(macKey),
        )
    }

    /** RFC 5869 HKDF-SHA256 */
    fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val prk = hmacSha256(salt, ikm)
        var t = ByteArray(0)
        val okm = ByteArray(length)
        var offset = 0
        var counter = 1
        while (offset < length) {
            val input = t + info + byteArrayOf(counter.toByte())
            t = hmacSha256(prk, input)
            val copy = minOf(t.size, length - offset)
            System.arraycopy(t, 0, okm, offset, copy)
            offset += copy
            counter++
        }
        return okm
    }

    private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        // 空 salt 时 RFC 5869 允许零长度 key；Mac 对 0 长 key 可能拒绝，用单零字节等价处理
        val keySpec = if (key.isEmpty()) SecretKeySpec(ByteArray(32), "HmacSHA256") else SecretKeySpec(key, "HmacSHA256")
        mac.init(keySpec)
        return mac.doFinal(data)
    }

    fun sha256HexUtf8(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    data class QrPayload(
        val version: Int,
        val scheme: String,
        val protocolVersion: Int,
        val host: String,
        val port: Int,
        val sessionId: String,
        val pcPublicKey: String,
        val secret: String,
        val expiresAt: Long,
        val fingerprint: String,
        val displayName: String,
        val scope: String,
    )

    sealed class ParsedQr {
        data class Ok(val payload: QrPayload) : ParsedQr()
        data class Invalid(val reason: String) : ParsedQr()
    }

    /** 解析 QR JSON；`now` 注入。过期必须拒绝。 */
    fun parseQr(raw: String, now: Long): ParsedQr {
        val obj = try {
            org.json.JSONObject(raw)
        } catch (_: Exception) {
            return ParsedQr.Invalid("not_json")
        }
        if (obj.optString("scheme") != QR_SCHEME) return ParsedQr.Invalid("unknown_scheme")
        if (obj.optInt("version", -1) != QR_VERSION) return ParsedQr.Invalid("unsupported_version")
        val sessionId = obj.optString("sessionId")
        if (sessionId.isNullOrEmpty()) return ParsedQr.Invalid("missing_sessionId")
        val pcPublicKey = obj.optString("pcPublicKey")
        if (pcPublicKey.isNullOrEmpty()) return ParsedQr.Invalid("missing_pcPublicKey")
        val secret = obj.optString("secret")
        if (secret.isNullOrEmpty()) return ParsedQr.Invalid("missing_secret")
        val host = obj.optString("host")
        val port = obj.optInt("port", -1)
        if (host.isNullOrEmpty() || port <= 0) return ParsedQr.Invalid("missing_endpoints")
        if (obj.optString("scope") != SCOPE) return ParsedQr.Invalid("bad_scope")
        val expiresAt = obj.optLong("expiresAt", Long.MIN_VALUE)
        if (expiresAt <= now) return ParsedQr.Invalid("expired")
        return ParsedQr.Ok(
            QrPayload(
                version = QR_VERSION,
                scheme = QR_SCHEME,
                protocolVersion = obj.optInt("protocolVersion", QR_VERSION),
                host = host,
                port = port,
                sessionId = sessionId,
                pcPublicKey = pcPublicKey,
                secret = secret,
                expiresAt = expiresAt,
                fingerprint = obj.optString("fingerprint"),
                displayName = obj.optString("displayName"),
                scope = SCOPE,
            ),
        )
    }
}
