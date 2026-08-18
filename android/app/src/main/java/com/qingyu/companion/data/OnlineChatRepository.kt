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

    private suspend fun api(): QingyuApi =
        connectionManager.activeApi() ?: throw IllegalStateException("尚未连接任何 PC")

    // ---------- 会话 ----------

    override suspend fun listSessions(): List<SessionPreview> {
        val sessions = api().listSessions()
        cacheSessions(sessions)
        return sessions
    }

    override suspend fun createSession(characterId: String, title: String?, greeting: String?): SessionPreview {
        val session = api().createSession(
            com.qingyu.companion.model.CreateSessionRequest(characterId, title, greeting)
        )
        cacheSessions(listOf(session))
        return session
    }

    override suspend fun deleteSession(sessionId: String, characterId: String?) {
        api().deleteSession(sessionId, characterId)
        sessionDao.delete(sessionId)
        messageDao.deleteBySession(sessionId)
    }

    override suspend fun renameSession(sessionId: String, title: String) {
        api().renameSession(sessionId, RenameSessionRequest(title))
        sessionDao.upsert(
            sessionDao.listAll().firstOrNull { it.id == sessionId }
                ?.copy(title = title)
                ?: return
        )
    }

    // ---------- 快捷设置 ----------

    override suspend fun getSettings(): com.qingyu.companion.model.SettingsDto =
        api().getSettings()

    override suspend fun updateSettings(patch: Map<String, Any?>) {
        // Map<String, Any?> 无法直接序列化（Any 无 serializer），转换为 JsonObject
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
    }

    override suspend fun listLorebooks(): List<com.qingyu.companion.model.LorebookDto> =
        api().listLorebooks()

    override suspend fun listPresets(): List<com.qingyu.companion.model.PresetDto> =
        api().listPresets()

    override suspend fun getSessionLorebooks(sessionId: String): List<String> =
        api().getSessionLorebooks(sessionId).lorebookIds

    override suspend fun setSessionLorebooks(sessionId: String, lorebookIds: List<String>) {
        api().patchSessionLorebooks(sessionId, com.qingyu.companion.model.LorebooksResponse(lorebookIds))
    }

    override suspend fun getSessionPreset(sessionId: String): String? =
        api().getSessionPreset(sessionId).presetId

    override suspend fun setSessionPreset(sessionId: String, presetId: String?) {
        api().patchSessionPreset(sessionId, com.qingyu.companion.model.PresetResponse(presetId))
    }

    override suspend fun listModels(): List<String> =
        api().listModels().models

    override suspend fun clearChat(sessionId: String) {
        api().clearChat(sessionId)
        messageDao.deleteBySession(sessionId)
    }

    override suspend fun aiAssist(sessionId: String, type: String, content: String?): String =
        api().aiAssist(sessionId, com.qingyu.companion.model.AiAssistRequest(type, content)).text

    override suspend fun updatePreset(
        presetId: String,
        temperature: Double?,
        topP: Double?,
        maxTokens: Int?,
    ): String? {
        val resp = api().patchPreset(
            presetId,
            com.qingyu.companion.model.PresetPatchRequest(temperature, topP, maxTokens),
        )
        return resp.presetId
    }

    // ---------- 长记忆 ----------

    override suspend fun getSessionMemory(sessionId: String, characterId: String?): com.qingyu.companion.model.MemoryDto =
        api().getSessionMemory(sessionId, characterId)

    override suspend fun patchSessionMemory(
        sessionId: String,
        memoryEnabled: Boolean?,
        memoryMode: String?,
        autoMemoryInterval: Int?,
        characterId: String?,
    ) {
        api().patchSessionMemory(
            sessionId,
            characterId,
            com.qingyu.companion.model.MemoryPatchRequest(memoryEnabled, memoryMode, autoMemoryInterval),
        )
    }

    override suspend fun summarizeMemory(sessionId: String, characterId: String?): Pair<String, List<com.qingyu.companion.model.MemoryFactDto>> {
        val resp = api().summarizeMemory(sessionId, characterId)
        return resp.summary to resp.facts
    }

    override suspend fun getContextUsage(sessionId: String, characterId: String?): com.qingyu.companion.model.ContextUsageDto =
        api().getContextUsage(sessionId, characterId)

    // ---------- 消息 ----------

    override suspend fun listMessages(sessionId: String, beforeId: String?): MessagePage {
        val page = api().listMessages(sessionId, beforeId = beforeId)
        messageDao.upsertAll(page.messages.map { it.toCache() })
        messageDao.trimTo(sessionId, MAX_CACHED_MESSAGES_PER_SESSION)
        return page
    }

    override suspend fun sendMessage(
        sessionId: String,
        requestId: String,
        content: String,
        replyToId: String?,
        images: List<String>,
    ): Message {
        val message = api().sendMessage(sessionId, SendMessageRequest(requestId, content, replyToId, images))
        messageDao.upsertAll(listOf(message.toCache()))
        return message
    }

    override suspend fun editMessage(sessionId: String, messageId: String, content: String): Message {
        // 编辑沿用 SendMessageRequest（requestId 作幂等键，服务端忽略亦可）
        val message = api().editMessage(sessionId, messageId, SendMessageRequest(UUID.randomUUID().toString(), content))
        messageDao.upsertAll(listOf(message.toCache()))
        return message
    }

    override suspend fun deleteMessage(sessionId: String, messageId: String) {
        api().deleteMessage(sessionId, messageId)
        messageDao.deleteById(messageId)
    }

    override suspend fun stopGeneration(requestId: String) {
        wsClient.stopGeneration(requestId)
    }

    override suspend fun swipe(sessionId: String, messageId: String, direction: Int): Message {
        val message = api().swipe(sessionId, messageId, direction)
        messageDao.upsertAll(listOf(message.toCache()))
        return message
    }

    override suspend fun translate(sessionId: String, messageId: String): TranslateResponse =
        api().translate(sessionId, messageId)

    // ---------- 角色 ----------

    override suspend fun listCharacters(): List<Character> = api().listCharacters()

    override suspend fun activateCharacter(characterId: String): com.qingyu.companion.model.ActivateResponse =
        api().activateCharacter(characterId)

    // ---------- 快捷回复 ----------

    override suspend fun listQuickReplies(characterId: String?): QuickReplyListResponse =
        api().listQuickReplies(characterId)

    override suspend fun executeQuickReply(id: String): Boolean =
        runCatching { api().executeQuickReply(id) }.isSuccess

    // ---------- 用量与公告（阶段三只读） ----------

    override suspend fun usageSummary(): com.qingyu.companion.model.UsageSummaryResponse =
        api().usageSummary()

    override suspend fun usageRecords(limit: Int): List<com.qingyu.companion.model.UsageRecordDto> =
        api().usageRecords(limit)

    override suspend fun listAnnouncements(): com.qingyu.companion.model.AnnouncementPage =
        api().listAnnouncements()

    override suspend fun fetchVersionInfo(): com.qingyu.companion.model.VersionInfo? =
        runCatching { api().versionInfo() }.getOrNull()

    // ---------- 群聊（阶段二：查看与发言） ----------

    override suspend fun listGroups(): List<com.qingyu.companion.model.GroupChat> =
        api().listGroups()

    override suspend fun listGroupSessions(groupId: String): List<com.qingyu.companion.model.GroupSession> =
        api().listGroupSessions(groupId)

    override suspend fun listGroupMessages(groupId: String, sessionId: String): List<com.qingyu.companion.model.GroupMessage> =
        api().listGroupMessages(groupId, sessionId)

    override suspend fun sendGroupMessage(
        groupId: String,
        sessionId: String,
        requestId: String,
        content: String,
    ): Boolean {
        val resp = api().sendGroupMessage(
            groupId,
            sessionId,
            com.qingyu.companion.model.GroupSendRequest(
                content = content,
                requestId = requestId,
            )
        )
        return resp.ok
    }

    // ---------- 群聊操作 ----------

    override suspend fun createGroupSession(groupId: String): com.qingyu.companion.model.GroupSessionDto =
        api().createGroupSession(groupId)

    override suspend fun renameGroupSession(groupId: String, sessionId: String, title: String) {
        api().renameGroupSession(groupId, sessionId, RenameSessionRequest(title))
    }

    override suspend fun editGroupMessage(groupId: String, sessionId: String, messageId: String, content: String) {
        api().editGroupMessage(groupId, sessionId, messageId, com.qingyu.companion.model.GroupEditMessageRequest(content))
    }

    override suspend fun deleteGroupMessage(groupId: String, sessionId: String, messageId: String) {
        api().deleteGroupMessage(groupId, sessionId, messageId)
    }

    override suspend fun groupAiReply(groupId: String, sessionId: String, speakerId: String?): Boolean =
        runCatching { api().groupAiReply(groupId, sessionId, com.qingyu.companion.model.GroupAiReplyRequest(speakerId)) }.isSuccess

    override suspend fun createGroup(name: String?, memberIds: List<String>): Boolean =
        runCatching { api().createGroup(com.qingyu.companion.model.CreateGroupRequest(name, memberIds)) }.isSuccess

    override suspend fun patchGroup(groupId: String, patch: Map<String, Any?>) {
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
    }

    override suspend fun addGroupMembers(groupId: String, characterIds: List<String>) {
        api().addGroupMembers(groupId, com.qingyu.companion.model.GroupMembersRequest(characterIds))
    }

    override suspend fun removeGroupMember(groupId: String, characterId: String) {
        api().removeGroupMember(groupId, characterId)
    }

    override suspend fun groupTranslate(groupId: String, sessionId: String, messageId: String): String? =
        runCatching { api().groupTranslate(groupId, sessionId, messageId) }.getOrNull()?.translation

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
