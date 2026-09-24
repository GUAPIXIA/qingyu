package com.qingyu.companion.local.testing

import com.qingyu.companion.local.db.ChangeLogEntity
import com.qingyu.companion.local.db.ConflictEntity
import com.qingyu.companion.local.db.EntityHeadEntity
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalConnectionProfileEntity
import com.qingyu.companion.local.db.LocalDeviceSettingEntity
import com.qingyu.companion.local.db.LocalGroupEntity
import com.qingyu.companion.local.db.LocalGroupMessageEntity
import com.qingyu.companion.local.db.LocalLorebookEntity
import com.qingyu.companion.local.db.LocalLorebookMappingTemplateEntity
import com.qingyu.companion.local.db.LocalMediaManifestEntity
import com.qingyu.companion.local.db.LocalMemoryFactEntity
import com.qingyu.companion.local.db.LocalMemoryStateEntity
import com.qingyu.companion.local.db.LocalMessageEntity
import com.qingyu.companion.local.db.LocalPersonaEntity
import com.qingyu.companion.local.db.LocalPresetEntity
import com.qingyu.companion.local.db.LocalPublicSettingEntity
import com.qingyu.companion.local.db.LocalQuickReplySetEntity
import com.qingyu.companion.local.db.LocalRegexRuleEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.db.LocalUsageClearMarkerEntity
import com.qingyu.companion.local.db.LocalUsageRecordEntity
import com.qingyu.companion.local.db.SyncReceiptEntity
import com.qingyu.companion.local.db.UsageAggregateRow
import com.qingyu.companion.local.domain.BindingImpact
import com.qingyu.companion.local.domain.CanonicalEntityIds
import com.qingyu.companion.local.domain.CharacterSortColumn
import com.qingyu.companion.local.domain.CounterVectors
import com.qingyu.companion.local.domain.EntityPayloads
import com.qingyu.companion.local.domain.EntityTypes
import com.qingyu.companion.local.domain.JsonValues
import com.qingyu.companion.local.domain.LocalCounts
import com.qingyu.companion.local.domain.LocalEnvelope
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.local.domain.LorebookMappingTemplateDsl
import com.qingyu.companion.local.domain.MemoryCasResult
import com.qingyu.companion.local.domain.MigrationIdentity
import com.qingyu.companion.local.domain.UsageClearMarkerPayload
import com.qingyu.companion.local.domain.UsageClearResult
import com.qingyu.companion.local.domain.UsageDimension
import com.qingyu.companion.local.domain.UsageStats
import com.qingyu.companion.local.domain.Origin
import com.qingyu.companion.local.domain.VersionVectorJson
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map

/**
 * 阶段 3 本地 Repository 的内存实现（**dev/test 专用**，位于 `src/test`）。
 *
 * 与 [com.qingyu.companion.local.domain.RoomLocalSyncRepository] 共用同一不变量：
 * 业务行 + head + change_log 一起写入、counter 为十进制字符串、删除写 tombstone。
 * `LocalRepositoryContractTest` 对两个实现跑同一行为表。
 *
 * 阶段 5：所有规范 payload 一律委托 [EntityPayloads]，聚合与清理口径复用
 * [CounterVectors]——替身自己另写一套 payload 的话，跨端哈希一致性就没人验证了。
 */
class FakeLocalStore(
    private val deviceIdValue: String = "android-test-device",
) : LocalStore {

    override fun deviceId(): String = deviceIdValue

        /** 内存实现没有事务；块内若抛异常，已写入的部分不会回滚（仅测试用，见接口注释）。 */
        override suspend fun <R> inTransaction(block: suspend () -> R): R = block()

    private var nextCounter = 1uL
    private val heads = mutableMapOf<Pair<String, String>, EntityHeadEntity>()
    private val changes = mutableListOf<ChangeLogEntity>()
    private var deviceStatePresent = false
    private var migrationGenesis: String? = null

    val characters = MutableStateFlow<List<LocalCharacterEntity>>(emptyList())
    val lorebooks = MutableStateFlow<List<LocalLorebookEntity>>(emptyList())
    val presets = MutableStateFlow<List<LocalPresetEntity>>(emptyList())
    val personas = MutableStateFlow<List<LocalPersonaEntity>>(emptyList())
    val regexRules = MutableStateFlow<List<LocalRegexRuleEntity>>(emptyList())
    val quickReplySets = MutableStateFlow<List<LocalQuickReplySetEntity>>(emptyList())
    val mappingTemplates = MutableStateFlow<List<LocalLorebookMappingTemplateEntity>>(emptyList())
    val groups = MutableStateFlow<List<LocalGroupEntity>>(emptyList())
    val groupMessages = MutableStateFlow<List<LocalGroupMessageEntity>>(emptyList())
    val sessions = MutableStateFlow<List<LocalSessionEntity>>(emptyList())
    private val messages = MutableStateFlow<List<LocalMessageEntity>>(emptyList())
    private val memoryStates = mutableMapOf<String, LocalMemoryStateEntity>()
    private val memoryFacts = MutableStateFlow<List<LocalMemoryFactEntity>>(emptyList())
    private val usage = mutableListOf<LocalUsageRecordEntity>()
    private val usageClearMarkers = mutableMapOf<String, LocalUsageClearMarkerEntity>()
    private val media = mutableListOf<LocalMediaManifestEntity>()
    private val publicSettings = mutableMapOf<Pair<String, String>, LocalPublicSettingEntity>()
    private val publicSettingsFlow = MutableStateFlow<List<LocalPublicSettingEntity>>(emptyList())
    private val deviceSettings = mutableMapOf<String, LocalDeviceSettingEntity>()
    private val deviceSettingsFlow = MutableStateFlow<List<LocalDeviceSettingEntity>>(emptyList())
    val connectionProfiles = MutableStateFlow<List<LocalConnectionProfileEntity>>(emptyList())
    private val receipts = mutableListOf<SyncReceiptEntity>()
    private val conflicts = mutableMapOf<String, ConflictEntity>()

    /** 由测试注入：模拟事务中段失败（验证业务行/journal 同步回滚语义）。 */
    var failNextWrite: (() -> Unit)? = null

    fun deviceIdForTest(): String = deviceIdValue

    fun journalEntries(): List<ChangeLogEntity> = changes.toList()

    fun versionVectorOf(entityType: String, entityId: String): Map<String, String> =
        heads[entityType to entityId]?.let { VersionVectorJson.decode(it.versionJson) } ?: emptyMap()

    // ---------------------------------------------------------------- 事务模拟

    private class Snapshot(
        val counter: ULong,
        val heads: Map<Pair<String, String>, EntityHeadEntity>,
        val changes: List<ChangeLogEntity>,
        val characters: List<LocalCharacterEntity>,
        val personas: List<LocalPersonaEntity>,
        val sessions: List<LocalSessionEntity>,
    )

    private fun snapshot() = Snapshot(
        counter = nextCounter,
        heads = heads.toMap(),
        changes = changes.toList(),
        characters = characters.value,
        personas = personas.value,
        sessions = sessions.value,
    )

    private fun restore(s: Snapshot) {
        nextCounter = s.counter
        heads.clear()
        heads.putAll(s.heads)
        changes.clear()
        changes.addAll(s.changes)
        characters.value = s.characters
        personas.value = s.personas
        sessions.value = s.sessions
    }

    /** 所有写路径都经此包装：抛异常时业务行与 journal 一起回滚。 */
    private inline fun transaction(block: () -> Unit) {
        val snap = snapshot()
        try {
            block()
        } catch (t: Throwable) {
            restore(snap)
            throw t
        }
    }

    /** suspend 版本（`applyRemote` / `importFromLegacy` 需要）。 */
    private suspend fun transactionSuspend(block: suspend () -> Unit) {
        val snap = snapshot()
        try {
            block()
        } catch (t: Throwable) {
            restore(snap)
            throw t
        }
    }

    /** 返回值的同步事务包装（`recordUsage` 的布尔语义需要）。 */
    private inline fun <R> transactionValue(block: () -> R): R {
        val snap = snapshot()
        try {
            return block()
        } catch (t: Throwable) {
            restore(snap)
            throw t
        }
    }

    private fun allocateCounter(): Pair<String, String> {
        deviceStatePresent = true
        val counter = nextCounter
        nextCounter += 1uL
        return deviceIdValue to counter.toString()
    }

    private fun journal(
        entityType: String,
        entityId: String,
        payload: Map<String, Any?>,
        origin: Origin,
        deleted: Boolean = false,
        parentId: String? = null,
    ) {
        MigrationIdentity.requireValidEntityId(entityId)
        val (device, counter) = when (origin) {
            Origin.Local -> allocateCounter()
            Origin.Remote, Origin.Migration -> {
                val existing = heads[entityType to entityId]
                val vector = existing?.let { VersionVectorJson.decode(it.versionJson) } ?: emptyMap()
                val dot = vector.entries.firstOrNull()?.key ?: deviceIdValue
                dot to (vector[dot] ?: "0")
            }
        }
        val previous = heads[entityType to entityId]
        val vector = when (origin) {
            Origin.Local -> {
                val base = previous?.let { VersionVectorJson.decode(it.versionJson) }?.toMutableMap()
                    ?: mutableMapOf()
                base[device] = counter
                base.toMap()
            }
            else -> (previous?.let { VersionVectorJson.decode(it.versionJson) } ?: emptyMap())
        }
        val now = System.currentTimeMillis()
        val hash = MigrationIdentity.contentHash(if (deleted) emptyMap() else payload)
        heads[entityType to entityId] = EntityHeadEntity(
            entityType = entityType,
            entityId = entityId,
            versionJson = VersionVectorJson.encode(vector),
            hash = hash,
            deleted = deleted,
            updatedAt = now,
        )
        changes += ChangeLogEntity(
            seq = changes.size + 1L,
            dotDevice = device,
            dotCounter = counter,
            entityType = entityType,
            entityId = entityId,
            envelopeJson = LocalEnvelope(
                entityType = entityType,
                entityId = entityId,
                payload = if (deleted) emptyMap() else payload,
                deviceId = device,
                counter = counter,
                version = vector,
                parentId = parentId,
                deleted = deleted,
                updatedAt = now,
                contentHash = hash,
            ).toJson(),
            origin = origin.wire,
            recordedAt = now,
        )
    }

    /**
     * tombstone 写入。
     *
     * [requireAncestor] = false 用于 `qr-char-<id>`：PC 的 `quickReply:clearCharacter` 会对一个
     * 从未单独记账过的 id 落 delete（整库只有一个 `quick-replies-root` 实体），
     * 此时必须照样建一条 deleted head，否则删除语义丢失（与 Room 同口径）。
     */
    private fun tombstone(
        entityType: String,
        entityId: String,
        requireAncestor: Boolean = true,
        parentId: String? = null,
    ) {
        if (heads[entityType to entityId] == null && requireAncestor) return
        journal(entityType, entityId, emptyMap(), Origin.Local, deleted = true, parentId = parentId)
    }

    private fun <T> upsertList(flow: MutableStateFlow<List<T>>, item: T, id: (T) -> String) {
        flow.value = flow.value.filterNot { id(it) == id(item) } + item
    }

    // ---------------------------------------------------------------- 内容

    override fun observeCharacters(): Flow<List<LocalCharacterEntity>> = characters

    override suspend fun listCharacters(): List<LocalCharacterEntity> = characters.value

    override suspend fun getCharacter(id: String): LocalCharacterEntity? = characters.value.firstOrNull { it.id == id }

    /**
     * 镜像 `LocalCharacterDao.search` 的 WHERE/ORDER BY：`LIKE` 在 SQLite 里对 ASCII 大小写不敏感，
     * 排序列名先经 [CharacterSortColumn.resolve] 收敛，未知 token 与 Room 一样回落到 `name`。
     */
    override suspend fun searchCharacters(
        query: String,
        sortBy: String,
        limit: Int,
        offset: Int,
    ): List<LocalCharacterEntity> = when (CharacterSortColumn.resolve(sortBy)) {
        CharacterSortColumn.CREATED ->
            matchCharacters(query).sortedWith(compareByDescending<LocalCharacterEntity> { it.createdAt }
                .thenBy { it.name.lowercase() }.thenBy { it.id })
        CharacterSortColumn.UPDATED ->
            matchCharacters(query).sortedWith(compareByDescending<LocalCharacterEntity> { it.updatedAt }
                .thenBy { it.name.lowercase() }.thenBy { it.id })
        else -> matchCharacters(query).sortedWith(compareBy({ it.name.lowercase() }, { it.id }))
    }.drop(offset.coerceAtLeast(0)).take(limit)

    override suspend fun countCharacters(query: String): Int = matchCharacters(query).size

    private fun matchCharacters(query: String): List<LocalCharacterEntity> =
        if (query.isEmpty()) {
            characters.value
        } else {
            characters.value.filter {
                it.name.contains(query, ignoreCase = true) || it.description.contains(query, ignoreCase = true)
            }
        }

    override suspend fun putCharacter(entity: LocalCharacterEntity) = transaction {
        failNextWrite?.invoke()
        val now = System.currentTimeMillis()
        val row = entity.copy(createdAt = if (entity.createdAt == 0L) now else entity.createdAt, updatedAt = now)
        journal(EntityTypes.CHARACTER, row.id, EntityPayloads.characterPayload(row), Origin.Local)
        upsertList(characters, row) { it.id }
    }

    /** S5-01 影响范围：角色不被别的角色引用，因此只报会话数；消息数单独查。 */
    override suspend fun characterBindingImpact(id: String): BindingImpact =
        BindingImpact(characters = 0, sessions = sessions.value.count { it.characterId == id })

    override suspend fun characterMessageCount(id: String): Int = messages.value.count { it.characterId == id }

    override suspend fun deleteCharacter(id: String) = transaction {
        // 顺序与 Room 一致：先清子集合并记整库 journal，再 tombstone 父角色。
        deleteCharacterQuickRepliesInTx(id)
        characters.value = characters.value.filterNot { it.id == id }
        tombstone(EntityTypes.CHARACTER, id)
    }

    override fun observeLorebooks(): Flow<List<LocalLorebookEntity>> = lorebooks

    override suspend fun listLorebooks(): List<LocalLorebookEntity> = lorebooks.value

    /** 与 Room 的 SQL 同口径：筛选列、排序列与分页都必须在替身上给出同样的结果。 */
    private fun filteredLorebooks(query: String): List<LocalLorebookEntity> {
        val needle = query.sqlNoCase()
        return lorebooks.value
            .filter { row ->
                needle.isEmpty() ||
                    row.name.sqlNoCase().contains(needle) ||
                    row.importedFrom.orEmpty().sqlNoCase().contains(needle)
            }
            .sortedWith(compareBy({ it.name.sqlNoCase() }, { it.id }))
    }

    override suspend fun searchLorebooks(
        query: String,
        limit: Int,
        offset: Int,
    ): List<LocalLorebookEntity> = filteredLorebooks(query).drop(offset).take(limit)

    override suspend fun countLorebooks(query: String): Int = filteredLorebooks(query).size

    /**
     * SQLite 的 COLLATE NOCASE 只折 A-Z（不折非 ASCII），这里刻意一模一样。
     *
     * 不用 buildString：它把 StringBuilder 当接收者，lambda 里的 forEach 会绑到
     * 那个**空 builder** 上而不是这个字符串，于是每个名字都折成空串、排序静默退化成插入序
     * （这行代码一开始就是这么写的，被分页契约用例抓出来的）。
     */
    private fun String.sqlNoCase(): String {
        val out = StringBuilder(length)
        forEach { ch -> out.append(if (ch in 'A'..'Z') (ch.code + 32).toChar() else ch) }
        return out.toString()
    }

    override suspend fun listLorebookIds(): List<String> = lorebooks.value.map { it.id }

    override suspend fun getLorebook(id: String): LocalLorebookEntity? = lorebooks.value.firstOrNull { it.id == id }

    override suspend fun putLorebook(entity: LocalLorebookEntity) = transaction {
        val now = System.currentTimeMillis()
        val row = entity.copy(createdAt = if (entity.createdAt == 0L) now else entity.createdAt, updatedAt = now)
        journal(EntityTypes.LOREBOOK, row.id, EntityPayloads.lorebookPayload(row), Origin.Local)
        upsertList(lorebooks, row) { it.id }
    }

    override suspend fun deleteLorebook(id: String) = transaction {
        lorebooks.value = lorebooks.value.filterNot { it.id == id }
        tombstone(EntityTypes.LOREBOOK, id)
    }

    /** 与 `LocalLorebookDao.countBoundCharacters` 同口径：多绑定 JSON 数组 + 阶段 3 单绑定列。 */
    override suspend fun lorebookBindingImpact(id: String): BindingImpact = BindingImpact(
        characters = characters.value.count {
            stringIdsOfJson(it.boundLorebookIdsJson).contains(id) || it.lorebookId == id
        },
        sessions = sessions.value.count { stringIdsOfJson(it.lorebookIdsJson).contains(id) },
    )

    override fun observePresets(): Flow<List<LocalPresetEntity>> = presets

    override suspend fun listPresets(): List<LocalPresetEntity> = presets.value

    override suspend fun listPresetIds(): List<String> = presets.value.map { it.id }

    override suspend fun getPreset(id: String): LocalPresetEntity? = presets.value.firstOrNull { it.id == id }

    /** 内建/用户分区：与 `listByBuiltin` 一样按 `sort_index, name COLLATE NOCASE, id` 排序。 */
    override suspend fun listPresetSection(builtin: Boolean): List<LocalPresetEntity> =
        sortedPresetSection(presets.value, builtin)

    /**
     * 分区排序与 SQL 逐项一致：`sort_index, name COLLATE NOCASE, id`。
     *
     * 折叠大小写用 [sqlNoCase]（只折 A-Z）而不是 `lowercase()`：后者连非 ASCII 一起折，
     * 而 SQLite 的 `COLLATE NOCASE` 只折 ASCII 字母——替身与真实现差在这里时，
     * 单看任何一方都正常，跑同一张行为表才会露（与 `LocalLorebookDao` 那边同一个口径）。
     */
    private fun sortedPresetSection(
        rows: List<LocalPresetEntity>,
        builtin: Boolean,
    ): List<LocalPresetEntity> = rows
        .filter { it.isBuiltin == builtin }
        .sortedWith(compareBy({ it.sortIndex }, { it.name.sqlNoCase() }, { it.id }))

    private fun filteredPresets(rows: List<LocalPresetEntity>, query: String): List<LocalPresetEntity> {
        val needle = query.sqlNoCase()
        return rows.filter { row ->
            needle.isEmpty() ||
                row.name.sqlNoCase().contains(needle) ||
                row.description.sqlNoCase().contains(needle)
        }
    }

    override suspend fun searchPresets(
        builtin: Boolean,
        query: String,
        limit: Int,
        offset: Int,
    ): List<LocalPresetEntity> =
        sortedPresetSection(filteredPresets(presets.value, query), builtin).drop(offset).take(limit)

    override suspend fun countPresets(builtin: Boolean, query: String): Int =
        sortedPresetSection(filteredPresets(presets.value, query), builtin).size

    override suspend fun putPreset(entity: LocalPresetEntity) = transaction {
        val now = System.currentTimeMillis()
        val row = entity.copy(createdAt = if (entity.createdAt == 0L) now else entity.createdAt, updatedAt = now)
        journal(EntityTypes.PRESET, row.id, EntityPayloads.presetPayload(row), Origin.Local)
        upsertList(presets, row) { it.id }
    }

    override suspend fun deletePreset(id: String) = transaction {
        presets.value = presets.value.filterNot { it.id == id }
        tombstone(EntityTypes.PRESET, id)
    }

    override suspend fun presetBindingImpact(id: String): BindingImpact = BindingImpact(
        characters = characters.value.count { it.defaultPresetId == id },
        sessions = sessions.value.count { it.presetId == id },
    )

    /**
     * S5-03：解绑 + 删除同事务。
     *
     * 与 Room 实现同口径：被解绑的角色/会话行**各自产生一条 journal**，
     * 否则对端只看到「预设消失」而看不到引用已变，同步后仍指向已删实体。
     */
    override suspend fun deletePresetUnbindingReferences(id: String): BindingImpact {
        val impact = presetBindingImpact(id)
        // 解绑逐行走 putCharacter/putSession：只有它们写 journal。
        // 以前这里只换列表，等于两端一致地犯错——契约套件抓不到共同的错误。
        characters.value.filter { it.defaultPresetId == id }
            .map { it.copy(defaultPresetId = null) }
            .forEach { putCharacter(it) }
        sessions.value.filter { it.presetId == id }
            .map { it.copy(presetId = null) }
            .forEach { putSession(it) }
        transaction {
            presets.value = presets.value.filterNot { it.id == id }
            tombstone(EntityTypes.PRESET, id)
        }
        return impact
    }

    override fun observePersonas(): Flow<List<LocalPersonaEntity>> = personas

    override suspend fun listPersonas(): List<LocalPersonaEntity> = personas.value

    override suspend fun getPersona(id: String): LocalPersonaEntity? = personas.value.firstOrNull { it.id == id }

    override suspend fun putPersona(entity: LocalPersonaEntity) = transaction {
        failNextWrite?.invoke()
        val now = System.currentTimeMillis()
        val row = entity.copy(createdAt = if (entity.createdAt == 0L) now else entity.createdAt, updatedAt = now)
        journal(EntityTypes.PERSONA, row.id, EntityPayloads.personaPayload(row), Origin.Local)
        upsertList(personas, row) { it.id }
    }

    override suspend fun deletePersona(id: String) = transaction {
        personas.value = personas.value.filterNot { it.id == id }
        tombstone(EntityTypes.PERSONA, id)
    }

    override suspend fun personaBindingImpact(id: String): BindingImpact = BindingImpact(
        characters = characters.value.count { it.defaultPersonaId == id },
        sessions = sessions.value.count { it.personaId == id },
    )

    override suspend fun deletePersonaUnbindingReferences(id: String): BindingImpact {
        val impact = personaBindingImpact(id)
        sessions.value.filter { it.personaId == id }
            .map { it.copy(personaId = null) }
            .forEach { putSession(it) }
        characters.value.filter { it.defaultPersonaId == id }
            .map { it.copy(defaultPersonaId = null) }
            .forEach { putCharacter(it) }
        transaction {
            personas.value = personas.value.filterNot { it.id == id }
            tombstone(EntityTypes.PERSONA, id)
        }
        return impact
    }

    /** S5-02：与 Room 实现同口径——解绑要逐行经写路径产生 journal。 */
    override suspend fun deleteLorebookUnbindingReferences(id: String): BindingImpact {
        val impact = lorebookBindingImpact(id)
        characters.value.filter { it.lorebookId == id || lorebookIdsOf(it).contains(id) }
            .map { row ->
                row.copy(
                    lorebookId = row.lorebookId?.takeIf { it != id },
                    boundLorebookIdsJson = withoutIdInArray(row.boundLorebookIdsJson, id),
                )
            }
            .forEach { putCharacter(it) }
        sessions.value.filter { lorebookIdsOfSession(it).contains(id) }
            .map { it.copy(lorebookIdsJson = withoutIdInArray(it.lorebookIdsJson, id)) }
            .forEach { putSession(it) }
        transaction {
            lorebooks.value = lorebooks.value.filterNot { it.id == id }
            tombstone(EntityTypes.LOREBOOK, id)
        }
        return impact
    }

    private fun lorebookIdsOf(row: LocalCharacterEntity): List<String> =
        JsonValues.parseArray(row.boundLorebookIdsJson).filterIsInstance<String>()

    private fun lorebookIdsOfSession(row: LocalSessionEntity): List<String> =
        JsonValues.parseArray(row.lorebookIdsJson).filterIsInstance<String>()

    private fun withoutIdInArray(json: String, id: String): String =
        JsonValues.stringify(JsonValues.parseArray(json).filterNot { it == id })

    override fun observeRegexRules(): Flow<List<LocalRegexRuleEntity>> = regexRules

    override suspend fun listRegexRules(): List<LocalRegexRuleEntity> = regexRules.value

    override suspend fun getRegexRule(id: String): LocalRegexRuleEntity? = regexRules.value.firstOrNull { it.id == id }

    override suspend fun putRegexRule(entity: LocalRegexRuleEntity) = transaction {
        val now = System.currentTimeMillis()
        val row = entity.copy(createdAt = if (entity.createdAt == 0L) now else entity.createdAt, updatedAt = now)
        journal(EntityTypes.REGEX_RULE, row.id, EntityPayloads.regexRulePayload(row), Origin.Local)
        upsertList(regexRules, row) { it.id }
    }

    override suspend fun deleteRegexRule(id: String) = transaction {
        regexRules.value = regexRules.value.filterNot { it.id == id }
        tombstone(EntityTypes.REGEX_RULE, id)
    }

    /** 与 Room 同语义：只改真正变了位置的条目，未变化不产生 journal。 */
    override suspend fun reorderRegexRules(orderedIds: List<String>) = transaction {
        val now = System.currentTimeMillis()
        orderedIds.forEachIndexed { index, id ->
            val existing = regexRules.value.firstOrNull { it.id == id } ?: return@forEachIndexed
            if (existing.sortIndex == index) return@forEachIndexed
            val row = existing.copy(sortIndex = index, updatedAt = now)
            journal(EntityTypes.REGEX_RULE, row.id, EntityPayloads.regexRulePayload(row), Origin.Local)
            upsertList(regexRules, row) { it.id }
        }
    }

    override fun observeQuickReplySets(): Flow<List<LocalQuickReplySetEntity>> = quickReplySets

    override suspend fun listQuickReplySets(): List<LocalQuickReplySetEntity> = quickReplySets.value

    override suspend fun getQuickReplySet(id: String): LocalQuickReplySetEntity? =
        quickReplySets.value.firstOrNull { it.id == id }

    override suspend fun listGlobalQuickReplySets(): List<LocalQuickReplySetEntity> =
        sortedSets(quickReplySets.value.filter { it.characterId == null })

    override suspend fun listCharacterQuickReplySets(characterId: String): List<LocalQuickReplySetEntity> =
        sortedSets(quickReplySets.value.filter { it.characterId == characterId })

    private fun sortedSets(rows: List<LocalQuickReplySetEntity>): List<LocalQuickReplySetEntity> =
        rows.sortedWith(compareBy({ it.sortIndex }, { it.id }))

    override suspend fun putQuickReplySet(entity: LocalQuickReplySetEntity) = transaction {
        val now = System.currentTimeMillis()
        val row = entity.copy(createdAt = if (entity.createdAt == 0L) now else entity.createdAt, updatedAt = now)
        upsertList(quickReplySets, row) { it.id }
        journalQuickReplyStore()
    }

    override suspend fun deleteQuickReplySet(id: String) = transaction {
        val existing = quickReplySets.value.firstOrNull { it.id == id }
        quickReplySets.value = quickReplySets.value.filterNot { it.id == id }
        journalQuickReplyStore()
        val characterId = existing?.characterId
        if (characterId != null && quickReplySets.value.none { it.characterId == characterId }) {
            tombstone(EntityTypes.QUICK_REPLY_SET, "qr-char-$characterId", requireAncestor = false)
        }
    }

    /** 无集合可清时整段跳过（含 journal），与 Room 实现同口径。 */
    override suspend fun deleteCharacterQuickReplies(characterId: String) = transaction {
        deleteCharacterQuickRepliesInTx(characterId)
    }

    private fun deleteCharacterQuickRepliesInTx(characterId: String) {
        val ids = quickReplySets.value.filter { it.characterId == characterId }.map { it.id }
        if (ids.isEmpty()) return
        quickReplySets.value = quickReplySets.value.filterNot { it.id in ids.toSet() }
        journalQuickReplyStore()
        tombstone(EntityTypes.QUICK_REPLY_SET, "qr-char-$characterId", requireAncestor = false)
    }

    /** S5-06：整库一个实体 `quick-replies-root`（PC `quickReplyStorePayload` 的粒度）。 */
    private fun journalQuickReplyStore() {
        journal(
            EntityTypes.QUICK_REPLY_SET,
            CanonicalEntityIds.QUICK_REPLY_ROOT,
            EntityPayloads.quickReplyStorePayload(quickReplySets.value),
            Origin.Local,
        )
    }

    // ---------------------------------------------------------------- 映射模板（S5-02）

    override fun observeLorebookMappingTemplates(): Flow<List<LocalLorebookMappingTemplateEntity>> = mappingTemplates

    override suspend fun listLorebookMappingTemplates(): List<LocalLorebookMappingTemplateEntity> =
        mappingTemplates.value.sortedWith(compareBy({ it.sortIndex }, { it.name.lowercase() }, { it.id }))

    override suspend fun getLorebookMappingTemplate(id: String): LocalLorebookMappingTemplateEntity? =
        mappingTemplates.value.firstOrNull { it.id == id }

    override suspend fun putLorebookMappingTemplate(entity: LocalLorebookMappingTemplateEntity) = transaction {
        LorebookMappingTemplateDsl.requireValid(entity.templateJson)
        val now = System.currentTimeMillis()
        val row = entity.copy(createdAt = if (entity.createdAt == 0L) now else entity.createdAt, updatedAt = now)
        journal(EntityTypes.LOREBOOK_MAPPING_TEMPLATE, row.id, EntityPayloads.mappingTemplatePayload(row), Origin.Local)
        upsertList(mappingTemplates, row) { it.id }
    }

    override suspend fun deleteLorebookMappingTemplate(id: String) = transaction {
        mappingTemplates.value = mappingTemplates.value.filterNot { it.id == id }
        tombstone(EntityTypes.LOREBOOK_MAPPING_TEMPLATE, id)
    }

    override fun observeGroups(): Flow<List<LocalGroupEntity>> = groups

    override suspend fun listGroups(): List<LocalGroupEntity> = groups.value

    override suspend fun getGroup(id: String): LocalGroupEntity? = groups.value.firstOrNull { it.id == id }

    override suspend fun putGroup(entity: LocalGroupEntity) = transaction {
        val now = System.currentTimeMillis()
        val row = entity.copy(createdAt = if (entity.createdAt == 0L) now else entity.createdAt, updatedAt = now)
        journal(
            "group",
            row.id,
            EntityPayloads.groupPayload(row),
            Origin.Local,
        )
        upsertList(groups, row) { it.id }
    }

    override suspend fun deleteGroup(id: String) = transaction {
        groups.value = groups.value.filterNot { it.id == id }
        tombstone("group", id)
    }

    // ---------------------------------------------------------------- 会话 / 消息

    override fun observeSessions(): Flow<List<LocalSessionEntity>> = sessions

    override suspend fun listSessions(): List<LocalSessionEntity> = sessions.value

    override suspend fun getSession(id: String): LocalSessionEntity? = sessions.value.firstOrNull { it.id == id }

    override suspend fun putSession(entity: LocalSessionEntity) = transaction {
        require(!isTombstoned("character", entity.characterId)) { "父角色已被删除，不能写入会话" }
        require(!isTombstoned("group", entity.groupId)) { "父群组已被删除，不能写入会话" }
        val now = System.currentTimeMillis()
        val row = entity.copy(createdAt = if (entity.createdAt == 0L) now else entity.createdAt, updatedAt = now)
        // D-11：群会话独立实体类型
        val entityType = if (row.groupId != null) EntityTypes.GROUP_SESSION else EntityTypes.SESSION
        journal(
            entityType,
            row.id,
            if (row.groupId != null) EntityPayloads.groupSessionPayload(row) else EntityPayloads.sessionPayload(row),
            Origin.Local,
        )
        upsertList(sessions, row) { it.id }
    }

    override suspend fun deleteSession(id: String) = transaction {
        // 与 Room 实现同口径：父（角色/群）必须在删除前读出来
        val existing = sessions.value.firstOrNull { it.id == id }
        val parent = existing?.let { it.groupId ?: it.characterId }
        sessions.value = sessions.value.filterNot { it.id == id }
        messages.value = messages.value.filterNot { it.sessionId == id }
        groupMessages.value = groupMessages.value.filterNot { it.sessionId == id }
        memoryFacts.value = memoryFacts.value.filterNot { it.sessionId == id }
        val entityType = if (existing?.groupId != null) EntityTypes.GROUP_SESSION else EntityTypes.SESSION
        tombstone(entityType, id, parentId = parent)
    }

    override fun observeMessages(sessionId: String): Flow<List<LocalMessageEntity>> =
        messages.map { list -> list.filter { it.sessionId == sessionId }.sortedBy { it.seq } }

    override suspend fun listMessages(sessionId: String): List<LocalMessageEntity> =
        messages.value.filter { it.sessionId == sessionId }.sortedBy { it.seq }

    override suspend fun appendMessage(entity: LocalMessageEntity) = transaction {
        require(sessions.value.any { it.id == entity.sessionId }) { "父会话不存在，拒绝写入消息" }
        require(!isTombstoned("session", entity.sessionId)) { "父会话已被删除，拒绝写入消息" }
        val now = System.currentTimeMillis()
        val seq = if (entity.seq >= 0) {
            entity.seq
        } else {
            (messages.value.filter { it.sessionId == entity.sessionId }.maxOfOrNull { it.seq } ?: -1L) + 1
        }
        val row = entity.copy(
            seq = seq,
            logicalTime = if (entity.logicalTime == 0L) now else entity.logicalTime,
            createdAt = if (entity.createdAt == 0L) now else entity.createdAt,
            updatedAt = now,
        )
        journal("message", row.id, EntityPayloads.messagePayload(row), Origin.Local)
        upsertList(messages, row) { it.id }
    }

    override suspend fun updateMessage(entity: LocalMessageEntity) = transaction {
        val existing = messages.value.firstOrNull { it.id == entity.id }
        val row = entity.copy(
            seq = existing?.seq ?: entity.seq,
            createdAt = existing?.createdAt ?: System.currentTimeMillis(),
            updatedAt = System.currentTimeMillis(),
        )
        journal("message", row.id, EntityPayloads.messagePayload(row), Origin.Local)
        upsertList(messages, row) { it.id }
    }

    override suspend fun deleteMessage(id: String, sessionId: String) = transaction {
        messages.value = messages.value.filterNot { it.id == id }
        tombstone("message", id, parentId = sessionId)
    }

    // ---------------------------------------------------------------- 群消息（阶段 6 S6-01）

    override fun observeGroupMessages(sessionId: String): Flow<List<LocalGroupMessageEntity>> =
        groupMessages.map { list -> list.filter { it.sessionId == sessionId }.sortedBy { it.seq } }

    override suspend fun listGroupMessages(sessionId: String): List<LocalGroupMessageEntity> =
        groupMessages.value.filter { it.sessionId == sessionId }.sortedBy { it.seq }

    override suspend fun countGroupMessages(sessionId: String): Int =
        groupMessages.value.count { it.sessionId == sessionId }

    override suspend fun appendGroupMessage(entity: LocalGroupMessageEntity) = transaction {
        require(sessions.value.any { it.id == entity.sessionId }) { "父会话不存在，拒绝写入群消息" }
        require(!isTombstoned(EntityTypes.GROUP_SESSION, entity.sessionId)) { "父会话已被删除，拒绝写入群消息" }
        require(!isTombstoned("group", entity.groupId)) { "父群组已被删除，拒绝写入群消息" }
        val now = System.currentTimeMillis()
        val seq = if (entity.seq >= 0) {
            entity.seq
        } else {
            (groupMessages.value.filter { it.sessionId == entity.sessionId }.maxOfOrNull { it.seq } ?: -1L) + 1
        }
        val row = entity.copy(
            seq = seq,
            logicalTime = if (entity.logicalTime == 0L) now else entity.logicalTime,
            createdAt = if (entity.createdAt == 0L) now else entity.createdAt,
            updatedAt = now,
        )
        journal(EntityTypes.GROUP_MESSAGE, row.id, EntityPayloads.groupMessagePayload(row), Origin.Local)
        upsertList(groupMessages, row) { it.id }
    }

    override suspend fun updateGroupMessage(entity: LocalGroupMessageEntity) = transaction {
        val existing = groupMessages.value.firstOrNull { it.id == entity.id }
        val row = entity.copy(
            seq = existing?.seq ?: entity.seq,
            createdAt = existing?.createdAt ?: System.currentTimeMillis(),
            updatedAt = System.currentTimeMillis(),
        )
        journal("group_message", row.id, EntityPayloads.groupMessagePayload(row), Origin.Local)
        upsertList(groupMessages, row) { it.id }
    }

    override suspend fun deleteGroupMessage(id: String, sessionId: String) = transaction {
        groupMessages.value = groupMessages.value.filterNot { it.id == id }
        tombstone("group_message", id, parentId = sessionId)
    }

    override suspend fun deleteGroupMessagesForSession(sessionId: String) = transaction {
        groupMessages.value = groupMessages.value.filterNot { it.sessionId == sessionId }
    }

    // ---------------------------------------------------------------- 记忆 / 用量 / 媒体

    override suspend fun getMemoryState(sessionId: String): LocalMemoryStateEntity? = memoryStates[sessionId]

    override suspend fun putMemoryState(entity: LocalMemoryStateEntity) = transaction {
        val row = entity.copy(updatedAt = System.currentTimeMillis())
        // D-12：记忆随 session 走，不作独立同步实体
        memoryStates[row.sessionId] = row
    }

    /**
     * 与 `RoomLocalSyncRepository` 同语义的 CAS：版本不符则不写、磁盘不变。
     * 替身也实现条件语义，否则依赖 CAS 的用例在替身上会「永远成功」而失去意义。
     *
     * 注：本替身的 `transaction {}` 返回 `Unit`，故结果在事务外捕获。
     */
    override suspend fun applyMemoryStateIfVersion(
        sessionId: String,
        expectedVersion: Long,
        entity: LocalMemoryStateEntity,
    ): MemoryCasResult {
        var result = MemoryCasResult(false, 0L)
        transaction {
            val existing = memoryStates[sessionId]
            if (existing == null) {
                if (expectedVersion == 0L) {
                    putMemoryState(entity.copy(sessionId = sessionId, memoryVersion = expectedVersion + 1))
                    result = MemoryCasResult(true, expectedVersion + 1)
                } else {
                    result = MemoryCasResult(false, 0L)
                }
                return@transaction
            }
            if (existing.memoryVersion != expectedVersion) {
                result = MemoryCasResult(false, existing.memoryVersion)
                return@transaction
            }
            // 摘要 CAS 不得覆盖 historyRevision（编辑/删除的 bump 可能并发提交）
            putMemoryState(
                entity.copy(
                    sessionId = sessionId,
                    memoryVersion = expectedVersion + 1,
                    historyRevision = maxOf(existing.historyRevision, entity.historyRevision),
                ),
            )
            result = MemoryCasResult(true, expectedVersion + 1)
        }
        return result
    }

    override suspend fun bumpMemoryHistoryRevision(sessionId: String): Boolean {
        var changed = false
        transaction {
            val existing = memoryStates[sessionId] ?: return@transaction
            memoryStates[sessionId] = existing.copy(
                historyRevision = existing.historyRevision + 1,
                updatedAt = System.currentTimeMillis(),
            )
            changed = true
        }
        return changed
    }

    override suspend fun listMemoryFacts(sessionId: String): List<LocalMemoryFactEntity> =
        memoryFacts.value.filter { it.sessionId == sessionId }

    override suspend fun putMemoryFact(entity: LocalMemoryFactEntity) = transaction {
        val row = entity.copy(createdAt = if (entity.createdAt == 0L) System.currentTimeMillis() else entity.createdAt)
        // D-12：记忆事实随 session 走，不作独立同步实体
        upsertList(memoryFacts, row) { it.id }
    }

    override suspend fun deleteMemoryFact(id: String) = transaction {
        val sessionId = memoryFacts.value.firstOrNull { it.id == id }?.sessionId
        memoryFacts.value = memoryFacts.value.filterNot { it.id == id }
        tombstone("memory_fact", id, parentId = sessionId)
    }

    override suspend fun recordUsage(entity: LocalUsageRecordEntity): Boolean = transactionValue {
        if (usage.any { it.id == entity.id }) {
            false
        } else {
            val row = entity.copy(
                createdAt = if (entity.createdAt == 0L) System.currentTimeMillis() else entity.createdAt,
            )
            journal(EntityTypes.USAGE_RECORD, row.id, EntityPayloads.usageRecordPayload(row), Origin.Local)
            usage += row
            trimUsageToRetention()
            true
        }
    }

    /** S5-07：与 Room 实现同语义——淘汰最旧的超额记录并逐条 tombstone。 */
    private fun trimUsageToRetention() {
        val excess = usage.size - LocalStore.MAX_USAGE_RECORDS
        if (excess <= 0) return
        usage.sortedWith(compareBy({ it.createdAt }, { it.id }))
            .take(excess)
            .forEach { row ->
                usage.removeAll { it.id == row.id }
                tombstone(EntityTypes.USAGE_RECORD, row.id)
            }
    }

    override suspend fun listUsage(limit: Int): List<LocalUsageRecordEntity> =
        usage.sortedByDescending { it.createdAt }.take(limit)

    override suspend fun usageTotals(since: Long, sessionId: String?): Pair<Long, Long> {
        val filtered = usage.filter { it.createdAt >= since && (sessionId == null || it.sessionId == sessionId) }
        return filtered.sumOf { it.promptTokens.toLong() } to filtered.sumOf { it.completionTokens.toLong() }
    }

    override suspend fun usageStats(since: Long, until: Long): UsageStats {
        // 必须镜像生产 SQL：聊天汇总**只统计 `main`**。
        // 记忆总结与翻译走同一模型端点、输入往往是整段对话，混进来会直接污染
        // 「本会话聊了多少」；PC 的用量也只来自聊天流，口径必须一致。
        val filtered = usage.filter { it.createdAt in since..until && it.taskType == "main" }
        return UsageStats(
            totalInput = filtered.sumOf { it.inputChars.toLong() },
            totalOutput = filtered.sumOf { it.outputChars.toLong() },
            totalChars = filtered.sumOf { (it.inputChars + it.outputChars).toLong() },
            count = filtered.size,
        )
    }

    override suspend fun listUsageInRange(since: Long, until: Long, limit: Int): List<LocalUsageRecordEntity> =
        usage.filter { it.createdAt in since..until }.sortedByDescending { it.createdAt }.take(limit)

    /**
     * S5-07 维度聚合：与 Room 的**固定查询**逐维度对应。
     *
     * SQL 在 `output_chars` 相等时的顺序未定义，替身补了 `group_key` 次级键保证可断言；
     * 两侧比较时按维度键取集合，不依赖行序。
     */
    override suspend fun usageAggregate(
        dimension: UsageDimension,
        since: Long,
        until: Long,
        taskType: String,
    ): List<UsageAggregateRow> {
        val filtered = usage.filter {
            it.createdAt in since..until && (taskType.isEmpty() || it.taskType == taskType)
        }
        val keyOf: (LocalUsageRecordEntity) -> String? = when (dimension) {
            UsageDimension.MODEL -> { row -> row.model }
            UsageDimension.PROVIDER -> { row -> row.provider }
            UsageDimension.CHARACTER -> { row -> row.characterId }
            UsageDimension.DATE -> { row -> row.dateKey }
            UsageDimension.STATUS -> { row -> row.status }
        }
        val rows = filtered.groupBy(keyOf).map { (key, group) ->
            UsageAggregateRow(
                group_key = key,
                records = group.size,
                input_chars = group.sumOf { it.inputChars.toLong() },
                output_chars = group.sumOf { it.outputChars.toLong() },
                prompt_tokens = group.sumOf { it.promptTokens.toLong() },
                completion_tokens = group.sumOf { it.completionTokens.toLong() },
            )
        }
        return when (dimension) {
            UsageDimension.DATE -> rows.sortedByDescending { it.group_key }
            UsageDimension.STATUS -> rows.sortedBy { it.group_key }
            else -> rows.sortedWith(compareByDescending<UsageAggregateRow> { it.output_chars }.thenBy { it.group_key })
        }
    }

    /**
     * S5-07：与 Room 同口径的因果清理——只删被游标支配的记录，其余**原地保留**。
     *
     * 读不到 head 的记录无法证明被支配，按保留处理（宁可少删）。
     */
    override suspend fun clearUsage(beforeVersionVector: Map<String, String>): UsageClearResult = transactionValue {
        val existing = usageClearMarkers[deviceIdValue]
        val clearedThrough = CounterVectors.merge(
            existing?.let { VersionVectorJson.decode(it.clearedThroughJson) } ?: emptyMap(),
            beforeVersionVector,
        )
        val ids = usage.map { it.id }
        val cleared = ids.filter { id ->
            val head = heads[EntityTypes.USAGE_RECORD to id] ?: return@filter false
            CounterVectors.dominates(VersionVectorJson.decode(head.versionJson), clearedThrough)
        }
        val clearedSet = cleared.toSet()
        val retained = ids.filterNot { it in clearedSet }
        usage.removeAll { it.id in clearedSet }
        val tombstoned = (stringIdsOfJson(existing?.tombstonedIdsJson) + cleared).distinct()
        usageClearMarkers[deviceIdValue] = LocalUsageClearMarkerEntity(
            deviceId = deviceIdValue,
            clearedThroughJson = VersionVectorJson.encode(clearedThrough),
            tombstonedIdsJson = JsonValues.stringify(tombstoned),
            updatedAt = System.currentTimeMillis(),
        )
        journal(EntityTypes.USAGE_CLEAR_MARKER, CanonicalEntityIds.USAGE_CLEAR_MARKER, UsageClearMarkerPayload.of(clearedThrough), Origin.Local)
        UsageClearResult(clearedIds = cleared, retainedIds = retained)
    }

    override suspend fun usageClearMarker(deviceId: String): LocalUsageClearMarkerEntity? = usageClearMarkers[deviceId]

    override suspend fun listUsageClearMarkers(): List<LocalUsageClearMarkerEntity> =
        usageClearMarkers.values.sortedBy { it.deviceId }

    override suspend fun putUsageClearMarker(entity: LocalUsageClearMarkerEntity) = transaction {
        require(entity.deviceId.isNotBlank()) { "usage_clear_marker 缺少 deviceId" }
        require(entity.deviceId != deviceIdValue) {
            "不允许由备份写入本机自己的清理游标（本机只能经 clearUsage 的因果判定推进）"
        }
        usageClearMarkers[entity.deviceId] = entity
        // D-10：单实体 id + 逐设备映射
        journal(
            EntityTypes.USAGE_CLEAR_MARKER,
            CanonicalEntityIds.USAGE_CLEAR_MARKER,
            UsageClearMarkerPayload.of(VersionVectorJson.decode(entity.clearedThroughJson)),
            Origin.Local,
        )
    }

    private fun stringIdsOfJson(json: String?): List<String> = JsonValues.parseArray(json).filterIsInstance<String>()

    override suspend fun putMediaManifest(entity: LocalMediaManifestEntity) = transaction {
        val now = System.currentTimeMillis()
        val row = entity.copy(
            createdAt = if (entity.createdAt == 0L) now else entity.createdAt,
            updatedAt = now,
        )
        // D-12：media_manifest 推迟到阶段 7，不进同步 journal
        media.removeAll { it.id == row.id }
        media += row
    }

    override suspend fun listMediaManifests(ownerType: String, ownerId: String): List<LocalMediaManifestEntity> =
        media.filter { it.ownerType == ownerType && it.ownerId == ownerId }

    // ---------------------------------------------------------------- 设置分区

    override fun observePublicSettings(): Flow<List<LocalPublicSettingEntity>> = publicSettingsFlow

    override suspend fun listPublicSettings(): List<LocalPublicSettingEntity> = publicSettings.values.toList()

    /**
     * S5-07：与 Room 同粒度——行式存储，但 journal 只有**一个聚合实体** `settings-public`
     * （PC `bootstrapScanners.ts:136` / `ipc/settings.ts:settingsPublicPayload`）。
     * 逐键记账会让两端对同一份设置产生伪冲突。
     */
    override suspend fun putPublicSetting(section: String, key: String, valueJson: String) = transaction {
        val now = System.currentTimeMillis()
        publicSettings[section to key] = LocalPublicSettingEntity(section, key, valueJson, now)
        publicSettingsFlow.value = publicSettings.values.toList()
        journal(
            EntityTypes.SETTINGS_PUBLIC,
            CanonicalEntityIds.SETTINGS_PUBLIC,
            EntityPayloads.settingsPublicPayload(publicSettingsAggregate()),
            Origin.Local,
        )
    }

    /** 折叠成扁平视图；按 `(section, key)` 排序读取，与 DAO 的 `ORDER BY section, key` 同规则。 */
    private fun publicSettingsAggregate(): Map<String, Any?> =
        publicSettings.values.sortedWith(compareBy({ it.section }, { it.key }))
            .associate { it.key to JsonValues.parseAny(it.valueJson) }

    override fun observeDeviceSettings(): Flow<List<LocalDeviceSettingEntity>> = deviceSettingsFlow

    override suspend fun listDeviceSettings(): List<LocalDeviceSettingEntity> = deviceSettings.values.toList()

    override suspend fun putDeviceSetting(key: String, valueJson: String) {
        // 设备本地设置不进入同步 envelope，因此不写 change_log（阶段 3 S3-04）。
        deviceSettings[key] = LocalDeviceSettingEntity(key, valueJson, System.currentTimeMillis())
        deviceSettingsFlow.value = deviceSettings.values.toList()
    }

    // ---------------------------------------------------------------- 连接档案

    override fun observeConnectionProfiles(): Flow<List<LocalConnectionProfileEntity>> = connectionProfiles

    override suspend fun listConnectionProfiles(): List<LocalConnectionProfileEntity> =
        connectionProfiles.value.sortedWith(compareBy({ it.sortIndex }, { it.id }))

    override suspend fun getConnectionProfile(id: String): LocalConnectionProfileEntity? =
        connectionProfiles.value.firstOrNull { it.id == id }

    override suspend fun upsertConnectionProfile(entity: LocalConnectionProfileEntity) {
        val now = System.currentTimeMillis()
        val existing = connectionProfiles.value.firstOrNull { it.id == entity.id }
        val row = if (existing == null) {
            entity.copy(createdAt = if (entity.createdAt == 0L) now else entity.createdAt, updatedAt = now)
        } else {
            // public 字段更新：secretRef 永远沿用旧值，绝不被空值覆盖。
            existing.copy(
                provider = entity.provider,
                baseUrl = entity.baseUrl,
                model = entity.model,
                displayName = entity.displayName,
                enabled = entity.enabled,
                sortIndex = entity.sortIndex,
                allowHttp = entity.allowHttp,
                capabilitiesJson = entity.capabilitiesJson,
                updatedAt = now,
            )
        }
        upsertList(connectionProfiles, row) { it.id }
    }

    override suspend fun setConnectionSecret(profileId: String, secretRef: String?) {
        val existing = connectionProfiles.value.firstOrNull { it.id == profileId } ?: return
        upsertList(
            connectionProfiles,
            existing.copy(secretRef = secretRef, updatedAt = System.currentTimeMillis()),
        ) { it.id }
    }

    override suspend fun deleteConnectionProfile(id: String) {
        connectionProfiles.value = connectionProfiles.value.filterNot { it.id == id }
    }

    // ---------------------------------------------------------------- 同步元数据

    override suspend fun getHead(entityType: String, entityId: String): EntityHeadEntity? = heads[entityType to entityId]

    override suspend fun headCount(): Int = heads.size

    override suspend fun isTombstoned(entityType: String, entityId: String?): Boolean {
        if (entityId == null) return false
        return heads[entityType to entityId]?.deleted == true
    }

    override suspend fun journalCount(origin: String): Int = changes.count { it.origin == origin }

    override suspend fun journalChangeCount(): Int = changes.size

    override suspend fun changesAfter(cursor: Long, limit: Int): List<ChangeLogEntity> =
        changes.filter { it.seq > cursor }.sortedBy { it.seq }.take(limit)

    override suspend fun maxChangeSeq(): Long = changes.maxOfOrNull { it.seq } ?: 0L

    override suspend fun <R> applyRemote(
        entityType: String,
        entityId: String,
        payload: () -> Map<String, Any?>,
        business: suspend () -> R,
        parentId: String?,
    ): R {
        var result: R? = null
        transactionSuspend {
            result = business()
            journal(entityType, entityId, payload(), Origin.Remote, parentId = parentId)
        }
        @Suppress("UNCHECKED_CAST")
        return result as R
    }

    override suspend fun listTombstones(): List<EntityHeadEntity> = heads.values.filter { it.deleted }

    override suspend fun listReceipts(limit: Int): List<SyncReceiptEntity> =
        receipts.sortedByDescending { it.committedAt }.take(limit)

    override suspend fun recordReceipt(receipt: SyncReceiptEntity) {
        receipts.removeAll { it.id == receipt.id }
        receipts += receipt
    }

    override suspend fun openConflictCount(): Int = conflicts.values.count { !it.resolved }

    override suspend fun recordConflict(conflict: ConflictEntity) {
        conflicts[conflict.id] = conflict
    }

    override suspend fun listOpenConflicts(): List<ConflictEntity> =
        conflicts.values.filter { !it.resolved }.sortedBy { it.detectedAt }

    override suspend fun resolveConflict(id: String, resolutionJson: String) {
        conflicts[id]?.let { conflicts[id] = it.copy(resolved = true, resolutionJson = resolutionJson) }
    }

    // ---------------------------------------------------------------- 迁移 / 设备

    override suspend fun importFromLegacy(
        entityType: String,
        entityId: String,
        genesisContentHash: String?,
        payload: () -> Map<String, Any?>,
        business: suspend () -> Unit,
        parentId: String?,
    ) = transactionSuspend {
        val computed = MigrationIdentity.contentHash(payload())
        val origin = if (MigrationIdentity.isSameProjection(genesisContentHash, computed)) {
            Origin.Migration
        } else {
            Origin.Local
        }
        business()
        journal(entityType, entityId, payload(), origin, parentId = parentId)
    }

    override suspend fun setMigrationGenesisId(genesisId: String) {
        migrationGenesis = genesisId
    }

    override suspend fun migrationGenesisId(): String? = migrationGenesis

    override suspend fun initDeviceState() {
        deviceStatePresent = true
    }

    // 迁移导入落库（journal 由 importFromLegacy 负责；这里只写业务表）

    override suspend fun importCharacter(entity: LocalCharacterEntity) {
        upsertList(characters, entity) { it.id }
    }

    override suspend fun importSession(entity: LocalSessionEntity) {
        upsertList(sessions, entity) { it.id }
    }

    override suspend fun importMessage(entity: LocalMessageEntity) {
        upsertList(messages, entity) { it.id }
    }

    // ---------------------------------------------------------------- 契约测试专用写路径

    private val contractObjects = mutableMapOf<String, String>()
    suspend fun contractPut(entityType: String, entityId: String, payload: Map<String, Any?>) = transaction {
        MigrationIdentity.requireValidEntityId(entityId)
        contractObjects[entityId] = encodeContractPayload(payload)
        journal(entityType, entityId, payload, Origin.Local)
    }

    suspend fun contractTombstone(entityType: String, entityId: String) = transaction {
        contractObjects.remove(entityId)
        tombstone(entityType, entityId)
    }

    suspend fun contractApplyRemote(
        entityType: String,
        entityId: String,
        payload: Map<String, Any?>,
        deviceId: String,
        counter: String,
    ) = transaction {
        MigrationIdentity.requireValidEntityId(entityId)
        contractObjects[entityId] = encodeContractPayload(payload)
        val version = mapOf(deviceId to counter)
        val hash = MigrationIdentity.contentHash(payload)
        heads[entityType to entityId] = EntityHeadEntity(
            entityType = entityType,
            entityId = entityId,
            versionJson = VersionVectorJson.encode(version),
            hash = hash,
            deleted = false,
            updatedAt = System.currentTimeMillis(),
        )
        changes += ChangeLogEntity(
            seq = changes.size + 1L,
            dotDevice = deviceId,
            dotCounter = counter,
            entityType = entityType,
            entityId = entityId,
            envelopeJson = "{}",
            origin = Origin.Remote.wire,
            recordedAt = System.currentTimeMillis(),
        )
    }

    suspend fun contractRead(entityId: String): String? = contractObjects[entityId]

    /** 契约命名空间内的 change_log 页。 */
    suspend fun contractChangesAfter(cursor: Long, limit: Int): List<ChangeLogEntity> =
        changes.filter { it.seq > cursor && it.entityType in com.qingyu.companion.domain.contracts.CONTRACT_NAMESPACE_TYPES }
            .sortedBy { it.seq }
            .take(limit)

    suspend fun contractReset() {
        contractObjects.clear()
    }

    suspend fun contractClearNamespace(namespace: String) {
        heads.keys.removeAll { it.first == namespace }
        changes.removeAll { it.entityType == namespace }
    }

    private fun encodeContractPayload(payload: Map<String, Any?>): String = payload.entries.joinToString(",", "{", "}") { (k, v) ->
        "\"${k.replace("\\", "\\\\").replace("\"", "\\\"")}\":\"${v.toString().replace("\\", "\\\\").replace("\"", "\\\"")}\""
    }

    override suspend fun localCounts(): LocalCounts = LocalCounts(
        characters = characters.value.size,
        lorebooks = lorebooks.value.size,
        presets = presets.value.size,
        personas = personas.value.size,
        sessions = sessions.value.size,
        messages = messages.value.size,
        usageRecords = usage.size,
        connectionProfiles = connectionProfiles.value.size,
        heads = heads.size,
        changeLogEntries = changes.size,
        mappingTemplates = mappingTemplates.value.size,
        usageClearMarkers = usageClearMarkers.size,
    )
}
