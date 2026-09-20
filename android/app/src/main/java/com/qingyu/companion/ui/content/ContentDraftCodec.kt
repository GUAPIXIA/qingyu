package com.qingyu.companion.ui.content

import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalLorebookEntity
import com.qingyu.companion.local.db.LocalPersonaEntity
import com.qingyu.companion.local.db.LocalPresetEntity
import com.qingyu.companion.local.db.LocalQuickReplySetEntity
import com.qingyu.companion.local.db.LocalRegexRuleEntity
import org.json.JSONObject

/**
 * 阶段 5 §2 草稿区的行编解码：**逐列无损往返**，一行编辑器草稿 = 该行 Room 实体的全部列。
 *
 * 为什么不用同步层的 payload（`EntityPayloads`）当草稿格式：payload 是按 PC 契约裁出来的
 * **稀疏白名单**（键的存在性本身进哈希），拿它存草稿会静默丢掉只有本机才有的列
 * （头像路径、内嵌世界书、卡片规范版本、记忆开关……）。草稿要的是「回到原位继续写」，
 * 不是「跨端可比」，所以这里刻意做全列快照。
 *
 * 可空字符串用 `JSONObject.NULL` 显式区分「没有这个列」与「列存在且为 null」：
 * `optString` 会把 null 读成空串，那样「用户清空了头像」会被恢复成「从没设过」，
 * 保存时就把一次清空悄悄吞掉了。
 *
 * 新增列忘补 codec 的情况由 `ContentDraftCodecTest` 用**字段条数**当场抓红
 * （`declaredFields.size == json.length()`），不依赖有人记得去改测试。
 */
object ContentDraftCodec {

    fun encodeCharacter(row: LocalCharacterEntity): String = JSONObject().apply {
        put("id", row.id)
        put("name", row.name)
        put("description", row.description)
        put("personality", row.personality)
        put("scenario", row.scenario)
        put("firstMessage", row.firstMessage)
        put("exampleDialogueJson", row.exampleDialogueJson)
        putNullable("avatarPath", row.avatarPath)
        putNullable("backgroundPath", row.backgroundPath)
        put("extensionsJson", row.extensionsJson)
        putNullable("lorebookId", row.lorebookId)
        putNullable("defaultPresetId", row.defaultPresetId)
        putNullable("defaultPersonaId", row.defaultPersonaId)
        putNullable("importedFrom", row.importedFrom)
        put("createdAt", row.createdAt)
        put("updatedAt", row.updatedAt)
        put("exampleDialog", row.exampleDialog)
        put("alternateGreetingsJson", row.alternateGreetingsJson)
        put("groupOnlyGreetingsJson", row.groupOnlyGreetingsJson)
        put("systemPrompt", row.systemPrompt)
        put("postHistoryInstructions", row.postHistoryInstructions)
        put("tagsJson", row.tagsJson)
        put("creator", row.creator)
        put("creatorNotes", row.creatorNotes)
        put("characterVersion", row.characterVersion)
        put("boundLorebookIdsJson", row.boundLorebookIdsJson)
        put("authorNoteJson", row.authorNoteJson)
        put("embeddedLorebookJson", row.embeddedLorebookJson)
        put("defaultMemoryMode", row.defaultMemoryMode)
        put("defaultMemoryEnabled", row.defaultMemoryEnabled)
        put("defaultMemoryInterval", row.defaultMemoryInterval)
        put("defaultNarrativeMode", row.defaultNarrativeMode)
        put("cardSpecVersion", row.cardSpecVersion)
        put("translatedContentJson", row.translatedContentJson)
    }.toString()

    fun decodeCharacter(json: String): LocalCharacterEntity? = parse(json) { o ->
        val id = o.requiredString("id") ?: return@parse null
        LocalCharacterEntity(
            id = id,
            name = o.stringOr("name"),
            description = o.stringOr("description"),
            personality = o.stringOr("personality"),
            scenario = o.stringOr("scenario"),
            firstMessage = o.stringOr("firstMessage"),
            exampleDialogueJson = o.stringOr("exampleDialogueJson").ifEmpty { "[]" },
            avatarPath = o.nullableString("avatarPath"),
            backgroundPath = o.nullableString("backgroundPath"),
            extensionsJson = o.stringOr("extensionsJson").ifEmpty { "{}" },
            lorebookId = o.nullableString("lorebookId"),
            defaultPresetId = o.nullableString("defaultPresetId"),
            defaultPersonaId = o.nullableString("defaultPersonaId"),
            importedFrom = o.nullableString("importedFrom"),
            createdAt = o.optLong("createdAt"),
            updatedAt = o.optLong("updatedAt"),
            exampleDialog = o.stringOr("exampleDialog"),
            alternateGreetingsJson = o.stringOr("alternateGreetingsJson").ifEmpty { "[]" },
            groupOnlyGreetingsJson = o.stringOr("groupOnlyGreetingsJson").ifEmpty { "[]" },
            systemPrompt = o.stringOr("systemPrompt"),
            postHistoryInstructions = o.stringOr("postHistoryInstructions"),
            tagsJson = o.stringOr("tagsJson").ifEmpty { "[]" },
            creator = o.stringOr("creator"),
            creatorNotes = o.stringOr("creatorNotes"),
            characterVersion = o.stringOr("characterVersion"),
            boundLorebookIdsJson = o.stringOr("boundLorebookIdsJson").ifEmpty { "[]" },
            authorNoteJson = o.stringOr("authorNoteJson"),
            embeddedLorebookJson = o.stringOr("embeddedLorebookJson"),
            defaultMemoryMode = o.stringOr("defaultMemoryMode"),
            defaultMemoryEnabled = o.optInt("defaultMemoryEnabled", -1),
            defaultMemoryInterval = o.optInt("defaultMemoryInterval", -1),
            defaultNarrativeMode = o.stringOr("defaultNarrativeMode"),
            cardSpecVersion = o.stringOr("cardSpecVersion"),
            translatedContentJson = o.stringOr("translatedContentJson"),
        )
    }

    fun encodeLorebook(row: LocalLorebookEntity): String = JSONObject().apply {
        put("id", row.id)
        put("name", row.name)
        put("canonicalJson", row.canonicalJson)
        put("schemaVersion", row.schemaVersion)
        putNullable("scanDepth", row.scanDepth)
        putNullable("tokenBudget", row.tokenBudget)
        putNullable("importedFrom", row.importedFrom)
        put("createdAt", row.createdAt)
        put("updatedAt", row.updatedAt)
    }.toString()

    fun decodeLorebook(json: String): LocalLorebookEntity? = parse(json) { o ->
        val id = o.requiredString("id") ?: return@parse null
        LocalLorebookEntity(
            id = id,
            name = o.stringOr("name"),
            canonicalJson = o.stringOr("canonicalJson").ifEmpty { "{}" },
            schemaVersion = o.optInt("schemaVersion", 2),
            scanDepth = if (o.isNull("scanDepth")) null else o.optInt("scanDepth"),
            tokenBudget = if (o.isNull("tokenBudget")) null else o.optInt("tokenBudget"),
            importedFrom = o.nullableString("importedFrom"),
            createdAt = o.optLong("createdAt"),
            updatedAt = o.optLong("updatedAt"),
        )
    }

    fun encodePreset(row: LocalPresetEntity): String = JSONObject().apply {
        put("id", row.id)
        put("name", row.name)
        put("bodyJson", row.bodyJson)
        put("isDefault", row.isDefault)
        putNullable("importedFrom", row.importedFrom)
        put("createdAt", row.createdAt)
        put("updatedAt", row.updatedAt)
        put("isBuiltin", row.isBuiltin)
        put("description", row.description)
        put("sortIndex", row.sortIndex)
        put("enabled", row.enabled)
    }.toString()

    fun decodePreset(json: String): LocalPresetEntity? = parse(json) { o ->
        val id = o.requiredString("id") ?: return@parse null
        LocalPresetEntity(
            id = id,
            name = o.stringOr("name"),
            bodyJson = o.stringOr("bodyJson").ifEmpty { "{}" },
            isDefault = o.optBoolean("isDefault"),
            importedFrom = o.nullableString("importedFrom"),
            createdAt = o.optLong("createdAt"),
            updatedAt = o.optLong("updatedAt"),
            isBuiltin = o.optBoolean("isBuiltin"),
            description = o.stringOr("description"),
            sortIndex = o.optInt("sortIndex"),
            enabled = o.optBoolean("enabled", true),
        )
    }

    fun encodePersona(row: LocalPersonaEntity): String = JSONObject().apply {
        put("id", row.id)
        put("name", row.name)
        put("description", row.description)
        put("persona", row.persona)
        put("isDefault", row.isDefault)
        putNullable("importedFrom", row.importedFrom)
        put("createdAt", row.createdAt)
        put("updatedAt", row.updatedAt)
        putNullable("avatarPath", row.avatarPath)
    }.toString()

    fun decodePersona(json: String): LocalPersonaEntity? = parse(json) { o ->
        val id = o.requiredString("id") ?: return@parse null
        LocalPersonaEntity(
            id = id,
            name = o.stringOr("name"),
            description = o.stringOr("description"),
            persona = o.stringOr("persona"),
            isDefault = o.optBoolean("isDefault"),
            importedFrom = o.nullableString("importedFrom"),
            createdAt = o.optLong("createdAt"),
            updatedAt = o.optLong("updatedAt"),
            avatarPath = o.nullableString("avatarPath"),
        )
    }

    fun encodeRegexRule(row: LocalRegexRuleEntity): String = JSONObject().apply {
        put("id", row.id)
        put("name", row.name)
        put("pattern", row.pattern)
        put("replacement", row.replacement)
        put("flags", row.flags)
        put("scope", row.scope)
        put("enabled", row.enabled)
        put("sortIndex", row.sortIndex)
        putNullable("importedFrom", row.importedFrom)
        put("createdAt", row.createdAt)
        put("updatedAt", row.updatedAt)
        put("group", row.group)
        put("stage", row.stage)
        put("triggerPattern", row.triggerPattern)
        put("triggerFlags", row.triggerFlags)
        put("stopStringsJson", row.stopStringsJson)
        put("sourceFormat", row.sourceFormat)
        put("compatNotesJson", row.compatNotesJson)
    }.toString()

    fun decodeRegexRule(json: String): LocalRegexRuleEntity? = parse(json) { o ->
        val id = o.requiredString("id") ?: return@parse null
        LocalRegexRuleEntity(
            id = id,
            name = o.stringOr("name"),
            pattern = o.stringOr("pattern"),
            replacement = o.stringOr("replacement"),
            flags = o.stringOr("flags"),
            scope = o.stringOr("scope"),
            enabled = o.optBoolean("enabled", true),
            sortIndex = o.optInt("sortIndex"),
            importedFrom = o.nullableString("importedFrom"),
            createdAt = o.optLong("createdAt"),
            updatedAt = o.optLong("updatedAt"),
            group = o.stringOr("group"),
            stage = o.stringOr("stage"),
            triggerPattern = o.stringOr("triggerPattern"),
            triggerFlags = o.stringOr("triggerFlags"),
            stopStringsJson = o.stringOr("stopStringsJson").ifEmpty { "[]" },
            sourceFormat = o.stringOr("sourceFormat"),
            compatNotesJson = o.stringOr("compatNotesJson").ifEmpty { "[]" },
        )
    }

    fun encodeQuickReplySet(row: LocalQuickReplySetEntity): String = JSONObject().apply {
        put("id", row.id)
        put("name", row.name)
        put("itemsJson", row.itemsJson)
        put("enabled", row.enabled)
        put("sortIndex", row.sortIndex)
        putNullable("importedFrom", row.importedFrom)
        put("createdAt", row.createdAt)
        put("updatedAt", row.updatedAt)
        putNullable("characterId", row.characterId)
    }.toString()

    fun decodeQuickReplySet(json: String): LocalQuickReplySetEntity? = parse(json) { o ->
        val id = o.requiredString("id") ?: return@parse null
        LocalQuickReplySetEntity(
            id = id,
            name = o.stringOr("name"),
            itemsJson = o.stringOr("itemsJson").ifEmpty { "[]" },
            enabled = o.optBoolean("enabled", true),
            sortIndex = o.optInt("sortIndex"),
            importedFrom = o.nullableString("importedFrom"),
            createdAt = o.optLong("createdAt"),
            updatedAt = o.optLong("updatedAt"),
            characterId = o.nullableString("characterId"),
        )
    }

    // ------------------------------------------------------------ JSON 读取小工具

    /** 草稿坏了就当没有草稿：编辑器的正确行为是回到「从库里读出的那一行」，不是崩。 */
    private inline fun <T> parse(json: String, decode: (JSONObject) -> T?): T? =
        runCatching { decode(JSONObject(json)) }.getOrNull()

    private fun JSONObject.stringOr(key: String): String = if (isNull(key)) "" else optString(key)

    private fun JSONObject.requiredString(key: String): String? =
        if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }

    /** 区分「null」与「缺键」：前者是用户主动清空，后者是本不该出现的结构问题。 */
    private fun JSONObject.nullableString(key: String): String? =
        if (!has(key) || isNull(key)) null else optString(key)

    private fun JSONObject.putNullable(key: String, value: Any?) {
        put(key, value ?: JSONObject.NULL)
    }
}
