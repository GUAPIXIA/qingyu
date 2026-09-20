package com.qingyu.companion.chatcore

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * 阶段 4 S4-01 第 5 层：上下文主装配
 * （对齐 `shared/chat-core/contextBuilder.ts` 的**无世界书子集**）。
 *
 * ## 为什么先做子集
 * PC 的 `buildContextMessagesFromData` 与 `lorebook.ts`（2304 行）的 runtime 瀑布深度耦合；
 * 本模块先覆盖 `activeLorebookIds` 为空、`shadow` 关闭时的完整装配路径——
 * 这条路径本身已经包含：系统提示、越狱段、叙事模式、用户人设、thought 契约、
 * 记忆三层注入、角色设定、作者注释、对话示例、历史裁剪与压缩摘要、续写指令、
 * assistant 前缀、连续同角色合并与 provider 格式转换。
 *
 * **未覆盖（明确排除，需后续 A3b）**：世界书 before/after_character、prompt_end、
 * at_depth（世界书部分）、示例位置的世界书包裹、世界书影子/记忆影子/输入审计、`shadow='shadow'`。
 * 这些分支在 `activeLorebookIds` 为空时**不会执行**，因此本子集与 PC 在该输入下逐字节等价。
 */
object ChatContextBuilder {

    const val DEFAULT_SYSTEM_PROMPT = "你是一个沉浸式互动叙事助手。请根据角色与世界设定持续创作，保持人物和情节的一致性。"
    const val DEFAULT_USER_NAME = "用户"
    const val DEFAULT_MODEL = "gpt-4o-mini"
    const val CONTINUATION_INSTRUCTION =
        "请直接接续上一段内容的结尾继续写作，保持相同的风格、语气和叙事视角。不要重复已有内容，直接输出续写部分。"

    // ---------------------------------------------------------------- 输入数据模型（子集）

    data class AuthorNote(
        val enabled: Boolean = false,
        val text: String = "",
        /** top | middle | bottom */
        val position: String = "bottom",
        val depth: Int = 0,
    )

    data class PersonaInjection(
        val enabled: Boolean = true,
        /** system | separate */
        val position: String = "system",
        val includeDescription: Boolean = true,
        val includePersona: Boolean = true,
    )

    data class TranslatedContent(
        val name: String? = null,
        val description: String? = null,
        val personality: String? = null,
        val scenario: String? = null,
        val firstMessage: String? = null,
        val exampleDialog: String? = null,
    )

    data class CharacterSnapshot(
        val id: String = "",
        val name: String = "",
        val description: String = "",
        val personality: String = "",
        val scenario: String = "",
        val exampleDialog: String = "",
        val systemPrompt: String? = null,
        val postHistoryInstructions: String? = null,
        val defaultNarrativeMode: String? = null,
        val authorNote: AuthorNote? = null,
        val translatedContent: TranslatedContent? = null,
    )

    data class PresetSnapshot(
        val id: String = "",
        val systemPrompt: String = "",
        val jailbreak: String = "",
        val maxContext: Int = 0,
        val maxTokens: Int = 0,
        val responseLengthHint: String? = null,
        val contextTemplate: String? = null,
        val exampleDialogMode: String? = null,
        val enableThoughtFormat: Boolean? = null,
    )

    data class CompressedRange(val startTs: Long, val endTs: Long)

    data class SessionSnapshot(
        val id: String = "",
        val characterId: String = "",
        val memoryEnabled: Boolean = false,
        val memory: String = "",
        val memoryCurrentState: String? = null,
        val memoryFacts: List<ChatMemoryFacts.FactRecord> = emptyList(),
        val narrativeMode: String? = null,
        val responseLengthMode: String? = null,
        val compressedSummary: String? = null,
        val compressedRange: CompressedRange? = null,
    )

    data class MessageSnapshot(
        val id: String = "",
        val role: String,
        override val content: String,
        override val images: List<String>? = null,
        override val timestamp: Long = 0L,
    ) : ChatContextShared.CropableMessage

    data class SettingsSnapshot(
        val userName: String = "",
        val activeModel: String = "",
        val defaultNarrativeMode: String? = null,
        val omniscientNarrativeRules: String? = null,
        val personaInjection: PersonaInjection? = null,
        val userDescription: String? = null,
        val userPersona: String? = null,
        val enableThoughtFormat: Boolean? = null,
        val exampleDialogPosition: String? = null,
        val exampleDialogMode: String? = null,
        /** null = 使用默认（enabled = true, minDropTokens = 2000），与 PC 一致 */
        val contextCompressionEnabled: Boolean? = null,
        val contextCompressionMinDropTokens: Int? = null,
    )

    data class ProfileSnapshot(
        val provider: String = "openai",
        val model: String = "",
        val useInstructTemplate: Boolean? = null,
        val maxContext: Int = 0,
    )

    data class ChatSnapshot(
        val messages: List<MessageSnapshot> = emptyList(),
        val sessions: List<SessionSnapshot> = emptyList(),
        val currentSessionId: String? = null,
        val semanticFactsHits: List<SemanticFactHit> = emptyList(),
        /** 已按会话绑定展开的**激活世界书 id 列表**。 */
        val activeLorebookIds: List<String> = emptyList(),
        /** 本轮之前已触发的条目 key（recency 窗口用）。 */
        val recentTriggeredIds: List<List<String>>? = null,
        /** 超限压缩缓存（命中时以缓存摘要替代被丢弃的条目集合）。 */
        val lorebookCompressionCache: Map<String, ChatLorebookBudget.CompressionCacheEntry> = emptyMap(),
    )

    /** 语义检索命中的长记忆事实（字符串事实或带分数的事实）。 */
    data class SemanticFactHit(val text: String, val score: Double = 0.0)

    data class BuildData(
        val character: CharacterSnapshot? = null,
        val preset: PresetSnapshot? = null,
        val chat: ChatSnapshot = ChatSnapshot(),
        val settings: SettingsSnapshot = SettingsSnapshot(),
        val profile: ProfileSnapshot? = null,
        /** 激活世界书全量（按 `chat.activeLorebookIds` 过滤后使用）。 */
        val lorebooks: List<ChatLorebookRuntime.Book> = emptyList(),
        val reasoningSamples: List<Double>? = null,
        val reasoningGate: ChatReasoningGate.Resolved? = null,
    )

    data class BuildOptions(
        val continuation: Boolean = false,
        val narrativeMode: String? = null,
        val generationType: String? = null,
    )

    // ---------------------------------------------------------------- 输出

    data class ContextMessage(
        val role: String,
        val content: String,
        val images: List<String>? = null,
        val keepSeparate: Boolean = false,
    )

    data class PendingCompression(
        val characterId: String,
        val sessionId: String,
        val droppedText: String,
        val droppedStartTs: Long,
        val droppedEndTs: Long,
    )

    data class ContextUsage(val used: Int, val max: Int)

    data class ChatRequestPlan(
        val responsePolicy: ChatResponsePolicy.Policy,
        val requestBudget: ChatModelOutputProfile.RequestBudget,
        val requestMaxTokens: Int,
        val responseIntent: String?,
        val sceneFactor: Double,
    )

    data class BuildResult(
        val messages: List<ContextMessage>,
        val lastContextUsage: ContextUsage,
        val responsePolicy: ChatResponsePolicy.Policy,
        val requestMaxTokens: Int,
        val responseIntent: String?,
        val sceneFactor: Double,
        val narrativeMode: String,
        val pendingCompression: PendingCompression? = null,
        /**
         * 本地超限量（估算）：装配后的**输入**超出输入池 `budgetBase` 的 token 数，未超限为 0。
         *
         * 阶段 4 S4-02：「**超出上下文前必须在本地阻断或降级，不能只依赖供应商报错**」。
         * 历史由 `cropHistory` 按 budgetBase 裁剪，但**非历史部分**（预设/系统提示/世界书/
         * 用户人设）本身就可能超限——那种情况裁剪历史救不回来，只能本地阻断。
         *
         * 基准取 `budgetBase`（= `lastContextUsage.max`，装配器真正分配给输入的量），
         * 而不是 `maxContext - requestMaxTokens`：后者在「输出预留大于上下文上限」时会变成 0，
         * 把任何正常输入都判成超限（实测 `maxContext=8192` 而模型输出上限 9081 时就会如此）。
         * 该「输出预留未被上下文夹住」的问题是另一件事，见实施报告，需与 PC 对齐后再改，
         * 不能靠这里的阈值掩盖。
         */
        val overflowTokens: Int = 0,
        /**
         * 本轮世界书实际触发的条目 key（去重后、预算裁剪前）。
         *
         * 调用方据此更新会话的**近因窗口**：没有它，ChatLorebookRuntime 的 recency 加权
         * 永远是 0——运行时早就支持该输入，只是一直没有数据来源（「能力已接、数据没接」）。
         */
        val lorebookTriggeredEntryKeys: List<String> = emptyList(),
    )

    // ---------------------------------------------------------------- 模型与计划解析

    fun resolveModel(data: BuildData): String {
        val active = data.settings.activeModel
        if (active.isNotEmpty()) return active
        val profileModel = data.profile?.model
        if (!profileModel.isNullOrEmpty()) return profileModel
        return DEFAULT_MODEL
    }

    /** 与 PC `resolveChatRequestPlan` 逐字段一致。 */
    fun resolveChatRequestPlan(data: BuildData): ChatRequestPlan {
        val settings = data.settings
        val model = resolveModel(data)
        val session = data.chat.sessions.firstOrNull { it.id == data.chat.currentSessionId }
        val latestUserText = data.chat.messages.lastOrNull { it.role == "user" }?.content ?: ""
        val hasAssistantReply = data.chat.messages.any { it.role == "assistant" && it.content.trim().isNotEmpty() }
        val responseIntent = ChatResponsePolicy.detectUserLengthIntent(latestUserText)
        val sceneFactor = ChatResponsePolicy.resolveSceneFactor(latestUserText, hasAssistantReply)
        val responsePolicy = ChatResponsePolicy.resolveResponsePolicy(
            sessionMode = session?.responseLengthMode,
            presetHint = data.preset?.responseLengthHint,
            userIntent = responseIntent,
            recentAssistantVisibleChars = ChatResponsePolicy.collectRecentAssistantChars(
                data.chat.messages.map { VisibleMessage(it.role, it.content) },
            ).map { it.toDouble() },
            sceneFactor = sceneFactor,
        )
        val requestBudget = ChatGenerationTaskBudget.resolveGenerationTaskBudget(
            ChatGenerationTaskBudget.Input(
                task = "main",
                model = model,
                expectedBodyChars = responsePolicy.hardMaxChars,
                userHardCap = data.preset?.maxTokens,
                recentReasoningTokens = data.reasoningSamples?.takeIf { it.isNotEmpty() },
                reasoningGate = data.reasoningGate,
            ),
        )
        return ChatRequestPlan(
            responsePolicy = responsePolicy,
            requestBudget = requestBudget.request,
            requestMaxTokens = requestBudget.request.requestMaxTokens,
            responseIntent = responseIntent,
            sceneFactor = sceneFactor,
        )
    }

    private data class VisibleMessage(override val role: String, override val content: String?) :
        ChatResponsePolicy.VisibleCharsSource

    // ---------------------------------------------------------------- 主装配

    /**
     * 从数据快照组装发送给 AI 的完整上下文（无世界书子集）。
     */
    fun buildContextMessagesFromData(data: BuildData, options: BuildOptions = BuildOptions()): BuildResult {
        val settings = data.settings
        val profile = data.profile
        val character = data.character ?: CharacterSnapshot()
        val preset = data.preset
        val userName = settings.userName.ifEmpty { DEFAULT_USER_NAME }
        val model = resolveModel(data)

        val messages = data.chat.messages.filter { message ->
            (message.content.isNotEmpty() || !message.images.isNullOrEmpty()) && message.role != "system"
        }
        val context = mutableListOf<ContextMessage>()
        val currentSession = data.chat.sessions.firstOrNull { it.id == data.chat.currentSessionId }
        // 旧会话缺少字段时固定按 immersive 运行，避免后来修改默认值导致旧故事静默换模式
        val sessionNarrativeMode = if (currentSession != null) {
            ChatNarrativeMode.resolveNarrativeMode(currentSession.narrativeMode)
        } else {
            ChatNarrativeMode.resolveNarrativeMode(character.defaultNarrativeMode, settings.defaultNarrativeMode)
        }
        val narrativeMode = ChatNarrativeMode.resolveNarrativeMode(options.narrativeMode, sessionNarrativeMode)

        // ===== System Prompt =====
        val charNameForVars = character.translatedContent?.name?.takeIf { it.isNotEmpty() } ?: character.name
        var systemContent = ChatVariables.replaceVariables(
            character.systemPrompt?.takeIf { it.isNotEmpty() }
                ?: preset?.systemPrompt?.takeIf { it.isNotEmpty() }
                ?: DEFAULT_SYSTEM_PROMPT,
            userName,
            charNameForVars,
        )

        // jailbreak 改为可选：只在 preset 有 jailbreak 且非空时附加
        val jailbreak = preset?.jailbreak
        if (!jailbreak.isNullOrEmpty() && jailbreak.trim().isNotEmpty()) {
            systemContent += "\n\n" + ChatVariables.replaceVariables(jailbreak, userName, charNameForVars)
        }

        // 叙事模式是独立于角色卡和预设的最终行为约束
        systemContent += "\n\n" + ChatNarrativeMode.buildNarrativeModePrompt(
            narrativeMode,
            userName,
            charNameForVars,
            settings.omniscientNarrativeRules,
        )

        // 用户人设注入（可配置：开关 / 位置 / 字段）
        val personaInjection = settings.personaInjection
            ?: PersonaInjection(enabled = true, position = "system", includeDescription = true, includePersona = true)
        var personaText = ""
        if (personaInjection.enabled) {
            personaText += "用户名：" + userName
            if (personaInjection.includeDescription && !settings.userDescription.isNullOrEmpty()) {
                personaText += "\n描述：" + ChatVariables.replaceVariables(settings.userDescription, userName, charNameForVars)
            }
            if (personaInjection.includePersona && !settings.userPersona.isNullOrEmpty()) {
                personaText += "\n性格：" + ChatVariables.replaceVariables(settings.userPersona, userName, charNameForVars)
            }
            if (personaText.isNotEmpty() && personaInjection.position == "system") {
                systemContent += "\n\n【用户人设】\n" + personaText
            }
        }

        // 心理描写输出格式：可配置，默认开启
        val enableThoughtFormat = preset?.enableThoughtFormat ?: (settings.enableThoughtFormat != false)
        if (enableThoughtFormat) {
            val thoughtContractBody = ChatThoughtContract.buildThoughtContractBody(
                narrativeMode,
                if (narrativeMode == "omniscient") "「$charNameForVars」" else charNameForVars,
            )
            systemContent += "\n\n【输出格式要求】\n" + thoughtContractBody
        }

        // ===== Token 预算框架 =====
        val maxContext = profile?.maxContext?.takeIf { it > 0 }
            ?: preset?.maxContext?.takeIf { it > 0 }
            ?: ChatModelOutputProfile.getModelOutputProfile(model).contextLimit
        val plan = resolveChatRequestPlan(data)
        val reservedOutput = plan.requestMaxTokens

        // 下限保护：maxTokens 配置过大时至少保留 25% 上下文预算
        val budgetBase = max(
            floor((maxContext - reservedOutput) * ChatContextShared.TOKEN_BUDGET_SAFETY).toInt(),
            floor(maxContext * 0.25).toInt(),
        )

        // ===== 记忆三层注入（候选分配 + 物化） =====
        if (currentSession?.memoryEnabled == true) {
            val memoryBudget = min(800, floor(budgetBase * 0.1).toInt())
            val semanticFacts = data.chat.semanticFactsHits
            val factsForInject: List<ChatMemoryFacts.FactRecord> = if (semanticFacts.isNotEmpty()) {
                semanticFacts.map { ChatMemoryFacts.FactRecord.TextFact(it.text) }
            } else {
                currentSession.memoryFacts
            }
            val semanticScores: List<Double>? = if (semanticFacts.isNotEmpty()) {
                semanticFacts.map { it.score }
            } else {
                null
            }

            var memoryInjected = false
            runCatching {
                val memoryPlan = ChatMemoryCandidates.buildMemoryCandidateSet(
                    ChatMemoryCandidates.Input(
                        currentState = currentSession.memoryCurrentState,
                        timeline = currentSession.memory,
                        facts = factsForInject,
                        semanticScores = semanticScores,
                        model = model,
                    ),
                )
                val selectedIds = ChatContextCandidates.allocateContextCandidates(
                    memoryPlan.candidates,
                    ChatContextCandidates.AllocationOptions(budgetTokens = budgetBase.toDouble()),
                ).selectedIds.toSet()
                val materialized = ChatMemoryCandidates.materializeMemoryInjection(
                    plan = memoryPlan,
                    selectedIds = selectedIds,
                    currentState = currentSession.memoryCurrentState,
                    facts = factsForInject,
                    timeline = currentSession.memory,
                    semanticScores = semanticScores,
                    model = model,
                )
                if (materialized.currentState.isNotEmpty()) {
                    systemContent += "\n\n【当前状态】\n" + materialized.currentState
                }
                val factsText = ChatMemoryRanking.formatMemoryFacts(materialized.facts)
                if (factsText.isNotEmpty()) systemContent += "\n\n【关键事实】\n" + factsText
                if (materialized.timeline.isNotEmpty()) {
                    systemContent += "\n\n【对话时间线】\n" + materialized.timeline
                }
                memoryInjected = true
            }

            if (!memoryInjected) {
                // 回滚路径：固定上限分层预算（存储永不删除）
                val fitted = ChatMemoryRanking.fitLayeredMemoryBudget(
                    currentState = currentSession.memoryCurrentState,
                    timeline = currentSession.memory,
                    facts = factsForInject,
                    budget = memoryBudget.toDouble(),
                    estimateTokens = { ChatTokenCounter.estimateTokens(it, model) },
                    semanticScores = semanticScores,
                    now = System.currentTimeMillis(),
                )
                if (fitted.currentState.isNotEmpty()) systemContent += "\n\n【当前状态】\n" + fitted.currentState
                val factsText = ChatMemoryRanking.formatMemoryFacts(fitted.facts)
                if (factsText.isNotEmpty()) systemContent += "\n\n【关键事实】\n" + factsText
                if (fitted.timeline.isNotEmpty()) systemContent += "\n\n【对话时间线】\n" + fitted.timeline
            }
        }

        // ===== 世界书（激活时才执行）=====
        // PC 的顺序：先按激活书求扫描深度 → 逐条窗口取扫描文本 → 运行时触发 →
        // 统一渲染器产出各桶 → 落位。落位顺序必须与 PC 一致：
        // before_character 拼在 charDesc 之前、after_character 拼在其后、prompt_end 追加到 systemContent 末尾，
        // chat depth 延后到历史消息构建后再注入。
        var lorebookRenderPlan = ChatLorebookRenderer.emptyPlan()
        var lorebookTriggeredIds: List<String>? = null
        var lorebookCompressionRequests: List<ChatLorebookBudget.CompressionRequest> = emptyList()
        var lorebookCompressionCacheHitKeys: List<String> = emptyList()
        val activeLorebookIds = data.chat.activeLorebookIds
        if (activeLorebookIds.isNotEmpty()) {
            val activeBooks = data.lorebooks.filter { activeLorebookIds.contains(it.id) }
            val scanDepth = ChatLorebookRuntime.resolveScanDepth(
                activeBooks.flatMap { book -> listOf(book.scanDepth) + book.entries.map { it.scanDepth } },
            )
            val scanMessages = (if (scanDepth == 0) emptyList() else messages.takeLast(scanDepth)).map { it.content }
            val scanText = scanMessages.joinToString(" ")

            val runtimeResult = ChatLorebookRuntime.execute(
                ChatLorebookRuntime.Input(
                    lorebooks = activeBooks,
                    scanText = scanText,
                    scanMessages = scanMessages,
                    userName = userName,
                    charName = character.name,
                    // 译名与原名都参与角色过滤匹配
                    characterNames = listOf(character.name, charNameForVars),
                    characterTags = emptyList(),
                    generationType = options.generationType
                        ?: if (options.continuation) "continue" else "normal",
                    messageCount = messages.size,
                    budget = budgetBase,
                    model = model,
                    entityVocabulary = emptyList(),
                    recentTriggeredIds = data.chat.recentTriggeredIds,
                    compressionCache = data.chat.lorebookCompressionCache,
                    semanticEnabled = false,
                ),
            )
            lorebookRenderPlan = ChatLorebookRenderer.render(
                runtimeResult.kept.map { item ->
                    ChatLorebookRenderer.RenderItem(
                        content = item.content,
                        order = item.order,
                        insertion = ChatLorebookRenderer.fromBudgetInsertion(ChatLorebookBudget.loreItemInsertion(item)),
                        key = item.key,
                    )
                },
            )
            lorebookTriggeredIds = runtimeResult.triggeredEntryKeys
            lorebookCompressionRequests = runtimeResult.compressionRequests
            lorebookCompressionCacheHitKeys = runtimeResult.compressionCacheHitKeys
            // prompt_end 追加到系统提示末尾——注意这在 **PC 的分支内**完成，
            // 因此落位在 `【角色设定】` 之前（角色设定在分支之后才追加）。
            if (lorebookRenderPlan.promptEnd.isNotEmpty()) {
                systemContent += "\n\n" + lorebookRenderPlan.promptEnd.joinToString("\n")
            }
        }

        // ===== 角色设定 =====
        // 统一用 charNameForVars（译名优先），避免角色自称自相矛盾
        val charDescBuilder = StringBuilder()
        if (character.description.isNotEmpty()) {
            charDescBuilder.append(ChatVariables.replaceVariables(character.description, userName, charNameForVars)).append('\n')
        }
        if (character.personality.isNotEmpty()) {
            charDescBuilder.append("性格：")
                .append(ChatVariables.replaceVariables(character.personality, userName, charNameForVars)).append('\n')
        }
        if (character.scenario.isNotEmpty()) {
            charDescBuilder.append("场景：")
                .append(ChatVariables.replaceVariables(character.scenario, userName, charNameForVars)).append('\n')
        }
        var charDesc = charDescBuilder.toString()
        // 世界书 before_character / after_character 拼在角色设定两侧（与 PC 同序）
        if (lorebookRenderPlan.beforeCharacter.isNotEmpty()) {
            charDesc = lorebookRenderPlan.beforeCharacter.joinToString("\n") + "\n" + charDesc
        }
        if (lorebookRenderPlan.afterCharacter.isNotEmpty()) {
            charDesc = charDesc + lorebookRenderPlan.afterCharacter.joinToString("\n")
        }
        if (charDesc.isNotEmpty()) systemContent += "\n\n【角色设定】\n" + charDesc

        // 宏展开（预设 / 人设 / 角色设定均支持；无宏时 expandMacros 原样返回）
        val macroCtx = ChatMacros.Context(
            userName = userName,
            charName = charNameForVars,
            originalCharName = character.name,
            lastMessage = data.chat.messages.lastOrNull { it.content.trim().isNotEmpty() }?.content ?: "",
            lastUserMessage = data.chat.messages.lastOrNull { it.role == "user" && it.content.trim().isNotEmpty() }?.content
                ?: "",
        )
        systemContent = ChatMacros.expandMacros(systemContent, macroCtx)

        context += ContextMessage(role = "system", content = systemContent)

        // 世界书 authors_note_top 紧跟系统提示（keepSeparate，避免被合并）
        for (content in lorebookRenderPlan.authorsNoteTop) {
            context += ContextMessage(role = "system", content = content, keepSeparate = true)
        }

        // 用户人设 separate 模式：独立 system 消息
        if (personaText.isNotEmpty() && personaInjection.position == "separate") {
            context += ContextMessage(role = "system", content = "【用户人设】\n" + personaText, keepSeparate = true)
        }

        // ===== 作者注释 =====
        val anConfig = character.authorNote
        var anText = ""
        if (anConfig != null && anConfig.enabled && anConfig.text.trim().isNotEmpty()) {
            anText = ChatMacros.expandMacros(
                ChatVariables.replaceVariables(anConfig.text.trim(), userName, charNameForVars),
                macroCtx,
            )
        }
        if (anText.isNotEmpty() && anConfig!!.position == "top") {
            context += ContextMessage(role = "system", content = anText, keepSeparate = true)
        }

        // ===== 对话示例 =====
        val exampleDialogPosition = settings.exampleDialogPosition?.takeIf { it.isNotEmpty() } ?: "after_system"
        val exampleDialogMode = preset?.exampleDialogMode ?: settings.exampleDialogMode ?: "always"
        val isFirstTurn = messages.count { it.role == "user" } <= 1
        val shouldSendExample = character.exampleDialog.isNotEmpty() &&
            exampleDialogMode != "off" &&
            (exampleDialogMode != "first_turn" || isFirstTurn)
        val exampleDialogContent = if (shouldSendExample) {
            "【对话示例】\n" + ChatVariables.replaceVariables(character.exampleDialog, userName, charNameForVars)
        } else {
            ""
        }
        if (exampleDialogPosition == "after_system") {
            // 世界书 before_examples / after_examples 包住对话示例（与 PC 同序）
            for (content in lorebookRenderPlan.beforeExamples) {
                context += ContextMessage(role = "system", content = content, keepSeparate = true)
            }
            if (exampleDialogContent.isNotEmpty()) {
                context += ContextMessage(role = "system", content = exampleDialogContent)
            }
            for (content in lorebookRenderPlan.afterExamples) {
                context += ContextMessage(role = "system", content = content, keepSeparate = true)
            }
        }

        // ===== 历史消息 =====
        var usedTokens = context.sumOf { ChatTokenCounter.estimateTokens(it.content, model) }

        val postHistoryText = character.postHistoryInstructions
            ?.takeIf { it.isNotEmpty() }
            ?.let { ChatVariables.replaceVariables(it, userName, charNameForVars) }
            ?: ""
        if (postHistoryText.isNotEmpty()) usedTokens += ChatTokenCounter.estimateTokens(postHistoryText, model)

        val bodyFormatBase = ChatResponsePolicy.buildMainChatOutputPrompt(plan.responsePolicy)
        val bodyFormatText = if (enableThoughtFormat) {
            // 与 PC 一致：全局叙事的尾部契约不点名主体（空串 → 通用措辞），
            // 沉浸模式则点名角色（否则模型不知道这段内心独白属于谁）
            val tailSubjectName = if (narrativeMode == "omniscient") "" else charNameForVars
            bodyFormatBase + "\n\n【内心想法契约】\n" +
                ChatThoughtContract.buildThoughtContractBody(narrativeMode, tailSubjectName)
        } else {
            bodyFormatBase
        }
        usedTokens += ChatTokenCounter.estimateTokens(bodyFormatText, model)

        if (anText.isNotEmpty() && anConfig!!.position != "top") {
            usedTokens += ChatTokenCounter.estimateTokens(anText, model)
        }
        if (exampleDialogPosition == "after_history" && exampleDialogContent.isNotEmpty()) {
            usedTokens += ChatTokenCounter.estimateTokens(exampleDialogContent, model)
        }
        // 世界书的 chat depth 与 authors_note_bottom 尚未加入 context（它们在历史裁剪之后
        // 才按深度注入），因此**裁剪前必须先预留**，否则会裁得比 PC 少一点。
        usedTokens += (lorebookRenderPlan.chat.map { it.content } + lorebookRenderPlan.authorsNoteBottom)
            .sumOf { ChatTokenCounter.estimateTokens(it, model) }

        val historyImageTokens = messages.sumOf { message ->
            if (message.role == "user") ChatTokenCounter.estimateImageTokens(message.images?.size ?: 0) else 0
        }
        usedTokens += historyImageTokens
        val crop = ChatContextShared.cropHistory(messages, usedTokens, budgetBase, model)

        // 上下文溢出压缩：有压缩摘要则注入；否则若裁剪量超阈值，标记异步压缩
        val compressionEnabled = settings.contextCompressionEnabled ?: true
        val minDropTokens = settings.contextCompressionMinDropTokens ?: 2000
        var compressedSummaryInjected = ""
        var pendingCompression: PendingCompression? = null
        // 长期时间线已覆盖更早历史时，不再注入或重复生成压缩摘要
        val hasTimelineMemory = currentSession?.memory?.trim()?.isNotEmpty() == true
        if (compressionEnabled && !hasTimelineMemory && crop.droppedTokens > 0 && currentSession != null) {
            val range = currentSession.compressedRange
            val covered = !currentSession.compressedSummary.isNullOrEmpty() && range != null &&
                crop.droppedStartTs >= range.startTs && crop.droppedEndTs <= range.endTs
            if (!currentSession.compressedSummary.isNullOrEmpty() && covered) {
                compressedSummaryInjected = currentSession.compressedSummary
            } else if (crop.droppedTokens >= minDropTokens) {
                val droppedText = if (crop.droppedEndIndex >= 0) {
                    messages.subList(0, crop.droppedEndIndex + 1).joinToString("\n") { message ->
                        val speaker = if (message.role == "user") userName else charNameForVars
                        "$speaker: ${message.content}"
                    }
                } else {
                    ""
                }
                pendingCompression = PendingCompression(
                    characterId = character.id,
                    sessionId = data.chat.currentSessionId ?: "",
                    droppedText = droppedText,
                    droppedStartTs = crop.droppedStartTs,
                    droppedEndTs = crop.droppedEndTs,
                )
            }
        }

        // 历史消息段（供 depth 注入）
        val historySegment = mutableListOf<ContextMessage>()
        if (compressedSummaryInjected.isNotEmpty()) {
            historySegment += ContextMessage(
                role = "system",
                content = "【早期对话压缩摘要】\n" + compressedSummaryInjected,
                keepSeparate = true,
            )
        }
        for (message in crop.recent) {
            historySegment += ContextMessage(
                role = if (message.role == "user") "user" else "assistant",
                content = message.content,
                images = if (message.role == "user" && !message.images.isNullOrEmpty()) message.images else null,
            )
        }

        // at_depth 世界书 + 作者注释（middle/bottom）按深度注入历史段
        val depthInserts = mutableListOf<ChatContextShared.DepthInsertItem>()
        // 世界书 chat depth 条目先入（PC：atDepthItems 在前，作者注释 order -1 排在其前、
        // authors_note_bottom 用 order -2000 排在最前）
        for (chatItem in lorebookRenderPlan.chat) {
            depthInserts += ChatContextShared.DepthInsertItem(
                content = chatItem.content,
                depth = chatItem.depth,
                order = chatItem.order,
                role = chatItem.role,
            )
        }
        lorebookRenderPlan.authorsNoteBottom.forEachIndexed { index, content ->
            depthInserts += ChatContextShared.DepthInsertItem(
                content = content,
                depth = 0,
                order = -2000 + index,
            )
        }
        if (anText.isNotEmpty() && anConfig!!.position != "top") {
            // bottom = 末尾（depth 0）；middle = 按配置深度；同深度下 AN 排在世界书前
            val anDepth = if (anConfig.position == "middle") max(0, anConfig.depth) else 0
            depthInserts += ChatContextShared.DepthInsertItem(content = anText, depth = anDepth, order = -1)
        }
        val depthInjected = ChatContextShared.applyDepthInserts(historySegment, depthInserts) { content, role ->
            ContextMessage(role = role ?: "system", content = content, keepSeparate = true)
        }
        context += depthInjected

        if (exampleDialogPosition == "after_history" && exampleDialogContent.isNotEmpty()) {
            context += ContextMessage(role = "system", content = exampleDialogContent)
        }

        // 历史之后再次固定本轮回应范围与正文结构
        context += ContextMessage(role = "system", content = bodyFormatText, keepSeparate = true)
        if (postHistoryText.isNotEmpty()) {
            context += ContextMessage(role = "system", content = postHistoryText)
        }

        // ===== 续写模式 =====
        if (options.continuation) {
            context += ContextMessage(role = "user", content = CONTINUATION_INSTRUCTION)
        }

        // Assistant Prefix：instruct 模式且 appendAssistantPrefix=true 时添加角色名前缀（续写跳过）
        val provider = profile?.provider ?: "openai"
        val instructTemplate = ChatTemplates.resolveEffectiveTemplate(
            preset?.contextTemplate,
            provider,
            model,
            profile?.useInstructTemplate,
        )
        if (!options.continuation && instructTemplate?.appendAssistantPrefix == true && charNameForVars.isNotEmpty()) {
            context += ContextMessage(role = "assistant", content = "")
        }

        // 消息后处理：合并连续相同角色消息 → 按 provider 转换格式
        val merged = ChatMessagePostProcess.mergeConsecutiveMessages(
            context.map {
                ChatPromptConverters.ChatMessage(
                    role = it.role,
                    content = it.content,
                    images = it.images,
                    keepSeparate = it.keepSeparate,
                )
            },
        )
        val processed = ChatPromptConverters.convertMessages(
            provider,
            merged,
            ChatPromptConverters.PromptNames(charName = charNameForVars, userName = userName),
        )

        return BuildResult(
            messages = processed.map {
                ContextMessage(role = it.role, content = it.content, images = it.images, keepSeparate = it.keepSeparate)
            },
            lastContextUsage = ContextUsage(used = usedTokens, max = budgetBase),
            overflowTokens = maxOf(0, usedTokens - budgetBase),
            lorebookTriggeredEntryKeys = lorebookTriggeredIds ?: emptyList(),
            responsePolicy = plan.responsePolicy,
            requestMaxTokens = plan.requestMaxTokens,
            responseIntent = plan.responseIntent,
            sceneFactor = plan.sceneFactor,
            narrativeMode = narrativeMode,
            pendingCompression = pendingCompression,
        )
    }
}
