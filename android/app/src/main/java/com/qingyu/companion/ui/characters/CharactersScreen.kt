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
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import coil.compose.AsyncImage
import com.qingyu.companion.R
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.data.userMessage
import com.qingyu.companion.model.Character
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.components.LoadState
import com.qingyu.companion.ui.components.MarkdownText
import com.qingyu.companion.ui.components.QyEmptyState
import com.qingyu.companion.ui.components.QyErrorBanner
import com.qingyu.companion.ui.components.QyOfflineBanner
import com.qingyu.companion.ui.components.QySkeletonList
import com.qingyu.companion.ui.components.rememberSkeletonVisible
import com.qingyu.companion.ui.components.resolveImageUrl
import com.qingyu.companion.ui.theme.qyColors
import android.util.Log
import java.util.Locale


/**
 * 角色页：双列网格卡（封面 + 名称 + 简介），点击进入详情弹窗
 * （完整设定 + 历史对话 / 设为当前）。
 * E-02：页面状态统一由 [CharactersViewModel.loadState]（LoadState 五态）驱动，
 * 渲染走 ui/components/AsyncStates.kt 的 Qy 组件（骨架/空态/离线/错误）；
 * 搜索、排序、详情弹窗、切换当前角色等交互保持不变。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CharactersScreen(
    onBack: () -> Unit,
    onOpenCharacterSessions: (characterId: String, characterName: String) -> Unit,
    onOpenChat: (sessionId: String, characterId: String) -> Unit,
) {
    val qy = qyColors()
    val container = LocalAppContainer.current
    val vm: CharactersViewModel = viewModel(factory = viewModelFactory {
        initializer { CharactersViewModel(container.repository) }
    })
    val ui by vm.ui.collectAsStateWithLifecycle()
    val loadState by vm.loadState.collectAsStateWithLifecycle()
    val skeletonVisible = rememberSkeletonVisible(loadState is LoadState.Loading)
    val activeConnection by container.connectionManager.activeFlow.collectAsStateWithLifecycle()
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
                title = stringResource(R.string.characters_title),
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.cd_back),
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
                        placeholder = { Text(stringResource(R.string.msg_search_hint)) },
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
                        modifier = Modifier.minimumInteractiveComponentSize(),
                    ) {
                        Row(
                            Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                if (sortBy == "name") {
                                    stringResource(R.string.characters_sort_by_name)
                                } else {
                                    stringResource(R.string.characters_sort_by_recent)
                                },
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
                    // E-02：五态分发（Loading 骨架 / Empty 空态 / Offline 横幅+缓存 / Error 横幅+重试 / Content 网格）
                    when (val st = loadState) {
                        is LoadState.Loading -> {
                            if (skeletonVisible) {
                                QySkeletonList(
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .padding(16.dp),
                                    rows = 4,
                                )
                            }
                        }

                        is LoadState.Empty -> {
                            QyEmptyState(
                                title = stringResource(R.string.characters_empty),
                                actionLabel = stringResource(R.string.action_retry),
                                onAction = vm::refresh,
                                modifier = Modifier.fillMaxSize(),
                            )
                        }

                        is LoadState.Error -> {
                            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                QyErrorBanner(
                                    message = st.error.userMessage(),
                                    retryable = st.retryable,
                                    onRetry = vm::refresh,
                                    modifier = Modifier.padding(horizontal = 16.dp),
                                )
                            }
                        }

                        is LoadState.Offline -> {
                            Column(Modifier.fillMaxSize()) {
                                QyOfflineBanner(
                                    onRetry = vm::refresh,
                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                                )
                                CharacterGrid(filteredCharacters, activeConnection) { character ->
                                    detailCharacter = character
                                }
                            }
                        }

                        is LoadState.Content -> {
                            if (filteredCharacters.isEmpty()) {
                                QyEmptyState(
                                    title = stringResource(R.string.characters_search_empty),
                                    modifier = Modifier.fillMaxSize(),
                                )
                            } else {
                                CharacterGrid(filteredCharacters, activeConnection) { character ->
                                    detailCharacter = character
                                }
                            }
                        }
                    }
                }
                // 动作失败横幅（切换/新建失败：动作级错误，不参与页面 LoadState 投影）
                ui.actionError?.let { err ->
                    QyErrorBanner(
                        message = err.userMessage(),
                        onRetry = null,
                        retryable = false,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                    )
                }
                // 信息提示条（切换成功等，网格底部）
                ui.infoResId?.let { infoRes ->
                    Surface(
                        color = qy.accentSoft,
                        shape = RoundedCornerShape(14.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                    ) {
                        Text(
                            stringResource(infoRes, ui.infoResArg ?: ""),
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
            creating = ui.creatingId == character.id,
            onDismiss = { detailCharacter = null },
            onOpenSessions = { onOpenCharacterSessions(character.id, character.name) },
            onActivate = { vm.activate(character.id, character.name) },
            onStartChat = { vm.startChat(character.id) { sessionId -> onOpenChat(sessionId, character.id) } },
        )
    }
}

/**
 * 角色网格渲染（Content / Offline 共用）：双列网格卡，点击进入详情弹窗。
 */
@Composable
private fun CharacterGrid(
    characters: List<Character>,
    activeConnection: com.qingyu.companion.model.ServerConnection?,
    onOpenDetail: (Character) -> Unit,
) {
    LazyVerticalGrid(
        columns = GridCells.Fixed(2),
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items(characters, key = { it.id }) { character ->
            CharacterCard(
                character = character,
                avatarUrl = resolveImageUrl(character.avatarUrl, activeConnection),
                onClick = { onOpenDetail(character) },
            )
        }
    }
}

/** 角色网格卡：封面 + 名称 + 简介 */
