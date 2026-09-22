package com.qingyu.companion.chatcore

/**
 * 阶段 6 S6-01(c)：**群聊上下文完整装配**（对齐 `shared/chat-core/groupContextBuilder.ts`；
 * 出处为 PC `src/store/groupChatContext.ts#buildGroupChatContext` 的组装顺序 1–19）。
 *
 * 组装顺序逐段钉死：roster → 轮次规则 → thought 契约 → 分层记忆 → 群 systemPrompt →
 * 世界书段位置 → 成员卡 → 用户人设 → at_end → 预设 → 叙事约束 → 历史裁剪 → 压缩摘要 →
 * 归属映射 → 深度插入 → 后历史 → instruct 前缀 → 合并/转换 → 宏。
 *
 * 与 PC 的两点刻意差异（同 TS 侧文档）：世界书执行与请求预算计划在上游，
 * 本函数只接收已渲染的 render plan 段与 `requestMaxTokens`。
 */
object ChatGroupContextBuilder {

    /** 参与裁剪与归属映射的群消息最小结构。 */
    data class Message(
        val characterId: String,
        override val content: String,
        override val images: List<String>? = null,
        override val timestamp: Long,
    ) : ChatContextShared.CropableMessage

    /** 世界书已渲染段（executeLorebookRuntime 的 render plan 输入面）。 */
    data class LorebookPlan(
        val beforeCharacter: List<String> = emptyList(),
        val afterCharacter: List<String> = emptyList(),
        val beforeExamples: List<String> = emptyList(),
        val afterExamples: List<String> = emptyList(),
        val promptEnd: List<String> = emptyList(),
        val authorsNoteTop: List<String> = emptyList(),
        val authorsNoteBottom: List<String> = emptyList(),
        val chat: List<ChatContextShared.DepthInsertItem> = emptyList(),
    )

    data class SessionInput(
        val personaId: String? = null,
        val narrativeMode: String? = null,
        val memoryEnabled: Boolean = false,
        val memory: String? = null,
        val memoryCurrentState: String? = null,
        val memoryFacts: List<ChatMemoryFacts.FactRecord>? = null,
        val compressedSummary: String? = null,
        val compressedRange: Pair<Long, Long>? = null,
    )

    data class SemanticFact(val text: String, val score: Double)

    data class CompressionSettings(val enabled: Boolean = true, val minDropTokens: Int = 2000)

    data class Settings(
        val defaultNarrativeMode: String? = null,
        val enableThoughtFormat: Boolean = true,
        val omniscientNarrativeRules: String? = null,
        val scenarioInjectionMode: String? = null,
        val contextCompression: CompressionSettings? = null,
    )

    data class PresetInput(
        val systemPrompt: String? = null,
        val jailbreak: String? = null,
        val contextTemplate: String? = null,
    )

    data class ProfileInput(
        val provider: String? = null,
        val useInstructTemplate: Boolean? = null,
    )

    data class Input(
        val groupName: String,
        val chatMode: String,
        val groupSystemPrompt: String = "",
        val defaultNarrativeMode: String? = null,
        val members: List<ChatGroupContextBlocks.Member>,
        val targetId: String? = null,
        val session: SessionInput? = null,
        val messages: List<Message>,
        val userName: String,
        val userDescription: String? = null,
        val userPersona: String? = null,
        val personaInjection: ChatGroupContextBlocks.PersonaInjection? = null,
        val settings: Settings = Settings(),
        val semanticFacts: List<SemanticFact>? = null,
        val preset: PresetInput? = null,
        val profile: ProfileInput? = null,
        val model: String,
        val maxContext: Int,
        val requestMaxTokens: Int,
        val lorebookPlan: LorebookPlan? = null,
        val trackUsage: Boolean = true,
        /** 显式「现在」（记忆事实 recency 排序用；fixture 传固定值保证可比）。 */
        val now: Long = 0L,
    )

    data class OutMessage(
        val role: String,
        val content: String,
        val images: List<String>? = null,
        val keepSeparate: Boolean = false,
    )

    data class PendingCompression(
        val droppedText: String,
        val droppedStartTs: Long,
        val droppedEndTs: Long,
    )

    data class Result(
        val messages: List<OutMessage>,
        val narrativeMode: String,
        val pendingCompression: PendingCompression? = null,
    )

    /** PC 桌面 free 模式的【对话规则】兜底文案（turnRules 为空时使用；与桥接版有意不同）。 */
    private const val FREE_DESKTOP_TURN_RULES =
        "\n【对话规则】你可以让多个角色参与对话。如果多个角色需要发言，请用「【角色名】」标注每段发言的发言人。\n"

    /** 身份解析结果（userName 永不为空，缺省回退「用户」）。 */
    data class PersonaFields(val userName: String, val userDescription: String, val userPersona: String)

    /**
     * 用户身份解析（PC `buildGroupChatContext` 91–105）：会话身份 > 全局默认人设；
     * 只有全局默认人设就是当前激活人设时才允许使用全局名字字段。
     */
    fun resolvePersonaFields(
        sessionPersonaId: String?,
        sessionPersonaIdDefined: Boolean,
        sessionPersona: ChatGroupContextBlocks.PersonaLike? = null,
        defaultPersonaId: String? = null,
        activePersonaId: String? = null,
        globalUserName: String = "",
        globalUserDescription: String = "",
        globalUserPersona: String = "",
    ): PersonaFields {
        val effectivePersonaId = if (sessionPersonaIdDefined) sessionPersonaId else defaultPersonaId
        val canUseGlobal = !effectivePersonaId.isNullOrEmpty() && activePersonaId == effectivePersonaId
        val userName = (sessionPersona?.name ?: (if (canUseGlobal) globalUserName else "")).ifEmpty { "用户" }
        val userDescription = sessionPersona?.description ?: (if (canUseGlobal) globalUserDescription else "")
        val userPersona = sessionPersona?.persona ?: (if (canUseGlobal) globalUserPersona else "")
        return PersonaFields(userName, userDescription, userPersona)
    }

    fun build(input: Input): Result {
        val plan = input.lorebookPlan ?: LorebookPlan()
        val model = input.model
        val members = input.members
        val target = input.targetId?.let { id -> members.firstOrNull { it.id == id } }
        val userName = input.userName
        val charNameForVars = ChatGroupContextBlocks.resolveCharNameForVars(target?.name, members)
        val userMessageCount = input.messages.count { it.characterId == "__user__" }
        val shouldSendScenario = ChatGroupContextBlocks.resolveShouldSendScenario(
            input.settings.scenarioInjectionMode,
            userMessageCount,
        )
        val narrativeMode = if (input.session != null) {
            ChatNarrativeMode.resolveNarrativeMode(input.session.narrativeMode)
        } else {
            ChatNarrativeMode.resolveNarrativeMode(input.defaultNarrativeMode, input.settings.defaultNarrativeMode)
        }

        // ---- 1–2. roster + 轮次规则 ----
        var systemContent = ChatGroupPrompts.buildGroupRosterIntro(
            input.groupName,
            members.map { ChatGroupPrompts.RosterMember(it.name, it.description) },
            userName,
        )
        val turnRules = ChatGroupPrompts.buildGroupTurnRulesPrompt(input.chatMode)
        systemContent += turnRules.ifEmpty { FREE_DESKTOP_TURN_RULES }

        // ---- 3. thought 契约（思考主体恒绑定当前发言角色） ----
        if (input.settings.enableThoughtFormat) {
            val focusName = target?.let { "「${it.translatedName ?: it.name}」" } ?: ""
            systemContent += "\n【输出格式】" +
                ChatThoughtContract.buildThoughtContractBody(narrativeMode, focusName) + "\n"
        }

        // ---- Token 预算框架 ----
        val reservedOutput = input.requestMaxTokens
        val budgetBase = maxOf(
            Math.floor((input.maxContext - reservedOutput) * ChatContextShared.TOKEN_BUDGET_SAFETY).toInt(),
            Math.floor(input.maxContext * 0.25).toInt(),
        )

        // ---- 4. 分层长期记忆 ----
        val session = input.session
        if (session != null && session.memoryEnabled) {
            val memoryBudget = minOf(800, Math.floor(budgetBase * 0.1).toInt())
            val semanticFacts = input.semanticFacts ?: emptyList()
            val factsForInject: List<ChatMemoryFacts.FactRecord> = if (semanticFacts.isNotEmpty()) {
                semanticFacts.map { ChatMemoryFacts.FactRecord.TextFact(it.text) }
            } else {
                session.memoryFacts ?: emptyList()
            }
            val semanticScores = if (semanticFacts.isNotEmpty()) semanticFacts.map { it.score } else null
            val fitted = ChatMemoryRanking.fitLayeredMemoryBudget(
                session.memoryCurrentState,
                session.memory ?: "",
                factsForInject,
                memoryBudget.toDouble(),
                { text -> ChatTokenCounter.estimateTokens(text, model) },
                semanticScores,
                input.now,
            )
            if (fitted.currentState.isNotEmpty()) {
                systemContent += "\n\n【当前状态】\n" + fitted.currentState
            }
            val factsText = ChatMemoryRanking.formatMemoryFacts(fitted.facts)
            if (factsText.isNotEmpty()) {
                systemContent += "\n\n【关键事实】\n" + factsText
            }
            if (fitted.timeline.isNotEmpty()) {
                systemContent += "\n\n【群聊时间线】\n" + fitted.timeline
            }
        }

        // ---- 5. 群自定义 systemPrompt ----
        if (input.groupSystemPrompt.isNotEmpty()) {
            systemContent += "\n" +
                ChatVariables.replaceVariables(input.groupSystemPrompt, userName, charNameForVars) + "\n"
        }

        // ---- 6. 世界书段位置 ----
        val lorebookBefore = if (plan.beforeCharacter.isNotEmpty()) plan.beforeCharacter.joinToString("\n") + "\n" else ""
        val lorebookAfter = if (plan.afterCharacter.isNotEmpty()) plan.afterCharacter.joinToString("\n") else ""
        val lorebookAtEnd = if (plan.promptEnd.isNotEmpty()) "\n\n" + plan.promptEnd.joinToString("\n") else ""

        // ---- 7. 成员卡 ----
        val cardsOpts = ChatGroupContextBlocks.MemberCardsOptions(
            userName = userName,
            shouldSendScenario = shouldSendScenario,
            lorebookBefore = lorebookBefore,
            lorebookAfter = lorebookAfter,
            exampleBefore = plan.beforeExamples,
            exampleAfter = plan.afterExamples,
        )
        if (input.chatMode == "free") {
            systemContent += ChatGroupContextBlocks.buildFreeMemberCards(members, cardsOpts)
        } else if (target != null) {
            systemContent += ChatGroupContextBlocks.buildTargetMemberCard(target, cardsOpts)
        }

        // ---- 8. 用户人设 ----
        val personaText = ChatGroupContextBlocks.buildUserPersona(
            userName = userName,
            userDescription = input.userDescription,
            userPersona = input.userPersona,
            charNameForVars = charNameForVars,
            injection = input.personaInjection,
        )
        if (personaText.isNotEmpty() && (input.personaInjection?.position ?: "system") == "system") {
            systemContent += "\n【用户人设】\n" + personaText
        }

        // ---- 9. 世界书 at_end ----
        if (lorebookAtEnd.isNotEmpty()) {
            systemContent += lorebookAtEnd
        }

        // ---- 10. 预设 systemPrompt / jailbreak ----
        val preset = input.preset
        val presetSystemPrompt = preset?.systemPrompt
        if (!presetSystemPrompt.isNullOrEmpty()) {
            systemContent += "\n\n" + ChatVariables.replaceVariables(presetSystemPrompt, userName, charNameForVars)
        }
        val presetJailbreak = preset?.jailbreak
        if (!presetJailbreak.isNullOrEmpty() && presetJailbreak.trim().isNotEmpty()) {
            systemContent += "\n\n" + ChatVariables.replaceVariables(presetJailbreak, userName, charNameForVars)
        }

        // ---- 11. 最终叙事约束 ----
        systemContent += "\n\n" + ChatNarrativeMode.buildGroupNarrativeModePrompt(
            narrativeMode,
            userName,
            charNameForVars.ifEmpty { "当前角色" },
            input.chatMode,
            input.settings.omniscientNarrativeRules,
        )

        // ---- 12–13. 历史预算与裁剪 ----
        var usedTokens = ChatTokenCounter.estimateTokens(systemContent, model)
        val postHistoryText = ChatGroupContextBlocks.buildPostHistoryInstructions(
            chatMode = input.chatMode,
            members = members,
            target = target,
            userName = userName,
            charNameForVars = charNameForVars,
        )
        if (postHistoryText.isNotEmpty()) {
            usedTokens += ChatTokenCounter.estimateTokens(postHistoryText, model)
        }
        usedTokens += (plan.chat.map { it.content } + plan.authorsNoteBottom)
            .sumOf { ChatTokenCounter.estimateTokens(it, model) }
        val historyImageTokens = input.messages.sumOf { m ->
            if (m.characterId == "__user__") ChatTokenCounter.estimateImageTokens(m.images?.size ?: 0) else 0
        }
        usedTokens += historyImageTokens

        val crop = ChatContextShared.cropHistory(input.messages, usedTokens, budgetBase, model)

        // ---- 14. 上下文溢出压缩摘要 ----
        val compression = input.settings.contextCompression ?: CompressionSettings()
        var compressedSummaryInjected = ""
        var pendingCompression: PendingCompression? = null
        val hasTimelineMemory = !session?.memory.isNullOrEmpty()
        if (compression.enabled && !hasTimelineMemory && crop.droppedTokens > 0 && session != null) {
            val covered = !session.compressedSummary.isNullOrEmpty() &&
                session.compressedRange != null &&
                crop.droppedStartTs >= session.compressedRange.first &&
                crop.droppedEndTs <= session.compressedRange.second
            if (!session.compressedSummary.isNullOrEmpty() && covered) {
                compressedSummaryInjected = session.compressedSummary!!
            } else if (input.trackUsage && crop.droppedTokens >= compression.minDropTokens) {
                pendingCompression = PendingCompression(
                    droppedText = if (crop.droppedEndIndex >= 0) {
                        input.messages.subList(0, crop.droppedEndIndex + 1).joinToString("\n") { m ->
                            if (m.characterId == "__user__") {
                                "$userName: ${m.content}"
                            } else {
                                val c = members.firstOrNull { it.id == m.characterId }
                                "【${c?.name ?: "未知角色"}】${m.content}"
                            }
                        }
                    } else {
                        ""
                    },
                    droppedStartTs = crop.droppedStartTs,
                    droppedEndTs = crop.droppedEndTs,
                )
            }
        }

        // ---- 15. 上下文数组 ----
        val context = mutableListOf<OutMessage>()
        context += OutMessage(
            role = "system",
            content = ChatMacros.expandMacros(
                systemContent,
                ChatMacros.buildContext(
                    input.messages.map { m ->
                        object : ChatMacros.MessageLike {
                            override val role: String =
                                if (m.characterId == "__user__") "user" else "assistant"
                            override val content: String = m.content
                        }
                    },
                    userName = userName,
                    charName = charNameForVars,
                    groupName = input.groupName,
                ),
            ),
        )
        for (content in plan.authorsNoteTop) {
            context += OutMessage(role = "system", content = content, keepSeparate = true)
        }
        if (personaText.isNotEmpty() && input.personaInjection?.position == "separate") {
            context += OutMessage(role = "system", content = "【用户人设】\n" + personaText, keepSeparate = true)
        }

        val historyContext = mutableListOf<OutMessage>()
        if (compressedSummaryInjected.isNotEmpty()) {
            historyContext += OutMessage(
                role = "system",
                content = "【早期对话压缩摘要】\n" + compressedSummaryInjected,
                keepSeparate = true,
            )
        }
        for (entry in ChatGroupContextBlocks.mapHistoryMessages(
            messages = crop.recent.map {
                ChatGroupContextBlocks.HistoryMessage(it.characterId, it.content, it.images ?: emptyList())
            },
            members = members,
            userName = userName,
            charNameForVars = charNameForVars,
        )) {
            historyContext += OutMessage(
                role = entry.role,
                content = entry.content,
                images = entry.images,
            )
        }

        // ---- 16. 深度插入 ----
        val depthInserts = ArrayList<ChatContextShared.DepthInsertItem>(plan.chat)
        plan.authorsNoteBottom.forEachIndexed { index, content ->
            depthInserts += ChatContextShared.DepthInsertItem(content = content, depth = 0, order = -2000 + index)
        }
        val depthInjected = ChatContextShared.applyDepthInserts(
            historyContext,
            depthInserts,
        ) { content, role ->
            OutMessage(role = role ?: "system", content = content, keepSeparate = true)
        }.toMutableList()

        // ---- 17. 后历史指令 ----
        if (postHistoryText.trim().isNotEmpty()) {
            depthInjected += OutMessage(role = "system", content = postHistoryText.trim())
        }

        // ---- 18. instruct 模板 assistant 前缀 ----
        val instructTemplate = ChatTemplates.resolveEffectiveTemplate(
            preset?.contextTemplate,
            input.profile?.provider ?: "openai",
            model,
            input.profile?.useInstructTemplate,
        )
        if (instructTemplate?.appendAssistantPrefix == true && charNameForVars.isNotEmpty()) {
            depthInjected += OutMessage(role = "assistant", content = "")
        }

        // ---- 19. 合并连续消息 + 按 provider 转换 ----
        val provider = input.profile?.provider ?: "openai"
        val merged = ChatMessagePostProcess.mergeConsecutiveMessages(
            (context + depthInjected).map {
                ChatPromptConverters.ChatMessage(it.role, it.content, it.images, it.keepSeparate)
            },
        )
        val processed = ChatPromptConverters.convertMessages(
            provider,
            merged,
            ChatPromptConverters.PromptNames(charName = charNameForVars.ifEmpty { "角色" }, userName = userName),
        )

        return Result(
            messages = processed.map { OutMessage(it.role, it.content, it.images, it.keepSeparate) },
            narrativeMode = narrativeMode,
            pendingCompression = pendingCompression,
        )
    }
}
