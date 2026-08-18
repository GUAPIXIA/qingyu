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


/**
 * 角色页：双列网格卡（封面 + 名称 + 简介），点击进入详情弹窗
 * （完整设定 + 历史对话 / 设为当前）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CharactersScreen(
    onBack: () -> Unit,
    onOpenCharacterSessions: (characterId: String, characterName: String) -> Unit,
) {
    val qy = qyColors()
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
                            tint = qy.text,
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
                                tint = qy.soft,
                                modifier = Modifier.size(18.dp),
                            )
                        },
                    )
                    Spacer(Modifier.width(8.dp))
                    Surface(
                        onClick = { sortBy = if (sortBy == "name") "updated" else "name" },
                        shape = RoundedCornerShape(50),
                        color = qy.bg2,
                    ) {
                        Row(
                            Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                if (sortBy == "name") "按名称" else "按最近",
                                style = MaterialTheme.typography.labelMedium,
                                color = qy.soft,
                            )
                            Icon(
                                Icons.Filled.KeyboardArrowDown,
                                contentDescription = null,
                                modifier = Modifier.size(14.dp),
                                tint = qy.muted,
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
                            CircularProgressIndicator(Modifier.align(Alignment.Center), color = qy.accent)

                        ui.characters.isEmpty() -> Text(
                            ui.error ?: "暂无角色",
                            modifier = Modifier.align(Alignment.Center),
                            color = qy.soft,
                        )

                        filteredCharacters.isEmpty() -> Text(
                            "没有匹配的角色",
                            modifier = Modifier.align(Alignment.Center),
                            color = qy.soft,
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
                        color = qy.accentSoft,
                        shape = RoundedCornerShape(14.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                    ) {
                        Text(
                            info,
                            style = MaterialTheme.typography.bodyMedium,
                            color = qy.accent,
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

/** 角色网格卡：封面 + 名称 + 简介 */
