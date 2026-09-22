package com.qingyu.companion.ui.groups

import org.junit.Assert.assertEquals
import org.junit.Test

/** 群成员排序（S6-01f 第 1 项）JVM 单测。 */
class GroupMembersTest {

    private val ids = listOf("c1", "c2", "c3")

    @Test
    fun `上移与下移调整顺序`() {
        assertEquals("首元素上移不变", ids, GroupMembers.moveUp(ids, 0))
        assertEquals("中间元素上移一位", listOf("c2", "c1", "c3"), GroupMembers.moveUp(ids, 1))
        assertEquals("末元素下移不变", ids, GroupMembers.moveDown(ids, 2))
        assertEquals("首元素下移一位", listOf("c2", "c1", "c3"), GroupMembers.moveDown(ids, 0))
    }

    @Test
    fun `越界移动返回原表不抛错`() {
        assertEquals("越界 from 原样返回", ids, GroupMembers.move(ids, 99, 0))
        assertEquals("越界 to 原样返回", ids, GroupMembers.move(ids, 0, -1))
    }

    @Test
    fun `添加成员去重并保持顺序`() {
        assertEquals("新增追加末尾", listOf("c1", "c2", "c3", "c4"), GroupMembers.add(ids, listOf("c4")))
        assertEquals("重复成员不追加", ids, GroupMembers.add(ids, listOf("c1")))
    }

    @Test
    fun `移除成员`() {
        assertEquals("移除指定成员", listOf("c1", "c3"), GroupMembers.remove(ids, "c2"))
        assertEquals("移除不存在成员不变", ids, GroupMembers.remove(ids, "cx"))
    }
}
