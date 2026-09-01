package com.qingyu.companion.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

class TranslationDisplayTest {
    @Test
    fun translationReplacesOriginalText() {
        assertEquals("你好世界", translatedMessageContent("hello world", "你好世界"))
    }

    @Test
    fun blankTranslationKeepsOriginalText() {
        assertEquals("hello world", translatedMessageContent("hello world", "  "))
    }
}
