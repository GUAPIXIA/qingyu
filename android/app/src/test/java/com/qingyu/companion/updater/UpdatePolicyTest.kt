package com.qingyu.companion.updater

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-07 更新策略单测：版本比较、按发布渠道选包、checksum sidecar 解析。
 */
class UpdatePolicyTest {

    // ---------- 版本比较 ----------

    @Test
    fun `版本按数字段比较而不是字典序`() {
        assertTrue("1.10.0 必须大于 1.9.0，否则用户会被误判已是最新", UpdatePolicy.isNewer("1.10.0", "1.9.0"))
        assertTrue("带 v 前缀应与裸版本等价", UpdatePolicy.compareVersions("v2.0.0", "2.0.0") == 0)
        assertTrue("相同版本不算更新", !UpdatePolicy.isNewer("1.2.3", "1.2.3"))
        assertTrue("更低版本不算更新", !UpdatePolicy.isNewer("1.2.3", "1.2.4"))
    }

    @Test
    fun `预发布版本小于正式版本`() {
        assertTrue("1.2.3-beta.2 必须小于 1.2.3，否则 beta 会被当成正式更新", UpdatePolicy.compareVersions("1.2.3-beta.2", "1.2.3") < 0)
        assertTrue("1.2.3 必须大于 1.2.3-beta.2", UpdatePolicy.compareVersions("1.2.3", "1.2.3-beta.2") > 0)
        assertTrue("带 build 元数据不影响比较", UpdatePolicy.compareVersions("1.2.3+45", "1.2.3") == 0)
    }

    // ---------- 发布渠道 ----------

    private fun pkg(version: String, channel: ReleaseChannel) =
        UpdatePackage(versionName = version, channel = channel, downloadUrl = "https://example.com/$version.apk")

    @Test
    fun `优先选择当前渠道的发布包`() {
        val releases = listOf(pkg("2.0.0", ReleaseChannel.STABLE), pkg("2.1.0", ReleaseChannel.BETA))
        assertEquals(
            "beta 渠道应拿到 beta 包，否则渠道语义失效",
            "2.1.0",
            UpdatePolicy.selectForChannel(releases, ReleaseChannel.BETA)?.versionName,
        )
        assertEquals(
            "stable 渠道应拿到 stable 包",
            "2.0.0",
            UpdatePolicy.selectForChannel(releases, ReleaseChannel.STABLE)?.versionName,
        )
    }

    @Test
    fun `非稳定渠道无匹配时回落稳定渠道`() {
        val releases = listOf(pkg("2.0.0", ReleaseChannel.STABLE))
        assertEquals(
            "nightly 无专属包时应安全回落 stable，而不是拿错渠道的包",
            "2.0.0",
            UpdatePolicy.selectForChannel(releases, ReleaseChannel.NIGHTLY)?.versionName,
        )
    }

    @Test
    fun `稳定渠道不接受其它渠道的包`() {
        val releases = listOf(pkg("2.1.0", ReleaseChannel.BETA))
        assertNull(
            "stable 渠道绝不能被投喂 beta 包",
            UpdatePolicy.selectForChannel(releases, ReleaseChannel.STABLE),
        )
    }

    @Test
    fun `渠道名宽松解析未知值回落稳定`() {
        assertEquals(ReleaseChannel.BETA, ReleaseChannel.from("Beta"))
        assertEquals(ReleaseChannel.NIGHTLY, ReleaseChannel.from("nightly"))
        assertEquals(ReleaseChannel.STABLE, ReleaseChannel.from("mystery"))
        assertEquals(ReleaseChannel.STABLE, ReleaseChannel.from(null))
    }

    // ---------- checksum 解析 ----------

    @Test
    fun `checksum文本多种形态都能解析`() {
        val hex = "a".repeat(64)
        assertEquals("裸十六进制应可解析", hex, UpdatePolicy.parseChecksumText(hex))
        assertEquals("coreutils 形态应可解析", hex, UpdatePolicy.parseChecksumText("$hex  update.apk"))
        assertEquals("openssl 形态应可解析", hex, UpdatePolicy.parseChecksumText("SHA256(update.apk)= $hex"))
        assertEquals("大写应归一为小写便于对账", hex, UpdatePolicy.parseChecksumText(hex.uppercase()))
    }

    @Test
    fun `checksum解析不到时返回空`() {
        assertNull("垃圾内容必须解析为空，进而拒绝安装", UpdatePolicy.parseChecksumText("not a checksum"))
        assertNull("长度不足的十六进制不能当 checksum", UpdatePolicy.parseChecksumText("a".repeat(63)))
        assertNull("null 输入应返回空", UpdatePolicy.parseChecksumText(null))
        assertFalse("空串不能当 checksum", UpdatePolicy.parseChecksumText("") != null)
    }
}
