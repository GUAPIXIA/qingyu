package com.qingyu.companion.diagnostics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-07 诊断脱敏单测：API Key / token / 路径用户名 / URL 凭据 / 邮箱 / 注册秘密
 * 一律抹除，无害元数据保留，脱敏幂等。
 */
class DiagnosticsRedactorTest {

    @Test
    fun `OpenAI风格APIKey必须被抹掉`() {
        val key = "sk-proj-AbCdEfGh1234567890-_XyZ"
        val out = DiagnosticsRedactor().redact("model auth failed with $key in header")
        assertFalse("导出里残留 OpenAI 风格 API Key，用户密钥会随诊断包外泄", key in out)
        assertTrue("API Key 应替换为掩码占位", DiagnosticsRedactor.MASK in out)
    }

    @Test
    fun `GitHub与Google等平台密钥必须被抹掉`() {
        val redactor = DiagnosticsRedactor()
        val secrets = listOf(
            "ghp_abcdefghijklmnop123456",
            "github_pat_11ABCDEFG01234567890_abCdeFg",
            "AIzaSyA-EXAMPLEKEY1234567890abcdefghijk",
            "AKIAIOSFODNN7EXAMPLE",
        )
        for (secret in secrets) {
            val out = redactor.redact("value=$secret end")
            assertFalse("导出里残留平台密钥 $secret，会随诊断包外泄", secret in out)
        }
    }

    @Test
    fun `JWT与Bearer头必须被抹掉`() {
        val jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"
        val out = DiagnosticsRedactor().redact("Authorization: Bearer $jwt")
        assertFalse("导出里残留 JWT，令牌会随诊断包外泄", jwt in out)
        assertFalse("导出里残留 Bearer 原串", "Bearer" in out)
        assertTrue("授权头应整体替换为掩码占位", DiagnosticsRedactor.MASK in out)
    }

    @Test
    fun `键值形式的密钥字段必须被抹掉`() {
        val redactor = DiagnosticsRedactor()
        val samples = listOf(
            "api_key=real-secret-value-123" to "real-secret-value-123",
            "token: relay-token-abc" to "relay-token-abc",
            "password=\"pass12345\"" to "pass12345",
            "Authorization: session_998877" to "session_998877",
        )
        for ((line, secret) in samples) {
            val out = redactor.redact(line)
            assertFalse("键值形式的秘密 $secret 未脱敏，会随诊断包外泄", secret in out)
        }
    }

    @Test
    fun `URL内嵌凭据必须被抹掉`() {
        val out = DiagnosticsRedactor().redact("GET https://user:passw0rd@example.com/api failed")
        assertFalse("URL 内嵌用户名未脱敏", "user" in out)
        assertFalse("URL 内嵌密码未脱敏，等于把账号密码发出去", "passw0rd" in out)
        assertTrue("URL 应保留 host 便于排障", "example.com" in out)
    }

    @Test
    fun `路径里的用户名必须被抹掉`() {
        val redactor = DiagnosticsRedactor()
        val windows = redactor.redactPath("""C:\Users\alice\AppData\files\db.sqlite""")
        val linux = redactor.redactPath("/home/alice/.cache/qingyu")
        val macos = redactor.redactPath("/Users/bob/Documents/err.log")
        assertFalse("路径里的 Windows 用户名泄露，可反推用户身份", "alice" in windows)
        assertFalse("路径里的 Linux 用户名泄露，可反推用户身份", "alice" in linux)
        assertFalse("路径里的 macOS 用户名泄露，可反推用户身份", "bob" in macos)
        assertTrue("路径应保留目录结构便于排障", "AppData" in windows)
    }

    @Test
    fun `邮箱本地部分必须被抹掉但保留域名`() {
        val out = DiagnosticsRedactor().redact("owner mail: zhangsan@example.com")
        assertFalse("邮箱本地部分泄露，可反推用户身份", "zhangsan" in out)
        assertTrue("邮箱域名保留便于排障", "@example.com" in out)
    }

    @Test
    fun `注册的秘密原串按原样抹掉（正文类自由文本只能靠注册）`() {
        val content = "今晚八点老地方见，别带手机"
        val token = "rt_Zq7Xk2Pn4Lm9Vb1Wc3"
        val redactor = DiagnosticsRedactor(listOf(content, token))
        val out = redactor.redact("error while handling 「$content」 with $token")
        assertFalse("注册的消息正文未被抹掉，诊断包会泄露聊天内容", content in out)
        assertFalse("注册的 token 未被抹掉，诊断包会泄露凭据", token in out)
    }

    @Test
    fun `长随机串兜底抹掉`() {
        val hex = "0123456789abcdef0123456789abcdef01234567"
        val b64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg=="
        val redactor = DiagnosticsRedactor()
        assertFalse("32+ 位十六进制随机串未抹掉，可能是签名或密钥", hex in redactor.redact("sig=$hex"))
        assertFalse("40+ 位 base64 随机串未抹掉，可能是密钥", b64 in redactor.redact("key $b64"))
    }

    @Test
    fun `无害元数据保留`() {
        val redactor = DiagnosticsRedactor()
        val out = redactor.redact("version=1.2.3 state=connected(rtt=45ms) schema=7 count=12 reason=tls")
        assertTrue("版本号被误伤会导致诊断失真", "1.2.3" in out)
        assertTrue("状态标签被误伤会导致诊断失真", "connected" in out)
        assertTrue("失败原因被误伤会导致诊断失真", "tls" in out)
    }

    @Test
    fun `脱敏幂等且超长文本截断`() {
        val redactor = DiagnosticsRedactor()
        val once = redactor.redact("sk-abcdefghijklmnopqrst1234567890 tail")
        val twice = redactor.redact(once)
        assertEquals("重复脱敏结果应稳定，否则拼接日志时会变形", once, twice)
        val long = redactor.redact("x".repeat(DiagnosticsRedactor.MAX_TEXT_LENGTH + 100))
        assertTrue(
            "超长自由文本必须截断，防止整段正文借错误摘要混入",
            long.length <= DiagnosticsRedactor.MAX_TEXT_LENGTH + 1,
        )
    }
}
