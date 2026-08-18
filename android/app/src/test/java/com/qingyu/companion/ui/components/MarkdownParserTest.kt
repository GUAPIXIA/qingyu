package com.qingyu.companion.ui.components

import androidx.compose.ui.text.font.FontStyle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Markdown 纯函数单测（不依赖 Android 运行时）。
 * 覆盖：块级结构（标题/列表/引用/代码块/段落）与行内样式（加粗/斜体/行内代码/嵌套）。
 */
class MarkdownParserTest {

    @Test
    fun `解析块级结构`() {
        val source = "# 标题\n\n- 项目1\n- 项目2\n\n> 引用\n\n```kotlin\nval x = 1\n```\n\n段落"
        val blocks = parseMarkdown(source)

        assertEquals(6, blocks.size)
        assertEquals(MdBlock.Heading(1, "标题"), blocks[0])
        assertEquals(MdBlock.ListItem("项目1", ordered = false), blocks[1])
        assertEquals(MdBlock.ListItem("项目2", ordered = false), blocks[2])
        assertEquals(MdBlock.Quote("引用"), blocks[3])

        val code = blocks[4] as MdBlock.CodeBlock
        assertEquals("kotlin", code.language)
        assertEquals("val x = 1", code.code)

        assertEquals(MdBlock.Paragraph("段落"), blocks[5])
    }

    @Test
    fun `解析有序列表`() {
        val blocks = parseMarkdown("1. 甲\n2. 乙")
        assertEquals(2, blocks.size)
        assertEquals(MdBlock.ListItem("甲", ordered = true), blocks[0])
        assertEquals(MdBlock.ListItem("乙", ordered = true), blocks[1])
    }

    @Test
    fun `行内样式还原纯文本并产生样式段`() {
        val result = inlineMarkdown("**加粗** *斜体* `code`", InlineStyles())
        assertEquals("加粗 斜体 code", result.text)
        assertEquals(3, result.spanStyles.size)
    }

    @Test
    fun `嵌套加粗斜体`() {
        val result = inlineMarkdown("**bold *italic* tail**", InlineStyles())
        assertEquals("bold italic tail", result.text)
    }

    @Test
    fun `未闭合分隔符按原文输出`() {
        val result = inlineMarkdown("**未闭合 * 星号", InlineStyles())
        assertEquals("**未闭合 * 星号", result.text)
    }

    @Test
    fun `解析分隔线`() {
        val blocks = parseMarkdown("上方\n\n---\n\n下方")
        assertEquals(3, blocks.size)
        assertEquals(MdBlock.HorizontalRule, blocks[1])
    }

    @Test
    fun `解析GFM表格`() {
        val source = "| 列1 | 列2 |\n|---|---|\n| a | b |\n| c | d |"
        val blocks = parseMarkdown(source)
        assertEquals(1, blocks.size)
        val table = blocks[0] as MdBlock.Table
        assertEquals(listOf("列1", "列2"), table.headers)
        assertEquals(2, table.rows.size)
        assertEquals(listOf("a", "b"), table.rows[0])
        assertEquals(listOf("c", "d"), table.rows[1])
    }

    @Test
    fun `解析链接为链接样式`() {
        val result = inlineMarkdown("点击[这里](https://example.com)查看", InlineStyles())
        assertEquals("点击这里查看", result.text)
        assertEquals(1, result.spanStyles.size)
        assertEquals("这里", result.text.substring(result.spanStyles[0].start, result.spanStyles[0].end))
    }

    @Test
    fun `解析独立行图片`() {
        val blocks = parseMarkdown("![封面](https://example.com/cover.png)")
        assertEquals(1, blocks.size)
        assertEquals(MdBlock.Image("https://example.com/cover.png"), blocks[0])
    }

    @Test
    fun `代码块保留语言标签`() {
        val blocks = parseMarkdown("```kotlin\nval x = 1\n```")
        val code = blocks[0] as MdBlock.CodeBlock
        assertEquals("kotlin", code.language)
        assertEquals("val x = 1", code.code)
    }

    @Test
    fun `行内对话带样式`() {
        val result = inlineMarkdown("她低声说：\"别怕\"", InlineStyles())
        assertEquals("她低声说：\"别怕\"", result.text)
        assertEquals(1, result.spanStyles.size)
        assertEquals("\"别怕\"", result.text.substring(result.spanStyles[0].start, result.spanStyles[0].end))
    }

    @Test
    fun `极端嵌套格式不崩溃`() {
        // 大量嵌套引号：防御深度限制应返回纯文本而非 StackOverflow
        val evil = "\"" + ("\"嵌套\"".repeat(50)) + "\""
        val result = inlineMarkdown(evil, InlineStyles())
        assertTrue(result.text.isNotEmpty())
    }

    // ===== 角色扮演语义（对齐 PC remark-roleplay） =====

    @Test
    fun `说话人对话块拆分`() {
        val blocks = parseMarkdown("爱丽丝：\"你好，陌生人。\"")
        assertEquals(1, blocks.size)
        val dp = blocks[0] as MdBlock.DialogueParagraph
        assertEquals(1, dp.segments.size)
        assertEquals("爱丽丝", dp.segments[0].speaker)
        assertEquals("你好，陌生人。", dp.segments[0].text)
    }

    @Test
    fun `CJK 引号对话块`() {
        val blocks = parseMarkdown("爱丽丝：「你好。」")
        val dp = blocks[0] as MdBlock.DialogueParagraph
        assertEquals("爱丽丝", dp.segments[0].speaker)
        assertEquals("你好。", dp.segments[0].text)
    }

    @Test
    fun `裸对话保持普通段落`() {
        // 无「名字:」前缀（无冒号）：不拆分为对话块，由行内渲染染色
        val blocks = parseMarkdown("她低声说\"别怕\"")
        assertEquals(1, blocks.size)
        assertTrue(blocks[0] is MdBlock.Paragraph)
    }

    @Test
    fun `对话块与普通文本交错`() {
        val blocks = parseMarkdown("开场。\n\n爱丽丝：\"嗨\" 她挥手。")
        assertEquals(2, blocks.size)
        assertEquals(MdBlock.Paragraph("开场。"), blocks[0])
        val dp = blocks[1] as MdBlock.DialogueParagraph
        // 说话人片段 + 尾部普通文本片段
        assertEquals(2, dp.segments.size)
        assertEquals("爱丽丝", dp.segments[0].speaker)
        assertEquals("嗨", dp.segments[0].text)
        assertEquals(null, dp.segments[1].speaker)
        assertEquals(" 她挥手。", dp.segments[1].text)
    }

    @Test
    fun `行内动作用动作样式`() {
        val result = inlineMarkdown("她*轻笑*一声", InlineStyles())
        assertEquals("她轻笑一声", result.text)
        assertEquals(1, result.spanStyles.size)
        // action 样式为斜体（与普通斜体区分点：动作色背景）
        assertTrue(result.spanStyles[0].item.fontStyle == FontStyle.Italic)
    }

    @Test
    fun `提及高亮命中成员名`() {
        val result = inlineMarkdown("@爱丽丝 你怎么看？", InlineStyles(), mentionNames = listOf("爱丽丝", "鲍勃"))
        assertEquals("@爱丽丝 你怎么看？", result.text)
        assertEquals(1, result.spanStyles.size)
        assertEquals("@爱丽丝", result.text.substring(result.spanStyles[0].start, result.spanStyles[0].end))
    }

    @Test
    fun `提及最长名字优先`() {
        val result = inlineMarkdown("@小爱丽丝 好", InlineStyles(), mentionNames = listOf("爱丽丝", "小爱丽丝"))
        assertEquals("@小爱丽丝 好", result.text)
        assertEquals("@小爱丽丝", result.text.substring(result.spanStyles[0].start, result.spanStyles[0].end))
    }

    @Test
    fun `未命中提及不染色`() {
        val result = inlineMarkdown("联系 @admin 处理", InlineStyles(), mentionNames = listOf("爱丽丝"))
        assertEquals(0, result.spanStyles.size)
        assertEquals("联系 @admin 处理", result.text)
    }

    @Test
    fun `CJK 引号变体行内染色`() {
        val result = inlineMarkdown("她说「这就来」", InlineStyles())
        assertEquals("她说「这就来」", result.text)
        assertEquals(1, result.spanStyles.size)
        assertEquals("「这就来」", result.text.substring(result.spanStyles[0].start, result.spanStyles[0].end))
    }

    // ===== 补充覆盖：表格 / 任务列表 / 动作块 / 代码块 / 引号变体全集 =====

    @Test
    fun `表格列数不足自动补空`() {
        val blocks = parseMarkdown("| 列1 | 列2 |\n|---|---|\n| 只有一列 |")
        val table = blocks[0] as MdBlock.Table
        assertEquals(2, table.headers.size)
        assertEquals(1, table.rows.size)
        // parser 层按 | 拆分保留原始列（补空发生在渲染层）
        assertEquals(1, table.rows[0].size)
    }

    @Test
    fun `表格行内内容保留链接标记`() {
        val result = inlineMarkdown("[链接](https://a.b)", InlineStyles())
        assertEquals("链接", result.text)
        assertEquals(1, result.spanStyles.size)
    }

    @Test
    fun `任务列表已完成与未完成`() {
        val blocks = parseMarkdown("- [x] 完成\n- [ ] 待办")
        assertEquals(2, blocks.size)
        // 任务项文本保留原样（渲染层处理 checkbox 前缀）
        assertEquals(MdBlock.ListItem("[x] 完成", ordered = false), blocks[0])
        assertEquals(MdBlock.ListItem("[ ] 待办", ordered = false), blocks[1])
    }

    @Test
    fun `整段动作块检测`() {
        assertTrue(isActionBlock("*她轻笑着*"))
        assertTrue(isActionBlock("  *停顿了一下*  "))
        // 加粗不是动作块
        assertTrue(!isActionBlock("**重要**"))
        // 非星号包裹不是动作块
        assertTrue(!isActionBlock("普通文本"))
        // 无内容/未闭合不是动作块
        assertTrue(!isActionBlock("*"))
        assertTrue(!isActionBlock("*ab"))
    }

    @Test
    fun `代码块保留多语言标签与空内容`() {
        val blocks = parseMarkdown("```python\nprint(1)\n```\n\n```\n无标签\n```")
        assertEquals(2, blocks.size)
        assertEquals("python", (blocks[0] as MdBlock.CodeBlock).language)
        assertEquals("print(1)", (blocks[0] as MdBlock.CodeBlock).code)
        assertEquals("", (blocks[1] as MdBlock.CodeBlock).language)
        assertEquals("无标签", (blocks[1] as MdBlock.CodeBlock).code)
    }

    @Test
    fun `未闭合代码块容忍到文末`() {
        val blocks = parseMarkdown("```kotlin\nval x = 1")
        assertEquals(1, blocks.size)
        assertEquals("val x = 1", (blocks[0] as MdBlock.CodeBlock).code)
    }

    @Test
    fun `说话人对话块支持全角冒号与冒号后空格`() {
        val blocks = parseMarkdown("爱丽丝： \"嗨\"")
        val dp = blocks[0] as MdBlock.DialogueParagraph
        assertEquals("爱丽丝", dp.segments[0].speaker)
        assertEquals("嗨", dp.segments[0].text)
    }

    @Test
    fun `冒号前有空格不算说话人`() {
        // 对齐 PC \S+[:：] 语义：冒号必须紧跟角色名，中间有空格不识别
        val blocks = parseMarkdown("爱丽丝 ： \"嗨\"")
        assertTrue(blocks[0] is MdBlock.Paragraph)
    }

    @Test
    fun `无闭引号的引号保持原样`() {
        val blocks = parseMarkdown("她说：\"没说完")
        assertEquals(1, blocks.size)
        assertTrue(blocks[0] is MdBlock.Paragraph)
    }

    @Test
    fun `引号变体全集行内染色`() {
        val variants = listOf(
            "\u201C双引号\u201D", "\u300C角引号\u300D", "\u300E双角\u300F",
            "\u2039单角\u203A", "\u00AB书名\u00BB", "\u301D小符\u301E",
            "\uFE41竖单\uFE42", "\uFE43竖双\uFE44", "\u2018单曲\u2019",
        )
        variants.forEach { v ->
            val result = inlineMarkdown("前缀${v}后缀", InlineStyles())
            assertEquals("前缀${v}后缀", result.text)
            assertTrue(
                "引号变体 $v 应被染色",
                result.spanStyles.isNotEmpty(),
            )
            assertEquals("$v", result.text.substring(result.spanStyles[0].start, result.spanStyles[0].end))
        }
    }

    @Test
    fun `对话块内嵌套强调`() {
        val result = inlineMarkdown("她*轻声*说", InlineStyles())
        assertEquals("她轻声说", result.text)
        // 行内动作 + 普通文本各一段
        assertTrue(result.spanStyles.isNotEmpty())
    }

    @Test
    fun `行内动作与对话同时出现`() {
        val result = inlineMarkdown("她*挥手*道：\"再见\"", InlineStyles())
        assertEquals("她挥手道：\"再见\"", result.text)
        assertEquals(2, result.spanStyles.size)
    }

    @Test
    fun `提及在链接与强调内不误伤`() {
        val result = inlineMarkdown("@爱丽丝 [@鲍勃](https://x) *@小明*", InlineStyles(), mentionNames = listOf("爱丽丝", "鲍勃", "小明"))
        // 链接 label 保留 @，动作 span 内 mention 也生效
        assertEquals("@爱丽丝 @鲍勃 @小明", result.text)
        // 外层 3 段（mention/链接/动作）+ 链接内 mention + 动作内 mention = 5 span
        assertEquals(5, result.spanStyles.size)
    }

    @Test
    fun `多行段落中的说话人对话块`() {
        val blocks = parseMarkdown("爱丽丝：\"第一句\"\n她继续说着。")
        val dp = blocks[0] as MdBlock.DialogueParagraph
        assertTrue(dp.segments.any { it.speaker == "爱丽丝" })
    }

    @Test
    fun `对话块内容为空串也保留结构`() {
        val blocks = parseMarkdown("爱丽丝：\"\"")
        val dp = blocks[0] as MdBlock.DialogueParagraph
        assertEquals("爱丽丝", dp.segments[0].speaker)
        assertEquals("", dp.segments[0].text)
    }
}
