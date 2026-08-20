package com.qingyu.companion.data

import com.qingyu.companion.model.Character
import com.qingyu.companion.model.Message
import com.qingyu.companion.model.MessagePage
import com.qingyu.companion.model.MessageUsage
import com.qingyu.companion.model.QuickReplyListResponse
import com.qingyu.companion.model.RenameSessionRequest
import com.qingyu.companion.model.Role
import com.qingyu.companion.model.SendMessageRequest
import com.qingyu.companion.model.SessionPreview
import com.qingyu.companion.model.TranslateResponse
import com.qingyu.companion.network.ConnectionManager
import com.qingyu.companion.network.QingyuApi
import com.qingyu.companion.network.WsClient
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.StateFlow
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
 * 流式数据（ai:chunk/ai:done/…）不经本仓库落库，而是经 [WsClient.events] 直接
 * 暴露给 ViewModel；本仓库只负责 REST 读写的落盘快照。
 */
class OnlineChatRepository(
    private val connectionManager: ConnectionManager,
    private val connectionStore: ConnectionStore,
    private val wsClient: WsClient,
    private val db: CacheDatabase,
    private val json: Json,
) : ChatRepository {

    override val events: SharedFlow<com.qingyu.companion.model.CompanionEvent> = wsClient.events
    override val connectionState: StateFlow<WsClient.State> = wsClient.state

    private val sessionDao = db.sessionDao()
    private val messageDao = db.messageDao()
    private val outboxDao = db.outboxDao()

    private suspend fun api(): QingyuApi =
        connectionManager.activeApi() ?: throw CompanionError.Offline("尚未连接任何 PC")

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

    override suspend fun sendMessage(
        sessionId: String,
        requestId: String,
        content: String,
        replyToId: String?,
        images: List<String>,
    ): Message {
        // 入队 queued（幂等：已存在则复用）
        val existing = runCatching { outboxDao.listForSession(sessionId).firstOrNull { it.requestId == requestId } }.getOrNull()
        if (existing == null) {
            outboxDao.upsert(
                OutboxMessage(
                    requestId = requestId,
                    sessionId = sessionId,
                    content = content,
                    imagesJson = json.encodeToString(images),
                    replyToId = replyToId,
                    createdAt = System.currentTimeMillis(),
                    retryCount = 0,
                    state = "queued",
                )
            )
        }
        // sending
        outboxDao.updateState(requestId, "sending", null, existing?.retryCount ?: 0)
        try {
            // awaiting_ai：用户消息已落盘，等待 AI（WS done）
            outboxDao.updateState(requestId, "awaiting_ai", null, existing?.retryCount ?: 0)
            val message = api().sendMessage(sessionId, SendMessageRequest(requestId, content, replyToId, images))
            messageDao.upsertAll(listOf(message.toCache()))
            outboxDao.updateState(requestId, "completed", null, existing?.retryCount ?: 0)
            outboxDao.delete(requestId)
            return message
        } catch (e: Exception) {
            val nextRetry = (existing?.retryCount ?: 0) + 1
            outboxDao.updateState(requestId, "failed", e.message, nextRetry)
            throw e.toCompanionError()
        }
    }

    /** 供 ChatViewModel 观察：sessionId -> PendingMessage 列表（queued/sending/awaiting_ai/failed） */
    override fun observeOutbox(sessionId: String): kotlinx.coroutines.flow.Flow<List<com.qingyu.companion.model.PendingMessage>> =
        outboxDao.observeForSession(sessionId).map { list ->
            list.filter { it.state != "completed" }.map {
                com.qingyu.companion.model.PendingMessage(
                    requestId = it.requestId,
                    content = it.content,
                    timestamp = it.createdAt,
                    failed = it.state == "failed",
                    images = runCatching { json.decodeFromString<List<String>>(it.imagesJson) }.getOrDefault(emptyList()),
                    replyToId = it.replyToId,
                )
            }
        }

    /** App 重启/重连后恢复：对未完成的 outbox 按 requestId 幂等重发（图片已落库，无需重新压缩） */
    override suspend fun restoreOutbox() {
        val pending = outboxDao.listPending()
        for (item in pending) {
            if (item.state == "failed" || item.state == "queued") {
                // 仅标记为 queued，等待 ViewModel 触发 retry（避免在 Repository 层隐式网络调用）
                outboxDao.updateState(item.requestId, "queued", null, item.retryCount)
            }
        }
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
    }

    override suspend fun wipeLocalData() {
        sessionDao.clear()
        messageDao.clear()
        connectionStore.wipe()
        // M-31 修复：断开活跃连接与 WS——此前只清存储，ConnectionManager 内存态与
        // WsClient 不受影响，WS 继续重连、已擦除的 JWT 继续发 REST 请求（“退出时清除”名存实亡）
        connectionManager.disconnectAll()
    }

    // ---------- 缓存写入 ----------

    private suspend fun cacheSessions(sessions: List<SessionPreview>) {
        sessionDao.upsertAll(sessions.map { it.toCache() })
        sessionDao.trimTo(CacheDatabase.MAX_CACHED_SESSIONS)
        // M-34 修复：裁剪后清理被删会话的孤儿消息（含聊天明文，防只增不减）
        messageDao.deleteOrphanMessages()
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
    }
}
