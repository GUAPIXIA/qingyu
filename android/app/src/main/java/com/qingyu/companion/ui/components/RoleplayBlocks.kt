package com.qingyu.companion.ui.components

/**
 * 语义分块（阶段7.2，方案 §6.2）：PC `src/utils/roleplayBlocks.ts` 的 Kotlin 等价移植。
 *
 * 两端共用同一份契约样本 `shared/fixtures/roleplay-blocks.json`（权威在 PC 侧），
 * RoleplayBlocksFixtureTest 逐条比对块数量与类型，防止 TypeScript/Kotlin 规则漂移。
 *
 * 规则与 PC 一致：
 * - `<thought>...</thought>` 转 thought（可跨行）；
 * - 纯中文引号段转 dialogue（可带 1-8 字说话人前缀，叙述式前缀排除）；
 * - 旧整段 `*动作*` 转 narration（剥离星号）；
 * - 同行混合内容转 mixed，按普通正文安全显示；
 * - 其余普通段落转 narration；同段相邻 narration 合并，空行分块；
 * - 只影响展示样式，不改写除剥离包裹星号之外的任何字符。
 */
sealed class RoleplayBlock {
    data class Dialogue(val text: String, val speaker: String?) : RoleplayBlock()
    class Narration(var text: String) : RoleplayBlock()
    data class Thought(val text: String) : RoleplayBlock()
    data class Mixed(val text: String) : RoleplayBlock()
}

object RoleplayBlocks {

    /**
     * JavaScript `s` 字符类的完整覆盖集（Java 的 `s` 只含 ASCII 空白，直接使用会导致
     * 全角空格 / NBSP 等 trim 行为漂移，故显式列字符类保持跨端一致）。
     */
    private const val JS_SPACE = "\\t\\n\\u000B\\u000C\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"

    /** JS trim / s 视同空白的字符集（0x0B/0x0C 用 toChar 构造，规避字面控制字符） */
    private val JS_SPACE_CHARS: Set<Char> = setOf(
        '\t', '\n', 0x0B.toChar(), 0x0C.toChar(), '\r', ' ',
        '\u00A0', '\u1680', '\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF',
    )

    /**
     * 说话人前缀 + 纯对白：冒号前 1-8 个非空白非标点字符（对齐 PC SPEAKER_QUOTE），
     * 再用 NARRATION_PREFIX 排除叙述式前缀（代词/助词/动作动词），避免
     * "她轻声说道：/苏晚推开门："被误当说话人。
     */
    internal val SPEAKER_QUOTE =
        Regex("^([^“”「」『』：:$JS_SPACE，。！？、；,.!?;'\"()（）【】〔〕—…·\\-]{1,8})[：:][$JS_SPACE]*([“「][\\s\\S]*[”」])$")

    /** 叙述式前缀特征字（与 PC NARRATION_PREFIX 同集合）：命中任一即视为叙述而非角色名 */
    internal val NARRATION_PREFIX =
        Regex("[她他它您我谁的了着是在推说道问答笑喊叫哼吼念讲走站坐打握摇抬皱眨顿望听看感摆挥耸抿咬飘]")

    /** 整行纯对白 */
    internal val PURE_QUOTE = Regex("^[“「][\\s\\S]*[”」]$")

    /** 整行动作段（旧样式星号包裹，等价 JS 带 s 标志的星号整行匹配） */
    private val ACTION_LINE = Regex("^\\*(.+)\\*$", setOf(RegexOption.DOT_MATCHES_ALL))

    /** 行内是否含引号字符（判断混写） */
    private val CONTAINS_QUOTE = Regex("[“”「」『』]")

    /** 思考块（可跨行，后随空白一并吞掉） */
    private val THOUGHT_BLOCK =
        Regex("<thought>([\\s\\S]*?)</thought>[$JS_SPACE]*", RegexOption.IGNORE_CASE)

    /** 段落边界：空行 */
    private val BLANK_LINE = Regex("\\n[$JS_SPACE]*\\n")

    /**
     * 展示层剥除对白外层引号（“…”/「…」/『…』成对时去掉；对齐 PC stripOuterQuotes）。
     * 只影响渲染：块 text 与消息正文保持原文，复制/搜索不受影响。
     */
    fun stripOuterQuotes(text: String): String {
        val t = trimLine(text)
        return if (
            (t.startsWith("“") && t.endsWith("”")) ||
            (t.startsWith("「") && t.endsWith("」")) ||
            (t.startsWith("『") && t.endsWith("』"))
        ) {
            t.substring(1, t.length - 1)
        } else {
            text
        }
    }

    private fun isJsSpace(c: Char): Boolean =
        JS_SPACE_CHARS.contains(c) || (c >= '\u2000' && c <= '\u200A')

    /** 按码点 trim（对齐 TS trimLine：JS 空白 + 全角空格） */
    private fun trimLine(line: String): String =
        line.dropWhile { isJsSpace(it) }.reversed().dropWhile { isJsSpace(it) }.reversed()

    /** 单行归类（对齐 TS classifyLine） */
    private fun classifyLine(rawLine: String): RoleplayBlock {
        val line = trimLine(rawLine)
        if (line.isEmpty()) return RoleplayBlock.Narration("")

        // 旧样式动作段：*动作* 转 narration（剥离星号，避免与样式叠加）
        ACTION_LINE.matchEntire(line)?.let { action ->
            return RoleplayBlock.Narration(trimLine(action.groupValues[1]))
        }

        // 说话人 + 纯对白：苏晚：“我知道。”（单字角色名同样成立；叙述式前缀排除）
        SPEAKER_QUOTE.matchEntire(line)?.let { m ->
            if (!NARRATION_PREFIX.containsMatchIn(m.groupValues[1])) {
                return RoleplayBlock.Dialogue(m.groupValues[2], speaker = trimLine(m.groupValues[1]))
            }
        }

        // 整行纯对白
        if (PURE_QUOTE.matchEntire(line) != null) return RoleplayBlock.Dialogue(line, null)

        // 对白与叙述混写 转 mixed，保持原文
        if (CONTAINS_QUOTE.containsMatchIn(line)) return RoleplayBlock.Mixed(line)

        return RoleplayBlock.Narration(line)
    }

    /**
     * 将正文解析为语义块（对齐 TS buildRoleplayBlocks）：
     * 思考块优先切分，其余按行分类；只影响展示，不改写正文。
     */
    fun build(content: String?): List<RoleplayBlock> {
        if (content.isNullOrEmpty()) return emptyList()

        val blocks = mutableListOf<RoleplayBlock>()
        var lastIndex = 0
        for (match in THOUGHT_BLOCK.findAll(content)) {
            appendLines(blocks, content.substring(lastIndex, match.range.first))
            val inner = trimLine(match.groupValues[1])
            if (inner.isNotEmpty()) blocks.add(RoleplayBlock.Thought(inner))
            lastIndex = match.range.last + 1
        }
        appendLines(blocks, content.substring(lastIndex))

        return blocks.filterNot { it is RoleplayBlock.Narration && it.text.isEmpty() }
    }

    /** 纯文本按行分类并追加（同段相邻 narration 合并；空行分隔段落；对齐 TS appendLines） */
    private fun appendLines(blocks: MutableList<RoleplayBlock>, text: String) {
        if (text.isEmpty()) return
        val paragraphs = BLANK_LINE.split(text)
        for (paragraph in paragraphs) {
            var lastNarration: RoleplayBlock.Narration? = null
            for (rawLine in paragraph.split('\n')) {
                val line = trimLine(rawLine)
                if (line.isEmpty()) continue
                val block = classifyLine(line)
                val prev = blocks.lastOrNull()
                if (block is RoleplayBlock.Narration && prev != null && prev === lastNarration) {
                    prev.text = prev.text + "\n" + block.text
                } else {
                    blocks.add(block)
                    if (block is RoleplayBlock.Narration) lastNarration = block
                }
            }
        }
    }
}
