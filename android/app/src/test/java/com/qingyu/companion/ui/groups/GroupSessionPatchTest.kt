package com.qingyu.companion.ui.groups

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 群／会话补丁白名单与模式切换（S6-01(f) 第 2 项）JVM 单测。 */
class GroupSessionPatchTest {

    @Test
    fun `模式切换接受 mention polling free 三种`() {
        assertEquals(mapOf("chatMode" to "mention"), GroupSessionPatch.chatModePatch("mention"))
        assertEquals(mapOf("chatMode" to "polling"), GroupSessionPatch.chatModePatch("polling"))
        assertEquals(mapOf("chatMode" to "free"), GroupSessionPatch.chatModePatch("free"))
    }

    @Test
    fun `非法模式被拒绝而不是静默纠正`() {
        val err = runCatching { GroupSessionPatch.chatModePatch("natural") }.exceptionOrNull()
        assertTrue("越界模式必须报错", err is IllegalArgumentException)
    }

    @Test
    fun `每成员发言间隔负值被拒绝`() {
        val err = runCatching { GroupSessionPatch.speakerIntervalPatch(-1) }.exceptionOrNull()
        assertTrue("负间隔必须报错", err is IllegalArgumentException)
        assertEquals("非负间隔通过", mapOf("speakerInterval" to 0), GroupSessionPatch.speakerIntervalPatch(0))
    }

    @Test
    fun `接力轮数下限为一`() {
        val err = runCatching { GroupSessionPatch.maxRoundsPatch(0) }.exceptionOrNull()
        assertTrue("零轮必须报错", err is IllegalArgumentException)
    }

    @Test
    fun `白名单越界键报错而不是静默丢弃`() {
        val err = runCatching {
            GroupSessionPatch.requireWhitelisted(mapOf("hack" to 1), GroupSessionPatch.GROUP_KEYS)
        }.exceptionOrNull()
        assertTrue("未知键必须报错", err is IllegalArgumentException)
    }

    @Test
    fun `模式切换补丁键都在群白名单内`() {
        val patch = GroupSessionPatch.chatModePatch("free") +
            GroupSessionPatch.autoModePatch(true) +
            GroupSessionPatch.speakerIntervalPatch(2000)
        runCatching { GroupSessionPatch.requireWhitelisted(patch, GroupSessionPatch.GROUP_KEYS) }
            .onFailure { throw AssertionError("模式切换补丁必须落在群白名单内", it) }
        assertTrue("含 autoMode", patch.containsKey("autoMode"))
    }

    @Test
    fun `成员排序补丁用 memberIds 整表覆盖`() {
        val patch = GroupSessionPatch.memberOrderPatch(listOf("c2", "c1"))
        assertEquals(listOf("c2", "c1"), patch["memberIds"])
    }

    @Test
    fun `叙事模式只接受 immersive omniscient 与跟随默认（数据层口径）`() {
        assertEquals(mapOf("narrativeMode" to "immersive"), GroupSessionPatch.narrativeModePatch("immersive"))
        assertEquals(mapOf("narrativeMode" to "omniscient"), GroupSessionPatch.narrativeModePatch("omniscient"))
        assertEquals(mapOf("narrativeMode" to ""), GroupSessionPatch.narrativeModePatch(""))
        val err = runCatching { GroupSessionPatch.narrativeModePatch("second") }.exceptionOrNull()
        assertTrue("第四种叙事模式在数据层被拒绝", err is IllegalArgumentException)
    }

    @Test
    fun `会话记忆补丁键落在会话白名单内`() {
        val patch = GroupSessionPatch.memoryPatch(enabled = true, mode = "auto", autoInterval = 5)
        assertEquals(true, patch["memoryEnabled"])
        assertEquals("auto", patch["memoryMode"])
        assertEquals(5, patch["autoMemoryInterval"])
        runCatching { GroupSessionPatch.requireWhitelisted(patch, GroupSessionPatch.SESSION_KEYS) }
            .onFailure { throw AssertionError("会话记忆补丁必须落在会话白名单内", it) }
    }

    @Test
    fun `群键与会话键不相交（避免 group 级键误塞进会话补丁）`() {
        assertTrue("两白名单不重叠", GroupSessionPatch.GROUP_KEYS.intersect(GroupSessionPatch.SESSION_KEYS).isEmpty())
        assertFalse("chatMode 是群键", "chatMode" in GroupSessionPatch.SESSION_KEYS)
        assertFalse("narrativeMode 是会话键", "narrativeMode" in GroupSessionPatch.GROUP_KEYS)
    }
}
