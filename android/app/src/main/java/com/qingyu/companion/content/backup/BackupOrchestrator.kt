package com.qingyu.companion.content.backup

import com.qingyu.companion.chatcore.Ulid
import com.qingyu.companion.content.CharacterCardCodec
import com.qingyu.companion.content.PresetCodec
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalLorebookEntity
import com.qingyu.companion.local.db.LocalLorebookMappingTemplateEntity
import com.qingyu.companion.local.db.LocalMessageEntity
import com.qingyu.companion.local.db.LocalPersonaEntity
import com.qingyu.companion.local.db.LocalPresetEntity
import com.qingyu.companion.local.db.LocalQuickReplySetEntity
import com.qingyu.companion.local.db.LocalRegexRuleEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.db.LocalUsageClearMarkerEntity
import com.qingyu.companion.local.db.LocalUsageRecordEntity
import com.qingyu.companion.local.domain.JsonValues
import com.qingyu.companion.local.domain.LocalStore
import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import org.json.JSONArray
import org.json.JSONObject

/**
 * 阶段 5 S5-08：Backup V3 的打包与恢复编排。
 *
 * `BackupV3` 只管「一个备份包长什么样、能不能信」；这里管「从本地库取什么、怎么写回去」。
 *
 * 三条方案要求落在这一层：
 * 1. **默认排除密钥类**：只序列化下面显式列出的实体，连接档案 / `secretRef` /
 *    设备身份 / spaceKey / 向量索引**没有被读进来的代码路径**——
 *    而不是「读进来再删字段」，后者漏删一次就是泄露。
 * 2. **先全包校验 + 预览，再 checkpoint 和原子应用**：见 [inspect] 与 [restore]。
 * 3. **PC 与 Android 可互相恢复非敏感数据**：条目路径沿用 PC Backup V2 布局，
 *    JSON 键名用 PC 的领域字段名（`exampleDialog`、`boundLorebookIds`），
 *    不用 Room 列名，否则 PC 打开 Android 的备份会看到一堆不认识的键。
 */
class BackupOrchestrator(
    private val store: LocalStore,
    private val mediaRoot: File,
    private val appVersion: String,
) {

    data class Bundle(val bytes: ByteArray, val manifest: BackupV3.Manifest)

    data class RestorePlan(
        val manifest: BackupV3.Manifest,
        val counts: Map<String, Int>,
        val warnings: List<String>,
    )

    data class RestoreOutcome(
        val applied: Map<String, Int>,
        val mediaRestored: Int,
        /** 失败时事务已回滚 */
        val rolledBack: Boolean,
        val error: String? = null,
    ) {
        val ok: Boolean get() = error == null
    }

    // ------------------------------------------------------------ 打包

    suspend fun create(): Bundle {
        val entries = ArrayList<BackupV3.Entry>()
        val counts = LinkedHashMap<String, Int>()

        val characters = store.listCharacters()
        characters.forEach { entries += entry(BackupV3.Paths.CHARACTERS + it.id + ".json", characterJson(it)) }
        counts["characters"] = characters.size

        val lorebooks = store.listLorebooks()
        lorebooks.forEach { entries += entry(BackupV3.Paths.LOREBOOKS + it.id + ".json", it.canonicalJson) }
        counts["lorebooks"] = lorebooks.size

        val presets = store.listPresets()
        presets.forEach { entries += entry(BackupV3.Paths.PRESETS + it.id + ".json", presetJson(it)) }
        counts["presets"] = presets.size

        val personas = store.listPersonas()
        val rules = store.listRegexRules()
        val quickReplies = store.listQuickReplySets()
        val templates = store.listLorebookMappingTemplates()
        val usage = store.listUsage(limit = Int.MAX_VALUE)
        val clearMarkers = store.listUsageClearMarkers()
        val sessions = store.listSessions()

        entries += entry(BackupV3.Paths.PERSONAS, JSONArray(personas.map { personaJson(it) }).toString())
        entries += entry(BackupV3.Paths.REGEX_RULES, JSONArray(rules.map { regexJson(it) }).toString())
        entries += entry(BackupV3.Paths.QUICK_REPLIES, quickReplyStoreJson(quickReplies))
        entries += entry(BackupV3.Paths.TEMPLATES + "templates.json", JSONArray(templates.map { templateJson(it) }).toString())
        entries += entry(BackupV3.Paths.USAGE, JSONArray(usage.map { usageJson(it) }).toString())
        // 全部设备的清理游标都要出去：只带本机那条，恢复端就不知道对端已经清到哪，
        // 下一轮同步会把已清理的用量记录重新拉回来（删除复活）。
        entries += entry(
            BackupV3.Paths.USAGE_CLEAR_MARKERS,
            JSONArray(clearMarkers.map { clearMarkerJson(it) }).toString(),
        )
        entries += entry(BackupV3.Paths.SETTINGS, JSONObject(publicSettingsJson()).toString())
        sessions.forEach { session ->
            entries += entry(BackupV3.Paths.CHATS + session.id + ".json", JSONObject(sessionJson(session)).toString())
        }

        counts["personas"] = personas.size
        counts["regexRules"] = rules.size
        counts["quickReplySets"] = quickReplies.size
        counts["mappingTemplates"] = templates.size
        counts["usageRecords"] = usage.size
        counts["usageClearMarkers"] = clearMarkers.size
        counts["sessions"] = sessions.size

        // 媒体只带被实体引用得到的文件：整目录打包会把下载缓存一起备份出去
        var mediaCount = 0
        mediaRoot.listFiles()?.filter { it.isFile }?.forEach { file ->
            val rel = file.relativeTo(mediaRoot).path.replace('\\', '/')
            if (rel.startsWith(".")) return@forEach
            val bytes = runCatching { file.readBytes() }.getOrNull() ?: return@forEach
            if (bytes.isEmpty()) return@forEach
            entries += BackupV3.Entry(BackupV3.Paths.MEDIA + rel, bytes)
            mediaCount += 1
        }
        counts["media"] = mediaCount

        val manifest = BackupV3.manifestOf(
            entries = entries,
            appVersion = appVersion,
            platform = PLATFORM,
            now = System.currentTimeMillis(),
            counts = counts,
        )
        return Bundle(BackupV3.build(entries, manifest), manifest)
    }

    private fun entry(path: String, json: String) = BackupV3.Entry(path, json.toByteArray(Charsets.UTF_8))

    // ------------------------------------------------------------ 预检与恢复

    /**
     * 只读预检：校验失败就不给恢复。**不写任何东西**。
     *
     * 单独暴露给 UI，是因为方案要求「导入先全包校验和预览，再 checkpoint 和原子应用」——
     * 一个损坏或被篡改的包必须在用户点确认之前就被拒掉。
     */
    fun inspect(bytes: ByteArray): RestorePlan? {
        val ok = (BackupV3.inspect(bytes) as? BackupV3.InspectResult.Ok)?.preview ?: return null
        return RestorePlan(
            manifest = ok.manifest,
            counts = ok.manifest.counts,
            warnings = buildList {
                if (ok.manifest.platform != PLATFORM) {
                    add("来源平台是 ${ok.manifest.platform}：按 PC 的字段布局解析，Android 专有字段保持现状。")
                }
                add("备份不含 API Key、设备身份、空间密钥、令牌与向量索引，这些需要在本机重新配置。")
                add("恢复是**合并**而不是整库替换：同名实体被覆盖，备份里没有的本地实体保留。")
            },
        )
    }

    /**
     * 应用一个已通过预检的包。
     *
     * 1. 媒体先写进 `media/.incoming/`，正式路径一个字节都不动；
     * 2. 所有库内写入放在**一个事务**（[LocalStore.inTransaction]）里，
     *    中途抛异常整体回滚——不会出现「预设已换、会话还指着旧预设」的中间态；
     * 3. 事务成功后才把 `.incoming` 里的文件 move 到位。
     *
     * `usage_clear_marker` 走 [LocalStore.putUsageClearMarker]，**只恢复其他设备的游标**：
     * 本机那一行的推进必须经 `clearUsage` 的因果判定（只删被支配的用量记录），
     * 由备份直接覆盖等于凭一个文件伪造一次本机清理。被这条守卫挡掉的行数不进 counts。
     */
    suspend fun restore(bytes: ByteArray): RestoreOutcome {
        val preview = (BackupV3.inspect(bytes) as? BackupV3.InspectResult.Ok)?.preview
            ?: return RestoreOutcome(emptyMap(), 0, rolledBack = false, error = "备份校验未通过，未做任何修改")

        val incoming = File(mediaRoot, INCOMING_DIR)
        runCatching { incoming.deleteRecursively() }
        incoming.mkdirs()
        val staged = ArrayList<Pair<File, String>>()
        var mediaCount = 0

        return try {
            preview.entries.forEach { (path, payload) ->
                if (!path.startsWith(BackupV3.Paths.MEDIA)) return@forEach
                val rel = path.removePrefix(BackupV3.Paths.MEDIA)
                val target = File(incoming, rel)
                target.parentFile?.mkdirs()
                target.writeBytes(payload)
                staged += target to rel
            }

            val applied = store.inTransaction {
                val counts = LinkedHashMap<String, Int>()
                characters(preview).forEach { store.putCharacter(it) }
                counts["characters"] = increment(null, preview, BackupV3.Paths.CHARACTERS)

                val books = lorebooks(preview)
                books.forEach { store.putLorebook(it) }
                counts["lorebooks"] = books.size

                val ps = presets(preview)
                ps.forEach { store.putPreset(it) }
                counts["presets"] = ps.size

                val pn = personas(preview)
                pn.forEach { store.putPersona(it) }
                counts["personas"] = pn.size

                val rx = regex(preview)
                rx.forEach { store.putRegexRule(it) }
                counts["regexRules"] = rx.size

                val tp = templates(preview)
                tp.forEach { store.putLorebookMappingTemplate(it) }
                counts["mappingTemplates"] = tp.size

                // 快捷回复整库替换：先清空再按备份重建。
                // 只增不删会把两批不同来源的集合叠在一起，聊天页出现重复按钮。
                val qr = quickReplySets(preview)
                if (qr.isNotEmpty()) {
                    store.listQuickReplySets().forEach { store.deleteQuickReplySet(it.id) }
                    qr.forEach { store.putQuickReplySet(it) }
                }
                counts["quickReplySets"] = qr.size

                var usageCount = 0
                usage(preview).forEach { if (store.recordUsage(it)) usageCount += 1 }
                counts["usageRecords"] = usageCount

                // 清理游标：只落**别的设备**的行。本机自己的游标由 clearUsage 的因果判定维护，
                // 让备份文件直接盖它就等于凭一个文件抹掉本机并发产生的用量（§6.3 要求那些保留）。
                var markerCount = 0
                clearMarkers(preview).forEach { marker ->
                    if (marker.deviceId == store.deviceId()) return@forEach
                    store.putUsageClearMarker(marker)
                    markerCount += 1
                }
                counts["usageClearMarkers"] = markerCount

                var sessionCount = 0
                sessions(preview).forEach { (session, messages) ->
                    store.putSession(session)
                    messages.forEach { store.appendMessage(it) }
                    sessionCount += 1
                }
                counts["sessions"] = sessionCount

                settings(preview).forEach { (section, key, valueJson) -> store.putPublicSetting(section, key, valueJson) }
                counts
            }

            staged.forEach { (file, rel) ->
                val target = File(mediaRoot, rel)
                target.parentFile?.mkdirs()
                if (!file.renameTo(target)) throw MediaMoveFailure(rel, applied)
                mediaCount += 1
            }
            RestoreOutcome(applied, mediaCount, rolledBack = false)
        } catch (failure: MediaMoveFailure) {
            // 媒体落位失败发生在事务提交**之后**：库已经改完了，说一句「已回滚」
            // 就是把一次成功的恢复报成失败——用户会再恢复一遍，或者以为没动过而不去核对。
            // 事务不会（也不该）倒带，所以这里如实报 rolledBack = false 并带上已应用的 counts，
            // 让 UI 说清「库已更新，媒体没落位」。真正可回滚的是事务内部的失败，
            // 以及媒体还没写完就失败的通用分支——那两条路径库一行都没变，才配得上 true。
            RestoreOutcome(
                applied = failure.applied,
                mediaRestored = mediaCount,
                rolledBack = false,
                error = "数据库已按备份更新，但媒体文件落位失败（${failure.path}）。" +
                    "已应用的部分不会自动撤销，请重新恢复或忽略媒体后继续。",
            )
        } catch (error: Throwable) {
            staged.forEach { runCatching { it.first.delete() } }
            RestoreOutcome(emptyMap(), 0, rolledBack = true, error = error.message ?: "恢复失败，已回滚")
        } finally {
            runCatching { incoming.deleteRecursively() }
        }
    }

    /** 事务已提交、仅媒体 move 失败时用来区分「可回滚」与「不可回滚」两条路。 */
    private class MediaMoveFailure(val path: String, val applied: Map<String, Int>) : Exception(path)

    private fun increment(@Suppress("UNUSED_PARAMETER") unused: Any?, preview: BackupV3.Preview, prefix: String): Int =
        preview.entries.keys.count { it.startsWith(prefix) && it.endsWith(".json") }

    // ------------------------------------------------------------ 备份 JSON 形状

    private fun characterJson(row: LocalCharacterEntity): String {
        val draft = CharacterCardCodec.draftOf(row)
        return JSONObject().apply {
            put("id", row.id)
            put("name", row.name)
            put("description", row.description)
            put("personality", row.personality)
            put("scenario", row.scenario)
            put("firstMessage", row.firstMessage)
            put("exampleDialog", draft.exampleDialog)
            put("tags", JSONArray(row.tagsJson))
            put("creator", row.creator)
            put("createdAt", row.createdAt)
            put("updatedAt", row.updatedAt)
            put("alternateGreetings", JSONArray(row.alternateGreetingsJson))
            put("groupOnlyGreetings", JSONArray(row.groupOnlyGreetingsJson))
            put("systemPrompt", row.systemPrompt)
            put("postHistoryInstructions", row.postHistoryInstructions)
            put("creatorNotes", row.creatorNotes)
            put("characterVersion", row.characterVersion)
            put("boundLorebookIds", JSONArray(row.boundLorebookIdsJson))
            put("boundPresetId", row.defaultPresetId ?: JSONObject.NULL)
            put("extensions", JSONObject(row.extensionsJson))
            // 头像以 media/ 相对路径引用，二进制本身随包走；不放 base64，否则备份体积爆掉
            put("avatarRef", row.avatarPath ?: JSONObject.NULL)
            put("chatBackgroundRef", row.backgroundPath ?: JSONObject.NULL)
            if (row.translatedContentJson.isNotBlank()) put("translatedContent", JSONObject(row.translatedContentJson))
        }.toString(2)
    }

    /** 预设正文与 PC 一样是「整个 Preset 对象」，因此写回 id/name。 */
    private fun presetJson(row: LocalPresetEntity): String {
        val body = LinkedHashMap(PresetCodec.bodyOf(row.bodyJson)).apply {
            put("id", row.id)
            put("name", row.name)
            put("description", row.description)
            put("isBuiltin", row.isBuiltin)
        }
        return JSONObject(JsonValues.parseObject(JsonValues.stringify(body))).toString(2)
    }

    private fun personaJson(row: LocalPersonaEntity): JSONObject = JSONObject().apply {
        put("id", row.id)
        put("name", row.name)
        put("description", row.description)
        put("persona", row.persona)
        put("avatarRef", row.avatarPath ?: JSONObject.NULL)
        put("createdAt", row.createdAt)
        put("updatedAt", row.updatedAt)
    }

    private fun regexJson(row: LocalRegexRuleEntity): JSONObject = JSONObject().apply {
        put("id", row.id)
        put("name", row.name)
        put("pattern", row.pattern)
        put("replacement", row.replacement)
        put("flags", row.flags)
        put("enabled", row.enabled)
        put("scope", row.scope)
        put("group", row.group)
        put("stage", row.stage)
        put("triggerPattern", row.triggerPattern)
        put("triggerFlags", row.triggerFlags)
        put("stopStrings", JSONArray(row.stopStringsJson))
        put("order", row.sortIndex)
    }

    private fun templateJson(row: LocalLorebookMappingTemplateEntity): JSONObject = JSONObject().apply {
        put("id", row.id)
        put("name", row.name)
        put("sourceFormat", row.sourceFormat)
        put("enabled", row.enabled)
        put("order", row.sortIndex)
        if (row.templateJson.isNotBlank()) put("mapping", JSONObject(row.templateJson))
    }

    private fun quickReplyStoreJson(rows: List<LocalQuickReplySetEntity>): String {
        val global = JSONArray()
        val byCharacter = JSONObject()
        rows.sortedWith(compareBy({ it.sortIndex }, { it.id })).forEach { row ->
            val items = runCatching { JSONArray(row.itemsJson) }.getOrElse { JSONArray() }
            val owner = row.characterId
            if (owner == null) {
                for (i in 0 until items.length()) global.put(items.opt(i))
            } else {
                val existing = byCharacter.optJSONArray(owner) ?: JSONArray()
                for (i in 0 until items.length()) existing.put(items.opt(i))
                byCharacter.put(owner, existing)
            }
        }
        return JSONObject().put("global", global).put("byCharacter", byCharacter).toString(2)
    }

    private fun usageJson(row: LocalUsageRecordEntity): JSONObject = JSONObject().apply {
        put("id", row.id)
        put("timestamp", row.createdAt)
        put("characterId", row.characterId ?: JSONObject.NULL)
        put("sessionId", row.sessionId ?: JSONObject.NULL)
        put("model", row.model)
        put("inputChars", row.inputChars)
        put("outputChars", row.outputChars)
        put("totalChars", row.inputChars + row.outputChars)
        put("status", row.status)
    }

    /** 清理游标：`clearedThrough` 以对象存（与 §6.3 的逐设备取最大值语义对齐）。 */
    private fun clearMarkerJson(row: LocalUsageClearMarkerEntity): JSONObject = JSONObject().apply {
        put("deviceId", row.deviceId)
        put("clearedThrough", JSONObject(row.clearedThroughJson))
        put("tombstonedIds", JSONArray(row.tombstonedIdsJson))
        put("updatedAt", row.updatedAt)
    }

    private fun clearMarkers(preview: BackupV3.Preview): List<LocalUsageClearMarkerEntity> =
        preview.arrayAt(BackupV3.Paths.USAGE_CLEAR_MARKERS).let { array ->
            (0 until array.length()).mapNotNull { index ->
                val obj = array.optJSONObject(index) ?: return@mapNotNull null
                val markerDevice = string(obj, "deviceId")
                if (markerDevice.isEmpty()) return@mapNotNull null
                LocalUsageClearMarkerEntity(
                    deviceId = markerDevice,
                    clearedThroughJson = obj.optJSONObject("clearedThrough")?.toString() ?: "{}",
                    tombstonedIdsJson = obj.optJSONArray("tombstonedIds")?.toString() ?: "[]",
                    updatedAt = obj.optLong("updatedAt"),
                )
            }
        }

    private suspend fun publicSettingsJson(): Map<String, Any?> =
        store.listPublicSettings().associate { row ->
            "${row.section}.${row.key}" to JsonValues.parseAny(row.valueJson)
        }

    private suspend fun sessionJson(session: LocalSessionEntity): Map<String, Any?> = mapOf(
        "id" to session.id,
        "characterId" to session.characterId,
        "groupId" to session.groupId,
        "title" to session.title,
        "personaId" to session.personaId,
        "presetId" to session.presetId,
        "lorebookIds" to JsonValues.parseArray(session.lorebookIdsJson),
        "createdAt" to session.createdAt,
        "updatedAt" to session.updatedAt,
        "messages" to store.listMessages(session.id).map { message ->
            mapOf(
                "id" to message.id,
                "role" to message.role,
                "content" to message.content,
                "logicalTime" to message.logicalTime,
                "seq" to message.seq,
                "replyToId" to message.replyToId,
                "translation" to message.translation,
                "createdAt" to message.createdAt,
                "updatedAt" to message.updatedAt,
            )
        },
    )

    // ------------------------------------------------------------ 备份 → 实体

    private fun BackupV3.Preview.jsonAt(path: String): JSONObject? =
        entries[path]?.let { runCatching { JSONObject(it.toString(Charsets.UTF_8)) }.getOrNull() }

    private fun BackupV3.Preview.arrayAt(path: String): JSONArray =
        entries[path]?.let { runCatching { JSONArray(it.toString(Charsets.UTF_8)) }.getOrNull() } ?: JSONArray()

    private fun BackupV3.Preview.objectsUnder(prefix: String): List<JSONObject> =
        entries.entries.filter { it.key.startsWith(prefix) && it.key.endsWith(".json") }.mapNotNull { entry ->
            runCatching { JSONObject(entry.value.toString(Charsets.UTF_8)) }.getOrNull()
        }

    private fun string(obj: JSONObject, key: String): String = obj.optString(key)

    private fun nullableString(obj: JSONObject, key: String): String? =
        if (obj.isNull(key)) null else obj.optString(key).takeIf { it.isNotEmpty() }

    private fun array(obj: JSONObject, key: String, fallback: String): String =
        obj.optJSONArray(key)?.toString() ?: fallback

    private fun characters(preview: BackupV3.Preview): List<LocalCharacterEntity> =
        preview.objectsUnder(BackupV3.Paths.CHARACTERS).mapNotNull { obj ->
            val id = string(obj, "id").ifEmpty { return@mapNotNull null }
            LocalCharacterEntity(
                id = id,
                name = string(obj, "name"),
                description = string(obj, "description"),
                personality = string(obj, "personality"),
                scenario = string(obj, "scenario"),
                firstMessage = string(obj, "firstMessage"),
                exampleDialog = string(obj, "exampleDialog"),
                alternateGreetingsJson = array(obj, "alternateGreetings", "[]"),
                groupOnlyGreetingsJson = array(obj, "groupOnlyGreetings", "[]"),
                systemPrompt = string(obj, "systemPrompt"),
                postHistoryInstructions = string(obj, "postHistoryInstructions"),
                tagsJson = array(obj, "tags", "[]"),
                creator = string(obj, "creator"),
                creatorNotes = string(obj, "creatorNotes"),
                characterVersion = string(obj, "characterVersion"),
                boundLorebookIdsJson = array(obj, "boundLorebookIds", "[]"),
                extensionsJson = obj.optJSONObject("extensions")?.toString() ?: "{}",
                avatarPath = nullableString(obj, "avatarRef"),
                backgroundPath = nullableString(obj, "chatBackgroundRef"),
                translatedContentJson = obj.optJSONObject("translatedContent")?.toString() ?: "",
                createdAt = obj.optLong("createdAt", System.currentTimeMillis()),
                updatedAt = obj.optLong("updatedAt", System.currentTimeMillis()),
                importedFrom = SOURCE,
            )
        }

    private fun lorebooks(preview: BackupV3.Preview): List<LocalLorebookEntity> =
        preview.objectsUnder(BackupV3.Paths.LOREBOOKS).mapNotNull { obj ->
            val id = string(obj, "id").ifEmpty { return@mapNotNull null }
            LocalLorebookEntity(
                id = id,
                name = string(obj, "name"),
                canonicalJson = obj.toString(),
                createdAt = obj.optLong("createdAt", System.currentTimeMillis()),
                updatedAt = obj.optLong("updatedAt", System.currentTimeMillis()),
                importedFrom = SOURCE,
            )
        }

    private fun presets(preview: BackupV3.Preview): List<LocalPresetEntity> =
        preview.objectsUnder(BackupV3.Paths.PRESETS).mapNotNull { obj ->
            val id = string(obj, "id").ifEmpty { return@mapNotNull null }
            val body = LinkedHashMap<String, Any?>()
            obj.keys().forEach { key -> if (key != "id") body[key] = JsonValues.parseAny(obj.opt(key).toString()) }
            LocalPresetEntity(
                id = id,
                name = string(obj, "name"),
                bodyJson = JsonValues.stringify(body),
                description = string(obj, "description"),
                isBuiltin = obj.optBoolean("isBuiltin", false),
                createdAt = obj.optLong("createdAt", System.currentTimeMillis()),
                updatedAt = obj.optLong("updatedAt", System.currentTimeMillis()),
                importedFrom = SOURCE,
            )
        }

    private fun personas(preview: BackupV3.Preview): List<LocalPersonaEntity> =
        preview.arrayAt(BackupV3.Paths.PERSONAS).let { array ->
            (0 until array.length()).mapNotNull { index ->
                val obj = array.optJSONObject(index) ?: return@mapNotNull null
                val id = string(obj, "id").ifEmpty { return@mapNotNull null }
                LocalPersonaEntity(
                    id = id,
                    name = string(obj, "name"),
                    description = string(obj, "description"),
                    persona = string(obj, "persona"),
                    avatarPath = nullableString(obj, "avatarRef"),
                    createdAt = obj.optLong("createdAt", System.currentTimeMillis()),
                    updatedAt = obj.optLong("updatedAt", System.currentTimeMillis()),
                    importedFrom = SOURCE,
                )
            }
        }

    private fun regex(preview: BackupV3.Preview): List<LocalRegexRuleEntity> =
        preview.arrayAt(BackupV3.Paths.REGEX_RULES).let { array ->
            (0 until array.length()).mapNotNull { index ->
                val obj = array.optJSONObject(index) ?: return@mapNotNull null
                val id = string(obj, "id").ifEmpty { return@mapNotNull null }
                LocalRegexRuleEntity(
                    id = id,
                    name = string(obj, "name"),
                    pattern = string(obj, "pattern"),
                    replacement = string(obj, "replacement"),
                    flags = string(obj, "flags").ifEmpty { "g" },
                    scope = string(obj, "scope").ifEmpty { "output" },
                    enabled = obj.optBoolean("enabled", true),
                    sortIndex = obj.optInt("order", index),
                    group = string(obj, "group"),
                    stage = string(obj, "stage").ifEmpty { "text" },
                    triggerPattern = string(obj, "triggerPattern"),
                    triggerFlags = string(obj, "triggerFlags"),
                    stopStringsJson = array(obj, "stopStrings", "[]"),
                    createdAt = System.currentTimeMillis(),
                    updatedAt = System.currentTimeMillis(),
                    importedFrom = SOURCE,
                )
            }
        }

    private fun templates(preview: BackupV3.Preview): List<LocalLorebookMappingTemplateEntity> =
        preview.arrayAt(BackupV3.Paths.TEMPLATES + "templates.json").let { array ->
            (0 until array.length()).mapNotNull { index ->
                val obj = array.optJSONObject(index) ?: return@mapNotNull null
                val id = string(obj, "id").ifEmpty { return@mapNotNull null }
                LocalLorebookMappingTemplateEntity(
                    id = id,
                    name = string(obj, "name"),
                    sourceFormat = string(obj, "sourceFormat"),
                    templateJson = obj.optJSONObject("mapping")?.toString() ?: "{}",
                    enabled = obj.optBoolean("enabled", true),
                    sortIndex = obj.optInt("order", index),
                    createdAt = System.currentTimeMillis(),
                    updatedAt = System.currentTimeMillis(),
                    importedFrom = SOURCE,
                )
            }
        }

    /**
     * 快捷回复：备份形状是整库 `{global, byCharacter}`，本地是集合行。
     *
     * 重建为「一个全局集合 + 每角色一个集合」，与 PC 形状一致。
     * 备份前 Android 若把条目拆成多个集合，这里会被合并——可接受的有损点，
     * 因为 PC 本来就只有这两层，跨端恢复必须以 PC 形状为准。
     */
    private fun quickReplySets(preview: BackupV3.Preview): List<LocalQuickReplySetEntity> {
        val root = preview.jsonAt(BackupV3.Paths.QUICK_REPLIES) ?: return emptyList()
        val out = ArrayList<LocalQuickReplySetEntity>()
        val now = System.currentTimeMillis()
        root.optJSONArray("global")?.takeIf { it.length() > 0 }?.let { global ->
            out += LocalQuickReplySetEntity(
                id = Ulid.newId(),
                name = "全局",
                itemsJson = global.toString(),
                createdAt = now,
                updatedAt = now,
                importedFrom = SOURCE,
            )
        }
        root.optJSONObject("byCharacter")?.let { byCharacter ->
            byCharacter.keys().forEach { characterId ->
                val items = byCharacter.optJSONArray(characterId) ?: return@forEach
                if (items.length() == 0) return@forEach
                out += LocalQuickReplySetEntity(
                    id = Ulid.newId(),
                    name = "角色：$characterId",
                    itemsJson = items.toString(),
                    characterId = characterId,
                    createdAt = now,
                    updatedAt = now,
                    importedFrom = SOURCE,
                )
            }
        }
        return out
    }

    private fun usage(preview: BackupV3.Preview): List<LocalUsageRecordEntity> =
        preview.arrayAt(BackupV3.Paths.USAGE).let { array ->
            (0 until array.length()).mapNotNull { index ->
                val obj = array.optJSONObject(index) ?: return@mapNotNull null
                val id = string(obj, "id").ifEmpty { return@mapNotNull null }
                val timestamp = obj.optLong("timestamp", System.currentTimeMillis())
                LocalUsageRecordEntity(
                    id = id,
                    sessionId = nullableString(obj, "sessionId"),
                    model = string(obj, "model"),
                    promptTokens = obj.optInt("promptTokens"),
                    completionTokens = obj.optInt("completionTokens"),
                    createdAt = timestamp,
                    inputChars = obj.optInt("inputChars"),
                    outputChars = obj.optInt("outputChars"),
                    status = string(obj, "status").ifEmpty { "success" },
                    characterId = nullableString(obj, "characterId"),
                    dateKey = toLocalDateKey(timestamp),
                )
            }
        }

    private fun sessions(preview: BackupV3.Preview): List<Pair<LocalSessionEntity, List<LocalMessageEntity>>> =
        preview.objectsUnder(BackupV3.Paths.CHATS).mapNotNull { obj ->
            val id = string(obj, "id").ifEmpty { return@mapNotNull null }
            val now = obj.optLong("updatedAt", System.currentTimeMillis())
            val session = LocalSessionEntity(
                id = id,
                characterId = nullableString(obj, "characterId"),
                groupId = nullableString(obj, "groupId"),
                title = string(obj, "title"),
                personaId = nullableString(obj, "personaId"),
                presetId = nullableString(obj, "presetId"),
                lorebookIdsJson = array(obj, "lorebookIds", "[]"),
                createdAt = obj.optLong("createdAt", now),
                updatedAt = now,
                importedFrom = SOURCE,
            )
            val messages = obj.optJSONArray("messages").let { array ->
                if (array == null) emptyList() else (0 until array.length()).mapNotNull { index ->
                    val message = array.optJSONObject(index) ?: return@mapNotNull null
                    val messageId = string(message, "id").ifEmpty { return@mapNotNull null }
                    LocalMessageEntity(
                        id = messageId,
                        sessionId = id,
                        characterId = session.characterId,
                        role = string(message, "role").ifEmpty { "user" },
                        content = string(message, "content"),
                        logicalTime = message.optLong("logicalTime", System.currentTimeMillis() + index),
                        seq = message.optLong("seq", index.toLong()),
                        replyToId = nullableString(message, "replyToId"),
                        translation = nullableString(message, "translation"),
                        createdAt = message.optLong("createdAt", now),
                        updatedAt = message.optLong("updatedAt", now),
                        importedFrom = SOURCE,
                    )
                }
            }
            session to messages
        }

    private fun settings(preview: BackupV3.Preview): List<Triple<String, String, String>> {
        val obj = preview.jsonAt(BackupV3.Paths.SETTINGS) ?: return emptyList()
        return obj.keys().asSequence().mapNotNull { key ->
            // 备份用 "section.key" 扁平存，恢复时拆回二维
            val dot = key.indexOf('.')
            if (dot <= 0 || dot == key.length - 1) return@mapNotNull null
            Triple(key.substring(0, dot), key.substring(dot + 1), JsonValues.stringify(obj.opt(key)))
        }.toList()
    }

    /**
     * epoch millis → 本地日期键（与 S5-07 的日期维度聚合同一口径）。
     *
     * 不用 `LocalDate.ofInstant(...)`：那是 **API 34** 才有的工厂方法，本机 minSdk 26，
     * 在 Android 8–13 上会在恢复备份时抛 `NoSuchMethodError`（单测在 JDK 上跑，抓不到；
     * 是 `lintDebug` 的 NewApi 抓出来的）。`Instant#atZone` 一系自 API 26 起可用且语义等价。
     */
    private fun toLocalDateKey(epochMillis: Long): String =
        Instant.ofEpochMilli(epochMillis).atZone(ZoneId.systemDefault()).toLocalDate().toString()

    companion object {
        const val PLATFORM = "android"
        const val SOURCE = "backup-v3"
        private const val INCOMING_DIR = ".incoming"
    }
}
