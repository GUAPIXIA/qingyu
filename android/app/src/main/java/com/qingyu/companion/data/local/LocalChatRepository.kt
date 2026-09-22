package com.qingyu.companion.data.local

import com.qingyu.companion.chatcore.LocalChatGenerationUseCase
import com.qingyu.companion.chatcore.LocalMemorySummaryService
import com.qingyu.companion.chatcore.Ulid
import com.qingyu.companion.content.PresetCodec
import com.qingyu.companion.content.QuickReplyCodec
import com.qingyu.companion.content.QuickReplyPolicy
import com.qingyu.companion.model.QuickReplyAction
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.data.ChatRepository
import com.qingyu.companion.local.db.LocalPresetEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.db.LocalUsageRecordEntity
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.model.ActivateResponse
import com.qingyu.companion.model.AnnouncementPage
import com.qingyu.companion.model.Character
import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.ContextUsageDto
import com.qingyu.companion.model.DialogueDirection
import com.qingyu.companion.model.MemoryDto
import com.qingyu.companion.model.MemoryFactDto
import com.qingyu.companion.model.Message
import com.qingyu.companion.model.MessagePage
import com.qingyu.companion.model.MessageUsage
import com.qingyu.companion.model.PendingMessage
import com.qingyu.companion.model.QuickReplyListResponse
import com.qingyu.companion.model.Role
import com.qingyu.companion.model.SessionPreview
import com.qingyu.companion.model.SettingsDto
import com.qingyu.companion.model.TranslateResponse
import com.qingyu.companion.model.UsageRecordDto
import com.qingyu.companion.model.UsageSummary
import com.qingyu.companion.model.UsageSummaryResponse
import com.qingyu.companion.model.VersionInfo
import com.qingyu.companion.network.WsClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * 阶段 4 S4-06：**本地优先** ChatRepository 实现。
 *
 * 定位：让现有 `ChatScreen` / `ChatViewModel` 不改 UI 骨架就能切到本地数据源，
 * 从而满足阶段 4 完成定义「关闭 PC 与 Relay 后，Android 仍能连续多轮聊天」。
 *
 * 与旧 `OnlineChatRepository` 的区别：
 * - 数据源是 `qingyu-local.db`（阶段 3 的权威库），不是 PC 缓存；
 * - 生成由 [LocalChatGenerationUseCase] **本地直连模型**完成，不经 PC/Relay；
 * - 不依赖任何 PC 连接，因此 `connectionState` 恒为「已就绪」语义（用 DISCONNECTED 之外的本地态）。
 *
 * **未迁移的能力**（阶段 5/6/8 范围）：世界书/预设编辑、群聊、翻译、快捷回复、公告、更新检查、用量汇总、
 * 长记忆总结。这些方法一律返回**可行动的空结果**，不抛异常、不静默失败——
 * 阶段 4 §S4-06 要求「错误提示显示可行动作」，因此 UI 拿到空列表/Optional 时不应崩溃。
 */
class LocalChatRepository(
    private val store: LocalStore,
    private val generation: LocalChatGenerationUseCase,
    /**
     * 生成任务作用域：生成独立于调用方（Compose/ViewModel）生命周期。
     * 生产用长生命周期作用域；测试可注入确定性调度器以稳定断言。
     */
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    /**
     * 阶段 4 S4-05：长记忆总结（自动触发）。为 null 时不启用（测试与未配置档案的场景）。
     * 总结在**生成完成之后**异步进行，不阻塞对话，也不影响本轮事件流。
     */
    private val memorySummary: LocalMemorySummaryService? = null,
    /** 自动总结与辅助任务所需的连接档案与密钥（与生成本身同源）。 */
    private val activeProfileAndKey: suspend () -> Pair<ConnectionProfilePublic?, String?> = { null to null },
    /**
     * 辅助任务网关（翻译等一次性补全）。
     * 与主生成分开注入：主生成的流式管线不适用于「取一段文本就结束」的任务，
     * 且辅助任务必须能在不干扰对话状态的前提下独立失败。
     */
    private val auxGateway: com.qingyu.companion.chatcore.ModelGateway? = null,
    /**
     * 会话级请求 id 生成（幂等键；本地场景仅用于事件关联）。
     * **必须保持在参数末位**，调用方以尾随 lambda 传入。
     */
    private val requestIdFactory: () -> String,
) : ChatRepository {

    private val eventFlow = MutableSharedFlow<CompanionEvent>(
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /**
     * 事件流，**无 replay 语义**：没有订阅者时 `tryEmit` 的成功不代表事件会被送达，
     * 事件会被直接丢弃——与在线实现一致（在线实现由 WS 长连接保证订阅先于事件）。
     *
     * 因此调用方必须先订阅再发起生成。UI 在 `init` 中订阅，天然满足；
     * 需要在测试或后台编排中确认订阅已建立时，等待 [eventSubscriberCount] > 0 再发送。
     */
    override val events: Flow<CompanionEvent> = eventFlow.asSharedFlow()

    /**
     * 当前事件流订阅者数量。
     * 用于在开始生成前确认订阅已建立，避免增量事件因「无订阅者」而被丢弃。
     */
    val eventSubscriberCount: StateFlow<Int> get() = eventFlow.subscriptionCount

    /**
     * 本地模式没有远程连接概念。
     * 用 `CONNECTED` 表达「本地数据源可用」，避免 UI 显示「未连接 PC」而误导用户。
     */
    private val localState = MutableStateFlow(WsClient.State.CONNECTED)
    override val connectionState: StateFlow<WsClient.State> = localState.asStateFlow()

    /** 本地模式下不可用的能力，供 UI 显示可行动提示。 */
    private val unsupported = MutableStateFlow<String?>(null)
    val unsupportedNotice: StateFlow<String?> = unsupported.asStateFlow()

    /**
     * 阶段 4 S4-06：数据源与模型连接状态。
     * 由 [refreshDataSourceStatus] 从真实本地库读取；未刷新前保守报告「未配置模型」。
     */
    private val _dataSourceStatus = MutableStateFlow(ChatRepository.DataSourceStatus(local = true))
    override val dataSourceStatus: StateFlow<ChatRepository.DataSourceStatus> = _dataSourceStatus.asStateFlow()

    /**
     * 重新读取本地连接档案并更新 [dataSourceStatus]。
     * 构造时不能挂起，故由 UI 层在进入页面/修改档案后主动刷新。
     */
    suspend fun refreshDataSourceStatus() {
        val profile = runCatching { store.listConnectionProfiles().firstOrNull() }.getOrNull()
        _dataSourceStatus.value = ChatRepository.DataSourceStatus(
            local = true,
            modelConfigured = profile != null && profile.model.isNotBlank(),
            provider = profile?.provider,
            model = profile?.model,
            baseUrl = profile?.baseUrl,
        )
    }

    // ---------------------------------------------------------------- 会话

    override suspend fun listSessions(): List<SessionPreview> =
        store.listSessions().map { it.toPreview() }

    override suspend fun createSession(characterId: String, title: String?, greeting: String?): SessionPreview {
        val id = requestIdFactory()
        val now = System.currentTimeMillis()
        val character = store.getCharacter(characterId)
        store.putSession(
            LocalSessionEntity(
                id = id,
                characterId = characterId,
                title = title ?: character?.name ?: "",
                createdAt = now,
                updatedAt = now,
            ),
        )
        greeting?.takeIf { it.isNotBlank() }?.let { text ->
            val messageId = requestIdFactory()
            store.appendMessage(
                com.qingyu.companion.local.db.LocalMessageEntity(
                    id = messageId,
                    sessionId = id,
                    characterId = characterId,
                    role = "assistant",
                    content = text,
                    logicalTime = now,
                    seq = -1,
                    createdAt = now,
                    updatedAt = now,
                ),
            )
        }
        return store.getSession(id)!!.toPreview(characterName = character?.name ?: "")
    }

    override suspend fun renameSession(sessionId: String, title: String) {
        val session = store.getSession(sessionId) ?: return
        store.putSession(session.copy(title = title, updatedAt = System.currentTimeMillis()))
        eventFlow.tryEmit(CompanionEvent.SessionUpdated(sessionId, "renamed"))
    }

    override suspend fun deleteSession(sessionId: String, characterId: String?) {
        store.deleteSession(sessionId)
        eventFlow.tryEmit(CompanionEvent.SessionUpdated(sessionId, "deleted"))
    }

    override suspend fun clearChat(sessionId: String) {
        store.listMessages(sessionId).forEach { store.deleteMessage(it.id, sessionId) }
        eventFlow.tryEmit(CompanionEvent.SessionUpdated(sessionId, "cleared"))
    }

    // ---------------------------------------------------------------- 消息

    override suspend fun listMessages(sessionId: String, beforeId: String?): MessagePage {
        // 按 seq 排序：FakeLocalStore / Room 的返回顺序不保证稳定，分页游标依赖确定顺序
        val all = store.listMessages(sessionId)
            .sortedBy { it.seq }
            .map { it.toMessage() }
        if (beforeId == null) {
            // 与在线实现一致：默认返回最新一页
            val page = all.takeLast(PAGE_SIZE)
            val nextCursor = if (all.size > PAGE_SIZE) all[all.size - PAGE_SIZE - 1].id else null
            return MessagePage(messages = page, nextCursor = nextCursor)
        }
        val index = all.indexOfFirst { it.id == beforeId }
        if (index <= 0) return MessagePage(messages = emptyList(), nextCursor = null)
        val from = maxOf(0, index - PAGE_SIZE)
        val slice = all.subList(from, index)
        return MessagePage(
            messages = slice.toList(),
            nextCursor = if (from > 0) all[from - 1].id else null,
        )
    }

    /**
     * 发送用户消息：**立即**落盘用户消息并返回，生成在仓库自有作用域内继续。
     *
     * 为什么不能「同步跑完再返回」（本轮实机踩到的真 bug）：
     * `ChatViewModel.doSend` 在 `sendMessageUseCase` **返回之后**才把 UI 置为
     * `Streaming.Generating`；若本实现阻塞到终局，Done 事件会先到、随后又被重置成
     * 「正在生成…」，界面永久卡在生成中，且流式草稿被清空。
     * 同时阶段 4 §1 明确要求「生成任务独立于 Compose 生命周期」——
     * 因此生成由仓库自己的 [scope] 承载，不随调用方（`viewModelScope`）生命周期结束而中断。
     *
     * 契约与在线实现对齐：返回**用户消息**；assistant 结果经 [events] 的 Done/Error 送出。
     */
    override suspend fun sendMessage(
        sessionId: String,
        requestId: String,
        content: String,
        replyToId: String?,
        images: List<String>,
    ): Message {
        val userMessageId = generation.appendUserMessage(sessionId, content)
            ?: throw IllegalStateException("空消息不应进入发送路径")
        val userMessage = store.listMessages(sessionId).firstOrNull { it.id == userMessageId }
            ?: throw IllegalStateException("用户消息未能落盘")

        // 生成任务独立于调用方生命周期；同一 requestId 只允许一个在跑
        activeJobs.remove(requestId)?.cancel()
        activeJobs[requestId] = scope.launch {
            try {
                generation.generate(sessionId, userText = null).collect { delta ->
                    when (delta) {
                        is LocalChatGenerationUseCase.Delta.Started ->
                            setActiveRequest(sessionId, requestId, delta.taskId)

                        is LocalChatGenerationUseCase.Delta.Chunk ->
                            eventFlow.tryEmit(CompanionEvent.Chunk(requestId, sessionId, delta.text))

                        is LocalChatGenerationUseCase.Delta.Finished -> {
                            val outcome = delta.outcome
                            if (outcome.usage.isNotEmpty()) {
                                eventFlow.tryEmit(
                                    CompanionEvent.Usage(
                                        requestId = requestId,
                                        promptTokens = outcome.usage["promptTokens"] ?: 0,
                                        completionTokens = outcome.usage["completionTokens"] ?: 0,
                                        totalTokens = (outcome.usage["promptTokens"] ?: 0) +
                                            (outcome.usage["completionTokens"] ?: 0),
                                    ),
                                )
                            }
                            // S4-04 用量诊断：**必须落库**，否则用量页永远显示 0
                            // （此前 `recordUsage` 没有任何生产调用者）。
                            // 只记有正文的轮次：失败/取消没有产出，记进去会污染统计。
                            if (outcome.persisted && outcome.outputChars > 0) {
                                runCatching {
                                    store.recordUsage(
                                        LocalUsageRecordEntity(
                                            id = "$requestId-usage",
                                            sessionId = sessionId,
                                            messageId = outcome.assistantMessageId,
                                            provider = "",
                                            model = "",
                                            promptTokens = outcome.usage["promptTokens"] ?: 0,
                                            completionTokens = outcome.usage["completionTokens"] ?: 0,
                                            createdAt = System.currentTimeMillis(),
                                            taskType = "main",
                                            inputChars = outcome.promptChars,
                                            outputChars = outcome.outputChars,
                                        ),
                                    )
                                }
                            }
                            if (outcome.persisted && outcome.assistantMessageId != null) {
                                val message = store.listMessages(sessionId)
                                    .firstOrNull { it.id == outcome.assistantMessageId }
                                if (message != null) {
                                    eventFlow.tryEmit(CompanionEvent.Done(requestId, sessionId, message.toMessage()))
                                }
                                // S4-05：本轮助手消息已落盘 → 后台尝试自动长记忆总结。
                                // 不 await、不上报错误：总结失败绝不能影响对话可用性；
                                // 是否真正触发由 ChatMemorySummaryPolicy 按间隔与模式决定。
                                scheduleMemorySummary(sessionId)
                                // 世界书近因窗口：本轮触发键落下，下一轮才能拿到近因加权（v3）
                                runCatching { appendSessionRecentTriggered(sessionId, outcome.lorebookTriggeredEntryKeys) }
                            } else if (outcome.status == "failed" || outcome.status == "cancelled") {
                                eventFlow.tryEmit(
                                    CompanionEvent.Error(
                                        requestId,
                                        sessionId,
                                        outcome.noticeText ?: "生成失败",
                                    ),
                                )
                            }
                        }
                    }
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                // 用户停止生成：保留已见正文（由 use case 的终局处理），不再上报错误
                throw e
            } catch (e: Throwable) {
                eventFlow.tryEmit(
                    CompanionEvent.Error(requestId, sessionId, e.message ?: "生成失败"),
                )
            } finally {
                clearActiveRequest()
            }
        }

        return userMessage.toMessage()
    }

    /**
     * S4-05：后台尝试自动长记忆总结。
     *
     * 刻意「发起即忘」：总结是后台派生工作，失败只记录日志，
     * 不得影响对话可用性，也不得让异常冒泡到生成任务里。
     */
    private fun scheduleMemorySummary(sessionId: String) {
        val service = memorySummary ?: return
        scope.launch {
            runCatching {
                val (profile, apiKey) = activeProfileAndKey()
                if (profile == null) return@launch
                // 间隔取用户在本会话上的配置（默认 10）；开关与模式由策略统一判定
                val session = store.getSession(sessionId)
                service.summarize(
                    scope = scope,
                    sessionId = sessionId,
                    automatic = true,
                    profile = profile,
                    apiKey = apiKey,
                    model = profile.model,
                    autoMemoryInterval = session?.autoMemoryInterval
                        ?: com.qingyu.companion.chatcore.ChatMemorySummaryPolicy.DEFAULT_AUTO_MEMORY_INTERVAL,
                )
            }
        }
    }

    /** 本地生成的取消：取消该 requestId 的生成任务（阶段 4：生成不依赖 UI 生命周期）。 */    override suspend fun stopGeneration(requestId: String) {
        activeJobs.remove(requestId)?.cancel()
    }

    override suspend fun editMessage(sessionId: String, messageId: String, content: String): Message {
        val existing = store.listMessages(sessionId).firstOrNull { it.id == messageId }
            ?: throw IllegalArgumentException("消息不存在：$messageId")
        store.updateMessage(
            existing.copy(content = content, updatedAt = System.currentTimeMillis()),
        )
        // S4-05：编辑历史会让派生记忆失去依据 → 推进修订号使其过期。
        // 注意：这里不直接删除记忆——旧摘要仍可用于衔接，失效判定交由下次提交的版本比较。
        store.bumpMemoryHistoryRevision(sessionId)
        return existing.copy(content = content).toMessage()
    }

    override suspend fun deleteMessage(sessionId: String, messageId: String) {
        store.deleteMessage(messageId, sessionId)
        // S4-05：删除历史同样使派生记忆过期
        store.bumpMemoryHistoryRevision(sessionId)
    }

    /**
     * 消息候选切换 / 重生成（S4-04）。
     *
     * 与 PC 的 `chatService.swipe` 逐条对齐：
     * - `direction == 0`：**重生成并把新候选追加到同一条消息**（原消息 id 不变）；
     * - `direction != 0`：在已有候选之间循环切换，**不调用模型**。
     *
     * 此前的实现是「新建一条消息」——消息数量因此与 PC 不同，
     * 而消息数量会进入导出、分页与上下文预算。候选语义已抽到共享模块并 fixture 锁定。
     */
    override suspend fun swipe(sessionId: String, messageId: String, direction: Int): Message {
        val target = store.listMessages(sessionId).firstOrNull { it.id == messageId }
            ?: throw IllegalArgumentException("目标消息不存在：$messageId")
        if (target.role != "assistant") throw IllegalArgumentException("目标消息不可切换：$messageId")

        if (direction != 0) {
            // 切换候选：纯本地操作，不产生模型调用
            val update = com.qingyu.companion.chatcore.ChatSwipeCandidates.rotateSwipe(
                com.qingyu.companion.chatcore.ChatSwipeCandidates.Target(
                    content = target.content,
                    swipes = parseSwipes(target.swipesJson),
                    swipeIndex = target.swipeIndex,
                ),
                direction,
            )
            val updated = target.copy(
                content = update.content,
                swipesJson = com.qingyu.companion.chatcore.ChatJsonCodec.encodeStringArray(update.swipes),
                swipeIndex = update.swipeIndex,
                updatedAt = System.currentTimeMillis(),
            )
            store.updateMessage(updated)
            return updated.toMessage()
        }

        // direction == 0：重新生成，结果追加为候选
        // 收集整个流（而不是只取第一个事件）：终局在最后，且流必须被消费才会真正执行
        val deltas = generation.generate(sessionId, userText = null, persist = false).toList()
        val outcome = deltas.lastOrNull { it is LocalChatGenerationUseCase.Delta.Finished }
            ?.let { (it as LocalChatGenerationUseCase.Delta.Finished).outcome }
            ?: throw IllegalStateException("重生成未产生结果")
        val newContent = outcome.content
        if (newContent.isEmpty()) {
            throw IllegalStateException("模型未返回可用内容，请重试")
        }
        val update = com.qingyu.companion.chatcore.ChatSwipeCandidates.appendRegeneratedCandidate(
            com.qingyu.companion.chatcore.ChatSwipeCandidates.Target(
                content = target.content,
                swipes = parseSwipes(target.swipesJson),
                swipeIndex = target.swipeIndex,
            ),
            newContent,
        )
        val updated = target.copy(
            content = update.content,
            swipesJson = com.qingyu.companion.chatcore.ChatJsonCodec.encodeStringArray(update.swipes),
            swipeIndex = update.swipeIndex,
            generationStatus = null,
            generationNotice = outcome.noticeText,
            updatedAt = System.currentTimeMillis(),
        )
        store.updateMessage(updated)
        return updated.toMessage()
    }

    /** `swipes_json` 解析：容忍 null / 空串 / 非法 JSON（null 表示「尚无候选数组」）。 */
    private fun parseSwipes(json: String?): List<String>? =
        com.qingyu.companion.chatcore.ChatJsonCodec.decodeStringArray(json)

    override suspend fun branchSession(sessionId: String, messageId: String): SessionPreview {
        val source = store.listMessages(sessionId)
        val cutIndex = source.indexOfFirst { it.id == messageId }
        if (cutIndex < 0) throw IllegalArgumentException("消息不存在：$messageId")
        val origin = store.getSession(sessionId) ?: throw IllegalArgumentException("会话不存在：$sessionId")
        val newId = requestIdFactory()
        val now = System.currentTimeMillis()
        store.putSession(
            LocalSessionEntity(
                id = newId,
                characterId = origin.characterId,
                groupId = origin.groupId,
                title = origin.title,
                createdAt = now,
                updatedAt = now,
            ),
        )
        source.take(cutIndex + 1).forEach { message ->
            store.appendMessage(
                message.copy(
                    id = requestIdFactory(),
                    sessionId = newId,
                    seq = -1,
                    createdAt = now,
                    updatedAt = now,
                ),
            )
        }
        return store.getSession(newId)!!.toPreview()
    }

    // ---------------------------------------------------------------- 角色

    override suspend fun listCharacters(): List<Character> =
        store.listCharacters().map { it.toCharacter() }

    override suspend fun activateCharacter(characterId: String): ActivateResponse {
        val existing = store.listSessions().firstOrNull { it.characterId == characterId }
        val session = existing ?: return run {
            val created = createSession(characterId, null, null)
            ActivateResponse(ok = true, sessionId = created.id)
        }
        return ActivateResponse(ok = true, sessionId = session.id)
    }

    // ---------------------------------------------------------------- 本地缓存回退（同源，直接复用本地库）

    override suspend fun listCachedSessions(): List<SessionPreview> = listSessions()

    override suspend fun listCachedMessages(sessionId: String): List<Message> =
        store.listMessages(sessionId).map { it.toMessage() }

    override fun observeOutbox(sessionId: String): Flow<List<PendingMessage>> =
        kotlinx.coroutines.flow.flowOf(emptyList())

    override suspend fun clearLocalCache() {
        // 本地库就是权威数据源，清缓存不得删除用户数据；仅清空事件缓冲
    }

    override suspend fun wipeLocalData() {
        // 「退出时清除」在本地权威库语义下会删除用户全部数据，必须由用户显式确认（阶段 9 迁移流程负责）
        unsupported.value = "本地模式不提供一键清除：请在设置中逐项删除，或使用备份恢复流程"
    }

    // ---------------------------------------------------------------- 未迁移能力（返回可行动的空结果，不抛异常）

    private var activeRequestId: String? = null

    /** 进行中的生成任务：requestId → Job，供 [stopGeneration] 取消。 */
    private val activeJobs = LinkedHashMap<String, kotlinx.coroutines.Job>()

    private fun setActiveRequest(sessionId: String, requestId: String, taskId: String) {
        activeRequestId = requestId
    }

    private fun clearActiveRequest() {
        activeRequestId = null
    }

    /** AI 辅助读取的近期消息条数（续写依赖上下文，但不需要整段历史）。 */
    private val aiAssistRecentMessages = 12

    /** 会话级叙事模式白名单（与装配器/ChatNarrativeMode 的取值一致）。 */
    private val NARRATIVE_MODES = setOf("immersive", "omniscient")

    /** 会话级篇幅模式白名单。 */
    private val RESPONSE_LENGTH_MODES = setOf("auto", "brief", "balanced", "detailed")

    /** 方向生成读取的最近对话条数。 */
    private val directionsRecentMessages = 8

    private fun <T> notMigrated(capability: String, fallback: T): T {
        unsupported.value = "$capability 尚未在本地模式提供（阶段 5/6 迁移）"
        return fallback
    }

    /**
     * 快捷设置面板的数据来源（S4-06：只读本地）。
     *
     * 此前这些方法一律走 `notMigrated` → 面板在本地模式下**显示为空且保存必然失败**，
     * 属于「界面在、功能不在」。现在改为读写本地权威表：
     * - 世界书/预设列表取自 `local_lorebooks` / `local_presets`；
     * - 会话级绑定取自 `local_sessions.lorebook_ids_json` / `preset_id`；
     * - 全局设置取自本地公共设置行。
     * 不再依赖 PC 端接口（阶段 5 会补齐更完整的内容管理）。
     */
    override suspend fun getSettings(): SettingsDto {
        // 公共设置是 (section, key) 一行，同一 section 会有多行（user.name / user.persona…），
        // 因此必须按「段+键」定位，不能按段取唯一行。
        val rows = store.listPublicSettings().associateBy { it.section to it.key }
        fun read(section: String, key: String): String? {
            val row = rows[section to key] ?: return null
            return runCatching { org.json.JSONObject(row.valueJson).optString(key) }.getOrNull()?.takeIf { it.isNotEmpty() }
        }
        return SettingsDto(
            userName = read("user", "name") ?: SettingsDto().userName,
            userDescription = read("user", "description") ?: "",
            userPersona = read("user", "persona") ?: "",
            activeModel = read("chat", "activeModel") ?: "",
            defaultNarrativeMode = read("chat", "defaultNarrativeMode") ?: SettingsDto().defaultNarrativeMode,
            omniscientNarrativeRules = read("chat", "omniscientNarrativeRules") ?: "",
        )
    }

    override suspend fun updateSettings(patch: Map<String, Any?>) {
        // 只写本地设置：逐项落到公共设置行，绝不下发到 PC
        // （LocalChatRepository 本身不持有任何远程依赖，"只写本地" 由结构保证）。
        for ((key, value) in patch) {
            val (section, name) = settingKeyLocation(key)
            store.putPublicSetting(section, name, org.json.JSONObject().put(name, value).toString())
        }
    }

    /** 设置键 → (section, 列内键名)。未登记的键一律落到 `chat` 段。 */
    private fun settingKeyLocation(key: String): Pair<String, String> = when (key) {
        "userName" -> "user" to "name"
        "userDescription" -> "user" to "description"
        "userPersona" -> "user" to "persona"
        else -> "chat" to key
    }

    override suspend fun listLorebooks(): List<com.qingyu.companion.model.LorebookDto> =
        store.listLorebooks().map { entity ->
            com.qingyu.companion.model.LorebookDto(
                id = entity.id,
                name = entity.name,
                description = "",
                enabled = true,
                scanDepth = entity.scanDepth ?: 0,
                entryCount = countLorebookEntries(entity.canonicalJson),
            )
        }

    override suspend fun listPresets(): List<com.qingyu.companion.model.PresetDto> =
        store.listPresets().map { entity ->
            com.qingyu.companion.model.PresetDto(
                id = entity.id,
                name = entity.name,
                description = "",
                isBuiltin = false,
                group = "",
                temperature = 1.0,
                topP = 1.0,
                maxTokens = 1024,
                maxContext = 4096,
                contextTemplate = "",
            )
        }

    override suspend fun getSessionLorebooks(sessionId: String): List<String> =
        store.getSession(sessionId)?.let { parseIdList(it.lorebookIdsJson) } ?: emptyList()

    override suspend fun getSessionNarrativeMode(sessionId: String): String =
        store.getSession(sessionId)?.narrativeMode.orEmpty()

    /**
     * 会话级叙事模式 / 篇幅模式（阶段 4 S4-04，本地库 v3）。
     *
     * 这是这两个列的**唯一写入方**：没有它，v3 迁移加出来的列永远是默认值，
     * 用户也就无法切换「代入式 / 全局叙事」——列存在只是必要条件，闭环才算接通。
     * 取值做白名单校验：非法值一律拒绝，避免把脏值写进库再被装配器当成有效模式。
     */
    override suspend fun patchSessionRuntimeState(
        sessionId: String,
        narrativeMode: String?,
        responseLengthMode: String?,
    ) {
        if (narrativeMode != null && narrativeMode !in NARRATIVE_MODES) {
            throw IllegalArgumentException("非法叙事模式：$narrativeMode")
        }
        if (responseLengthMode != null && responseLengthMode !in RESPONSE_LENGTH_MODES) {
            throw IllegalArgumentException("非法篇幅模式：$responseLengthMode")
        }
        val session = store.getSession(sessionId) ?: return
        store.putSession(
            session.copy(
                narrativeMode = narrativeMode ?: session.narrativeMode,
                responseLengthMode = responseLengthMode ?: session.responseLengthMode,
                updatedAt = System.currentTimeMillis(),
            ),
        )
    }

    override suspend fun setSessionLorebooks(sessionId: String, lorebookIds: List<String>) {
        val session = store.getSession(sessionId) ?: return
        store.putSession(
            session.copy(
                lorebookIdsJson = org.json.JSONArray(lorebookIds).toString(),
                updatedAt = System.currentTimeMillis(),
            ),
        )
    }

    /**
     * 追加本轮世界书触发键到会话近因窗口（阶段 4 S4-04/S4-06，v3）。
     *
     * 调用点在**生成成功之后**：运行时的 recency 加权依赖上一轮触发记录，
     * 不落盘则每轮都从零开始（同一批条目永远拿不到近因加分）。
     * 窗口长度与运行时一致（[ChatLorebookScoring.RECENCY_WINDOW]），避免写入与读取口径漂移。
     */
    suspend fun appendSessionRecentTriggered(sessionId: String, keys: List<String>) {
        if (keys.isEmpty()) return
        val session = store.getSession(sessionId) ?: return
        val previous = runCatching {
            val rounds = org.json.JSONArray(session.recentTriggeredIdsJson)
            (0 until rounds.length()).mapNotNull { index ->
                rounds.optJSONArray(index)?.let { round ->
                    (0 until round.length()).map { round.optString(it) }.filter { it.isNotEmpty() }
                }
            }
        }.getOrDefault(emptyList())
        val next = com.qingyu.companion.chatcore.ChatLorebookScoring.appendRecentTriggeredIds(previous, keys)
        store.putSession(
            session.copy(
                recentTriggeredIdsJson = org.json.JSONArray(next.map { round -> org.json.JSONArray(round) }).toString(),
                updatedAt = System.currentTimeMillis(),
            ),
        )
    }

    override suspend fun getSessionPreset(sessionId: String): String? =
        store.getSession(sessionId)?.presetId?.takeIf { it.isNotEmpty() }

    override suspend fun setSessionPreset(sessionId: String, presetId: String?) {
        val session = store.getSession(sessionId) ?: return
        store.putSession(
            session.copy(presetId = presetId, updatedAt = System.currentTimeMillis()),
        )
    }

    /** `lorebook_ids_json` 解析：容忍空串与非法 JSON（返回空列表而非抛错）。 */
    private fun parseIdList(json: String): List<String> = runCatching {
        val array = org.json.JSONArray(json)
        (0 until array.length()).map { array.optString(it) }.filter { it.isNotEmpty() }
    }.getOrDefault(emptyList())

    /** canonical v2 文档里的条目数（仅用于面板展示）。 */
    private fun countLorebookEntries(canonicalJson: String): Int = runCatching {
        org.json.JSONObject(canonicalJson).optJSONArray("entries")?.length() ?: 0
    }.getOrDefault(0)

    override suspend fun listModels(): List<String> =
        store.listConnectionProfiles().map { it.model }.filter { it.isNotBlank() }.distinct()

    /**
     * 输入框 AI 辅助（S4-04）：`continue` = 续写用户输入，`polish` = 润色用户输入。
     *
     * 语义与 PC 的 `aiInputHelper` 一致（纯逻辑已由 fixture 锁定）：
     * - 续写用最近对话 + 系统提示构造上下文，**历史中的 `<thought>` 必须剥离**
     *   （否则模型模仿角色视角，输出随后被整段清空）；
     * - 结果经 `parseContinueResult` 校验后再做长度评估；
     *   长度不合格时并行一次修复请求，仍不合格则**保留用户原输入并抛错**，不写回半成品。
     *
     * 返回的是**要追加到输入框的新内容**（调用方负责与原输入拼接）。
     */
    override suspend fun aiAssist(sessionId: String, type: String, content: String?): String {
        val (profile, apiKey) = activeProfileAndKey()
        if (profile == null) throw IllegalStateException("未配置可用的 API 连接，无法使用 AI 辅助")
        val client = auxGateway ?: throw IllegalStateException("辅助生成未接线，无法使用 AI 辅助")
        val session = store.getSession(sessionId)
        val character = session?.characterId?.let { store.getCharacter(it) }
        val charName = character?.name.orEmpty().ifEmpty { "角色" }
        val userName = getSettings().userName.ifEmpty { com.qingyu.companion.chatcore.ChatContextBuilder.DEFAULT_USER_NAME }
        val model = profile.model

        // 近期对话（从旧到新），续写依赖上下文，不能在调用层压缩成首尾两条
        val recent = store.listMessages(sessionId)
            .filter { it.role == "user" || it.role == "assistant" }
            .takeLast(aiAssistRecentMessages)
            .map { com.qingyu.companion.chatcore.ChatAiInputHelper.ContinueContextMessage(it.role, it.content) }

        val original = content.orEmpty()
        val hasInput = original.isNotBlank()
        val messages = if (type == "polish") {
            // 润色：只对用户已写内容做改写，不需要剧情上下文
            listOf(
                com.qingyu.companion.chatcore.ChatAiInputHelper.ContinueContextMessage(
                    "system",
                    "你是文本润色助手。请在不改变原意与信息量的前提下润色用户输入，使其更自然、通顺、符合角色扮演对话口吻。" +
                        "只输出润色后的正文，放在一组 <continuation>...</continuation> 标签内，标签外不要输出任何内容。",
                ),
                com.qingyu.companion.chatcore.ChatAiInputHelper.ContinueContextMessage("user", original),
            )
        } else {
            com.qingyu.companion.chatcore.ChatAiInputHelper.buildContinueContext(
                com.qingyu.companion.chatcore.ChatAiInputHelper.ContinueContextInput(
                    charName = charName,
                    charDescription = character?.description.orEmpty(),
                    charScenario = character?.scenario.orEmpty(),
                    userName = userName,
                    recentMessages = recent,
                    originalInput = original,
                    hasInput = hasInput,
                ),
            )
        }

        val temperature = com.qingyu.companion.chatcore.ChatContinueIntensity.temperatureOf(
            com.qingyu.companion.chatcore.ChatContinueIntensity.DEFAULT_INTENSITY,
        )
        val length = com.qingyu.companion.chatcore.ChatContinueIntensity.DEFAULT_LENGTH
        val plan = com.qingyu.companion.chatcore.ChatGenerationTaskBudget.resolveGenerationTaskBudget(
            com.qingyu.companion.chatcore.ChatGenerationTaskBudget.Input(
                task = "generic",
                model = model,
                expectedBodyChars = com.qingyu.companion.chatcore.ChatContinueIntensity.paramsOf(length).maxChars,
            ),
        )

        suspend fun request(msgs: List<com.qingyu.companion.chatcore.ChatAiInputHelper.ContinueContextMessage>): String {
            // 本函数已是 suspend：直接 collect，不用 runBlocking（后者会阻塞线程且可能死锁）
            val events = client.stream(
                profile.provider,
                profile,
                com.qingyu.companion.network.models.ModelChatRequest(
                    model = model,
                    messages = msgs.map {
                        com.qingyu.companion.network.models.ChatMessageDto(it.role, it.content)
                    },
                    temperature = temperature,
                    maxTokens = plan.request.requestMaxTokens,
                    stream = false,
                ),
                apiKey,
            ).first.toList()
            events.filterIsInstance<com.qingyu.companion.network.models.ModelStreamEvent.Failure>().firstOrNull()
                ?.let { throw IllegalStateException(it.error.message) }
            return events.filterIsInstance<com.qingyu.companion.network.models.ModelStreamEvent.Chunk>()
                .joinToString("") { it.value.deltaText }
        }

        var raw = request(messages)
        var parsed = com.qingyu.companion.chatcore.ChatAiInputHelper.parseContinueResult(
            raw,
            userName,
            charName,
            "immersive",
        )
        if (parsed.isEmpty() &&
            com.qingyu.companion.chatcore.ChatAiInputHelper.shouldRetryContinueFormat(raw)
        ) {
            // 归因是「格式/内容不合格」而非「没有正文」→ 重试一次格式
            raw = request(messages)
            parsed = com.qingyu.companion.chatcore.ChatAiInputHelper.parseContinueResult(
                raw,
                userName,
                charName,
                "immersive",
            )
        }
        if (parsed.isEmpty()) {
            val kind = com.qingyu.companion.chatcore.ChatAiInputHelper.classifyContinueFailure(raw)
            throw IllegalStateException(
                when (kind) {
                    com.qingyu.companion.chatcore.ChatAiInputHelper.FAILURE_EMPTY ->
                        "模型没有返回正文（推理内容可能占满了输出预算），请重试"
                    com.qingyu.companion.chatcore.ChatAiInputHelper.FAILURE_TRUNCATED ->
                        "模型输出被截断，请重试"
                    else -> "模型返回的内容不是可用的中文正文，请重试"
                },
            )
        }

        // 长度评估：合格直接用；偏长可句边界收束；否则修复一次，仍不合格则不写回半成品
        val evaluation = com.qingyu.companion.chatcore.ChatAiInputHelper.evaluateContinueLength(parsed, length)
        return when (evaluation.action) {
            com.qingyu.companion.chatcore.ChatAiInputHelper.ACTION_ACCEPT -> parsed
            com.qingyu.companion.chatcore.ChatAiInputHelper.ACTION_TRIM ->
                evaluation.trimmedText ?: parsed
            else -> {
                val instruction = com.qingyu.companion.chatcore.ChatAiInputHelper.buildLengthRepairInstruction(
                    evaluation.action,
                    length,
                    evaluation.chars,
                    evaluation.truncated,
                )
                val repairMessages = messages + com.qingyu.companion.chatcore.ChatAiInputHelper.ContinueContextMessage(
                    "system",
                    instruction,
                )
                val repaired = com.qingyu.companion.chatcore.ChatAiInputHelper.parseContinueResult(
                    request(repairMessages),
                    userName,
                    charName,
                    "immersive",
                )
                if (repaired.isNotEmpty() &&
                    com.qingyu.companion.chatcore.ChatAiInputHelper.isAcceptableAfterLengthRepair(repaired, length)
                ) {
                    repaired
                } else {
                    throw IllegalStateException("续写长度未达到要求，请重试（已保留你的输入）")
                }
            }
        }
    }

    /**
     * 阶段 5 S5-03：本地改预设采样参数。
     *
     * 返回**生效的预设 id**：内建预设不可原地改（它属于安装包，改了下一次升级就被覆盖），
     * 因此复制成用户预设并返回新 id，与 PC 的「内置预设保存为副本时变化」一致。
     *
     * 写入前必经 `PresetCodec.normalize`：预设正文整体就是 `preset` 实体的同步 payload，
     * 少一个键或钳位时机不同，两端就会算出两个 contentHash。
     */
    override suspend fun updatePreset(
        presetId: String,
        temperature: Double?,
        topP: Double?,
        maxTokens: Int?,
    ): String? {
        val existing = store.getPreset(presetId) ?: return null
        val merged = LinkedHashMap(PresetCodec.bodyOf(existing.bodyJson)).apply {
            temperature?.let { put("temperature", it) }
            topP?.let { put("topP", it) }
            maxTokens?.let { put("maxTokens", it) }
            put("id", existing.id)
            put("name", existing.name)
            put("description", existing.description)
            put("isBuiltin", existing.isBuiltin)
        }
        val normalized = PresetCodec.normalize(merged)

        if (!existing.isBuiltin) {
            store.putPreset(existing.copy(bodyJson = PresetCodec.bodyJsonOf(normalized), description = normalized["description"] as? String ?: existing.description))
            return existing.id
        }

        val copyId = Ulid.newId()
        val now = System.currentTimeMillis()
        store.putPreset(
            LocalPresetEntity(
                id = copyId,
                name = existing.name,
                bodyJson = PresetCodec.bodyJsonOf(normalized + ("id" to copyId) + ("isBuiltin" to false)),
                isDefault = false,
                createdAt = now,
                updatedAt = now,
                isBuiltin = false,
                sortIndex = store.listPresets().size,
            ),
        )
        return copyId
    }

    override suspend fun getSessionMemory(sessionId: String, characterId: String?): MemoryDto {
        val state = store.getMemoryState(sessionId)
        val session = store.getSession(sessionId)
        return MemoryDto(
            // 开关取自会话行：即使还没有生成过内容，「已开启」也应当被如实反映
            memoryEnabled = session?.memoryEnabled ?: (state != null),
            memoryMode = session?.memoryMode ?: "manual",
            autoMemoryInterval = session?.autoMemoryInterval ?: 0,
            memory = state?.summary ?: "",
            memoryUpdatedAt = state?.updatedAt ?: 0L,
        )
    }

    override suspend fun patchSessionMemory(
        sessionId: String,
        memoryEnabled: Boolean?,
        memoryMode: String?,
        autoMemoryInterval: Int?,
        characterId: String?,
    ) {
        // 只写本地会话行（面板的开关/模式/间隔都在这里持久化）
        val session = store.getSession(sessionId) ?: return
        store.putSession(
            session.copy(
                memoryEnabled = memoryEnabled ?: session.memoryEnabled,
                memoryMode = memoryMode?.takeIf { it == "auto" || it == "manual" } ?: session.memoryMode,
                autoMemoryInterval = autoMemoryInterval?.takeIf { it > 0 } ?: session.autoMemoryInterval,
                updatedAt = System.currentTimeMillis(),
            ),
        )
    }

    /**
     * 手动触发一次长记忆总结（S4-05）。
     *
     * 与自动触发共用同一个 [com.qingyu.companion.chatcore.LocalMemorySummaryService]，
     * 因此 CAS、游标推进与事实应用语义完全一致；区别只在于不受间隔与模式约束。
     */
    override suspend fun summarizeMemory(
        sessionId: String,
        characterId: String?,
    ): Pair<String, List<MemoryFactDto>> {
        val service = memorySummary ?: return "" to emptyList()
        val (profile, apiKey) = activeProfileAndKey()
        if (profile == null) return "" to emptyList()
        val session = store.getSession(sessionId) ?: return "" to emptyList()
        val outcome = service.summarize(
            scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.currentCoroutineContext()),
            sessionId = sessionId,
            automatic = false,
            profile = profile,
            apiKey = apiKey,
            model = profile.model,
            autoMemoryInterval = session.autoMemoryInterval,
        )
        if (outcome !is com.qingyu.companion.chatcore.LocalMemorySummaryService.Outcome.Summarized) {
            return "" to emptyList()
        }
        val state = store.getMemoryState(sessionId)
        val facts = parseStoredFacts(state?.factsJson).map { fact ->
            MemoryFactDto(
                id = fact.id,
                subject = fact.subject,
                predicate = fact.predicate,
                value = fact.value,
            )
        }
        return outcome.summary to facts
    }

    /** `facts_json` → 结构化事实（仅结构化项；文本事实不进入面板列表）。 */
    private fun parseStoredFacts(
        json: String?,
    ): List<com.qingyu.companion.chatcore.ChatMemoryFacts.FactRecord.Structured> {
        if (json.isNullOrBlank()) return emptyList()
        return runCatching {
            val array = org.json.JSONArray(json)
            (0 until array.length()).mapNotNull { index ->
                (array.opt(index) as? org.json.JSONObject)
                    ?.let { com.qingyu.companion.chatcore.ChatMemoryFacts.factRecordFromJson(it) }
                    ?.let { it as? com.qingyu.companion.chatcore.ChatMemoryFacts.FactRecord.Structured }
            }
        }.getOrDefault(emptyList())
    }

    /** 上下文用量：用本地已对齐的启发式估算（阶段 4 S4-02 口径）。 */
    override suspend fun getContextUsage(sessionId: String, characterId: String?): ContextUsageDto {
        val messages = store.listMessages(sessionId)
        val used = messages.sumOf { com.qingyu.companion.chatcore.ChatTokenCounter.estimateTokens(it.content) }.toLong()
        val limit = CONTEXT_LIMIT_TOKENS.toLong()
        val ratio = if (limit <= 0) 0.0 else used.toDouble() / limit
        return ContextUsageDto(
            used = used,
            max = limit,
            ratio = ratio,
            pct = kotlin.math.round(ratio * 100).toInt(),
        )
    }

    /**
     * 对话「下一步方向」（A5）：本地直连生成并**经完整校验**后返回。
     *
     * 校验是全有或全无（`ChatDialogueDirections.parse`）：只渲染部分方向会让用户
     * 以为其余方向不存在，而不是知道生成失败。首个响应不合法时按协议重试一次。
     *
     * 方向**不落盘**：它们依附于某条助手回复，属于可再生成的派生 UI 数据
     * （与 PC 一致，避免把派生数据写进消息实体）。
     */
    override suspend fun regenerateDirections(sessionId: String, messageId: String): List<DialogueDirection> {
        val (profile, apiKey) = activeProfileAndKey()
        if (profile == null) throw IllegalStateException("未配置可用的 API 连接，无法生成方向")
        val client = auxGateway ?: throw IllegalStateException("辅助生成未接线，无法生成方向")

        val messages = store.listMessages(sessionId)
        val target = messages.firstOrNull { it.id == messageId }
            ?: throw IllegalArgumentException("目标消息不存在：$messageId")
        val session = store.getSession(sessionId)
        val character = session?.characterId?.let { store.getCharacter(it) }
        val charName = character?.name.orEmpty().ifEmpty { "角色" }
        val settings = getSettings()
        val userName = settings.userName.ifEmpty { com.qingyu.companion.chatcore.ChatContextBuilder.DEFAULT_USER_NAME }

        val recent = messages
            .filter { (it.role == "user" || it.role == "assistant") && it.content.isNotBlank() && it.id != messageId }
            .takeLast(directionsRecentMessages)
            .map {
                com.qingyu.companion.chatcore.ChatDialogueDirections.SpeakerMessage(
                    speaker = if (it.role == "user") userName else charName,
                    content = com.qingyu.companion.chatcore.ChatMessagePostProcess.stripThought(it.content),
                )
            }

        val input = com.qingyu.companion.chatcore.ChatDialogueDirections.GenerationInput(
            userName = userName,
            charName = charName,
            characterDescription = character?.description.orEmpty(),
            narrativeMode = com.qingyu.companion.chatcore.ChatNarrativeMode.resolveNarrativeMode(
                settings.defaultNarrativeMode,
            ),
            recentMessages = recent,
            latestReply = com.qingyu.companion.chatcore.ChatMessagePostProcess.stripThought(target.content),
        )
        val request = listOf(
            com.qingyu.companion.network.models.ChatMessageDto(
                "system",
                com.qingyu.companion.chatcore.ChatDialogueDirections.buildSystemPrompt(input),
            ),
            com.qingyu.companion.network.models.ChatMessageDto(
                "user",
                com.qingyu.companion.chatcore.ChatDialogueDirections.buildUserPrompt(input),
            ),
        )
        val plan = com.qingyu.companion.chatcore.ChatGenerationTaskBudget.resolveGenerationTaskBudget(
            com.qingyu.companion.chatcore.ChatGenerationTaskBudget.Input(task = "direction", model = profile.model),
        )

        suspend fun once(): List<DialogueDirection> {
            val events = client.stream(
                profile.provider,
                profile,
                com.qingyu.companion.network.models.ModelChatRequest(
                    model = profile.model,
                    messages = request,
                    temperature = com.qingyu.companion.chatcore.ChatDialogueDirections.TEMPERATURE,
                    maxTokens = plan.request.requestMaxTokens,
                    stream = false,
                ),
                apiKey,
            ).first.toList()
            events.filterIsInstance<com.qingyu.companion.network.models.ModelStreamEvent.Failure>().firstOrNull()
                ?.let { throw IllegalStateException(it.error.message) }
            val raw = events.filterIsInstance<com.qingyu.companion.network.models.ModelStreamEvent.Chunk>()
                .joinToString("") { it.value.deltaText }
            return com.qingyu.companion.chatcore.ChatDialogueDirections
                .parse(com.qingyu.companion.chatcore.ChatMessagePostProcess.stripThought(raw))
                .map { DialogueDirection(id = it.id, label = it.label, content = it.content, tendency = it.tendency) }
        }

        val first = once()
        if (first.isNotEmpty()) return first
        // 协议要求「不合法则重试一次」：模型偶尔写不满 3 个或写成解释性文本
        return once()
    }

    /**
     * 消息翻译（S4-04）：本地直连完成，并把译文落回该消息行。
     *
     * 与 PC 的 `chatService.translate` 对齐：同一系统提示词、同一采样参数、
     * 同一任务预算（task = translation，按输入字符数推导）；
     * 译文以「同 id 覆盖」写回消息的 `translation` 字段，不产生新消息。
     */
    override suspend fun translate(sessionId: String, messageId: String): TranslateResponse {
        val target = store.listMessages(sessionId).firstOrNull { it.id == messageId }
            ?: throw IllegalArgumentException("目标消息不存在：$messageId")
        val (profile, apiKey) = activeProfileAndKey()
        if (profile == null) throw IllegalStateException("未配置可用的 API 连接，无法翻译")

        val model = profile.model
        val targetLang = com.qingyu.companion.chatcore.ChatTranslationPrompt.resolveTargetLang(
            getSettings().translationTargetLang,
        )
        val plan = com.qingyu.companion.chatcore.ChatGenerationTaskBudget.resolveGenerationTaskBudget(
            com.qingyu.companion.chatcore.ChatGenerationTaskBudget.Input(
                task = "translation",
                model = model,
                inputChars = target.content.length,
            ),
        )
        val client = auxGateway ?: throw IllegalStateException("辅助生成未接线，无法翻译")
        val events = client.stream(
            profile.provider,
            profile,
            com.qingyu.companion.network.models.ModelChatRequest(
                model = model,
                messages = listOf(
                    com.qingyu.companion.network.models.ChatMessageDto(
                        "system",
                        com.qingyu.companion.chatcore.ChatTranslationPrompt
                            .buildMessageTranslationSystemPrompt(targetLang),
                    ),
                    com.qingyu.companion.network.models.ChatMessageDto("user", target.content),
                ),
                temperature = com.qingyu.companion.chatcore.ChatTranslationPrompt.TEMPERATURE,
                maxTokens = plan.request.requestMaxTokens,
                stream = false,
            ),
            apiKey,
        ).first.toList()
        events.filterIsInstance<com.qingyu.companion.network.models.ModelStreamEvent.Failure>().firstOrNull()
            ?.let { throw IllegalStateException(it.error.message) }
        val raw = events.filterIsInstance<com.qingyu.companion.network.models.ModelStreamEvent.Chunk>()
            .joinToString("") { it.value.deltaText }
        val translation = com.qingyu.companion.chatcore.ChatTranslationPrompt.stripTranslationWrapper(raw)
        if (translation.isEmpty()) throw IllegalStateException("翻译结果为空，请重试")
        store.updateMessage(target.copy(translation = translation, updatedAt = System.currentTimeMillis()))
        // S4-04 用量诊断：翻译同样是一次真实模型调用，必须按**独立 task type** 记用量，
        // 否则「本会话聊了多少」会被翻译请求污染（翻译输入往往是整条长消息）。
        runCatching {
            val metrics = com.qingyu.companion.chatcore.ChatTextMetrics
            val promptChars = metrics.countVisibleCharacters(
                com.qingyu.companion.chatcore.ChatTranslationPrompt
                    .buildMessageTranslationSystemPrompt(targetLang),
            ) + metrics.countVisibleCharacters(target.content)
            val outputChars = metrics.countVisibleCharacters(translation)
            if (outputChars > 0) {
                store.recordUsage(
                    com.qingyu.companion.local.db.LocalUsageRecordEntity(
                        id = "translation-$messageId-${System.currentTimeMillis()}",
                        sessionId = target.sessionId,
                        messageId = messageId,
                        provider = "",
                        model = model,
                        promptTokens = 0,
                        completionTokens = 0,
                        createdAt = System.currentTimeMillis(),
                        taskType = "translation",
                        inputChars = promptChars,
                        outputChars = outputChars,
                    ),
                )
            }
        }
        return TranslateResponse(messageId = messageId, translation = translation)
    }

    /**
     * 阶段 5 S5-06：本地快捷回复。
     *
     * 存储是「集合行」，接口要的是 PC 的整库形状 `{global, byCharacter}`，
     * 这里做同一份聚合（与 `EntityPayloads.quickReplyStorePayload` 同一顺序规则：
     * 集合按 `sortIndex, id` 串联后展开），否则同步 payload 与本地视图会给出不同顺序。
     */
    override suspend fun listQuickReplies(characterId: String?): QuickReplyListResponse {
        val sets = store.listQuickReplySets()
        val global = ArrayList<com.qingyu.companion.model.QuickReply>()
        val byCharacter = LinkedHashMap<String, List<com.qingyu.companion.model.QuickReply>>()
        sets.sortedWith(compareBy({ it.sortIndex }, { it.id })).forEach { row ->
            val items = QuickReplyCodec.decodeItems(row.itemsJson, fallbackOrderBase = global.size + byCharacter.size)
            val owner = row.characterId
            if (owner == null) global += items else byCharacter[owner] = (byCharacter[owner] ?: emptyList()) + items
        }
        return QuickReplyListResponse(
            global = global,
            byCharacter = if (characterId == null) byCharacter else byCharacter.filterKeys { it == characterId },
        )
    }

    /**
     * 返回 `true` 表示「本地已经把它执行完了，调用方不用再动」。
     *
     * `text` 型故意返回 false：ViewModel 的既有契约是 false 时把内容作为用户消息发出，
     * 本地模式下的发送路径（含宏展开、引用清除）都在那条支线上，
     * 在这里再实现一遍会出现两份发送实现漂移。
     * `preset` 型本地可直接改设置，返回 true。
     * `command` 型只有 [QuickReplyPolicy] 判定为 SUPPORTED 才可能返回 true——
     * 平台专用命令必须落到调用方的「显示禁用原因」支线上，而不是静默成功。
     */
    override suspend fun executeQuickReply(id: String): Boolean {
        val found = store.listQuickReplySets()
            .asSequence()
            .flatMap { QuickReplyCodec.decodeItems(it.itemsJson, fallbackOrderBase = 0).asSequence() }
            .firstOrNull { item -> item.id == id }
            ?: return false
        return when (found.action) {
            QuickReplyAction.preset -> {
                val presetId = found.presetId
                if (presetId.isNullOrBlank()) {
                    false
                } else {
                    store.putPublicSetting("chat", "activePresetId", "\"$presetId\"")
                    true
                }
            }
            QuickReplyAction.command ->
                QuickReplyPolicy.decideCommand(found.command).support == QuickReplyPolicy.CommandSupport.SUPPORTED
            QuickReplyAction.text -> false
        }
    }

    /**
     * 用量区间汇总（S4-04 用量诊断）。
     *
     * 修正了两处真实缺陷：
     * 1. `today` 与 `total` 此前完全相同（都是全量），今日统计实际没有生效；
     * 2. `count` 用 `listUsage(1).size` 计算——最多只能得到 0 或 1，而不是总条数。
     *
     * 与 PC `getSummary` 同口径：字符数汇总 + 记录条数。
     */
    override suspend fun usageSummary(): UsageSummaryResponse {
        val now = System.currentTimeMillis()
        val todayStart = java.util.Calendar.getInstance().apply {
            timeInMillis = now
            set(java.util.Calendar.HOUR_OF_DAY, 0)
            set(java.util.Calendar.MINUTE, 0)
            set(java.util.Calendar.SECOND, 0)
            set(java.util.Calendar.MILLISECOND, 0)
        }.timeInMillis

        fun toSummary(stats: com.qingyu.companion.local.domain.UsageStats) = UsageSummary(
            // DTO 的 totalInput/totalOutput 承载字符数（PC 同名字段即字符数）
            totalInput = stats.totalInput,
            totalOutput = stats.totalOutput,
            totalChars = stats.totalChars,
            count = stats.count,
        )
        return UsageSummaryResponse(
            today = toSummary(store.usageStats(todayStart, now)),
            total = toSummary(store.usageStats(0L, Long.MAX_VALUE)),
        )
    }

    override suspend fun usageRecords(limit: Int): List<UsageRecordDto> =
        store.listUsageInRange(0L, Long.MAX_VALUE, limit).map { row ->
            UsageRecordDto(
                id = row.id,
                timestamp = row.createdAt,
                characterId = row.sessionId?.let { store.getSession(it)?.characterId }.orEmpty(),
                sessionId = row.sessionId.orEmpty(),
                model = row.model,
                inputChars = row.inputChars,
                outputChars = row.outputChars,
                totalChars = row.inputChars + row.outputChars,
                taskType = row.taskType,
            )
        }

    /**
     * 公告：本地模式没有公告来源（公告只来自 PC 侧公告服务器/缓存回退）。
     *
     * 此前这里**直接返回空页**，而紧挨着的注释就写着「必须留下可行动提示，不得静默返回空值」
     * ——同一条规则，隔壁的 `fetchVersionInfo` 守了、它没守。用户看到的是「暂无公告」，
     * 无法区分「真的没有」与「本地模式还不提供」。
     * 走 [notMigrated] 后至少与 group 那一批同一个口径（提示写进 `unsupportedNotice`）。
     * **已知未闭环**：`AnnouncementsViewModel` 目前不消费该提示（只有 `ChatViewModel` 消费），
     * 所以这一屏还看不到文案——见报告 §2.28 的「可见性」一条。
     */
    override suspend fun listAnnouncements(): AnnouncementPage =
        notMigrated("公告", AnnouncementPage(items = emptyList(), total = 0, page = 1, pageSize = 0))

    /**
     * 未迁移能力（阶段 5/6）——**必须留下可行动提示**，不得静默返回空值。
     *
     * 静默降级会让界面显示「空列表」而非「本地模式尚未提供」，
     * 用户无法区分「真的没有」和「还没做」。因此这些方法统一走 [notMigrated]。
     */
    override suspend fun fetchVersionInfo(): VersionInfo? = notMigrated("版本信息", null)

    // ---------------------------------------------------------------- 群聊（阶段 6 S6-01：本地权威）

    /**
     * 群聊自阶段 6 起为**本地权威数据**（关闭 PC 后群聊独立可用，S6-01 完成定义）。
     *
     * 仍未本地化的只有 [groupAiReply]（群生成闭环依赖群调度器状态机 + 群上下文装配，
     * 属 S6-01d/S6-01c 后续子项）——它继续走 [notMigrated]，不假装成功。
     */

    override suspend fun listGroups(): List<com.qingyu.companion.model.GroupChat> =
        store.listGroups().map { it.toGroupChat() }

    override suspend fun listGroupSessions(groupId: String): List<com.qingyu.companion.model.GroupSession> =
        store.listSessions()
            .filter { it.groupId == groupId }
            .sortedWith(compareByDescending<com.qingyu.companion.local.db.LocalSessionEntity> { it.updatedAt }.thenBy { it.id })
            .map { it.toGroupSession(store.countGroupMessages(it.id)) }

    override suspend fun listGroupMessages(
        groupId: String,
        sessionId: String,
    ): List<com.qingyu.companion.model.GroupMessage> = store.listGroupMessages(sessionId)
        // 展示顺序 = (logicalTime, id) 稳定排序（总方案 §6.3）
        .sortedWith(compareBy({ it.logicalTime }, { it.id }))
        .map { it.toGroupMessage() }

    /**
     * 发送群聊用户消息（S6-01）。
     *
     * 与 PC `useGroupChatStore.sendMessage` 的公共前序对齐：
     * - `requestId` 即消息 id（幂等键：弱网重发**不写第二条**，同 id 重放直接返回成功）；
     * - 轮次 = `max(rounds, 0) + 1`（[ChatGroupScheduling.nextGroupRound]，与 PC 同一份逻辑）；
     * - 身份快照：`generationKind='manual'`，`speakerKind` 由会话叙事模式决定
     *   （omniscient → narrator，其余 → persona）。
     */
    override suspend fun sendGroupMessage(
        groupId: String,
        sessionId: String,
        requestId: String,
        content: String,
    ): Boolean {
        val session = store.getSession(sessionId)
            ?: throw IllegalArgumentException("群聊会话不存在：$sessionId")
        require(session.groupId == groupId) { "会话不属于该群聊" }
        // 幂等：同一 requestId 重发只落一条
        if (store.listGroupMessages(sessionId).any { it.id == requestId }) return true

        val now = System.currentTimeMillis()
        val narrative = resolveSessionNarrativeMode(session.narrativeMode)
        store.appendGroupMessage(
            com.qingyu.companion.local.db.LocalGroupMessageEntity(
                id = requestId,
                sessionId = sessionId,
                groupId = groupId,
                characterId = "__user__",
                content = content,
                round = com.qingyu.companion.chatcore.ChatGroupScheduling
                    .nextGroupRound(store.listGroupMessages(sessionId).map { it.round.toLong() })
                    .toInt(),
                status = "sent",
                narrativeMode = narrative,
                speakerKind = if (narrative == "omniscient") "narrator" else "persona",
                generationKind = "manual",
                logicalTime = now,
                seq = -1,
                createdAt = now,
                updatedAt = now,
            ),
        )
        // 与 PC `group:saveMessage` 同口径：消息落盘推进会话 updatedAt
        store.putSession(session.copy(updatedAt = now))
        return true
    }

    /**
     * 编辑群聊消息（S6-01）。
     *
     * 与 PC `group:editMessage` 逐条对齐：**只改 content**（译文/方向按 PC 现状保留
     * 在存储层、由上层失效），并且**不 bump 会话 updatedAt**（PC 同）；
     * 编辑历史会使派生记忆过期 → 推进历史修订号（S4-05 检查点口径）。
     */
    override suspend fun editGroupMessage(groupId: String, sessionId: String, messageId: String, content: String) {
        val existing = store.listGroupMessages(sessionId).firstOrNull { it.id == messageId }
            ?: throw IllegalArgumentException("消息不存在：$messageId")
        store.updateGroupMessage(existing.copy(content = content))
        store.bumpMemoryHistoryRevision(sessionId)
    }

    /** 删除群聊消息（S6-01）：删除同样使派生记忆过期（推进历史修订号）。 */
    override suspend fun deleteGroupMessage(groupId: String, sessionId: String, messageId: String) {
        store.deleteGroupMessage(messageId, sessionId)
        store.bumpMemoryHistoryRevision(sessionId)
    }

    override suspend fun groupAiReply(groupId: String, sessionId: String, speakerId: String?): Boolean =
        notMigrated("群聊 AI 回复", false)

    /**
     * 新建群聊（S6-01）：与 PC `GroupChatPage.confirmCreate` 的新建默认一致
     * （polling / 不自动接力 / maxRounds 1 / 2000ms / `builtin-default` 预设）；
     * 未给名称时用成员名 `、` 连接（PC 同）。
     */
    override suspend fun createGroup(name: String?, memberIds: List<String>): Boolean {
        val now = System.currentTimeMillis()
        // 缺省群名 = 成员名「、」连接（PC confirmCreate 口径）；joinToString 的 lambda 非挂起，先取名再拼接
        val resolvedName = name?.takeIf { it.isNotBlank() } ?: run {
            val names = ArrayList<String>(memberIds.size)
            for (id in memberIds) names += store.getCharacter(id)?.name ?: id
            names.joinToString("、")
        }
        store.putGroup(
            com.qingyu.companion.local.db.LocalGroupEntity(
                id = com.qingyu.companion.chatcore.Ulid.newId(),
                name = resolvedName,
                mode = "manual",
                characterIdsJson = com.qingyu.companion.local.domain.JsonValues.stringify(memberIds),
                chatMode = "polling",
                autoMode = false,
                maxRounds = 1,
                speakerInterval = 2000,
                currentSpeakerIndex = 0,
                presetId = "builtin-default",
                systemPrompt = "",
                lorebookIdsJson = "[]",
                defaultNarrativeMode = "",
                createdAt = now,
                updatedAt = now,
            ),
        )
        return true
    }

    /**
     * 修改群聊设置（S6-01）。白名单键（越界键报错，不静默丢弃）：
     * `name` / `chatMode` / `autoMode` / `maxRounds` / `speakerInterval` /
     * `currentSpeakerIndex` / `presetId` / `systemPrompt` / `lorebookIds` /
     * `defaultNarrativeMode` / `memberIds`（整体替换 = 成员增删与**排序**的统一入口）。
     */
    override suspend fun patchGroup(groupId: String, patch: Map<String, Any?>) {
        val group = store.getGroup(groupId) ?: throw IllegalArgumentException("群聊不存在：$groupId")
        store.putGroup(applyGroupPatch(group, patch))
    }

    /** 添加群聊成员（S6-01）：追加到成员顺序末尾；已存在的成员不重复、不改变位置。 */
    override suspend fun addGroupMembers(groupId: String, characterIds: List<String>) {
        val group = store.getGroup(groupId) ?: throw IllegalArgumentException("群聊不存在：$groupId")
        val current = parseStringList(group.characterIdsJson)
        val merged = current + characterIds.filter { it !in current }
        store.putGroup(group.copy(characterIdsJson = com.qingyu.companion.local.domain.JsonValues.stringify(merged)))
    }

    /** 删除群聊成员（S6-01）：从成员顺序中移除（轮转顺序即 memberIds 顺序）。 */
    override suspend fun removeGroupMember(groupId: String, characterId: String) {
        val group = store.getGroup(groupId) ?: throw IllegalArgumentException("群聊不存在：$groupId")
        val merged = parseStringList(group.characterIdsJson).filter { it != characterId }
        store.putGroup(group.copy(characterIdsJson = com.qingyu.companion.local.domain.JsonValues.stringify(merged)))
    }

    /**
     * 删除群聊（S6-01）：**先删会话（含消息），再删群**——顺序不可反。
     *
     * 会话删除走 [LocalStore.deleteSession] 的 tombstone 记账（消息随会话级联清理），
     * 群删除走 [LocalStore.deleteGroup] 的 tombstone；先删群会让会话的 tombstone
     * 永久失去 parentId（父行已不在），§6.3 的删除并发/孤儿检测就归不了位。
     */
    override suspend fun deleteGroup(groupId: String) {
        store.listSessions().filter { it.groupId == groupId }.forEach { store.deleteSession(it.id) }
        store.deleteGroup(groupId)
    }

    /**
     * 新建群聊会话（S6-01）：群会话 = `local_sessions` 中 `group_id` 非空的行。
     *
     * 记忆配置暂按「关闭 / manual / 10」落盘；跟随全局默认记忆配置属 S6-01e
     * （群记忆接入）范围，届时按 `resolveDefaultGroupMemoryConfig` 同口径补齐。
     */
    override suspend fun createGroupSession(groupId: String, title: String?): com.qingyu.companion.model.GroupSession {
        store.getGroup(groupId) ?: throw IllegalArgumentException("群聊不存在：$groupId")
        val id = com.qingyu.companion.chatcore.Ulid.newId()
        val now = System.currentTimeMillis()
        store.putSession(
            LocalSessionEntity(
                id = id,
                groupId = groupId,
                title = title?.takeIf { it.isNotBlank() } ?: "新对话",
                createdAt = now,
                updatedAt = now,
            ),
        )
        return store.getSession(id)!!.toGroupSession(0)
    }

    override suspend fun renameGroupSession(groupId: String, sessionId: String, title: String) {
        val session = store.getSession(sessionId) ?: throw IllegalArgumentException("会话不存在：$sessionId")
        require(session.groupId == groupId) { "会话不属于该群聊" }
        store.putSession(session.copy(title = title))
    }

    override suspend fun deleteGroupSession(groupId: String, sessionId: String) {
        val session = store.getSession(sessionId) ?: return
        require(session.groupId == groupId) { "会话不属于该群聊" }
        store.deleteSession(sessionId)
    }

    /**
     * 修改群聊会话设置（S6-01）。白名单键（越界键报错）：
     * `title` / `personaId` / `narrativeMode` / `dialogueDirectionsEnabled` /
     * `memoryEnabled` / `memoryMode` / `autoMemoryInterval`。
     */
    override suspend fun patchGroupSession(groupId: String, sessionId: String, patch: Map<String, Any?>) {
        val session = store.getSession(sessionId) ?: throw IllegalArgumentException("会话不存在：$sessionId")
        require(session.groupId == groupId) { "会话不属于该群聊" }
        var next = session
        for ((key, value) in patch) {
            next = when (key) {
                "title" -> next.copy(title = requireString(key, value))
                "personaId" -> next.copy(personaId = value as? String)
                "narrativeMode" -> next.copy(narrativeMode = requireNarrativeMode(key, value))
                "dialogueDirectionsEnabled" -> next.copy(dialogueDirectionsEnabled = requireBoolean(key, value))
                "memoryEnabled" -> next.copy(memoryEnabled = requireBoolean(key, value))
                "memoryMode" -> next.copy(memoryMode = requireMemoryMode(key, value))
                "autoMemoryInterval" -> next.copy(autoMemoryInterval = requireInt(key, value, min = 1))
                else -> throw IllegalArgumentException("未知的群聊会话设置键：$key")
            }
        }
        store.putSession(next)
    }

    /**
     * 翻译群聊消息（S6-01）：与 PC 群翻译**短提示词变体**逐字对齐
     * （`你是一个翻译助手。请将以下内容翻译成{目标语言}。只输出翻译结果，不要添加任何解释。`
     * ——PC 群聊用的是短变体，与单聊 `buildMessageTranslationSystemPrompt` 有意不同）；
     * 译文以同 id 覆盖写回 `translation`，用量按独立 task type 记账。
     */
    override suspend fun groupTranslate(groupId: String, sessionId: String, messageId: String): String? {
        val target = store.listGroupMessages(sessionId).firstOrNull { it.id == messageId }
            ?: throw IllegalArgumentException("目标消息不存在：$messageId")
        val (profile, apiKey) = activeProfileAndKey()
        if (profile == null) throw IllegalStateException("未配置可用的 API 连接，无法翻译")

        val model = profile.model
        val targetLang = getSettings().translationTargetLang.ifBlank { "中文" }
        val plan = com.qingyu.companion.chatcore.ChatGenerationTaskBudget.resolveGenerationTaskBudget(
            com.qingyu.companion.chatcore.ChatGenerationTaskBudget.Input(
                task = "translation",
                model = model,
                inputChars = target.content.length,
            ),
        )
        val client = auxGateway ?: throw IllegalStateException("辅助生成未接线，无法翻译")
        val events = client.stream(
            profile.provider,
            profile,
            com.qingyu.companion.network.models.ModelChatRequest(
                model = model,
                messages = listOf(
                    com.qingyu.companion.network.models.ChatMessageDto(
                        "system",
                        "你是一个翻译助手。请将以下内容翻译成$targetLang。只输出翻译结果，不要添加任何解释。",
                    ),
                    com.qingyu.companion.network.models.ChatMessageDto("user", target.content),
                ),
                temperature = com.qingyu.companion.chatcore.ChatTranslationPrompt.TEMPERATURE,
                maxTokens = plan.request.requestMaxTokens,
                stream = false,
            ),
            apiKey,
        ).first.toList()
        events.filterIsInstance<com.qingyu.companion.network.models.ModelStreamEvent.Failure>().firstOrNull()
            ?.let { throw IllegalStateException(it.error.message) }
        val raw = events.filterIsInstance<com.qingyu.companion.network.models.ModelStreamEvent.Chunk>()
            .joinToString("") { it.value.deltaText }
        val translation = com.qingyu.companion.chatcore.ChatTranslationPrompt.stripTranslationWrapper(raw)
        if (translation.isEmpty()) throw IllegalStateException("翻译结果为空，请重试")
        store.updateGroupMessage(target.copy(translation = translation))
        runCatching {
            val metrics = com.qingyu.companion.chatcore.ChatTextMetrics
            val promptChars = metrics.countVisibleCharacters(
                "你是一个翻译助手。请将以下内容翻译成$targetLang。只输出翻译结果，不要添加任何解释。",
            ) + metrics.countVisibleCharacters(target.content)
            val outputChars = metrics.countVisibleCharacters(translation)
            if (outputChars > 0) {
                store.recordUsage(
                    com.qingyu.companion.local.db.LocalUsageRecordEntity(
                        id = "group-translation-$messageId-${System.currentTimeMillis()}",
                        sessionId = sessionId,
                        messageId = messageId,
                        provider = "",
                        model = model,
                        promptTokens = 0,
                        completionTokens = 0,
                        createdAt = System.currentTimeMillis(),
                        taskType = "translation",
                        inputChars = promptChars,
                        outputChars = outputChars,
                    ),
                )
            }
        }
        return translation
    }

    /** 群聊设置补丁：白名单逐键校验（枚举/范围非法一律报错，不静默纠正）。 */
    private fun applyGroupPatch(
        group: com.qingyu.companion.local.db.LocalGroupEntity,
        patch: Map<String, Any?>,
    ): com.qingyu.companion.local.db.LocalGroupEntity {
        var next = group
        for ((key, value) in patch) {
            next = when (key) {
                "name" -> next.copy(name = requireString(key, value))
                "chatMode" -> {
                    val mode = requireString(key, value)
                    require(mode in setOf("mention", "polling", "free")) { "参数无效：chatMode" }
                    next.copy(chatMode = mode)
                }
                "autoMode" -> next.copy(autoMode = requireBoolean(key, value))
                "maxRounds" -> next.copy(maxRounds = requireInt(key, value, min = 1))
                "speakerInterval" -> next.copy(speakerInterval = requireInt(key, value, min = 0))
                "currentSpeakerIndex" -> next.copy(currentSpeakerIndex = requireInt(key, value, min = 0))
                "presetId" -> next.copy(presetId = value as? String)
                "systemPrompt" -> next.copy(systemPrompt = requireString(key, value))
                "lorebookIds" -> next.copy(lorebookIdsJson = com.qingyu.companion.local.domain.JsonValues.stringify(requireStringList(key, value)))
                "defaultNarrativeMode" -> next.copy(defaultNarrativeMode = requireNarrativeMode(key, value))
                "memberIds" -> next.copy(characterIdsJson = com.qingyu.companion.local.domain.JsonValues.stringify(requireStringList(key, value)))
                else -> throw IllegalArgumentException("未知的群聊设置键：$key")
            }
        }
        return next
    }

    private fun requireString(key: String, value: Any?): String =
        value as? String ?: throw IllegalArgumentException("参数无效：$key")

    private fun requireBoolean(key: String, value: Any?): Boolean =
        value as? Boolean ?: throw IllegalArgumentException("参数无效：$key")

    private fun requireInt(key: String, value: Any?, min: Int): Int {
        val v = (value as? Number)?.toInt() ?: throw IllegalArgumentException("参数无效：$key")
        require(v >= min) { "参数无效：$key" }
        return v
    }

    private fun requireStringList(key: String, value: Any?): List<String> {
        val list = value as? List<*> ?: throw IllegalArgumentException("参数无效：$key")
        return list.map { it as? String ?: throw IllegalArgumentException("参数无效：$key") }
    }

    private fun requireNarrativeMode(key: String, value: Any?): String {
        val v = value as? String ?: throw IllegalArgumentException("参数无效：$key")
        require(v in setOf("", "immersive", "omniscient")) { "参数无效：$key" }
        return v
    }

    private fun requireMemoryMode(key: String, value: Any?): String {
        val v = value as? String ?: throw IllegalArgumentException("参数无效：$key")
        require(v in setOf("manual", "auto")) { "参数无效：$key" }
        return v
    }

    private fun parseStringList(json: String): List<String> =
        com.qingyu.companion.local.domain.JsonValues.parseArray(json).mapNotNull { it as? String }

    /** 会话叙事模式解析（PC `resolveNarrativeMode(session.narrativeMode)` 单候选口径）：非法/未设一律 immersive。 */
    private fun resolveSessionNarrativeMode(stored: String): String =
        when (stored) {
            "immersive", "omniscient" -> stored
            else -> "immersive"
        }

    companion object {
        const val PAGE_SIZE = 30

        /**
         * 本地上下文窗口口径。
         * 精确值应由连接档案的模型能力决定（阶段 4 S4-02 的 estimated 口径）；
         * 阶段 4 先用保守常量，阶段 5 接入模型档案后替换。
         */
        const val CONTEXT_LIMIT_TOKENS = 8192
    }
}

// ---------------------------------------------------------------- 实体 → 领域模型

private fun LocalSessionEntity.toPreview(characterName: String = ""): SessionPreview = SessionPreview(
    id = id,
    characterId = characterId.orEmpty(),
    characterName = characterName,
    title = title,
    createdAt = createdAt,
    updatedAt = updatedAt,
    messageCount = 0,
    lastMessage = "",
)

private fun com.qingyu.companion.local.db.LocalMessageEntity.toMessage(): Message = Message(
    id = id,
    sessionId = sessionId,
    characterId = characterId.orEmpty(),
    role = when (role) {
        "user" -> Role.user
        "assistant" -> Role.assistant
        else -> Role.system
    },
    content = content,
    timestamp = logicalTime,
    translation = translation,
    swipes = null,
    swipeIndex = swipeIndex,
    replyToId = replyToId,
    usage = null,
)

private fun com.qingyu.companion.local.db.LocalCharacterEntity.toCharacter(): Character = Character(
    id = id,
    name = name,
    description = description,
    personality = personality,
    scenario = scenario,
    firstMessage = firstMessage,
    updatedAt = updatedAt,
)

// ---------------------------------------------------------------- 群聊实体 → DTO（阶段 6 S6-01）

private val groupJson = kotlinx.serialization.json.Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    explicitNulls = false
}

private fun com.qingyu.companion.local.db.LocalGroupEntity.toGroupChat(): com.qingyu.companion.model.GroupChat =
    com.qingyu.companion.model.GroupChat(
        id = id,
        name = name,
        memberIds = com.qingyu.companion.local.domain.JsonValues.parseArray(characterIdsJson).mapNotNull { it as? String },
        chatMode = chatMode,
        autoMode = autoMode,
        maxRounds = maxRounds,
        speakerInterval = speakerInterval,
        currentSpeakerIndex = currentSpeakerIndex,
        presetId = presetId,
        systemPrompt = systemPrompt,
        lorebookIds = com.qingyu.companion.local.domain.JsonValues.parseArray(lorebookIdsJson).mapNotNull { it as? String },
        defaultNarrativeMode = defaultNarrativeMode,
    )

private fun LocalSessionEntity.toGroupSession(messageCount: Int): com.qingyu.companion.model.GroupSession =
    com.qingyu.companion.model.GroupSession(
        id = id,
        groupId = groupId.orEmpty(),
        title = title,
        messageCount = messageCount,
        dialogueDirectionsEnabled = dialogueDirectionsEnabled,
        personaId = personaId,
        narrativeMode = narrativeMode,
        memoryEnabled = memoryEnabled,
        memoryMode = memoryMode,
        autoMemoryInterval = autoMemoryInterval,
    )

private fun com.qingyu.companion.local.db.LocalGroupMessageEntity.toGroupMessage(): com.qingyu.companion.model.GroupMessage =
    com.qingyu.companion.model.GroupMessage(
        id = id,
        groupId = groupId,
        characterId = characterId,
        content = content,
        images = com.qingyu.companion.local.domain.JsonValues.parseArray(imagesJson).mapNotNull { it as? String },
        timestamp = logicalTime,
        round = round,
        translation = translation,
        replyToId = replyToId,
        narrativeMode = narrativeMode,
        speakerKind = speakerKind,
        generationKind = generationKind,
        status = status,
        mentionedCharacterIds = com.qingyu.companion.local.domain.JsonValues.parseArray(mentionedIdsJson).mapNotNull { it as? String },
        dialogueDirections = dialogueDirectionsJson?.takeIf { it.isNotBlank() }?.let { json ->
            runCatching { groupJson.decodeFromString<List<com.qingyu.companion.model.DialogueDirection>>(json) }.getOrNull()
        },
        generationNotice = generationNotice,
        generationError = generationError,
        contentRenderMode = contentRenderMode,
    )
