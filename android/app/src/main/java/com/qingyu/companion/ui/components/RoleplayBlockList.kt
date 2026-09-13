package com.qingyu.companion.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.qingyu.companion.ui.theme.qyColors

/**
 * 语义分块渲染（阶段7.2，方案 §6.2/§6.3）：与 PC MessageBubble 的 blocks 分支同语义。
 * 三色收敛样式（对齐 PC index.css）：对白块 = 左竖线 + 说话人名（accent 小标）+ 正文主色；
 * 匿名对白同结构无名字行；叙述 = 弱化灰正文（不斜体）；mixed = 正文 + 行内引号染色。
 * 分块只影响展示样式；复制/翻译/搜索仍基于原始 message.content（由调用方保证）。
 *
 * 消费契约：仅当消息 `contentRenderMode == "blocks"` 时使用；
 * 旧消息（字段缺省）或未知值走调用方的 Markdown 兼容分支，不崩溃。
 */
@Composable
fun RoleplayBlockList(
    blocks: List<RoleplayBlock>,
    modifier: Modifier = Modifier,
    baseStyle: TextStyle = MaterialTheme.typography.bodyMedium,
    fontScale: Float = 1f,
    spacingMultiplier: Float = 1f,
    onUserBubble: Boolean = false,
    mentionNames: List<String> = emptyList(),
) {
    val qy = qyColors()
    val spacing = spacingMultiplier.coerceIn(0.6f, 1.6f)
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy((5 * spacing).dp),
    ) {
        for (block in blocks) {
            when (block) {
                is RoleplayBlock.Dialogue -> Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(top = (2 * spacing).dp, bottom = (2 * spacing).dp),
                ) {
                    // 左竖线：accent 淡色（对齐 PC dialogue-block 的 border-left）
                    Box(
                        Modifier
                            .width(2.dp)
                            .fillMaxHeight()
                            .clip(RoundedCornerShape(1.dp))
                            .background(qy.accent.copy(alpha = 0.45f)),
                    )
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.fillMaxWidth()) {
                        if (block.speaker != null) {
                            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                                Box(
                                    Modifier
                                        .width(6.dp)
                                        .height(6.dp)
                                        .clip(CircleShape)
                                        .background(qy.accent),
                                )
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    block.speaker,
                                    style = MaterialTheme.typography.labelSmall.scaledForChat(fontScale).copy(
                                        color = qy.accent,
                                        fontWeight = FontWeight.SemiBold,
                                    ),
                                )
                            }
                            Spacer(Modifier.height(2.dp))
                        }
                        MarkdownText(
                            // 展示层剥外层引号（原文不变，复制/搜索基于 message.content）
                            text = RoleplayBlocks.stripOuterQuotes(block.text),
                            style = baseStyle.copy(color = qy.text),
                            fontScale = fontScale,
                            spacingMultiplier = spacing,
                            onUserBubble = onUserBubble,
                            mentionNames = mentionNames,
                        )
                    }
                }
                is RoleplayBlock.Narration -> MarkdownText(
                    // 叙述/动作：灰色弱化正文（中文斜体渲染质量差，不再斜体）
                    text = block.text,
                    style = baseStyle.copy(color = qy.soft),
                    fontScale = fontScale,
                    spacingMultiplier = spacing,
                    onUserBubble = onUserBubble,
                    mentionNames = mentionNames,
                )
                is RoleplayBlock.Thought -> MarkdownText(
                    // 正文内残留的 thought 块（正常已由 extractThought 前置展示）：按心理活动弱化
                    text = block.text,
                    style = baseStyle.copy(color = qy.soft, fontStyle = androidx.compose.ui.text.font.FontStyle.Italic),
                    fontScale = fontScale,
                    spacingMultiplier = spacing,
                    onUserBubble = onUserBubble,
                    mentionNames = mentionNames,
                )
                is RoleplayBlock.Mixed -> MarkdownText(
                    // 混写段按普通正文显示；行内对白引号由 inlineMarkdown 染色（与 PC dialogue-inline 一致）
                    text = block.text,
                    style = baseStyle.copy(color = qy.text),
                    fontScale = fontScale,
                    spacingMultiplier = spacing,
                    onUserBubble = onUserBubble,
                    mentionNames = mentionNames,
                )
            }
        }
    }
}
