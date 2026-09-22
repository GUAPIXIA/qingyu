package com.qingyu.companion.imagegen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-04 / 阶段 6 §3 SSRF 边界：
 * 重定向到内网元数据地址、`file://` 等非 http(s) scheme 必须拒绝。
 */
class ImageGenUrlPolicyTest {

    private fun assertBlocked(raw: String, code: String) {
        val decision = ImageGenUrlPolicy.checkUrl(raw)
        assertTrue("非法 URL 必须拒绝：$raw，实际 $decision", decision is ImageGenUrlPolicy.UrlDecision.Blocked)
        assertEquals("拒绝码必须可分类", code, (decision as ImageGenUrlPolicy.UrlDecision.Blocked).code)
    }

    @Test
    fun `non-http schemes rejected`() {
        assertBlocked("file:///etc/passwd", "UNSUPPORTED_SCHEME")
        assertBlocked("file://C:/Windows/win.ini", "UNSUPPORTED_SCHEME")
        assertBlocked("javascript:alert(1)", "UNSUPPORTED_SCHEME")
        assertBlocked("data:text/html;base64,PHNjcmlwdD4=", "UNSUPPORTED_SCHEME")
        assertBlocked("ftp://evil.example.com/a", "UNSUPPORTED_SCHEME")
        assertBlocked("ws://192.168.1.5:8188", "UNSUPPORTED_SCHEME")
    }

    @Test
    fun `link-local and metadata endpoints rejected`() {
        assertBlocked("http://169.254.169.254/latest/meta-data/", "METADATA_ENDPOINT")
        assertBlocked("https://169.254.169.254/", "METADATA_ENDPOINT")
        assertBlocked("http://[fe80::1%25wlan0]:8188/", "METADATA_ENDPOINT")
        assertBlocked("http://[::ffff:169.254.169.254]/", "METADATA_ENDPOINT")
        assertBlocked("http://metadata.google.internal/computeMetadata/v1/", "METADATA_ENDPOINT")
    }

    @Test
    fun `userinfo credentials in url rejected`() {
        assertBlocked("https://user:pass@comfy.example.com", "BAD_URL")
    }

    @Test
    fun `lan and public http endpoints allowed`() {
        assertTrue(
            "局域网生图端点必须允许",
            ImageGenUrlPolicy.checkUrl("http://192.168.1.5:8188/prompt") is ImageGenUrlPolicy.UrlDecision.Allowed,
        )
        assertTrue(
            "公网 https 端点必须允许",
            ImageGenUrlPolicy.checkUrl("https://api.example.com/v1/images/generations") is ImageGenUrlPolicy.UrlDecision.Allowed,
        )
        assertTrue(
            "带查询串的图片下载地址必须允许",
            ImageGenUrlPolicy.checkUrl("http://10.0.0.9:8188/view?filename=a.png") is ImageGenUrlPolicy.UrlDecision.Allowed,
        )
    }

    @Test
    fun `redirect to metadata endpoint rejected even over https`() {
        val decision = ImageGenUrlPolicy.checkRedirect(
            "https://comfy.example.com/view",
            "https://169.254.169.254/latest/meta-data/",
        )
        assertTrue(
            "重定向到内网元数据地址必须拒绝（即使走 TLS）",
            decision is ImageGenUrlPolicy.UrlDecision.Blocked,
        )
    }

    @Test
    fun `redirect to non-http scheme rejected`() {
        val cases = listOf(
            "http://192.168.1.5:8188/a" to "file:///etc/passwd",
            "http://192.168.1.5:8188/a" to "javascript:alert(1)",
            "https://comfy.example.com/a" to "ftp://evil.example.com/x",
        )
        for ((request, location) in cases) {
            val decision = ImageGenUrlPolicy.checkRedirect(request, location)
            assertTrue(
                "重定向到非 http(s) scheme 必须拒绝：$request → $location",
                decision is ImageGenUrlPolicy.UrlDecision.Blocked,
            )
        }
    }

    @Test
    fun `redirect downgrade and public-to-local cleartext jumps rejected`() {
        val downgrade = ImageGenUrlPolicy.checkRedirect(
            "https://bridge.example.com/a",
            "http://192.168.1.5:8188/a",
        )
        assertTrue("HTTPS→HTTP 降级必须拒绝", downgrade is ImageGenUrlPolicy.UrlDecision.Blocked)
        val escape = ImageGenUrlPolicy.checkRedirect(
            "http://public.example.com/a",
            "http://10.0.0.9/a",
        )
        assertTrue("公网→本地明文跳转必须拒绝（防 SSRF 探测内网）", escape is ImageGenUrlPolicy.UrlDecision.Blocked)
    }

    @Test
    fun `safe redirects allowed`() {
        assertTrue(
            "本地 http→本地 http 放行",
            ImageGenUrlPolicy.checkRedirect(
                "http://192.168.1.5:8188/api",
                "http://192.168.1.9:8188/api",
            ) is ImageGenUrlPolicy.UrlDecision.Allowed,
        )
        assertTrue(
            "TLS→TLS 放行",
            ImageGenUrlPolicy.checkRedirect(
                "https://a.example.com/",
                "https://b.example.com/",
            ) is ImageGenUrlPolicy.UrlDecision.Allowed,
        )
        assertTrue(
            "明文升级到 TLS 放行",
            ImageGenUrlPolicy.checkRedirect(
                "http://192.168.1.5:8188/a",
                "https://192.168.1.5:8443/a",
            ) is ImageGenUrlPolicy.UrlDecision.Allowed,
        )
    }

    @Test
    fun `base url with query or fragment rejected`() {
        val decision = ImageGenUrlPolicy.checkBaseUrl("https://api.example.com/v1?token=abc")
        assertTrue("base URL 带 query 必须拒绝", decision is ImageGenUrlPolicy.UrlDecision.Blocked)
    }
}
