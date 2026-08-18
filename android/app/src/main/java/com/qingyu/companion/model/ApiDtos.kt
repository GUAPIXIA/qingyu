package com.qingyu.companion.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

/**
 * REST 请求/响应 DTO（方案 §4.3 协议设计）。
 * 幂等键：发消息带客户端生成的 requestId，防弱网重发产生双条消息。
 */

/** POST /api/v1/sessions/:id/messages 请求 */
@Serializable
data class SendMessageRequest(
    /** 客户端生成的幂等键 */
    val requestId: String,
    val content: String,
    /** 引用回复的目标消息 ID */
    val replyToId: String? = null,
    /** 图片（base64，安卓端选图压缩后上传；PC 侧 images 为 base64 数组） */
    val images: List<String> = emptyList(),
)

/** 消息分页响应：cursor 仅在 REST 层实现，底层 IPC 不改 */
@Serializable
data class MessagePage(
    val messages: List<Message>,
    /** 下一页游标（更早消息的 beforeId），null 表示到头 */
    val nextCursor: String? = null,
)

/** POST /api/v1/sessions/:id/translate 响应 */
@Serializable
data class TranslateResponse(
    val messageId: String,
    val translation: String,
)

/** 版本协商：响应头 X-Api-Version 之外，握手端点返回兼容性信息 */
@Serializable
data class ServerInfo(
    val apiVersion: Int,
    val appVersion: String,
)

/** PATCH /api/v1/sessions/:id 请求（重命名，协议假设） */
@Serializable
data class RenameSessionRequest(
    val title: String,
)

/** POST /api/v1/characters/:id/activate 响应（协议假设） */
@Serializable
data class ActivateResponse(
    val ok: Boolean,
    val sessionId: String? = null,
)

/** POST /api/v1/sessions 请求（新建对话；greeting 为选定的开场白，可空） */
@Serializable
data class CreateSessionRequest(
    val characterId: String,
    val title: String? = null,
    val greeting: String? = null,
)

// ===================== 快捷设置面板 DTO（桥接层第一批端点） =====================

/** GET /api/v1/settings 响应：PC 设置的精简子集（不含 apiKey/连接配置等敏感字段） */
@Serializable
data class SettingsDto(
    val userName: String = "",
    val userDescription: String = "",
    val userPersona: String = "",
    val activePresetId: String? = null,
    val activeModel: String = "",
    val translationTargetLang: String = "中文",
    val streamOutput: Boolean = true,
    val autoScroll: Boolean = true,
    val showTokenCount: Boolean = false,
    val htmlRendering: Boolean = false,
    val imageGenAutoEnabled: Boolean = false,
    val imageGenSize: String = "1024x1024",
    val exampleDialogMode: String = "always",
    val lorebookRatio: Double = 0.3,
    val autoTitle: Boolean = true,
    val themeColor: String = "amber",
    val fontSize: String = "comfortable",
    val bubbleStyle: String = "round",
    val messageSpacing: Int = 0,
    val messageWidth: Int = 768,
    val authorNote: AuthorNoteDto? = null,
)

/** 作者注释（快捷设置面板只读展示） */
@Serializable
data class AuthorNoteDto(
    val enabled: Boolean = false,
    val text: String = "",
    val position: String = "top",
    val depth: Int = 0,
)

/** GET /api/v1/lorebooks 条目（列表精简版） */
@Serializable
data class LorebookDto(
    val id: String,
    val name: String,
    val description: String = "",
    val enabled: Boolean = true,
    val scanDepth: Int = 0,
    val entryCount: Int = 0,
)

/** GET /api/v1/presets 条目（含内置预设，仅参数不含提示词内容） */
@Serializable
data class PresetDto(
    val id: String,
    val name: String,
    val description: String = "",
    val isBuiltin: Boolean = false,
    val group: String = "",
    val temperature: Double = 1.0,
    val topP: Double = 1.0,
    val maxTokens: Int = 1024,
    val maxContext: Int = 4096,
    val contextTemplate: String = "",
)

/** GET/PATCH /api/v1/sessions/:id/lorebooks 响应与请求体 */
@Serializable
data class LorebooksResponse(
    val lorebookIds: List<String> = emptyList(),
)

/** GET/PATCH /api/v1/sessions/:id/preset 响应与请求体 */
@Serializable
data class PresetResponse(
    val presetId: String? = null,
)

/** GET /api/v1/ai/models 响应（PC 激活连接拉取） */
@Serializable
data class ModelListResponse(
    val models: List<String> = emptyList(),
)

/** POST /api/v1/sessions/:id/ai-assist 请求（续写/润色） */
@Serializable
data class AiAssistRequest(
    val type: String,
    val content: String? = null,
)

/** POST /api/v1/sessions/:id/ai-assist 响应 */
@Serializable
data class AiAssistResponse(
    val text: String = "",
)

/** PATCH /api/v1/presets/:id 请求（采样参数微调） */
@Serializable
data class PresetPatchRequest(
    val temperature: Double? = null,
    val topP: Double? = null,
    val maxTokens: Int? = null,
)

/** PATCH /api/v1/presets/:id 响应（内置预设保存为副本时 presetId 变化） */
@Serializable
data class PresetPatchResponse(
    val ok: Boolean = false,
    val presetId: String? = null,
    val createdCopy: Boolean = false,
)

/** GET /api/v1/sessions/:id/memory 响应（长记忆） */
@Serializable
data class MemoryDto(
    val memoryEnabled: Boolean = false,
    val memoryMode: String = "manual",
    val autoMemoryInterval: Int = 10,
    val memory: String = "",
    val memoryCurrentState: String = "",
    val memoryFacts: List<MemoryFactDto> = emptyList(),
    val memoryUpdatedAt: Long = 0,
    val messageCount: Int = 0,
)

/**
 * 长记忆事实：服务端 v1 的旧会话会返回字符串，新会话返回对象。
 * 该序列化器同时接收两种格式，让 Android 可与已存在的 PC 数据兼容。
 */
@Serializable(with = MemoryFactDtoSerializer::class)
data class MemoryFactDto(
    val id: String = "",
    val subject: String = "",
    val predicate: String = "",
    val value: String = "",
    val status: String = "active",
    val importance: Int = 3,
    val confidence: Double = 0.8,
    val sourceMessageIds: List<String> = emptyList(),
    val updatedAt: Long = 0,
) {
    val displayText: String
        get() = if (subject == "历史事实" && predicate == "内容") value
        else if (predicate.isBlank()) "$subject：$value"
        else "${subject}的${predicate}：$value"
}

@Serializable
private data class MemoryFactPayload(
    val id: String = "",
    val subject: String = "",
    val predicate: String = "",
    val value: String = "",
    val status: String = "active",
    val importance: Int = 3,
    val confidence: Double = 0.8,
    val sourceMessageIds: List<String> = emptyList(),
    val updatedAt: Long = 0,
)

object MemoryFactDtoSerializer : KSerializer<MemoryFactDto> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("MemoryFactDto")

    override fun deserialize(decoder: Decoder): MemoryFactDto {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("MemoryFactDto 仅支持 JSON")
        val element = input.decodeJsonElement()
        if (element is JsonPrimitive && element.isString) {
            val text = element.content
            return MemoryFactDto(
                id = "legacy-${text.hashCode()}",
                subject = "历史事实",
                predicate = "内容",
                value = text,
                confidence = 0.7,
            )
        }
        if (element !is JsonObject) throw SerializationException("无效的长记忆事实")
        val payload = input.json.decodeFromJsonElement(MemoryFactPayload.serializer(), element)
        return MemoryFactDto(
            id = payload.id,
            subject = payload.subject,
            predicate = payload.predicate,
            value = payload.value,
            status = payload.status,
            importance = payload.importance,
            confidence = payload.confidence,
            sourceMessageIds = payload.sourceMessageIds,
            updatedAt = payload.updatedAt,
        )
    }

    override fun serialize(encoder: Encoder, value: MemoryFactDto) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("MemoryFactDto 仅支持 JSON")
        output.encodeJsonElement(output.json.encodeToJsonElement(MemoryFactPayload(
            id = value.id,
            subject = value.subject,
            predicate = value.predicate,
            value = value.value,
            status = value.status,
            importance = value.importance,
            confidence = value.confidence,
            sourceMessageIds = value.sourceMessageIds,
            updatedAt = value.updatedAt,
        )))
    }
}

/** PATCH /api/v1/sessions/:id/memory 请求 */
@Serializable
data class MemoryPatchRequest(
    val memoryEnabled: Boolean? = null,
    val memoryMode: String? = null,
    val autoMemoryInterval: Int? = null,
)

/** POST /api/v1/sessions/:id/memory/summarize 响应 */
@Serializable
data class MemorySummaryResponse(
    val ok: Boolean = false,
    val summary: String = "",
    val facts: List<MemoryFactDto> = emptyList(),
)

/** GET /api/v1/sessions/:id/context-usage 响应（上下文用量，≥0.85 预警） */
@Serializable
data class ContextUsageDto(
    val used: Long = 0,
    val max: Long = 0,
    val ratio: Double = 0.0,
    val pct: Int = 0,
)

/** POST /api/v1/groups/:id/sessions 响应（新建群聊会话） */
@Serializable
data class GroupSessionDto(
    val id: String,
    val groupId: String,
    val title: String,
    val messageCount: Int = 0,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
)

/** PATCH /api/v1/groups/:id/sessions/:sid/messages/:mid 请求（编辑群聊消息） */
@Serializable
data class GroupEditMessageRequest(
    val content: String,
)

/** POST /api/v1/groups/:id/sessions/:sid/ai-reply 请求（群聊 AI 回复，speakerId 空=轮转） */
@Serializable
data class GroupAiReplyRequest(
    val speakerId: String? = null,
)

/** POST /api/v1/groups 请求（新建群聊） */
@Serializable
data class CreateGroupRequest(
    val name: String? = null,
    val memberIds: List<String> = emptyList(),
)

/** POST /api/v1/groups 响应 */
@Serializable
data class CreateGroupResponse(
    val id: String = "",
    val name: String = "",
    val memberIds: List<String> = emptyList(),
)

/** POST /api/v1/groups/:id/members 请求（添加成员） */
@Serializable
data class GroupMembersRequest(
    val characterIds: List<String> = emptyList(),
)
