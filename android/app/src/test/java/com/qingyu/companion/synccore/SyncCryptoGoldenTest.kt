package com.qingyu.companion.synccore

import com.qingyu.companion.synccore.crypto.SyncCrypto
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/**
 * 阶段 8 S8-01/S8-02：E2EE 跨语言 golden（对齐 shared/sync-crypto/ 与
 * `shared/fixtures/cross-platform/sync-crypto/e2ee-interop.json`）。
 */
class SyncCryptoGoldenTest {

    private fun loadGolden(): Map<String, Any?> {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "shared/fixtures/cross-platform/sync-crypto")
            if (candidate.isDirectory) {
                val text = File(candidate, "e2ee-interop.json").readText()
                @Suppress("UNCHECKED_CAST")
                return SyncCrypto.normalizeJson(org.json.JSONObject(text)) as Map<String, Any?>
            }
            dir = dir.parentFile
        }
        error("找不到 sync-crypto fixture 目录")
    }

    @Suppress("UNCHECKED_CAST")
    private fun asMap(v: Any?): Map<String, Any?> = v as Map<String, Any?>

    @Test
    fun subkeysMatchGolden() {
        val g = loadGolden()
        val spaceKey = SyncCrypto.b64d(asMap(g["fixed"])["spaceKey"] as String)
        val derived = asMap(asMap(g["subkeys"])["derived"])
        for ((purpose, expected) in derived) {
            assertEquals(purpose, expected, SyncCrypto.b64e(SyncCrypto.deriveSubkey(spaceKey, purpose)))
        }
    }

    @Test
    fun entityAadCiphertextAndContentTagMatchGolden() {
        val g = loadGolden()
        val fixed = asMap(g["fixed"])
        val entity = asMap(g["entity"])
        val spaceKey = SyncCrypto.b64d(fixed["spaceKey"] as String)
        val aad = SyncCrypto.buildEntityAad(
            spaceId = fixed["spaceId"] as String,
            entityType = fixed["entityType"] as String,
            entityId = fixed["entityId"] as String,
            schemaVersion = (fixed["schemaVersion"] as Long).toInt(),
            versionHash = fixed["versionHash"] as String,
            keyEpoch = (fixed["keyEpoch"] as Long).toInt(),
            cipherRevision = (fixed["cipherRevision"] as Long).toInt(),
        )
        assertEquals(g["aadString"], aad)
        @Suppress("UNCHECKED_CAST")
        val payload = fixed["payload"] as Map<String, Any?>
        val contentHash = fixed["contentHash"] as String
        assertEquals("canonical payload", contentHash, SyncCrypto.contentHash(payload))
        val enc = SyncCrypto.encryptEntity(
            spaceKey = spaceKey,
            aad = aad,
            payload = payload,
            contentHash = contentHash,
            keyEpoch = (fixed["keyEpoch"] as Long).toInt(),
            cipherRevision = (fixed["cipherRevision"] as Long).toInt(),
            nonce = SyncCrypto.b64d(entity["nonce"] as String),
        )
        assertEquals("ciphertext", entity["ciphertext"], enc.ciphertext)
        assertEquals("cipherHash", entity["cipherHash"], enc.cipherHash)
        assertEquals("contentTag", entity["contentTag"], enc.contentTag)
        val dec = SyncCrypto.decryptAndVerifyEntity(spaceKey, aad, enc, contentHash)
        assertEquals(payload, dec)
    }

    @Test
    fun challengeProofMatchesGolden() {
        val g = loadGolden()
        val spaceKey = SyncCrypto.b64d(asMap(g["fixed"])["spaceKey"] as String)
        val challenge = asMap(g["challenge"])
        assertEquals(challenge["proof"], SyncCrypto.computeChallengeProof(spaceKey, challenge["challenge"] as String))
        assertTrue(SyncCrypto.verifyChallengeProof(spaceKey, challenge["challenge"] as String, challenge["proof"] as String))
    }

    @Test
    fun keyEnvelopeSasAndWrapKeyMatchGolden() {
        val g = loadGolden()
        val ke = asMap(g["keyEnvelope"])
        val body = asMap(ke["body"])
        val input = SyncCrypto.KeyEnvelopeTranscriptInput(
            spaceId = body["spaceId"] as String,
            keyEpoch = (body["keyEpoch"] as Long).toInt(),
            recipientDeviceId = body["recipientDeviceId"] as String,
            recipientX25519PublicKey = body["recipientX25519PublicKey"] as String,
            approverDeviceId = body["approverDeviceId"] as String,
            approverX25519PublicKey = body["approverX25519PublicKey"] as String,
            approverEd25519PublicKey = body["approverEd25519PublicKey"] as String,
            nonce = body["nonce"] as String,
            expiresAt = body["expiresAt"] as Long,
        )
        val transcript = SyncCrypto.buildKeyEnvelopeTranscript(input)
        assertEquals(ke["transcript"], transcript)
        assertEquals(ke["sas"], SyncCrypto.deriveKeyEnvelopeSas(transcript))
        assertEquals(ke["transcriptHash"], SyncCrypto.keyEnvelopeTranscriptHash(transcript))
        val wrapKey = SyncCrypto.deriveKeyEnvelopeWrapKey(
            SyncCrypto.b64d(ke["ecdhSharedSecret"] as String),
            transcript,
        )
        assertEquals(ke["wrapKey"], SyncCrypto.b64e(wrapKey))
        assertEquals(ke["wrapAad"], SyncCrypto.keyEnvelopeWrapAad(ke["transcriptHash"] as String))
    }

    @Test
    fun recoveryRoundTripAndRejects() {
        val spaceKey = ByteArray(32) { 0x11 }
        val pkg = SyncCrypto.exportRecoveryPackage(
            spaceKey = spaceKey,
            spaceId = "s1",
            keyEpoch = 1,
            passphrase = "Correct-Horse-9",
            createdAt = 1L,
            salt = ByteArray(32) { 6 },
            nonce = ByteArray(12) { 5 },
            n = SyncCrypto.RECOVERY_KDF_MIN_N,
        )
        assertTrue(pkg.rotateAfterRestore)
        val ok = SyncCrypto.importRecoveryPackage(pkg, "Correct-Horse-9", "s1")
        assertArrayEquals(spaceKey, ok.spaceKey)
        assertTrue(ok.mustRotate)
        try {
            SyncCrypto.importRecoveryPackage(pkg, "Wrong-Horse-9", "s1")
            fail("错误口令必须拒绝")
        } catch (_: SyncCrypto.SyncCryptoException) {
        }
        try {
            SyncCrypto.importRecoveryPackage(pkg, "Correct-Horse-9", "other")
            fail("跨空间必须拒绝")
        } catch (_: SyncCrypto.SyncCryptoException) {
        }
    }

    @Test
    fun weakPassphraseRejected() {
        for (p in listOf("", "short", "alllowercaseonly")) {
            try {
                SyncCrypto.assertPassphraseStrength(p)
                fail("弱口令必须拒绝: $p")
            } catch (_: SyncCrypto.SyncCryptoException) {
            }
        }
    }

    @Test
    fun tamperedEntityRejected() {
        val g = loadGolden()
        val fixed = asMap(g["fixed"])
        val entity = asMap(g["entity"])
        val spaceKey = SyncCrypto.b64d(fixed["spaceKey"] as String)
        val aad = g["aadString"] as String
        val ct = SyncCrypto.b64d(entity["ciphertext"] as String)
        ct[0] = (ct[0].toInt() xor 0xff).toByte()
        val evil = SyncCrypto.EncryptedEntity(
            keyEpoch = (fixed["keyEpoch"] as Long).toInt(),
            cipherRevision = (fixed["cipherRevision"] as Long).toInt(),
            nonce = entity["nonce"] as String,
            ciphertext = SyncCrypto.b64e(ct),
            cipherHash = entity["cipherHash"] as String,
            contentTag = entity["contentTag"] as String,
        )
        try {
            SyncCrypto.decryptEntity(spaceKey, aad, evil)
            fail("篡改密文必须拒绝")
        } catch (_: SyncCrypto.SyncCryptoException) {
        }
    }
}
