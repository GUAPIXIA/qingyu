package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-01 第 8 层：生成回复统一收尾管线与异常终止协调
 * （对齐 `shared/chat-core/generatedReplyPipeline.ts`）。
 *
 * 唯一的处理顺序：
 * 1. 供应商推理残留清理；2. output 正则；3. 停止字符串；4. 收尾器；
 * 5. 必要时一次短补尾；6. 续写重叠去重（由续写入口自行执行）。
 *
 * 桌面单聊、消息续写、群聊与 Bridge 都必须经过本入口，**不允许各调用方自行决定正则与收尾器的先后**——
 * 否则正则可能在结构检查之后再次破坏正文（重新制造半句/未闭合格式）。
 */
object ChatGeneratedReplyPipeline {

    data class Options(
        val rawText: String,
        val finishReason: String?,
        /** output 正则规则（调用方各自获取） */
        val regexRules: List<ChatRegex.Rule>,
        val characterName: String,
        /**
         * 一次短补尾执行器。仅在收尾器判定 needs_tail_repair 时调用一次；null = 不补尾。
         */
        val runTailRepair: (suspend (ChatAssistantOutputFinalizer.Finalized) -> String?)? = null,
        /**
         * 供应商明确 stop/tool_calls 收尾时，即使正文缺句末标点也不发起补尾、更不整条丢弃——
         * 模型宣告结束时「无标点」只是风格问题，不是截断；数据丢失比缺标点更严重。
         */
        val allowEmptyTailPassthrough: Boolean = false,
    )

    data class Outcome(
        val content: String,
        /** complete | recovered | needs_tail_repair | failed | raw */
        val status: String,
        val notice: String? = null,
        val repairFailed: Boolean = false,
    )

    /**
     * 统一收尾管线。返回最终可保存正文与收尾状态；
     * 无可用正文时 content 为空串（调用方按各自占位/错误分支处理）。
     */
    suspend fun runGeneratedReplyPipeline(options: Options): Outcome {
        // 1. 供应商推理残留清理
        var text = ChatMessagePostProcess.stripVendorThinking(options.rawText).trim()

        // 2 + 3. output 正则与停止字符串——先于收尾器执行，
        //        保证收尾器的结构检查针对最终落盘口径；每条消息只执行一次。
        if (options.regexRules.isNotEmpty()) {
            text = ChatRegex.applyOutputRegexRules(text, options.regexRules)
            text = ChatRegex.truncateAtStop(text, ChatRegex.collectStopStrings(options.regexRules)).first
        }

        // 4. 收尾器（完整性检查 + 稳定边界回退）
        val finalized = ChatAssistantOutputFinalizer.finalizeAssistantOutput(
            rawText = text,
            finishReason = options.finishReason,
            characterName = options.characterName,
        )

        // 5. 必要时一次短补尾
        val repair = options.runTailRepair
        if (finalized.status == "needs_tail_repair" && repair != null) {
            val repaired = repair(finalized)
            if (!repaired.isNullOrEmpty()) {
                return Outcome(content = repaired, status = "recovered", notice = "tail_repaired")
            }
            if (finalized.content.isNotEmpty()) {
                return Outcome(content = finalized.content, status = "recovered", repairFailed = true)
            }
            return Outcome(content = "", status = "failed", repairFailed = true)
        }

        // stop/tool_calls 明确结束但找不到稳定边界时，不补尾也不整条丢弃
        if (finalized.status == "needs_tail_repair" && finalized.content.isEmpty() &&
            options.allowEmptyTailPassthrough && text.trim().isNotEmpty()
        ) {
            return Outcome(content = text.trim(), status = "recovered")
        }

        if (finalized.status == "failed" || finalized.content.isEmpty()) {
            return Outcome(content = "", status = "failed")
        }

        return Outcome(
            content = finalized.content,
            status = finalized.status,
            notice = finalized.notice,
        )
    }

    // ===================== 统一异常终止协调入口 =====================

    /**
     * 终止协调结果：调用方唯一可落盘依据。
     * - `persistable = false` 时不得保存 AI 消息（不创建空消息，错误只进提示字段）；
     * - `noticeFields` 只写 generationNotice/generationError，**绝不拼入 content**。
     */
    data class TerminalOutcome(
        val content: String,
        /** complete | recovered | needs_tail_repair | failed | raw | empty */
        val status: String,
        val persistable: Boolean,
        val terminationCause: String,
        val noticeFields: Map<String, String> = emptyMap(),
        val notice: String? = null,
        val repairFailed: Boolean = false,
    )

    /**
     * 统一终止协调入口：按 terminationCause 决定是否保存部分正文、是否允许补尾，
     * 生成 generationNotice/generationError，并把正文收束交给唯一共享管线。
     */
    suspend fun finalizeGenerationTerminalResult(
        rawText: String,
        finishReason: String?,
        terminationCause: String,
        regexRules: List<ChatRegex.Rule>,
        characterName: String,
        errorMessage: String? = null,
        runTailRepair: (suspend (ChatAssistantOutputFinalizer.Finalized) -> String?)? = null,
    ): TerminalOutcome {
        // 用户取消：保留用户已经看到的正文，不收尾、不补尾
        if (terminationCause == "user_cancel") {
            val content = rawText.trim()
            return TerminalOutcome(
                content = content,
                status = if (content.isNotEmpty()) "raw" else "empty",
                persistable = content.isNotEmpty(),
                terminationCause = terminationCause,
                noticeFields = if (content.isNotEmpty()) mapOf("generationNotice" to "已停止生成") else emptyMap(),
            )
        }

        // 审核拦截：整条回复不可信，按审核策略丢弃正文，只给明确审核提示，不做补尾
        if (terminationCause == "provider_content_filter" &&
            !ChatGenerationTermination.contentFilterPreservesBody()
        ) {
            return TerminalOutcome(
                content = "",
                status = "empty",
                persistable = false,
                terminationCause = terminationCause,
                noticeFields = mapOf(
                    "generationError" to
                        ChatGenerationTermination.terminationPromptWithoutContent(terminationCause, errorMessage),
                ),
            )
        }

        // 其余情况：先走唯一共享管线。
        // 自动补尾限制：只有 provider_length 且稳定正文不足时允许，每条消息最多一次；
        // transport/timeout/protocol/cancel/filter 一律不补尾。
        val effectiveFinishReason =
            ChatGenerationTermination.effectiveFinishReasonForCause(terminationCause, finishReason)
        val mayRepair = terminationCause == "provider_length" && runTailRepair != null
        val outcome = runGeneratedReplyPipeline(
            Options(
                rawText = rawText,
                finishReason = effectiveFinishReason,
                regexRules = regexRules,
                characterName = characterName,
                runTailRepair = if (mayRepair) runTailRepair else null,
                // 正常 stop / tool_calls 的保存结果是「完整正文」，不整条丢弃
                allowEmptyTailPassthrough =
                    terminationCause == "provider_stop" || terminationCause == "provider_tool_calls",
            ),
        )

        if (outcome.content.isEmpty()) {
            // 任意异常且无可用正文：不创建空 AI 消息
            return TerminalOutcome(
                content = "",
                status = "empty",
                persistable = false,
                terminationCause = terminationCause,
                noticeFields = mapOf(
                    "generationError" to
                        ChatGenerationTermination.terminationPromptWithoutContent(terminationCause, errorMessage),
                ),
            )
        }

        val noticeFields = LinkedHashMap<String, String>()
        val prompt = ChatGenerationTermination.terminationPromptWithContent(terminationCause)
        if (prompt != null) noticeFields[prompt.field] = prompt.text
        // provider_length 的普通句界收束静默处理；只有实际补尾或补尾失败需要提示。
        // 与异常类提示互斥：异常类优先展示 generationError。
        if (prompt == null && terminationCause == "provider_length") {
            if (outcome.notice == "tail_repaired") noticeFields["generationNotice"] = "已自动补全结尾"
            if (outcome.repairFailed) {
                noticeFields.remove("generationNotice")
                noticeFields["generationError"] = "生成中断，已保留完整部分"
            }
        }

        return TerminalOutcome(
            content = outcome.content,
            status = outcome.status,
            persistable = true,
            terminationCause = terminationCause,
            noticeFields = noticeFields,
            notice = outcome.notice,
            repairFailed = outcome.repairFailed,
        )
    }
}
