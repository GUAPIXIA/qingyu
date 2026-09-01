package com.qingyu.companion.data.relay

import android.content.Context
import com.qingyu.companion.security.TokenCrypto

class RelayCredentialStore(private val context: Context) {
    private fun accessKey(deviceId: String) = "connection:$deviceId:access"
    private fun refreshKey(deviceId: String) = "connection:$deviceId:refresh"
    fun save(deviceId: String, accessToken: String, refreshToken: String) {
        require(accessToken.isNotBlank() && refreshToken.isNotBlank())
        val encrypted = requireNotNull(TokenCrypto.getEncryptedPrefs(context)) { "安全存储不可用" }
        encrypted.edit().putString(accessKey(deviceId), accessToken).putString(refreshKey(deviceId), refreshToken).apply()
    }
    fun access(deviceId: String): String? = TokenCrypto.getDecrypted(context, accessKey(deviceId))
    fun refresh(deviceId: String): String? = TokenCrypto.getDecrypted(context, refreshKey(deviceId))
    fun remove(deviceId: String) {
        TokenCrypto.removeEncrypted(context, accessKey(deviceId))
        TokenCrypto.removeEncrypted(context, refreshKey(deviceId))
    }
}
