package com.qingyu.companion.imagegen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-04：`localhost` 配置迁移时的阻断式提示判定。
 * 产品要求：提示其在手机上指向本机、要求填写可访问地址，**不是静默换地址**。
 */
class LocalhostEndpointPolicyTest {

    private fun assertBlocking(raw: String) {
        val decision = LocalhostEndpointPolicy.evaluate(raw)
        assertTrue(
            "loopback 配置必须返回阻断式提示（$raw），实际是 $decision",
            decision is LocalhostEndpointPolicy.EndpointDecision.BlockingLocalhostNotice,
        )
        decision as LocalhostEndpointPolicy.EndpointDecision.BlockingLocalhostNotice
        assertTrue("提示必须说明 localhost 在手机上指向手机本机", decision.message.contains("手机"))
        assertTrue("提示必须要求填写手机可访问的地址", decision.message.contains("可访问"))
        assertFalse("阻断式提示不得携带替用户改写的地址", decision.message.contains("192.168."))
    }

    @Test
    fun `localhost and loopback addresses are blocked with notice`() {
        assertBlocking("http://localhost:8188")
        assertBlocking("http://127.0.0.1:7860")
        assertBlocking("http://127.0.0.5:8188")
        assertBlocking("http://[::1]:8188")
        assertBlocking("http://0.0.0.0:8188")
        assertBlocking("http://my.localhost:8188")
    }

    @Test
    fun `decision never rewrites the address silently`() {
        val decision = LocalhostEndpointPolicy.evaluate("http://localhost:8188")
        // 判定结果只有「阻断提示 / 接受 / 拒绝」三种形状，不存在“改写后的地址”出口
        assertTrue(
            "loopback 只能返回阻断提示，调用方无法拿到任何被静默改写的地址",
            decision is LocalhostEndpointPolicy.EndpointDecision.BlockingLocalhostNotice,
        )
    }

    @Test
    fun `lan and public addresses are accepted with normalized base url`() {
        val lan = LocalhostEndpointPolicy.evaluate("http://192.168.1.5:8188/")
        assertEquals(
            "局域网地址是合法生图端点，接受并去掉尾斜杠",
            "http://192.168.1.5:8188",
            (lan as LocalhostEndpointPolicy.EndpointDecision.Accepted).normalizedBaseUrl,
        )
        val public = LocalhostEndpointPolicy.evaluate("https://comfy.example.com")
        assertTrue("公网 https 地址必须可用", public is LocalhostEndpointPolicy.EndpointDecision.Accepted)
    }

    @Test
    fun `non-http schemes and metadata addresses are rejected`() {
        val file = LocalhostEndpointPolicy.evaluate("file:///etc/passwd")
        assertTrue("file:// 必须拒绝", file is LocalhostEndpointPolicy.EndpointDecision.Rejected)
        val metadata = LocalhostEndpointPolicy.evaluate("http://169.254.169.254/")
        assertTrue("内网元数据地址必须拒绝", metadata is LocalhostEndpointPolicy.EndpointDecision.Rejected)
        val userinfo = LocalhostEndpointPolicy.evaluate("https://user:pass@example.com")
        assertTrue("userinfo 夹带必须拒绝", userinfo is LocalhostEndpointPolicy.EndpointDecision.Rejected)
    }
}
