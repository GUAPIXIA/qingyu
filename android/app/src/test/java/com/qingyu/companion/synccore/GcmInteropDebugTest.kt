package com.qingyu.companion.synccore

import org.junit.Test
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class GcmInteropDebugTest {
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    @Test
    fun nistEmptyTag() {
        val key = ByteArray(32)
        val iv = ByteArray(12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        val out = cipher.doFinal(ByteArray(0))
        val tag = out.copyOfRange(out.size - 16, out.size)
        println("NIST_EMPTY_TAG=" + hex(tag) + " expect=530f8afbc74536b9a963b4f1c4cb738b")
    }

    @Test
    fun decryptTsCiphertext() {
        val key = javax.crypto.spec.SecretKeySpec(
            java.util.Base64.getDecoder().decode("00lVz6IQ6v+7KBXnj2xbq87yK/n6pSHUF5IeX1LhPaY="),
            "AES",
        )
        val iv = ByteArray(12) { 1 }
        val aad = ("qingyu-entity-aad/v1|11111111-2222-3333-4444-555555555555|" +
            "character|01KCHARACTER00000000000001|3|" +
            "sha256:e9095f1ba407ef12f5681a48a7175774480b9fd86beeeff0a45c642c8a160aed|1|1"
            ).toByteArray(Charsets.UTF_8)
        val body = hexToBytes("6dde30d94adf860073e8361554641ee74aa2734cab5da5733076b23f71baea2be559fdb458526eaf6d660dec6c28baaabe34152c2761ca1fa5bc8515")
        val tsTag = hexToBytes("ac9f18f9b455acd22c4c4805151fb6c3")
        val javaTag = hexToBytes("1a7a0c3125d1989db3d11b9016eeaff6")
        for ((name, tag) in listOf("ts" to tsTag, "java" to javaTag)) {
            try {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
                cipher.updateAAD(aad)
                val plain = cipher.doFinal(body + tag)
                println("JAVA_DECRYPT_${name.uppercase()}_OK len=" + plain.size)
            } catch (e: Exception) {
                println("JAVA_DECRYPT_${name.uppercase()}_FAIL " + e.message)
            }
        }
        println("AAD_LEN=" + aad.size + " AAD_HEX=" + hex(aad))
    }

    private fun hexToBytes(s: String): ByteArray {
        val out = ByteArray(s.length / 2)
        for (i in out.indices) out[i] = s.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        return out
    }

    @Test
    fun dumpTags() {
        val spaceKey = ByteArray(32) { 0x11 }
        val key = com.qingyu.companion.synccore.crypto.SyncCrypto.deriveSubkey(spaceKey, "entity")
        val nonce = ByteArray(12) { 0x01 }
        val plain = (
            "{\"greeting\":\"你好\",\"name\":\"测试角色\",\"tags\":[\"a\",\"b\"]}"
            ).toByteArray(Charsets.UTF_8)
        val aad = ("qingyu-entity-aad/v1|11111111-2222-3333-4444-555555555555|" +
            "character|01KCHARACTER00000000000001|3|" +
            "sha256:e9095f1ba407ef12f5681a48a7175774480b9fd86beeeff0a45c642c8a160aed|1|1"
            ).toByteArray(Charsets.UTF_8)
        println("AAD_HEX=" + hex(aad))
        println("AAD_LEN=" + aad.size)

        fun enc(aadBytes: ByteArray?, provider: String?): Pair<String, String> {
            val cipher = if (provider == null) {
                Cipher.getInstance("AES/GCM/NoPadding")
            } else {
                Cipher.getInstance("AES/GCM/NoPadding", provider)
            }
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
            if (aadBytes != null) cipher.updateAAD(aadBytes)
            val out = cipher.doFinal(plain)
            return hex(out.copyOfRange(0, out.size - 16)) to hex(out.copyOfRange(out.size - 16, out.size))
        }

        val withDefault = enc(aad, null)
        val withoutAad = enc(null, null)
        val withSun = enc(aad, "SunJCE")
        println("PLAIN_HEX=" + hex(plain))
        println("PLAIN_LEN=" + plain.size)
        println("DEFAULT_WITH_AAD body=" + withDefault.first + " tag=" + withDefault.second)
        println("DEFAULT_NO_AAD body=" + withoutAad.first + " tag=" + withoutAad.second)
        println("SUN_WITH_AAD body=" + withSun.first + " tag=" + withSun.second)
        // also try BC if present
        try {
            val bc = enc(aad, "BC")
            println("BC_WITH_AAD body=" + bc.first + " tag=" + bc.second)
        } catch (e: Exception) {
            println("BC unavailable: " + e.message)
        }
        try {
            val bc = enc(aad, "BC")
            println("BC_WITH_AAD body=" + bc.first + " tag=" + bc.second)
        } catch (e: Exception) {
            println("BC2 unavailable: " + e.message)
        }
        MessageDigest.getInstance("SHA-256") // keep import
    }
}
