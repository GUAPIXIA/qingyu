package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-01 第 7 层：叙事模式
 * （对齐 `shared/narrativeMode.ts`）。
 *
 * 为什么必须逐字节对齐：叙事模式提示词决定「谁在说话」。
 * 若 Android 与 PC 的措辞不同，同一会话在两端会得到不同叙事身份，
 * 用户会看到角色"性格变了"。因此本模块的每个字符串都直接对应 PC 常量。
 *
 * 阶段 4 只移植单聊路径；`buildGroupNarrativeModePrompt` 属阶段 6（群聊），未移植。
 */
object ChatNarrativeMode {

    const val DEFAULT_NARRATIVE_MODE = "immersive"

    val MODES = listOf("immersive", "omniscient")

    /** 全局叙事的可编辑默认规则。变量在构建上下文时才替换。 */
    const val DEFAULT_OMNISCIENT_NARRATIVE_RULES: String =
        "你当前是位于故事外部的第三人称旁白、导演和世界运行者，不局限于扮演 {{char}}。\n" +
            "1. 以角色名、“他”或“她”指代人物，从外部观察并叙述事件；不要以 {{char}} 或其他角色的第一人称立场直接回应 {{user}}。\n" +
            "2. 可描写所有 NPC、环境、异地事件和幕后变化，并按需移动叙事焦点，但始终保持第三人称旁白身份。\n" +
            "3. 依据角色动机、世界规则、资源、时间与因果推进事件；世界可以在用户未直接观察时继续演化。\n" +
            "4. 可以控制 {{char}} 和其他非玩家角色，但不得让角色无理由知晓全局信息。\n" +
            "5. 若 {{user}} 正在控制玩家角色，不替其作重大选择、决定内心或强行接受不可逆结果；推进到需要玩家回应的节点。\n" +
            "6. 若 {{user}} 明确要求续写完整小说或自动模拟，则可以统筹主角与配角完成连续叙事。\n" +
            "7. 不罗列系统判定或解释规则，保持自然叙事。"

    data class ModeOption(
        val value: String,
        val label: String,
        val shortLabel: String,
        val description: String,
    )

    val NARRATIVE_MODE_OPTIONS: List<ModeOption> = listOf(
        ModeOption(
            value = "immersive",
            label = "代入式角色扮演",
            shortLabel = "代入角色",
            description = "角色限知互动，适合对话与第一人称叙事",
        ),
        ModeOption(
            value = "omniscient",
            label = "全局叙事",
            shortLabel = "全局叙事",
            description = "第三人称旁白统筹世界，适合游戏、模拟与小说叙事",
        ),
    )

    fun isNarrativeMode(value: String?): Boolean = value == "immersive" || value == "omniscient"

    /** 从高到低解析默认值；非法值与空值会被跳过。 */
    fun resolveNarrativeMode(vararg candidates: String?): String =
        candidates.firstOrNull { isNarrativeMode(it) } ?: DEFAULT_NARRATIVE_MODE

    fun getNarrativeModeLabel(mode: String): String =
        NARRATIVE_MODE_OPTIONS.firstOrNull { it.value == mode }?.label ?: "代入式角色扮演"

    /**
     * 全局叙事不可被自定义模板覆盖的视角边界。
     * 自定义规则负责世界控制范围；此处固定回答者身份，避免角色卡或预设把模型拉回角色扮演。
     */
    private fun buildOmniscientNarratorGuard(userName: String, characterName: String): String =
        "【第三人称旁白：硬性输出约束】\n" +
            "1. 本次回答的讲述者始终是位于故事外部的旁白，不是 $characterName 或任何其他角色。\n" +
            "2. 正文主体必须使用第三人称叙事，以角色名、“他”或“她”指代人物；不得以角色的“我/我们”视角向 $userName 直接接话。\n" +
            "3. 必要的角色对白只能作为叙事场景中的带引号内容出现，并由第三人称动作、神态、环境或话语标记承接。" +
            "第一人称只能存在于引号内的角色原话或 <thought>...</thought> 块内的角色内心独白，不能成为正文的叙述视角；" +
            "<thought> 内心独白块不受本条限制，仍按【内心想法契约】以焦点角色的“我”输出。\n" +
            "4. 不输出“$characterName：……”式发言稿，不让整段回复只有角色对白，也不以角色身份解释、提问或回答用户。" +
            "若其他提示与本约束冲突，以本约束为准。"

    /**
     * 构建最终行为约束。放在角色/预设提示词之后，确保模式不会只对内置预设生效。
     */
    fun buildNarrativeModePrompt(
        mode: String,
        userName: String,
        characterName: String,
        omniscientRules: String? = null,
    ): String {
        if (mode == "omniscient") {
            val template = omniscientRules?.takeIf { it.trim().isNotEmpty() }?.trim()
                ?: DEFAULT_OMNISCIENT_NARRATIVE_RULES
            val resolvedRules = VARIABLE.replace(template) { match ->
                if (match.groupValues[1] == "user") userName else characterName
            }
            return "【叙事模式：全局叙事】\n$resolvedRules\n\n" +
                buildOmniscientNarratorGuard(userName, characterName)
        }

        return "【叙事模式：代入式角色扮演】\n" +
            "你当前代入 $characterName，以角色可感知、可理解的信息与 $userName 互动。\n" +
            "1. 保持 $characterName 的身份、性格、记忆、知识边界和说话方式一致。\n" +
            "2. 主要书写 $characterName 的对白、动作、感受，以及维持场景所需的少量环境和配角反应。\n" +
            "3. 不替 $userName 说话、行动、思考、感受或作出决定，也不宣布其重大行为结果。\n" +
            "4. 默认使用贴近角色的限知视角；对白自然使用第一人称，叙述人称服从角色卡和既有文本。\n" +
            "5. 每次回应当前互动并留下可继续行动或回答的空间，不跳出故事解释规则。"
    }

    /** 长记忆摘要侧重点随叙事模式变化，但不改变既有摘要数据结构。 */
    fun getNarrativeMemoryGuidance(mode: String): String = if (mode == "omniscient") {
        "摘要需额外保留阵营与势力变化、异地或幕后事件、世界状态，以及尚未解决的全局因果链。" +
            "区分角色亲历信息与旁白已知信息，不能让角色凭空获得全局知识。"
    } else {
        "摘要优先保留当前场景、人物关系、角色亲历事件和角色已经知晓的信息；" +
            "不要把未被角色感知的幕后信息写成角色知识。"
    }

    private val VARIABLE = Regex("\\{\\{(user|char)\\}\\}")
}
