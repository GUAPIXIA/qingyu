package com.qingyu.companion.data

import com.qingyu.companion.model.Character
import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.Message
import com.qingyu.companion.model.MessagePage
import com.qingyu.companion.model.QuickReplyListResponse
import com.qingyu.companion.model.SessionPreview
import com.qingyu.companion.model.TranslateResponse
import com.qingyu.companion.network.WsClient
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * 数据仓库：UI 唯一数据入口。
 * 策略：在线走 REST + WS 推送增量更新；离线回退 Room 只读缓存。
 * 发消息带 requestId 幂等键（防弱网重发双条，方案 §4.3）。
 */
interface ChatRepository {

    /** WS 事件流（chunk/done/error/sessionUpdated），供 ViewModel 驱动流式与增量刷新 */
    val events: SharedFlow<CompanionEvent>

    /** 连接状态，供连接状态栏展示 */
    val connectionState: StateFlow<WsClient.State>

    // ---------- 会话 ----------

    suspend fun listSessions(): List<SessionPreview>

    /** 新建对话（P0：安卓端「+」新建会话；greeting 为选定的开场白，可空） */
    suspend fun createSession(characterId: String, title: String? = null, greeting: String? = null): SessionPreview

    /** 重命名会话（协议假设：PATCH /api/v1/sessions/:id，对齐 PC 侧 renameSession） */
    suspend fun renameSession(sessionId: String, title: String)

    /** 删除会话 */
    suspend fun deleteSession(sessionId: String, characterId: String? = null)

    // ---------- 快捷设置（世界书/预设/翻译语言） ----------

    /** 读取 PC 设置精简子集 */
    suspend fun getSettings(): com.qingyu.companion.model.SettingsDto

    /** 修改设置（白名单字段） */
    suspend fun updateSettings(patch: Map<String, Any?>)

    /** 世界书列表 */
    suspend fun listLorebooks(): List<com.qingyu.companion.model.LorebookDto>

    /** 预设列表（含内置） */
    suspend fun listPresets(): List<com.qingyu.companion.model.PresetDto>

    /** 会话激活的世界书 ID 列表 */
    suspend fun getSessionLorebooks(sessionId: String): List<String>

    /** 修改会话世界书 */
    suspend fun setSessionLorebooks(sessionId: String, lorebookIds: List<String>)

    /** 当前会话预设 */
    suspend fun getSessionPreset(sessionId: String): String?

    /** 切换会话预设 */
    suspend fun setSessionPreset(sessionId: String, presetId: String?)

    /** 拉取模型列表（用 PC 激活连接） */
    suspend fun listModels(): List<String>

    /** 清空对话（对齐 PC 端 chat:clearChat） */
    suspend fun clearChat(sessionId: String)

    /** AI 输入辅助（continue=续写 / polish=润色），返回生成的文本 */
    suspend fun aiAssist(sessionId: String, type: String, content: String?): String

    /** 修改预设采样参数；返回生效的预设 id（内置预设保存为副本时变化） */
    suspend fun updatePreset(
        presetId: String,
        temperature: Double? = null,
        topP: Double? = null,
        maxTokens: Int? = null,
    ): String?

    // ---------- 长记忆 ----------

    /** 读取会话记忆配置与内容 */
    suspend fun getSessionMemory(sessionId: String, characterId: String? = null): com.qingyu.companion.model.MemoryDto

    /** 修改会话记忆配置 */
    suspend fun patchSessionMemory(
        sessionId: String,
        memoryEnabled: Boolean? = null,
        memoryMode: String? = null,
        autoMemoryInterval: Int? = null,
        characterId: String? = null,
    )

    /** 立即触发长记忆总结，返回 (摘要, 事实) */
    suspend fun summarizeMemory(sessionId: String, characterId: String? = null): Pair<String, List<com.qingyu.companion.model.MemoryFactDto>>

    /** 上下文用量（≥0.85 预警） */
    suspend fun getContextUsage(sessionId: String, characterId: String? = null): com.qingyu.companion.model.ContextUsageDto

    // ---------- 消息 ----------

    /** 分页拉取（beforeId 游标），并写入本地缓存 */
    suspend fun listMessages(sessionId: String, beforeId: String? = null): MessagePage

    /** 发送用户消息（幂等键由调用方生成；replyToId 为引用回复目标，可空；images 为图片 base64） */
    suspend fun sendMessage(
        sessionId: String,
        requestId: String,
        content: String,
        replyToId: String? = null,
        images: List<String> = emptyList(),
    ): Message

    suspend fun editMessage(sessionId: String, messageId: String, content: String): Message

    suspend fun deleteMessage(sessionId: String, messageId: String)

    /** 停止当前生成（映射 PC 侧 abort） */
    suspend fun stopGeneration(requestId: String)

    /** swipe 切换候选回复（阶段二）；direction <0 上一候选、>0 下一候选 */
    suspend fun swipe(sessionId: String, messageId: String, direction: Int): Message

    /** 触发 PC 侧翻译（阶段二），返回译文与目标消息 ID */
    suspend fun translate(sessionId: String, messageId: String): TranslateResponse

    // ---------- 角色 ----------

    suspend fun listCharacters(): List<Character>

    /** 切换当前角色（协议假设：POST /api/v1/characters/{id}/activate，返回 {ok, sessionId}） */
    suspend fun activateCharacter(characterId: String): com.qingyu.companion.model.ActivateResponse

    // ---------- 快捷回复 ----------

    suspend fun listQuickReplies(characterId: String?): QuickReplyListResponse

    /** 执行快捷回复（协议假设：POST /api/v1/quickReplies/{id}/execute，宏展开在 PC 侧） */
    suspend fun executeQuickReply(id: String): Boolean

    // ---------- 用量与公告（阶段三只读） ----------

    suspend fun usageSummary(): com.qingyu.companion.model.UsageSummaryResponse

    suspend fun usageRecords(limit: Int): List<com.qingyu.companion.model.UsageRecordDto>

    suspend fun listAnnouncements(): com.qingyu.companion.model.AnnouncementPage

    /** 获取服务器最新版本信息（阶段三：走 PC 桥接层转发公告服务器；失败返回 null 不抛错） */
    suspend fun fetchVersionInfo(): com.qingyu.companion.model.VersionInfo?

    // ---------- 群聊（阶段二：查看与发言） ----------

    suspend fun listGroups(): List<com.qingyu.companion.model.GroupChat>

    suspend fun listGroupSessions(groupId: String): List<com.qingyu.companion.model.GroupSession>

    suspend fun listGroupMessages(groupId: String, sessionId: String): List<com.qingyu.companion.model.GroupMessage>

    suspend fun sendGroupMessage(
        groupId: String,
        sessionId: String,
        requestId: String,
        content: String,
    ): Boolean

    // ---------- 群聊操作 ----------

    /** 新建群聊会话 */
    suspend fun createGroupSession(groupId: String): com.qingyu.companion.model.GroupSessionDto

    /** 重命名群聊会话 */
    suspend fun renameGroupSession(groupId: String, sessionId: String, title: String)

    /** 编辑群聊消息 */
    suspend fun editGroupMessage(groupId: String, sessionId: String, messageId: String, content: String)

    /** 删除群聊消息 */
    suspend fun deleteGroupMessage(groupId: String, sessionId: String, messageId: String)

    /** 群聊 AI 回复（speakerId 空 = 轮转发言人），返回是否成功 */
    suspend fun groupAiReply(groupId: String, sessionId: String, speakerId: String? = null): Boolean

    /** 新建群聊，返回是否成功 */
    suspend fun createGroup(name: String?, memberIds: List<String>): Boolean

    /** 修改群聊设置 */
    suspend fun patchGroup(groupId: String, patch: Map<String, Any?>)

    /** 添加群聊成员 */
    suspend fun addGroupMembers(groupId: String, characterIds: List<String>)

    /** 删除群聊成员 */
    suspend fun removeGroupMember(groupId: String, characterId: String)

    /** 翻译群聊消息，返回译文 */
    suspend fun groupTranslate(groupId: String, sessionId: String, messageId: String): String?

    // ---------- 离线 ----------

    /** 断网时的只读回退（Room） */
    suspend fun listCachedSessions(): List<SessionPreview>

    suspend fun listCachedMessages(sessionId: String): List<Message>

    /** 仅清本地缓存（保留连接配置，方案 §6.9） */
    suspend fun clearLocalCache()

    /** "退出时清除"：清缓存 + 移除连接 */
    suspend fun wipeLocalData()
}
