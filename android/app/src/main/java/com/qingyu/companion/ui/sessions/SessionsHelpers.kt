package com.qingyu.companion.ui.sessions

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.model.Character
import com.qingyu.companion.model.SessionPreview
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.AvatarBubble
import com.qingyu.companion.ui.components.ConnectionStatusBar
import com.qingyu.companion.ui.components.SessionCard
import com.qingyu.companion.ui.components.resolveImageUrl
import com.qingyu.companion.ui.theme.qyColors


/** 空状态：极简字标 + 引导文案（方案 B：仅保留必要元素） */
@Composable
internal fun EmptyState(offline: Boolean) {
    val qy = qyColors()
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            modifier = Modifier
                .size(72.dp)
                .shadow(0.dp, CircleShape)
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
        Spacer(Modifier.height(20.dp))
        Text(
            "暂无会话",
            style = MaterialTheme.typography.titleLarge,
            color = qy.text,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            if (offline) "未连接 PC，且无本地缓存" else "在 PC 端开始对话，或检查连接状态",
            style = MaterialTheme.typography.bodyMedium,
            color = qy.muted,
        )
    }
}

/** 构建可选开场白列表：主首条消息 + 备选开场白（译文优先），过滤空串与重复项 */

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
