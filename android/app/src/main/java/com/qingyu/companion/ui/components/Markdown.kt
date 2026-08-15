package com.qingyu.companion.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
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
import com.qingyu.companion.data.LocalAppContainer
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * 极简本地 Markdown 渲染（方案 §3.3「Markdown 渲染本地实现」）。
 * 覆盖聊天最常见的结构：标题 / 加粗 / 斜体 / 行内代码 / 代码块 / 引用 / 无序列表 / 段落。
 * 高级特性（表格、图片、链接）MVP 阶段按纯文本降级；后续可替换为完整 Markdown 库。
 * 解析函数 [parseMarkdown] 与 [inlineMarkdown] 为纯函数，便于 JVM 单测。
 */

sealed interface MdBlock {
    data class Paragraph(val text: String) : MdBlock
    data class Heading(val level: Int, val text: String) : MdBlock
    data class CodeBlock(val language: String, val code: String) : MdBlock
    data class Quote(val text: String) : MdBlock
    data class ListItem(val text: String, val ordered: Boolean) : MdBlock
    data object HorizontalRule : MdBlock
    data class Table(val headers: List<String>, val rows: List<List<String>>) : MdBlock
    data class Image(val url: String) : MdBlock
}

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
)

private val HEADING = Regex("""^(#{1,6})\s+(.*)$""")
private val LIST_ITEM = Regex("""^\s*([-*+]|\d+\.)\s+(.*)$""")
private val HR = Regex("""^\s*(?:-{3,}|\*{3,}|_{3,})\s*$""")
private val IMAGE_LINE = Regex("""^\s*!\[[^\]]*\]\(([^)\s]+)\)\s*$""")

/** 整段动作块检测：*动作*（排除 **加粗**） */
private fun isActionBlock(text: String): Boolean {
    val t = text.trim()
    return t.length >= 3 && t.startsWith("*") && t.endsWith("*") && !t.startsWith("**")
}
private val TABLE_SEPARATOR = Regex("""^\s*\|?[\s:|-]+\|?\s*$""")

/** 表格行：去头尾竖线后按 | 分列并 trim */
private fun parseTableRow(line: String): List<String> =
    line.trim().trim('|').split("|").map { it.trim() }

/** 判定是否为 GFM 表格分隔行（| --- | --- | 形式） */
private fun isTableSeparator(line: String): Boolean {
    val t = line.trim()
    if (!t.contains("|")) return false
    val cells = t.trim().trim('|').split("|")
    if (cells.isEmpty()) return false
    return cells.all { c ->
        val s = c.trim()
        s.isEmpty() || s.matches(Regex(""":?-{3,}:?"""))
    }
}

fun parseMarkdown(source: String): List<MdBlock> {
    val lines = source.lines()
    val blocks = mutableListOf<MdBlock>()
    val paragraph = StringBuilder()
    var i = 0

    fun flushParagraph() {
        if (paragraph.isNotEmpty()) {
            blocks += MdBlock.Paragraph(paragraph.toString().trim())
            paragraph.clear()
        }
    }

    while (i < lines.size) {
        val line = lines[i]
        val trimmedStart = line.trimStart()

        when {
            // GFM 表格：当前行含 | 且下一行是分隔行
            line.contains("|") && i + 1 < lines.size && isTableSeparator(lines[i + 1]) -> {
                flushParagraph()
                val headers = parseTableRow(line)
                i += 2
                val rows = mutableListOf<List<String>>()
                while (i < lines.size && lines[i].contains("|")) {
                    val row = parseTableRow(lines[i])
                    if (row.isNotEmpty()) rows += row
                    i++
                }
                blocks += MdBlock.Table(headers, rows)
            }

            HR.matches(line) -> {
                flushParagraph()
                blocks += MdBlock.HorizontalRule
                i++
            }

            // 独立行图片 ![alt](url)
            IMAGE_LINE.matches(line) -> {
                flushParagraph()
                val m = IMAGE_LINE.matchEntire(line)!!
                blocks += MdBlock.Image(m.groupValues[1])
                i++
            }

            trimmedStart.startsWith("```") -> {
                flushParagraph()
                val language = trimmedStart.removePrefix("```").trim()
                val code = StringBuilder()
                i++
                while (i < lines.size && !lines[i].trimStart().startsWith("```")) {
                    code.appendLine(lines[i])
                    i++
                }
                blocks += MdBlock.CodeBlock(language, code.toString().trimEnd('\n'))
                i++
            }

            HEADING.matches(line) -> {
                flushParagraph()
                val m = HEADING.matchEntire(line)!!
                blocks += MdBlock.Heading(m.groupValues[1].length, m.groupValues[2].trim())
                i++
            }

            line.startsWith(">") -> {
                flushParagraph()
                blocks += MdBlock.Quote(line.removePrefix(">").trimStart())
                i++
            }

            LIST_ITEM.matches(line) -> {
                flushParagraph()
                val m = LIST_ITEM.matchEntire(line)!!
                blocks += MdBlock.ListItem(m.groupValues[2].trim(), m.groupValues[1].endsWith("."))
                i++
            }

            line.isBlank() -> {
                flushParagraph()
                i++
            }

            else -> {
                paragraph.append(line).append('\n')
                i++
            }
        }
    }
    flushParagraph()
    return blocks
}

/**
 * 行内 Markdown -> AnnotatedString。支持 `code`、~~删除线~~、**加粗**、*斜体*，可嵌套。
 */
fun inlineMarkdown(text: String, styles: InlineStyles, depth: Int = 0): AnnotatedString {
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

            // 链接 [label](url)：渲染为链接样式（点击能力留待后续）
            ch == '[' -> {
                val close = text.indexOf(']', i + 1)
                if (close > i + 1 && text.getOrNull(close + 1) == '(') {
                    val urlEnd = text.indexOf(')', close + 2)
                    if (urlEnd != -1) {
                        val label = text.substring(i + 1, close)
                        b.withStyle(styles.link) {
                            b.append(inlineMarkdown(label, styles, depth + 1))
                        }
                        i = urlEnd + 1
                    } else {
                        b.append(ch); i++
                    }
                } else {
                    b.append(ch); i++
                }
            }

            // 行内对话 "…" / 「…」：对话色文字 + 淡背景（角色扮演语义）
            ch == '"' || ch == '「' -> {
                val closeQuote = if (ch == '「') '」' else '"'
                val end = text.indexOf(closeQuote, i + 1)
                if (end != -1) {
                    b.withStyle(styles.dialogue) {
                        b.append(ch) // 开始引号
                        b.append(inlineMarkdown(text.substring(i + 1, end), styles, depth + 1)) // 内容（不含引号，避免递归不收敛）
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
                        b.append(inlineMarkdown(text.substring(i + 2, end), styles, depth + 1))
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
                        b.append(inlineMarkdown(text.substring(i + 2, end), styles, depth + 1))
                    }
                    i = end + 2
                }
            }

            ch == '*' -> {
                val end = text.indexOf('*', i + 1)
                if (end == -1) {
                    b.append('*'); i++
                } else {
                    b.withStyle(styles.italic) {
                        b.append(inlineMarkdown(text.substring(i + 1, end), styles, depth + 1))
                    }
                    i = end + 1
                }
            }

            else -> {
                b.append(ch); i++
            }
        }
    }
    return b.toAnnotatedString()
}

@Composable
fun MarkdownText(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
) {
    // HTML 内容（角色卡首条消息等）走 HtmlCompat 渲染，避免显示为纯文本标签
    if (containsHtml(text)) {
        HtmlText(text = text, modifier = modifier, style = style)
        return
    }
    val blocks = remember(text) { parseMarkdown(text) }
    val codeBackground = MaterialTheme.colorScheme.surfaceVariant
    val styles = remember {
        InlineStyles(
            code = SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground),
        )
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
                        // 整段动作 *动作*：斜体 + 动作淡背景 + 左侧色条（角色扮演语义）
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .padding(vertical = 2.dp)
                                .clip(RoundedCornerShape(6.dp))
                                .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.06f))
                                .padding(horizontal = 8.dp, vertical = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(
                                Modifier
                                    .width(3.dp)
                                    .height(18.dp)
                                    .clip(RoundedCornerShape(2.dp))
                                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.4f)),
                            )
                            Spacer(Modifier.width(6.dp))
                            Text(
                                text = inlineMarkdown(block.text, styles),
                                style = style.copy(fontStyle = FontStyle.Italic),
                            )
                        }
                    } else {
                        Text(
                            text = inlineMarkdown(block.text, styles),
                            style = style,
                            modifier = Modifier.padding(vertical = 2.dp),
                        )
                    }
                }

                is MdBlock.Heading -> {
                    val size = when (block.level) {
                        1 -> 22.sp
                        2 -> 20.sp
                        3 -> 18.sp
                        else -> 16.sp
                    }
                    Text(
                        text = inlineMarkdown(block.text, styles),
                        style = style.copy(fontSize = size, fontWeight = FontWeight.Bold),
                        modifier = Modifier.padding(vertical = 4.dp),
                    )
                }

                is MdBlock.CodeBlock -> CodeBlockCard(block, style, codeBackground)

                is MdBlock.Image -> ImageBlock(block.url)

                is MdBlock.Quote -> Text(
                    text = inlineMarkdown(block.text, styles),
                    style = style.copy(
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontStyle = FontStyle.Italic,
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
                        .border(
                            BorderStroke(3.dp, MaterialTheme.colorScheme.primary),
                            shape = MaterialTheme.shapes.extraSmall,
                        )
                        .padding(start = 8.dp, top = 2.dp, bottom = 2.dp),
                )

                is MdBlock.HorizontalRule -> HorizontalDivider()

                is MdBlock.Table -> TableBlock(block, style)

                is MdBlock.ListItem -> {
                    val prefix = if (block.ordered) {
                        orderedCounter += 1
                        "$orderedCounter. "
                    } else {
                        orderedCounter = 0
                        "• "
                    }
                    Row(
                        modifier = Modifier.padding(vertical = 1.dp),
                    ) {
                        Text(
                            text = prefix,
                            style = style,
                        )
                        Text(
                            text = inlineMarkdown(block.text, styles),
                            style = style,
                        )
                    }
                }
            }
        }
    }
}

/** 水平分隔线（--- / *** / ___） */
@Composable
private fun HorizontalDivider() {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp)
            .height(1.dp)
            .background(MaterialTheme.colorScheme.outline.copy(alpha = 0.3f)),
    )
}

/** GFM 表格：表头加粗 + 隔行底色 */
@Composable
private fun TableBlock(block: MdBlock.Table, style: TextStyle) {
    val borderColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
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
                        .padding(horizontal = 8.dp, vertical = 6.dp),
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
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                    )
                }
            }
        }
    }
}

/** 代码块：语言标签 + 复制按钮 + 等宽内容 */
@Composable
private fun CodeBlockCard(block: MdBlock.CodeBlock, style: TextStyle, background: Color) {
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    Surface(
        color = background,
        shape = MaterialTheme.shapes.small,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
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
                style = style.copy(fontFamily = FontFamily.Monospace, fontSize = 13.sp),
                modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
            )
        }
    }
}

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
