package com.qingyu.companion.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * E-05 滚动跟随状态机纯函数单测：
 * - 位于底部（index 0）恒跟随、计数清零；
 * - 上滑超过阈值后脱离跟随，新 chunk 累计计数；
 * - 未达阈值保持原状；
 * - 「回到最新」恢复跟随并清零；
 * - 浮层显隐判定。
 */
class ChatScrollStateTest {

    private val bottom = ScrollSnapshot(firstVisibleItemIndex = 0)
    private val scrolledUp = ScrollSnapshot(firstVisibleItemIndex = FOLLOW_DETACH_THRESHOLD_ITEMS)
    private val slightlyUp = ScrollSnapshot(firstVisibleItemIndex = 1)

    @Test
    fun `底部新chunk保持跟随且不计数`() {
        val st = chatFollowTick(bottom, newContent = 1, previous = ChatFollowState())
        assertTrue(st.following)
        assertEquals(0, st.newCount)
    }

    @Test
    fun `上滑超阈值脱离跟随`() {
        val st = chatFollowTick(scrolledUp, newContent = 0, previous = ChatFollowState())
        assertFalse(st.following)
        assertEquals(0, st.newCount)
    }

    @Test
    fun `脱离后新chunk累计计数`() {
        val prev = chatFollowTick(scrolledUp, newContent = 0, previous = ChatFollowState())
        val st1 = chatFollowTick(scrolledUp, newContent = 1, previous = prev)
        assertEquals(1, st1.newCount)
        val st2 = chatFollowTick(scrolledUp, newContent = 2, previous = st1)
        assertEquals(3, st2.newCount)
    }

    @Test
    fun `跟随中即使未贴底也不计数`() {
        // 未达阈值且仍跟随（例如流式 chunk 短暂插入），计数保持 0
        val st = chatFollowTick(slightlyUp, newContent = 1, previous = ChatFollowState())
        assertTrue(st.following)
        assertEquals(0, st.newCount)
    }

    @Test
    fun `未达阈值已脱离时继续累计`() {
        val prev = chatFollowTick(scrolledUp, newContent = 0, previous = ChatFollowState())
        // 回到未达阈值位置但仍未贴底（如 index 1），保持脱离并累计
        val st = chatFollowTick(slightlyUp, newContent = 1, previous = prev)
        assertFalse(st.following)
        assertEquals(1, st.newCount)
    }

    @Test
    fun `回到底部清零计数并恢复跟随`() {
        val prev = ChatFollowState(following = false, newCount = 5)
        val st = chatFollowTick(bottom, newContent = 1, previous = prev)
        assertTrue(st.following)
        assertEquals(0, st.newCount)
    }

    @Test
    fun `点击回到最新重置状态`() {
        val st = chatFollowReset(ChatFollowState(following = false, newCount = 7))
        assertTrue(st.following)
        assertEquals(0, st.newCount)
    }

    @Test
    fun `浮层仅脱离跟随后显示`() {
        assertFalse(chatFollowOverlayVisible(ChatFollowState(following = true, newCount = 0)))
        assertTrue(chatFollowOverlayVisible(ChatFollowState(following = false, newCount = 3)))
        assertTrue(chatFollowOverlayVisible(ChatFollowState(following = false, newCount = 0)))
    }

    @Test
    fun `负数chunk不产生负计数`() {
        val prev = ChatFollowState(following = false, newCount = 2)
        val st = chatFollowTick(scrolledUp, newContent = -3, previous = prev)
        assertEquals(2, st.newCount)
    }
}
