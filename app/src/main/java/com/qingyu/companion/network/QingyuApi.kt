package com.qingyu.companion.network

import com.qingyu.companion.model.MessagePage
import com.qingyu.companion.model.PairRequest
import com.qingyu.companion.model.PairResponse
import com.qingyu.companion.model.QuickReplyListResponse
import com.qingyu.companion.model.RenameSessionRequest
import com.qingyu.companion.model.SendMessageRequest
import com.qingyu.companion.model.ServerInfo
import com.qingyu.companion.model.SessionPreview
import com.qingyu.companion.model.TranslateResponse
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

/**
 * REST API 定义（方案 §4.3）。
 * 所有端点校验 JWT（Authorization: Bearer），配对端点除外。
 * 版本化：/api/v1/ 前缀，启动时经 serverInfo 校验兼容性。
 */
interface QingyuApi {

    // ---------- 配对与握手 ----------

    @POST("api/v1/auth/pair")
    suspend fun pair(@Body request: PairRequest): PairResponse

    @GET("api/v1/server/info")
    suspend fun serverInfo(): ServerInfo

    // ---------- 角色 ----------

    @GET("api/v1/characters")
    suspend fun listCharacters(): List<com.qingyu.companion.model.Character>

    /** 切换当前角色（协议假设：POST /api/v1/characters/{id}/activate，返回 {ok, sessionId}） */
    @POST("api/v1/characters/{characterId}/activate")
    suspend fun activateCharacter(
        @Path("characterId") characterId: String,
    ): com.qingyu.companion.model.ActivateResponse

    // ---------- 会话 ----------

    @GET("api/v1/sessions")
    suspend fun listSessions(): List<SessionPreview>

    /** 新建对话（P0：安卓端「+」新建会话） */
    @POST("api/v1/sessions")
    suspend fun createSession(
        @Body body: com.qingyu.companion.model.CreateSessionRequest,
    ): SessionPreview

    /** 删除会话（characterId 用于多角色共用 sessionId 时精确定位） */
    @DELETE("api/v1/sessions/{sessionId}")
    suspend fun deleteSession(
        @Path("sessionId") sessionId: String,
        @Query("characterId") characterId: String? = null,
    )

    /** 重命名会话（协议假设：对齐 PC 侧 renameSession） */
    @PATCH("api/v1/sessions/{sessionId}")
    suspend fun renameSession(
        @Path("sessionId") sessionId: String,
        @Body body: RenameSessionRequest,
    )

    // ---------- 快捷设置（桥接层第一批端点） ----------

    /** 读取 PC 设置精简子集（不含敏感字段） */
    @GET("api/v1/settings")
    suspend fun getSettings(): com.qingyu.companion.model.SettingsDto

    /** 修改设置（白名单字段） */
    @PATCH("api/v1/settings")
    suspend fun patchSettings(
        @Body body: kotlinx.serialization.json.JsonObject,
    )

    /** 世界书列表 */
    @GET("api/v1/lorebooks")
    suspend fun listLorebooks(): List<com.qingyu.companion.model.LorebookDto>

    /** 预设列表（含内置） */
    @GET("api/v1/presets")
    suspend fun listPresets(): List<com.qingyu.companion.model.PresetDto>

    /** 会话激活的世界书 ID 列表 */
    @GET("api/v1/sessions/{sessionId}/lorebooks")
    suspend fun getSessionLorebooks(
        @Path("sessionId") sessionId: String,
    ): com.qingyu.companion.model.LorebooksResponse

    /** 修改会话世界书 */
    @PATCH("api/v1/sessions/{sessionId}/lorebooks")
    suspend fun patchSessionLorebooks(
        @Path("sessionId") sessionId: String,
        @Body body: com.qingyu.companion.model.LorebooksResponse,
    ): com.qingyu.companion.model.LorebooksResponse

    /** 当前会话预设（角色绑定优先，其次全局） */
    @GET("api/v1/sessions/{sessionId}/preset")
    suspend fun getSessionPreset(
        @Path("sessionId") sessionId: String,
    ): com.qingyu.companion.model.PresetResponse

    /** 切换会话预设（写全局 activePresetId） */
    @PATCH("api/v1/sessions/{sessionId}/preset")
    suspend fun patchSessionPreset(
        @Path("sessionId") sessionId: String,
        @Body body: com.qingyu.companion.model.PresetResponse,
    ): com.qingyu.companion.model.PresetResponse

    /** 拉取模型列表（用 PC 激活连接） */
    @GET("api/v1/ai/models")
    suspend fun listModels(): com.qingyu.companion.model.ModelListResponse

    /** 清空对话（对齐 PC 端 chat:clearChat） */
    @DELETE("api/v1/sessions/{sessionId}/messages")
    suspend fun clearChat(@Path("sessionId") sessionId: String)

    /** AI 输入辅助（continue=续写 / polish=润色） */
    @POST("api/v1/sessions/{sessionId}/ai-assist")
    suspend fun aiAssist(
        @Path("sessionId") sessionId: String,
        @Body body: com.qingyu.companion.model.AiAssistRequest,
    ): com.qingyu.companion.model.AiAssistResponse

    /** 修改预设采样参数（内置预设保存为副本） */
    @PATCH("api/v1/presets/{presetId}")
    suspend fun patchPreset(
        @Path("presetId") presetId: String,
        @Body body: com.qingyu.companion.model.PresetPatchRequest,
    ): com.qingyu.companion.model.PresetPatchResponse

    // ---------- 长记忆 ----------

    /** 读取会话记忆配置与内容 */
    @GET("api/v1/sessions/{sessionId}/memory")
    suspend fun getSessionMemory(
        @Path("sessionId") sessionId: String,
    ): com.qingyu.companion.model.MemoryDto

    /** 修改会话记忆配置 */
    @PATCH("api/v1/sessions/{sessionId}/memory")
    suspend fun patchSessionMemory(
        @Path("sessionId") sessionId: String,
        @Body body: com.qingyu.companion.model.MemoryPatchRequest,
    )

    /** 立即触发长记忆总结 */
    @POST("api/v1/sessions/{sessionId}/memory/summarize")
    suspend fun summarizeMemory(
        @Path("sessionId") sessionId: String,
    ): com.qingyu.companion.model.MemorySummaryResponse

    /** 上下文用量（≥0.85 预警） */
    @GET("api/v1/sessions/{sessionId}/context-usage")
    suspend fun getContextUsage(
        @Path("sessionId") sessionId: String,
    ): com.qingyu.companion.model.ContextUsageDto

    // ---------- 消息（cursor 分页，见方案 §4.3 分页策略） ----------

    @GET("api/v1/sessions/{sessionId}/messages")
    suspend fun listMessages(
        @Path("sessionId") sessionId: String,
        @Query("limit") limit: Int = DEFAULT_PAGE_SIZE,
        @Query("beforeId") beforeId: String? = null,
    ): MessagePage

    @POST("api/v1/sessions/{sessionId}/messages")
    suspend fun sendMessage(
        @Path("sessionId") sessionId: String,
        @Body request: SendMessageRequest,
    ): com.qingyu.companion.model.Message

    @PATCH("api/v1/sessions/{sessionId}/messages/{messageId}")
    suspend fun editMessage(
        @Path("sessionId") sessionId: String,
        @Path("messageId") messageId: String,
        @Body request: SendMessageRequest,
    ): com.qingyu.companion.model.Message

    @DELETE("api/v1/sessions/{sessionId}/messages/{messageId}")
    suspend fun deleteMessage(
        @Path("sessionId") sessionId: String,
        @Path("messageId") messageId: String,
    )

    /** swipe 切换候选（阶段二） */
    @POST("api/v1/sessions/{sessionId}/swipe")
    suspend fun swipe(
        @Path("sessionId") sessionId: String,
        @Query("messageId") messageId: String,
        @Query("direction") direction: Int,
    ): com.qingyu.companion.model.Message

    /** 触发 PC 侧翻译（阶段二） */
    @POST("api/v1/sessions/{sessionId}/translate")
    suspend fun translate(
        @Path("sessionId") sessionId: String,
        @Query("messageId") messageId: String,
    ): TranslateResponse

    // ---------- 快捷回复 ----------

    @GET("api/v1/quickReplies")
    suspend fun listQuickReplies(
        @Query("characterId") characterId: String? = null,
    ): QuickReplyListResponse

    /** 执行快捷回复（协议假设：宏展开/预设切换/命令执行均在 PC 侧完成） */
    @POST("api/v1/quickReplies/{id}/execute")
    suspend fun executeQuickReply(@Path("id") id: String): Unit

    // ---------- 用量与公告（阶段三只读） ----------

    @GET("api/v1/usage/summary")
    suspend fun usageSummary(): com.qingyu.companion.model.UsageSummaryResponse

    @GET("api/v1/usage/records")
    suspend fun usageRecords(
        @Query("limit") limit: Int = 20,
    ): List<com.qingyu.companion.model.UsageRecordDto>

    @GET("api/v1/announcements")
    suspend fun listAnnouncements(
        @Query("page") page: Int = 1,
        @Query("pageSize") pageSize: Int = 20,
    ): com.qingyu.companion.model.AnnouncementPage

    // ---------- 群聊（阶段二：查看与发言） ----------

    @GET("api/v1/groups")
    suspend fun listGroups(): List<com.qingyu.companion.model.GroupChat>

    @GET("api/v1/groups/{groupId}/sessions")
    suspend fun listGroupSessions(
        @Path("groupId") groupId: String,
    ): List<com.qingyu.companion.model.GroupSession>

    @GET("api/v1/groups/{groupId}/sessions/{sessionId}/messages")
    suspend fun listGroupMessages(
        @Path("groupId") groupId: String,
        @Path("sessionId") sessionId: String,
    ): List<com.qingyu.companion.model.GroupMessage>

    @POST("api/v1/groups/{groupId}/sessions/{sessionId}/messages")
    suspend fun sendGroupMessage(
        @Path("groupId") groupId: String,
        @Path("sessionId") sessionId: String,
        @Body body: com.qingyu.companion.model.GroupSendRequest,
    ): com.qingyu.companion.model.GroupSendResponse

    /** 新建群聊会话 */
    @POST("api/v1/groups/{groupId}/sessions")
    suspend fun createGroupSession(
        @Path("groupId") groupId: String,
    ): com.qingyu.companion.model.GroupSessionDto

    /** 重命名群聊会话 */
    @PATCH("api/v1/groups/{groupId}/sessions/{sessionId}")
    suspend fun renameGroupSession(
        @Path("groupId") groupId: String,
        @Path("sessionId") sessionId: String,
        @Body body: RenameSessionRequest,
    )

    /** 编辑群聊消息 */
    @PATCH("api/v1/groups/{groupId}/sessions/{sessionId}/messages/{messageId}")
    suspend fun editGroupMessage(
        @Path("groupId") groupId: String,
        @Path("sessionId") sessionId: String,
        @Path("messageId") messageId: String,
        @Body body: com.qingyu.companion.model.GroupEditMessageRequest,
    )

    /** 删除群聊消息 */
    @DELETE("api/v1/groups/{groupId}/sessions/{sessionId}/messages/{messageId}")
    suspend fun deleteGroupMessage(
        @Path("groupId") groupId: String,
        @Path("sessionId") sessionId: String,
        @Path("messageId") messageId: String,
    )

    /** 群聊 AI 回复（speakerId 空 = 轮转发言人） */
    @POST("api/v1/groups/{groupId}/sessions/{sessionId}/ai-reply")
    suspend fun groupAiReply(
        @Path("groupId") groupId: String,
        @Path("sessionId") sessionId: String,
        @Body body: com.qingyu.companion.model.GroupAiReplyRequest,
    ): com.qingyu.companion.model.GroupSendResponse

    /** 新建群聊 */
    @POST("api/v1/groups")
    suspend fun createGroup(
        @Body body: com.qingyu.companion.model.CreateGroupRequest,
    ): com.qingyu.companion.model.CreateGroupResponse

    /** 修改群聊设置 */
    @PATCH("api/v1/groups/{groupId}")
    suspend fun patchGroup(
        @Path("groupId") groupId: String,
        @Body body: kotlinx.serialization.json.JsonObject,
    )

    /** 添加群聊成员 */
    @POST("api/v1/groups/{groupId}/members")
    suspend fun addGroupMembers(
        @Path("groupId") groupId: String,
        @Body body: com.qingyu.companion.model.GroupMembersRequest,
    )

    /** 删除群聊成员 */
    @DELETE("api/v1/groups/{groupId}/members/{characterId}")
    suspend fun removeGroupMember(
        @Path("groupId") groupId: String,
        @Path("characterId") characterId: String,
    )

    /** 翻译群聊消息（POST .../translate?messageId=xxx） */
    @POST("api/v1/groups/{groupId}/sessions/{sessionId}/translate")
    suspend fun groupTranslate(
        @Path("groupId") groupId: String,
        @Path("sessionId") sessionId: String,
        @Query("messageId") messageId: String,
    ): com.qingyu.companion.model.TranslateResponse

    companion object {
        const val DEFAULT_PAGE_SIZE = 50
    }
}
