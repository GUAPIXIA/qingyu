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


/**
 * 可点击文本：处理链接区间（链接点击打开浏览器，仅 http/https 已在收集时过滤）。
 */
@Composable
private fun MdText(
    annotated: AnnotatedString,
    style: TextStyle,
    modifier: Modifier = Modifier,
    links: List<Pair<IntRange, String>>? = null,
) {
    val context = LocalContext.current
    if (links.isNullOrEmpty()) {
        Text(text = annotated, style = style, modifier = modifier)
    } else {
        ClickableText(
            text = annotated,
            style = style,
            modifier = modifier,
            onClick = { offset ->
                links.firstOrNull { offset in it.first }?.let { (_, url) ->
                    runCatching {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    }
                }
            },
        )
    }
}

@Composable
fun MarkdownText(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
    /** 对话页本地字号缩放；标题、代码和 Markdown 子块统一跟随。 */
    fontScale: Float = 1f,
    /** 对话页本地间距缩放；控制段落及 Markdown 块之间的留白。 */
    spacingMultiplier: Float = 1f,
    /** 用户气泡内渲染（对话/动作样式切换为气泡对比色变体，对齐 PC .bubble-user） */
    onUserBubble: Boolean = false,
    /** @提及高亮名单（群聊传成员名列表，单聊留空） */
    mentionNames: List<String> = emptyList(),
) {
    val scaledStyle = style.scaledForChat(fontScale)
    val spacing = spacingMultiplier.coerceIn(0.6f, 1.6f)
    // HTML 内容（角色卡首条消息等）走 HtmlCompat 渲染，避免显示为纯文本标签
    if (containsHtml(text)) {
        HtmlText(text = text, modifier = modifier, style = scaledStyle)
        return
    }
    val blocks = remember(text) { parseMarkdown(text) }
    val codeBackground = MaterialTheme.colorScheme.surfaceVariant
    val qy = qyColors()
    // 样式按气泡语境派生：普通气泡用主题色；用户气泡用气泡对比色淡化背景（PC .bubble-user 适配）
    val styles = remember(text, onUserBubble) {
        val codeStyle = SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground)
        if (onUserBubble) {
            val contrast = if (qy.isDark) Color.White else Color(0xFF2A2620)
            InlineStyles(
                code = codeStyle,
                action = SpanStyle(
                    fontStyle = FontStyle.Italic,
                    color = contrast.copy(alpha = 0.8f),
                    background = contrast.copy(alpha = 0.08f),
                ),
                dialogue = SpanStyle(
                    color = qy.warn,
                    background = contrast.copy(alpha = 0.10f),
                ),
                mention = SpanStyle(
                    color = qy.accent,
                    background = qy.accent.copy(alpha = 0.10f),
                    fontWeight = FontWeight.Medium,
                ),
            )
        } else {
            val actionColor = if (qy.isDark) Color(0xFFB9A4E8) else Color(0xFF7A5FA8)
            InlineStyles(
                code = codeStyle,
                action = SpanStyle(
                    fontStyle = FontStyle.Italic,
                    color = actionColor,
                    background = actionColor.copy(alpha = 0.10f),
                ),
                dialogue = SpanStyle(
                    color = qy.warn,
                    background = qy.warn.copy(alpha = 0.10f),
                ),
                mention = SpanStyle(
                    color = qy.accent,
                    background = qy.accentSoft,
                    fontWeight = FontWeight.Medium,
                ),
            )
        }
    }

    Column(modifier = modifier.fillMaxWidth()) {
        // 有序列表序号计数器（连续有序项递增；遇非列表项/无序项重置）
        var orderedCounter = 0
        blocks.forEach { block ->
            if (block !is MdBlock.ListItem) orderedCounter = 0
            when (block) {
                is MdBlock.Paragraph -> {
                    val t = block.text.trim()
                    if (isActionBlock(t)) {
                        // 整段动作 *动作*：渐变背景 + 渐变色条 + 斜体 + 字号微缩（对齐 PC action-block）
                        val actionColor = if (qy.isDark) Color(0xFFB9A4E8) else Color(0xFF7A5FA8)
                        val inner = t.removePrefix("*").removeSuffix("*")
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .padding(vertical = 2.dp)
                                .clip(RoundedCornerShape(6.dp))
                                .background(
                                    Brush.horizontalGradient(
                                        listOf(actionColor.copy(alpha = 0.08f), Color.Transparent)
                                    )
                                )
                                .padding(horizontal = 8.dp, vertical = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(
                                Modifier
                                    .width(3.dp)
                                    .height(18.dp)
                                    .clip(RoundedCornerShape(2.dp))
                                    .background(
                                        Brush.verticalGradient(
                                            listOf(actionColor, qy.accent)
                                        )
                                    ),
                            )
                            Spacer(Modifier.width(6.dp))
                            val links = remember(inner) { mutableListOf<Pair<IntRange, String>>() }
                            MdText(
                                annotated = inlineMarkdown(inner, styles, links = links, mentionNames = mentionNames),
                                style = scaledStyle.copy(
                                    fontStyle = FontStyle.Italic,
                                    fontSize = scaledStyle.fontSize * 0.94f,
                                ),
                                links = links,
                            )
                        }
                    } else {
                        val links = remember(block.text) { mutableListOf<Pair<IntRange, String>>() }
                        MdText(
                            annotated = inlineMarkdown(block.text, styles, links = links, mentionNames = mentionNames),
                            style = scaledStyle,
                            modifier = Modifier.padding(vertical = (2 * spacing).dp),
                            links = links,
                        )
                    }
                }

                is MdBlock.DialogueParagraph -> {
                    // 说话人对话块：渐变背景 + 3dp 左色条 + 说话人标签（色标圆点）+ 对话文本（对齐 PC dialogue-block）
                    block.segments.forEachIndexed { idx, seg ->
                        if (seg.speaker != null) {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    // 连续对话块间距收紧（对齐 PC 相邻 dialogue-block）
                                    .padding(top = if (idx == 0) 3.dp else 1.dp, bottom = 2.dp)
                                    .clip(RoundedCornerShape(8.dp))
                                    .background(
                                        Brush.horizontalGradient(
                                            listOf(qy.warn.copy(alpha = 0.08f), Color.Transparent)
                                        )
                                    )
                                    .padding(horizontal = 10.dp, vertical = 6.dp),
                                verticalAlignment = Alignment.Top,
                            ) {
                                Box(
                                    Modifier
                                        .width(3.dp)
                                        .height(IntrinsicSize.Max)
                                        .clip(RoundedCornerShape(2.dp))
                                        .background(qy.accent.copy(alpha = 0.6f)),
                                )
                                Spacer(Modifier.width(8.dp))
                                Column {
                                    // 说话人标签：accent 色标圆点 + 600 字重小字
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Box(
                                            Modifier
                                                .size(6.dp)
                                                .clip(CircleShape)
                                                .background(qy.accent)
                                        )
                                        Spacer(Modifier.width(6.dp))
                                        Text(
                                            seg.speaker,
                                            style = MaterialTheme.typography.labelSmall.scaledForChat(fontScale).copy(
                                                color = qy.accent,
                                                fontWeight = FontWeight.SemiBold,
                                            ),
                                        )
                                    }
                                    Spacer(Modifier.height(3.dp))
                                    val links = remember(seg.text) { mutableListOf<Pair<IntRange, String>>() }
                                    MdText(
                                        annotated = inlineMarkdown(seg.text, styles, links = links, mentionNames = mentionNames),
                                        style = scaledStyle.copy(fontWeight = FontWeight.Medium),
                                        links = links,
                                    )
                                }
                            }
                        } else {
                            val links = remember(seg.text) { mutableListOf<Pair<IntRange, String>>() }
                            MdText(
                                annotated = inlineMarkdown(seg.text, styles, links = links, mentionNames = mentionNames),
                                style = scaledStyle,
                                modifier = Modifier.padding(vertical = (2 * spacing).dp),
                                links = links,
                            )
                        }
                    }
                }

                is MdBlock.Heading -> {
                    val size = when (block.level) {
                        1 -> 22.sp
                        2 -> 20.sp
                        3 -> 18.sp
                        else -> 16.sp
                    }
                    val links = remember(block.text) { mutableListOf<Pair<IntRange, String>>() }
                    MdText(
                        annotated = inlineMarkdown(block.text, styles, links = links, mentionNames = mentionNames),
                        style = scaledStyle.copy(
                            fontSize = (size.value * fontScale).sp,
                            lineHeight = scaledStyle.lineHeight,
                            fontWeight = FontWeight.Bold,
                        ),
                        modifier = Modifier.padding(vertical = (4 * spacing).dp),
                        links = links,
                    )
                }

                is MdBlock.CodeBlock -> CodeBlockCard(block, scaledStyle, codeBackground, spacing)

                is MdBlock.Image -> ImageBlock(block.url)

                is MdBlock.Quote -> {
                    val links = remember(block.text) { mutableListOf<Pair<IntRange, String>>() }
                    MdText(
                        annotated = inlineMarkdown(block.text, styles, links = links, mentionNames = mentionNames),
                        style = scaledStyle.copy(
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            fontStyle = FontStyle.Italic,
                        ),
                        modifier = Modifier
                            .fillMaxWidth()
                            .border(
                                BorderStroke(3.dp, MaterialTheme.colorScheme.primary),
                                shape = MaterialTheme.shapes.extraSmall,
                            )
                            .padding(start = 8.dp, top = (2 * spacing).dp, bottom = (2 * spacing).dp),
                        links = links,
                    )
                }

                is MdBlock.HorizontalRule -> HorizontalDivider(spacing)

                is MdBlock.Table -> TableBlock(block, scaledStyle, spacing)

                is MdBlock.ListItem -> {
                    // GFM 任务列表：- [ ] / - [x]（对齐 PC 端 remark-gfm checkbox）
                    val taskMatch = TASK_ITEM.matchEntire(block.text)
                    val taskChecked = taskMatch?.groupValues?.get(1)?.lowercase() == "x"
                    val taskText = taskMatch?.groupValues?.get(2) ?: block.text
                    val taskBox = if (taskMatch != null) {
                        if (taskChecked) "☑ " else "☐ "
                    } else {
                        ""
                    }
                    val prefix = if (taskMatch != null) {
                        taskBox
                    } else if (block.ordered) {
                        orderedCounter += 1
                        "$orderedCounter. "
                    } else {
                        orderedCounter = 0
                        "• "
                    }
                    Row(
                        modifier = Modifier.padding(vertical = spacing.dp),
                    ) {
                        Text(
                            text = prefix,
                            style = if (taskMatch != null && taskChecked) {
                                scaledStyle.copy(
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    textDecoration = TextDecoration.LineThrough,
                                )
                            } else {
                                scaledStyle
                            },
                        )
                        val links = remember(taskText) { mutableListOf<Pair<IntRange, String>>() }
                        MdText(
                            annotated = inlineMarkdown(taskText, styles, links = links, mentionNames = mentionNames),
                            style = scaledStyle,
                            links = links,
                        )
                    }
                }
            }
        }
    }
}

/** 水平分隔线（--- / *** / ___） */

/** 水平分隔线（--- / *** / ___） */
@Composable
private fun HorizontalDivider(spacing: Float) {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(vertical = (8 * spacing).dp)
            .height(1.dp)
            .background(MaterialTheme.colorScheme.outline.copy(alpha = 0.3f)),
    )
}

/** GFM 表格：表头加粗 + 隔行底色 */

/** GFM 表格：表头加粗 + 隔行底色 */
@Composable
private fun TableBlock(block: MdBlock.Table, style: TextStyle, spacing: Float) {
    val borderColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = (4 * spacing).dp)
            .clip(RoundedCornerShape(8.dp))
            .border(1.dp, borderColor),
    ) {
        // 表头
        Row(
            Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)),
        ) {
            block.headers.forEach { h ->
                Text(
                    inlineMarkdown(h, InlineStyles()),
                    style = style.copy(fontWeight = FontWeight.Bold),
                    modifier = Modifier
                        .weight(1f)
                        .padding(horizontal = 8.dp, vertical = (6 * spacing).dp),
                )
            }
        }
        // 数据行（单元格不足时补空）
        block.rows.forEachIndexed { idx, row ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(
                        if (idx % 2 == 1) MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.25f)
                        else Color.Transparent
                    ),
            ) {
                for (c in 0 until maxOf(block.headers.size, row.size)) {
                    val cell = row.getOrNull(c) ?: ""
                    Text(
                        cell,
                        style = style,
                        modifier = Modifier
                            .weight(1f)
                            .padding(horizontal = 8.dp, vertical = (4 * spacing).dp),
                    )
                }
            }
        }
    }
}

/** 代码块：语言标签 + 复制按钮 + 等宽内容 */

/** 代码块：语言标签 + 复制按钮 + 等宽内容 */
@Composable
private fun CodeBlockCard(
    block: MdBlock.CodeBlock,
    style: TextStyle,
    background: Color,
    spacing: Float,
) {
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    Surface(
        color = background,
        shape = MaterialTheme.shapes.small,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = (4 * spacing).dp),
    ) {
        Column {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(start = 12.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    block.language.ifBlank { "code" },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.weight(1f))
                TextButton(
                    onClick = {
                        clipboard.setText(AnnotatedString(block.code))
                        copied = true
                        scope.launch {
                            delay(1500)
                            copied = false
                        }
                    },
                ) {
                    Text(
                        if (copied) "已复制 ✓" else "复制",
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
            Text(
                text = block.code,
                style = style.copy(
                    fontFamily = FontFamily.Monospace,
                    fontSize = style.fontSize * (13f / 14.5f),
                ),
                modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = (12 * spacing).dp),
            )
        }
    }
}

/** 独立行 Markdown 图片：相对路径拼 baseUrl，Coil 加载 */

/** 独立行 Markdown 图片：相对路径拼 baseUrl，Coil 加载 */
@Composable
private fun ImageBlock(rawUrl: String) {
    val connection = LocalAppContainer.current.connectionManager.activeConnection
    val url = resolveImageUrl(rawUrl, connection) ?: rawUrl
    AsyncImage(
        model = url,
        contentDescription = "图片",
        contentScale = ContentScale.FillWidth,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .clip(RoundedCornerShape(8.dp)),
    )
}
