package com.qingyu.companion.ui.chat

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalMinimumInteractiveComponentEnforcement
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import coil.compose.AsyncImage
import com.qingyu.companion.R
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.model.Message
import com.qingyu.companion.model.PendingMessage
import com.qingyu.companion.model.QuickReply
import com.qingyu.companion.model.Role
import com.qingyu.companion.model.TimelineItem
import com.qingyu.companion.model.buildTimeline
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AvatarBubble
import com.qingyu.companion.ui.components.ImageViewerDialog
import com.qingyu.companion.ui.components.MessageImages
import com.qingyu.companion.ui.components.QuickSettingsPanel
import com.qingyu.companion.ui.components.resolveImageUrl
import com.qingyu.companion.ui.components.translatedMessageContent
import com.qingyu.companion.ui.theme.qyColors
import com.qingyu.companion.ui.tts.TtsPlayer
import com.qingyu.companion.utils.SearchUtils
import com.qingyu.companion.utils.ShareUtils
import com.qingyu.companion.utils.uriToCompressedBase64
import kotlinx.coroutines.launch

/**
 * 单聊对话页（方案 B · 情感极简 · 透明上下栏）：
 * - 消息列表全屏延伸，滚动时从透明顶栏与底部输入区之下穿过，互不遮挡；
 * - 顶栏：全透明浮层（仅返回 + 标题 + 操作，顶部渐隐护底）；
 * - 底部：渐变浮层（透明→底色），输入框为极简单行胶囊（无描边）。
 *
 * E-04/E-05：输入区收口（附件菜单 + 错误动作语义）、滚动跟随与新增计数、
 * 搜索匹配列表 + 上一项/下一项 + 高亮跳转；全部文案走 strings.xml。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    sessionId: String,
    characterId: String? = null,
    onBack: () -> Unit,
    onOpenBranch: (String, String) -> Unit,
) {
    val qy = qyColors()
    val container = LocalAppContainer.current
    val vm: ChatViewModel = viewModel(factory = viewModelFactory {
        initializer {
            ChatViewModel(
                repository = container.repository,
                sessionId = sessionId,
                expectedCharacterId = characterId,
                ttsPlayer = container.ttsPlayer,
                generationTracker = container.generationTracker,
                draftStore = container.draftStore,
            )
        }
    })
    val ui by vm.ui.collectAsStateWithLifecycle()
    val input by vm.input.collectAsStateWithLifecycle()
    val replyTo by vm.replyTo.collectAsStateWithLifecycle()
    val pendingImages by vm.images.collectAsStateWithLifecycle()
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current

    // 本地 UI 偏好：聊天字体缩放 + 消息间距 + 对话背景
    val fontScale by container.uiPrefsStore.fontScale.collectAsStateWithLifecycle(initialValue = 1f)
    val spacingMult by container.uiPrefsStore.spacingMultiplier.collectAsStateWithLifecycle(initialValue = 1f)
    val bgEnabled by container.uiPrefsStore.chatBackground.collectAsStateWithLifecycle(initialValue = true)

    var menuMessage by remember { mutableStateOf<Message?>(null) }
    var editingMessage by remember { mutableStateOf<Message?>(null) }
    var editText by remember { mutableStateOf("") }
    var viewer by remember { mutableStateOf<Pair<List<String>, Int>?>(null) }
    // 快捷设置面板（世界书/预设）
    var showQuickSettings by remember { mutableStateOf(false) }
    // 清空对话确认
    var showClearConfirm by remember { mutableStateOf(false) }
    // 搜索与分享
    var showSearch by remember { mutableStateOf(false) }
    val searchQuery by vm.searchQuery.collectAsStateWithLifecycle()
    val directionsError by vm.directionsError.collectAsStateWithLifecycle()
    // 会话开启“下一步方向”时才渲染卡片；开关来自 PC 会话字段（旧端缺省 false）
    val dialogueDirectionsEnabled = ui.dialogueDirectionsEnabled
    // 附件菜单（E-04）
    var showAttachments by remember { mutableStateOf(false) }
    // E-05 搜索导航：当前高亮匹配下标（底->上时间线顺序）
    var searchIndex by remember { mutableIntStateOf(0) }
    // 分享消息 chooser 标题（非 composable 上下文使用）
    val shareMessageLabel = stringResource(R.string.chat_share_message)

    // 选图（PhotoPicker，无需权限）
    val imagePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri: Uri? ->
        uri?.let {
            val base64 = uriToCompressedBase64(context, it)
            if (base64 != null) {
                vm.onImagesChange(pendingImages + base64)
            }
        }
    }

    val ttsState by container.ttsPlayer.state.collectAsStateWithLifecycle()

    DisposableEffect(Unit) {
        onDispose { container.ttsPlayer.release() }
    }

    Scaffold(containerColor = Color.Transparent) { padding ->
        AppBackground {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .consumeWindowInsets(padding),
            ) {
                // ===== 角色封面背景（模糊 + 底色压暗蒙层，保证气泡可读） =====
                val coverUrl = resolveImageUrl(
                    ui.characterCoverUrl,
                    container.connectionManager.activeConnection,
                )
                if (bgEnabled && coverUrl != null) {
                    AsyncImage(
                        model = coverUrl,
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier
                            .fillMaxSize()
                            .blur(if (qy.isDark) 14.dp else 10.dp),
                    )
                    // 压暗蒙层：深色压得更深，浅色稍亮，保持 Morandi 低对比氛围
                    Box(
                        Modifier
                            .fillMaxSize()
                            .background(qy.bg.copy(alpha = if (qy.isDark) 0.78f else 0.85f))
                    )
                }

                // 时间线：全屏延伸，滚动时从透明顶栏与底部输入区之下穿过
                val timeline = remember(ui.messages, ui.pending) {
                    buildTimeline(ui.messages, ui.pending)
                }
                // E-05 搜索：维护匹配 messageId 列表（不依赖过滤后的时间线）
                val matchedIds = remember(ui.messages, searchQuery) {
                    SearchUtils.matchingMessageIds(ui.messages, searchQuery)
                }
                val matchedSet = remember(matchedIds) { matchedIds.toSet() }
                val filteredTimeline = remember(timeline, searchQuery) {
                    if (searchQuery.isBlank()) timeline else timeline.filter { item ->
                        when (item) {
                            is TimelineItem.Entry -> matchedSet.contains(item.message.id)
                            is TimelineItem.PendingEntry -> item.pending.content.contains(searchQuery, ignoreCase = true)
                            is TimelineItem.DateHeader -> true
                        }
                    }
                }
                // 分享整段会话：纯文本/Markdown via Share Sheet
                val shareSessionLabel = stringResource(R.string.chat_share_session)
                val shareSessionMarkdownLabel = stringResource(R.string.chat_share_session_markdown)
                fun shareSession(asMarkdown: Boolean) {
                    val text = ShareUtils.sessionExportText(ui.messages, asMarkdown)
                    if (text.isBlank()) return
                    val intent = Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(Intent.EXTRA_TEXT, text)
                    }
                    context.startActivity(
                        Intent.createChooser(intent, if (asMarkdown) shareSessionMarkdownLabel else shareSessionLabel)
                    )
                }
                val messageListState = rememberLazyListState(initialFirstVisibleItemIndex = 0)
                // 历史消息异步加载完成后明确定位 index 0；时间线保证 index 0 是最新消息。
                LaunchedEffect(sessionId, ui.messages.isNotEmpty()) {
                    if (ui.messages.isNotEmpty()) messageListState.scrollToItem(0)
                }
                // E-05 滚动跟随状态机（纯函数）：上滑超阈值停止跟随，显示回到最新 + 计数
                var followState by remember { mutableStateOf(ChatFollowState()) }
                val firstVisible by remember {
                    derivedStateOf { messageListState.firstVisibleItemIndex }
                }
                // 新内容批次（流式 chunk 节流批次 / 新消息 / streaming 文本变化）计数输入
                // 状态机推进：位置变化时结算
                LaunchedEffect(firstVisible) {
                    followState = chatFollowTick(
                        scroll = ScrollSnapshot(firstVisibleItemIndex = firstVisible),
                        newContent = 0,
                        previous = followState,
                    )
                }
                val streamingTextLen = (ui.streaming as? ChatViewModel.Streaming.Generating)?.text?.length
                LaunchedEffect(streamingTextLen) {
                    if (streamingTextLen != null && streamingTextLen > 0) {
                        followState = chatFollowTick(
                            scroll = ScrollSnapshot(firstVisibleItemIndex = firstVisible),
                            newContent = 1,
                            previous = followState,
                        )
                    }
                }
                val bottomActionVisible by remember {
                    derivedStateOf { !chatFollowOverlayVisible(followState) }
                }
                // 底部输入区实际高度（快捷回复/图片预览出现时自适应，让列表让位）
                var footerHeightPx by remember { mutableStateOf(0) }
                val density = LocalDensity.current
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    state = messageListState,
                    reverseLayout = true,
                    contentPadding = PaddingValues(
                        start = 16.dp,
                        end = 16.dp,
                        top = 48.dp,
                        bottom = with(density) { footerHeightPx.toDp() } + 8.dp,
                    ),
                ) {
                    val streaming = ui.streaming as? ChatViewModel.Streaming.Generating
                    if (streaming != null && streaming.text.isNotEmpty()) {
                        item(key = "streaming") {
                            StreamingBubble(
                                text = streaming.text,
                                fontScale = fontScale,
                                spacingMultiplier = spacingMult,
                            )
                        }
                    }

                    items(filteredTimeline, key = { item ->
                        when (item) {
                            is TimelineItem.DateHeader -> "date:${item.label}"
                            is TimelineItem.Entry -> "${item.message.sessionId}:${item.message.id}"
                            is TimelineItem.PendingEntry -> "pending:${item.pending.requestId}"
                        }
                    }) { item ->
                        when (item) {
                            is TimelineItem.DateHeader -> DateHeaderRow(item.label)

                            is TimelineItem.Entry -> {
                                val referenced = ui.messages.firstOrNull { it.id == item.message.replyToId }
                                // 消息图片为相对路径（/static/messages/...），拼接当前连接的 baseUrl
                                val imageUrls = item.message.images.map {
                                    resolveImageUrl(it, container.connectionManager.activeConnection) ?: it
                                }
                                MessageBubble(
                                    message = item.message,
                                    referencedMessage = referenced,
                                    characterName = ui.characterName,
                                    onLongPress = { menuMessage = item.message },
                                    onSwipe = { direction -> vm.swipe(item.message.id, direction) },
                                    onImageClick = { index -> viewer = imageUrls to index },
                                    imageUrls = imageUrls,
                                    fontScale = fontScale,
                                    spacingMultiplier = spacingMult,
                                    onCopy = {
                                        clipboard.setText(
                                            AnnotatedString(
                                                translatedMessageContent(item.message.content, item.message.translation)
                                            )
                                        )
                                    },
                                    onEdit = {
                                        editingMessage = item.message
                                        editText = item.message.content
                                    },
                                    onRegenerate = { vm.regenerate(item.message.id) },
                                    onSpeak = {
                                        container.ttsPlayer.stop()
                                        vm.playTts(item.message.id)
                                    },
                                    onTranslate = { vm.translate(item.message.id) },
                                    isTranslating = item.message.id in ui.translatingMessageIds,
                                    onDelete = { vm.deleteMessage(item.message.id) },
                                    searchQuery = searchQuery,
                                    dialogueDirectionsEnabled = dialogueDirectionsEnabled,
                                    isLast = item.message.id == ui.messages.lastOrNull()?.id,
                                    currentDraft = { input },
                                    onSelectDirection = { direction -> vm.onInputChange(direction.content) },
                                    onRegenerateDirections =
                                        if (item.message.id == ui.messages.lastOrNull()?.id) {
                                            { vm.regenerateDirections(item.message.id) }
                                        } else {
                                            null
                                        },
                                    directionsError = directionsError[item.message.id],
                                )
                            }

                            is TimelineItem.PendingEntry -> PendingBubble(
                                pending = item.pending,
                                onRetry = { vm.retryPending(item.pending.requestId) },
                                onRetryGeneration = { vm.retryGeneration(item.pending.requestId) },
                                onCancel = { vm.cancelPending(item.pending.requestId) },
                                connection = ui.connection,
                                fontScale = fontScale,
                                spacingMultiplier = spacingMult,
                            )
                        }
                    }

                    ui.nextCursor?.let {
                        item(key = "load-older") {
                            Box(
                                Modifier
                                    .fillMaxWidth()
                                    .padding(8.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                TextButton(onClick = vm::loadOlder, enabled = !ui.loadingOlder) {
                                    if (ui.loadingOlder) {
                                        CircularProgressIndicator(
                                            Modifier.size(14.dp),
                                            strokeWidth = 2.dp,
                                            color = qy.accent,
                                        )
                                        Spacer(Modifier.width(8.dp))
                                    }
                                    Text(stringResource(R.string.msg_load_older), color = qy.muted)
                                }
                            }
                        }
                    }

                    // reverseLayout 下，contentPadding 的 top 不等价于视觉顶部。
                    // 显式插入顶部安全区，避免首条消息被悬浮顶栏覆盖。
                    item(key = "chat-top-inset") {
                        Spacer(Modifier.height(56.dp))
                    }
                }

                // E-05 回到最新浮层：仅脱离跟随后显示，带新增内容计数
                val scope = rememberCoroutineScope()
                val scrollToLatestLabel = stringResource(R.string.chat_cd_scroll_to_latest)
                androidx.compose.animation.AnimatedVisibility(
                    visible = !bottomActionVisible,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(bottom = with(density) { footerHeightPx.toDp() } + 16.dp)
                        .zIndex(2f),
                    enter = fadeIn(),
                    exit = fadeOut(),
                ) {
                    FilledTonalButton(
                        onClick = {
                            followState = chatFollowReset(followState)
                            scope.launch { messageListState.scrollToItem(0) }
                        },
                        colors = ButtonDefaults.filledTonalButtonColors(
                            containerColor = qy.bg2.copy(alpha = 0.68f),
                            contentColor = qy.soft,
                        ),
                        modifier = Modifier.semantics {
                            contentDescription = scrollToLatestLabel
                        },
                    ) {
                        Icon(
                            Icons.Filled.KeyboardArrowDown,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                        Spacer(Modifier.width(4.dp))
                        Text(stringResource(R.string.chat_scroll_to_latest))
                        if (followState.newCount > 0) {
                            Spacer(Modifier.width(6.dp))
                            Text(
                                stringResource(R.string.chat_new_messages_fmt, followState.newCount),
                                style = MaterialTheme.typography.labelMedium,
                                color = qy.accent.copy(alpha = 0.55f),
                            )
                        }
                    }
                }

                // E-05 搜索条：匹配计数 + 上一项/下一项 + 高亮跳转
                AnimatedVisibility(
                    visible = showSearch,
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .padding(top = 48.dp)
                        .fillMaxWidth()
                        .background(qy.bg.copy(alpha = 0.96f))
                        .padding(horizontal = 16.dp, vertical = 6.dp)
                        .zIndex(1f),
                    enter = fadeIn(), exit = fadeOut(),
                ) {
                    Column {
                        OutlinedTextField(
                            value = searchQuery,
                            onValueChange = { q ->
                                vm.onSearchQueryChange(q)
                                searchIndex = 0
                            },
                            placeholder = { Text(stringResource(R.string.chat_search_hint), color = qy.muted) },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                            trailingIcon = {
                                if (searchQuery.isNotEmpty()) {
                                    IconButton(onClick = {
                                        vm.clearSearch()
                                        searchIndex = 0
                                    }) {
                                        Icon(
                                            Icons.Filled.Delete,
                                            contentDescription = stringResource(R.string.chat_search_clear),
                                            tint = qy.muted,
                                            modifier = Modifier.size(16.dp),
                                        )
                                    }
                                }
                            },
                            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = qy.accent, unfocusedBorderColor = qy.line),
                        )
                        if (searchQuery.isNotBlank()) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                val cur = if (matchedIds.isEmpty()) 0 else searchIndex.coerceIn(0, matchedIds.size - 1)
                                Text(
                                    if (matchedIds.isEmpty()) {
                                        stringResource(R.string.chat_search_no_match)
                                    } else {
                                        stringResource(R.string.chat_search_results_fmt, cur + 1, matchedIds.size)
                                    },
                                    style = MaterialTheme.typography.labelSmall,
                                    color = if (matchedIds.isEmpty()) qy.danger else qy.muted,
                                    modifier = Modifier.weight(1f),
                                )
                                // 上一个匹配（更旧，视觉上方） / 下一个匹配（更新，视觉下方）
                                IconButton(
                                    onClick = {
                                        val prev = SearchUtils.navigateMatch(matchedIds, searchIndex, 1) ?: return@IconButton
                                        searchIndex = prev
                                        scope.launch {
                                            val target = matchedIds[prev]
                                            val index = filteredTimeline.indexOfFirst { item ->
                                                (item as? TimelineItem.Entry)?.message?.id == target
                                            }
                                            if (index >= 0) messageListState.animateScrollToItem(index)
                                        }
                                    },
                                    enabled = matchedIds.size > 1,
                                    modifier = Modifier.size(32.dp),
                                ) {
                                    Icon(
                                        Icons.Filled.KeyboardArrowUp,
                                        contentDescription = stringResource(R.string.chat_cd_search_previous),
                                        tint = qy.soft,
                                        modifier = Modifier.size(20.dp),
                                    )
                                }
                                IconButton(
                                    onClick = {
                                        val next = SearchUtils.navigateMatch(matchedIds, searchIndex, -1) ?: return@IconButton
                                        searchIndex = next
                                        scope.launch {
                                            val target = matchedIds[next]
                                            val index = filteredTimeline.indexOfFirst { item ->
                                                (item as? TimelineItem.Entry)?.message?.id == target
                                            }
                                            if (index >= 0) messageListState.animateScrollToItem(index)
                                        }
                                    },
                                    enabled = matchedIds.size > 1,
                                    modifier = Modifier.size(32.dp),
                                ) {
                                    Icon(
                                        Icons.Filled.KeyboardArrowDown,
                                        contentDescription = stringResource(R.string.chat_cd_search_next),
                                        tint = qy.soft,
                                        modifier = Modifier.size(20.dp),
                                    )
                                }
                            }
                        }
                    }
                }

                // ===== 透明顶栏（浮层：顶部渐隐，不遮挡消息） =====
                Row(
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .fillMaxWidth()
                        .background(
                            Brush.verticalGradient(
                                0f to qy.bg.copy(alpha = 0.98f),
                                0.72f to qy.bg.copy(alpha = 0.82f),
                                1f to qy.bg.copy(alpha = 0f),
                            )
                        )
                        .height(48.dp)
                        .padding(horizontal = 6.dp)
                        .zIndex(1f),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // 返回
                    IconButton(onClick = onBack, modifier = Modifier.size(34.dp)) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.cd_back),
                            tint = qy.soft,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                    // 角色头像（PC 端同步，相对路径拼 baseUrl）
                    val avatarUrl = resolveImageUrl(
                        ui.characterAvatarUrl,
                        container.connectionManager.activeConnection,
                    )
                    if (avatarUrl != null) {
                        var avatarFailed by remember(avatarUrl) { mutableStateOf(false) }
                        if (avatarFailed) {
                            AvatarBubble(name = ui.characterName, avatarUrl = null, size = 28)
                        } else {
                            AsyncImage(
                                model = avatarUrl,
                                contentDescription = ui.characterName,
                                contentScale = ContentScale.Crop,
                                modifier = Modifier
                                    .size(28.dp)
                                    .clip(CircleShape),
                                onError = { avatarFailed = true },
                            )
                        }
                        Spacer(Modifier.width(6.dp))
                    }
                    // 角色名（+ 会话标题小字）
                    Column(Modifier.weight(1f)) {
                        Text(
                            ui.characterName.ifBlank { stringResource(R.string.chat_default_title) },
                            style = MaterialTheme.typography.titleMedium,
                            color = qy.text,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (ui.sessionTitle.isNotBlank()) {
                            Text(
                                ui.sessionTitle,
                                style = MaterialTheme.typography.labelSmall,
                                color = qy.muted,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    // 右上角：搜索/分享/清空 + 设置
                    IconButton(onClick = { showSearch = !showSearch }, modifier = Modifier.size(34.dp)) {
                        Icon(
                            Icons.Filled.Search,
                            contentDescription = stringResource(R.string.action_search),
                            tint = if (showSearch) qy.accent else qy.soft,
                            modifier = Modifier.size(17.dp),
                        )
                    }
                    IconButton(onClick = { shareSession(false) }, modifier = Modifier.size(34.dp)) {
                        Icon(
                            Icons.Filled.Share,
                            contentDescription = stringResource(R.string.chat_share_session),
                            tint = qy.soft,
                            modifier = Modifier.size(17.dp),
                        )
                    }
                    IconButton(
                        onClick = { showClearConfirm = true },
                        modifier = Modifier.size(34.dp),
                    ) {
                        Icon(
                            Icons.Filled.Delete,
                            contentDescription = stringResource(R.string.cd_clear_chat),
                            tint = qy.soft,
                            modifier = Modifier.size(17.dp),
                        )
                    }
                    IconButton(
                        onClick = { showQuickSettings = true },
                        modifier = Modifier.size(34.dp),
                    ) {
                        Icon(
                            Icons.Filled.Settings,
                            contentDescription = stringResource(R.string.cd_chat_settings),
                            tint = qy.soft,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }

                // ===== 底部输入区（浮层：底部渐显，消息从其下穿过） =====
                CompositionLocalProvider(LocalMinimumInteractiveComponentEnforcement provides false) {
                    Column(
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .fillMaxWidth()
                            .imePadding()
                            .onGloballyPositioned { footerHeightPx = it.size.height }
                            .background(
                                Brush.verticalGradient(
                                    listOf(
                                        qy.bg.copy(alpha = 0.78f),
                                        qy.bg.copy(alpha = 0.96f),
                                        qy.bg,
                                    )
                                )
                            ),
                    ) {
                    // 上下文上限预警（对齐 PC 端：≥85% 金，≥100% 红）
                    ui.contextUsage?.let { usage ->
                        if (usage.max > 0 && usage.ratio >= 0.85) {
                            val danger = usage.ratio >= 1.0
                            Surface(
                                color = if (danger) qy.danger.copy(alpha = 0.12f) else qy.warn.copy(alpha = 0.12f),
                                shape = RoundedCornerShape(10.dp),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 16.dp, vertical = 4.dp),
                            ) {
                                Text(
                                    stringResource(R.string.chat_context_used_fmt, usage.pct, usage.used, usage.max) +
                                        stringResource(if (danger) R.string.chat_context_trimming else R.string.chat_context_near_limit),
                                    style = MaterialTheme.typography.labelMedium,
                                    color = if (danger) qy.danger else qy.warn,
                                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                                )
                            }
                        }
                    }

                    ui.error?.let {
                        Text(
                            text = it,
                            color = qy.danger,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(horizontal = 20.dp),
                        )
                    }

                    // TTS 状态条
                    when (ttsState) {
                        TtsPlayer.State.SYNTHESIZING ->
                            StatusPill(stringResource(R.string.chat_tts_synthesizing), isError = false) { container.ttsPlayer.stop() }

                        TtsPlayer.State.PLAYING ->
                            StatusPill(stringResource(R.string.chat_tts_playing), isError = false) { container.ttsPlayer.stop() }

                        TtsPlayer.State.ERROR ->
                            StatusPill(stringResource(R.string.chat_tts_error), isError = true) {}

                        TtsPlayer.State.IDLE -> Unit
                    }

                    // 引用条（左细条 + 软底，对齐内心想法视觉）
                    AnimatedVisibility(visible = replyTo != null, enter = fadeIn(), exit = fadeOut()) {
                        replyTo?.let { target ->
                            Surface(
                                color = qy.accentSoft,
                                shape = RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Row(
                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Box(
                                        Modifier
                                            .width(3.dp)
                                            .height(26.dp)
                                            .clip(RoundedCornerShape(2.dp))
                                            .background(qy.accent)
                                    )
                                    Spacer(Modifier.width(10.dp))
                                    Column(Modifier.weight(1f)) {
                                        val who = if (target.role == Role.user) {
                                            stringResource(R.string.chat_you)
                                        } else {
                                            stringResource(R.string.chat_other)
                                        }
                                        Text(
                                            stringResource(R.string.chat_quote_label_fmt, who),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = qy.accent,
                                        )
                                        Text(
                                            target.content.take(60),
                                            style = MaterialTheme.typography.bodySmall,
                                            color = qy.soft,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                    TextButton(onClick = { vm.setReplyTo(null) }) {
                                        Text(stringResource(R.string.action_cancel), color = qy.muted)
                                    }
                                }
                            }
                        }
                    }

                    QuickReplyBar(replies = ui.quickReplies, onSend = vm::onQuickReplyClick)

                    // 待发送图片预览
                    if (pendingImages.isNotEmpty()) {
                        LazyRow(
                            contentPadding = PaddingValues(horizontal = 16.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            items(pendingImages.size) { index ->
                                Box {
                                    MessageImages(
                                        images = listOf(pendingImages[index]),
                                        onImageClick = {},
                                    )
                                    // 移除按钮
                                    val removeImageLabel = stringResource(R.string.chat_cd_remove_image_fmt, index + 1)
                                    Surface(
                                        onClick = { vm.onImagesChange(pendingImages.filterIndexed { i, _ -> i != index }) },
                                        shape = CircleShape,
                                        color = Color.Black.copy(alpha = 0.6f),
                                        modifier = Modifier
                                            .align(Alignment.TopEnd)
                                            .semantics { contentDescription = removeImageLabel },
                                    ) {
                                        Text(
                                            "×",
                                            color = Color.White,
                                            style = MaterialTheme.typography.labelMedium,
                                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                                        )
                                    }
                                }
                            }
                        }
                    }

                    // AI 输入辅助（续写/润色：极淡小胶囊；E-04 收口后保留直连入口）
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        if (ui.aiProcessing) {
                            Text(
                                stringResource(R.string.chat_error_ai_processing),
                                style = MaterialTheme.typography.labelSmall,
                                color = qy.muted,
                                modifier = Modifier.padding(start = 6.dp, top = 2.dp, bottom = 2.dp),
                            )
                        } else {
                            Surface(
                                onClick = vm::aiContinue,
                                shape = RoundedCornerShape(50),
                                color = qy.accentSoft,
                            ) {
                                Row(
                                    Modifier.padding(horizontal = 8.dp, vertical = 1.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Icon(
                                        Icons.Filled.Edit,
                                        contentDescription = null,
                                        modifier = Modifier.size(10.dp),
                                        tint = qy.accent,
                                    )
                                    Spacer(Modifier.width(3.dp))
                                    Text(
                                        stringResource(R.string.chat_ai_continue),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = qy.accent,
                                    )
                                }
                            }
                            Surface(
                                onClick = vm::aiPolish,
                                enabled = input.isNotBlank(),
                                shape = RoundedCornerShape(50),
                                color = qy.accentSoft,
                            ) {
                                Text(
                                    stringResource(R.string.chat_ai_polish),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = if (input.isNotBlank()) qy.accent else qy.accent.copy(alpha = 0.4f),
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                                )
                            }
                        }
                    }

                        InputBar(
                            value = input,
                            onValueChange = vm::onInputChange,
                            streaming = ui.streaming !is ChatViewModel.Streaming.Idle,
                            onSend = vm::send,
                            onStop = vm::stop,
                            onPickImage = {
                                imagePicker.launch(
                                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                                )
                            },
                            onShowAttachments = { showAttachments = true },
                            hasImage = pendingImages.isNotEmpty(),
                        )
                    }
                }
            }
        }
    }

    // E-04 附件菜单
    if (showAttachments) {
        AttachmentMenu(
            onContinue = {
                showAttachments = false
                vm.aiContinue()
            },
            onPolish = {
                showAttachments = false
                vm.aiPolish()
            },
            onPickImage = {
                showAttachments = false
                imagePicker.launch(
                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                )
            },
            onDismiss = { showAttachments = false },
        )
    }

    menuMessage?.let { message ->
        MessageActionDialog(
            message = message,
            onDismiss = { menuMessage = null },
            onReply = {
                menuMessage = null
                vm.setReplyTo(message)
            },
            onCopy = {
                clipboard.setText(AnnotatedString(ShareUtils.messageToPlainText(message)))
                menuMessage = null
            },
            onCopyMarkdown = {
                clipboard.setText(AnnotatedString(ShareUtils.messageToMarkdown(message)))
                menuMessage = null
            },
            onShare = {
                val text = ShareUtils.messageToPlainText(message)
                val intent = Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, text) }
                context.startActivity(Intent.createChooser(intent, shareMessageLabel))
                menuMessage = null
            },
            onEdit = {
                menuMessage = null
                editingMessage = message
                editText = message.content
            },
            onTranslate = {
                menuMessage = null
                vm.translate(message.id)
            },
            onRegenerate = {
                menuMessage = null
                vm.regenerate(message.id)
            },
            onSpeak = {
                menuMessage = null
                container.ttsPlayer.stop()
                vm.playTts(message.id)
            },
            onBranch = {
                menuMessage = null
                vm.branch(message.id, onOpenBranch)
            },
            onDelete = {
                menuMessage = null
                vm.deleteMessage(message.id)
            },
        )
    }

    editingMessage?.let { message ->
        AlertDialog(
            onDismissRequest = { editingMessage = null },
            containerColor = qy.card,
            title = { Text(stringResource(R.string.title_edit_message), color = qy.text) },
            text = {
                OutlinedTextField(
                    value = editText,
                    onValueChange = { editText = it },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 6,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = qy.text,
                        focusedBorderColor = qy.accent,
                        unfocusedBorderColor = qy.line,
                        focusedContainerColor = qy.bg2,
                        cursorColor = qy.accent,
                    ),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.editMessage(message.id, editText)
                        editingMessage = null
                    },
                    enabled = editText.isNotBlank(),
                ) { Text(stringResource(R.string.action_save), color = qy.accent) }
            },
            dismissButton = {
                TextButton(onClick = { editingMessage = null }) { Text(stringResource(R.string.action_cancel), color = qy.soft) }
            },
        )
    }

    viewer?.let { (images, index) ->
        ImageViewerDialog(
            images = images,
            initialIndex = index,
            onDismiss = { viewer = null },
        )
    }

    // 对话快捷设置面板
    if (showQuickSettings) {
        QuickSettingsPanel(
            sessionId = sessionId,
            characterId = characterId?.takeIf { it.isNotBlank() },
            onDismiss = { showQuickSettings = false },
        )
    }

    // 清空对话确认
    if (showClearConfirm) {
        AlertDialog(
            onDismissRequest = { showClearConfirm = false },
            containerColor = qy.card,
            title = { Text(stringResource(R.string.title_clear_session), color = qy.text) },
            text = {
                Text(
                    stringResource(R.string.chat_clear_confirm_desc),
                    color = qy.soft,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showClearConfirm = false
                    vm.clearChat { onBack() }
                }) { Text(stringResource(R.string.action_delete), color = qy.danger) }
            },
            dismissButton = {
                TextButton(onClick = { showClearConfirm = false }) { Text(stringResource(R.string.action_cancel), color = qy.soft) }
            },
        )
    }
}
