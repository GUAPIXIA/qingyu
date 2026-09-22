package com.qingyu.companion.ui.groups

import com.qingyu.companion.chatcore.ChatGroupContextBlocks
import com.qingyu.companion.chatcore.LocalGroupGenerationUseCase

/**
 * 群生成设置映射（S6-01(f) 第 6 项：设置面接线）。
 *
 * 纯函数，JVM 可测。把 UI／设置层收集到的值映射为
 * [LocalGroupGenerationUseCase.GroupGenerationSettings]。
 *
 * **已知口径（S6-01 报告 §3.6 登记，不猜测）**：任务原文列举
 * `GroupGenerationSettings(contextLimit, maxMembersInContext, maxMessages, maxImages,
 * enableChatCompression, promptChars)`；但 chatcore 的 `GroupGenerationSettings` 数据类
 * **并无** `maxMembersInContext / maxMessages / maxImages / enableChatCompression /
 * promptChars` 字段（chatcore 禁改），只有 `contextLimit` 及人设／叙事字段。故本映射：
 * - `contextLimit` 从 `LocalSettingsRepository` 的 `context.contextBudget` 读真实值
 *   （当前非硬编码 PC 默认 8192）；
 * - 人设／叙事字段经 [GroupGenerationSettingsInput] 透传（人设接线归并行人格流）；
 * - 任务列举的其余五字段**在数据类中不存在**，无法按原样接线——登记为合流遗留
 *   （见报告「需主代理合流的接线点」）。
 */
object GroupSettingsMapper {

    /** PC 默认上下文上限（与 GroupGenerationSettings.contextLimit 缺省一致）。 */
    const val PC_DEFAULT_CONTEXT_LIMIT: Int = 8192

    /** 设置层收集到的群生成设置输入。 */
    data class GroupGenerationSettingsInput(
        val defaultPersonaId: String? = null,
        val activePersonaId: String? = null,
        val globalUserName: String = "",
        val globalUserDescription: String = "",
        val globalUserPersona: String = "",
        val personaInjection: ChatGroupContextBlocks.PersonaInjection? = null,
        val scenarioInjectionMode: String? = null,
        val enableThoughtFormat: Boolean = true,
        val omniscientNarrativeRules: String? = null,
        val defaultNarrativeMode: String? = null,
        /** 来自 `context.contextBudget` 的真实值；<= 0 时回退 PC 默认。 */
        val contextBudget: Int = PC_DEFAULT_CONTEXT_LIMIT,
    )

    /** 上下文上限：真实设置值，非法（<= 0）回退 PC 默认。 */
    fun contextLimitFrom(contextBudget: Int): Int =
        if (contextBudget > 0) contextBudget else PC_DEFAULT_CONTEXT_LIMIT

    /** 映射为群生成设置面。 */
    fun build(input: GroupGenerationSettingsInput): LocalGroupGenerationUseCase.GroupGenerationSettings =
        LocalGroupGenerationUseCase.GroupGenerationSettings(
            defaultPersonaId = input.defaultPersonaId,
            activePersonaId = input.activePersonaId,
            globalUserName = input.globalUserName,
            globalUserDescription = input.globalUserDescription,
            globalUserPersona = input.globalUserPersona,
            personaInjection = input.personaInjection,
            scenarioInjectionMode = input.scenarioInjectionMode,
            enableThoughtFormat = input.enableThoughtFormat,
            omniscientNarrativeRules = input.omniscientNarrativeRules,
            defaultNarrativeMode = input.defaultNarrativeMode,
            contextLimit = contextLimitFrom(input.contextBudget),
        )
}
