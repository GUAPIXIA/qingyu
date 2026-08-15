package com.qingyu.companion.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * extractThought 单测：对齐 PC 端 src/utils/__tests__/messagePostProcess.test.ts 的
 * extractThought 用例，保证两端渲染行为一致（方案 §3.3「两端对照同一规范」）。
 */
class ThoughtExtractionTest {

    @Test
    fun `thinking 标签归一化提取`() {
        val r = extractThought("<thinking>about it</thinking>The answer is 42")
        assertEquals("about it", r.thought)
        assertEquals("The answer is 42", r.content)
        assertFalse(r.isFallback)
    }

    @Test
    fun `thought 原生标签提取`() {
        val r = extractThought("<thought>my thought</thought>The answer is 42")
        assertEquals("my thought", r.thought)
        assertEquals("The answer is 42", r.content)
        assertFalse(r.isFallback)
    }

    @Test
    fun `无标签返回 null thought`() {
        val r = extractThought("Just regular content with no tags")
        assertNull(r.thought)
        assertEquals("Just regular content with no tags", r.content)
        assertFalse(r.isFallback)
    }

    @Test
    fun `多 thought 块拼接并以空行分隔`() {
        val r = extractThought("<thought>part1</thought>middle<thought>part2</thought>end")
        assertEquals("part1\n\npart2", r.thought)
        assertEquals("middleend", r.content)
        assertFalse(r.isFallback)
    }

    @Test
    fun `多 thinking 块`() {
        val r = extractThought("<thinking>step1</thinking>text<thinking>step2</thinking>more")
        assertEquals("step1\n\nstep2", r.thought)
        assertFalse(r.isFallback)
    }

    @Test
    fun `thought 内容首尾空白被裁剪`() {
        val r = extractThought("<thought>  spaced thought  </thought>content")
        assertEquals("spaced thought", r.thought)
    }

    @Test
    fun `标签大小写不敏感`() {
        val r = extractThought("<THOUGHT>upper case</THOUGHT>content")
        assertEquals("upper case", r.thought)
    }

    @Test
    fun `正文为空时回退到思考内容`() {
        val r = extractThought("<thought>only thinking here</thought>")
        assertEquals("only thinking here", r.thought)
        assertTrue(r.isFallback)
        assertEquals("only thinking here", r.content)
    }

    @Test
    fun `空字符串`() {
        val r = extractThought("")
        assertNull(r.thought)
        assertEquals("", r.content)
        assertFalse(r.isFallback)
    }

    @Test
    fun `stripThought 剥离块且不做空回退`() {
        assertEquals("The answer is 42", stripThought("<thought>hidden</thought>The answer is 42"))
        assertEquals("", stripThought("<thinking>only</thinking>"))
    }

    @Test
    fun `stripThoughtTags 去标签留内容`() {
        assertEquals("keep me", stripThoughtTags("<thought>keep me</thought>"))
    }
}
