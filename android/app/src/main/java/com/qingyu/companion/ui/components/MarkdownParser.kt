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
 * 极简本地 Markdown 渲染（方案 §3.3「Markdown 渲染本地实现」）。
 * 覆盖聊天最常见的结构：标题 / 加粗 / 斜体 / 行内代码 / 代码块 / 引用 / 无序列表 / 段落。
 * 高级特性（表格、图片、链接）MVP 阶段按纯文本降级；后续可替换为完整 Markdown 库。
 * 解析函数 [parseMarkdown] 与 [inlineMarkdown] 为纯函数，便于 JVM 单测。
 */

sealed interface MdBlock {
    data class Paragraph(val text: String) : MdBlock
    /** 说话人对话块段落：普通文本与「角色: "对话"」片段交错（对齐 PC dialogue-block） */
    data class DialogueParagraph(val segments: List<DialogueSegment>) : MdBlock
    data class Heading(val level: Int, val text: String) : MdBlock
    data class CodeBlock(val language: String, val code: String) : MdBlock
    data class Quote(val text: String) : MdBlock
    data class ListItem(val text: String, val ordered: Boolean) : MdBlock
    data object HorizontalRule : MdBlock
    data class Table(val headers: List<String>, val rows: List<List<String>>) : MdBlock
    data class Image(val url: String) : MdBlock
}

/** 对话段片段：block=true 表示整行对白块（speaker 可为 null = 匿名对白）；block=false 为普通文本段 */
data class DialogueSegment(
    val speaker: String?,
    val text: String,
    val block: Boolean = false,
)

private val HEADING = Regex("""^(#{1,6})\s+(.*)$""")
private val LIST_ITEM = Regex("""^\s*([-*+]|\d+\.)\s+(.*)$""")
/** GFM 任务列表项：- [ ] 任务 / - [x] 已完成 */
/** GFM 任务列表项：- [ ] 任务 / - [x] 已完成 */
internal val TASK_ITEM = Regex("""^\[([ xX])\]\s+(.*)$""")
private val HR = Regex("""^\s*(?:-{3,}|\*{3,}|_{3,})\s*$""")
private val IMAGE_LINE = Regex("""^\s*!\[[^\]]*\]\(([^)\s]+)\)\s*$""")

/** 整段动作块检测：*动作*（排除 **加粗**） */

/** 整段动作块检测：*动作*（排除 **加粗**） */
internal fun isActionBlock(text: String): Boolean {
    val t = text.trim()
    return t.length >= 3 && t.startsWith("*") && t.endsWith("*") && !t.startsWith("**")
}
private val TABLE_SEPARATOR = Regex("""^\s*\|?[\s:|-]+\|?\s*$""")

/** 表格行：去头尾竖线后按 | 分列并 trim */

/** 表格行：去头尾竖线后按 | 分列并 trim */
internal fun parseTableRow(line: String): List<String> =
    line.trim().trim('|').split("|").map { it.trim() }

/** 判定是否为 GFM 表格分隔行（| --- | --- | 形式） */

/** 判定是否为 GFM 表格分隔行（| --- | --- | 形式） */
internal fun isTableSeparator(line: String): Boolean {
    val t = line.trim()
    if (!t.contains("|")) return false
    val cells = t.trim().trim('|').split("|")
    if (cells.isEmpty()) return false
    return cells.all { c ->
        val s = c.trim()
        s.isEmpty() || s.matches(Regex(""":?-{3,}:?"""))
    }
}

/**
 * 行级对白拆分（对齐 PC remark-roleplay 行级分类，复用 RoleplayBlocks 同一套规则）：
 * 整行「名字：“对白”」或整行纯引号对白 → 对白块段（后者为匿名块，无名字行）；
 * 其余行保持普通文本段。仅当存在块段时生成 DialogueParagraph。
 * 行内不再单独识别说话人前缀（避免把「叙述：“对白”」误拆成对话块）。
 * @return null 表示不含对白块，保持普通段落
 */
private fun splitDialogueParagraph(text: String): List<DialogueSegment>? {
    val segments = mutableListOf<DialogueSegment>()
    var hasBlock = false
    text.split('\n').forEachIndexed { index, rawLine ->
        val line = rawLine.trim()
        val speakerMatch = RoleplayBlocks.SPEAKER_QUOTE.matchEntire(line)
        val speakerName = speakerMatch?.groupValues?.get(1)?.trim()?.takeIf {
            !RoleplayBlocks.NARRATION_PREFIX.containsMatchIn(it)
        }
        when {
            speakerMatch != null && speakerName != null -> {
                hasBlock = true
                segments += DialogueSegment(
                    speakerName,
                    RoleplayBlocks.stripOuterQuotes(speakerMatch.groupValues[2]),
                    block = true,
                )
            }
            line.isNotEmpty() && RoleplayBlocks.PURE_QUOTE.matchEntire(line) != null -> {
                hasBlock = true
                segments += DialogueSegment(null, RoleplayBlocks.stripOuterQuotes(line), block = true)
            }
            line.isNotEmpty() -> segments += DialogueSegment(null, if (index > 0) "\n$line" else line)
        }
    }
    return if (hasBlock) segments else null
}

fun parseMarkdown(source: String): List<MdBlock> {
    val lines = source.lines()
    val blocks = mutableListOf<MdBlock>()
    val paragraph = StringBuilder()
    var i = 0

    fun flushParagraph() {
        if (paragraph.isNotEmpty()) {
            val raw = paragraph.toString().trim()
            blocks += splitDialogueParagraph(raw)?.let { MdBlock.DialogueParagraph(it) }
                ?: MdBlock.Paragraph(raw)
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
 * 行内 Markdown -> AnnotatedString。支持 `code`、~~删除线~~、**加粗**、*斜体*、链接、可嵌套。
 * @param links 可选：收集可点击链接区间（annotated 内字符区间 -> URL），供 ClickableText 使用。
 */
