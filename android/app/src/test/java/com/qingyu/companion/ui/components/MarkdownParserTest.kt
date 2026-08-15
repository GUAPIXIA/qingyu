package com.qingyu.companion.ui.components

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
}
