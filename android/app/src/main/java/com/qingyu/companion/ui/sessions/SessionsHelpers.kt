package com.qingyu.companion.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.qingyu.companion.model.Character
import com.qingyu.companion.ui.theme.qyColors

/** 空态品牌装饰：「轻」字标（方案 B 极简）。作为 QyEmptyState 的 leading 槽使用（E-02） */
@Composable
internal fun SessionsEmptyBadge() {
    val qy = qyColors()
    Box(
        modifier = Modifier
            .size(72.dp)
            .background(qy.accentSoft, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            "轻",
            style = MaterialTheme.typography.headlineMedium,
            color = qy.accent,
            fontWeight = FontWeight.Medium,
        )
    }
}

/** 构建可选开场白列表：主首条消息 + 备选开场白（译文优先），过滤空串与重复项 */
internal fun buildGreetingOptions(character: Character): List<String> {
    val main = character.translatedContent?.firstMessage ?: character.firstMessage
    val alternates = character.alternateGreetings.mapIndexed { i, g ->
        character.translatedContent?.alternateGreetings?.getOrNull(i) ?: g
    }
    return (listOfNotNull(main.takeIf { it.isNotBlank() }) + alternates)
        .filter { it.isNotBlank() }
        .distinct()
}
