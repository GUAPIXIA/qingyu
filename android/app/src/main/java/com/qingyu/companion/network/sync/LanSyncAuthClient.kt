package com.qingyu.companion.network.sync

import com.qingyu.companion.synccore.LanAuth
import org.json.JSONObject
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PublicKey
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.KeyAgreement

/**
 * S7-05：LAN 一次性授权客户端（扫码 → hello → 核对短认证串 → 会话密钥）。
 *
 * - 解析 `qingyu-sync-auth` QR；
 * - 生成临时 X25519；与 PC 公钥 ECDH；
 * - 派生短认证串（两端同源）并 POST `/sync/v1/auth/hello`；
 * - PC 用户确认后 `pollAuthStatus` 可见 confirmed，再 `deriveSessionKeys`。
 *
 * 不复用 Bridge JWT；私钥仅存内存，`destroy()` 后清空。
 */
class LanSyncAuthClient(
    private val engine: SyncHttpEngine = OkHttpSyncEngine(),
    private val deviceName: String = "Android",
) {
    private var keyPair: KeyPair? = null
    private var qr: LanAuth.QrPayload? = null
    private var androidPublicKeyB64: String? = null
    private var shortAuth: String? = null

    fun shortAuth(): String? = shortAuth

    fun qrPayload(): LanAuth.QrPayload? = qr

    /** 解析扫码 JSON；过期/非法返回 null */
    fun parseQr(raw: String, now: Long = System.currentTimeMillis()): LanAuth.QrPayload? {
        val parsed = LanAuth.parseQr(raw, now)
        return (parsed as? LanAuth.ParsedQr.Ok)?.payload
    }

    /**
     * 从 QR 启动握手：生成临时密钥、算短认证串、提交 hello。
     * 返回本地短认证串（与 PC 显示同一数值）。
     */
    fun startHandshake(payload: LanAuth.QrPayload): SyncTransportResult<String> {
        val kp = generateX25519()
        keyPair = kp
        qr = payload
        val pub = rawPublicKey(kp.public)
        androidPublicKeyB64 = pub
        val transcript = LanAuth.buildTranscript(
            LanAuth.TranscriptInput(
                sessionId = payload.sessionId,
                host = payload.host,
                port = payload.port,
                fingerprint = payload.fingerprint,
                expiresAt = payload.expiresAt,
                secret = payload.secret,
                pcPublicKey = payload.pcPublicKey,
                androidPublicKey = pub,
            ),
        )
        val code = LanAuth.shortAuthString(transcript)
        shortAuth = code

        val url = baseUrlOf(payload) + "/auth/hello"
        val body = JSONObject()
            .put("sessionId", payload.sessionId)
            .put("deviceName", deviceName)
            .put("androidPublicKey", pub)
            .toString()
        return try {
            val res = engine.request("POST", url, mapOf("content-type" to "application/json"), body)
            when {
                res.statusCode in 200..299 -> SyncTransportResult.Ok(code)
                res.statusCode == 503 -> SyncTransportResult.Fail("sync_dormant", retryable = true)
                else -> SyncTransportResult.Fail("hello_http_${res.statusCode}", retryable = res.statusCode >= 500)
            }
        } catch (e: Exception) {
            SyncTransportResult.Fail("hello_network", retryable = true, message = e.message ?: "")
        }
    }

    /** 轮询 PC 是否已确认（用户核对短认证串后） */
    fun pollAuthStatus(): SyncTransportResult<Boolean> {
        val payload = qr ?: return SyncTransportResult.Fail("no_qr", retryable = false)
        val url = baseUrlOf(payload) + "/auth/status"
        return try {
            val res = engine.request("GET", url, emptyMap(), null)
            if (res.statusCode !in 200..299) {
                return SyncTransportResult.Fail("status_http_${res.statusCode}", retryable = res.statusCode >= 500 || res.statusCode == 503)
            }
            val json = JSONObject(res.body)
            SyncTransportResult.Ok(json.optBoolean("confirmed", false))
        } catch (e: Exception) {
            SyncTransportResult.Fail("status_network", retryable = true, message = e.message ?: "")
        }
    }

    /** PC 确认后派生会话密钥（ECDH + HKDF） */
    fun deriveSessionKeys(): SyncTransportResult<LanAuth.SessionKeys> {
        val payload = qr ?: return SyncTransportResult.Fail("no_qr", retryable = false)
        val kp = keyPair ?: return SyncTransportResult.Fail("no_keypair", retryable = false)
        val androidPub = androidPublicKeyB64 ?: return SyncTransportResult.Fail("no_pub", retryable = false)
        val pcPub = publicKeyFromRaw(Base64.getDecoder().decode(payload.pcPublicKey))
        val shared = ecdh(kp, pcPub)
        val transcript = LanAuth.buildTranscript(
            LanAuth.TranscriptInput(
                sessionId = payload.sessionId,
                host = payload.host,
                port = payload.port,
                fingerprint = payload.fingerprint,
                expiresAt = payload.expiresAt,
                secret = payload.secret,
                pcPublicKey = payload.pcPublicKey,
                androidPublicKey = androidPub,
            ),
        )
        return SyncTransportResult.Ok(LanAuth.deriveSessionKeys(shared, transcript))
    }

    /** 打开 /sync/v1/session（需已确认） */
    fun openSyncSession(): SyncTransportResult<SyncSessionHandle> {
        val payload = qr ?: return SyncTransportResult.Fail("no_qr", retryable = false)
        val endpoint = SyncEndpoint(
            host = payload.host,
            port = payload.port,
            fingerprint = payload.fingerprint,
        )
        val transport = LanSyncTransport(engine)
        return transport.openSession(endpoint)
    }

    fun destroy() {
        keyPair = null
        qr = null
        androidPublicKeyB64 = null
        shortAuth = null
    }

    private fun baseUrlOf(payload: LanAuth.QrPayload): String {
        val host = if (payload.host.contains(':')) "[${payload.host}]" else payload.host
        return "http://${host}:${payload.port}/sync/v1"
    }

    companion object {
        fun generateX25519(): KeyPair {
            val kpg = KeyPairGenerator.getInstance("X25519")
            return kpg.generateKeyPair()
        }

        fun rawPublicKey(publicKey: PublicKey): String {
            val der = publicKey.encoded
            // SPKI X25519 = 12 字节前缀 + 32 字节 raw
            val raw = if (der.size >= 32) der.copyOfRange(der.size - 32, der.size) else der
            return Base64.getEncoder().withoutPadding().encodeToString(raw)
        }

        fun publicKeyFromRaw(raw32: ByteArray): PublicKey {
            val spkiPrefix = byteArrayOf(
                0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
            )
            val spki = spkiPrefix + raw32
            return KeyFactory.getInstance("X25519").generatePublic(X509EncodedKeySpec(spki))
        }

        fun ecdh(keyPair: KeyPair, peerPublic: PublicKey): ByteArray {
            val ka = KeyAgreement.getInstance("X25519")
            ka.init(keyPair.private)
            ka.doPhase(peerPublic, true)
            return ka.generateSecret()
        }
    }
}
