package com.qingyu.companion.ui.groups

/**
 * 群成员排序（S6-01(f) 第 1 项）纯函数，JVM 可测。
 * 生成 `patchGroup(memberIds = …)` 所需的整表顺序；增删走 `addGroupMembers`／`removeGroupMember`。
 */
object GroupMembers {

    /** 把 [from] 索引的成员移到 [to] 索引（越界返回原表，不抛错）。 */
    fun move(memberIds: List<String>, from: Int, to: Int): List<String> {
        if (from < 0 || from >= memberIds.size) return memberIds
        if (to < 0 || to >= memberIds.size) return memberIds
        if (from == to) return memberIds
        val next = memberIds.toMutableList()
        val item = next.removeAt(from)
        next.add(to, item)
        return next
    }

    /** 上移一位（首元素上移为原表）。 */
    fun moveUp(memberIds: List<String>, index: Int): List<String> = move(memberIds, index, index - 1)

    /** 下移一位（末元素下移为原表）。 */
    fun moveDown(memberIds: List<String>, index: Int): List<String> = move(memberIds, index, index + 1)

    /** 追加成员（保持顺序，去重）。 */
    fun add(memberIds: List<String>, characterIds: List<String>): List<String> =
        memberIds + characterIds.filter { it !in memberIds }

    /** 移除成员。 */
    fun remove(memberIds: List<String>, characterId: String): List<String> =
        memberIds.filter { it != characterId }
}
