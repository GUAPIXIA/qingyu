package com.qingyu.companion.ui.characters

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import coil.compose.AsyncImage
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.model.Character
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.MarkdownText
import com.qingyu.companion.ui.components.resolveImageUrl
import com.qingyu.companion.ui.theme.qyColors
import android.util.Log
import java.util.Locale


/** 角色详情底部弹窗：完整设定 + 历史对话/设为当前 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CharacterDetailSheet(
    character: Character,
    avatarUrl: String?,
    activating: Boolean,
    onDismiss: () -> Unit,
    onOpenSessions: () -> Unit,
    onActivate: () -> Unit,
) {
    val qy = qyColors()
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = qy.card,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(bottom = 24.dp),
        ) {
            // 头部：头像 + 名称 + 标签
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(64.dp)
                        .clip(CircleShape)
                        .background(qy.accent),
                    contentAlignment = Alignment.Center,
                ) {
                    if (avatarUrl != null) {
                        var loadFailed by remember(avatarUrl) { mutableStateOf(false) }
                        if (loadFailed) {
                            Text(
                                character.name.take(1),
                                style = MaterialTheme.typography.headlineMedium,
                                color = qy.onAccent,
                            )
                        } else {
                            AsyncImage(
                                model = avatarUrl,
                                contentDescription = character.name,
                                contentScale = ContentScale.Crop,
                                modifier = Modifier.fillMaxSize(),
                                onError = { loadFailed = true },
                            )
                        }
                    } else {
                        Text(
                            character.name.take(1),
                            style = MaterialTheme.typography.headlineMedium,
                            color = qy.onAccent,
                        )
                    }
                }
                Column(Modifier.padding(start = 14.dp)) {
                    Text(
                        character.translatedContent?.name ?: character.name,
                        style = MaterialTheme.typography.titleLarge,
                        color = qy.text,
                    )
                    if (character.tags.isNotEmpty()) {
                        Text(
                            character.tags.take(5).joinToString(" · "),
                            style = MaterialTheme.typography.labelSmall,
                            color = qy.soft,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }

            // 详情区块
            Column(
                modifier = Modifier.padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                DetailSection("描述", character.translatedContent?.description ?: character.description)
                DetailSection("性格", character.translatedContent?.personality ?: character.personality)
                DetailSection("场景", character.translatedContent?.scenario ?: character.scenario)
                DetailSection("开场白", character.translatedContent?.firstMessage ?: character.firstMessage)
            }

            // 操作按钮
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Surface(
                    onClick = onOpenSessions,
                    shape = RoundedCornerShape(12.dp),
                    color = qy.bg2,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(
                        "历史对话",
                        style = MaterialTheme.typography.labelLarge,
                        color = qy.text,
                        modifier = Modifier.padding(vertical = 9.dp),
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    )
                }
                Button(
                    onClick = onActivate,
                    enabled = !activating,
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = qy.accent,
                        contentColor = qy.onAccent,
                    ),
                    modifier = Modifier.weight(1f),
                ) {
                    if (activating) {
                        CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(if (activating) "切换中…" else "设为当前")
                }
            }
        }
    }
}

/** 详情区块：标题 + 内容（内容为空时隐藏） */

/** 详情区块：标题 + 内容（内容为空时隐藏） */
@Composable
private fun DetailSection(title: String, content: String) {
    val qy = qyColors()
    if (content.isBlank()) return
    Column {
        Text(
            title,
            style = MaterialTheme.typography.labelLarge,
            color = qy.accent,
        )
        Spacer(Modifier.height(4.dp))
        MarkdownText(
            content,
            style = MaterialTheme.typography.bodyMedium.copy(
                color = qy.text,
            ),
        )
    }
}
