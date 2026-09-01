package com.qingyu.companion.ui.components

internal fun translatedMessageContent(original: String, translation: String?): String =
    translation?.takeIf { it.isNotBlank() } ?: original
