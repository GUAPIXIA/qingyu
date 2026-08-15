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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
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
import com.qingyu.companion.ui.theme.Accent
import com.qingyu.companion.ui.theme.AssistantBubble
import android.util.Log
import java.util.Locale

/**
 * 角色页：双列网格卡（封面渐变 + 名称 + 简介），点击进入详情弹窗
 * （完整设定 + 历史对话 / 设为当前）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CharactersScreen(
    onBack: () -> Unit,
    onOpenCharacterSessions: (characterId: String, characterName: String) -> Unit,
) {
    val container = LocalAppContainer.current
    val vm: CharactersViewModel = viewModel(factory = viewModelFactory {
        initializer { CharactersViewModel(container.repository) }
    })
    val ui by vm.ui.collectAsState()
    val activeConnection by container.connectionManager.activeFlow.collectAsState()
    var detailCharacter by remember { mutableStateOf<Character?>(null) }
    // 搜索与排序
    var searchQuery by remember { mutableStateOf("") }
    var sortBy by remember { mutableStateOf("updated") } // updated | name
    val filteredCharacters = remember(ui.characters, searchQuery, sortBy) {
        val q = searchQuery.trim().lowercase(Locale.getDefault())
        val base = ui.characters.filter { c ->
            q.isEmpty() || c.name.lowercase().contains(q) ||
                c.tags.any { it.lowercase().contains(q) }
        }
        if (sortBy == "name") {
            base.sortedWith(
                compareByDescending<com.qingyu.companion.model.Character> { it.pinned == true }
                    .thenBy { it.name.lowercase() }
            )
        } else {
            base.sortedWith(
                compareByDescending<com.qingyu.companion.model.Character> { it.pinned == true }
                    .thenByDescending { it.updatedAt }
            )
        }
    }

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            AppTopBar(
                title = "角色",
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "返回",
                            tint = MaterialTheme.colorScheme.onBackground,
                        )
                    }
                },
            )
        },
    ) { padding ->
        AppBackground {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
            ) {
                // 搜索 + 排序（统一 chip 样式）
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OutlinedTextField(
                        value = searchQuery,
                        onValueChange = { searchQuery = it },
                        modifier = Modifier.weight(1f),
                        placeholder = { Text("搜索角色或标签…") },
                        singleLine = true,
                        shape = RoundedCornerShape(14.dp),
                        leadingIcon = {
                            Icon(
                                Icons.Filled.Search,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.size(18.dp),
                            )
                        },
                    )
                    Spacer(Modifier.width(8.dp))
                    Surface(
                        onClick = { sortBy = if (sortBy == "name") "updated" else "name" },
                        shape = RoundedCornerShape(50),
                        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.75f),
                        border = androidx.compose.foundation.BorderStroke(
                            1.dp,
                            MaterialTheme.colorScheme.outline.copy(alpha = 0.3f),
                        ),
                    ) {
                        Row(
                            Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                if (sortBy == "name") "按名称" else "按最近",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Icon(
                                Icons.Filled.KeyboardArrowDown,
                                contentDescription = null,
                                modifier = Modifier.size(14.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                            )
                        }
                    }
                }

                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .weight(1f),
                ) {
                    when {
                        ui.loading && ui.characters.isEmpty() ->
                            CircularProgressIndicator(Modifier.align(Alignment.Center), color = Accent)

                        ui.characters.isEmpty() -> Text(
                            ui.error ?: "暂无角色",
                            modifier = Modifier.align(Alignment.Center),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )

                        filteredCharacters.isEmpty() -> Text(
                            "没有匹配的角色",
                            modifier = Modifier.align(Alignment.Center),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )

                        else -> LazyVerticalGrid(
                            columns = GridCells.Fixed(2),
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(16.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            items(filteredCharacters, key = { it.id }) { character ->
                                CharacterCard(
                                    character = character,
                                    avatarUrl = resolveImageUrl(character.avatarUrl, activeConnection),
                                    onClick = { detailCharacter = character },
                                )
                            }
                        }
                    }
                }
                // 信息提示条（网格底部）
                ui.info?.let { info ->
                    Surface(
                        color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.9f),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                    ) {
                        Text(
                            info,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                        )
                    }
                }
            }
        }
    }

    // 角色详情弹窗
    detailCharacter?.let { character ->
        CharacterDetailSheet(
            character = character,
            avatarUrl = resolveImageUrl(character.avatarUrl, activeConnection),
            activating = ui.activatingId == character.id,
            onDismiss = { detailCharacter = null },
            onOpenSessions = { onOpenCharacterSessions(character.id, character.name) },
            onActivate = { vm.activate(character.id, character.name) },
        )
    }
}

/** 角色网格卡：封面渐变 + 名称 + 简介 */
@Composable
private fun CharacterCard(
    character: Character,
    avatarUrl: String?,
    onClick: () -> Unit,
) {
    Log.d("CharactersScreen", "CharacterCard: ${character.name}, avatarUrl=$avatarUrl, raw=${character.avatarUrl}")
    val seed = character.name.hashCode()
    val palette = listOf(
        listOf(Color(0xFFD4A574), Color(0xFF8E633C)),
        listOf(Color(0xFF9B7EDE), Color(0xFF5A3F8E)),
        listOf(Color(0xFF7EC97E), Color(0xFF3F6F52)),
        listOf(Color(0xFFE08C7A), Color(0xFF8E4A3C)),
        listOf(Color(0xFF5B9BD5), Color(0xFF2E5A85)),
        listOf(Color(0xFFE0C068), Color(0xFF8E7A2E)),
    )
    val gradient = palette[Math.floorMod(seed, palette.size)]

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .shadow(10.dp, RoundedCornerShape(20.dp), ambientColor = Color.Black.copy(alpha = 0.35f))
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outline.copy(alpha = 0.25f),
        ),
    ) {
        Column {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(1.35f)
                    .background(Brush.linearGradient(gradient)),
            ) {
                if (avatarUrl != null) {
                    var loadFailed by remember(avatarUrl) { mutableStateOf(false) }
                    if (loadFailed) {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .background(Brush.linearGradient(gradient)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                character.name.take(1),
                                style = MaterialTheme.typography.headlineLarge,
                                color = Color.White,
                            )
                        }
                    } else {
                        AsyncImage(
                            model = avatarUrl,
                            contentDescription = character.name,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.fillMaxSize(),
                            onError = {
                                loadFailed = true
                            },
                        )
                    }
                }
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(
                            Brush.verticalGradient(
                                0.35f to Color.Transparent,
                                1f to Color.Black.copy(alpha = 0.55f),
                            )
                        )
                )
                Text(
                    character.name,
                    style = MaterialTheme.typography.titleMedium,
                    color = Color.White,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .padding(12.dp),
                )
            }
            val desc = character.translatedContent?.description ?: character.description
            Text(
                desc.ifBlank { "（无简介）" },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                minLines = 2,
                modifier = Modifier.padding(10.dp),
            )
        }
    }
}

/** 角色详情底部弹窗：完整设定 + 历史对话/设为当前 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CharacterDetailSheet(
    character: Character,
    avatarUrl: String?,
    activating: Boolean,
    onDismiss: () -> Unit,
    onOpenSessions: () -> Unit,
    onActivate: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = MaterialTheme.colorScheme.surface,
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
                        .shadow(10.dp, RoundedCornerShape(18.dp), ambientColor = Color.Black.copy(alpha = 0.4f))
                        .clip(RoundedCornerShape(18.dp)),
                ) {
                    if (avatarUrl != null) {
                        var loadFailed by remember(avatarUrl) { mutableStateOf(false) }
                        if (loadFailed) {
                            Box(
                                Modifier
                                    .fillMaxSize()
                                    .background(Brush.linearGradient(listOf(Accent, AssistantBubble))),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    character.name.take(1),
                                    style = MaterialTheme.typography.headlineMedium,
                                    color = Color.White,
                                )
                            }
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
                        Box(
                            Modifier
                                .fillMaxSize()
                                .background(Brush.linearGradient(listOf(Accent, AssistantBubble))),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                character.name.take(1),
                                style = MaterialTheme.typography.headlineMedium,
                                color = Color.White,
                            )
                        }
                    }
                }
                Column(Modifier.padding(start = 14.dp)) {
                    Text(
                        character.translatedContent?.name ?: character.name,
                        style = MaterialTheme.typography.titleLarge,
                    )
                    if (character.tags.isNotEmpty()) {
                        Text(
                            character.tags.take(5).joinToString(" · "),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
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
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.8f),
                    modifier = Modifier.weight(1f),
                ) {
                    Text(
                        "历史对话",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 12.dp),
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    )
                }
                Button(
                    onClick = onActivate,
                    enabled = !activating,
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Accent,
                        contentColor = Color(0xFF3B2410),
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
@Composable
private fun DetailSection(title: String, content: String) {
    if (content.isBlank()) return
    Column {
        Text(
            title,
            style = MaterialTheme.typography.labelLarge,
            color = Accent,
        )
        Spacer(Modifier.height(4.dp))
        MarkdownText(
            content,
            style = MaterialTheme.typography.bodyMedium.copy(
                color = MaterialTheme.colorScheme.onSurface,
            ),
        )
    }
}
