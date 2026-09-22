package com.qingyu.companion.chatcore

/**
 * 阶段 6 S6-01：free（AI 自选）模式多角色回复的拆分与归属
 * （对齐 `shared/chat-core/groupFreeSplit.ts`）。
 *
 * free 模式一次生成返回多角色发言，按「【角色名】」标记拆分成多条消息。
 * 拆分规则直接决定**消息条数与角色归属**；两端不一致会让同一段群聊在两端
 * 拥有不同的消息序列，影响导出、记忆摘要、上下文与同步。
 *
 * 语义钉子（与 PC 逐字一致，禁止"顺手修复"）：
 * - omniscient（全知叙事）**不拆分**：整条作为单一成员回应（无成员时 `__narrator__`），
 *   避免【判定】/【可选行动】被分段器误识别；
 * - 首个标记前的旁白并入首段（`\n\n` 连接，空部分丢弃）；标记之间的文本归上一段；
 * - 未识别角色名的内容旁注为「⚠️ 未识别角色「名」: 内容」：上一条归属**首成员**则并入，
 *   否则新建一条首成员消息；识别到但正文为空的段直接丢弃（无旁注）；
 * - 无任何标记时整条回落首成员（无成员则 `__free__`），空正文占位 `(无回复)`。
 */
object ChatGroupFreeSplit {

    const val EMPTY_CONTENT: String = "(无回复)"
    const val NARRATOR_ID: String = "__narrator__"
    const val FREE_ID: String = "__free__"

    private const val UNRECOGNIZED_PREFIX = "⚠️ 未识别角色「"

    data class Member(val id: String, val name: String)

    data class Message(val characterId: String, val content: String)

    /** kind = "narrator" / "segments" / "fallback"。 */
    data class Result(val kind: String, val messages: List<Message>)

    private val SEGMENT_PATTERN = Regex("【(.+?)】")

    fun split(content: String, members: List<Member>, narrativeMode: String?): Result {
        // 全知叙事：保留为单条实际成员回应
        if (narrativeMode == "omniscient") {
            return Result(
                kind = "narrator",
                messages = listOf(
                    Message(
                        characterId = members.firstOrNull()?.id ?: NARRATOR_ID,
                        content = content.ifEmpty { EMPTY_CONTENT },
                    ),
                ),
            )
        }

        // 按 【角色名】 拆段（段内容 = 本标记与下一标记之间的文本）
        val segments = mutableListOf<Pair<String, String>>() // name to content
        var lastIdx = 0
        var preamble = ""
        for (match in SEGMENT_PATTERN.findAll(content)) {
            val textBefore = content.substring(lastIdx, match.range.first).trim()
            if (segments.isEmpty()) {
                // 首个标记前的旁白先暂存，收尾时并入首段（避免被后续迭代覆盖）
                preamble = textBefore
                segments.add(match.groupValues[1] to "")
            } else {
                segments[segments.size - 1] = segments[segments.size - 1].first to textBefore
                segments.add(match.groupValues[1] to "")
            }
            lastIdx = match.range.first + match.value.length
        }
        if (segments.isNotEmpty()) {
            segments[segments.size - 1] = segments[segments.size - 1].first to content.substring(lastIdx).trim()
            if (preamble.isNotEmpty()) {
                val first = segments[0].second
                segments[0] = segments[0].first to listOf(preamble, first).filter { it.isNotEmpty() }.joinToString("\n\n")
            }
        }

        if (segments.isEmpty()) {
            // 没有任何角色标记 → 回落首成员，避免渲染为不可见消息
            return Result(
                kind = "fallback",
                messages = listOf(
                    Message(
                        characterId = members.firstOrNull()?.id ?: FREE_ID,
                        content = content.ifEmpty { EMPTY_CONTENT },
                    ),
                ),
            )
        }

        val messages = mutableListOf<Message>()
        for ((name, segContent) in segments) {
            // 大小写不敏感 + 去除空格 进行角色名匹配
            val segName = name.lowercase().trim()
            val char = members.find { it.name.lowercase().trim() == segName }
            if (char == null || segContent.isEmpty()) {
                // 未识别角色：旁注归属首成员（上一条已是首成员则并入，否则新建）
                if (segContent.isNotEmpty() && members.isNotEmpty()) {
                    val note = UNRECOGNIZED_PREFIX + name + "」: " + segContent
                    val fallbackSeg = messages.lastOrNull()
                    if (fallbackSeg != null && fallbackSeg.characterId == members[0].id) {
                        messages[messages.size - 1] = fallbackSeg.copy(content = fallbackSeg.content + "\n\n" + note)
                    } else {
                        messages.add(Message(characterId = members[0].id, content = note))
                    }
                }
                continue
            }
            messages.add(Message(characterId = char.id, content = segContent))
        }
        return Result(kind = "segments", messages = messages)
    }
}
