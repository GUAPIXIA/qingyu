package com.qingyu.companion.phase0

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyPair
import java.security.KeyStore
import java.security.NoSuchAlgorithmException
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Security
import java.security.Signature
import java.security.spec.NamedParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 阶段 0 S0-06 技术 spike：仅 androidTest，不进入生产路径。
 * 验证：Keystore wrapping key 加密封存 32 字节 spaceKey；X25519 ECDH + Ed25519 签名互操作。
 */
object CryptoSpike {

    const val ANDROID_KEYSTORE = "AndroidKeyStore"
    const val WRAP_ALIAS = "phase0_spacekey_wrap_spike"
    const val X25519_ALIAS = "phase0_x25519_spike"
    const val ED25519_ALIAS = "phase0_ed25519_spike"
    const val GCM_TAG_BITS = 128

    data class WrapResult(
        val wrapped: ByteArray,
        val iv: ByteArray,
        val apiLevel: Int = Build.VERSION.SDK_INT,
    )

    data class AgreementResult(
        val sharedSecret: ByteArray,
        val mechanism: String,
    )

    data class SignVerifyResult(
        val signature: ByteArray,
        val mechanism: String,
        val verified: Boolean,
    )

    fun deleteAliases() {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        listOf(WRAP_ALIAS, X25519_ALIAS, ED25519_ALIAS).forEach { ks.deleteEntry(it) }
    }

    fun ensureAesWrapKey(bits: Int = 256): SecretKey {
        val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            WRAP_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(bits)
            .setRandomizedEncryptionRequired(true)
            .build()
        kg.init(spec)
        return kg.generateKey()
    }

    fun wrapSpaceKey(spaceKey: ByteArray, requireKeystoreAes: Boolean = true): WrapResult {
        require(spaceKey.size == 32) { "spaceKey 必须是 32 字节" }
        val key = ensureAesWrapKey()
        val cipher = if (requireKeystoreAes) {
            Cipher.getInstance("AES/GCM/NoPadding")
        } else {
            Cipher.getInstance("AES/GCM/NoPadding", ANDROID_KEYSTORE)
        }
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val iv = cipher.iv
        val wrapped = cipher.doFinal(spaceKey)
        return WrapResult(wrapped = wrapped, iv = iv)
    }

    fun unwrapSpaceKey(result: WrapResult, requireKeystoreAes: Boolean = true): ByteArray {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val key = ks.getKey(WRAP_ALIAS, null) as SecretKey
        val cipher = if (requireKeystoreAes) {
            Cipher.getInstance("AES/GCM/NoPadding")
        } else {
            Cipher.getInstance("AES/GCM/NoPadding", ANDROID_KEYSTORE)
        }
        val spec = GCMParameterSpec(GCM_TAG_BITS, result.iv)
        cipher.init(Cipher.DECRYPT_MODE, key, spec)
        return cipher.doFinal(result.wrapped)
    }

    /** X25519/Ed25519 算法名与 PURPOSE_AGREE_KEY=32（API 33+），避免 compileSdk 常量缺失。 */
    const val ALGO_X25519 = "X25519"
    const val ALGO_ED25519 = "Ed25519"
    const val PURPOSE_AGREE_KEY = 32

    fun generateKeystoreX25519(): KeyPair {
        val kpg = KeyPairGenerator.getInstance(ALGO_X25519, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(X25519_ALIAS, PURPOSE_AGREE_KEY).build()
        kpg.initialize(spec)
        return kpg.generateKeyPair()
    }

    /** 软件侧默认 Provider：Android 上 Conscrypt 名为 AndroidOpenSSL。 */
    const val SOFTWARE_PROVIDER = "AndroidOpenSSL"
    const val BC_PROVIDER = "BC"

    fun generateSoftwareX25519(): KeyPair {
        // Conscrypt X25519 不接受 NamedParameterSpec；直接 generateKeyPair()
        val kpg = KeyPairGenerator.getInstance(ALGO_X25519, SOFTWARE_PROVIDER)
        return kpg.generateKeyPair()
    }

    fun agree(shared: KeyPair, peerPublic: PublicKey): AgreementResult {
        val ka = try {
            KeyAgreement.getInstance(ALGO_X25519, SOFTWARE_PROVIDER)
        } catch (_: Exception) {
            KeyAgreement.getInstance(ALGO_X25519, BC_PROVIDER)
        }
        ka.init(shared.private)
        ka.doPhase(peerPublic, true)
        return AgreementResult(ka.generateSecret(), "${ALGO_X25519}/${ka.provider.name}")
    }

    fun generateKeystoreEd25519(): KeyPair {
        val kpg = KeyPairGenerator.getInstance(ALGO_ED25519, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            ED25519_ALIAS,
            KeyProperties.PURPOSE_SIGN,
        ).build()
        kpg.initialize(spec)
        return kpg.generateKeyPair()
    }

    fun softwareProviders(): List<java.security.Provider> =
        Security.getProviders().filterNot { it.name.equals(ANDROID_KEYSTORE, ignoreCase = true) }

    /** BouncyCastle RFC8032 直连（androidTest only）：绕过系统无 Ed25519 JCA Provider 的缺口。 */
    data class Ed25519KeyMaterial(
        val seed: ByteArray,
        val publicKey: ByteArray,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Ed25519KeyMaterial) return false
            return seed.contentEquals(other.seed) && publicKey.contentEquals(other.publicKey)
        }

        override fun hashCode(): Int = seed.contentHashCode() * 31 + publicKey.contentHashCode()
    }

    fun generateEd25519Rfc8032(): Ed25519KeyMaterial {
        val seed = ByteArray(32)
        java.security.SecureRandom().nextBytes(seed)
        val priv = org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters(seed, 0)
        val pub = priv.generatePublicKey().encoded
        return Ed25519KeyMaterial(seed, pub)
    }

    fun signEd25519Rfc8032(key: Ed25519KeyMaterial, message: ByteArray): ByteArray {
        val priv = org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters(key.seed, 0)
        val signer = org.bouncycastle.crypto.signers.Ed25519Signer()
        signer.init(true, priv)
        signer.update(message, 0, message.size)
        return signer.generateSignature()
    }

    fun verifyEd25519Rfc8032(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        val pub = org.bouncycastle.crypto.params.Ed25519PublicKeyParameters(publicKey, 0)
        val verifier = org.bouncycastle.crypto.signers.Ed25519Signer()
        verifier.init(false, pub)
        verifier.update(message, 0, message.size)
        return verifier.verifySignature(signature)
    }

    fun signAndVerify(privateKey: PrivateKey, publicKey: PublicKey, message: ByteArray): SignVerifyResult {
        val candidates = mutableListOf<String>()
        if (privateKey.javaClass.name.contains("AndroidKeyStore", ignoreCase = true)) {
            candidates += "AndroidKeyStore"
        }
        candidates += softwareProviders().map { it.name }

        var last: Exception? = null
        for (prov in candidates) {
            try {
                val signer = Signature.getInstance(ALGO_ED25519, prov)
                signer.initSign(privateKey)
                signer.update(message)
                val sig = signer.sign()
                val verifier = Signature.getInstance(ALGO_ED25519, prov)
                verifier.initVerify(publicKey)
                verifier.update(message)
                val ok = verifier.verify(sig)
                return SignVerifyResult(sig, "$ALGO_ED25519/$prov", ok)
            } catch (e: Exception) {
                last = e
            }
        }
        throw NoSuchAlgorithmException("无可用 Ed25519 Signature Provider", last)
    }

    fun encodePublic(publicKey: PublicKey): ByteArray = publicKey.encoded

    fun decodePublicX509(bytes: ByteArray): PublicKey =
        KeyFactory.getInstance(ALGO_X25519).generatePublic(X509EncodedKeySpec(bytes))
}
