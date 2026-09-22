package com.qingyu.companion.ui.groups

import org.junit.Assert.assertEquals
import org.junit.Test

/** 群生成设置映射（S6-01(f) 第 6 项：从 LocalSettingsRepository 读真实值）JVM 单测。 */
class GroupSettingsMapperTest {

    @Test
    fun `contextLimit 取设置真实值（不再硬编码 PC 默认）`() {
        assertEquals("正数设置值原样生效", 16384, GroupSettingsMapper.contextLimitFrom(16384))
    }

    @Test
    fun `contextLimit 非法值回退 PC 默认 8192`() {
        assertEquals("零值回退 PC 默认", 8192, GroupSettingsMapper.contextLimitFrom(0))
        assertEquals("负值回退 PC 默认", 8192, GroupSettingsMapper.contextLimitFrom(-5))
    }

    @Test
    fun `build 把 contextBudget 映射进 contextLimit`() {
        val settings = GroupSettingsMapper.build(
            GroupSettingsMapper.GroupGenerationSettingsInput(contextBudget = 4096),
        )
        assertEquals("设置值进入群生成设置面", 4096, settings.contextLimit)
    }

    @Test
    fun `build 缺省上下文即 PC 默认 8192（口径登记）`() {
        val settings = GroupSettingsMapper.build(GroupSettingsMapper.GroupGenerationSettingsInput())
        assertEquals("缺省 contextLimit 与 PC 默认一致", 8192, settings.contextLimit)
    }

    @Test
    fun `build 透传用户与叙事字段`() {
        val settings = GroupSettingsMapper.build(
            GroupSettingsMapper.GroupGenerationSettingsInput(
                globalUserName = "小明",
                defaultNarrativeMode = "omniscient",
                enableThoughtFormat = false,
            ),
        )
        assertEquals("用户名透传", "小明", settings.globalUserName)
        assertEquals("叙事模式透传", "omniscient", settings.defaultNarrativeMode)
        assertEquals("思考格式开关透传", false, settings.enableThoughtFormat)
    }
}
