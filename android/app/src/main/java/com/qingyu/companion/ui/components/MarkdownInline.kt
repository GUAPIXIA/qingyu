package com.qingyu.companion.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.text.ClickableText
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import android.content.Intent
import android.net.Uri
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.ui.theme.qyColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch


data class InlineStyles(
    val bold: SpanStyle = SpanStyle(fontWeight = FontWeight.Bold),
    val italic: SpanStyle = SpanStyle(fontStyle = FontStyle.Italic),
    val strike: SpanStyle = SpanStyle(textDecoration = TextDecoration.LineThrough),
    val code: SpanStyle = SpanStyle(fontFamily = FontFamily.Monospace),
    val link: SpanStyle = SpanStyle(color = androidx.compose.ui.graphics.Color(0xFF4A90D9), textDecoration = TextDecoration.Underline),
    /** 行内对话（"…" / 「…」）：对话色文字 + 淡背景 */
    val dialogue: SpanStyle = SpanStyle(
        color = androidx.compose.ui.graphics.Color(0xFFB0804E),
        background = androidx.compose.ui.graphics.Color(0xFFB0804E).copy(alpha = 0.14f),
    ),
    /** 行内动作（*动作*）：斜体 + 动作色 + 动作背景（对齐 PC action-em） */
    val action: SpanStyle = SpanStyle(
        fontStyle = FontStyle.Italic,
        color = androidx.compose.ui.graphics.Color(0xFF9B7EDE),
        background = androidx.compose.ui.graphics.Color(0xFF9B7EDE).copy(alpha = 0.10f),
    ),
    /** @提及高亮（群聊，对齐 PC mention-highlight） */
    val mention: SpanStyle = SpanStyle(
        color = androidx.compose.ui.graphics.Color(0xFFA88360),
        background = androidx.compose.ui.graphics.Color(0x1AA88360),
        fontWeight = FontWeight.Medium,
    ),
)

/** 引号对（对齐 PC remark-roleplay 归一化表：CJK 引号变体统一匹配） */

/** 引号对（对齐 PC remark-roleplay 归一化表：CJK 引号变体统一匹配） */
private val QUOTE_PAIRS = mapOf(
    '"' to '"',
    '\u201C' to '\u201D', // “ ”
    '\u201D' to '\u201D', // ” 也可作开引号（PC 归一化同款）
    '\u201E' to '\u201D', // „ ”
    '\u201F' to '\u201D', // ‟ ”
    '\uFF02' to '\uFF02', // ＂
    '\u2018' to '\u2019', // ‘ ’
    '\u300C' to '\u300D', // 「 」
    '\u300E' to '\u300F', // 『 』
    '\u2039' to '\u203A', // ‹ ›
    '\u00AB' to '\u00BB', // « »
    '\u301D' to '\u301E', // 〝 〞
    '\uFE41' to '\uFE42', // ﹁ ﹂
    '\uFE43' to '\uFE44', // ﹃ ﹄
)

/**
 * 行内 Markdown -> AnnotatedString。支持 `code`、~~删除线~~、**加粗**、*斜体*、链接、可嵌套。
 * @param links 可选：收集可点击链接区间（annotated 内字符区间 -> URL），供 ClickableText 使用。
 */
fun inlineMarkdown(
    text: String,
    styles: InlineStyles,
    depth: Int = 0,
    links: MutableList<Pair<IntRange, String>>? = null,
    /** @提及高亮名单（群聊成员名，命中 @名字 加高亮） */
    mentionNames: List<String> = emptyList(),
): AnnotatedString {
    val b = AnnotatedString.Builder()
    var i = 0
    // 防御：嵌套过深（异常格式）直接返回纯文本，避免 StackOverflowError
    if (depth > 30) return AnnotatedString(text)
    while (i < text.length) {
        val ch = text[i]
        when {
            ch == '`' -> {
                val end = text.indexOf('`', i + 1)
                if (end == -1) {
                    b.append(ch); i++
                } else {
                    b.withStyle(styles.code) { b.append(text.substring(i + 1, end)) }
                    i = end + 1
                }
            }

            // 行内图片 ![alt](url)：降级为「🔗 图片」链接样式（可点击打开）
            ch == '!' && text.getOrNull(i + 1) == '[' -> {
                val close = text.indexOf(']', i + 2)
                val urlEnd = if (close > i + 2) text.indexOf(')', close + 2) else -1
                if (close != -1 && urlEnd != -1) {
                    val url = text.substring(close + 2, urlEnd).trim()
                    val label = text.substring(i + 2, close).ifBlank { "图片" }
                    val start = b.length
                    b.withStyle(styles.link) {
                        b.append("🔗 $label")
                    }
                    if (url.startsWith("http://") || url.startsWith("https://")) {
                        links?.add(Pair(IntRange(start, b.length), url))
                    }
                    i = urlEnd + 1
                } else {
                    b.append(ch); i++
                }
            }

            // 链接 [label](url)：渲染为链接样式 + 可点击（仅 http/https，危险协议降级为纯文本）
            ch == '[' -> {
                val close = text.indexOf(']', i + 1)
                if (close > i + 1 && text.getOrNull(close + 1) == '(') {
                    val urlEnd = text.indexOf(')', close + 2)
                    if (urlEnd != -1) {
                        val label = text.substring(i + 1, close)
                        val url = text.substring(close + 2, urlEnd).trim()
                        val start = b.length
                        b.withStyle(styles.link) {
                            b.append(inlineMarkdown(label, styles, depth + 1, links, mentionNames))
                        }
                        // 链接可点击：仅 http/https（危险协议如 javascript:/data: 降级为纯文本）
                        if (url.startsWith("http://") || url.startsWith("https://")) {
                            links?.add(Pair(IntRange(start, b.length), url))
                        }
                        i = urlEnd + 1
                    } else {
                        b.append(ch); i++
                    }
                } else {
                    b.append(ch); i++
                }
            }

            // 行内对话：任意引号变体（对齐 PC remark-roleplay 归一化：CJK 引号统一匹配）
            QUOTE_PAIRS[ch] != null -> {
                val closeQuote = QUOTE_PAIRS.getValue(ch)
                val end = text.indexOf(closeQuote, i + 1)
                if (end != -1) {
                    b.withStyle(styles.dialogue) {
                        b.append(ch) // 开始引号
                        b.append(inlineMarkdown(text.substring(i + 1, end), styles, depth + 1, links, mentionNames)) // 内容（不含引号，避免递归不收敛）
                        b.append(closeQuote) // 结束引号
                    }
                    i = end + 1
                } else {
                    b.append(ch); i++
                }
            }

            ch == '~' && text.getOrNull(i + 1) == '~' -> {
                val end = text.indexOf("~~", i + 2)
                if (end == -1) {
                    b.append("~~"); i += 2
                } else {
                    b.withStyle(styles.strike) {
                        b.append(inlineMarkdown(text.substring(i + 2, end), styles, depth + 1, links, mentionNames))
                    }
                    i = end + 2
                }
            }

            ch == '*' && text.getOrNull(i + 1) == '*' -> {
                val end = text.indexOf("**", i + 2)
                if (end == -1) {
                    b.append("**"); i += 2
                } else {
                    b.withStyle(styles.bold) {
                        b.append(inlineMarkdown(text.substring(i + 2, end), styles, depth + 1, links, mentionNames))
                    }
                    i = end + 2
                }
            }

            ch == '*' -> {
                val end = text.indexOf('*', i + 1)
                if (end == -1) {
                    b.append('*'); i++
                } else {
                    // 行内动作（对齐 PC action-em：斜体 + 动作色背景）
                    b.withStyle(styles.action) {
                        b.append(inlineMarkdown(text.substring(i + 1, end), styles, depth + 1, links, mentionNames))
                    }
                    i = end + 1
                }
            }

            // @提及高亮（群聊）：匹配 mentionNames 中最长角色名
            ch == '@' && mentionNames.isNotEmpty() -> {
                val name = mentionNames
                    .filter { text.startsWith(it, i + 1) }
                    .maxByOrNull { it.length }
                if (name != null) {
                    b.withStyle(styles.mention) { b.append("@$name") }
                    i += 1 + name.length
                } else {
                    b.append(ch); i++
                }
            }

            else -> {
                b.append(ch); i++
            }
        }
    }
    return b.toAnnotatedString()
}

/**
 * 可点击文本：处理链接区间（链接点击打开浏览器，仅 http/https 已在收集时过滤）。
 */
