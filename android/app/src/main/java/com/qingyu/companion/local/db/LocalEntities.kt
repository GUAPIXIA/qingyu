package com.qingyu.companion.local.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * 阶段 3 S3-01：本地权威库 `qingyu-local.db` 的业务实体。
 *
 * 设计约束（阶段 3 文档 §2 S3-01）：
 * - 高频查询字段规范化为列；低频扩展保存受控 JSON（`*Json` 后缀列）。
 * - 大正文（消息正文、世界书条目）落在 Room；二进制与超大 payload 走 app-private files
 *   （`media_manifests.localPath` 只存相对路径，不存字节）。
 * - 所有外键与删除策略显式；不使用 destructive migration。
 * - DAO 不暴露给 UI，事务由 Repository 控制。
 * - 本库与旧 `qingyu-companion-cache` 完全独立；旧库只读导入（S3-02）。
 *
 * 版本：`version = 1` 为阶段 3 首次落地，尚未发货，因此不提供 1→N 迁移。
 */

// ---------------------------------------------------------------- 设备状态

@Entity(tableName = "local_device_state")
data class LocalDeviceStateEntity(
    @PrimaryKey val id: Int = 1,
    @ColumnInfo(name = "device_id") val deviceId: String,
    /** UInt64 十进制字符串；绝不经过 Long 有损转换（总方案 §6.2） */
    @ColumnInfo(name = "next_counter_text") val nextCounterText: String,
    @ColumnInfo(name = "migration_genesis_id") val migrationGenesisId: String? = null,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

// ---------------------------------------------------------------- 内容实体

/**
 * 阶段 5 S5-01：角色行的列名与规范 payload 的键名**不再一致**，这是有意的。
 *
 * `shared/contracts/schemas/character-payload.schema.json` 是 `additionalProperties:false` 的契约，
 * 键名为 `exampleDialog`/`boundLorebookIds`/`boundPresetId`（与 PC `shared/types.ts` 的 `Character` 同名）。
 * 阶段 3 曾把 Room 列名直接写进 journal，导致本机 envelope 会被共享 schema 判为非法；
 * S5-01 由 [com.qingyu.companion.local.domain.CharacterPayloadCodec] 做显式映射，
 * 不再让列名泄漏到跨端契约里。
 *
 * `example_dialogue_json` 是阶段 3 遗留（JSON 数组，且生成时只取首条，属于有损读法），
 * 保留只为让旧缓存导入结果继续可读；新写入一律走 `example_dialog` 规范文本（与 PC 同格式）。
 */
@Entity(
    tableName = "local_characters",
    indices = [Index("name")],
)
data class LocalCharacterEntity(
    @PrimaryKey val id: String,
    val name: String,
    val description: String = "",
    val personality: String = "",
    val scenario: String = "",
    @ColumnInfo(name = "first_message") val firstMessage: String = "",
    /** 示例对话 JSON 数组（阶段 3 遗留，仅供旧缓存导入结果读取） */
    @ColumnInfo(name = "example_dialogue_json") val exampleDialogueJson: String = "[]",
    @ColumnInfo(name = "avatar_path") val avatarPath: String? = null,
    @ColumnInfo(name = "background_path") val backgroundPath: String? = null,
    /** 角色卡扩展字段（Character Card V2/V3 透传） */
    @ColumnInfo(name = "extensions_json") val extensionsJson: String = "{}",
    @ColumnInfo(name = "lorebook_id") val lorebookId: String? = null,
    @ColumnInfo(name = "default_preset_id") val defaultPresetId: String? = null,
    @ColumnInfo(name = "default_persona_id") val defaultPersonaId: String? = null,
    @ColumnInfo(name = "imported_from") val importedFrom: String? = null,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
    // ---- 阶段 5 S5-01：Character Card V1/V2/V3 全字段，缺失即「未设置」而非空覆盖 ----
    /** 规范示例对话文本（`<START>` 分段），与 PC `exampleDialog` 同格式 */
    @ColumnInfo(name = "example_dialog") val exampleDialog: String = "",
    /** 备选开场白（`alternate_greetings`） */
    @ColumnInfo(name = "alternate_greetings_json") val alternateGreetingsJson: String = "[]",
    /** 群聊专用开场白（`group_only_greetings`） */
    @ColumnInfo(name = "group_only_greetings_json") val groupOnlyGreetingsJson: String = "[]",
    /** 角色级系统提示词（覆盖预设） */
    @ColumnInfo(name = "system_prompt") val systemPrompt: String = "",
    /** 对话历史后注入指令 */
    @ColumnInfo(name = "post_history_instructions") val postHistoryInstructions: String = "",
    /** 标签（最多 64 项） */
    @ColumnInfo(name = "tags_json") val tagsJson: String = "[]",
    val creator: String = "",
    /** 创作者备注（隐藏元数据，导入导出保留） */
    @ColumnInfo(name = "creator_notes") val creatorNotes: String = "",
    @ColumnInfo(name = "character_version") val characterVersion: String = "",
    /** 多世界书绑定（取代单 `lorebook_id`） */
    @ColumnInfo(name = "bound_lorebook_ids_json") val boundLorebookIdsJson: String = "[]",
    /** 角色级作者注释（受控 JSON；PC `authorNote`） */
    @ColumnInfo(name = "author_note_json") val authorNoteJson: String = "",
    /** 内嵌世界书（导入时提取出的规范 v2 文档 JSON；`""` = 无） */
    @ColumnInfo(name = "embedded_lorebook_json") val embeddedLorebookJson: String = "",
    /** 新建会话继承的长记忆默认；`""` = 未设置（跟随全局） */
    @ColumnInfo(name = "default_memory_mode") val defaultMemoryMode: String = "",
    @ColumnInfo(name = "default_memory_enabled") val defaultMemoryEnabled: Int = -1,
    @ColumnInfo(name = "default_memory_interval") val defaultMemoryInterval: Int = -1,
    /** 新建会话默认叙事模式；`""` = 跟随全局设置 */
    @ColumnInfo(name = "default_narrative_mode") val defaultNarrativeMode: String = "",
    /** 导入来源卡片的规范格式标记：v1 | v2 | v3 | bare（导出时按原格式回写） */
    @ColumnInfo(name = "card_spec_version") val cardSpecVersion: String = "",
    /** 翻译内容（UI 显示优先，AI 上下文仍用原文；导入导出必须往返） */
    @ColumnInfo(name = "translated_content_json") val translatedContentJson: String = "",
)

@Entity(tableName = "local_lorebooks")
data class LocalLorebookEntity(
    @PrimaryKey val id: String,
    val name: String,
    /** canonical v2 文档（含 entries） */
    @ColumnInfo(name = "canonical_json") val canonicalJson: String = "{}",
    @ColumnInfo(name = "schema_version") val schemaVersion: Int = 2,
    @ColumnInfo(name = "scan_depth") val scanDepth: Int? = null,
    @ColumnInfo(name = "token_budget") val tokenBudget: Int? = null,
    @ColumnInfo(name = "imported_from") val importedFrom: String? = null,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

/**
 * 阶段 5 S5-03：预设区分「内建」与「用户」两个分区（方案 S5-03 第一条）。
 * 内建预设不可删除、只读；`body_json` 沿用 PC `Preset` 结构，由
 * [com.qingyu.companion.chatcore.ChatPresetCompile] 消费，并由 `PresetCodec` 负责 normalize。
 */
@Entity(
    tableName = "local_presets",
    indices = [Index("sort_index")],
)
data class LocalPresetEntity(
    @PrimaryKey val id: String,
    val name: String,
    /** 预设参数与提示词集合（受控 JSON；阶段 5 冻结为 PC `Preset` 结构） */
    @ColumnInfo(name = "body_json") val bodyJson: String = "{}",
    @ColumnInfo(name = "is_default") val isDefault: Boolean = false,
    @ColumnInfo(name = "imported_from") val importedFrom: String? = null,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
    @ColumnInfo(name = "is_builtin") val isBuiltin: Boolean = false,
    val description: String = "",
    @ColumnInfo(name = "sort_index") val sortIndex: Int = 0,
    /** 启用开关（内建/用户同权；关闭后不出现在选择列表） */
    val enabled: Boolean = true,
)

/**
 * 阶段 5 S5-04：人设头像与注入范围。
 * `avatarPath` 为 app-private 相对路径（二进制不入库，与 `media_manifests` 同规则）。
 */
@Entity(tableName = "local_personas")
data class LocalPersonaEntity(
    @PrimaryKey val id: String,
    val name: String,
    val description: String = "",
    val persona: String = "",
    @ColumnInfo(name = "is_default") val isDefault: Boolean = false,
    @ColumnInfo(name = "imported_from") val importedFrom: String? = null,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
    @ColumnInfo(name = "avatar_path") val avatarPath: String? = null,
)

@Entity(
    tableName = "local_regex_rules",
    indices = [Index("sort_index")],
)
data class LocalRegexRuleEntity(
    @PrimaryKey val id: String,
    val name: String,
    val pattern: String,
    val replacement: String = "",
    val flags: String = "g",
    /** input | output | both —— 与 PC `RegexRule.scope` 同枚举；空串按 output 解析 */
    val scope: String = "output",
    val enabled: Boolean = true,
    @ColumnInfo(name = "sort_index") val sortIndex: Int = 0,
    @ColumnInfo(name = "imported_from") val importedFrom: String? = null,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
    // ---- 阶段 5 S5-05：PC `RegexRule` 的其余业务字段（这些**进入**同步 payload） ----
    /** 分组名（翻译修复 / 格式清理 / 越狱清理…；空 = 未分组） */
    val group: String = "",
    /** text = 生成/输入文本；markdown = 渲染前文本（仅 output，在 text 规则之后） */
    val stage: String = "text",
    /** 触发条件正则（空 = 总是执行） */
    @ColumnInfo(name = "trigger_pattern") val triggerPattern: String = "",
    @ColumnInfo(name = "trigger_flags") val triggerFlags: String = "",
    /** 停止字符串（output 命中后截断，可多条） */
    @ColumnInfo(name = "stop_strings_json") val stopStringsJson: String = "[]",
    // ---- 本地元数据：不进入同步 payload ----
    /** 导入来源平台（sillytavern | agnai | …），用于兼容性提示 */
    @ColumnInfo(name = "source_format") val sourceFormat: String = "",
    /** 非共通正则特性的兼容性提示（方案 S5-05「不静默改变含义」） */
    @ColumnInfo(name = "compat_notes_json") val compatNotesJson: String = "[]",
)

/**
 * 阶段 5 S5-06：快捷回复以「集合」为单位，且区分全局与角色级。
 * `characterId == null` 表示全局集合；否则绑定到该角色（PC `QuickReplyStore` 的 character 维度）。
 */
@Entity(
    tableName = "local_quick_reply_sets",
    indices = [Index("character_id"), Index("sort_index")],
)
data class LocalQuickReplySetEntity(
    @PrimaryKey val id: String,
    val name: String,
    /** 快捷回复条目 JSON 数组（`QuickReplyItem[]`，与 PC 同结构） */
    @ColumnInfo(name = "items_json") val itemsJson: String = "[]",
    val enabled: Boolean = true,
    @ColumnInfo(name = "sort_index") val sortIndex: Int = 0,
    @ColumnInfo(name = "imported_from") val importedFrom: String? = null,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
    @ColumnInfo(name = "character_id") val characterId: String? = null,
)

@Entity(tableName = "local_groups")
data class LocalGroupEntity(
    @PrimaryKey val id: String,
    val name: String,
    /** sequential | round_robin | manual */
    val mode: String = "sequential",
    @ColumnInfo(name = "character_ids_json") val characterIdsJson: String = "[]",
    @ColumnInfo(name = "memory_enabled") val memoryEnabled: Boolean = false,
    @ColumnInfo(name = "avatar_path") val avatarPath: String? = null,
    @ColumnInfo(name = "imported_from") val importedFrom: String? = null,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
    // ---- 阶段 6 S6-01（v5）：群调度参数（对齐 PC `GroupChat`） ----
    /**
     * 发言调度模式：`mention` | `polling` | `free`（PC `GroupChat.chatMode`）。
     *
     * 与旧 [mode] 列（sequential|round_robin|manual，旧缓存来源）**不是同一套枚举**：
     * 旧列保留仅作迁移溯源，业务一律读本列；缺省 `polling` 与 PC 新建群默认一致。
     */
    @ColumnInfo(name = "chat_mode") val chatMode: String = "polling",
    /** polling 模式是否自动接力（PC `autoMode`）。 */
    @ColumnInfo(name = "auto_mode") val autoMode: Boolean = false,
    /** 自动接力的最大 AI 轮数（PC `maxRounds`，UI 1-5；语义见 group-scheduling fixture）。 */
    @ColumnInfo(name = "max_rounds") val maxRounds: Int = 1,
    /** 接力间隔毫秒（PC `speakerInterval`，UI 500-5000）。 */
    @ColumnInfo(name = "speaker_interval") val speakerInterval: Int = 2000,
    /**
     * 轮转发言索引（PC `currentSpeakerIndex`）。
     * PC 上是**纯运行时状态不落盘**；Android 落盘以便冷启动恢复轮转位置
     * （不影响同步 payload——群调度参数两端都不进契约）。
     */
    @ColumnInfo(name = "current_speaker_index") val currentSpeakerIndex: Int = 0,
    /** 群预设（PC `presetId`，新建默认 `builtin-default`）。 */
    @ColumnInfo(name = "preset_id") val presetId: String? = null,
    /** 群自定义系统提示（PC `systemPrompt`，支持变量与宏）。 */
    @ColumnInfo(name = "system_prompt") val systemPrompt: String = "",
    /** 群级世界书 id 数组（PC `lorebookIds`）。 */
    @ColumnInfo(name = "lorebook_ids_json") val lorebookIdsJson: String = "[]",
    /** 新建群会话的默认叙事模式（PC `defaultNarrativeMode`）；空串 = 跟随全局默认。 */
    @ColumnInfo(name = "default_narrative_mode") val defaultNarrativeMode: String = "",
)

// ---------------------------------------------------------------- 会话 / 消息

@Entity(
    tableName = "local_sessions",
    foreignKeys = [
        ForeignKey(
            entity = LocalCharacterEntity::class,
            parentColumns = ["id"],
            childColumns = ["character_id"],
            onDelete = ForeignKey.SET_NULL,
        ),
        ForeignKey(
            entity = LocalGroupEntity::class,
            parentColumns = ["id"],
            childColumns = ["group_id"],
            onDelete = ForeignKey.SET_NULL,
        ),
    ],
    indices = [Index("character_id"), Index("group_id"), Index("updated_at")],
)
data class LocalSessionEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "character_id") val characterId: String? = null,
    @ColumnInfo(name = "group_id") val groupId: String? = null,
    val title: String = "",
    @ColumnInfo(name = "persona_id") val personaId: String? = null,
    @ColumnInfo(name = "preset_id") val presetId: String? = null,
    @ColumnInfo(name = "lorebook_ids_json") val lorebookIdsJson: String = "[]",
    @ColumnInfo(name = "imported_from") val importedFrom: String? = null,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
    /**
     * 阶段 4 S4-05：会话级长记忆开关与策略。
     *
     * 放在会话行（而不是记忆状态行）：即使记忆尚未生成过（没有状态行），
     * 用户也可能已经打开了开关——「开启但还没有内容」是一个合法状态。
     */
    @ColumnInfo(name = "memory_enabled") val memoryEnabled: Boolean = false,
    /** manual | auto */
    @ColumnInfo(name = "memory_mode") val memoryMode: String = "manual",
    /** 自动总结间隔（消息条数）。 */
    @ColumnInfo(name = "auto_memory_interval") val autoMemoryInterval: Int = 10,
    /**
     * 阶段 4 S4-04（v3）：会话级叙事模式。
     *
     * `immersive`（代入式）| `omniscient`（全局叙事）。空串表示「未设置」，
     * 由装配器回退到全局默认再回退到 `immersive`——与 PC 的三层回退一致。
     * 此前该字段**只存在于装配器输入**，本地无处持久化，导致「会话级叙事模式」无法生效。
     */
    @ColumnInfo(name = "narrative_mode") val narrativeMode: String = "",
    /** 会话级回复篇幅意图（v3）：auto | brief | balanced | detailed；空串 = 未设置。 */
    @ColumnInfo(name = "response_length_mode") val responseLengthMode: String = "",
    /**
     * 世界书近因窗口（v3）：最近若干轮触发过的条目 key（JSON 数组的数组）。
     *
     * 没有它，`ChatLorebookRuntime` 的 recency 加权永远为 0——
     * 运行时**已经支持**该输入，但一直拿不到数据，属于「接了能力却没接数据」。
     */
    @ColumnInfo(name = "recent_triggered_ids_json") val recentTriggeredIdsJson: String = "[]",
    /** 世界书超限压缩缓存（v3）：压缩键 → 缓存摘要（JSON 对象）。 */
    @ColumnInfo(name = "lorebook_compression_cache_json") val lorebookCompressionCacheJson: String = "{}",
    /** 历史压缩摘要（v3）：裁剪掉的历史被压缩后的摘要文本。 */
    @ColumnInfo(name = "compressed_summary") val compressedSummary: String = "",
    /** 历史压缩覆盖范围（v3）：JSON `{"startTs":..,"endTs":..}`，空串 = 无。 */
    @ColumnInfo(name = "compressed_range_json") val compressedRangeJson: String = "",
    /**
     * 会话级「下一步方向」开关（v5，阶段 6 S6-01；单聊/群聊会话共用——PC 的
     * `ChatSession.dialogueDirectionsEnabled` 与 `GroupSession.dialogueDirectionsEnabled` 同名同义）。
     */
    @ColumnInfo(name = "dialogue_directions_enabled") val dialogueDirectionsEnabled: Boolean = false,
)

/**
 * 消息采用顺序列 `seq` 而不是 `timestamp` 排序：
 * 阶段 3 只负责落库与稳定排序，逻辑时间注入由阶段 4 生成闭环决定。
 * 展示顺序 = (logicalTime, id)（总方案 §6.3）。
 */
@Entity(
    tableName = "local_messages",
    foreignKeys = [
        ForeignKey(
            entity = LocalSessionEntity::class,
            parentColumns = ["id"],
            childColumns = ["session_id"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("session_id"), Index(value = ["session_id", "seq"], unique = true)],
)
data class LocalMessageEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "session_id") val sessionId: String,
    @ColumnInfo(name = "character_id") val characterId: String? = null,
    /** user | assistant | system */
    val role: String,
    val content: String = "",
    @ColumnInfo(name = "images_json") val imagesJson: String = "[]",
    @ColumnInfo(name = "reply_to_id") val replyToId: String? = null,
    @ColumnInfo(name = "swipes_json") val swipesJson: String? = null,
    @ColumnInfo(name = "swipe_index") val swipeIndex: Int? = null,
    val translation: String? = null,
    @ColumnInfo(name = "usage_json") val usageJson: String? = null,
    @ColumnInfo(name = "generation_status") val generationStatus: String? = null,
    @ColumnInfo(name = "generation_notice") val generationNotice: String? = null,
    @ColumnInfo(name = "generation_error") val generationError: String? = null,
    @ColumnInfo(name = "logical_time") val logicalTime: Long,
    @ColumnInfo(name = "seq") val seq: Long,
    @ColumnInfo(name = "imported_from") val importedFrom: String? = null,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
    /**
     * 阶段 6 S6-01（v5）：消息身份三键（对齐 PC `Message.speakerKind/generationKind/narrativeMode`）。
     *
     * 可空 = 「未设置」，payload 按 PC 的 `typeof === 'string'` 语义**不下发**——
     * 补上这三列后 `message` 的同步 payload 缺口（PC_ONLY_KEYS）清零。
     */
    @ColumnInfo(name = "speaker_kind") val speakerKind: String? = null,
    @ColumnInfo(name = "generation_kind") val generationKind: String? = null,
    @ColumnInfo(name = "narrative_mode") val narrativeMode: String? = null,
)

/**
 * 阶段 6 S6-01（v5）：群聊消息表（对齐 PC `GroupMessage`；PC 存 `groups/<gid>/<sid>.jsonl`）。
 *
 * 与 [LocalMessageEntity] 分表：群消息的**业务列不同**（round / speaker_kind /
 * mentioned_ids / dialogue_directions 等归属与调度字段），揉进单聊表会让两套语义
 * 互相踩字段；分表也让「消息条数/排序」各按各的口径（群按 (logicalTime, id) 稳定排序）。
 */
@Entity(
    tableName = "local_group_messages",
    foreignKeys = [
        ForeignKey(
            entity = LocalSessionEntity::class,
            parentColumns = ["id"],
            childColumns = ["session_id"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("session_id"), Index(value = ["session_id", "seq"], unique = true)],
)
data class LocalGroupMessageEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "session_id") val sessionId: String,
    /** 冗余群 id（PC `GroupMessage.groupId`；导出与 payload 需要，不靠 JOIN）。 */
    @ColumnInfo(name = "group_id") val groupId: String,
    /**
     * 归属：角色 id，或哨兵 `__user__` / `__free__`（未拆分自由发言占位）/ `__narrator__`。
     * 与 PC `GroupMessage.characterId` 同语义（消息归属的关键字段）。
     */
    @ColumnInfo(name = "character_id") val characterId: String,
    val content: String = "",
    @ColumnInfo(name = "images_json") val imagesJson: String = "[]",
    /** 轮次号（PC `GroupMessage.round`）：用户消息与其触发的 AI 回复共用一轮。 */
    val round: Int = 0,
    val translation: String? = null,
    @ColumnInfo(name = "reply_to_id") val replyToId: String? = null,
    /** 用户消息发送状态：sending | sent（PC `status`）。 */
    val status: String? = null,
    /** @提及的角色 id 数组（PC `mentionedCharacterIds`；仅元数据，不决定发言者）。 */
    @ColumnInfo(name = "mentioned_ids_json") val mentionedIdsJson: String = "[]",
    @ColumnInfo(name = "narrative_mode") val narrativeMode: String? = null,
    @ColumnInfo(name = "speaker_kind") val speakerKind: String? = null,
    @ColumnInfo(name = "generation_kind") val generationKind: String? = null,
    /** AI 回复后的下一步方向（PC `dialogueDirections`，JSON 数组）。 */
    @ColumnInfo(name = "dialogue_directions_json") val dialogueDirectionsJson: String? = null,
    @ColumnInfo(name = "dialogue_directions_generated_at") val dialogueDirectionsGeneratedAt: Long? = null,
    @ColumnInfo(name = "generation_notice") val generationNotice: String? = null,
    @ColumnInfo(name = "generation_error") val generationError: String? = null,
    @ColumnInfo(name = "content_render_mode") val contentRenderMode: String? = null,
    @ColumnInfo(name = "logical_time") val logicalTime: Long,
    @ColumnInfo(name = "seq") val seq: Long,
    @ColumnInfo(name = "imported_from") val importedFrom: String? = null,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

// ---------------------------------------------------------------- 记忆 / 用量 / 媒体

@Entity(tableName = "local_memory_states")
data class LocalMemoryStateEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "session_id") val sessionId: String,
    val summary: String = "",
    @ColumnInfo(name = "covered_through_seq") val coveredThroughSeq: Long = 0,
    @ColumnInfo(name = "budget_json") val budgetJson: String = "{}",
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
    /**
     * 阶段 4 S4-05：记忆版本（CAS 依据）。
     *
     * 语义逐条对齐 PC `updateSessionIfMemoryVersion`：写摘要前先读当前版本，
     * 提交时要求磁盘版本仍等于期望版本，否则**丢弃本次摘要**并上报 `stale_version`。
     * 这样「生成期间用户编辑了历史」不会让旧摘要覆盖新历史。
     */
    @ColumnInfo(name = "memory_version") val memoryVersion: Long = 0,
    /** 最近情节的即时状态（与时间线摘要分层注入）。 */
    @ColumnInfo(name = "current_state") val currentState: String = "",
    /**
     * 结构化事实与其历史（已对齐模型的规范 JSON）。
     *
     * 为什么不复用 `local_memory_facts` 扁平表：该表是阶段 3 的 subject/content 简表，
     * 缺少 predicate/status/importance/scope/entityId 等字段，无法表达 S4-05 已对齐的事实模型。
     * 规范模型以 JSON 存放于本行（CAS 的同一行、同一事务），扁平表保留兼容，后续收敛。
     */
    @ColumnInfo(name = "facts_json") val factsJson: String = "[]",
    @ColumnInfo(name = "history_json") val historyJson: String = "[]",
    /**
     * 派生记忆所基于的历史修订号。消息编辑/删除/清空会推进该值，
     * 使基于旧历史的摘要在提交时被判定为过期。
     */
    @ColumnInfo(name = "history_revision") val historyRevision: Long = 0,
    /**
     * 上次总结到的消息 id（游标）。只推进到**真正发送过并被总结**的位置，
     * 否则会永久漏掉一段对话；编辑历史后由修订号负责让摘要失效。
     */
    @ColumnInfo(name = "memory_last_message_id") val memoryLastMessageId: String? = null,
    /**
     * 事实段连续解析失败次数。达到阈值后按指数退避推迟重试版本，
     * 避免每一轮都花 token 去撞同一个格式问题。
     */
    @ColumnInfo(name = "fact_parse_failure_count") val factParseFailureCount: Int = 0,
    /** 允许重新尝试事实提案的记忆版本（未退避时为 0）。 */
    @ColumnInfo(name = "fact_retry_after_version") val factRetryAfterVersion: Long = 0,
)

@Entity(
    tableName = "local_memory_facts",
    indices = [Index("session_id"), Index("subject")],
)
data class LocalMemoryFactEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "session_id") val sessionId: String,
    val subject: String = "",
    val content: String = "",
    @ColumnInfo(name = "source_message_id") val sourceMessageId: String? = null,
    val confidence: Double? = null,
    @ColumnInfo(name = "created_at") val createdAt: Long,
)

/**
 * 阶段 5 S5-07 补充列：
 * - `status`：成功/失败分类（方案要求「按模型、角色、日期和成功/失败分类」）；
 *   失败调用也要记账，否则用量页只统计成功会让成本被系统性低估。
 * - `character_id`：按角色聚合；会话可被删除，因此这里存冗余角色 id 而不是靠 JOIN 会话。
 */
@Entity(
    tableName = "local_usage_records",
    indices = [Index("session_id"), Index("created_at"), Index("character_id"), Index("model")],
)
data class LocalUsageRecordEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "session_id") val sessionId: String? = null,
    @ColumnInfo(name = "message_id") val messageId: String? = null,
    val provider: String = "",
    val model: String = "",
    @ColumnInfo(name = "prompt_tokens") val promptTokens: Int = 0,
    @ColumnInfo(name = "completion_tokens") val completionTokens: Int = 0,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    /**
     * 阶段 4 S4-05：该条用量所属的生成任务类型（main/memory/translation/…）。
     * 记忆总结必须与聊天用量分开统计，否则「本轮聊天花了多少」会被记忆任务污染。
     */
    @ColumnInfo(name = "task_type") val taskType: String = "main",
    /**
     * S4-04 用量诊断：输入/输出**可见字符数**。
     *
     * 为什么同时存 token 与字符：PC 的用量记录以字符数为主体（`inputChars/outputChars/totalChars`），
     * 而 token 数依赖端点是否上报 usage。两者都留，界面才能显示真实数字，而不是用 token 猜字符。
     */
    @ColumnInfo(name = "input_chars") val inputChars: Int = 0,
    @ColumnInfo(name = "output_chars") val outputChars: Int = 0,
    /** success | error */
    val status: String = "success",
    @ColumnInfo(name = "character_id") val characterId: String? = null,
    /** 本地日期键（YYYY-MM-DD，按设备时区）；日期维度聚合直接走索引。 */
    @ColumnInfo(name = "date_key") val dateKey: String = "",
)

@Entity(
    tableName = "local_media_manifests",
    indices = [Index("owner_type", "owner_id")],
)
data class LocalMediaManifestEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "owner_type") val ownerType: String,
    @ColumnInfo(name = "owner_id") val ownerId: String,
    val kind: String = "",
    /** app-private files 相对路径；二进制不入库 */
    @ColumnInfo(name = "local_path") val localPath: String? = null,
    @ColumnInfo(name = "remote_url") val remoteUrl: String? = null,
    @ColumnInfo(name = "mime_type") val mimeType: String? = null,
    @ColumnInfo(name = "byte_size") val byteSize: Long = 0,
    /** sha256:...（解密后校验真实内容） */
    val hash: String = "",
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

// ---------------------------------------------------------------- 设置分区

/**
 * S3-04 `PublicSettings`：可同步的行为设置。
 * 当前以 (section, key) 行式存储，便于阶段 5/7 按字段分组做冲突展示。
 */
@Entity(
    tableName = "local_public_settings",
    primaryKeys = ["section", "key"],
)
data class LocalPublicSettingEntity(
    val section: String,
    val key: String,
    @ColumnInfo(name = "value_json") val valueJson: String,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

/** S3-04 `DeviceSettings`：主题跟随、通知、下载目录、性能档位等本机设置。 */
@Entity(
    tableName = "local_device_settings",
    primaryKeys = ["key"],
)
data class LocalDeviceSettingEntity(
    val key: String,
    @ColumnInfo(name = "value_json") val valueJson: String,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

// ---------------------------------------------------------------- 连接档案（本地，不同步）

@Entity(
    tableName = "local_connection_profiles",
    indices = [Index("sort_index")],
)
data class LocalConnectionProfileEntity(
    @PrimaryKey val id: String,
    /** openai | anthropic | gemini | ollama */
    val provider: String,
    @ColumnInfo(name = "base_url") val baseUrl: String,
    val model: String,
    @ColumnInfo(name = "display_name") val displayName: String = "",
    val enabled: Boolean = true,
    @ColumnInfo(name = "sort_index") val sortIndex: Int = 0,
    @ColumnInfo(name = "allow_http") val allowHttp: Boolean = false,
    /** 能力探测缓存（JSON；失败不影响连接） */
    @ColumnInfo(name = "capabilities_json") val capabilitiesJson: String = "{}",
    /** 仅引用 Keystore 别名；明文永不入库 */
    @ColumnInfo(name = "secret_ref") val secretRef: String? = null,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

// ---------------------------------------------------------------- 阶段 5 新增同步实体

/**
 * 阶段 5 S5-02 / 总方案 §6.1：`lorebook_mapping_template` 是**同步实体**，
 * 因此必须与业务写入同事务进 journal，不能只当本地导入配置。
 *
 * 首版 Android 只消费 PC 或导入产生的模板（方案 S5-02 明确允许），
 * 复杂模板的创建列入 P1；但存储与同步语义现在就要成立，否则阶段 7 无法拉平。
 *
 * `templateJson` 内的路径表达式是**受限 DSL**（方案 §S5-02 末句）：
 * 只允许 `field`/`index`/`const` 三类节点，由 `LorebookMappingTemplate` 解析器白名单校验，
 * 任何脚本、函数调用或表达式片段都在入库前拒绝——这里不存可执行代码。
 */
@Entity(
    tableName = "local_lorebook_mapping_templates",
    indices = [Index("name")],
)
data class LocalLorebookMappingTemplateEntity(
    @PrimaryKey val id: String,
    val name: String,
    /** 目标格式标识（sillytavern | character_book | lorebook_v3 | risu | agnai | novelai | native_v1） */
    @ColumnInfo(name = "source_format") val sourceFormat: String,
    /** 规范模板 JSON（受限 DSL；见类注释） */
    @ColumnInfo(name = "template_json") val templateJson: String = "{}",
    val enabled: Boolean = true,
    @ColumnInfo(name = "sort_index") val sortIndex: Int = 0,
    @ColumnInfo(name = "imported_from") val importedFrom: String? = null,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

/**
 * 阶段 5 S5-07 / 总方案 §6.3 `usage_clear_marker` 行。
 *
 * 主键是**设备 id**：多个 marker 逐设备取最大值（方案 §6.3），
 * 因此一台设备最多一个「当前」清理游标，`cleared_through_json` 保存该游标的版本向量
 * （counter 为 UInt64 十进制字符串）。只有被该向量**因果支配**的 usage_record 才可清除，
 * 并发产生的新记录必须保留——所以这里存的是向量而不是时间戳。
 *
 * 本表同时是 tombstone 记账：`tombstoned_ids_json` 记录已抹除的用量事件 id，
 * 防止长期离线设备把已清理事件重新带回（方案 §12「删除不会复活」）。
 */
@Entity(tableName = "local_usage_clear_markers")
data class LocalUsageClearMarkerEntity(
    @PrimaryKey @ColumnInfo(name = "device_id") val deviceId: String,
    @ColumnInfo(name = "cleared_through_json") val clearedThroughJson: String = "{}",
    @ColumnInfo(name = "tombstoned_ids_json") val tombstonedIdsJson: String = "[]",
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

// ---------------------------------------------------------------- 同步元数据

@Entity(
    tableName = "entity_heads",
    primaryKeys = ["entity_type", "entity_id"],
    indices = [Index("updated_at")],
)
data class EntityHeadEntity(
    @ColumnInfo(name = "entity_type") val entityType: String,
    @ColumnInfo(name = "entity_id") val entityId: String,
    /** 版本向量 JSON：{"deviceId":"counter"}，counter 为十进制字符串 */
    @ColumnInfo(name = "version_json") val versionJson: String,
    /** sha256:... 规范业务哈希（排除 updatedAt 等非业务字段） */
    val hash: String,
    val deleted: Boolean = false,
    /** 聚合删除围栏（总方案 §6.3 跨 ID 删除并发检测） */
    @ColumnInfo(name = "delete_fence_json") val deleteFenceJson: String? = null,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

@Entity(
    tableName = "change_log",
    indices = [Index("entity_type", "entity_id"), Index("origin")],
)
data class ChangeLogEntity(
    @PrimaryKey(autoGenerate = true) val seq: Long = 0,
    @ColumnInfo(name = "dot_device") val dotDevice: String,
    @ColumnInfo(name = "dot_counter") val dotCounter: String,
    @ColumnInfo(name = "entity_type") val entityType: String,
    @ColumnInfo(name = "entity_id") val entityId: String,
    val envelopeJson: String,
    /** local | remote | bootstrap | migration */
    val origin: String,
    @ColumnInfo(name = "recorded_at") val recordedAt: Long,
)

@Entity(tableName = "sync_receipts")
data class SyncReceiptEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "session_id") val sessionId: String,
    /** lan | server */
    val transport: String,
    @ColumnInfo(name = "peer_device_id") val peerDeviceId: String,
    /** 双方已知版本向量（JSON） */
    @ColumnInfo(name = "acknowledged_vectors_json") val acknowledgedVectorsJson: String = "{}",
    @ColumnInfo(name = "prepared_at") val preparedAt: Long? = null,
    @ColumnInfo(name = "committed_at") val committedAt: Long,
    @ColumnInfo(name = "audit_json") val auditJson: String = "{}",
)

@Entity(
    tableName = "conflicts",
    indices = [Index("entity_type", "entity_id"), Index("resolved")],
)
data class ConflictEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "entity_type") val entityType: String,
    @ColumnInfo(name = "entity_id") val entityId: String,
    /** version_divergence | delete_vs_update | parent_child_dependency | field_group */
    val kind: String,
    @ColumnInfo(name = "local_envelope_json") val localEnvelopeJson: String,
    @ColumnInfo(name = "remote_envelope_json") val remoteEnvelopeJson: String,
    @ColumnInfo(name = "detected_at") val detectedAt: Long,
    val resolved: Boolean = false,
    @ColumnInfo(name = "resolution_json") val resolutionJson: String? = null,
)

/**
 * 契约测试专用通用对象表（阶段 1 `shared/contracts/fixtures/repository/behavior-table.json`）。
 *
 * 行为表以语言无关的 `(entityType, entityId, payload)` 三元组描述仓储语义，
 * PC/内存/Room 三个实现都必须对同一份表给出一致结果。本表只承载该表中
 * 「任意 entityType」的 payload 落盘，**不参与任何业务查询**，也不进入同步 envelope。
 */
@Entity(tableName = "contract_objects")
data class ContractObjectEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "payload_json") val payloadJson: String,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)
