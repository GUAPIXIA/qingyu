package com.qingyu.companion.ui.sessions

import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.model.SessionPreview
import com.qingyu.companion.ui.components.LoadState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * E-02 会话列表 LoadState 投影单测（SessionsViewModel.loadState 使用的纯函数；
 * 全局会话页 SessionsScreen 与角色历史会话页 CharacterSessionsScreen 共用同一投影）。
 */
class SessionsLoadStateTest {

    private fun preview(id: String, characterId: String = "c1") = SessionPreview(
        id = id,
        characterId = characterId,
        characterName = "角色",
        title = "会话$id",
        createdAt = 0L,
        updatedAt = 1L,
        messageCount = 2,
        lastMessage = "你好",
    )

    private val sessions = listOf(preview("s1"), preview("s2"))

    @Test
    fun `加载中无数据投影为Loading`() {
        val st = projectSessionsLoadState(
            SessionsViewModel.UiState(sessions = emptyList(), loading = true),
        )
        assertEquals(LoadState.Loading, st)
    }

    @Test
    fun `非空会话列表投影为Content`() {
        val st = projectSessionsLoadState(
            SessionsViewModel.UiState(sessions = sessions, loading = false),
        )
        assertEquals(LoadState.Content(sessions, refreshing = false), st)
    }

    @Test
    fun `空列表且未加载投影为Empty`() {
        val st = projectSessionsLoadState(
            SessionsViewModel.UiState(sessions = emptyList(), loading = false),
        )
        assertEquals(LoadState.Empty, st)
    }

    @Test
    fun `网络类错误加缓存会话投影为Offline`() {
        val st = projectSessionsLoadState(
            SessionsViewModel.UiState(sessions = sessions, loading = false, pageError = CompanionError.Offline()),
        )
        assertEquals(LoadState.Offline(sessions), st)
    }

    @Test
    fun `非网络类错误即使有缓存也投影为Error且不可重试`() {
        val st = projectSessionsLoadState(
            SessionsViewModel.UiState(sessions = sessions, loading = false, pageError = CompanionError.Unauthorized()),
        )
        assertTrue(st is LoadState.Error)
        assertFalse((st as LoadState.Error).retryable)
    }
}
