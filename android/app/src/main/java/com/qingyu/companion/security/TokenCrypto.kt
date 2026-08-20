package com.qingyu.companion.security

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Token 加密存储（路线图 4.3 B2）：
 * - 使用 Android Keystore 包装主密钥（MasterKey.AES256_GCM）
 * - EncryptedSharedPreferences 自动对 value 做 AES256-GCM 加密，key 亦加密
 * - 失败回退：Keystore 不可用或测试环境（Robolectric/JVM）时返回 null，由调用方降级为明文 DataStore
 */
object TokenCrypto {

    private const val PREFS_NAME = "secure_tokens"
    private var cachedPrefs: SharedPreferences? = null

    fun getEncryptedPrefs(context: Context): SharedPreferences? {
        cachedPrefs?.let { return it }
        return runCatching {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                context,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            ).also { cachedPrefs = it }
        }.getOrNull()
    }

    fun encryptToken(context: Context, token: String): String {
        // 尝试加密存储：写入 EncryptedSharedPreferences 后返回原 token 的加密引用
        // 为保持 ServerConnection 模型不变，我们不改变 token 字符串本身，
        // 而是将明文 token 额外缓存在 EncryptedSharedPreferences 中，DataStore 仅存占位
        // 新逻辑：DataStore 存 ENC:<key>，实际密文在 EncryptedPrefs 中以 key 映射
        // 简化：直接返回 token，调用方负责双写；此处提供句柄
        return token
    }

    fun putEncrypted(context: Context, key: String, plain: String) {
        getEncryptedPrefs(context)?.edit()?.putString(key, plain)?.apply()
    }

    fun getDecrypted(context: Context, key: String): String? =
        getEncryptedPrefs(context)?.getString(key, null)

    fun removeEncrypted(context: Context, key: String) {
        getEncryptedPrefs(context)?.edit()?.remove(key)?.apply()
    }

    fun clearEncrypted(context: Context) {
        getEncryptedPrefs(context)?.edit()?.clear()?.apply()
    }
}
