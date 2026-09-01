package com.qingyu.companion.ui.groups

import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.model.GroupChat
import com.qingyu.companion.ui.components.LoadState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * E-02 群聊页 LoadState 投影单测：非空群列表即「有内容」；
 * 群列表无本地缓存，失败且无数据一律 Error；Unauthorized 不伪装成离线。
 */
class GroupsLoadStateTest {

    private val groups = listOf(
        GroupChat(id = "g1", name = "群聊一", memberIds = listOf("c1", "c2")),
        GroupChat(id = "g2", name = "群聊二", memberIds = listOf("c1")),
    )

    @Test
    fun `加载中无数据投影为Loading`() {
        assertEquals(
            LoadState.Loading,
            projectGroupsLoadState(loading = true, error = null, groups = emptyList()),
        )
    }

    @Test
    fun `非空群列表投影为Content`() {
        val st = projectGroupsLoadState(loading = false, error = null, groups = groups)
        assertEquals(LoadState.Content(groups, refreshing = false), st)
    }

    @Test
    fun `空列表且未加载投影为Empty`() {
        assertEquals(
            LoadState.Empty,
            projectGroupsLoadState(loading = false, error = null, groups = emptyList()),
        )
    }

    @Test
    fun `失败且无数据投影为Error可重试`() {
        val st = projectGroupsLoadState(loading = false, error = CompanionError.Timeout(), groups = emptyList())
        assertTrue(st is LoadState.Error)
        assertTrue((st as LoadState.Error).retryable)
    }

    @Test
    fun `非网络类错误即使有数据也投影为Error`() {
        val st = projectGroupsLoadState(loading = false, error = CompanionError.Unauthorized(), groups = groups)
        assertTrue(st is LoadState.Error)
        assertFalse((st as LoadState.Error).retryable)
    }
}
