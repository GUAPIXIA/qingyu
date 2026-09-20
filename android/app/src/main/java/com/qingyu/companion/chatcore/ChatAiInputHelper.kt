package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-04：输入框 AI 辅助（续写 / 润色）
 * （对齐 `shared/chat-core/aiInputHelper.ts`）。
 *
 * 这些是纯函数，但语义密度很高：它们决定「什么样的模型输出可以写回输入框」。
 * 实测教训（原注释保留）：多数聚合端点忽略 `thinking: disabled`，推理内容既占输出预算、
 * 又让模型忘记加标签——但产出的正文本身完全可用。因此标签是「信封」而非正确性前提：
 * 完整标签对优先，缺失时回退到未闭合内容或全文，再由长度与完整性校验把关。
 *
 * **绝不允许 thought-only 回退**：辅助调用的结果会进入输入框或被下游服务使用。
 */
object ChatAiInputHelper {

    /** 续写解析失败的归因；用于给出可操作的提示，而不是笼统的「无效正文」。 */
    const val FAILURE_TRUNCATED = "truncated"
    const val FAILURE_INVALID_CONTENT = "invalid-content"
    const val FAILURE_EMPTY = "empty"

    /** 长度校验结论。 */
    const val ACTION_ACCEPT = "accept"
    const val ACTION_TRIM = "trim"
    const val ACTION_SUPPLEMENT = "supplement"
    const val ACTION_COMPRESS = "compress"

    /** 转义正则特殊字符（构造角色名/用户名匹配时使用）。 */
    private fun escapeRegExp(text: String): String {
        val builder = StringBuilder(text.length + 8)
        for (ch in text) {
            if (ch in ".*+?^\${}()|[]\\") builder.append('\\')
            builder.append(ch)
        }
        return builder.toString()
    }

    /**
     * 名字发言行的正则源片段：允许行首缩进与 Markdown 星号装饰（*Aiko* / **Aiko** / ***Aiko***）。
     * `lineAnchor` 传行首锚（如 `^` 或 `\n`），内部会被包成非捕获组。
     */
    private fun speakerLineSource(name: String, lineAnchor: String): String =
        "(?:$lineAnchor)[ \\t]*\\*{0,3}${escapeRegExp(name)}\\*{0,3}\\s*[:：]"

    /**
     * 后处理：确保输出是用户视角，剥离角色视角内容。
     * 若 AI 以角色名开头回复（含冒号），则提取用户发言部分；找不到用户部分则返回空串。
     */
    fun ensureUserPerspective(raw: String, userName: String, charName: String): String {
        var output = raw.trim()
        val charPrefix = Regex("${speakerLineSource(charName, "^")}\\s*", RegexOption.IGNORE_CASE)
        if (charPrefix.containsMatchIn(output)) {
            // 用户部分可能跨多个段落：捕获到文本结尾，再截到角色下一次开口为止
            val userLine = Regex("${speakerLineSource(userName, "^|\\n")}\\s*([\\s\\S]*)", RegexOption.IGNORE_CASE)
            val match = userLine.find(output)
            if (match != null) {
                val rest = match.groupValues[1]
                val nextCharLine = Regex(speakerLineSource(charName, "\\n"), RegexOption.IGNORE_CASE)
                val stop = nextCharLine.find(rest)?.range?.first ?: -1
                output = (if (stop >= 0) rest.substring(0, stop) else rest).trim()
            } else {
                return ""
            }
        }
        return output
    }

    /**
     * 续写输出按叙事身份清洗：代入模式保护用户身份；
     * 全局模式的正文属于旁白，即使以焦点角色名开头也不能当成「替角色发言」删除。
     */
    fun normalizeContinueOutput(raw: String, userName: String, charName: String, narrativeMode: String): String =
        if (narrativeMode == "omniscient") raw.trim() else ensureUserPerspective(raw, userName, charName)

    /**
     * 从辅助模型响应中提取唯一的业务结果标签。标签位于 thought 内时会先被剥离，
     * **缺失或重复均视为无效**，避免把分析、检查清单或提示词本身写入业务数据。
     */
    fun extractTaggedResult(raw: String, tag: String): String {
        val content = ChatMessagePostProcess.stripThought(raw)
        if (content.isEmpty()) return ""
        val pattern = Regex("<\\s*$tag\\s*>([\\s\\S]*?)<\\s*/\\s*$tag\\s*>", RegexOption.IGNORE_CASE)
        val matches = pattern.findAll(content).toList()
        if (matches.size != 1) return ""
        return matches[0].groupValues[1].trim()
    }

    /** 续写必须以中文为主；允许少量英文角色名或专有名词。 */
    private fun isChineseContinuation(text: String): Boolean {
        val han = text.count { it.code in 0x3400..0x9fff }
        val latin = text.count { it in 'A'..'Z' || it in 'a'..'z' }
        return han >= 2 && han * 2 >= latin
    }

    /**
     * 无标签回退路径的更严判据。
     *
     * 标签内正文已遵守协议，容忍「中文正文 + 少量英文专名」（2:1）；
     * 无标签时无法区分「正文」与「英文分析里夹了一句中文」，因此要求中文字符不少于英文字符，
     * 挡住 "Need final only. 应该继续推进剧情。" 这类混合输出。
     */
    private fun isPredominantlyChinese(text: String): Boolean {
        val han = text.count { it.code in 0x3400..0x9fff }
        val latin = text.count { it in 'A'..'Z' || it in 'a'..'z' }
        return han >= 4 && han >= latin
    }

    /**
     * 剥离模型写在正文前的元说明（如「以下是续写：」「好的，我来补写：」）。
     * 只认「短、含元词、以冒号结尾」的整行，避免误删正文（对白里也可能以「好的」开头）。
     */
    private fun stripContinuationPreamble(text: String): String {
        val match = Regex("^[^\\n。！？]{0,24}?(?:续写|补写|正文|内容|如下|接着写)[^\\n。！？]{0,12}[：:]\\s*\\n?").find(text)
        return if (match != null) text.substring(match.value.length).trim() else text
    }

    /** 去掉可能残留的标签字面量（截断或未包裹时会出现）。 */
    private fun stripTagLiterals(text: String, tag: String): String =
        text.replace(Regex("<\\s*/?\\s*$tag\\s*>", RegexOption.IGNORE_CASE), "").trim()

    /**
     * 提取并校验可安全写回输入框的续写正文。
     *
     * 标签是「信封」而非正确性前提：实测聚合端点常忽略 `thinking: disabled`，
     * 推理内容既占用输出预算、又让模型忘记加标签，但产出的正文本身完全可用。
     * 因此完整标签对优先，缺失时回退到标签内未闭合内容或全文，经元说明剥离后使用；
     * 长度与完整性由 `evaluateContinueLength` 继续把关（截断会走补足修复）。
     */
    fun parseContinueResult(raw: String, userName: String, charName: String, narrativeMode: String): String {
        val content = ChatMessagePostProcess.stripThought(raw)
        if (content.isEmpty()) return ""

        val tagged = extractTaggedResult(content, "continuation")
        val candidate: String
        val fromTag: Boolean
        if (tagged.isNotEmpty()) {
            candidate = tagged
            fromTag = true
        } else {
            // 未闭合（被切断）时取开标签之后的部分；完全没有标签则用全文
            val openMatch = Regex("<\\s*continuation\\s*>([\\s\\S]*)$", RegexOption.IGNORE_CASE).find(content)
            candidate = stripContinuationPreamble(
                stripTagLiterals(if (openMatch != null) openMatch.groupValues[1] else content, "continuation"),
            )
            fromTag = false
        }

        // 标签外内容需更严的中文占比判据，避免把「英文分析 + 中文尾巴」当成正文
        val accepted = if (fromTag) isChineseContinuation(candidate) else isPredominantlyChinese(candidate)
        if (!accepted) return ""
        val normalized = normalizeContinueOutput(candidate, userName, charName, narrativeMode)
        return if (normalized.isNotEmpty() && isChineseContinuation(normalized)) normalized else ""
    }

    /**
     * 归因续写为何无法使用：
     * - empty：思考内容之外没有正文——实测聚合端点忽略 `thinking: disabled`，
     *   推理会吃光输出预算，这是「没有正文」的最常见成因；
     * - truncated：写了但没写完（含未闭合标签）；
     * - invalid-content：有内容但不是可用的中文正文（如只回了英文分析）。
     */
    fun classifyContinueFailure(raw: String): String {
        val content = ChatMessagePostProcess.stripThought(raw)
        if (content.isBlank()) return FAILURE_EMPTY
        val hasOpen = Regex("<\\s*continuation\\s*>", RegexOption.IGNORE_CASE).containsMatchIn(content)
        val hasClose = Regex("<\\s*/\\s*continuation\\s*>", RegexOption.IGNORE_CASE).containsMatchIn(content)
        if (hasOpen && !hasClose) return FAILURE_TRUNCATED
        return FAILURE_INVALID_CONTENT
    }

    /**
     * 解析失败是否值得再试一次格式。
     * 未加标签已由 [parseContinueResult] 回退接受，因此走到这里只剩「确实拿不到中文正文」
     * 或「内容不完整」，重试一次即可；长度修复由 [evaluateContinueLength] 另行触发。
     */
    fun shouldRetryContinueFormat(raw: String): Boolean = classifyContinueFailure(raw) != FAILURE_EMPTY

    data class LengthEvaluation(
        /** 本次新增内容的可见字符数 */
        val chars: Int,
        /** 是否以完整句收尾；不完整即视为被 maxTokens 截断 */
        val truncated: Boolean,
        val action: String,
        /** action == trim 时的收束结果（已落在目标区间内） */
        val trimmedText: String? = null,
    )

    /**
     * 生成后长度校验（方案 §6.5）。
     * 判定顺序：明显超长 → 上限 100%–120% 句边界收束 → 截断 → 明显偏短 → 容忍下限 → 接受。
     * 超长优先于截断：对已经超出上限的正文要求「补足」只会更长，应先压缩。
     * 「语义完整」用句末标点判定，不额外调用模型。
     */
    fun evaluateContinueLength(text: String, length: String): LengthEvaluation {
        val params = ChatContinueIntensity.paramsOf(length)
        val chars = ChatTextMetrics.countVisibleCharacters(text)
        val truncated = !ChatTextMetrics.isCompleteSentence(text)

        if (chars > params.maxChars * ChatContinueIntensity.REPAIR_CEILING_RATIO) {
            return LengthEvaluation(chars, truncated, ACTION_COMPRESS)
        }
        if (chars > params.maxChars) {
            val trimmed = ChatTextMetrics.trimToSentenceBoundary(text, params.minChars, params.maxChars)
            return if (trimmed != null) {
                LengthEvaluation(chars, truncated, ACTION_TRIM, trimmed)
            } else {
                LengthEvaluation(chars, truncated, ACTION_COMPRESS)
            }
        }
        // 被 maxTokens 截断的正文即使字数达标也要补足，不能把半截正文写回输入框
        if (truncated) return LengthEvaluation(chars, truncated, ACTION_SUPPLEMENT)
        if (chars < params.minChars * ChatContinueIntensity.ACCEPT_LOWER_RATIO) {
            return LengthEvaluation(chars, truncated, ACTION_SUPPLEMENT)
        }
        return LengthEvaluation(chars, truncated, ACTION_ACCEPT)
    }

    /**
     * 修复一次后的宽容判定：仍属轻微越界且句意完整时接受，明显越界返回 false
     * （调用方应保留用户原输入并给出可见反馈）。
     */
    fun isAcceptableAfterLengthRepair(text: String, length: String): Boolean {
        if (!ChatTextMetrics.isCompleteSentence(text)) return false
        val params = ChatContinueIntensity.paramsOf(length)
        val chars = ChatTextMetrics.countVisibleCharacters(text)
        return chars >= params.minChars * ChatContinueIntensity.SOFT_LOWER_RATIO &&
            chars <= params.maxChars * ChatContinueIntensity.SOFT_UPPER_RATIO
    }

    /**
     * 长度修复指令：追加到 system 提示词后重新请求一次。
     * 只约束字数与收尾方式——输出上限是统一的失控兜底，不在这里复述具体 token 数。
     */
    fun buildLengthRepairInstruction(
        mode: String,
        length: String,
        chars: Int,
        truncated: Boolean,
    ): String {
        val params = ChatContinueIntensity.paramsOf(length)
        if (mode == ACTION_COMPRESS) {
            return "上一次输出约 $chars 个可见字符，超出本次目标 ${params.minChars}–${params.maxChars} 字。" +
                "请压缩重写：保留关键信息与因果，删去重复、铺陈与次要细节，必须在目标区间内以完整句收尾。"
        }
        val truncatedNote = if (truncated) {
            "上一次输出未能写完就中断了。"
        } else {
            "上一次输出约 $chars 个可见字符，低于本次目标 ${params.minChars}–${params.maxChars} 字。"
        }
        return truncatedNote +
            "请补足到目标区间（${params.minChars}–${params.maxChars} 个可见字符），以完整句收尾；" +
            "不要复述已有内容，也不要增加无关支线。"
    }

    // ---------------------------------------------------------------- 提示词构造

    /**
     * 全局叙事下各强度档位的推进幅度指令。active 档保持强度功能引入前的原文案。
     * 注意：不要写回「1–3 句」等旧硬性长度短语（既有测试断言其不存在）。
     */
    private fun omniscientScopeClause(intensity: String): String = when (intensity) {
        "subtle" -> "- 只写一处细微的环境、氛围或细节变化，不引入新事件、新角色或新冲突；不替对方角色完成详细反应"
        "steady" -> "- 顺着当前场景与最近矛盾做小幅推进，只加入小阻碍或新信息，不改变当前主线；不替对方角色完成详细反应"
        "bold" -> "- 可引入重大转折、场景切换、时间推进或新的冲突线；不替对方角色完成详细反应"
        else -> "- 推动局势发生变化，优先加入事件、压力、线索、阻碍或转折\n" +
            "- 只提出变化并把故事推到下一个反应点，不展开完整场景，不替对方角色完成详细反应"
    }

    /** 代入角色模式下各强度档位的补全幅度指令；active 档不加额外约束。 */
    private fun immersiveScopeClause(intensity: String): String = when (intensity) {
        "subtle" -> "- 只补完当前表达或添加细微变化，不引入新的剧情发展"
        "steady" -> "- 顺着当前意图自然承接，可加入轻微波澜，但不改变当前主线"
        "bold" -> "- 可以引入重大转折、场景变化或新的冲突方向，但保持因果可信"
        else -> "- 引入有因果依据的事件、压力或线索，把情节推到下一个反应点"
    }

    /**
     * 本次新增内容的篇幅目标；长度控制的唯一手段，不参与剧情转折判断。
     * 语义是「续写新增的部分」，不是「合并原文后的最终输入框内容」——
     * 原文已经很长时，靠追加无法让最终内容变短（方案 §6.1）。
     */
    private fun continueLengthClause(length: String, hasInput: Boolean): String {
        val params = ChatContinueIntensity.paramsOf(length)
        val lead = if (hasInput) {
            "本次只输出直接接在原文之后的新内容，不要复述原文"
        } else {
            "本次只输出用户接下来要说的新内容"
        }
        return "- 篇幅由本指令控制：$lead，写 ${params.minChars}–${params.maxChars} 个可见中文字符，${params.structure}\n" +
            "- 一次把目标篇幅写完，不要只写开头就收尾，也不要大幅超出上限\n" +
            "- 必须在完整句处结束，不要为了凑字数重复信息\n" +
            "- 如果情节已经自然完成，宁可接近下限，也不得增加无关支线"
    }

    /** 接续点约束：专门防止末尾复读、时序倒置和无输入时绕开当前悬念。 */
    private fun continueContinuityClause(hasInput: Boolean): String {
        if (hasInput) {
            return "- 不得重复原文末尾已经出现的词语、动作或句式\n" +
                "- 从完成原文所需的下一个新词或下一句直接写起，确保与原文拼接后语法通顺\n" +
                "- 保持动作与事件时序；不得把尚未发生的动作写成已经完成，也不得凭空倒叙为“刚才已经做过”"
        }
        return "- 优先回应最近一条尚未解决的问题、呼喊、威胁、承诺或悬念，处理后再补充次要细节\n" +
            "- 保持最近对话的时序与因果，不要绕开当前矛盾另起无关话题"
    }

    /** 构造续写的 systemPrompt（用户视角续写助手）。 */
    fun buildContinueSystemPrompt(
        userName: String,
        charName: String,
        hasInput: Boolean,
        narrativeMode: String = "immersive",
        intensity: String = ChatContinueIntensity.DEFAULT_INTENSITY,
        length: String = ChatContinueIntensity.DEFAULT_LENGTH,
    ): String {
        val lengthClause = continueLengthClause(length, hasInput)
        val continuityClause = continueContinuityClause(hasInput)
        if (narrativeMode == "omniscient") {
            val task = if (hasInput) {
                "请续写用户尚未完成的旁白推动，使其成为可直接发送、自然完整的剧情变化。"
            } else {
                "请根据最近对话中尚未解决的矛盾，生成可由用户直接发送、自然完整的旁白推动。"
            }
            return "你是用户侧的剧情推进助手。$task\n\n" +
                "严格要求：\n" +
                "- 必须使用简体中文输出\n" +
                "- 只以故事外部旁白的身份输出第三人称叙事，以角色名、“他”或“她”指代人物\n" +
                "- 不以 $charName 或任何角色的第一人称视角回应，不生成角色对白、角色名前缀或整段对话\n" +
                "- 写到本次剧情推动自然完成；可按叙事节奏分段\n" +
                "- 必须以完整句收尾，不要在动作、对白或因果关系尚未写完时停止\n" +
                "${omniscientScopeClause(intensity)}\n" +
                "$lengthClause\n" +
                "$continuityClause\n" +
                "- $charName 是当前故事焦点之一，但不要替 $charName 说话或完成详细心理与连续动作\n" +
                "- 不替 $userName 控制的玩家角色作重大选择，不一次解决当前冲突\n" +
                "- 保持既有时序、因果和叙述风格，不随机引入无关事件\n" +
                "- 不添加标题、“剧情建议”或解释\n" +
                "- 最终正文必须且只能放在一组 <continuation>...</continuation> 标签内，标签外不要输出任何内容"
        }

        val scope = immersiveScopeClause(intensity)
        if (hasInput) {
            return "你是一个角色扮演对话的用户视角续写助手。你的任务是以【用户 $userName】的身份和口吻，" +
                "续写用户未完成的消息。\n\n严格要求：\n" +
                "- 必须使用简体中文输出\n" +
                "- 只输出 $userName 的话语，绝对不要输出 $charName 的话语\n" +
                "- 不要以 $charName 的身份说话或行动\n" +
                "- 不要包含角色名前缀，直接输出对话内容\n" +
                "- 保持用户一贯的语气和风格\n" +
                "$scope\n$lengthClause\n$continuityClause\n" +
                "- 最终正文必须且只能放在一组 <continuation>...</continuation> 标签内，标签外不要输出任何内容"
        }
        return "你是一个角色扮演对话的用户视角续写助手。你的任务是以【用户 $userName】的身份和口吻，" +
            "生成一条合适的用户回复。\n\n严格要求：\n" +
            "- 必须使用简体中文输出\n" +
            "- 只输出 $userName 的话语，绝对不要输出 $charName 的话语\n" +
            "- 不要以 $charName 的身份说话或行动\n" +
            "- 不要包含角色名前缀，直接输出对话内容\n" +
            "- 保持用户一贯的语气和风格\n" +
            "$scope\n$lengthClause\n$continuityClause\n" +
            "- 最终正文必须且只能放在一组 <continuation>...</continuation> 标签内，标签外不要输出任何内容"
    }

    /** 全局叙事末条指令的推进幅度措辞；active 档保持强度功能引入前的原文案。 */
    private fun omniscientTaskInstruction(intensity: String, hasInput: Boolean): String = when (intensity) {
        "subtle" -> if (hasInput) {
            "请只补写直接接在原文后面的部分，不要复述原文；保持当前走向，仅加入细微变化，写完最后一句：\n"
        } else {
            "请基于最近对话保持当前走向，仅加入细微的环境或氛围变化，写完最后一句，不引入新事件"
        }
        "steady" -> if (hasInput) {
            "请只补写直接接在原文后面的部分，不要复述原文；顺着当前情节做小幅推进，写完最后一句：\n"
        } else {
            "请基于最近对话中的矛盾，生成一段小幅推进，写完最后一句，保留角色反应空间"
        }
        "bold" -> if (hasInput) {
            "请只补写直接接在原文后面的部分，不要复述原文；形成一次幅度较大的剧情转折或场景变化，并写完最后一句：\n"
        } else {
            "请基于最近对话中的矛盾，生成一次幅度较大的剧情转折或场景变化，写完最后一句，保留角色反应空间"
        }
        else -> if (hasInput) {
            "请只补写直接接在原文后面的部分，不要复述原文；形成自然完整的剧情推动，并写完最后一句：\n"
        } else {
            "请基于最近对话中尚未解决的矛盾，生成自然完整的剧情推动，写完最后一句，只提出变化并保留角色反应空间"
        }
    }

    data class ContinueContextMessage(val role: String, val content: String)

    data class ContinueContextInput(
        val charName: String,
        val charDescription: String,
        val charScenario: String,
        val userName: String,
        /** 最近对话（role + content），已按时间从旧到新排列 */
        val recentMessages: List<ContinueContextMessage>,
        val originalInput: String,
        val hasInput: Boolean,
        val narrativeMode: String = "immersive",
        val intensity: String? = null,
        val length: String? = null,
    )

    /** 构造续写的上下文消息（system + 最近消息 + 续写指令）。 */
    fun buildContinueContext(input: ContinueContextInput): List<ContinueContextMessage> {
        val intensity = ChatContinueIntensity.resolveIntensity(input.intensity)
        val length = ChatContinueIntensity.resolveLength(input.length)
        val systemPrompt = buildContinueSystemPrompt(
            input.userName,
            input.charName,
            input.hasInput,
            input.narrativeMode,
            intensity,
            length,
        )
        val messages = mutableListOf(
            ContinueContextMessage(
                role = "system",
                content = "$systemPrompt\n\n当前角色：${input.charName}\n" +
                    "角色设定：${input.charDescription.ifEmpty { "无" }}\n" +
                    "场景：${input.charScenario.ifEmpty { "无" }}",
            ),
        )
        for (message in input.recentMessages) {
            messages += ContinueContextMessage(
                role = if (message.role == "user") "user" else "assistant",
                // 历史消息可能携带 <thought> 内心独白（角色第一人称声口）。直接喂给续写会诱导
                // 模型模仿角色视角输出，随后被 ensureUserPerspective 整段清空，表现为
                // 「续写未生成可用内容」。续写只需要可见正文。
                content = ChatMessagePostProcess.stripThought(message.content),
            )
        }
        messages += ContinueContextMessage(
            role = "user",
            content = if (input.narrativeMode == "omniscient") {
                if (input.hasInput) {
                    omniscientTaskInstruction(intensity, true) + input.originalInput
                } else {
                    omniscientTaskInstruction(intensity, false)
                }
            } else {
                if (input.hasInput) {
                    "请以 ${input.userName} 的身份续写以下未完成的消息" +
                        "（直接接在后面的部分；不得重复末尾措辞，从下一个必要的新词或下一句写起）：\n" +
                        input.originalInput
                } else {
                    "请以 ${input.userName} 的身份根据上下文生成一条回复；优先回应最近一条尚未解决的问题或悬念"
                }
            },
        )
        return messages
    }

    /** `callAiHelper` 的采样默认值（与 PC 一致：未显式给出时由 preset 决定）。 */
    fun resolveHelperTemperature(explicit: Double?, presetTemperature: Double?): Double =
        explicit ?: presetTemperature ?: 0.5

    fun resolveHelperTopP(presetTopP: Double?): Double = presetTopP ?: 0.9
}
