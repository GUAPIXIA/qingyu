package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-01 第 7 层：thought 语义架构契约
 * （对齐 `shared/thoughtContract.ts`）。
 *
 * 契约：`<thought>...</thought>` 只表示消息所属角色在当前情境中的内心活动，**不表示模型的推理过程**。
 * 单聊、全局叙事与群聊必须从本模块生成提示正文，防止多处文案漂移。
 *
 * 必须满足：第一人称「我」；只包含角色能知道/感受/怀疑/打算的事；
 * 不得出现模型、用户指令、系统提示、规则、上下文等元信息；不得复述分析过程；
 * 正文使用第三人称叙事时 thought 仍属焦点角色并保持第一人称；每条回复只输出一个简短 thought 块。
 */
object ChatThoughtContract {

    /** 契约要点（测试断言用；与提示文案同源维护）。 */
    val THOUGHT_CONTRACT_CLAUSES = listOf(
        "第一人称",
        "不超过 3 句",
        "不得包含模型推理",
        "写作计划",
        "规则分析",
        "上下文复述",
        "标签外",
    )

    /**
     * 生成 thought 契约提示正文（不含界面层的【输出格式…】抬头与换行包装）。
     *
     * @param subjectName 思考主体的展示名（含书名号等修饰由调用方决定）。
     *   全局叙事：焦点角色/speaker；沉浸模式：回应角色/speaker。缺省 = 通用措辞。
     */
    fun buildThoughtContractBody(narrativeMode: String, subjectName: String? = null): String {
        val name = subjectName ?: ""
        if (narrativeMode == "omniscient") {
            val subject = name.ifEmpty { "当前对话角色" }
            return "正文仍保持第三人称叙事。每轮必须输出且只输出一组 <thought>...</thought>，" +
                "它仅表示当前焦点角色${subject}的第一人称内心独白，必须切换到 $subject 自己的“我”来思考" +
                "（禁止用旁白/第三人称“他/她”写这段心理），保持简短且不超过 3 句；" +
                "不得包含模型推理、写作计划、规则分析、上下文复述或正文草稿。不要一次泄露所有人物的隐私想法。" +
                "完整的实际叙事必须放在标签外。"
        }
        val self = name.ifEmpty { "该角色" }
        return "每轮必须输出且只输出一组 <thought>...</thought>，它仅表示当前回应角色的第一人称私密内心独白，" +
            "必须使用 $self 自己的“我”来思考（禁止用旁白/第三人称“他/她”写这段心理），保持简短且不超过 3 句；" +
            "不得包含模型推理、写作计划、规则分析、上下文复述或正文草稿。完整的实际对话和行动必须放在标签外。"
    }
}
