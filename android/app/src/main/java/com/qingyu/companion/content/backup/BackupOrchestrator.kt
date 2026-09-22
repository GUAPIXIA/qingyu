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

        // U-6-8：群行（含调度列）与群消息进包。群会话本身已随 chats/{sessionId}.json（带 groupId）出包；
        // 群消息按群聚成一个数组文件，恢复时在**第三遍**（会话之后）落库——FK 级联要求会话先行。
        val groups = store.listGroups()
        var groupMessageCount = 0
        groups.forEach { group ->
            entries += entry(BackupV3.Paths.GROUPS + group.id + ".json", groupJson(group))
            val messages = sessions.filter { it.groupId == group.id }
                .flatMap { store.listGroupMessages(it.id) }
            entries += entry(
                BackupV3.Paths.GROUPS + group.id + GROUP_MESSAGES_SUFFIX,
                JSONArray(messages.map { groupMessageJson(it) }).toString(),
            )
            groupMessageCount += messages.size
        }

        counts["personas"] = personas.size
        counts["regexRules"] = rules.size
        counts["quickReplySets"] = quickReplies.size
        counts["mappingTemplates"] = templates.size
        counts["usageRecords"] = usage.size
        counts["usageClearMarkers"] = clearMarkers.size
        counts["sessions"] = sessions.size
        counts["groups"] = groups.size
        counts["groupMessages"] = groupMessageCount

        // 媒体：**必须递归**收集。
        //
        // `MediaImportGate` 把文件放在 `media/<kind>/<sha>.<ext>` 下，实体里的
        // `avatarRef`/`chatBackgroundRef` 就是那个相对路径（`"avatar/<sha>.png"`）。
        // 此前这里只扫 `mediaRoot.listFiles()` 的**顶层文件**（非递归），于是
        // `media/avatar/...` 一个都进不了包——**所有媒体都没有被备份**，而且是静默的：
        // 恢复端只看到角色少了头像，`counts["media"]` 恒为 0，没有任何报错或提示。
        // 注释当时写的是「只带被实体引用得到的文件」，即**注释描述的是意图、代码做的是另一件事**。
        //
        // 现在按「递归收集 + 排除恢复暂存区」实现：媒体目录里只有 MediaImportGate 写的内容寻址文件
        // 与 `.incoming/`（恢复时的暂存目录，绝不能被打进包），没有下载缓存之类的东西，
        // 所以递归不会把无关数据捎上；少带文件比多带文件危险得多（引用会指向缺失文件）。
        var mediaCount = 0
        mediaRoot.walkTopDown()
            .onEnter { it.name != INCOMING_DIR }
            .filter { it.isFile }
            .forEach { file ->
                val rel = file.relativeTo(mediaRoot).path.replace('\\', '/')
                // 点开头的路径一律不带（`.incoming/`、编辑器可能留下的临时文件）
                if (rel.split('/').any { it.startsWith(".") }) return@forEach
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

    // ------------------------------------------------------------ U-6-8 群数据序列化
    // 字段与 LocalGroupEntity（18 列，含 9 调度列）/LocalGroupMessageEntity（24 列）逐一对称；
    // 备份是跨版本存档，**显式列字段**而不是反射/序列化器推断——缺列会在 BackupGroupRoundTripTest 变红。

    private val GROUP_MESSAGES_SUFFIX = ".messages.json"

    private fun groupJson(row: com.qingyu.companion.local.db.LocalGroupEntity): String = JSONObject().apply {
        put("id", row.id)
        put("name", row.name)
        put("mode", row.mode)
        put("characterIdsJson", row.characterIdsJson)
        put("memoryEnabled", row.memoryEnabled)
        put("avatarPath", row.avatarPath)
        put("importedFrom", row.importedFrom)
        put("createdAt", row.createdAt)
        put("updatedAt", row.updatedAt)
        put("chatMode", row.chatMode)
        put("autoMode", row.autoMode)
        put("maxRounds", row.maxRounds)
        put("speakerInterval", row.speakerInterval)
        put("currentSpeakerIndex", row.currentSpeakerIndex)
        put("presetId", row.presetId)
        put("systemPrompt", row.systemPrompt)
        put("lorebookIdsJson", row.lorebookIdsJson)
        put("defaultNarrativeMode", row.defaultNarrativeMode)
    }.toString()

    private fun groupOf(payload: ByteArray): com.qingyu.companion.local.db.LocalGroupEntity? {
        val obj = JSONObject(String(payload, Charsets.UTF_8))
        val id = obj.optString("id")
        if (id.isEmpty()) return null
        return com.qingyu.companion.local.db.LocalGroupEntity(
            id = id,
            name = obj.optString("name"),
            mode = obj.optString("mode", "group"),
            characterIdsJson = obj.optString("characterIdsJson", "[]"),
            memoryEnabled = obj.optBoolean("memoryEnabled", true),
            avatarPath = if (obj.isNull("avatarPath")) null else obj.optString("avatarPath"),
            importedFrom = if (obj.isNull("importedFrom")) null else obj.optString("importedFrom"),
            createdAt = obj.optLong("createdAt"),
            updatedAt = obj.optLong("updatedAt"),
            chatMode = obj.optString("chatMode", "mention"),
            autoMode = obj.optBoolean("autoMode"),
            maxRounds = obj.optInt("maxRounds", 3),
            speakerInterval = obj.optInt("speakerInterval", 1500),
            currentSpeakerIndex = obj.optInt("currentSpeakerIndex"),
            presetId = if (obj.isNull("presetId")) null else obj.optString("presetId"),
            systemPrompt = obj.optString("systemPrompt"),
            lorebookIdsJson = obj.optString("lorebookIdsJson", "[]"),
            defaultNarrativeMode = obj.optString("defaultNarrativeMode", "immersive"),
        )
    }

    private fun groupMessageJson(row: com.qingyu.companion.local.db.LocalGroupMessageEntity): JSONObject = JSONObject().apply {
        put("id", row.id)
        put("sessionId", row.sessionId)
        put("groupId", row.groupId)
        put("characterId", row.characterId)
        put("content", row.content)
        put("imagesJson", row.imagesJson)
        put("round", row.round)
        put("translation", row.translation)
        put("replyToId", row.replyToId)
        put("status", row.status)
        put("mentionedIdsJson", row.mentionedIdsJson)
        put("narrativeMode", row.narrativeMode)
        put("speakerKind", row.speakerKind)
        put("generationKind", row.generationKind)
        put("dialogueDirectionsJson", row.dialogueDirectionsJson)
        put("dialogueDirectionsGeneratedAt", row.dialogueDirectionsGeneratedAt)
        put("generationNotice", row.generationNotice)
        put("generationError", row.generationError)
        put("contentRenderMode", row.contentRenderMode)
        put("logicalTime", row.logicalTime)
        put("seq", row.seq)
        put("importedFrom", row.importedFrom)
        put("createdAt", row.createdAt)
        put("updatedAt", row.updatedAt)
    }

    private fun groupMessageOf(obj: JSONObject): com.qingyu.companion.local.db.LocalGroupMessageEntity? {
        val id = obj.optString("id")
        if (id.isEmpty()) return null
        return com.qingyu.companion.local.db.LocalGroupMessageEntity(
            id = id,
            sessionId = obj.optString("sessionId"),
            groupId = obj.optString("groupId"),
            characterId = obj.optString("characterId"),
            content = obj.optString("content"),
            imagesJson = obj.optString("imagesJson", "[]"),
            round = obj.optInt("round", 1),
            translation = if (obj.isNull("translation")) null else obj.optString("translation"),
            replyToId = if (obj.isNull("replyToId")) null else obj.optString("replyToId"),
            status = if (obj.isNull("status")) null else obj.optString("status"),
            mentionedIdsJson = obj.optString("mentionedIdsJson", "[]"),
            narrativeMode = if (obj.isNull("narrativeMode")) null else obj.optString("narrativeMode"),
            speakerKind = if (obj.isNull("speakerKind")) null else obj.optString("speakerKind"),
            generationKind = if (obj.isNull("generationKind")) null else obj.optString("generationKind"),
            dialogueDirectionsJson = if (obj.isNull("dialogueDirectionsJson")) null else obj.optString("dialogueDirectionsJson"),
            dialogueDirectionsGeneratedAt = if (obj.isNull("dialogueDirectionsGeneratedAt")) null else obj.optLong("dialogueDirectionsGeneratedAt"),
            generationNotice = if (obj.isNull("generationNotice")) null else obj.optString("generationNotice"),
            generationError = if (obj.isNull("generationError")) null else obj.optString("generationError"),
            contentRenderMode = if (obj.isNull("contentRenderMode")) null else obj.optString("contentRenderMode"),
            logicalTime = obj.optLong("logicalTime"),
            seq = obj.optLong("seq"),
            importedFrom = if (obj.isNull("importedFrom")) null else obj.optString("importedFrom"),
            createdAt = obj.optLong("createdAt"),
            updatedAt = obj.optLong("updatedAt"),
        )
    }

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
        if (BackupV3.inspect(bytes) !is BackupV3.InspectResult.Ok) {
            return RestoreOutcome(emptyMap(), 0, rolledBack = false, error = "备份校验未通过，未做任何修改")
        }

        val incoming = File(mediaRoot, INCOMING_DIR)
        runCatching { incoming.deleteRecursively() }
        incoming.mkdirs()
        val staged = ArrayList<Pair<File, String>>()
        var mediaCount = 0

        return try {
            // ── 第一遍（事务之外）：只把媒体写进暂存区，正式路径一个字节都不动。
            // 媒体写在事务**之前**是有意的：写盘失败时库里一行都没变，才配得上 rolledBack = true。
            BackupV3.streamEntries(bytes) { path, payload ->
                if (path.startsWith(BackupV3.Paths.MEDIA)) {
                    val rel = path.removePrefix(BackupV3.Paths.MEDIA)
                    val target = File(incoming, rel)
                    target.parentFile?.mkdirs()
                    target.writeBytes(payload)
                    staged += target to rel
                }
            }?.let { throw IllegalStateException(it) }

            val applied = store.inTransaction {
                // 这 10 个键在旧实现里**总是存在**（即使计数为 0），UI 与用例都按「键在不在」读它，
                // 所以先归零再累加，保持 `applied` 的形状稳定（例如「包里有 1 条清理游标，
                // 但那是我自己的 → usageClearMarkers=0」是一个有信息量的 0，不是缺键）。
                val counts = LinkedHashMap<String, Int>().apply {
                    listOf(
                        "characters", "lorebooks", "presets", "personas", "regexRules",
                        "mappingTemplates", "quickReplySets", "usageRecords",
                        "usageClearMarkers", "sessions", "groups", "groupMessages",
                    ).forEach { put(it, 0) }
                }
                val quickReplies = ArrayList<LocalQuickReplySetEntity>()

                // ── 第二遍：逐条目流式应用**父实体与配置**（彼此无依赖，读到即写）。
                // 每一轮循环只在内存里有一个条目的字节——这是「备份比堆大也能恢复」的关键。
                BackupV3.streamEntries(bytes) { path, payload ->
                    when {
                        path.startsWith(BackupV3.Paths.CHARACTERS) ->
                            characterOf(payload)?.let { store.putCharacter(it); counts.bump("characters") }

                        path.startsWith(BackupV3.Paths.LOREBOOKS) ->
                            lorebookOf(payload)?.let { store.putLorebook(it); counts.bump("lorebooks") }

                        path.startsWith(BackupV3.Paths.PRESETS) ->
                            presetOf(payload)?.let { store.putPreset(it); counts.bump("presets") }

                        // 映射模板是**一个数组文件**（`templates/templates.json`），不是每实体一文件
                        path == BackupV3.Paths.TEMPLATES + "templates.json" ->
                            eachIndexed(payload) { index, obj ->
                                templateOf(obj, index)?.let { store.putLorebookMappingTemplate(it); counts.bump("mappingTemplates") }
                            }

                        path == BackupV3.Paths.PERSONAS -> eachIndexed(payload) { index, obj ->
                            personaOf(obj)?.let { store.putPersona(it); counts.bump("personas") }
                        }

                        path == BackupV3.Paths.REGEX_RULES -> eachIndexed(payload) { index, obj ->
                            regexOf(obj, index)?.let { store.putRegexRule(it); counts.bump("regexRules") }
                        }

                        // 快捷回复是**整库替换**语义，必须先知道备份里有哪些集合，
                        // 所以只收集、不在这里写——等这一遍读完再清空重建。
                        path == BackupV3.Paths.QUICK_REPLIES ->
                            quickReplySetsOf(payload).forEach { quickReplies += it }

                        path == BackupV3.Paths.USAGE -> eachIndexed(payload) { _, obj ->
                            usageOf(obj)?.let { if (store.recordUsage(it)) counts.bump("usageRecords") }
                        }

                        // 清理游标：只落**别的设备**的行。本机自己的游标由 clearUsage 的因果判定维护，
                        // 让备份文件直接盖它就等于凭一个文件抹掉本机并发产生的用量（§6.3 要求那些保留）。
                        path == BackupV3.Paths.USAGE_CLEAR_MARKERS -> eachIndexed(payload) { _, obj ->
                            clearMarkerOf(obj)?.let { marker ->
                                if (marker.deviceId != store.deviceId()) {
                                    store.putUsageClearMarker(marker)
                                    counts.bump("usageClearMarkers")
                                }
                            }
                        }

                        // U-6-8：群行是**父实体**（第二遍落库）；群消息文件跳过，第三遍在会话之后处理
                        path.startsWith(BackupV3.Paths.GROUPS) && !path.endsWith(GROUP_MESSAGES_SUFFIX) ->
                            groupOf(payload)?.let { store.putGroup(it); counts.bump("groups") }

                        path == BackupV3.Paths.SETTINGS ->
                            settingsOf(payload).forEach { (section, key, valueJson) ->
                                store.putPublicSetting(section, key, valueJson)
                            }

                        // 媒体在第一遍已处理；`groups/` 目前 PC/Android 都还没有群数据；
                        // 其余路径预检已拒（不在清单里就进不来）。
                        else -> Unit
                    }
                }?.let { throw IllegalStateException(it) }

                // 快捷回复整库替换：先清空再按备份重建。
                // 只增不删会把两批不同来源的集合叠在一起，聊天页出现重复按钮。
                if (quickReplies.isNotEmpty()) {
                    store.listQuickReplySets().forEach { store.deleteQuickReplySet(it.id) }
                    quickReplies.forEach { store.putQuickReplySet(it) }
                }
                counts["quickReplySets"] = quickReplies.size

                // ── 第三遍：**子实体**（会话与消息）必须在父（角色/群）之后。
                // 单独走一遍而不是依赖 ZIP 内部顺序：外部产出的包（PC 的）条目顺序不受我们控制，
                // 靠顺序就等于把一个安全属性交给打包方。三遍读的代价是 I/O，不是内存。
                BackupV3.streamEntries(bytes) { path, payload ->
                    if (path.startsWith(BackupV3.Paths.CHATS)) {
                        sessionOf(payload)?.let { (session, messages) ->
                            store.putSession(session)
                            messages.forEach { store.appendMessage(it) }
                            counts.bump("sessions")
                        }
                    }
                    // U-6-8：群消息是**子实体**，必须在群/会话之后（FK 级联）
                    if (path.startsWith(BackupV3.Paths.GROUPS) && path.endsWith(GROUP_MESSAGES_SUFFIX)) {
                        eachIndexed(payload) { _, obj ->
                            groupMessageOf(obj)?.let { store.appendGroupMessage(it); counts.bump("groupMessages") }
                        }
                    }
                }?.let { throw IllegalStateException(it) }

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

    private fun MutableMap<String, Int>.bump(key: String) {
        this[key] = (this[key] ?: 0) + 1
    }

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
                // 「这条是谁说的」必须随包走：群聊/多角色会话里它不等于会话的 characterId
                "characterId" to message.characterId,
                "logicalTime" to message.logicalTime,
                "seq" to message.seq,
                "replyToId" to message.replyToId,
                "translation" to message.translation,
                // 候选回复（swipe）是**用户数据**：重新生成过几次、存了几个候选，
                // 丢了就等于把用户留着的那些分支全删了（§6.3 对 swipe 有专门语义）。
                "swipes" to JsonValues.parseArray(message.swipesJson ?: "[]"),
                "swipeIndex" to message.swipeIndex,
                // 消息配图与用量、以及生成收尾提示：都是本地保真字段，备份必须带上
                "images" to JsonValues.parseArray(message.imagesJson),
                "usage" to JsonValues.parseObject(message.usageJson ?: "{}"),
                "generationStatus" to message.generationStatus,
                "generationNotice" to message.generationNotice,
                "generationError" to message.generationError,
                "createdAt" to message.createdAt,
                "updatedAt" to message.updatedAt,
            )
        },
    )

    // ------------------------------------------------------------ 备份 → 实体
    //
    // 每个映射函数只吃**一个条目的字节**：流式恢复时同一时刻只有一个条目在内存里。
    // 以前它们吃的是整张 `Preview.entries`（整包解压结果都驻留），
    // 那正是「备份比堆大就只能拒绝」的根因（§5-P1-d）。

    private fun jsonOf(payload: ByteArray): JSONObject? =
        runCatching { JSONObject(payload.toString(Charsets.UTF_8)) }.getOrNull()

    private fun arrayOf(payload: ByteArray): JSONArray =
        runCatching { JSONArray(payload.toString(Charsets.UTF_8)) }.getOrNull() ?: JSONArray()

    /** 数组型配置文件（personas / regex / usage / 清理游标 / 映射模板）逐元素交给 [block]。 */
    private inline fun eachIndexed(payload: ByteArray, block: (Int, JSONObject) -> Unit) {
        val array = arrayOf(payload)
        for (index in 0 until array.length()) {
            val obj = array.optJSONObject(index) ?: continue
            block(index, obj)
        }
    }

    private fun string(obj: JSONObject, key: String): String = obj.optString(key)

    private fun nullableString(obj: JSONObject, key: String): String? =
        if (obj.isNull(key)) null else obj.optString(key).takeIf { it.isNotEmpty() }

    private fun array(obj: JSONObject, key: String, fallback: String): String =
        obj.optJSONArray(key)?.toString() ?: fallback

    private fun characterOf(payload: ByteArray): LocalCharacterEntity? {
        val obj = jsonOf(payload) ?: return null
        val id = string(obj, "id").ifEmpty { return null }
        return LocalCharacterEntity(
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

    private fun lorebookOf(payload: ByteArray): LocalLorebookEntity? {
        val obj = jsonOf(payload) ?: return null
        val id = string(obj, "id").ifEmpty { return null }
        return LocalLorebookEntity(
            id = id,
            name = string(obj, "name"),
            canonicalJson = obj.toString(),
            createdAt = obj.optLong("createdAt", System.currentTimeMillis()),
            updatedAt = obj.optLong("updatedAt", System.currentTimeMillis()),
            importedFrom = SOURCE,
        )
    }

    private fun presetOf(payload: ByteArray): LocalPresetEntity? {
        val obj = jsonOf(payload) ?: return null
        val id = string(obj, "id").ifEmpty { return null }
        val body = LinkedHashMap<String, Any?>()
        // 只剔 id：`bodyJson` 的约定就是「整个预设对象（含 name/description/isBuiltin）+ id」
        // ——见 `SyncPayloadGoldenTest.presetPayloadIsWholeBodyMinusId`，那里正是用
        // `payload + id` 反推行的。所以恢复时把其余键原样放回 body 才是对的，
        // 顺手「拆回列」会把 PC 也有的键从 payload 里弄丢（同步哈希就变了）。
        obj.keys().forEach { key -> if (key != "id") body[key] = JsonValues.parseAny(obj.opt(key).toString()) }
        return LocalPresetEntity(
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

    private fun personaOf(obj: JSONObject): LocalPersonaEntity? {
        val id = string(obj, "id").ifEmpty { return null }
        return LocalPersonaEntity(
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

    private fun regexOf(obj: JSONObject, index: Int): LocalRegexRuleEntity? {
        val id = string(obj, "id").ifEmpty { return null }
        return LocalRegexRuleEntity(
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

    private fun templateOf(obj: JSONObject, index: Int): LocalLorebookMappingTemplateEntity? {
        val id = string(obj, "id").ifEmpty { return null }
        return LocalLorebookMappingTemplateEntity(
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

    /**
     * 快捷回复：备份形状是整库 `{global, byCharacter}`，本地是集合行。
     *
     * 重建为「一个全局集合 + 每角色一个集合」，与 PC 形状一致。
     * 备份前 Android 若把条目拆成多个集合，这里会被合并——可接受的有损点，
     * 因为 PC 本来就只有这两层，跨端恢复必须以 PC 形状为准。
     */
    private fun quickReplySetsOf(payload: ByteArray): List<LocalQuickReplySetEntity> {
        val root = jsonOf(payload) ?: return emptyList()
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

    private fun usageOf(obj: JSONObject): LocalUsageRecordEntity? {
        val id = string(obj, "id").ifEmpty { return null }
        val timestamp = obj.optLong("timestamp", System.currentTimeMillis())
        return LocalUsageRecordEntity(
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

    private fun clearMarkerOf(obj: JSONObject): LocalUsageClearMarkerEntity? {
        val markerDevice = string(obj, "deviceId")
        if (markerDevice.isEmpty()) return null
        return LocalUsageClearMarkerEntity(
            deviceId = markerDevice,
            clearedThroughJson = obj.optJSONObject("clearedThrough")?.toString() ?: "{}",
            tombstonedIdsJson = obj.optJSONArray("tombstonedIds")?.toString() ?: "[]",
            updatedAt = obj.optLong("updatedAt"),
        )
    }

    private fun sessionOf(payload: ByteArray): Pair<LocalSessionEntity, List<LocalMessageEntity>>? {
        val obj = jsonOf(payload) ?: return null
        val id = string(obj, "id").ifEmpty { return null }
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
                    // 优先用消息自带的说话人；旧包没有这个键时回落到会话的角色（单聊两者相同）
                    characterId = nullableString(message, "characterId") ?: session.characterId,
                    role = string(message, "role").ifEmpty { "user" },
                    content = string(message, "content"),
                    swipesJson = message.optJSONArray("swipes")?.toString(),
                    swipeIndex = if (message.isNull("swipeIndex")) null else message.optInt("swipeIndex"),
                    imagesJson = message.optJSONArray("images")?.toString() ?: "[]",
                    usageJson = message.optJSONObject("usage")?.toString(),
                    generationStatus = nullableString(message, "generationStatus"),
                    generationNotice = nullableString(message, "generationNotice"),
                    generationError = nullableString(message, "generationError"),
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
        return session to messages
    }

    private fun settingsOf(payload: ByteArray): List<Triple<String, String, String>> {
        val obj = jsonOf(payload) ?: return emptyList()
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
