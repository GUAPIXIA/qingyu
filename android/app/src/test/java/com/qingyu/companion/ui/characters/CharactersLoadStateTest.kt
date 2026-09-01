package com.qingyu.companion.ui.characters

import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.model.Character
import com.qingyu.companion.ui.components.LoadState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * E-02 角色页 LoadState 投影单测：非空角色列表即「有内容」；
 * 角色列表无本地缓存，失败且无数据一律 Error（Offline 仅在理论上有缓存时出现，
 * 这里验证无缓存时网络类错误也走 Error + 可重试）。
 */
class CharactersLoadStateTest {

    private val characters = listOf(
        Character(id = "c1", name = "角色一", description = "d"),
        Character(id = "c2", name = "角色二", description = "d"),
    )

    @Test
    fun `加载中无数据投影为Loading`() {
        assertEquals(
            LoadState.Loading,
            projectCharactersLoadState(loading = true, error = null, characters = emptyList()),
        )
    }

    @Test
    fun `非空角色列表投影为Content`() {
        val st = projectCharactersLoadState(loading = false, error = null, characters = characters)
        assertEquals(LoadState.Content(characters, refreshing = false), st)
    }

    @Test
    fun `空列表且未加载投影为Empty`() {
        assertEquals(
            LoadState.Empty,
            projectCharactersLoadState(loading = false, error = null, characters = emptyList()),
        )
    }

    @Test
    fun `失败且无数据投影为Error`() {
        val st = projectCharactersLoadState(loading = false, error = CompanionError.Offline(), characters = emptyList())
        assertTrue(st is LoadState.Error)
        assertTrue((st as LoadState.Error).retryable)
    }

    @Test
    fun `非重试类错误带数据投影为Error不伪装离线`() {
        val st = projectCharactersLoadState(loading = false, error = CompanionError.Unauthorized(), characters = characters)
        assertTrue(st is LoadState.Error)
        assertFalse((st as LoadState.Error).retryable)
    }
}
