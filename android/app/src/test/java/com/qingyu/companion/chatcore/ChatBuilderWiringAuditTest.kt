package com.qingyu.companion.chatcore

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 阶段 4：**装配器输入接线审计**。
 *
 * ## 为什么需要它
 * 「功能在、接线不在」是本阶段反复出现的缺陷类型，且**编译期与常规门禁都不会报错**：
 * - `recordUsage` 没有任何生产调用者 → 用量页永远 0；
 * - 世界书检索/渲染模块只被测试使用 → 绑定了世界书却一条都不注入；
 * - 会话预设从未传给装配器 → 用户设了预设毫无效果；
 * - 会话人设从未传给装配器 → 同上。
 *
 * 它们都不是「写错了」，而是「没接上」——逐个靠人工发现太慢，因此这里做机械审计：
 * 扫描 `ChatContextBuilder` 的四类快照字段，要求每个字段**要么**在
 * `LocalChatGenerationUseCase` 里被显式赋值，**要么**出现在下面的「尚未接线」清单里
 * 并写明原因与归属阶段。
 *
 * 于是「新增一个装配器输入却忘了接线」会立刻让本测试变红，迫使作者做一次明确决定
 * （接线，或登记到清单里并说明为什么还不接）。
 */
class ChatBuilderWiringAuditTest {

    /**
     * 尚未接线的字段 → 原因。
     *
     * 这份清单是**已知缺口的有名有姓的记录**，不是免责声明：每一条都应能在实施报告里
     * 找到对应说明，接线后必须从清单删除（删除后审计仍然通过）。
     */
    private val notWiredYet: Map<String, String> = mapOf(
        // v3 已接通：narrativeMode / responseLengthMode / recentTriggeredIds /
        // lorebookCompressionCache / compressedSummary / compressedRange（已从清单移除）——
        // 本条注释保留是为了说明「接线后必须删条目」，清理动作由本测试的腐烂检查强制。
        "defaultNarrativeMode" to "全局叙事模式无设置键（需补 key + UI）",
        "omniscientNarrativeRules" to "全局叙事规则无设置键（需补 key + UI）",
        // 思考格式 / 对话示例位置与模式：全局设置为阶段 5 内容管理范围；
        // 预设级同名项已通过预设接线生效。
        "enableThoughtFormat" to "全局设置为阶段 5 范围；预设级已生效",
        "exampleDialogPosition" to "全局设置为阶段 5 范围；预设级已生效",
        "exampleDialogMode" to "全局设置为阶段 5 范围；预设级已生效",
        // 上下文压缩设置：本地设置键尚未定义（PublicSettingKey 无此键）。
        "contextCompressionEnabled" to "本地设置键尚未定义（需补 PublicSettingKey + UI）",
        "contextCompressionMinDropTokens" to "本地设置键尚未定义（需补 PublicSettingKey + UI）",
        // 语义命中：向量层属阶段 6 §S6-05；阶段 4 只要求「不可用时降级到非向量路径」（已测）。
        "semanticFactsHits" to "向量层属阶段 6 §S6-05；阶段 4 只要求降级（已覆盖）",
        // 角色侧未接线字段：内容管理属阶段 5 §S5-01（角色卡扩展字段 extensions_json 的 schema）
        "authorNote" to "角色作者注释属阶段 5 §S5-01（extensions_json schema）",
        "postHistoryInstructions" to "属阶段 5 §S5-01（角色卡扩展字段）",
        "systemPrompt" to "角色级系统提示属阶段 5 §S5-01（角色卡扩展字段）",
        "translatedContent" to "翻译内容未持久化（阶段 5/6）",
    )

    private fun sourceOf(relative: String): File {
        val candidates = listOf(File("src/main/java/com/qingyu/companion/$relative"), File("app/src/main/java/com/qingyu/companion/$relative"))
        return candidates.firstOrNull { it.exists() }
            ?: error("找不到源文件 $relative（工作目录=${File(".").absolutePath}）")
    }

    private fun fieldsOf(source: File, snapshotName: String): List<String> {
        val text = source.readText()
        val start = text.indexOf("data class $snapshotName(")
        assertTrue("必须定位到 $snapshotName", start >= 0)
        // 取到该类声明结束（下一个顶层 data class 之前）
        val rest = text.substring(start + 1)
        val end = rest.indexOf("\n    data class ")
        val block = if (end > 0) rest.substring(0, end) else rest
        return Regex("val (\\w+)\\s*:").findAll(block).map { it.groupValues[1] }.toList()
    }

    /**
     * 允许被显式写成裸 `null` 的字段。
     *
     * 其余字段若只写成 `x = null`，视为**没有真正接线**：那正是本审计要防的
     * 「字段出现了、但什么都不传」。最初的版本只检查「字段名是否出现」，
     * 突变验证时被 `= null` 平凡满足（守卫照样通过），因此这里要求非空来源。
     */
    private val allowedNullWiring: Set<String> = setOf(
        // 指令模板是否使用由模型能力决定，Android 侧暂无该判定来源，显式置空是有意为之
        "useInstructTemplate",
    )

    /** 字段是否被**有意义地**接线：出现赋值，且不是裸 `null`。 */
    private fun wiredMeaningfully(useCaseText: String, field: String): Boolean {
        val assignment = Regex("\\b$field\\s*=([^,\\n]*)").find(useCaseText) ?: return false
        val expression = assignment.groupValues[1].trim()
        if (expression.isEmpty()) return false
        return !(expression == "null" && !allowedNullWiring.contains(field))
    }

    @Test
    fun everyBuilderInputIsWiredOrExplicitlyDeferred() {
        val builder = sourceOf("chatcore/ChatContextBuilder.kt")
        val useCaseText = sourceOf("chatcore/LocalChatGenerationUseCase.kt").readText()

        val snapshots = listOf(
            "SettingsSnapshot",
            "SessionSnapshot",
            "CharacterSnapshot",
            "ChatSnapshot",
            "ProfileSnapshot",
        )
        val allFields = snapshots.flatMap { fieldsOf(builder, it) }
        assertTrue("必须扫描到装配器输入字段（否则审计空跑）", allFields.size >= 30)

        val unwired = mutableListOf<String>()
        for (field in allFields) {
            if (!wiredMeaningfully(useCaseText, field) && !notWiredYet.containsKey(field)) {
                unwired += field
            }
        }
        assertTrue(
            "以下装配器输入既未在 LocalChatGenerationUseCase 中接线，也未登记为「尚未接线」：$unwired\n" +
                "要么接上（多数情况是几行代码），要么在 notWiredYet 里写明原因与归属阶段。",
            unwired.isEmpty(),
        )
    }

    @Test
    fun deferredListEntriesCarryReasonsAndAreNotStale() {
        val builder = sourceOf("chatcore/ChatContextBuilder.kt")
        val useCaseText = sourceOf("chatcore/LocalChatGenerationUseCase.kt").readText()
        val snapshots = listOf("SettingsSnapshot", "SessionSnapshot", "CharacterSnapshot", "ChatSnapshot", "ProfileSnapshot")
        val allFields = snapshots.flatMap { fieldsOf(builder, it) }.toSet()

        for ((field, reason) in notWiredYet) {
            assertTrue("清单里的 $field 已不是装配器输入（应删除该条目）", allFields.contains(field))
            assertTrue("$field 的原因必须写清楚（含归属或待补项）", reason.length >= 10)
            // 已接线却留在清单里 → 清单会腐烂，必须清理
            assertTrue(
                "清单里的 $field 其实已经接线了，请从 notWiredYet 删除",
                !wiredMeaningfully(useCaseText, field),
            )
        }
    }

    @Test
    fun presetAndPersonaAndLorebookAreWired() {
        // 这三项是 S4-04 明确要求的「会话级预设/人设/世界书」，必须保持接线
        val useCase = sourceOf("chatcore/LocalChatGenerationUseCase.kt").readText()
        assertTrue("会话预设必须接线", useCase.contains("preset = sessionPreset"))
        assertTrue("人设必须接线", wiredMeaningfully(useCase, "personaInjection"))
        assertTrue("人设描述必须接线", wiredMeaningfully(useCase, "userDescription"))
        assertTrue("人设性格必须接线", wiredMeaningfully(useCase, "userPersona"))
        assertTrue("世界书必须接线", useCase.contains("lorebooks = activeLorebookBooks"))
        assertTrue("会话绑定的世界书 id 必须传入", useCase.contains("activeLorebookIds = activeLorebookIds"))
    }

    @Test
    fun sessionRuntimeStateHasAWriterNotJustAColumn() {
        // 「有列 ≠ 有闭环」：v3 补了叙事模式列，若没有写入方，列永远是默认值。
        // 写入方必须同时存在于**仓库实现**与**UI 入口**，只在测试里写不算接通。
        val repository = sourceOf("data/local/LocalChatRepository.kt").readText()
        assertTrue(
            "本地仓库必须实现会话级叙事模式写入",
            repository.contains("override suspend fun patchSessionRuntimeState("),
        )
        val panel = sourceOf("ui/components/QuickSettingsPanel.kt").readText()
        assertTrue(
            "快捷设置面板必须提供会话级叙事模式入口（否则用户无从切换）",
            panel.contains("patchSessionRuntimeState("),
        )
        assertTrue("面板必须读取当前会话的叙事模式", panel.contains("getSessionNarrativeMode("))
        // 接口默认实现必须**明确失败**而不是静默成功：伴侣模式没有该端点，
        // 静默成功会让用户以为设置生效了（本阶段反复出现的「按钮在、功能不在」）
        val iface = sourceOf("data/ChatRepository.kt").readText()
        assertTrue(
            "接口默认实现必须明确拒绝而不是静默成功",
            iface.contains("当前数据源不支持会话级叙事模式"),
        )
    }
}
