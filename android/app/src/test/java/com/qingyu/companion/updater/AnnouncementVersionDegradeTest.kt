package com.qingyu.companion.updater

import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.model.Announcement
import com.qingyu.companion.model.AnnouncementPage
import com.qingyu.companion.model.VersionInfo
import com.qingyu.companion.ui.announcements.AnnouncementFeed
import com.qingyu.companion.ui.announcements.AnnouncementFeedResult
import com.qingyu.companion.ui.announcements.AnnouncementSource
import java.io.IOException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-07 公告与版本获取降级单测（公告/版本获取失败可降级，本地提示不崩）：
 * - 公告获取抛错 → 降级为「上次列表 + 提示」，绝不抛给 UI；
 * - 版本获取失败/服务器未配置 → 降级为 Unavailable，绝不抛给 UI。
 */
class AnnouncementVersionDegradeTest {

    private fun announcement(id: Int, title: String) =
        Announcement(id = id, title = title, content = "（公告详情内容）", createdAt = "2024-01-01", updatedAt = "2024-01-01")

    private fun page(vararg items: Announcement) =
        AnnouncementPage(items = items.toList(), total = items.size, page = 1, pageSize = 20)

    // ---------- 公告降级 ----------

    @Test
    fun `公告获取失败降级为提示而不是崩溃`() = runTest {
        val feed = AnnouncementFeed(AnnouncementSource { throw IOException("network down") })
        val result = feed.load()
        assertTrue("公告获取失败必须降级，不能把异常抛给 UI 造成崩溃", result is AnnouncementFeedResult.Degraded)
        result as AnnouncementFeedResult.Degraded
        assertTrue("降级提示不能为空，否则用户不知道发生了什么", result.notice.isNotBlank())
        assertTrue("首次失败时没有缓存可展示", result.cached.isEmpty())
    }

    @Test
    fun `公告获取失败时保留上次列表供离线查看`() = runTest {
        var fail = false
        val items = listOf(announcement(1, "公告一"), announcement(2, "公告二"))
        val feed = AnnouncementFeed(AnnouncementSource {
            if (fail) throw IOException("network down") else page(*items.toTypedArray())
        })
        val first = feed.load()
        assertTrue("获取成功应返回列表", first is AnnouncementFeedResult.Loaded)
        assertEquals("成功列表内容不符", 2, (first as AnnouncementFeedResult.Loaded).items.size)

        fail = true
        val second = feed.load()
        assertTrue("再次失败应降级而不是崩溃", second is AnnouncementFeedResult.Degraded)
        second as AnnouncementFeedResult.Degraded
        assertEquals("离线时必须保留上次列表，否则用户丢失已看到的公告", items, second.cached)
    }

    @Test
    fun `离线类错误的降级提示面向本地可用`() = runTest {
        val feed = AnnouncementFeed(AnnouncementSource { throw CompanionError.Offline() })
        val result = feed.load() as AnnouncementFeedResult.Degraded
        assertTrue(
            "离线提示应说明本地缓存可用，而不是吓唬用户",
            "离线" in result.notice,
        )
        assertFalse("提示里不应泄露原始异常堆栈", "Exception" in result.notice)
    }

    @Test
    fun `空公告列表是正常结果不是降级`() = runTest {
        val feed = AnnouncementFeed(AnnouncementSource { page() })
        val result = feed.load()
        assertTrue("服务端明确返回空列表应算成功，方便区分『没有公告』与『获取失败』", result is AnnouncementFeedResult.Loaded)
        assertTrue("空列表应原样返回", (result as AnnouncementFeedResult.Loaded).items.isEmpty())
    }

    // ---------- 版本获取降级 ----------

    private fun updateServiceFor(source: VersionInfoSource) = UpdateService(
        currentVersionName = "1.0.0",
        channel = ReleaseChannel.STABLE,
        releaseSource = VersionInfoReleaseSource(source),
        downloader = object : UpdateDownloadClient {
            override suspend fun download(url: String, target: java.io.File): Long = 0L
            override suspend fun fetchText(url: String): String? = null
        },
        fileStore = LocalUpdateFileStore(java.io.File("build/nonexistent-updater-test")),
        installer = object : UpdateInstaller {
            override fun install(apk: java.io.File) = Unit
        },
    )

    @Test
    fun `版本获取失败降级为不可用而不是崩溃`() = runTest {
        val service = updateServiceFor(VersionInfoSource { throw IOException("version api down") })
        val result = service.check()
        assertTrue("版本获取失败必须降级，不能把异常抛给 UI 造成崩溃", result is UpdateCheckResult.Unavailable)
        assertEquals(
            "失败原因键被改动会让 UI 无法映射提示文案",
            "version_fetch_failed",
            (result as UpdateCheckResult.Unavailable).reason,
        )
    }

    @Test
    fun `服务器未配置版本信息按降级处理`() = runTest {
        val noInfo = updateServiceFor(VersionInfoSource { null }).check()
        assertTrue("服务器未返回版本应降级", noInfo is UpdateCheckResult.Unavailable)

        val noUrl = updateServiceFor(VersionInfoSource { VersionInfo(androidVersion = "1.1.0") }).check()
        assertTrue("没有下载地址时不应报出可用更新", noUrl is UpdateCheckResult.Unavailable)
    }

    @Test
    fun `本地版本检查正常工作并走安卓字段`() = runTest {
        val service = updateServiceFor(VersionInfoSource {
            VersionInfo(
                version = "9.9.9",
                androidVersion = "1.1.0",
                androidDownloadUrl = "https://example.com/companion.apk",
                androidChangelog = "修复若干问题",
            )
        })
        val result = service.check()
        assertTrue("有新版本应报出来", result is UpdateCheckResult.UpdateAvailable)
        result as UpdateCheckResult.UpdateAvailable
        assertEquals("应优先使用安卓端版本号而不是 PC 版本号", "1.1.0", result.pkg.versionName)
        assertEquals("下载地址应走安卓字段", "https://example.com/companion.apk", result.pkg.downloadUrl)
    }
}
