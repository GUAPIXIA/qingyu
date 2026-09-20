package com.qingyu.companion.local.domain

import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalLorebookEntity
import com.qingyu.companion.local.db.LocalLorebookMappingTemplateEntity
import com.qingyu.companion.local.db.LocalMessageEntity
import com.qingyu.companion.local.db.LocalPersonaEntity
import com.qingyu.companion.local.db.LocalPresetEntity
import com.qingyu.companion.local.db.LocalQuickReplySetEntity
import com.qingyu.companion.local.db.LocalRegexRuleEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.db.LocalUsageRecordEntity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

/**
 * 同步实体类型常量。
 *
 * 唯一来源是 `shared/contracts/sync-envelope.ts` 的 `ENTITY_TYPES`（16 项）与
 * `shared/contracts/schemas/sync-envelope.schema.json`。阶段 3 之前这些值以
 * 裸字符串散落在仓储实现里，任何一处拼错都会在阶段 7 变成「对端不认识该实体」，
 * 所以这里收口成编译期常量。
 */
object EntityTypes {
    const val SETTINGS_PUBLIC = "settings_public"
    const val CHARACTER = "character"
    const val LOREBOOK = "lorebook"
    const val PRESET = "preset"
    const val PERSONA = "persona"
    const val REGEX_RULE = "regex_rule"
    const val QUICK_REPLY_SET = "quick_reply_set"
    const val GROUP = "group"
    const val SESSION = "session"
    const val MESSAGE = "message"
    const val MEMORY_STATE = "memory_state"
    const val MEMORY_FACT = "memory_fact"
    const val USAGE_RECORD = "usage_record"
    const val MCP_PUBLIC_CONFIG = "mcp_public_config"
    const val MEDIA_MANIFEST = "media_manifest"
    const val LOREBOOK_MAPPING_TEMPLATE = "lorebook_mapping_template"
    const val USAGE_CLEAR_MARKER = "usage_clear_marker"
}

/**
 * PC 端使用的**固定实体 id**（不是每行一个 id）。
 *
 * 这两个常量是跨端一致性的关键：PC 把「整库快捷回复」和「整份公开设置」
 * 各当作一个实体记账，Android 早期按行/按键记账，两端 id 与 payload 粒度都不同，
 * 首次同步必然对同一份数据产生大量伪并发版本。粒度必须与 PC 对齐。
 */
object CanonicalEntityIds {
    /** `electron/ipc/quickReply.ts` 的 `QUICK_REPLY_ROOT_ID` */
    const val QUICK_REPLY_ROOT = "quick-replies-root"

    /** `electron/domain/bootstrapScanners.ts` 的 settings_public 实体 id */
    const val SETTINGS_PUBLIC = "settings-public"
}

/**
 * 阶段 5：跨端规范 payload 组装。
 *
 * **每个函数的键集合都必须与 PC 对应的 `*EntityPayload` 函数逐字一致**，因为
 * `contentHash` 是对该 Map 的 canonical JSON 求 sha256：多一个键、少一个键、
 * 或把 `null` 写成缺省，都会让同一份数据在两端得到不同哈希，
 * 于是「同内容并发版本」的收敛路径失效、用户看到满屏伪冲突（总方案 §12 验收项）。
 *
 * 对应的 PC 实现（改动任一侧都必须同步另一侧，并更新共享 fixture）：
 * - `electron/services/charCard.ts` → [characterPayload] / [lorebookPayload] / [regexRulePayload]
 * - `electron/ipc/persona.ts` → [personaPayload]
 * - `electron/ipc/preset.ts` → [presetPayload]
 * - `electron/ipc/quickReply.ts` → [quickReplyStorePayload]
 * - `electron/ipc/settings.ts` → [settingsPublicPayload]
 * - `electron/services/usage.ts` → [usageRecordPayload]
 * - `electron/services/lorebookMappingTemplates.ts` → [mappingTemplatePayload]
 */
object EntityPayloads {

    /**
     * 角色：与 PC `characterEntityPayload` 相同的**稀疏白名单**——
     * 只有 schema 定义且该端确实存在的字段才下发；`avatarBlobId` 需要 blob 通道，
     * PC 未实现因此不下发，Android 同样不下发（否则悬空引用 + 哈希不一致）。
     *
     * 角色的其余列（`creatorNotes`、`postHistoryInstructions`、`characterVersion`、
     * `groupOnlyGreetings`、`authorNote`、内嵌世界书、默认记忆策略等）是
     * **本地编辑与角色卡往返保真**用，不属于 `character-payload.schema.json`
     * （该 schema 是 `additionalProperties:false`）。把它们塞进 payload 会被共享
     * schema 判非法，也会让 PC 侧哈希对不上——所以这里明确排除，
     * 跨端保真由 Backup V3（S5-08）与角色卡导入导出（S5-01）承担。
     */
    fun characterPayload(row: LocalCharacterEntity): Map<String, Any?> {
        val payload = LinkedHashMap<String, Any?>()
        // PC 是 `card.name || '未命名角色'`：只有**空串**才兜底，纯空白名原样下发。
        // 这里曾用 `ifBlank`，于是「名字是几个空格」的角色在两端得到不同 payload → 不同
        // contentHash → 阶段 7 判成并发冲突。由 sync-payload fixture 的
        // `blank-name-falls-back`（下发 `"   "`）与 `empty-name`（下发 `未命名角色`）两条钉住。
        payload["name"] = row.name.ifEmpty { UNNAMED_CHARACTER }
        payload["description"] = row.description
        payload["personality"] = row.personality
        payload["scenario"] = row.scenario
        payload["firstMessage"] = row.firstMessage
        stringOf(row.exampleDialog)?.let { payload["exampleDialog"] = it }
        stringOf(row.systemPrompt)?.let { payload["systemPrompt"] = it }
        stringOf(row.creator)?.let { payload["creator"] = it }
        stringArray(row.tagsJson, MAX_TAGS)?.let { payload["tags"] = it }
        stringArray(row.alternateGreetingsJson, MAX_ALTERNATE_GREETINGS)?.let {
            payload["alternateGreetings"] = it
        }
        stringArray(row.boundLorebookIdsJson, MAX_BOUND_LOREBOOKS)?.let { payload["boundLorebookIds"] = it }
        payload["boundPresetId"] = row.defaultPresetId
        JsonValues.parseObject(row.extensionsJson.takeIf { it.isNotBlank() })
            .takeIf { it.isNotEmpty() }
            ?.let { payload["extensions"] = it }
        return payload
    }

    /** 人设：只有三个业务字段（PC 注释明确「不含 id/头像/时间戳」）。 */
    fun personaPayload(row: LocalPersonaEntity): Map<String, Any?> = linkedMapOf(
        "name" to row.name,
        "description" to row.description,
        "persona" to row.persona,
    )

    /**
     * 预设：PC 是 `{...preset} - id`，即**完整 Preset 正文**。
     * Android 把正文整份保存在 `body_json`，因此 payload = 正文去掉 `id`；
     * 写入前必须经 `PresetCodec.normalize`，保证键集合与 PC `normalizePreset` 输出一致。
     */
    fun presetPayload(row: LocalPresetEntity): Map<String, Any?> =
        LinkedHashMap<String, Any?>(JsonValues.parseObject(row.bodyJson)).apply { remove("id") }

    /** 世界书：canonical v2 文档去掉 `id`（PC `lorebookEntityPayload`）。 */
    fun lorebookPayload(row: LocalLorebookEntity): Map<String, Any?> =
        LinkedHashMap<String, Any?>(JsonValues.parseObject(row.canonicalJson)).apply { remove("id") }

    /**
     * 正则规则：PC 是 `{...rule} - id`，即整条规则的全部键。
     *
     * Android 把可选字段以空串/空数组表达（Room 列非空），因此这里**无条件输出**这些键，
     * 与 PC 上「由 UI 保存的规则」一致（UI 会把空文本框存成 `""`）。
     * 手工编辑、确实缺少可选键的旧规则文件属于已知差异，需在阶段 7 的
     * `content-io` fixture 里钉死；不在这里猜，也不静默丢字段。
     */
    fun regexRulePayload(row: LocalRegexRuleEntity): Map<String, Any?> = linkedMapOf(
        "name" to row.name,
        "pattern" to row.pattern,
        "replacement" to row.replacement,
        "flags" to row.flags,
        "enabled" to row.enabled,
        "scope" to row.scope,
        "group" to row.group,
        "stage" to row.stage,
        "triggerPattern" to row.triggerPattern,
        "triggerFlags" to row.triggerFlags,
        "stopStrings" to stringArray(row.stopStringsJson, MAX_STOP_STRINGS).orEmpty(),
    )

    /**
     * 快捷回复：**整库一个实体**（PC `quickReplyStorePayload`）。
     *
     * 顺序语义：集合按 `sortIndex, id` 串联后展开成条目数组；
     * `byCharacter` 的每个角色条目同理。空的角色条目**不出现在 map 里**，
     * 因为 PC 的 `byCharacter` 只为确实存在集合的角色保留键。
     */
    fun quickReplyStorePayload(rows: List<LocalQuickReplySetEntity>): Map<String, Any?> {
        val globalItems = ArrayList<Any?>()
        val byCharacter = LinkedHashMap<String, ArrayList<Any?>>()
        rows.asSequence()
            .sortedWith(compareBy({ it.sortIndex }, { it.id }))
            .forEach { row ->
                val items = JsonValues.parseArray(row.itemsJson)
                val characterId = row.characterId
                if (characterId == null) {
                    globalItems.addAll(items)
                } else {
                    byCharacter.getOrPut(characterId) { ArrayList<Any?>() }.addAll(items)
                }
            }
        return linkedMapOf(
            "global" to globalItems,
            "byCharacter" to LinkedHashMap<String, Any?>(byCharacter),
        )
    }

    /** 映射模板：整个模板去掉 `id`（PC `lorebookMappingTemplatePayload`）。 */
    fun mappingTemplatePayload(row: LocalLorebookMappingTemplateEntity): Map<String, Any?> {
        val payload = LinkedHashMap<String, Any?>(JsonValues.parseObject(row.templateJson))
        payload.remove("id")
        payload["name"] = row.name
        payload["sourceFormat"] = row.sourceFormat
        return payload
    }

    /**
     * 用量记录：PC 固定 7 个键（去掉 id），`totalChars` 是输入+输出可见字符数。
     *
     * **`characterId`/`sessionId` 为 null 时必须整个键不下发**，不能写成 null：
     * PC 侧是 `return { characterId: record.characterId, ... }`，JS 对象里 `undefined`
     * 的键在序列化时消失，所以「没有会话的用量」在 PC 只有 5 个键。
     * `CanonicalJson` 会把 null 编成 `null` 文本，两端就会得到不同哈希——
     * 这条由 `shared/fixtures/cross-platform/sync-payload/other-entity-payloads.json`
     * 的 `usage_record.no-session` 用例钉住。
     */
    fun usageRecordPayload(row: LocalUsageRecordEntity): Map<String, Any?> {
        val payload = LinkedHashMap<String, Any?>()
        payload["timestamp"] = row.createdAt
        row.characterId?.let { payload["characterId"] = it }
        row.sessionId?.let { payload["sessionId"] = it }
        payload["model"] = row.model
        payload["inputChars"] = row.inputChars
        payload["outputChars"] = row.outputChars
        payload["totalChars"] = row.inputChars + row.outputChars
        return payload
    }

    /**
     * 公开设置：**整份设置一个实体**（PC `settingsPublicPayload` 的白名单）。
     *
     * Android 的行式存储（section,key）只是本地实现；journal 必须以聚合视图下发，
     * 否则两端对同一份设置使用不同实体 id，阶段 7 无法合并。
     * 白名单外的键（凭据、设备偏好等）绝不允许进入本 payload。
     */
    fun settingsPublicPayload(settings: Map<String, Any?>): Map<String, Any?> {
        val payload = LinkedHashMap<String, Any?>()
        stringOf(settings["theme"])?.takeIf { THEME_VALUES.contains(it) }?.let { payload["theme"] = it }
        stringOf(settings["language"])?.takeIf { it.length <= 32 }?.let { payload["language"] = it }
        settings["narrativeMode"]?.let { stringOf(it) }?.let { payload["narrativeMode"] = it }
        stringOf(settings["responseLengthMode"])
            ?.takeIf { RESPONSE_LENGTH_VALUES.contains(it) }
            ?.let { payload["responseLengthMode"] = it }
        if (settings.containsKey("activePersonaId")) {
            payload["activePersonaId"] = stringOf(settings["activePersonaId"])
        }
        if (settings.containsKey("activePresetId")) {
            payload["activePresetId"] = stringOf(settings["activePresetId"])
        }
        return payload
    }

    // PC `characterEntityPayload` 的兜底名，逐字一致。
    const val UNNAMED_CHARACTER = "未命名角色"

    /**
     * 消息实体 payload —— 对齐 `electron/ipc/chat.ts#messageEntityPayload`
     * 与 `shared/contracts/schemas/message-payload.schema.json`（`additionalProperties:false`）。
     *
     * 为什么这次必须动它：阶段 3 起这里直接把 **Room 列名**当 payload 下发
     * （`logicalTime`/`seq`/`swipesJson`/`imagesJson`/`usageJson`/`translation`/`generationStatus`），
     * 而契约要求 `timestamp` 且禁止额外键。两端对同一条消息算出的 `contentHash` 因此
     * **永远不相等**；消息又是同步量最大的实体（总方案 §12 的基线是 100 万条），
     * 阶段 7 会把它读成满屏伪冲突。这是阶段 5 §2.1 给 `character` 修过的同一类缺陷，
     * 只是当时没把 `message` 纳入 `sync-payload` golden（那份 golden 只覆盖 8 类实体）。
     *
     * 逐条对齐规则（oracle = `shared/fixtures/cross-platform/sync-payload/message-payload.json`）：
     * - `timestamp` ← `logicalTime`：两端都用它当消息的逻辑位置（PC 的 `Message.timestamp`）
     * - `swipes` 是**数组**，由 `swipesJson` 解析；`swipesJson` 为 null/空串时不下发键
     * - `characterId` **始终下发**（可为 null）——PC 那边是 `string | null` 都下发
     * - 可空列（`replyToId`/`swipeIndex`）为 null 时**不下发键**，对齐 PC 的 `undefined`
     * - `imagesJson`/`translation`/`usageJson`/`generationStatus`/`generationNotice`/
     *   `generationError`/`seq` 属**本地保真**，不进契约（PC 也一个都不发）；
     *   跨端保真由 Backup V3 与导入导出承担
     *
     * **仍缺三键（属阶段 6 S6-01「旁白与角色身份」）**：Android 没有 `speakerKind` /
     * `generationKind` / `narrativeMode` 列，PC 下发这三键时本机发不出。
     * `SyncPayloadGoldenTest` 把这条缺口**逐键登记**——不是放宽断言：
     * 多一个键、少一个键（缺口变化）都会让它变红。
     */
    fun messagePayload(row: LocalMessageEntity): Map<String, Any?> {
        val out = linkedMapOf<String, Any?>(
            "sessionId" to row.sessionId,
            "role" to row.role,
            "content" to row.content,
            "timestamp" to row.logicalTime,
            "characterId" to row.characterId,
        )
        // 不截断：PC 对 `swipes` 是原样透传（schema 的 maxItems 32 两端都没执行），
        // 单边截断会让候选数超过 32 的消息哈希不同。
        stringArray(row.swipesJson, Int.MAX_VALUE)?.let { out["swipes"] = it }
        row.swipeIndex?.let { out["swipeIndex"] = it }
        row.replyToId?.let { out["replyToId"] = it }
        return out
    }

    /**
     * 会话实体 payload —— 对齐 `electron/ipc/chat.ts#sessionEntityPayload`。
     *
     * 同一类缺陷的第二处：阶段 3 起这里下发的是 `lorebookIdsJson`（Room 列名），
     * 而 PC 用的是契约键 `lorebookIds`，并且 PC 还下发 `createdAt`/`updatedAt`/`narrativeMode`
     * ——三键此前**一个都没发**。两端对同一会话算出的哈希因此不相等。
     *
     * 逐条对齐：
     * - `lorebookIds` ← 解析 `lorebookIdsJson`；解析不出就当空数组（对齐 PC 的 `?? []`，**始终下发**）
     * - `personaId` / `narrativeMode` **始终下发**，未设置时为 `null`（PC 是 `?? null`）
     * - Android 的空串表示「未设置」，因此 `narrativeMode` 要 `"" → null`
     * - `groupId` / `presetId` / `memoryEnabled` / `memoryMode` / `autoMemoryInterval` /
     *   `responseLengthMode` 等属**平台扩展或本地状态**，PC 的 session payload 里没有这些键，
     *   塞进去就是 `additionalProperties:false` 判非法 + 哈希不等。
     *   群会话的归属（`groupId`）在 PC 是**另一个实体类型**，属阶段 6 S6-01 的对齐范围。
     */
    fun sessionPayload(row: LocalSessionEntity): Map<String, Any?> = linkedMapOf(
        "characterId" to row.characterId,
        "title" to row.title,
        "createdAt" to row.createdAt,
        "updatedAt" to row.updatedAt,
        "personaId" to row.personaId,
        "lorebookIds" to (stringArray(row.lorebookIdsJson, Int.MAX_VALUE) ?: emptyList()),
        "narrativeMode" to row.narrativeMode.takeIf { it.isNotBlank() },
    )

    private const val MAX_TAGS = 64
    private const val MAX_ALTERNATE_GREETINGS = 32
    private const val MAX_BOUND_LOREBOOKS = 32
    private const val MAX_STOP_STRINGS = 32

    /** 与 `electron/ipc/settings.ts` 的 `THEME_VALUES` 对齐。 */
    private val THEME_VALUES = setOf("light", "dark", "system")

    /** 与 `electron/ipc/settings.ts` 的 `LENGTH_MODE_VALUES` 对齐。 */
    private val RESPONSE_LENGTH_VALUES = setOf("auto", "brief", "balanced", "detailed")

    /** PC 语义：`typeof x === 'string'` 才下发（空串是合法字符串，不能当缺省处理）。 */
    private fun stringOf(value: Any?): String? = value as? String

    /**
     * 与 PC `stringArray` 一致：过滤非字符串并按 maxItems 截断；非数组返回 null（即不下发）。
     *
     * 这里刻意不用 `org.json`：`local/domain` 是按「纯 JVM 可测」分层决策落地的
     * （阶段 3 起 Repository 契约测试不依赖模拟器），而 `org.json` 是 Android 框架类，
     * JVM 单测里拿到的是「not mocked」桩——桩会在 `length()` 上抛异常，把 40 个
     * 与快捷回复无关的旧用例一起砸掉。用 kotlinx.serialization 解析才是这一层的正确工具。
     */
    private fun stringArray(json: String?, max: Int): List<String>? {
        if (json.isNullOrBlank()) return null
        val array = runCatching { Json.parseToJsonElement(json) }.getOrNull() as? JsonArray ?: return null
        return array.filterIsInstance<JsonPrimitive>().filter { it.isString }.map { it.content }.take(max)
    }
}
