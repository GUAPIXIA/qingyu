package com.qingyu.companion.tts

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/**
 * 凭据脱敏：TTS 日志/错误文案不得携带本地 secret store 的明文密钥。
 */
class SecretRedactorTest {

    @Test
    fun `已知密钥从任何文本形态中抹除`() {
        val secret = "sk-super-secret-key-123"
        val text = "请求失败：Authorization: Bearer $secret，回显体=$secret"

        val redacted = SecretRedactor.redact(text, listOf(secret))

        assertFalse(redacted.contains(secret), "密钥一旦进日志就等于泄漏：已知密钥必须逐字抹除")
    }

    @Test
    fun `Bearer与sk样式凭据被兜底抹除`() {
        val text = "headers={Authorization=Bearer abcdef123456, X-Api-Key=sk-unlisted-key-9999}"

        val redacted = SecretRedactor.redact(text)

        assertFalse(redacted.contains("abcdef123456"), "未登记的 Bearer 凭据也必须兜底抹除，日志是最大的泄密面")
        assertFalse(redacted.contains("sk-unlisted-key-9999"), "sk 样式凭据必须兜底抹除")
    }

    @Test
    fun `无密钥文本保持原样-不破坏排障信息`() {
        val text = "网络 TTS 返回 HTTP 503，请稍后重试"

        assertEquals(text, SecretRedactor.redact(text, listOf(null, "")), "不含凭据的错误信息不得被误伤，否则排障线索丢失")
    }
}
