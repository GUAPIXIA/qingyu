package com.qingyu.companion.content.backup

import com.qingyu.companion.chatcore.Ulid
import com.qingyu.companion.content.CharacterCardCodec
import com.qingyu.companion.content.PresetCodec
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalGroupEntity
import com.qingyu.companion.local.db.LocalGroupMessageEntity
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
import com.qingyu.companion.local.domain.EntityPayloads
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
        val groups = store.listGroups()

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
        // U-6-8：会话条目一视同仁地走 `chats/<sessionId>.json`。群会话（groupId 非空）是
        // 「消息方言不同」的同一种条目：会话行 + 内嵌消息数组（群消息方言）。
        // 群消息与它的会话**同条目**落位，「消息在群/会话之后」的依赖顺序由条目结构保证，
        // 不靠 ZIP 条目顺序——那正是三遍式「不信打包方顺序」的原则。
        var groupSessionCount = 0
        var groupMessageCount = 0
        sessions.forEach { session ->
            val json = if (session.groupId == null) {
                sessionJson(session)
            } else {
                groupSessionCount += 1
                val messages = store.listGroupMessages(session.id)
                groupMessageCount += messages.size
                groupSessionJson(session, messages)
            }
            entries += entry(BackupV3.Paths.CHATS + session.id + ".json", JSONObject(json).toString())
        }

        // U-6-8：群行（含 9 个调度列）进包：`groups/<gid>.json`，每实体一文件，
        // 与 `characters/<id>.json` 同一命名风格。
        groups.forEach { group ->
            entries += entry(BackupV3.Paths.GROUPS + group.id + ".json", groupJson(group))
        }

        counts["personas"] = personas.size
        counts["regexRules"] = rules.size
        counts["quickReplySets"] = quickReplies.size
        counts["mappingTemplates"] = templates.size
        counts["usageRecords"] = usage.size
        counts["usageClearMarkers"] = clearMarkers.size
        counts["sessions"] = sessions.size
        // U-6-8：三个群计数键与其余键一样**总是在**（0 也是有信息量的数）。
        // `sessions` 仍是全部会话行（含群会话，口径不变）；`groupSessions` 是其中 groupId 非空的
        // 子集，`groupMessages` 是群消息条数。
        counts["groups"] = groups.size
        counts["groupSessions"] = groupSessionCount
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
    //
    // 布局决策（与 `chats/` 对称）：群行每实体一文件 `groups/<gid>.json`（与 `characters/<id>.json`
    // 同一命名风格）；**群会话并入 `chats/<sid>.json`**，群消息内嵌在同一会话条目的 `messages`
    // 数组里。两个理由：① 恢复端只有「一条目 = 会话 + 其消息」一种形状，比「群消息另放一个
    // 数组文件」少一个分支；② 「消息在群/会话之后」的依赖顺序由**条目结构**保证，不依赖 ZIP
    // 条目顺序——群消息单独成条目时，外部包把它排在会话条目之前就撞了 FK，而三遍式的原则
    // 正是「不信打包方的顺序」。
    //
    // 字段口径：群行/群会话/群消息的备份字段**直接复用 [EntityPayloads.groupPayload] /
    // [EntityPayloads.groupSessionPayload] / [EntityPayloads.groupMessagePayload]**（D-11 临时
    // 镜像：PC `electron/ipc/group.ts` spread − id + parentId），只补上 payload 刻意不发的本地
    // 保真列（id / seq / 时间戳元数据 / 归属 / 预设 / 世界书）。键名与同步口径同名同义
    // （`memberIds`、`images`、`mentionedCharacterIds`、`timestamp`…），PC 打开也读得懂。

    private fun groupJson(row: LocalGroupEntity): String {
        // 基底 = 同步 payload（name / memberIds / createdAt / updatedAt）
        val out = LinkedHashMap<String, Any?>(EntityPayloads.groupPayload(row))
        // 备份保真列：同步契约是稀疏白名单——群调度参数两端都不进契约（见 groupPayload 的注释），
        // 但备份是全保真存档。9 个调度列（chatMode / autoMode / maxRounds / speakerInterval /
        // currentSpeakerIndex / presetId / systemPrompt / lorebookIds / defaultNarrativeMode）
        // 一个都不能少：缺哪一列就在 BackupGroupRoundTripTest 的九列逐一断言里变红。
        out["id"] = row.id
        out["mode"] = row.mode
        out["memoryEnabled"] = row.memoryEnabled
        out["avatarRef"] = row.avatarPath
        out["chatMode"] = row.chatMode
        out["autoMode"] = row.autoMode
        out["maxRounds"] = row.maxRounds
        out["speakerInterval"] = row.speakerInterval
        out["currentSpeakerIndex"] = row.currentSpeakerIndex
        out["presetId"] = row.presetId
        out["systemPrompt"] = row.systemPrompt
        out["lorebookIds"] = JsonValues.parseArray(row.lorebookIdsJson)
        out["defaultNarrativeMode"] = row.defaultNarrativeMode
        // 导入来源随包保真（U-6-8 要求全字段往返）：原样进出，缺键（外部包）即未设置
        out["importedFrom"] = row.importedFrom
        return JSONObject(out).toString(2)
    }

    private fun groupOf(payload: ByteArray): LocalGroupEntity? {
        val obj = jsonOf(payload) ?: return null
        val id = string(obj, "id").ifEmpty { return null }
        return LocalGroupEntity(
            id = id,
            name = string(obj, "name"),
            mode = obj.optString("mode", "sequential"),
            characterIdsJson = array(obj, "memberIds", "[]"),
            memoryEnabled = obj.optBoolean("memoryEnabled", false),
            avatarPath = nullableString(obj, "avatarRef"),
            // 备份是存档：导入来源**原样进出**（全字段往返），不重盖 SOURCE 标记；缺键即未设置
            importedFrom = nullableString(obj, "importedFrom"),
            createdAt = obj.optLong("createdAt"),
            updatedAt = obj.optLong("updatedAt"),
            chatMode = obj.optString("chatMode", "polling"),
            autoMode = obj.optBoolean("autoMode", false),
            maxRounds = obj.optInt("maxRounds", 1),
            speakerInterval = obj.optInt("speakerInterval", 2000),
            currentSpeakerIndex = obj.optInt("currentSpeakerIndex", 0),
            presetId = nullableString(obj, "presetId"),
            systemPrompt = string(obj, "systemPrompt"),
            lorebookIdsJson = array(obj, "lorebookIds", "[]"),
            defaultNarrativeMode = string(obj, "defaultNarrativeMode"),
        )
    }

    /**
     * 群会话条目（`chats/<sid>.json`）：会话行 + 内嵌群消息。
     *
     * 会话行基底是 [EntityPayloads.groupSessionPayload]（D-11 镜像口径），再补备份保真列
     * id / 归属 / 预设 / 世界书——键名与单聊会话条目（[sessionJson]）一致，所以恢复端解析
     * 两种会话条目共用同一段代码（见 `sessionEntryOf`）。
     */
    private fun groupSessionJson(
        session: LocalSessionEntity,
        messages: List<LocalGroupMessageEntity>,
    ): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>(EntityPayloads.groupSessionPayload(session))
        out["id"] = session.id
        out["characterId"] = session.characterId
        out["presetId"] = session.presetId
        out["lorebookIds"] = JsonValues.parseArray(session.lorebookIdsJson)
        out["messages"] = messages.map { groupMessageJson(it) }
        return out
    }

    private fun groupMessageJson(row: LocalGroupMessageEntity): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>(EntityPayloads.groupMessagePayload(row))
        // 备份保真列：payload 镜像口径刻意不发 id / seq / 时间戳元数据（同步按父级寻址），
        // 备份却要靠它们把这一行原样建回来——seq 是 (sessionId, seq) 唯一索引的一半。
        out["id"] = row.id
        out["seq"] = row.seq
        out["createdAt"] = row.createdAt
        out["updatedAt"] = row.updatedAt
        out["importedFrom"] = row.importedFrom
        return out
    }

    private fun groupMessageOf(
        obj: JSONObject,
        fallbackSessionId: String,
        fallbackGroupId: String,
    ): LocalGroupMessageEntity? {
        val id = string(obj, "id").ifEmpty { return null }
        val timestamp = obj.optLong("timestamp", 0L)
        return LocalGroupMessageEntity(
            id = id,
            sessionId = string(obj, "sessionId").ifEmpty { fallbackSessionId },
            groupId = string(obj, "groupId").ifEmpty { fallbackGroupId },
            // 归属缺键（外部旧包）按用户发言哨兵处理，绝不落空串——空串不是合法归属
            characterId = string(obj, "characterId").ifEmpty { SPEAKER_USER },
            content = string(obj, "content"),
            imagesJson = array(obj, "images", "[]").replace("\\/", "/"),
            round = obj.optInt("round", 0),
            translation = nullableString(obj, "translation"),
            replyToId = nullableString(obj, "replyToId"),
            status = nullableString(obj, "status"),
            mentionedIdsJson = array(obj, "mentionedCharacterIds", "[]"),
            narrativeMode = nullableString(obj, "narrativeMode"),
            speakerKind = nullableString(obj, "speakerKind"),
            generationKind = nullableString(obj, "generationKind"),
            dialogueDirectionsJson = obj.optJSONArray("dialogueDirections")?.toString(),
            dialogueDirectionsGeneratedAt = nullableLong(obj, "dialogueDirectionsGeneratedAt"),
            generationNotice = nullableString(obj, "generationNotice"),
            generationError = nullableString(obj, "generationError"),
            contentRenderMode = nullableString(obj, "contentRenderMode"),
            logicalTime = timestamp,
            seq = obj.optLong("seq", 0L),
            createdAt = obj.optLong("createdAt", timestamp),
            updatedAt = obj.optLong("updatedAt", timestamp),
            // 同 groupOf：导入来源随包保真，不重盖
            importedFrom = nullableString(obj, "importedFrom"),
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
                // 这些键在旧实现里**总是存在**（即使计数为 0），UI 与用例都按「键在不在」读它，
                // 所以先归零再累加，保持 `applied` 的形状稳定（例如「包里有 1 条清理游标，
                // 但那是我自己的 → usageClearMarkers=0」是一个有信息量的 0，不是缺键）。
                // U-6-8 增补 groups / groupSessions / groupMessages 三键，沿用同一形状。
                val counts = LinkedHashMap<String, Int>().apply {
                    listOf(
                        "characters", "lorebooks", "presets", "personas", "regexRules",
                        "mappingTemplates", "quickReplySets", "usageRecords",
                        "usageClearMarkers", "sessions", "groups", "groupSessions", "groupMessages",
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

                        // U-6-8：群行是**父实体**（群会话的 FK 挂在它上面），第二遍落库。
                        // 只认 `groups/<gid>.json` 这一种「每实体一文件」形状；PC 的 `groups/`
                        // 是 index.json + 每群目录（sessions.json / .jsonl）布局，那些**嵌套**条目
                        // 不在这里解析（也不误读），落到 else 原样跳过。
                        path.startsWith(BackupV3.Paths.GROUPS) &&
                            !path.removePrefix(BackupV3.Paths.GROUPS).contains('/') ->
                            groupOf(payload)?.let { store.putGroup(it); counts.bump("groups") }

                        path == BackupV3.Paths.SETTINGS ->
                            settingsOf(payload).forEach { (section, key, valueJson) ->
                                store.putPublicSetting(section, key, valueJson)
                            }

                        // 媒体在第一遍已处理；`groups/` 的嵌套布局（PC 的 index.json / 每群目录）
                        // 不解析、原样跳过；其余路径预检已拒（不在清单里就进不来）。
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

                // ── 第三遍：**子实体**（会话与其消息）必须在父（角色/群）之后。
                // 单独走一遍而不是依赖 ZIP 内部顺序：外部产出的包（PC 的）条目顺序不受我们控制，
                // 靠顺序就等于把一个安全属性交给打包方。三遍读的代价是 I/O，不是内存。
                //
                // U-6-8 落位：群会话是 `chats/` 的同形条目（groupId 非空），群消息**内嵌**在同一
                // 会话条目里——同一个处理器里先 putSession 再 appendGroupMessage，「消息在群/会话
                // 之后」由条目结构保证（群行已在第二遍落库），与 ZIP 条目顺序无关。
                BackupV3.streamEntries(bytes) { path, payload ->
                    if (path.startsWith(BackupV3.Paths.CHATS)) {
                        sessionEntryOf(payload)?.let { entry ->
                            store.putSession(entry.session)
                            entry.plainMessages.forEach { store.appendMessage(it) }
                            entry.groupMessages.forEach { store.appendGroupMessage(it); counts.bump("groupMessages") }
                            counts.bump("sessions")
                            // groupSessions 是 sessions 的子集（groupId 非空那部分），两个键都在：
                            // 读「会话数」看 sessions，读「群会话数」看 groupSessions
                            if (entry.session.groupId != null) counts.bump("groupSessions")
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

    /** 缺键与 JSON null 都算「未设置」（`isNull` 对缺键也返回 true）。 */
    private fun nullableLong(obj: JSONObject, key: String): Long? =
        if (obj.isNull(key)) null else obj.optLong(key)

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

    /** 一个 `chats/<sid>.json` 条目的解析结果：会话行 + 按归属分流的两种消息方言。 */
    private class SessionEntry(
        val session: LocalSessionEntity,
        val plainMessages: List<LocalMessageEntity>,
        val groupMessages: List<LocalGroupMessageEntity>,
    )

    /**
     * `chats/` 条目 → 会话 + 其消息。**一种条目形状、两种消息方言**：
     * `groupId == null` 是单聊消息（[LocalMessageEntity] 方言），否则是群消息（D-11 镜像口径，
     * 字段复用 [EntityPayloads.groupMessagePayload]）。方言按会话归属分流，两张消息表互不串
     * ——串了就是「群消息出现在单聊记录里」级别的数据事故。
     */
    private fun sessionEntryOf(payload: ByteArray): SessionEntry? {
        val obj = jsonOf(payload) ?: return null
        val id = string(obj, "id").ifEmpty { return null }
        val groupId = nullableString(obj, "groupId")
        val now = obj.optLong("updatedAt", System.currentTimeMillis())
        val session = LocalSessionEntity(
            id = id,
            characterId = nullableString(obj, "characterId"),
            groupId = groupId,
            title = string(obj, "title"),
            personaId = nullableString(obj, "personaId"),
            presetId = nullableString(obj, "presetId"),
            lorebookIdsJson = array(obj, "lorebookIds", "[]"),
            createdAt = obj.optLong("createdAt", now),
            updatedAt = now,
            // U-6-8：群会话条目按 D-11 镜像口径会带 narrativeMode；单聊条目没有这个键 → 空串（未设置）。
            // 此前这里不读它，群会话的叙事模式会被恢复悄悄抹掉。
            narrativeMode = nullableString(obj, "narrativeMode") ?: "",
            importedFrom = SOURCE,
        )
        val messages = obj.optJSONArray("messages") ?: return SessionEntry(session, emptyList(), emptyList())
        val plain = ArrayList<LocalMessageEntity>()
        val grouped = ArrayList<LocalGroupMessageEntity>()
        for (index in 0 until messages.length()) {
            val message = messages.optJSONObject(index) ?: continue
            if (groupId == null) {
                messageOf(message, session, index)?.let { plain += it }
            } else {
                groupMessageOf(message, id, groupId)?.let { grouped += it }
            }
        }
        return SessionEntry(session, plain, grouped)
    }

    private fun messageOf(message: JSONObject, session: LocalSessionEntity, index: Int): LocalMessageEntity? {
        val messageId = string(message, "id").ifEmpty { return null }
        return LocalMessageEntity(
            id = messageId,
            sessionId = session.id,
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
            createdAt = message.optLong("createdAt", session.updatedAt),
            updatedAt = message.optLong("updatedAt", session.updatedAt),
            importedFrom = SOURCE,
        )
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

        /** 群消息归属哨兵：用户发言（PC `GroupMessage.characterId` 的 `__user__`）。 */
        private const val SPEAKER_USER = "__user__"
        private const val INCOMING_DIR = ".incoming"
    }
}
