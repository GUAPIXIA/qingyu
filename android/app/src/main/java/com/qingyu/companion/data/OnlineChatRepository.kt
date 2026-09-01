package com.qingyu.companion.data

import androidx.room.withTransaction
import com.qingyu.companion.data.send.OutboxStateMachine
import com.qingyu.companion.data.send.SendPathSelector.SendPath
import com.qingyu.companion.data.send.SendPathSelector
import com.qingyu.companion.data.send.TaskCursorLogic
import com.qingyu.companion.model.Character
import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.ConnectionMode
import com.qingyu.companion.model.CreateTaskRequest
import com.qingyu.companion.model.Message
import com.qingyu.companion.model.MessagePage
import com.qingyu.companion.model.MessageUsage
import com.qingyu.companion.model.QuickReplyListResponse
import com.qingyu.companion.model.RenameSessionRequest
import com.qingyu.companion.model.Role
import com.qingyu.companion.model.SendMessageRequest
import com.qingyu.companion.model.ServerInfo
import com.qingyu.companion.model.SessionPreview
import com.qingyu.companion.model.TaskEventEnvelopeDto
import com.qingyu.companion.model.TaskEventType
import com.qingyu.companion.model.TaskSnapshotDto
import com.qingyu.companion.model.TranslateResponse
import com.qingyu.companion.network.ConnectionManager
import com.qingyu.companion.network.QingyuApi
import com.qingyu.companion.network.WsClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.merge
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID

/**
 * [ChatRepository] 在线实现：REST 为主，Room 为离线只读快照。
 *
 * 缓存策略（方案 §6.9）：会话仅存最近 [CacheDatabase.MAX_CACHED_SESSIONS] 条、
 * 单会话消息仅存最近 [MAX_CACHED_MESSAGES_PER_SESSION] 条；重连后以 PC 为准刷新。
 *
 * 事件流 = WS 事件 + 本地注入（v2 task 轮询流式 chunk / 对账刷新通知）合并输出。
 *
 * 阶段 F：
 * - F-01：发送链路按 capabilities 门控（task_events_v2 → v2 task，否则 v1 ai:*），
 *   同一 requestId 只走一条链路；
 * - F-02：task 事件 cursor（task_cursors 表，(deviceId, taskId)）按序应用 + REST 补拉 + 快照兜底；
 * - F-04：八态状态机（OutboxStateMachine），所有转换在 Room 事务内完成；
 * - F-06：重启恢复矩阵 / legacy 归属修复 / 对账刷新 / UseCase 下沉。
 */
class OnlineChatRepository(
    private val connectionManager: ConnectionManager,
    private val connectionStore: ConnectionStore,
    private val wsClient: WsClient,
    private val db: CacheDatabase,
    private val json: Json,
    /**
     * F-04：状态转换事务执行器（默认 db.withTransaction；JVM 测试注入直接执行以脱离 Room）。
     * 所有 outbox 状态转换必须经此进入数据库事务（方案 F-06）。
     */
    private val transactionRunner: suspend (block: suspend () -> Unit) -> Unit =
        { block -> db.withTransaction { block() } },
) : ChatRepository {

    override val connectionState: StateFlow<WsClient.State> = wsClient.state

    /** F-01：本地注入事件（v2 task 流式 chunk、对账刷新通知） */
    private val localEvents = MutableSharedFlow<CompanionEvent>(
        replay = 0,
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    override val events: Flow<CompanionEvent> = merge(wsClient.events, localEvents)

    /** F-04：是否存在无法归属（legacy）的旧待处理消息（UI 提示"旧版本待发送消息"） */
    private val _pendingLegacyOutbox = MutableStateFlow(false)
    override val pendingLegacyOutbox: StateFlow<Boolean> = _pendingLegacyOutbox.asStateFlow()

    private val sessionDao = db.sessionDao()
    private val messageDao = db.messageDao()
    private val outboxDao = db.outboxDao()
    private val taskCursorDao = db.taskCursorDao()

    private suspend fun api(): QingyuApi =
        connectionManager.activeApi() ?: throw CompanionError.Offline("尚未连接任何 PC")

    /** 当前归属 PC（优先内存活跃连接，回退持久化活跃选择——启动早期 restore 未完成时仍可归属） */
    private suspend fun activeDeviceId(): String? =
        connectionManager.activeConnection?.deviceId ?: connectionStore.getActive()?.deviceId

    private fun nowMs(): Long = System.currentTimeMillis()

    /**
     * F-06：任务快照解析（可注入测试替身；生产 = GET /api/v2/tasks/:taskId）。
     * 供恢复矩阵查询任务终态（不重复用户消息的恢复路径）。
     */
    internal var taskSnapshotResolver: suspend (String) -> TaskSnapshotDto? = { taskId ->
        runCatching { api().getTask(taskId).task }.getOrNull()
    }

    // ---------- 会话 ----------

    override suspend fun listSessions(): List<SessionPreview> = try {
        val sessions = api().listSessions()
        cacheSessions(sessions)
        sessions
    } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun createSession(characterId: String, title: String?, greeting: String?): SessionPreview = try {
        val session = api().createSession(
            com.qingyu.companion.model.CreateSessionRequest(characterId, title, greeting)
        )
        cacheSessions(listOf(session))
        session
    } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun deleteSession(sessionId: String, characterId: String?) = try {
        api().deleteSession(sessionId, characterId)
        sessionDao.delete(sessionId)
        messageDao.deleteBySession(sessionId)
    } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun renameSession(sessionId: String, title: String) {
        try {
            api().renameSession(sessionId, RenameSessionRequest(title))
            val existing = sessionDao.listAll().firstOrNull { it.id == sessionId } ?: return
            sessionDao.upsert(existing.copy(title = title))
        } catch (e: Exception) { throw e.toCompanionError() }
    }

    // ---------- 快捷设置 ----------

    override suspend fun getSettings(): com.qingyu.companion.model.SettingsDto = try { api().getSettings() } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun updateSettings(patch: Map<String, Any?>) = try {
        val body = buildJsonObject {
            patch.forEach { (k, v) ->
                when (v) {
                    is String -> put(k, JsonPrimitive(v))
                    is Boolean -> put(k, JsonPrimitive(v))
                    is Int -> put(k, JsonPrimitive(v))
                    is Long -> put(k, JsonPrimitive(v))
                    is Double -> put(k, JsonPrimitive(v))
                    null -> put(k, JsonNull)
                }
            }
        }
        api().patchSettings(body)
    } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun listLorebooks(): List<com.qingyu.companion.model.LorebookDto> = try { api().listLorebooks() } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun listPresets(): List<com.qingyu.companion.model.PresetDto> = try { api().listPresets() } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun getSessionLorebooks(sessionId: String): List<String> = try { api().getSessionLorebooks(sessionId).lorebookIds } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun setSessionLorebooks(sessionId: String, lorebookIds: List<String>) {
        try { api().patchSessionLorebooks(sessionId, com.qingyu.companion.model.LorebooksResponse(lorebookIds)) } catch (e: Exception) { throw e.toCompanionError() }
    }

    override suspend fun getSessionPreset(sessionId: String): String? = try { api().getSessionPreset(sessionId).presetId } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun setSessionPreset(sessionId: String, presetId: String?) {
        try { api().patchSessionPreset(sessionId, com.qingyu.companion.model.PresetResponse(presetId)) } catch (e: Exception) { throw e.toCompanionError() }
    }

    override suspend fun listModels(): List<String> = try { api().listModels().models } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun clearChat(sessionId: String) = try { api().clearChat(sessionId); messageDao.deleteBySession(sessionId) } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun aiAssist(sessionId: String, type: String, content: String?): String = try { api().aiAssist(sessionId, com.qingyu.companion.model.AiAssistRequest(type, content)).text } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun updatePreset(
        presetId: String,
        temperature: Double?,
        topP: Double?,
        maxTokens: Int?,
    ): String? = try {
        val resp = api().patchPreset(
            presetId,
            com.qingyu.companion.model.PresetPatchRequest(temperature, topP, maxTokens),
        )
        resp.presetId
    } catch (e: Exception) { throw e.toCompanionError() }

    // ---------- 长记忆 ----------

    override suspend fun getSessionMemory(sessionId: String, characterId: String?): com.qingyu.companion.model.MemoryDto = try { api().getSessionMemory(sessionId, characterId) } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun patchSessionMemory(
        sessionId: String,
        memoryEnabled: Boolean?,
        memoryMode: String?,
        autoMemoryInterval: Int?,
        characterId: String?,
    ) = try {
        api().patchSessionMemory(
            sessionId,
            characterId,
            com.qingyu.companion.model.MemoryPatchRequest(memoryEnabled, memoryMode, autoMemoryInterval),
        )
    } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun summarizeMemory(sessionId: String, characterId: String?): Pair<String, List<com.qingyu.companion.model.MemoryFactDto>> = try {
        val resp = api().summarizeMemory(sessionId, characterId)
        resp.summary to resp.facts
    } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun getContextUsage(sessionId: String, characterId: String?): com.qingyu.companion.model.ContextUsageDto = try { api().getContextUsage(sessionId, characterId) } catch (e: Exception) { throw e.toCompanionError() }

    // ---------- 消息 ----------

    override suspend fun listMessages(sessionId: String, beforeId: String?): MessagePage = try {
        val page = api().listMessages(sessionId, beforeId = beforeId)
        messageDao.upsertAll(page.messages.map { it.toCache() })
        messageDao.trimTo(sessionId, MAX_CACHED_MESSAGES_PER_SESSION)
        page
    } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun branchSession(sessionId: String, messageId: String): com.qingyu.companion.model.SessionPreview = try { api().branchSession(sessionId, messageId) } catch (e: Exception) { throw e.toCompanionError() }

    // ---------- 发送（F-01 双链路门控 + F-04 八态状态机） ----------

    override suspend fun sendMessage(
        sessionId: String,
        requestId: String,
        content: String,
        replyToId: String?,
        images: List<String>,
    ): Message {
        val active = connectionManager.activeConnection
        if (active?.mode == ConnectionMode.RELAY && images.isNotEmpty()) {
            throw CompanionError.ServerRejected(415, "服务器连接暂不支持发送图片或音频，请切换到局域网连接")
        }
        val capabilities = active?.capabilities ?: emptySet()
        // Relay MVP 白名单走 v1 Bridge 兼容端点；task v2 在后续显式开放前不得绕过白名单。
        val path = if (active?.mode == ConnectionMode.RELAY) SendPath.LEGACY_V1 else SendPathSelector.select(capabilities)
        enqueueIfNeeded(sessionId, requestId, content, replyToId, images)
        val row = outboxDao.getById(requestId)
        // 切 PC 隔离：非 active 设备的行保持暂停，绝不发送（F-04 验收项）
        if (row != null && row.deviceId != LEGACY_DEVICE_ID && row.deviceId != activeDeviceId()) {
            throw CompanionError.Offline("该消息属于其他 PC，已暂停发送")
        }
        // 用户消息已落盘（v2 链路确认过）→ 绝不重发用户消息，转生成重试
        if (row != null && row.state in setOf(
                OutboxStateMachine.USER_COMMITTED,
                OutboxStateMachine.AWAITING_AI,
                OutboxStateMachine.FAILED_GENERATION,
            )
        ) {
            return retryGeneration(requestId)
        }
        // 发送失败行：先复位为 queued（同一 requestId 重发，退避调度清除）
        if (row != null && row.state == OutboxStateMachine.FAILED_SEND) {
            transitionOutbox(requestId, OutboxStateMachine.QUEUED)
        }
        // Relay 已接管同一 commandId：重复点击只返回本地占位，不生成第二条命令。
        if (row != null && row.state == OutboxStateMachine.RELAY_QUEUED) return relayQueuedPlaceholder(row)
        return when (path) {
            SendPath.TASK_V2 -> sendMessageTaskV2(sessionId, requestId, content, replyToId, images)
            SendPath.LEGACY_V1 -> sendMessageLegacyV1(sessionId, requestId, content, replyToId, images)
        }
    }

    /**
     * 入队（幂等）：不存在则新建 queued 行；终态行（completed/cancelled）重建为 queued。
     * v5 列接线：deviceId=当前归属 PC、characterId=缓存会话角色、updatedAt=now。
     */
    private suspend fun enqueueIfNeeded(
        sessionId: String,
        requestId: String,
        content: String,
        replyToId: String?,
        images: List<String>,
    ) {
        val existing = outboxDao.getById(requestId)
        if (existing != null && existing.state !in OutboxStateMachine.TERMINAL) return
        val row = OutboxMessage(
            requestId = requestId,
            sessionId = sessionId,
            content = content,
            imagesJson = json.encodeToString(images),
            replyToId = replyToId,
            createdAt = existing?.createdAt ?: nowMs(),
            retryCount = existing?.retryCount ?: 0,
            state = OutboxStateMachine.QUEUED,
            deviceId = activeDeviceId() ?: LEGACY_DEVICE_ID,
            characterId = sessionDao.listAll().firstOrNull { it.id == sessionId }?.characterId,
            updatedAt = nowMs(),
        )
        outboxDao.upsert(row)
    }

    /** v1 兼容链路：POST /api/v1/sessions/:id/messages + WS ai:* 事件。 */
    private suspend fun sendMessageLegacyV1(
        sessionId: String,
        requestId: String,
        content: String,
        replyToId: String?,
        images: List<String>,
    ): Message {
        // 时序修复：awaiting_ai 不再在 REST 调用前置位（旧实现时序错误）
        transitionOutbox(requestId, OutboxStateMachine.SENDING)
        try {
            val request = SendMessageRequest(requestId, content, replyToId, images)
            val message = if (connectionManager.activeConnection?.mode == ConnectionMode.RELAY) {
                val response = api().sendMessageRaw(sessionId, request)
                if (response.code() == 202) {
                    transitionOutbox(requestId, OutboxStateMachine.RELAY_QUEUED)
                    return relayQueuedPlaceholder(requireNotNull(outboxDao.getById(requestId)))
                }
                if (!response.isSuccessful) throw retrofit2.HttpException(response)
                val body = response.body()?.string() ?: error("Relay 消息响应为空")
                json.decodeFromString<Message>(body)
            } else api().sendMessage(sessionId, request)
            messageDao.upsertAll(listOf(message.toCache()))
            // v1 REST 单次返回即含"用户消息落盘 + AI 完成"，直达 completed
            //（v1 无 remoteUserMessageId 回执，列留空）
            transitionOutbox(requestId, OutboxStateMachine.COMPLETED)
            return message
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failSend(requestId, e)
            throw e.toCompanionError()
        }
    }

    private fun relayQueuedPlaceholder(row: OutboxMessage) = Message(
        id = row.requestId,
        sessionId = row.sessionId,
        characterId = row.characterId.orEmpty(),
        role = Role.user,
        content = row.content,
        images = runCatching { json.decodeFromString<List<String>>(row.imagesJson) }.getOrDefault(emptyList()),
        timestamp = row.createdAt,
        replyToId = row.replyToId,
    )

    override suspend fun completeRelayCommand(commandId: String, resultStatus: Int, message: Message?) {
        val row = outboxDao.getById(commandId) ?: return
        if (row.state != OutboxStateMachine.RELAY_QUEUED) return
        if (resultStatus in 200..299) {
            if (message != null) messageDao.upsertAll(listOf(message.toCache()))
            transitionOutbox(commandId, OutboxStateMachine.COMPLETED)
        } else {
            transitionOutbox(
                commandId, OutboxStateMachine.FAILED_SEND,
                errorCode = "relay_command_failed", errorMessage = "服务器排队消息执行失败 ($resultStatus)", countRetry = true,
            )
        }
    }

    override suspend fun expireRelayCommand(commandId: String) {
        val row = outboxDao.getById(commandId) ?: return
        if (row.state != OutboxStateMachine.RELAY_QUEUED) return
        transitionOutbox(
            commandId, OutboxStateMachine.FAILED_SEND,
            errorCode = "relay_queue_expired", errorMessage = "服务器排队消息已超过 15 分钟，请手动重试", countRetry = true,
        )
    }

    /** v2 task 链路：POST /api/v2/sessions/:id/tasks（Idempotency-Key）→ task 事件流。 */
    private suspend fun sendMessageTaskV2(
        sessionId: String,
        requestId: String,
        content: String,
        replyToId: String?,
        images: List<String>,
    ): Message {
        val api = api()
        transitionOutbox(requestId, OutboxStateMachine.SENDING)
        val created = try {
            api.createTask(
                sessionId,
                requestId,
                CreateTaskRequest(
                    type = "send",
                    characterId = outboxDao.getById(requestId)?.characterId,
                    content = content,
                    images = images,
                    replyToId = replyToId,
                    requestId = requestId,
                ),
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failSend(requestId, e)
            throw e.toCompanionError()
        }
        // PC 已确认用户消息落盘（或幂等命中既有消息）→ user_committed（拿到 remoteUserMessageId）
        transitionOutbox(
            requestId,
            OutboxStateMachine.USER_COMMITTED,
            taskId = created.task.taskId.takeIf { it.isNotEmpty() },
            remoteUserMessageId = created.userMessage?.id,
        )
        // AI 生成任务开始（拿到 taskId）→ awaiting_ai
        transitionOutbox(requestId, OutboxStateMachine.AWAITING_AI)
        // 能力命中时订阅该会话的 task 事件（WS 推送；PC 未推送时由下方 REST 轮询兜底）
        runCatching { subscribeTaskEvents() }
        return awaitTaskCompletion(requestId, sessionId, created.task.taskId, startCursor = created.task.lastSequence)
    }

    /** 发送失败（网络/REST 拒绝）：failed_send + 退避调度（1s/2s/4s/8s/15s/30s 封顶）。 */
    private suspend fun failSend(requestId: String, e: Exception) {
        runCatching {
            transitionOutbox(
                requestId,
                OutboxStateMachine.FAILED_SEND,
                errorCode = (e as? CompanionError)?.let { "companion_${it.javaClass.simpleName}" } ?: "network_error",
                errorMessage = e.message,
                countRetry = true,
            )
        }
    }

    /** 生成失败：failed_generation + 退避调度。 */
    private suspend fun failGeneration(requestId: String, errorCode: String, errorMessage: String?) {
        runCatching {
            transitionOutbox(
                requestId,
                OutboxStateMachine.FAILED_GENERATION,
                errorCode = errorCode,
                errorMessage = errorMessage,
                countRetry = true,
            )
        }
    }

    /**
     * F-02/F-04：v2 任务完成等待——REST 轮询 task 事件（PC 现阶段不广播 task:* 帧，
     * events 端点是权威通道；WS task:* 帧若到达，经 cursor 去重后同样驱动本地流式）。
     * cursor 按 [TaskCursorLogic] 三规则应用并持久化到 task_cursors（(deviceId, taskId)）。
     */
    private suspend fun awaitTaskCompletion(
        requestId: String,
        sessionId: String,
        taskId: String,
        startCursor: Long,
    ): Message {
        var cursor = startCursor
        val accumulated = StringBuilder()
        val deadline = nowMs() + TASK_POLL_TIMEOUT_MS
        while (true) {
            val api = api()
            val page = runCatching { api.getTaskEvents(taskId, afterSequence = cursor) }.getOrNull()
            var snapshot: TaskSnapshotDto? = null
            if (page != null) {
                val plan = TaskCursorLogic.planBatch(cursor, page.events.map { it.sequence })
                for (env in page.events) {
                    if (env.sequence > plan.appliedTo) break
                    when (env.type) {
                        TaskEventType.CHUNK -> env.chunkDelta?.let { delta ->
                            accumulated.append(delta)
                            // 本地注入流式 chunk（与 v1 ai:chunk 同构，VM 渲染路径复用）
                            localEvents.tryEmit(CompanionEvent.Chunk(requestId, sessionId, delta))
                        }
                        TaskEventType.USAGE -> Unit // 用量随最终消息落库，无需本地缓冲
                    }
                }
                if (plan.appliedTo != cursor) {
                    cursor = plan.appliedTo
                    persistCursor(deviceId = activeDeviceId(), taskId = taskId, sessionId = sessionId, lastSequence = cursor)
                }
                // 缺口/压缩 → checkpoint 兜底：读快照（最终结果），cursor 推进到快照 lastSequence
                if (plan.gapAt != null || TaskCursorLogic.needsSnapshotFallback(
                        cursor,
                        page.events.firstOrNull()?.sequence,
                        page.resyncRequired,
                        page.snapshot?.lastSequence,
                    )
                ) {
                    snapshot = runCatching { api.getTask(taskId).task }.getOrNull()
                    if (snapshot != null && snapshot.lastSequence > cursor) {
                        if (snapshot.accumulatedText.isNotEmpty() && accumulated.isBlank()) {
                            accumulated.append(snapshot.accumulatedText)
                        }
                        cursor = snapshot.lastSequence
                        persistCursor(deviceId = activeDeviceId(), taskId = taskId, sessionId = sessionId, lastSequence = cursor)
                    }
                }
            }
            // 终态检测：优先事件未覆盖时读快照（事件日志可能被压缩/尚未写出终态事件）
            val snap = snapshot ?: runCatching { api.getTask(taskId).task }.getOrNull()
            if (snap != null && snap.isTerminal) {
                return finishTask(requestId, sessionId, taskId, snap, accumulated.toString())
            }
            if (nowMs() >= deadline) {
                failGeneration(requestId, "TASK_TIMEOUT", "生成等待超时")
                throw CompanionError.Timeout("生成等待超时，请重试")
            }
            delay(TASK_POLL_INTERVAL_MS)
        }
    }

    /** 终态处理：completed → 解析最终消息；cancelled → 部分消息；failed/interrupted → failed_generation。 */
    private suspend fun finishTask(
        requestId: String,
        sessionId: String,
        taskId: String,
        snap: TaskSnapshotDto,
        accumulatedText: String,
    ): Message = when (snap.state) {
        "completed" -> {
            val message = resolveFinalMessage(sessionId, snap, accumulatedText)
            messageDao.upsertAll(listOf(message.toCache()))
            transitionOutbox(requestId, OutboxStateMachine.COMPLETED)
            message
        }
        "cancelled" -> {
            transitionOutbox(requestId, OutboxStateMachine.CANCELLED)
            // 保留已生成部分（对齐 PC cancelled.payload.partial 语义）
            val partial = Message(
                id = snap.assistantMessageId ?: "partial-$taskId",
                sessionId = sessionId,
                characterId = snap.characterId,
                role = Role.assistant,
                content = accumulatedText.ifBlank { snap.accumulatedText },
                timestamp = nowMs(),
            )
            messageDao.upsertAll(listOf(partial.toCache()))
            partial
        }
        else -> {
            val message = snap.error?.message ?: "生成失败"
            failGeneration(requestId, "task_${snap.state}", message)
            throw CompanionError.Unknown(message)
        }
    }

    /** 解析最终 AI 消息：assistantMessageId 精确匹配 → 内容匹配 → 最新 assistant 兜底 → 本地合成。 */
    private suspend fun resolveFinalMessage(sessionId: String, snap: TaskSnapshotDto, accumulatedText: String): Message {
        val recent = runCatching { api().listMessages(sessionId, limit = 20) }.getOrNull()?.messages ?: emptyList()
        return recent.firstOrNull { it.id == snap.assistantMessageId }
            ?: recent.firstOrNull { it.role == Role.assistant && it.content == (accumulatedText.ifBlank { snap.accumulatedText }) }
            ?: recent.firstOrNull { it.role == Role.assistant }
            ?: Message(
                id = snap.assistantMessageId ?: "task-${snap.taskId}",
                sessionId = sessionId,
                characterId = snap.characterId,
                role = Role.assistant,
                content = accumulatedText.ifBlank { snap.accumulatedText },
                timestamp = snap.finishedAt ?: nowMs(),
            )
    }

    /** F-02：cursor 持久化（deviceId 为空 = 无活跃连接，跳过——cursor 属于特定 PC）。 */
    private suspend fun persistCursor(deviceId: String?, taskId: String, sessionId: String, lastSequence: Long) {
        val device = deviceId ?: return
        runCatching {
            taskCursorDao.upsert(
                TaskCursorEntity(
                    deviceId = device,
                    taskId = taskId,
                    sessionId = sessionId,
                    lastSequence = lastSequence,
                    updatedAt = nowMs(),
                )
            )
        }
    }

    /**
     * 状态转换（F-04）：Room 事务内读取当前行 → [OutboxStateMachine.advance] → upsert。
     * 行不存在/非法转换静默忽略（幂等消费路径），错误已由调用方兜底。
     */
    private suspend fun transitionOutbox(
        requestId: String,
        to: String,
        errorCode: String? = null,
        errorMessage: String? = null,
        taskId: String? = null,
        remoteUserMessageId: String? = null,
        countRetry: Boolean = false,
    ) {
        runCatching {
            transactionRunner {
                val current = outboxDao.getById(requestId) ?: return@transactionRunner
                val next = OutboxStateMachine.advance(
                    current,
                    to,
                    nowMs(),
                    errorCode = errorCode,
                    errorMessage = errorMessage,
                    taskId = taskId,
                    remoteUserMessageId = remoteUserMessageId,
                    countRetry = countRetry,
                )
                outboxDao.upsert(next)
            }
        }
    }

    /** 供 ChatViewModel 观察：sessionId -> PendingMessage 列表（未完成态，仅当前活跃 PC 的行） */
    override fun observeOutbox(sessionId: String): Flow<List<com.qingyu.companion.model.PendingMessage>> {
        val device = connectionManager.activeConnection?.deviceId
        return outboxDao.observeForSession(sessionId).map { list ->
            list.filter {
                it.state != OutboxStateMachine.COMPLETED &&
                    (device == null || it.deviceId == device || it.deviceId == LEGACY_DEVICE_ID)
            }.map { it.toPending() }
        }
    }

    private fun OutboxMessage.toPending() = com.qingyu.companion.model.PendingMessage(
        requestId = requestId,
        content = content,
        timestamp = createdAt,
        failed = state in setOf(OutboxStateMachine.FAILED_SEND, OutboxStateMachine.FAILED_GENERATION),
        images = runCatching { json.decodeFromString<List<String>>(imagesJson) }.getOrDefault(emptyList()),
        replyToId = replyToId,
    )

    /** F-06：读取单条发件箱行（仅当前活跃设备的行对外可见；legacy 行不暴露——不得自动发送） */
    override suspend fun outboxEntry(requestId: String): com.qingyu.companion.model.PendingMessage? {
        val row = outboxDao.getById(requestId) ?: return null
        if (row.deviceId == LEGACY_DEVICE_ID) return null
        if (row.deviceId != activeDeviceId()) return null
        return row.toPending()
    }

    /**
     * F-06：App 重启/重连后恢复矩阵（按 requestId 幂等；不重发用户消息原则）：
     * - sending → queued（同一 requestId 重发；v1 PC 幂等窗口 60s 内去重，v2 幂等键持久去重）
     * - user_committed/awaiting_ai → 统一转 awaiting_ai；有 taskId 时查询 task 快照：
     *   completed → 落库最终消息并置 completed；failed/interrupted → failed_generation；
     *   cancelled → cancelled；其余保持 awaiting_ai 等待（重连后由重试/轮询继续）；
     *   无 taskId → 保持 awaiting_ai 等待或超时由用户重试（绝不重发用户消息）；
     * - failed_send/failed_generation/queued → 保持，由重连自动重试（退避 nextAttemptAt 调度）；
     * - completed → 保留短期审计记录（clearCompletedOutbox 清理）。
     * - legacy 行不处理（不自动发送），仅刷新 [pendingLegacyOutbox] 提示。
     */
    override suspend fun restoreOutbox() {
        val pending = outboxDao.listPending()
        for (item in pending) {
            if (item.deviceId == LEGACY_DEVICE_ID) continue
            when (item.state) {
                OutboxStateMachine.SENDING -> transitionOutbox(item.requestId, OutboxStateMachine.QUEUED)

                OutboxStateMachine.USER_COMMITTED -> transitionOutbox(item.requestId, OutboxStateMachine.AWAITING_AI)

                OutboxStateMachine.AWAITING_AI -> restoreGeneration(item)

                else -> Unit
            }
        }
        _pendingLegacyOutbox.value = outboxDao.countLegacyPending() > 0
    }

    /** 恢复生成追踪：查询 task 快照终态并落库；查询失败保持 awaiting_ai（不重复用户消息）。 */
    private suspend fun restoreGeneration(item: OutboxMessage) {
        val taskId = item.taskId ?: return // 无 taskId：保持 awaiting_ai 等待
        val snapshot = taskSnapshotResolver(taskId) ?: return
        when {
            snapshot.state == "completed" -> {
                val message = resolveFinalMessage(item.sessionId, snapshot, snapshot.accumulatedText)
                messageDao.upsertAll(listOf(message.toCache()))
                transitionOutbox(item.requestId, OutboxStateMachine.COMPLETED)
            }
            snapshot.state == "cancelled" -> transitionOutbox(item.requestId, OutboxStateMachine.CANCELLED)
            snapshot.state == "failed" || snapshot.state == "interrupted" ->
                failGeneration(item.requestId, "task_${snapshot.state}", snapshot.error?.message ?: "生成失败")
            // 非终态（queued/preparing/streaming/...）：保持 awaiting_ai，等待后续轮询/重试
            else -> Unit
        }
    }

    /** F-06：取消——queued/sending 本地取消；user_committed/awaiting_ai 有 taskId 时同时请求 PC 取消。 */
    override suspend fun cancelOutbox(requestId: String): Boolean {
        val row = outboxDao.getById(requestId) ?: return false
        if (row.deviceId == LEGACY_DEVICE_ID) return false
        if (row.deviceId != activeDeviceId()) return false // 非 active 设备的行保持暂停
        if (row.state !in OutboxStateMachine.PENDING) return false
        // v2 任务：先请求 PC 取消（幂等），再本地置 cancelled
        if (row.taskId != null && row.state in setOf(OutboxStateMachine.USER_COMMITTED, OutboxStateMachine.AWAITING_AI)) {
            runCatching { api().cancelTask(row.taskId!!) }
        }
        return try {
            transitionOutbox(requestId, OutboxStateMachine.CANCELLED)
            true
        } catch (e: Exception) {
            false
        }
    }

    /** F-06：仅重试 AI 生成（不重发用户消息）。 */
    override suspend fun retryGeneration(requestId: String): Message {
        val row = outboxDao.getById(requestId)
            ?: throw CompanionError.Offline("该消息已不在发件箱中")
        if (row.deviceId == LEGACY_DEVICE_ID || row.deviceId != activeDeviceId()) {
            throw CompanionError.Offline("该消息不属于当前 PC")
        }
        val taskId = row.taskId
        if (taskId == null) {
            // 无 taskId：转 awaiting_ai 等待生成恢复（实现简单且不重复用户消息的路径）
            if (row.state == OutboxStateMachine.FAILED_GENERATION) {
                transitionOutbox(requestId, OutboxStateMachine.AWAITING_AI)
            }
            throw CompanionError.Unknown("生成任务未创建，请稍后重试")
        }
        val api = api()
        val resp = try {
            api.retryTask(taskId) // POST /api/v2/tasks/:taskId/retry（仅生成，不重发用户消息）
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failGeneration(requestId, "retry_failed", e.message)
            throw e.toCompanionError()
        }
        val newTaskId = resp.task.taskId.takeIf { it.isNotEmpty() } ?: taskId
        // 回到 awaiting_ai，等待新任务完成
        transitionOutbox(requestId, OutboxStateMachine.AWAITING_AI, taskId = newTaskId)
        runCatching { subscribeTaskEvents() }
        return awaitTaskCompletion(requestId, row.sessionId, newTaskId, startCursor = resp.task.lastSequence)
    }

    /** F-03：对账刷新——REST 重拉会话消息落缓存，并注入 SessionUpdated 驱动已打开页面刷新。 */
    override suspend fun refreshSession(sessionId: String): Boolean = try {
        listMessages(sessionId)
        localEvents.tryEmit(CompanionEvent.SessionUpdated(sessionId, "message"))
        true
    } catch (e: Exception) {
        false
    }

    /** F-04：legacy 归属修复（AppContainer.start 一次性调用）。 */
    override suspend fun repairLegacyOutbox(): Int {
        val device = activeDeviceId()
        val adopted = if (device != null) outboxDao.adoptLegacyPending(device, nowMs()) else 0
        _pendingLegacyOutbox.value = outboxDao.countLegacyPending() > 0
        return adopted
    }

    /** 清理已完成的 outbox（消息已 done） */
    override suspend fun clearCompletedOutbox(sessionId: String) {
        outboxDao.clearCompleted(sessionId)
    }

    override suspend fun editMessage(sessionId: String, messageId: String, content: String): Message = try {
        val message = api().editMessage(sessionId, messageId, SendMessageRequest(UUID.randomUUID().toString(), content))
        messageDao.upsertAll(listOf(message.toCache()))
        message
    } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun deleteMessage(sessionId: String, messageId: String) = try { api().deleteMessage(sessionId, messageId); messageDao.deleteById(messageId) } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun stopGeneration(requestId: String) {
        // v2 任务走 REST 取消；v1 保持 ai:stop WS 帧
        val row = outboxDao.getById(requestId)
        if (row?.taskId != null && row.state in setOf(OutboxStateMachine.USER_COMMITTED, OutboxStateMachine.AWAITING_AI)) {
            runCatching { api().cancelTask(row.taskId!!) }
            return
        }
        wsClient.stopGeneration(requestId)
    }

    override suspend fun swipe(sessionId: String, messageId: String, direction: Int): Message = try {
        val message = api().swipe(sessionId, messageId, direction)
        messageDao.upsertAll(listOf(message.toCache()))
        message
    } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun translate(sessionId: String, messageId: String): TranslateResponse = try { api().translate(sessionId, messageId) } catch (e: Exception) { throw e.toCompanionError() }

    // ---------- 角色 ----------

    override suspend fun listCharacters(): List<Character> = try { api().listCharacters() } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun activateCharacter(characterId: String): com.qingyu.companion.model.ActivateResponse = try { api().activateCharacter(characterId) } catch (e: Exception) { throw e.toCompanionError() }

    // ---------- 快捷回复 ----------

    override suspend fun listQuickReplies(characterId: String?): QuickReplyListResponse = try { api().listQuickReplies(characterId) } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun executeQuickReply(id: String): Boolean = try { api().executeQuickReply(id); true } catch (e: Exception) { throw e.toCompanionError() }

    // ---------- 用量与公告（阶段三只读） ----------

    override suspend fun usageSummary(): com.qingyu.companion.model.UsageSummaryResponse = try { api().usageSummary() } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun usageRecords(limit: Int): List<com.qingyu.companion.model.UsageRecordDto> = try { api().usageRecords(limit) } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun listAnnouncements(): com.qingyu.companion.model.AnnouncementPage = try { api().listAnnouncements() } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun fetchVersionInfo(): com.qingyu.companion.model.VersionInfo? = try { api().versionInfo() } catch (e: Exception) {
        val ce = e.toCompanionError()
        if (ce is CompanionError.Unauthorized || ce is CompanionError.IncompatibleVersion || ce is CompanionError.Offline || ce is CompanionError.Timeout) throw ce
        null
    }

    // ---------- 群聊（阶段二：查看与发言） ----------

    override suspend fun listGroups(): List<com.qingyu.companion.model.GroupChat> = try { api().listGroups() } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun listGroupSessions(groupId: String): List<com.qingyu.companion.model.GroupSession> = try { api().listGroupSessions(groupId) } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun listGroupMessages(groupId: String, sessionId: String): List<com.qingyu.companion.model.GroupMessage> = try { api().listGroupMessages(groupId, sessionId) } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun sendGroupMessage(
        groupId: String,
        sessionId: String,
        requestId: String,
        content: String,
    ): Boolean = try {
        val resp = api().sendGroupMessage(
            groupId,
            sessionId,
            com.qingyu.companion.model.GroupSendRequest(
                content = content,
                requestId = requestId,
            )
        )
        resp.ok
    } catch (e: Exception) { throw e.toCompanionError() }

    // ---------- 群聊操作 ----------

    override suspend fun createGroupSession(groupId: String): com.qingyu.companion.model.GroupSessionDto = try { api().createGroupSession(groupId) } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun renameGroupSession(groupId: String, sessionId: String, title: String) = try { api().renameGroupSession(groupId, sessionId, RenameSessionRequest(title)) } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun editGroupMessage(groupId: String, sessionId: String, messageId: String, content: String) = try { api().editGroupMessage(groupId, sessionId, messageId, com.qingyu.companion.model.GroupEditMessageRequest(content)) } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun deleteGroupMessage(groupId: String, sessionId: String, messageId: String) = try { api().deleteGroupMessage(groupId, sessionId, messageId) } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun groupAiReply(groupId: String, sessionId: String, speakerId: String?): Boolean = try { api().groupAiReply(groupId, sessionId, com.qingyu.companion.model.GroupAiReplyRequest(speakerId)); true } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun createGroup(name: String?, memberIds: List<String>): Boolean = try { api().createGroup(com.qingyu.companion.model.CreateGroupRequest(name, memberIds)); true } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun patchGroup(groupId: String, patch: Map<String, Any?>) = try {
        val body = buildJsonObject {
            patch.forEach { (k, v) ->
                when (v) {
                    is String -> put(k, JsonPrimitive(v))
                    is Boolean -> put(k, JsonPrimitive(v))
                    is Int -> put(k, JsonPrimitive(v))
                    is Long -> put(k, JsonPrimitive(v))
                    is Double -> put(k, JsonPrimitive(v))
                    null -> put(k, JsonNull)
                }
            }
        }
        api().patchGroup(groupId, body)
    } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun addGroupMembers(groupId: String, characterIds: List<String>) = try { api().addGroupMembers(groupId, com.qingyu.companion.model.GroupMembersRequest(characterIds)) } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun removeGroupMember(groupId: String, characterId: String) = try { api().removeGroupMember(groupId, characterId) } catch (e: Exception) { throw e.toCompanionError() }

    override suspend fun groupTranslate(groupId: String, sessionId: String, messageId: String): String? = try { api().groupTranslate(groupId, sessionId, messageId).translation } catch (e: Exception) {
        val ce = e.toCompanionError()
        if (ce is CompanionError.Unauthorized || ce is CompanionError.Offline || ce is CompanionError.Timeout) throw ce
        null
    }

    // ---------- 离线 ----------

    override suspend fun listCachedSessions(): List<SessionPreview> =
        sessionDao.listAll().map { it.toPreview() }

    override suspend fun listCachedMessages(sessionId: String): List<Message> =
        messageDao.listRecent(sessionId, MAX_CACHED_MESSAGES_PER_SESSION).map { it.toModel() }

    override suspend fun clearLocalCache() {
        sessionDao.clear()
        messageDao.clear()
        taskCursorDao.clear()
    }

    override suspend fun wipeLocalData() {
        sessionDao.clear()
        messageDao.clear()
        taskCursorDao.clear() // cursor 属纯缓存，随"退出时清除"一并清理（outbox 行保持原语义，不在本方法清理）
        connectionStore.wipe()
        // M-31 修复：断开活跃连接与 WS——此前只清存储，ConnectionManager 内存态与
        // WsClient 不受影响，WS 继续重连、已擦除的 JWT 继续发 REST 请求（“退出时清除”名存实亡）
        connectionManager.disconnectAll()
        _pendingLegacyOutbox.value = false
    }

    // ---------- 缓存写入 ----------

    private suspend fun cacheSessions(sessions: List<SessionPreview>) {
        sessionDao.upsertAll(sessions.map { it.toCache() })
        sessionDao.trimTo(CacheDatabase.MAX_CACHED_SESSIONS)
        // M-34 修复：裁剪后清理被删会话的孤儿消息（含聊天明文，防只增不减）
        messageDao.deleteOrphanMessages()
    }

    // ---------- F-01：task 订阅 ----------

    /** 连接建立后调用：capabilities 命中且缓存有会话时发送 task:subscribe（携带该 PC 的 cursor）。 */
    override suspend fun subscribeTaskEvents(): Boolean {
        val connection = connectionManager.activeConnection ?: return false
        if (ServerInfo.CAP_TASK_EVENTS_V2 !in connection.capabilities) return false
        val sessions = sessionDao.listAll().map { it.id }
        if (sessions.isEmpty()) return false
        val cursors = taskCursorDao.listForDevice(connection.deviceId)
            .associate { it.taskId to it.lastSequence }
        return wsClient.subscribeTasks(sessions, cursors)
    }

    // ---------- 映射 ----------

    private fun SessionPreview.toCache() = CachedSession(
        id = id,
        characterId = characterId,
        characterName = characterName,
        title = title,
        createdAt = createdAt,
        updatedAt = updatedAt,
        messageCount = messageCount,
        lastMessage = lastMessage,
    )

    private fun CachedSession.toPreview() = SessionPreview(
        id = id,
        characterId = characterId,
        characterName = characterName,
        title = title,
        createdAt = createdAt,
        updatedAt = updatedAt,
        messageCount = messageCount,
        lastMessage = lastMessage,
    )

    private fun Message.toCache() = CachedMessage(
        id = id,
        sessionId = sessionId,
        characterId = characterId,
        role = role.name,
        content = content,
        images = json.encodeToString(images),
        timestamp = timestamp,
        translation = translation,
        swipes = swipes?.let { json.encodeToString(it) },
        swipeIndex = swipeIndex,
        replyToId = replyToId,
        usage = usage?.let { json.encodeToString(it) },
    )

    private fun CachedMessage.toModel() = Message(
        id = id,
        sessionId = sessionId,
        characterId = characterId,
        role = runCatching { Role.valueOf(role) }.getOrDefault(Role.user),
        content = content,
        images = runCatching { json.decodeFromString<List<String>>(images) }.getOrDefault(emptyList()),
        timestamp = timestamp,
        translation = translation,
        swipes = swipes?.let { runCatching { json.decodeFromString<List<String>>(it) }.getOrNull() },
        swipeIndex = swipeIndex,
        replyToId = replyToId,
        usage = usage?.let {
            runCatching { json.decodeFromString<MessageUsage>(it) }.getOrNull()
        },
    )

    private companion object {
        const val MAX_CACHED_MESSAGES_PER_SESSION = 500

        /** F-04：无法确定归属的旧行标记（MIGRATION_4_5 回填默认值） */
        const val LEGACY_DEVICE_ID = "legacy"

        /** v2 任务轮询节奏/上限：PC 未广播 task:* 帧时 events 端点是权威通道 */
        const val TASK_POLL_INTERVAL_MS = 500L
        const val TASK_POLL_TIMEOUT_MS = 5 * 60 * 1000L
    }
}
