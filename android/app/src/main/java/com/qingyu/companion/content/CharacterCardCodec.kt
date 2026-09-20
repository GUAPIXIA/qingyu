package com.qingyu.companion.content

import com.qingyu.companion.local.domain.JsonValues
import com.qingyu.companion.local.db.LocalCharacterEntity
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

/**
 * 阶段 5 S5-01：Character Card V1/V2/V3 与裸卡（bare）的导入导出。
 *
 * 行为基准是 `electron/services/charCard.ts` 的 `normalizeCharacter` /
 * `exportCharacterToPng` / `exportCharacterToJson`，**逐字段对齐**，因为跨端要求
 * 「PC 导出 → Android 导入 → PC 再导入」没有语义损失（方案 §3 测试矩阵）。
 *
 * 与 PC 的两处刻意差异，都属于移动端平台约束而不是行为漂移：
 * 1. 头像/封面在 PC 是 data URL 字符串，在 Android 落 app-private 文件后只保留相对路径
 *    （见 `LocalCharacterEntity.avatarPath`）；导入时由 [AvatarSink] 负责解码验证与落盘，
 *    编解码层本身不碰文件系统，保证可在 JVM 单测里跑。
 * 2. PC 只写 V2（`chara` 段），方案 S5-01 要求 Android 也支持 V3，因此 V3 导出是新增能力；
 *    V3 导入 PC 早已支持（读 `ccv3`），所以「Android 导出 V3 → PC 导入」是可行的。
 */
object CharacterCardCodec {

    /** 导入产物：与 Room 行解耦，便于先做冲突/影响预览再落库。 */
    data class Draft(
        val specVersion: String,
        val name: String,
        val description: String,
        val personality: String,
        val scenario: String,
        val firstMessage: String,
        val alternateGreetings: List<String>,
        val groupOnlyGreetings: List<String>,
        val exampleDialog: String,
        val systemPrompt: String,
        val postHistoryInstructions: String,
        val creatorNotes: String,
        val characterVersion: String,
        val tags: List<String>,
        val creator: String,
        /** 原始 `extensions` 对象（未知字段保真的落点，必须原样写回） */
        val extensions: Map<String, Any?>,
        /** 图片字段的原始表达（data URL / http URL / 裸 base64），由 UI 决定如何落地 */
        val imageReference: String?,
        /** 内嵌 `character_book` 原文，交给世界书导入器 */
        val embeddedCharacterBook: String?,
        /** 本次导入未能应用的来源字段名（方案 §2「未知字段保留报告」） */
        val unmappedFields: List<String>,
    )

    sealed interface ImportResult {
        data class Success(val draft: Draft) : ImportResult
        /** `reason` 面向用户，必须说清是哪种格式、缺什么。 */
        data class Rejected(val reason: String, val detectedAs: String? = null) : ImportResult
    }

    /** 单文件字节上限（方案 S5-01「限制数量、单文件和总大小」）。 */
    const val MAX_CARD_BYTES = 20 * 1024 * 1024
    const val MAX_BATCH_FILES = 50
    const val MAX_BATCH_BYTES = 100L * 1024 * 1024

    // ------------------------------------------------------------ 导入

    /** PNG 角色卡：读 `chara`（V2）或 `ccv3`（V3）文本段。 */
    fun importPng(bytes: ByteArray): ImportResult {
        if (bytes.size > MAX_CARD_BYTES) {
            return ImportResult.Rejected("文件过大（超过 ${MAX_CARD_BYTES / 1024 / 1024} MiB）")
        }
        if (!PngTextChunks.isPng(bytes)) {
            return ImportResult.Rejected("不是有效的 PNG 文件")
        }
        val chunks = PngTextChunks.read(bytes)
        val encoded = chunks["chara"] ?: chunks["ccv3"]
        if (encoded == null) {
            return ImportResult.Rejected("该 PNG 文件不包含角色卡数据（未找到 chara 或 ccv3 字段）")
        }
        // `chara`/`ccv3` 段存的是 base64 后的 **UTF-8 JSON 文本**，解码后必须按 UTF-8 还原成字符串。
        val json = decodeBase64(encoded)?.toString(Charsets.UTF_8)
            ?: return ImportResult.Rejected("角色卡 base64 解码失败")
        val draft = parseJsonText(json)
        // 整张 PNG 就是头像：只有确认能被系统解码成位图才接受（方案要求先解码验证再入库）。
        return if (draft is ImportResult.Success) {
            draft.copy(draft = draft.draft.copy(imageReference = PNG_DATA_URL_PREFIX + encodeBase64(bytes)))
        } else {
            draft
        }
    }

    fun importJson(text: String): ImportResult {
        if (text.toByteArray(Charsets.UTF_8).size > MAX_CARD_BYTES) {
            return ImportResult.Rejected("文件过大")
        }
        // 世界书文件误入角色卡入口时给出可操作的提示，而不是报「缺少 name」。
        val root = runCatching { JSONObject(text) }.getOrNull()
            ?: return ImportResult.Rejected("JSON 解析失败")
        if (looksLikeLorebook(root)) {
            val count = when (val entries = root.opt("entries")) {
                is JSONArray -> entries.length()
                is JSONObject -> entries.length()
                else -> 0
            }
            return ImportResult.Rejected(
                "这个文件是世界书（Lorebook），包含 $count 条条目，不是角色卡。\n请在世界书页面使用「导入 JSON」功能导入。",
                detectedAs = "lorebook",
            )
        }
        return parseJson(text, root)
    }

    // ------------------------------------------------------------ 导出

    /** 导出为 Character Card V2 JSON（与 PC `exportCharacterToJson` 同一字段集）。 */
    fun exportV2Json(draft: Draft): String = cardJson(draft, SPEC_V2).pretty()

    /** 导出为 Character Card V3 JSON（`spec: chara_card_v3`，`spec_version: 3.0`）。 */
    fun exportV3Json(draft: Draft): String = cardJson(draft, SPEC_V3).pretty()

    /**
     * 导出为 PNG：V2 写 `chara` 段，V3 **同时**写 `chara` 与 `ccv3`。
     *
     * 为什么双写：`chara` 是所有 V2 读取方（含 PC）都认的段，只写 `ccv3` 会让
     * 旧版应用打不开；而 V3 读取方优先看 `ccv3`。双写保证一张卡在任何一版上都能读。
     */
    fun exportPng(draft: Draft, basePng: ByteArray?, spec: String = SPEC_V2): ByteArray {
        val base = basePng?.takeIf { PngTextChunks.isPng(it) } ?: blankPng()
        // PNG 段里的载荷是紧凑 JSON：PC 用 `JSON.stringify`（不转义 `/`），
        // 所以这里同样要走 [pcCompatible]，否则两端写出的 `chara` 段字节不同。
        val payload = pcCompatible(cardJson(draft, spec).toString())
        val encoded = Base64.getEncoder().encodeToString(payload.toByteArray(Charsets.UTF_8))
        val withV2 = PngTextChunks.writeTextChunk(base, "chara", encoded)
        return if (spec == SPEC_V3) PngTextChunks.writeTextChunk(withV2, "ccv3", encoded) else withV2
    }

    /** 由本地行还原成导出用草稿（编辑后导出必须带上未进同步契约的本地字段）。 */
    fun draftOf(row: LocalCharacterEntity): Draft = Draft(
        specVersion = row.cardSpecVersion.ifBlank { SPEC_V2 },
        name = row.name,
        description = row.description,
        personality = row.personality,
        scenario = row.scenario,
        firstMessage = row.firstMessage,
        alternateGreetings = stringList(row.alternateGreetingsJson),
        groupOnlyGreetings = stringList(row.groupOnlyGreetingsJson),
        exampleDialog = row.exampleDialog.ifBlank { legacyFirstExample(row.exampleDialogueJson) },
        systemPrompt = row.systemPrompt,
        postHistoryInstructions = row.postHistoryInstructions,
        creatorNotes = row.creatorNotes,
        characterVersion = row.characterVersion,
        tags = stringList(row.tagsJson),
        creator = row.creator,
        extensions = JsonValues.parseObject(row.extensionsJson),
        imageReference = row.avatarPath,
        embeddedCharacterBook = row.embeddedLorebookJson.takeIf { it.isNotBlank() },
        unmappedFields = emptyList(),
    )

    /** 草稿 → Room 行（`id` 由调用方给定；不在此处生成，避免导入批次里 ID 来源分散）。 */
    fun entityOf(draft: Draft, id: String, now: Long, avatarPath: String?): LocalCharacterEntity {
        val extensions = LinkedHashMap(draft.extensions)
        draft.unmappedFields.takeIf { it.isNotEmpty() }?.let {
            extensions[UNMAPPED_FIELDS_KEY] = it
        }
        return LocalCharacterEntity(
            id = id,
            name = draft.name,
            description = draft.description,
            personality = draft.personality,
            scenario = draft.scenario,
            firstMessage = draft.firstMessage,
            // 规范文本单一来源：不再写 JSON 数组，避免两种表示长期并存后含义漂移。
            exampleDialogueJson = "[]",
            avatarPath = avatarPath,
            extensionsJson = JSONObject(extensions as Map<out String, Any?>).toString(),
            lorebookId = null,
            defaultPresetId = null,
            defaultPersonaId = null,
            importedFrom = draft.specVersion,
            createdAt = now,
            updatedAt = now,
            exampleDialog = draft.exampleDialog,
            alternateGreetingsJson = JSONArray(draft.alternateGreetings).toString(),
            groupOnlyGreetingsJson = JSONArray(draft.groupOnlyGreetings).toString(),
            systemPrompt = draft.systemPrompt,
            postHistoryInstructions = draft.postHistoryInstructions,
            tagsJson = JSONArray(draft.tags).toString(),
            creator = draft.creator,
            creatorNotes = draft.creatorNotes,
            characterVersion = draft.characterVersion,
            embeddedLorebookJson = draft.embeddedCharacterBook.orEmpty(),
            cardSpecVersion = draft.specVersion,
            translatedContentJson = JsonValues.stringify(draft.extensions["translatedContent"])
                .takeIf { it != "null" } ?: "",
        )
    }

    // ------------------------------------------------------------ 归一化实现

    private const val SPEC_V2 = "chara_card_v2"
    private const val SPEC_V3 = "chara_card_v3"
    /** 裸卡：无 `spec`/`data` 包装的 V1 风格卡 */
    private const val BARE_SPEC = "bare"
    private const val PNG_DATA_URL_PREFIX = "data:image/png;base64,"
    private const val UNNAMED = "未命名角色"
    /** 未知字段的保留位置：写回来源卡的 `extensions`，避免静默丢弃。 */
    private const val UNMAPPED_FIELDS_KEY = "qingyuUnmappedFields"

    /** 非 PNG 头像时的 1x1 透明基底（与 PC 用的是同一段字节）。 */
    private fun blankPng(): ByteArray = Base64.getMimeDecoder().decode(PngTextChunks.BLANK_PNG_BASE64)

    private fun parseJsonText(text: String): ImportResult =
        runCatching { JSONObject(text) }.fold(
            onSuccess = { parseJson(text, it) },
            onFailure = { ImportResult.Rejected("角色卡校验失败：JSON 解析失败") },
        )

    private fun parseJson(@Suppress("UNUSED_PARAMETER") text: String, root: JSONObject): ImportResult {
        val wrapped = root.opt("data") as? JSONObject
        val spec = root.optString("spec").takeIf { it.isNotEmpty() }
        // 校验基本结构：V2/V3 必须有 data；裸卡必须有 name（PC validateCharacterCard 的底线）。
        if (spec != null && spec != SPEC_V2 && spec != SPEC_V3) {
            return ImportResult.Rejected("角色卡校验失败：未知 spec=$spec", detectedAs = spec)
        }
        if (spec != null && wrapped == null) {
            return ImportResult.Rejected("角色卡校验失败：$spec 角色卡缺少 data 字段")
        }
        val data = wrapped ?: root
        if (data.optString("name").isBlank() && root.optString("name").isBlank() &&
            data.optString("first_mes").isBlank() && data.optString("firstMessage").isBlank()
        ) {
            return ImportResult.Rejected("角色卡校验失败：缺少 name 字段")
        }

        val alternate = nonBlankStrings(data.optJSONArray("alternate_greetings"))
        val groupOnly = nonBlankStrings(data.optJSONArray("group_only_greetings"))
        // 兜底：只有备选开场白没有 first_mes 的卡，首条消息取第一条备选（PC 同规则）。
        val firstMessage = data.stringOr("first_mes").ifBlank { data.stringOr("firstMessage") }
            .ifBlank { alternate.firstOrNull().orEmpty() }

        val extensions = JsonValues.parseObject(data.optJSONObject("extensions")?.toString())
        val tags = normalizeTags(data.opt("tags").takeIf { it != JSONObject.NULL } ?: root.opt("tags"))
        val image = firstNonNull(
            data.stringOr("cover"), data.stringOr("avatar"), data.stringOr("image"),
            data.stringOr("image_url"), data.stringOr("thumbnail"), data.stringOr("portrait"),
            root.stringOr("cover"), root.stringOr("avatar"), root.stringOr("image"),
            root.stringOr("image_url"), root.stringOr("thumbnail"), root.stringOr("portrait"),
        )

        val recognized = RECOGNIZED_DATA_FIELDS + setOf("firstMessage")
        val unmapped = data.keys().asSequence().filterNot { recognized.contains(it) }.sorted().toList()

        return ImportResult.Success(
            Draft(
                specVersion = spec ?: if (root.has("name")) BARE_SPEC else "unknown",
                name = data.stringOr("name").ifBlank { root.stringOr("name") }.ifBlank { UNNAMED },
                description = data.stringOr("description"),
                personality = data.stringOr("personality"),
                scenario = data.stringOr("scenario"),
                firstMessage = firstMessage,
                alternateGreetings = alternate,
                groupOnlyGreetings = groupOnly,
                exampleDialog = data.stringOr("mes_example").ifBlank { data.stringOr("exampleDialog") },
                systemPrompt = data.stringOr("system_prompt").ifBlank { data.stringOr("systemPrompt") },
                postHistoryInstructions = data.stringOr("post_history_instructions"),
                creatorNotes = data.stringOr("creator_notes"),
                characterVersion = data.stringOr("character_version"),
                tags = tags,
                creator = data.stringOr("creator"),
                extensions = extensions,
                imageReference = image,
                embeddedCharacterBook = data.optJSONObject("character_book")?.toString(),
                unmappedFields = unmapped,
            ),
        )
    }

    /**
     * 导出正文。键序与 PC `exportCharacterToPng`/`exportCharacterToJson` 的 `data` 一致，
     * 但**不承诺字节级相等**：JSON 键序由写入方决定，跨端比较一律走 canonical JSON 哈希。
     */
    private fun cardData(draft: Draft): JSONObject = JSONObject().apply {
        put("name", draft.name)
        put("description", draft.description)
        put("personality", draft.personality)
        put("scenario", draft.scenario)
        put("first_mes", draft.firstMessage)
        put("alternate_greetings", JSONArray(draft.alternateGreetings))
        put("mes_example", draft.exampleDialog)
        put("system_prompt", draft.systemPrompt)
        put("post_history_instructions", draft.postHistoryInstructions)
        put("creator_notes", draft.creatorNotes)
        put("character_version", draft.characterVersion)
        put("group_only_greetings", JSONArray(draft.groupOnlyGreetings))
        put("tags", JSONArray(draft.tags))
        put("creator", draft.creator)
        put("extensions", JSONObject(draft.extensions as Map<out String, Any?>))
    }

    private fun cardJson(draft: Draft, spec: String): JSONObject =
        JSONObject().put("spec", spec).put("spec_version", if (spec == SPEC_V3) "3.0" else "2.0")
            .put("data", cardData(draft))

    /** 与 PC 的 `JSON.stringify` 结果等价的可读输出（缩进 2）。 */
    private fun JSONObject.pretty(): String = pcCompatible(toString(2))

    /**
     * 把 Android `org.json` 会转义、而 `JSON.stringify` 不转义的 `\/` 还原成 `/`。
     *
     * 两份文件解析回来是同一个对象，但**字节不同**：同一张卡两端各导出一次，
     * 用户 diff 就看到整篇被重写，跨端 fixture 也只能比解析结果、比不了字节
     * （`CharacterCardChainGoldenTest` 的字节档就是为此而红过一次）。
     *
     * 反斜杠只可能出现在 JSON 字符串里，且这里每轮都连吃两格，所以值里真的带
     * 「反斜杠 + 斜杠」时（文本 `\\\/`）不会被误改：先按 `\\` 输出，再把 `\/` 还原成 `/`。
     */
    private fun pcCompatible(json: String): String {
        if (!json.contains("\\/")) return json
        val out = StringBuilder(json.length)
        var index = 0
        while (index < json.length) {
            val char = json[index]
            if (char != '\\' || index + 1 == json.length) {
                out.append(char)
                index += 1
                continue
            }
            val next = json[index + 1]
            if (next == '/') out.append('/') else out.append(char).append(next)
            index += 2
        }
        return out.toString()
    }

    private fun looksLikeLorebook(root: JSONObject): Boolean {
        val entries = root.opt("entries")
        val hasEntries = when (entries) {
            is JSONArray -> entries.length() > 0
            is JSONObject -> entries.length() > 0
            else -> false
        }
        return hasEntries && root.opt("scan_depth") is Number && !root.has("spec") && !root.has("data")
    }

    /** tags 脏格式归一化：数组过滤空串、字符串按 `,，、\n` 拆分（与 PC 同一组分隔符）。 */
    private fun normalizeTags(raw: Any?): List<String> = when (raw) {
        is JSONArray -> nonBlankStrings(raw)
        is String -> raw.split( TAG_SEPARATOR).map { it.trim() }.filter { it.isNotEmpty() }
        else -> emptyList()
    }

    private val TAG_SEPARATOR = Regex("[,，、\\n]+")

    private val RECOGNIZED_DATA_FIELDS = setOf(
        "name", "description", "personality", "scenario", "first_mes", "alternate_greetings",
        "mes_example", "system_prompt", "post_history_instructions", "creator_notes",
        "character_version", "group_only_greetings", "tags", "creator", "extensions",
        "character_book", "cover", "avatar", "image", "image_url", "thumbnail", "portrait",
        "nickname", "profile_version", "notes", "main", "post_history",
    )

    private fun JSONObject.stringOr(key: String): String =
        (opt(key) as? String).orEmpty()

    private fun firstNonNull(vararg values: String?): String? = values.firstOrNull { !it.isNullOrEmpty() }

    private fun nonBlankStrings(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        return (0 until array.length())
            .mapNotNull { array.opt(it) as? String }
            .filter { it.isNotBlank() }
    }

    private fun stringList(json: String?): List<String> =
        JsonValues.parseArray(json).filterIsInstance<String>()

    /** 阶段 3 遗留：旧行只有 JSON 数组且生成时只取首条，导出时保持同一读法不回退语义。 */
    private fun legacyFirstExample(json: String): String = stringList(json).firstOrNull().orEmpty()

    private fun encodeBase64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    private fun decodeBase64(text: String): ByteArray? = runCatching {
        Base64.getMimeDecoder().decode(text.filter { !it.isWhitespace() })
    }.getOrNull()?.takeIf { it.isNotEmpty() }
}
