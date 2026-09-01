package com.qingyu.companion.ui.announcements

import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.model.Announcement
import com.qingyu.companion.ui.components.LoadState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * E-02 公告页 LoadState 投影单测：非空列表即「有内容」；
 * 网络类错误 + 上次列表 → Offline；无列表 → Error/Empty。
 */
class AnnouncementsLoadStateTest {

    private val items = listOf(
        Announcement(id = 1, title = "t", content = "c", createdAt = "2026-08-30", updatedAt = "2026-08-30"),
    )

    @Test
    fun `加载中无数据投影为Loading`() {
        assertEquals(
            LoadState.Loading,
            projectAnnouncementsLoadState(loading = true, error = null, items = emptyList()),
        )
    }

    @Test
    fun `非空列表投影为Content`() {
        val st = projectAnnouncementsLoadState(loading = false, error = null, items = items)
        assertEquals(LoadState.Content(items, refreshing = false), st)
    }

    @Test
    fun `空列表且未加载投影为Empty`() {
        assertEquals(
            LoadState.Empty,
            projectAnnouncementsLoadState(loading = false, error = null, items = emptyList()),
        )
    }

    @Test
    fun `失败且无列表投影为Error可重试性按错误类型`() {
        val retryable = projectAnnouncementsLoadState(loading = false, error = CompanionError.Offline(), items = emptyList())
        assertTrue((retryable as LoadState.Error).retryable)

        val fatal = projectAnnouncementsLoadState(loading = false, error = CompanionError.Unauthorized(), items = emptyList())
        assertFalse((fatal as LoadState.Error).retryable)
    }

    @Test
    fun `网络类失败但有上次列表投影为Offline`() {
        assertEquals(
            LoadState.Offline(items),
            projectAnnouncementsLoadState(loading = false, error = CompanionError.Offline(), items = items),
        )
    }
}
