package com.qingyu.companion.security

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 阶段 3 S3-04：SecretRef 的生产实现——**Keystore 生成的不可导出 wrapping key**
 * 加密保存秘密（ADR-010）。
 *
 * 约束（阶段 3 文档 §2 S3-04 / S3-05）：
 * - Keystore 不直接导入任意 32 字节密钥；包装密钥由 Keystore 生成且不可导出。
 * - 明文秘密只出现在内存中；`toString`、日志、崩溃上报、SavedStateHandle 均不得包含明文。
 * - 秘密以 `AES-256-GCM` 密文落在 EncryptedSharedPreferences（其自身再被 Keystore 主密钥包装）。
 */
interface SecretStore {
    fun put(alias: String, plain: ByteArray): SecretRef

    fun get(ref: SecretRef): ByteArray?

    fun delete(ref: SecretRef)

    fun exists(ref: SecretRef): Boolean
}

/** 秘密引用：只持有别名，绝不持有明文。 */
data class SecretRef(val alias: String) {
    override fun toString(): String = "SecretRef(alias=***)"

    override fun equals(other: Any?): Boolean = other is SecretRef && other.alias == alias

    override fun hashCode(): Int = alias.hashCode()
}

/** 内存实现：仅单测/无 Keystore 环境降级使用；不落盘。 */
class InMemorySecretStore : SecretStore {
    private val map = mutableMapOf<String, ByteArray>()

    override fun put(alias: String, plain: ByteArray): SecretRef {
        map[alias] = plain.copyOf()
        return SecretRef(alias)
    }

    override fun get(ref: SecretRef): ByteArray? = map[ref.alias]?.copyOf()

    override fun delete(ref: SecretRef) {
        map.remove(ref.alias)
    }

    override fun exists(ref: SecretRef): Boolean = map.containsKey(ref.alias)
}

/**
 * Keystore 实现。
 *
 * 读取路径的失败语义：Keystore 条目被系统清除（改锁屏/恢复出厂）或密文损坏时
 * **返回 null 而不是抛异常**，由调用方提示用户重新输入；绝不回退到明文。
 */
class KeystoreSecretStore(context: Context) : SecretStore {

    private val appContext = context.applicationContext

    private val prefs: SharedPreferences? by lazy { createPrefs(appContext) }

    override fun put(alias: String, plain: ByteArray): SecretRef {
        val store = prefs ?: throw IllegalStateException("Keystore 不可用，拒绝以明文保存秘密")
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey(alias))
        val iv = cipher.iv
        val cipherText = cipher.doFinal(plain)
        store.edit()
            .putString(ivKey(alias), Base64.encodeToString(iv, Base64.NO_WRAP))
            .putString(ctKey(alias), Base64.encodeToString(cipherText, Base64.NO_WRAP))
            .commit()
        return SecretRef(alias)
    }

    override fun get(ref: SecretRef): ByteArray? {
        val store = prefs ?: return null
        val ivText = store.getString(ivKey(ref.alias), null) ?: return null
        val ctText = store.getString(ctKey(ref.alias), null) ?: return null
        return runCatching {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                wrappingKey(ref.alias),
                GCMParameterSpec(GCM_TAG_BITS, Base64.decode(ivText, Base64.NO_WRAP)),
            )
            cipher.doFinal(Base64.decode(ctText, Base64.NO_WRAP))
        }.getOrNull()
    }

    override fun delete(ref: SecretRef) {
        prefs?.edit()?.remove(ivKey(ref.alias))?.remove(ctKey(ref.alias))?.commit()
        runCatching { keyStore()?.deleteEntry(ref.alias) }
    }

    override fun exists(ref: SecretRef): Boolean =
        prefs?.contains(ctKey(ref.alias)) == true

    private fun ivKey(alias: String) = "$alias.iv"

    private fun ctKey(alias: String) = "$alias.ct"

    private fun keyStore(): KeyStore? =
        runCatching { KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) } }.getOrNull()

    private fun wrappingKey(alias: String): SecretKey {
        val ks = keyStore() ?: throw IllegalStateException("Android Keystore 不可用")
        (ks.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // 不可导出：不设置 setUserAuthenticationRequired，避免后台同步被锁屏打断
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
        const val PREFS_NAME = "qingyu_local_secrets"

        fun createPrefs(context: Context): SharedPreferences? = runCatching {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                context,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }.getOrNull()
    }
}
