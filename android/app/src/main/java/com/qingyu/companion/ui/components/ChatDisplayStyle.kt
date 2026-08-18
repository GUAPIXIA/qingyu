package com.qingyu.companion.ui.components

import androidx.compose.ui.text.TextStyle

/** 对话页统一缩放字号、行高和字距，避免只放大字号导致文字拥挤或裁切。 */
internal fun TextStyle.scaledForChat(scale: Float): TextStyle {
    val factor = scale.coerceIn(0.75f, 1.5f)
    return copy(
        fontSize = fontSize * factor,
        lineHeight = lineHeight * factor,
        letterSpacing = letterSpacing * factor,
    )
}
