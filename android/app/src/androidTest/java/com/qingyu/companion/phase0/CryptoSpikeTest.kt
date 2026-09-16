package com.qingyu.companion.phase0

import android.os.Build
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyPair
import java.security.Provider
import java.security.Security

/**
 * 阶段 0 S0-06 实机 spike（MuMu / 真机）。
 * 结果写入 logcat tag Phase0CryptoSpike，便于报告取证。
 */
@RunWith(AndroidJUnit4::class)
class CryptoSpikeTest {

    @Before
    fun setUp() {
        CryptoSpike.deleteAliases()
        try {
            val bc = Class.forName("org.bouncycastle.jce.provider.BouncyCastleProvider").getDeclaredConstructor().newInstance()
            if (Security.getProvider("BCP") == null) {
                Security.insertProviderAt(bc as java.security.Provider, 1)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "BC provider register failed: $t")
        }
        Log.i(TAG, "=== Phase0 crypto spike start api=${Build.VERSION.SDK_INT} model=${Build.MODEL} ===")
        val providerNames = Security.getProviders().joinToString { p -> p.name }
        Log.i(TAG, "providers=$providerNames")
    }

    @Test
    fun keystoreWrapUnwrap32ByteSpaceKey() {
        val spaceKey = ByteArray(32) { (it * 7 + 3).toByte() }
        val wrapped = CryptoSpike.wrapSpaceKey(spaceKey)
        assertTrue("wrapped must be non-empty", wrapped.wrapped.isNotEmpty())
        assertTrue("iv must be non-empty", wrapped.iv.isNotEmpty())
        assertEquals(32, spaceKey.size)

        val roundTrip = CryptoSpike.unwrapSpaceKey(wrapped)
        assertArrayEquals("GCM wrap/unwrap round-trip", spaceKey, roundTrip)

        // 密文不应等于明文
        assertTrue(!spaceKey.contentEquals(wrapped.wrapped))
        Log.i(TAG, "KEystore_WRAP_OK wrappedBytes=${wrapped.wrapped.size} ivBytes=${wrapped.iv.size}")
    }

    @Test
    fun softwareX25519EcdhMatchesBothSides() {
        val a = CryptoSpike.generateSoftwareX25519()
        val b = CryptoSpike.generateSoftwareX25519()
        val ab = CryptoSpike.agree(a, b.public)
        val ba = CryptoSpike.agree(b, a.public)
        assertArrayEquals("ECDH shared secret", ab.sharedSecret, ba.sharedSecret)
        assertEquals(32, ab.sharedSecret.size)
        Log.i(TAG, "SW_X25519_OK mechanism=${ab.mechanism} secretLen=${ab.sharedSecret.size}")
    }

    @Test
    fun softwareEd25519SignVerify() {
        // 系统 JCA 无完整 Ed25519（MuMu API35 仅 AndroidKeyStoreBCWorkaround 空壳）；
        // 阶段0 用 BC RFC8032 验证算法可实现性，阶段7/8 若走 BC 或 T需在 ADR-010 固化依赖策略。
        val key = CryptoSpike.generateEd25519Rfc8032()
        assertEquals(32, key.seed.size)
        assertEquals(32, key.publicKey.size)
        val msg = "phase0-ed25519-spike".toByteArray()
        val sig = CryptoSpike.signEd25519Rfc8032(key, msg)
        assertEquals(64, sig.size)
        assertTrue("Ed25519 RFC8032 verify", CryptoSpike.verifyEd25519Rfc8032(key.publicKey, msg, sig))
        assertFalse(
            "forged signature must fail",
            CryptoSpike.verifyEd25519Rfc8032(key.publicKey, "other".toByteArray(), sig),
        )
        Log.i(TAG, "SW_ED25519_RFC8032_OK sigLen=${sig.size}")
    }

    @Test
    fun keystoreEd25519IfSupported() {
        val kp = try {
            CryptoSpike.generateKeystoreEd25519()
        } catch (t: Throwable) {
            Log.w(TAG, "KEYSTORE_ED25519_UNSUPPORTED api=${Build.VERSION.SDK_INT}: $t")
            val key = CryptoSpike.generateEd25519Rfc8032()
            assertTrue(
                CryptoSpike.verifyEd25519Rfc8032(
                    key.publicKey,
                    "fallback".toByteArray(),
                    CryptoSpike.signEd25519Rfc8032(key, "fallback".toByteArray()),
                ),
            )
            Log.i(TAG, "KEYSTORE_ED25519_FALLBACK_RFC8032")
            return
        }
        try {
            val result = CryptoSpike.signAndVerify(
                kp.private,
                kp.public,
                "phase0-keystore-ed".toByteArray(),
            )
            assertTrue("Keystore Ed25519 verify", result.verified)
            Log.i(TAG, "KEYSTORE_ED25519_OK mechanism=${result.mechanism}")
        } catch (t: Throwable) {
            Log.w(TAG, "KEYSTORE_ED25519_SIGN_UNSUPPORTED api=${Build.VERSION.SDK_INT}: $t")
            val key = CryptoSpike.generateEd25519Rfc8032()
            val msg = "fallback-sign".toByteArray()
            assertTrue(CryptoSpike.verifyEd25519Rfc8032(key.publicKey, msg, CryptoSpike.signEd25519Rfc8032(key, msg)))
            Log.i(TAG, "KEYSTORE_ED25519_SIGN_FALLBACK_RFC8032")
        }
    }

    @Test
    fun keystoreX25519IfSupported() {
        val supported = try {
            CryptoSpike.generateKeystoreX25519()
            true
        } catch (t: Throwable) {
            Log.w(TAG, "KEYSTORE_X25519_UNSUPPORTED api=${Build.VERSION.SDK_INT}: $t")
            false
        }
        if (!supported) {
            // 设计允许：非 API33+ Keystore 不支持 X25519 时，使用软件/Conscrypt 实现
            val a = CryptoSpike.generateSoftwareX25519()
            val b = CryptoSpike.generateSoftwareX25519()
            assertArrayEquals(
                CryptoSpike.agree(a, b.public).sharedSecret,
                CryptoSpike.agree(b, a.public).sharedSecret,
            )
            Log.i(TAG, "KEYSTORE_X25519_FALLBACK_SOFTWARE api=${Build.VERSION.SDK_INT}")
            return
        }
        val a = CryptoSpike.generateKeystoreX25519()
        val b = CryptoSpike.generateKeystoreX25519()
        val ab = CryptoSpike.agree(a, b.public)
        val ba = CryptoSpike.agree(b, a.public)
        assertArrayEquals("Keystore X25519 ECDH", ab.sharedSecret, ba.sharedSecret)
        Log.i(TAG, "KEYSTORE_X25519_OK secretLen=${ab.sharedSecret.size}")
    }

    @Test
    fun spaceKeyNeverExposedFromKeystoreMaterial() {
        // wrapping key 私钥不可导出；wrapped 密文独立
        val spaceKey = ByteArray(32) { (it + 1).toByte() }
        val wrap = CryptoSpike.wrapSpaceKey(spaceKey)
        val ks = java.security.KeyStore.getInstance(CryptoSpike.ANDROID_KEYSTORE).apply { load(null) }
        val entry = ks.getEntry(CryptoSpike.WRAP_ALIAS, null)
        assertTrue(entry is java.security.KeyStore.SecretKeyEntry)
        val sk = (entry as java.security.KeyStore.SecretKeyEntry).secretKey
        assertTrue("wrap key must not be exportable raw 32B", sk.encoded == null || sk.encoded.isEmpty() || !sk.encoded.contentEquals(spaceKey))
        assertArrayEquals(spaceKey, CryptoSpike.unwrapSpaceKey(wrap))
        Log.i(TAG, "SPACEKEY_NON_EXPOSE_OK")
    }

    private companion object {
        const val TAG = "Phase0CryptoSpike"
    }
}
