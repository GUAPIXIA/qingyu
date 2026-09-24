package com.qingyu.companion.synccore.crypto

import com.qingyu.companion.domain.contracts.CanonicalJson
import com.qingyu.companion.synccore.LanAuth
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Security
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 阶段 8 S8-01/S8-02：E2EE 原语（Kotlin）。
 *
 * 与 `shared/sync-crypto/` 逐语义对齐；golden
 * `shared/fixtures/cross-platform/sync-crypto/e2ee-interop.json`。
 *
 * 密码失败 fail closed；不得回退明文。
 */
object SyncCrypto {

    const val FORMAT_VERSION = 1
    const val SPACE_KEY_BYTES = 32
    const val GCM_NONCE_BYTES = 12
    const val GCM_TAG_BITS = 128
    const val SUBKEY_INFO_VERSION = 1
    const val BLOB_CHUNK_PLAIN_MAX = 1024 * 1024

    const val SUBKEY_SALT = "qingyu-sync-crypto/subkey/v1"
    const val ENTITY_AAD_DOMAIN = "qingyu-entity-aad/v1"
    const val BLOB_CHUNK_AAD_DOMAIN = "qingyu-blob-chunk-aad/v1"
    const val BLOB_MANIFEST_AAD_DOMAIN = "qingyu-blob-manifest-aad/v1"
    const val KEY_ENVELOPE_DOMAIN = "qingyu-key-envelope/v1"
    const val RECOVERY_AAD_DOMAIN = "qingyu-recovery-aad/v1"

    const val RECOVERY_KDF_MIN_N = 1 shl 15
    const val RECOVERY_KDF_MIN_R = 8
    const val RECOVERY_KDF_MIN_P = 1
    const val RECOVERY_KDF_DKLEN = 32
    const val RECOVERY_PASSPHRASE_MIN_LENGTH = 12

    class SyncCryptoException(val code: String, message: String) : Exception(message)

    private val b64 = Base64.getEncoder()
    private val b64d = Base64.getDecoder()

    fun b64e(bytes: ByteArray): String = b64.encodeToString(bytes)

    fun b64d(text: String): ByteArray = b64d.decode(text)

    // ---- 子密钥 ----

    fun subkeyInfo(purpose: String): String = "qingyu-sync-crypto/v$SUBKEY_INFO_VERSION|$purpose"

    fun deriveSubkey(spaceKey: ByteArray, purpose: String): ByteArray {
        require(spaceKey.size == SPACE_KEY_BYTES) {
            throw SyncCryptoException("BAD_FORMAT", "spaceKey 必须是 $SPACE_KEY_BYTES 字节")
        }
        return LanAuth.hkdfSha256(
            ikm = spaceKey,
            salt = SUBKEY_SALT.toByteArray(Charsets.UTF_8),
            info = subkeyInfo(purpose).toByteArray(Charsets.UTF_8),
            length = 32,
        )
    }

    fun hmacSha256(key: ByteArray, message: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(message)
    }

    fun computeContentTag(spaceKey: ByteArray, entityType: String, entityId: String, contentHash: String): String {
        val key = deriveSubkey(spaceKey, "content-dedupe")
        val msg = "$entityType|$entityId|$contentHash"
        return b64e(hmacSha256(key, msg.toByteArray(Charsets.UTF_8)))
    }

    fun versionHashFromCanonical(canonicalVectorJson: String): String =
        "sha256:" + LanAuth.sha256HexUtf8(canonicalVectorJson)

    // ---- 实体 ----

    fun buildEntityAad(
        spaceId: String,
        entityType: String,
        entityId: String,
        schemaVersion: Int,
        versionHash: String,
        keyEpoch: Int,
        cipherRevision: Int,
    ): String = listOf(
        ENTITY_AAD_DOMAIN,
        spaceId,
        entityType,
        entityId,
        schemaVersion.toString(),
        versionHash,
        keyEpoch.toString(),
        cipherRevision.toString(),
    ).joinToString("|")

    data class EncryptedEntity(
        val keyEpoch: Int,
        val cipherRevision: Int,
        val nonce: String,
        val ciphertext: String,
        val cipherHash: String,
        val contentTag: String,
        val contentHash: String? = null,
    )

    fun cipherHashOf(ciphertext: ByteArray): String = "sha256:" + sha256Hex(ciphertext)

    fun encryptEntity(
        spaceKey: ByteArray,
        aad: String,
        payload: Map<String, Any?>,
        contentHash: String,
        keyEpoch: Int = 1,
        cipherRevision: Int = 1,
        nonce: ByteArray? = null,
    ): EncryptedEntity {
        val key = deriveSubkey(spaceKey, "entity")
        val iv = nonce ?: SecureRandom().let { ByteArray(GCM_NONCE_BYTES).also(it::nextBytes) }
        if (iv.size != GCM_NONCE_BYTES) throw SyncCryptoException("BAD_FORMAT", "nonce 必须 12 字节")
        val plain = CanonicalJson.encode(payload).toByteArray(Charsets.UTF_8)
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
            cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
            val body = cipher.doFinal(plain)
            return EncryptedEntity(
                keyEpoch = keyEpoch,
                cipherRevision = cipherRevision,
                nonce = b64e(iv),
                ciphertext = b64e(body),
                cipherHash = cipherHashOf(body),
                contentTag = computeContentTag(spaceKey, entityTypeFromAad(aad), entityIdFromAad(aad), contentHash),
                contentHash = contentHash,
            )
        } catch (e: SyncCryptoException) {
            throw e
        } catch (_: Exception) {
            throw SyncCryptoException("FAIL_CLOSED", "实体加密失败，拒绝回退明文")
        }
    }

    /**
     * contentTag 需要 entityType/entityId；从 AAD 第 3/4 段还原（AAD 格式固定）。
     * 调用方也可直接用 computeContentTag。
     */
    private fun entityTypeFromAad(aad: String): String = aad.split('|').getOrElse(2) { "" }

    private fun entityIdFromAad(aad: String): String = aad.split('|').getOrElse(3) { "" }

    fun decryptEntity(spaceKey: ByteArray, aad: String, encrypted: EncryptedEntity): Map<String, Any?> {
        val key = deriveSubkey(spaceKey, "entity")
        val iv = b64d(encrypted.nonce)
        val ciphertext = b64d(encrypted.ciphertext)
        if (iv.size != GCM_NONCE_BYTES || ciphertext.size < GCM_TAG_BITS / 8) {
            throw SyncCryptoException("BAD_FORMAT", "密文结构非法")
        }
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
            cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
            val plain = cipher.doFinal(ciphertext)
            @Suppress("UNCHECKED_CAST")
            return normalizeJson(org.json.JSONObject(String(plain, Charsets.UTF_8))) as Map<String, Any?>
        } catch (e: SyncCryptoException) {
            throw e
        } catch (_: Exception) {
            throw SyncCryptoException("DECRYPT_FAILED", "实体解密失败（AAD/密钥/密文不匹配）")
        }
    }

    fun decryptAndVerifyEntity(
        spaceKey: ByteArray,
        aad: String,
        encrypted: EncryptedEntity,
        expectedContentHash: String,
    ): Map<String, Any?> {
        val payload = decryptEntity(spaceKey, aad, encrypted)
        val actual = contentHash(payload)
        if (actual != expectedContentHash) {
            throw SyncCryptoException("TAG_MISMATCH", "解密后 contentHash 与预期不符（安全错误）")
        }
        val parts = aad.split('|')
        val tag = computeContentTag(spaceKey, parts.getOrElse(2) { "" }, parts.getOrElse(3) { "" }, expectedContentHash)
        if (tag != encrypted.contentTag) {
            throw SyncCryptoException("TAG_MISMATCH", "contentTag 与解密结果不一致")
        }
        return payload
    }

    fun contentHash(payload: Map<String, Any?>): String = "sha256:" + LanAuth.sha256HexUtf8(CanonicalJson.encode(payload))

    // ---- key envelope ----

    data class KeyEnvelopeTranscriptInput(
        val spaceId: String,
        val keyEpoch: Int,
        val recipientDeviceId: String,
        val recipientX25519PublicKey: String,
        val approverDeviceId: String,
        val approverX25519PublicKey: String,
        val approverEd25519PublicKey: String,
        val nonce: String,
        val expiresAt: Long,
    )

    fun buildKeyEnvelopeTranscript(input: KeyEnvelopeTranscriptInput): String = CanonicalJson.encode(
        linkedMapOf(
            "domain" to KEY_ENVELOPE_DOMAIN,
            "spaceId" to input.spaceId,
            "keyEpoch" to input.keyEpoch.toLong(),
            "recipientDeviceId" to input.recipientDeviceId,
            "recipientX25519PublicKey" to input.recipientX25519PublicKey,
            "approverDeviceId" to input.approverDeviceId,
            "approverX25519PublicKey" to input.approverX25519PublicKey,
            "approverEd25519PublicKey" to input.approverEd25519PublicKey,
            "nonce" to input.nonce,
            "expiresAt" to input.expiresAt,
        ),
    )

    fun keyEnvelopeTranscriptHash(transcript: String): String = "sha256:" + LanAuth.sha256HexUtf8(transcript)

    fun deriveKeyEnvelopeSas(transcript: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(transcript.toByteArray(Charsets.UTF_8))
        val n = (((digest[0].toInt() and 0xff) shl 16) or
            ((digest[1].toInt() and 0xff) shl 8) or
            (digest[2].toInt() and 0xff)) % 1_000_000
        return n.toString().padStart(6, '0')
    }

    fun deriveKeyEnvelopeWrapKey(sharedSecret: ByteArray, transcript: String): ByteArray {
        val th = keyEnvelopeTranscriptHash(transcript)
        return LanAuth.hkdfSha256(
            ikm = sharedSecret,
            salt = KEY_ENVELOPE_DOMAIN.toByteArray(Charsets.UTF_8),
            info = "$KEY_ENVELOPE_DOMAIN|wrap|$th".toByteArray(Charsets.UTF_8),
            length = 32,
        )
    }

    fun keyEnvelopeWrapAad(transcriptHash: String): String = "$KEY_ENVELOPE_DOMAIN|wrap-aad|$transcriptHash"

    fun keyEnvelopeSigningBytes(transcript: String, body: Map<String, Any?>): ByteArray {
        val filtered = body.filterKeys { it != "signature" }
        return "$transcript\n${CanonicalJson.encode(filtered)}".toByteArray(Charsets.UTF_8)
    }

    fun computeChallengeProof(spaceKey: ByteArray, challenge: String): String {
        val key = deriveSubkey(spaceKey, "challenge")
        return b64e(hmacSha256(key, challenge.toByteArray(Charsets.UTF_8)))
    }

    fun verifyChallengeProof(spaceKey: ByteArray, challenge: String, proof: String): Boolean =
        computeChallengeProof(spaceKey, challenge) == proof

    // ---- 恢复包 ----

    fun assertPassphraseStrength(passphrase: String) {
        if (passphrase.length < RECOVERY_PASSPHRASE_MIN_LENGTH) {
            throw SyncCryptoException("WEAK_PASSPHRASE", "口令长度必须 ≥ $RECOVERY_PASSPHRASE_MIN_LENGTH")
        }
        var classes = 0
        if (passphrase.any { it in 'a'..'z' }) classes++
        if (passphrase.any { it in 'A'..'Z' }) classes++
        if (passphrase.any { it in '0'..'9' }) classes++
        if (passphrase.any { it !in 'a'..'z' && it !in 'A'..'Z' && it !in '0'..'9' }) classes++
        if (classes < 2) throw SyncCryptoException("WEAK_PASSPHRASE", "口令至少包含 2 类字符")
    }

    /** RFC 7914 scrypt——BouncyCastle SCrypt（平台无内置 scrypt）。 */
    fun scrypt(passphrase: String, salt: ByteArray, n: Int, r: Int, p: Int, dkLen: Int): ByteArray {
        if (n < RECOVERY_KDF_MIN_N || r < RECOVERY_KDF_MIN_R || p < RECOVERY_KDF_MIN_P || dkLen != RECOVERY_KDF_DKLEN || (n and (n - 1)) != 0) {
            throw SyncCryptoException("BAD_KDF_PARAMS", "恢复包 KDF 参数低于最低要求或非法")
        }
        return try {
            org.bouncycastle.crypto.generators.SCrypt.generate(
                passphrase.toByteArray(Charsets.UTF_8),
                salt,
                n,
                r,
                p,
                dkLen,
            )
        } catch (e: SyncCryptoException) {
            throw e
        } catch (e: Exception) {
            throw SyncCryptoException("FAIL_CLOSED", "scrypt 失败：${e.message}")
        }
    }

    fun recoveryAad(spaceId: String, keyEpoch: Int): String = "$RECOVERY_AAD_DOMAIN|$spaceId|$keyEpoch"

    data class RecoveryPackage(
        val formatVersion: Int,
        val kind: String,
        val spaceId: String,
        val keyEpoch: Int,
        val kdfAlgorithm: String,
        val kdfN: Int,
        val kdfR: Int,
        val kdfP: Int,
        val kdfSalt: String,
        val kdfDkLen: Int,
        val nonce: String,
        val ciphertext: String,
        val createdAt: Long,
        val rotateAfterRestore: Boolean = true,
    )

    fun exportRecoveryPackage(
        spaceKey: ByteArray,
        spaceId: String,
        keyEpoch: Int,
        passphrase: String,
        createdAt: Long,
        salt: ByteArray? = null,
        nonce: ByteArray? = null,
        n: Int = 1 shl 18,
        r: Int = 8,
        p: Int = 1,
    ): RecoveryPackage {
        assertPassphraseStrength(passphrase)
        if (spaceKey.size != SPACE_KEY_BYTES) throw SyncCryptoException("BAD_FORMAT", "spaceKey 必须 32 字节")
        val saltBytes = salt ?: SecureRandom().let { ByteArray(32).also(it::nextBytes) }
        val iv = nonce ?: SecureRandom().let { ByteArray(GCM_NONCE_BYTES).also(it::nextBytes) }
        val key = scrypt(passphrase, saltBytes, n, r, p, RECOVERY_KDF_DKLEN)
        val aad = recoveryAad(spaceId, keyEpoch)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
        cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
        val body = cipher.doFinal(spaceKey)
        return RecoveryPackage(
            formatVersion = FORMAT_VERSION,
            kind = "qingyu-space-key-recovery",
            spaceId = spaceId,
            keyEpoch = keyEpoch,
            kdfAlgorithm = "scrypt",
            kdfN = n,
            kdfR = r,
            kdfP = p,
            kdfSalt = b64e(saltBytes),
            kdfDkLen = RECOVERY_KDF_DKLEN,
            nonce = b64e(iv),
            ciphertext = b64e(body),
            createdAt = createdAt,
            rotateAfterRestore = true,
        )
    }

    data class ImportResult(val spaceKey: ByteArray, val keyEpoch: Int, val mustRotate: Boolean = true)

    fun importRecoveryPackage(
        pkg: RecoveryPackage,
        passphrase: String,
        expectedSpaceId: String?,
    ): ImportResult {
        if (pkg.formatVersion != FORMAT_VERSION || pkg.kind != "qingyu-space-key-recovery") {
            throw SyncCryptoException("BAD_FORMAT", "恢复包格式不支持")
        }
        if (pkg.kdfAlgorithm != "scrypt" || pkg.kdfDkLen != RECOVERY_KDF_DKLEN) {
            throw SyncCryptoException("BAD_KDF_PARAMS", "恢复包 KDF 算法/长度非法")
        }
        if (pkg.kdfN < RECOVERY_KDF_MIN_N || pkg.kdfR < RECOVERY_KDF_MIN_R || pkg.kdfP < RECOVERY_KDF_MIN_P) {
            throw SyncCryptoException("BAD_KDF_PARAMS", "恢复包 KDF 参数被降级，拒绝导入")
        }
        if (expectedSpaceId != null && pkg.spaceId != expectedSpaceId) {
            throw SyncCryptoException("CROSS_SPACE", "恢复包属于其他空间")
        }
        val key = scrypt(passphrase, b64d(pkg.kdfSalt), pkg.kdfN, pkg.kdfR, pkg.kdfP, pkg.kdfDkLen)
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_BITS, b64d(pkg.nonce)))
            cipher.updateAAD(recoveryAad(pkg.spaceId, pkg.keyEpoch).toByteArray(Charsets.UTF_8))
            val plain = cipher.doFinal(b64d(pkg.ciphertext))
            if (plain.size != SPACE_KEY_BYTES) throw SyncCryptoException("BAD_FORMAT", "恢复出的 spaceKey 长度非法")
            return ImportResult(plain, pkg.keyEpoch, true)
        } catch (e: SyncCryptoException) {
            throw e
        } catch (_: Exception) {
            throw SyncCryptoException("DECRYPT_FAILED", "恢复包口令错误或数据被篡改")
        }
    }

    // ---- helpers ----

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** org.json → 纯 Map/List（与 CanonicalJson 兼容；Int/Long 归一为 Long） */
    fun normalizeJson(value: Any?): Any? = when (value) {
        null, org.json.JSONObject.NULL -> null
        is org.json.JSONObject -> {
            val map = LinkedHashMap<String, Any?>()
            for (key in value.keys()) map[key] = normalizeJson(value.get(key))
            map
        }
        is org.json.JSONArray -> (0 until value.length()).map { normalizeJson(value.get(it)) }
        is Int -> value.toLong()
        is Long -> value
        else -> value
    }

    /** 生产路径优先自带 BC provider（阶段 3 结论） */
    fun ensureBcProvider(): java.security.Provider? {
        val existing = Security.getProvider("BC")
        // 只在实例可用时补充注册（名字冲突时保留已有）
        return try {
            val p = org.bouncycastle.jce.provider.BouncyCastleProvider()
            if (existing == null) Security.insertProviderAt(p, 1)
            p
        } catch (_: Exception) {
            existing
        }
    }
}
