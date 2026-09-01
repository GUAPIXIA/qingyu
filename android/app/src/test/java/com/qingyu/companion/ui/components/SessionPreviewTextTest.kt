package com.qingyu.companion.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

class SessionPreviewTextTest {
    @Test
    fun `global session title includes character and conversation names`() {
        assertEquals("花藕子-新对话 2", sessionDisplayTitle("新对话 2", "花藕子", true))
        assertEquals("新对话 2", sessionDisplayTitle("新对话 2", "花藕子", false))
    }

    @Test
    fun `session title handles missing character without stray separator`() {
        assertEquals("默认对话", sessionDisplayTitle("默认对话", "", true))
        assertEquals("未命名会话", sessionDisplayTitle("", "花藕子", false))
    }

    @Test
    fun `preview shows final visible content without thought blocks`() {
        assertEquals(
            "最后一句正文",
            sessionPreviewText("<thought>这段不能显示</thought>最后一句正文"),
        )
    }

    @Test
    fun `thought-only message does not leak psychological text`() {
        assertEquals("（无可见正文）", sessionPreviewText("<thinking>秘密想法</thinking>"))
    }

    @Test
    fun `truncated unclosed thought from server preview is removed`() {
        assertEquals("（无可见正文）", sessionPreviewText("<thought>（我正在思考但服务端截断了…"))
        assertEquals("可见开头", sessionPreviewText("可见开头<thinking>未闭合心理描写…"))
    }
}
