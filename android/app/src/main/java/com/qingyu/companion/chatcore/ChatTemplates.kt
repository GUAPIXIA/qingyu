package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-01：Instruct 模板配置
 * （对齐 `shared/chat-core/chatTemplates.ts`）。
 *
 * 已知模型的输入/输出包装格式映射。主要用于 Ollama 自部署模型
 * （模板模式时 Ollama 走纯文本补全接口）。OpenAI / Claude / Gemini 本身是
 * messages 数组格式，不需要额外包装。
 *
 * 注意 `TEMPLATE_MAP` 的**插入顺序即模糊匹配的优先级**，因此必须用 `linkedMapOf`：
 * PC 侧 `Object.entries` 保持插入顺序，换成 `mapOf` 会打乱匹配结果。
 */
object ChatTemplates {

    data class InstructTemplate(
        val systemPrefix: String = "",
        val systemSuffix: String = "",
        val userPrefix: String = "",
        val userSuffix: String = "",
        val assistantPrefix: String = "",
        val assistantSuffix: String = "",
        /** 仅部分模板/提供商使用；缺省为 null（对应 PC 的 undefined）。 */
        val systemAsTopLevel: Boolean? = null,
        val stopSequences: List<String> = emptyList(),
        val appendAssistantPrefix: Boolean = false,
    )

    private val DEFAULT_TEMPLATE = InstructTemplate()

    private val TEMPLATE_MAP: Map<String, InstructTemplate> = linkedMapOf(
        // ===== ChatML（Qwen / DeepSeek 官方格式）=====
        "chatml" to InstructTemplate(
            systemPrefix = "<|im_start|>system\n",
            systemSuffix = "<|im_end|>\n",
            userPrefix = "<|im_start|>user\n",
            userSuffix = "<|im_end|>\n",
            assistantPrefix = "<|im_start|>assistant\n",
            assistantSuffix = "<|im_end|>\n",
            stopSequences = listOf("<|im_end|>", "<|im_start|>"),
            appendAssistantPrefix = true,
        ),
        "qwen" to InstructTemplate(
            systemPrefix = "<|im_start|>system\n",
            systemSuffix = "<|im_end|>\n",
            userPrefix = "<|im_start|>user\n",
            userSuffix = "<|im_end|>\n",
            assistantPrefix = "<|im_start|>assistant\n",
            assistantSuffix = "<|im_end|>\n",
            stopSequences = listOf("<|im_end|>", "<|im_start|>"),
            appendAssistantPrefix = true,
        ),
        "deepseek" to InstructTemplate(
            systemPrefix = "<|im_start|>system\n",
            systemSuffix = "<|im_end|>\n",
            userPrefix = "<|im_start|>user\n",
            userSuffix = "<|im_end|>\n",
            assistantPrefix = "<|im_start|>assistant\n",
            assistantSuffix = "<|im_end|>\n",
            stopSequences = listOf("<|im_end|>", "<|im_start|>"),
            appendAssistantPrefix = true,
        ),
        // ===== Llama 系列 =====
        "llama2" to InstructTemplate(
            systemPrefix = "[INST] <<SYS>>\n",
            systemSuffix = "\n<</SYS>>\n\n",
            userPrefix = "[INST] ",
            userSuffix = " [/INST]",
            assistantPrefix = "",
            assistantSuffix = "</s>",
            stopSequences = listOf("</s>", "[INST]"),
            appendAssistantPrefix = false,
        ),
        "llama3" to InstructTemplate(
            systemPrefix = "<|start_header_id|>system<|end_header_id|>\n\n",
            systemSuffix = "<|eot_id|>",
            userPrefix = "<|start_header_id|>user<|end_header_id|>\n\n",
            userSuffix = "<|eot_id|>",
            assistantPrefix = "<|start_header_id|>assistant<|end_header_id|>\n\n",
            assistantSuffix = "<|eot_id|>",
            stopSequences = listOf("<|eot_id|>", "<|start_header_id|>"),
            appendAssistantPrefix = true,
        ),
        "command-r" to InstructTemplate(
            systemPrefix = "<|START_OF_TURN_TOKEN|><|SYSTEM_TOKEN|>",
            systemSuffix = "<|END_OF_TURN_TOKEN|>",
            userPrefix = "<|START_OF_TURN_TOKEN|><|USER_TOKEN|>",
            userSuffix = "<|END_OF_TURN_TOKEN|>",
            assistantPrefix = "<|START_OF_TURN_TOKEN|><|CHATBOT_TOKEN|>",
            assistantSuffix = "<|END_OF_TURN_TOKEN|>",
            stopSequences = listOf("<|END_OF_TURN_TOKEN|>"),
            appendAssistantPrefix = true,
        ),
        "mistral" to InstructTemplate(
            systemPrefix = "",
            systemSuffix = "",
            userPrefix = "[INST] ",
            userSuffix = " [/INST]",
            assistantPrefix = "",
            assistantSuffix = "</s>",
            stopSequences = listOf("</s>", "[INST]"),
            appendAssistantPrefix = false,
        ),
        // Phi-3 系列
        "phi3" to InstructTemplate(
            systemPrefix = "<|system|>\n",
            systemSuffix = "<|end|>\n",
            userPrefix = "<|user|>\n",
            userSuffix = "<|end|>\n",
            assistantPrefix = "<|assistant|>\n",
            assistantSuffix = "<|end|>\n",
            stopSequences = listOf("<|end|>", "<|user|>"),
            appendAssistantPrefix = true,
        ),
        // ===== Alpaca =====
        "alpaca" to InstructTemplate(
            systemPrefix = "",
            systemSuffix = "\n\n",
            userPrefix = "### Instruction:\n",
            userSuffix = "\n\n### Response:\n",
            assistantPrefix = "",
            assistantSuffix = "\n\n",
            stopSequences = listOf("### Instruction:", "### Response:"),
            appendAssistantPrefix = false,
        ),
        // ===== Gemma =====
        "gemma" to InstructTemplate(
            systemPrefix = "",
            systemSuffix = "",
            userPrefix = "<start_of_turn>user\n",
            userSuffix = "<end_of_turn>\n",
            assistantPrefix = "<start_of_turn>model\n",
            assistantSuffix = "<end_of_turn>\n",
            stopSequences = listOf("<end_of_turn>", "<start_of_turn>"),
            appendAssistantPrefix = true,
        ),
    )

    /** 内置模板名列表（供预设 UI 展示）。 */
    val BUILTIN_TEMPLATE_NAMES: List<String> = TEMPLATE_MAP.keys.sorted()

    /** 按模板名解析（未知名称返回 null）。 */
    fun getTemplateByName(name: String?): InstructTemplate? {
        if (name.isNullOrEmpty()) return null
        return TEMPLATE_MAP[name.lowercase().trim()]
    }

    /**
     * 解析生效的 instruct 模板：预设指定 > profile 自动推断 > 无。
     */
    fun resolveEffectiveTemplate(
        contextTemplate: String?,
        provider: String,
        model: String,
        useInstructTemplate: Boolean?,
    ): InstructTemplate? {
        getTemplateByName(contextTemplate)?.let { return it }
        if (useInstructTemplate == true) return getInstructTemplate(provider, model)
        return null
    }

    /**
     * 按 provider/model 推断模板。
     *
     * 与 PC 一致：只识别 provider 字面量 `claude` / `gemini`（`systemAsTopLevel = true`）。
     * **Android 的连接档案使用 wire 名 `anthropic`**，因此调用方必须在传入前映射
     * `anthropic → claude`，否则会拿到空默认模板而丢失顶层 system 语义。
     * 该差异由 fixture 中的 provider 用例显式锁定。
     */
    fun getInstructTemplate(provider: String, model: String): InstructTemplate {
        val lowerModel = model.lowercase()
        val lowerProvider = provider.lowercase()

        // 精确模型名匹配
        TEMPLATE_MAP[lowerModel]?.let { return it }

        // 模糊匹配（按插入顺序，首个命中即返回）
        for ((key, template) in TEMPLATE_MAP) {
            if (lowerModel.contains(key)) return template
        }

        // 按提供商默认行为
        if (lowerProvider == "claude") return DEFAULT_TEMPLATE.copy(systemAsTopLevel = true)
        if (lowerProvider == "gemini") return DEFAULT_TEMPLATE.copy(systemAsTopLevel = true)

        return DEFAULT_TEMPLATE
    }

    data class WrappedPrompt(val text: String, val stopSequences: List<String>)

    /**
     * 按模板将消息数组包装为单个纯文本（用于原始补全接口，如 Ollama 生成端点）。
     * 未知 role 一律跳过（与 PC 的 if/else 链一致，不落到任何分支）。
     */
    fun applyInstructTemplate(
        messages: List<InstructMessage>,
        template: InstructTemplate,
    ): WrappedPrompt {
        val text = StringBuilder()
        for (message in messages) {
            when (message.role) {
                "system" -> text.append(template.systemPrefix).append(message.content).append(template.systemSuffix)
                "user" -> text.append(template.userPrefix).append(message.content).append(template.userSuffix)
                "assistant" -> text.append(template.assistantPrefix).append(message.content)
                    .append(template.assistantSuffix)
                else -> Unit
            }
        }
        // appendAssistantPrefix：追加空 assistant 前缀，引导模型续写
        if (template.appendAssistantPrefix) text.append(template.assistantPrefix)
        return WrappedPrompt(text.toString(), template.stopSequences)
    }
}

/** 模板包装所需的最小消息形状（与 PC 的 `{ role, content }` 对应）。 */
data class InstructMessage(val role: String, val content: String)
