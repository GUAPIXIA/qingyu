package com.qingyu.companion.ui.components

import android.graphics.Typeface
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.UnderlineSpan
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.core.text.HtmlCompat
import coil.compose.AsyncImage
import com.qingyu.companion.data.LocalAppContainer

/**
 * HTML 内容渲染（对齐 PC 端 react-markdown + rehype-raw）。
 * 角色卡首条消息等可能为 HTML 格式（<div>/<img>/<h1>/<a>…），
 * MVP 用 HtmlCompat 解析保留常见文本样式，<img> 图片经 Coil 加载。
 */

/** HTML 标签检测（命中任一标签即按 HTML 渲染） */
private val HTML_TAG_REGEX = Regex(
    """<(div|img|h[1-6]|p|br|span|table|tr|td|th|a|b|i|u|s|hr|font|center|ul|ol|li|blockquote|code|pre)\b""",
    RegexOption.IGNORE_CASE,
)

fun containsHtml(text: String): Boolean = HTML_TAG_REGEX.containsMatchIn(text)

/** 提取 HTML 中的 <img src=...> 图片 URL（外部 URL 或相对路径） */
private val IMG_SRC_REGEX = Regex(
    """<img[^>]+src\s*=\s*['"]?([^'">\s]+)""",
    RegexOption.IGNORE_CASE,
)

fun extractHtmlImages(text: String): List<String> =
    IMG_SRC_REGEX.findAll(text).map { it.groupValues[1] }.toList()

/**
 * HtmlCompat -> AnnotatedString：保留粗体/斜体/下划线/删除线/前景色等常见样式。
 * 链接（URLSpan）MVP 阶段降级为普通文本（保持可读），点击能力后续增强。
 */
fun htmlToAnnotatedString(html: String): AnnotatedString {
    val spanned: Spanned = HtmlCompat.fromHtml(html, HtmlCompat.FROM_HTML_MODE_LEGACY)
    return buildAnnotatedString {
        append(spanned.toString())
        spanned.getSpans(0, spanned.length, Any::class.java).forEach { span ->
            val start = spanned.getSpanStart(span)
            val end = spanned.getSpanEnd(span)
            if (start < 0 || end <= start || end > spanned.length) return@forEach
            when (span) {
                is StyleSpan -> when (span.style) {
                    Typeface.BOLD -> addStyle(SpanStyle(fontWeight = FontWeight.Bold), start, end)
                    Typeface.ITALIC -> addStyle(SpanStyle(fontStyle = FontStyle.Italic), start, end)
                    Typeface.BOLD_ITALIC -> addStyle(
                        SpanStyle(fontWeight = FontWeight.Bold, fontStyle = FontStyle.Italic),
                        start,
                        end,
                    )
                }

                is UnderlineSpan ->
                    addStyle(SpanStyle(textDecoration = TextDecoration.Underline), start, end)

                is StrikethroughSpan ->
                    addStyle(SpanStyle(textDecoration = TextDecoration.LineThrough), start, end)

                is ForegroundColorSpan ->
                    addStyle(SpanStyle(color = Color(span.foregroundColor)), start, end)
            }
        }
    }
}

/**
 * HTML 富文本组件：文本经 HtmlCompat 解析保留格式，<img> 图片用 Coil 加载。
 * 图片 URL 支持外部地址与桥接层相对路径（经 resolveImageUrl 拼接 baseUrl）。
 */
@Composable
fun HtmlText(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
) {
    val annotated = remember(text) { htmlToAnnotatedString(text) }
    val connection = LocalAppContainer.current.connectionManager.activeConnection
    val imageUrls = remember(text, connection) {
        extractHtmlImages(text).map { resolveImageUrl(it, connection) ?: it }
    }
    // 消息内嵌 <audio src=...>（角色首条消息等场景）：提取 URL 渲染播放器
    val audioUrls = remember(text) { extractHtmlAudios(text) }

    Column(modifier = modifier.fillMaxWidth()) {
        if (annotated.isNotEmpty()) {
            Text(text = annotated, style = style)
        }
        if (imageUrls.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            imageUrls.forEach { url ->
                AsyncImage(
                    model = url,
                    contentDescription = "图片",
                    contentScale = ContentScale.FillWidth,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 2.dp)
                        .clip(RoundedCornerShape(8.dp)),
                )
            }
        }
        if (audioUrls.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            audioUrls.forEach { url ->
                AudioPlayerItem(url = url, modifier = Modifier.padding(vertical = 2.dp))
            }
        }
    }
}
