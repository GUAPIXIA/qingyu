package com.qingyu.companion.chatcore

/**
 * 阶段 4 A5：对话「下一步方向」共享协议
 * （对齐 `shared/dialogueDirections.ts`）。
 *
 * 桌面端、群聊与桥接层共用同一实现，避免三端各写一套降级逻辑。
 * 本模块负责：会话开关解析、输出提取与校验、重复度判定、提示词构造。
 *
 * **校验策略是「全有或全无」**：任一条件不满足即整组作废（不渲染部分选项）——
 * 只显示 2 个方向会让用户以为第 3 个不存在，而不是知道生成失败了。
 */
object ChatDialogueDirections {

    /** safe | explore | risky */
    val TENDENCIES = listOf("safe", "explore", "risky")

    /** 单个方向的数量与长度约束（方案 §4.3）。 */
    const val COUNT = 3
    const val LABEL_MIN_CHARS = 6
    const val LABEL_MAX_CHARS = 14
    const val CONTENT_MIN_CHARS = 15
    const val CONTENT_MAX_CHARS = 60

    /** 方向生成请求的采样温度。 */
    const val TEMPERATURE = 0.6

    /** 标签名：允许模型在 JSON 外包裹统一标签。 */
    const val TAG = "directions"

    data class Direction(
        val id: String,
        val label: String,
        val content: String,
        /** safe | explore | risky */
        val tendency: String,
    )

    fun isTendency(value: String?): Boolean = value != null && TENDENCIES.contains(value)

    /**
     * 会话级开关的兼容解析：优先新字段，其次旧游戏主持字段，最后关闭。
     * 旧会话若开过游戏主持格式，升级后自动启用下一步方向。
     */
    fun resolveEnabled(dialogueDirectionsEnabled: Boolean?, gameMasterMode: Boolean?): Boolean =
        dialogueDirectionsEnabled ?: gameMasterMode ?: false

    /**
     * 从辅助模型响应中提取 `<directions>` 内的 JSON 文本。
     * 缺失或重复标签均判无效，避免把分析过程或提示词当成业务数据。
     * 调用方应先把 thought 块剥离后再传入。
     */
    fun extractPayload(raw: String): String {
        val matches = Regex("<\\s*directions\\s*>([\\s\\S]*?)<\\s*/\\s*directions\\s*>", RegexOption.IGNORE_CASE)
            .findAll(raw).toList()
        if (matches.size != 1) return ""
        return matches[0].groupValues[1].trim()
    }

    private fun stripCodeFence(text: String): String {
        val fenced = Regex("^```(?:json)?\\s*([\\s\\S]*?)\\s*```$", RegexOption.IGNORE_CASE).find(text.trim())
        return fenced?.groupValues?.get(1)?.trim() ?: text
    }

    /** 解释性前缀：命中即视为模型把说明当成了选项内容。 */
    private val EXPLANATORY_PREFIXES = listOf(
        "选项", "建议你", "作为AI", "作为 AI", "以下是", "注意：", "提示：", "说明：",
    )

    private fun hasExplanatoryPrefix(text: String): Boolean {
        val normalized = text.trim()
        return EXPLANATORY_PREFIXES.any { normalized.startsWith(it) }
    }

    /**
     * 解析并校验方向输出。任一条件不满足即整组作废（不渲染部分选项），
     * 校验项见方案 §4.3：数量、长度、倾向覆盖、重复度与解释性前缀。
     */
    fun parse(raw: String): List<Direction> {
        val payload = stripCodeFence(extractPayload(raw))
        if (payload.isEmpty()) return emptyList()

        val array = runCatching { org.json.JSONArray(payload) }.getOrNull() ?: return emptyList()
        if (array.length() != COUNT) return emptyList()

        val seenTendencies = mutableSetOf<String>()
        val seenIds = mutableSetOf<String>()
        val directions = mutableListOf<Direction>()

        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: return emptyList()
            if (!item.has("label") || !item.has("content")) return emptyList()
            val label = item.optString("label")
            val content = item.optString("content")
            val tendency = item.optString("tendency")
            if (!isTendency(tendency)) return emptyList()

            // id 由倾向派生，避免模型自造重复或不稳定的 id
            val rawId = item.optString("id").trim()
            val resolvedId = rawId.ifEmpty { tendency }
            if (seenIds.contains(resolvedId) || seenTendencies.contains(tendency)) return emptyList()
            seenIds += resolvedId
            seenTendencies += tendency

            val trimmedLabel = label.trim()
            val trimmedContent = content.trim()
            val labelChars = ChatTextMetrics.countVisibleCharacters(trimmedLabel)
            val contentChars = ChatTextMetrics.countVisibleCharacters(trimmedContent)
            if (labelChars < LABEL_MIN_CHARS || labelChars > LABEL_MAX_CHARS) return emptyList()
            if (contentChars < CONTENT_MIN_CHARS || contentChars > CONTENT_MAX_CHARS) return emptyList()
            if (hasExplanatoryPrefix(trimmedLabel) || hasExplanatoryPrefix(trimmedContent)) return emptyList()

            directions += Direction(resolvedId, trimmedLabel, trimmedContent, tendency)
        }

        if (seenTendencies.size != COUNT) return emptyList()
        if (hasSimilar(directions)) return emptyList()

        // 稳定输出顺序，便于界面与测试断言
        return TENDENCIES.mapNotNull { tendency -> directions.firstOrNull { it.tendency == tendency } }
    }

    /** 归一化用于重复度比较：去空白、标点与大小写差异。 */
    private fun normalizeForCompare(text: String): String {
        val builder = StringBuilder(text.length)
        for (ch in text) {
            if (ch.isWhitespace()) continue
            if (ch in "，。！？、；：,.!?;:'\"“”‘’（）()【】[]—-") continue
            builder.append(ch.lowercaseChar())
        }
        return builder.toString()
    }

    /**
     * 基础重复度判定：三项两两比较，完全同形或字符集合高度重叠视为重复。
     * 不引入向量计算，只做文本归一化。
     */
    fun hasSimilar(directions: List<Direction>): Boolean {
        val normalized = directions.map { normalizeForCompare(it.label + it.content) }
        for (i in normalized.indices) {
            for (j in i + 1 until normalized.size) {
                val a = normalized[i]
                val b = normalized[j]
                if (a.isEmpty() || b.isEmpty()) continue
                if (a == b) return true
                val shorter = if (a.length <= b.length) a else b
                val longer = if (a.length <= b.length) b else a
                if (shorter.length >= 8 && longer.contains(shorter)) return true
                // 字符集合重叠率：短串字符有 90% 以上出现在长串中视为高度相似
                val chars = longer.toSet()
                val overlap = shorter.count { chars.contains(it) }
                if (shorter.length >= 10 && overlap.toDouble() / shorter.length >= 0.9) return true
            }
        }
        return false
    }

    /** 方向生成器的提示词上下文（方案 §4.1 的注入边界）。 */
    data class GenerationInput(
        val userName: String,
        val charName: String,
        val characterDescription: String,
        /** 产生方向的那条消息的叙事模式快照，**不是**当前会话设置。 */
        val narrativeMode: String,
        /** 最近若干条有效对话，已按时间正序排列。 */
        val recentMessages: List<SpeakerMessage>,
        /** 产生方向的最新 AI 回复正文。 */
        val latestReply: String,
        /** 世界状态精简片段；为空时不注入。 */
        val worldState: String? = null,
    )

    data class SpeakerMessage(val speaker: String, val content: String)

    /**
     * 构造方向生成的 system 提示词。两种叙事模式分别约束 content 的叙事身份，
     * 不允许把 AI 正文改写成选项格式，也不注入世界书或完整预设。
     */
    fun buildSystemPrompt(input: GenerationInput): String {
        val userName = input.userName
        val charName = input.charName
        val identity = if (input.narrativeMode == "omniscient") {
            "当前采用全局叙事：$userName 是故事外部的旁白、导演与世界推动者，" +
                "方向内容应写成旁白式的剧情推动或世界变化，使用第三人称，不得写成某个角色的第一人称台词。"
        } else {
            "当前采用代入式角色扮演：$userName 是玩家角色，方向内容应是玩家角色可以说的话或可以尝试的行动，" +
                "用玩家视角口吻，不得替 $charName 或其他角色发言。"
        }

        return "你是剧情推进助手，负责在 AI 回复之后提供 3 个风格不同的「下一步方向」，供用户挑选后继续对话。\n\n" +
            "$identity\n\n" +
            "输出要求：\n" +
            "- 必须使用简体中文\n" +
            "- 只返回一组 <$TAG>...</$TAG> 标签，标签内是合法 JSON 数组，标签外不要输出任何内容\n" +
            "- 数组必须恰好 3 个元素，每个元素包含 id、label、content、tendency 四个字段\n" +
            "- label 是 $LABEL_MIN_CHARS–$LABEL_MAX_CHARS 个可见字符的短标签，概括这个方向要做什么；" +
            "不足 $LABEL_MIN_CHARS 字（如“关窗守屋”）会被判为非法并触发一次重试\n" +
            "- content 是 $CONTENT_MIN_CHARS–$CONTENT_MAX_CHARS 个可见字符的可发送文本，用户点选后会直接进入输入框\n" +
            "- tendency 三个值必须各出现一次：safe（稳妥推进，承接主线减少风险）、" +
            "explore（探索信息，追问观察调查试探）、risky（冒险变化，接受显著风险或改变计划）\n" +
            "- 三个方向必须有实质差异：分别对应 safe / explore / risky，不得只是同一句话的不同措辞\n" +
            "- 只描述接下来可以做什么，不要评价、建议或解释，不要写“选项 A”“建议你”“作为 AI”等前缀\n" +
            "- 不要泄露 $userName 的角色尚未知晓的幕后信息"
    }

    /** 构造方向生成的 user 提示词：最近对话 + 最新回复 + 精简世界状态。 */
    fun buildUserPrompt(input: GenerationInput): String {
        val lines = mutableListOf(
            "当前角色：${input.charName}",
            "角色设定：${input.characterDescription.ifEmpty { "无" }}",
        )
        val world = input.worldState?.trim()
        if (!world.isNullOrEmpty()) lines += "当前世界状态（精简）：$world"
        if (input.recentMessages.isNotEmpty()) {
            lines += ""
            lines += "最近对话："
            for (message in input.recentMessages) {
                lines += "${message.speaker}：${message.content}"
            }
        }
        lines += ""
        lines += "最新一条 AI 回复（${input.charName}）："
        lines += input.latestReply.trim()
        lines += ""
        lines += "请据此给出 ${input.userName} 接下来可以选择的 3 个方向。"
        return lines.joinToString("\n")
    }
}
