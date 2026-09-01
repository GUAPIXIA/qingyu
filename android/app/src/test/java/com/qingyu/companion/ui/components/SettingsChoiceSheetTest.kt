package com.qingyu.companion.ui.components

import com.qingyu.companion.data.ThemeMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A-02 选择行去重纯函数单测（JVM，不依赖 Compose/Android）：
 * 覆盖「选择新值产生回调值」与「重复选择当前项不产生写入（返回 null）」。
 */
class SettingsChoiceSheetTest {

    @Test
    fun `选择非当前值返回新值`() {
        assertEquals(ThemeMode.LIGHT, resolveChoiceSelection(ThemeMode.SYSTEM, ThemeMode.LIGHT))
        assertEquals(ThemeMode.DARK, resolveChoiceSelection(ThemeMode.LIGHT, ThemeMode.DARK))
    }

    @Test
    fun `重复选择当前项返回null不产生写入`() {
        assertNull(resolveChoiceSelection(ThemeMode.SYSTEM, ThemeMode.SYSTEM))
        assertNull(resolveChoiceSelection(ThemeMode.DARK, ThemeMode.DARK))
    }

    @Test
    fun `字符串与自定义类型同样按相等性去重`() {
        assertEquals("b", resolveChoiceSelection("a", "b"))
        assertNull(resolveChoiceSelection("a", "a"))
        assertEquals(listOf(1, 2), resolveChoiceSelection(listOf(3), listOf(1, 2)))
        assertNull(resolveChoiceSelection(listOf(1, 2), listOf(1, 2)))
    }
}
