package com.qingyu.companion.local.domain

import androidx.room.withTransaction
import com.qingyu.companion.domain.contracts.CanonicalJson
import com.qingyu.companion.local.db.ChangeLogEntity
import com.qingyu.companion.local.db.ConflictEntity
import com.qingyu.companion.local.db.EntityHeadEntity
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalConnectionProfileEntity
import com.qingyu.companion.local.db.LocalDeviceStateEntity
import com.qingyu.companion.local.db.LocalDeviceSettingEntity
import com.qingyu.companion.local.db.LocalGroupEntity
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
import com.qingyu.companion.local.db.QingyuLocalDatabase
import com.qingyu.companion.local.db.SyncReceiptEntity
import com.qingyu.companion.local.db.UsageAggregateRow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext

/**
 * 阶段 3 S3-03：本地权威 Repository（Room 实现）。
 *
 * 不变量（可被 `LocalRepositoryContractTest` 验证）：
 * 1. 每次业务写都在**同一 Room 事务**内同时写业务表、`entity_heads`、`change_log`。
 * 2. 本地写分配当前设备 counter（十进制字符串，绝不经过 Long）；`origin = local`。
 * 3. 远端应用写 `origin = remote`，且不推进本机 dot（版本向量里不含本机新 counter）。
 * 4. 同事务失败时三张表一起回滚，不产生 "有业务行无 journal" 或反向的不一致。
 * 5. 删除写 tombstone（`deleted = true`）并保留 change_log 历史，不物理抹除同步历史。
 */
class RoomLocalSyncRepository(
    private val db: QingyuLocalDatabase,
    private val deviceId: String,
) : LocalStore {

    override fun deviceId(): String = deviceId

    override suspend fun <R> inTransaction(block: suspend () -> R): R = db.withTransaction { block() }

    // ------------------------------------------------------------ 通用写路径

    private class Tx(
        val origin: Origin,
        val entityType: String,
        val entityId: String,
        val payload: Map<String, Any?>,
        val now: Long,
    )

    /**
     * 事务体：写业务行 + head + change_log。
     * [business] 必须是纯数据库写入，不得发起网络或文件 IO（否则会拉长事务）。
     */
    private suspend fun <R> withJournal(
        entityType: String,
        entityId: String,
        origin: Origin,
        /** §6.3 跨实体不变量的来源：会话→角色/群、消息→会话、记忆→会话。顶层实体为 null。 */
        parentId: String? = null,
        schemaVersion: Int = LocalEnvelope.DEFAULT_SCHEMA_VERSION,
        deleted: Boolean = false,
        payload: () -> Map<String, Any?>,
        business: suspend () -> R,
    ): R = db.withTransaction {
        // 路径穿越防护（阶段 1 冻结契约）：非法 ID 直接拒绝，不产生任何业务行/head/journal。
        MigrationIdentity.requireValidEntityId(entityId)
        val businessResult = business()

        val payloadMap = if (deleted) emptyMap() else payload()
        // 单条 payload 上限 2 MiB（总方案 §6.2）：超出必须走 blob，不得进入实体信封。
        val canonicalPayload = MigrationIdentity.requirePayloadWithinLimit(payloadMap)
        val contentHash = "sha256:" + sha256Hex(canonicalPayload)
        val previous = db.syncMetaDao().getHead(entityType, entityId)
        val previousVersion = previous?.let { VersionVectorJson.decode(it.versionJson) } ?: emptyMap()

        val (dotDevice, dotCounter, version) = when (origin) {
            Origin.Local -> {
                val (device, counter) = allocateCounterInTx()
                val merged = previousVersion.toMutableMap()
                merged[device] = counter
                Triple(device, counter, merged.toMap())
            }
            Origin.Remote, Origin.Migration -> {
                // 远端应用/迁移导入：不推进本机 dot，只在 head 上记录收到的事实。
                val dot = previousVersion.entries.firstOrNull()?.key ?: deviceId
                Triple(dot, previousVersion[dot] ?: "0", previousVersion)
            }
        }

        val now = System.currentTimeMillis()
        val envelope = LocalEnvelope(
            entityType = entityType,
            entityId = entityId,
            payload = payloadMap,
            deviceId = dotDevice,
            counter = dotCounter,
            version = version,
            parentId = parentId,
            schemaVersion = schemaVersion,
            deleted = deleted,
            updatedAt = now,
            contentHash = contentHash,
        )

        db.syncMetaDao().upsertHead(
            EntityHeadEntity(
                entityType = entityType,
                entityId = entityId,
                versionJson = VersionVectorJson.encode(version),
                hash = contentHash,
                deleted = deleted,
                updatedAt = now,
            ),
        )
        db.syncMetaDao().insertChange(
            ChangeLogEntity(
                dotDevice = dotDevice,
                dotCounter = dotCounter,
                entityType = entityType,
                entityId = entityId,
                envelopeJson = envelope.toJson(),
                origin = origin.wire,
                recordedAt = now,
            ),
        )
        businessResult
    }

    /** 必须在事务内调用。返回 (deviceId, counter)。 */
    private suspend fun allocateCounterInTx(): Pair<String, String> {
        val dao = db.deviceDao()
        val state = dao.get() ?: LocalDeviceStateEntity(
            deviceId = deviceId,
            nextCounterText = "1",
            updatedAt = System.currentTimeMillis(),
        )
        val current = state.nextCounterText.toULongOrNull()
            ?: throw IllegalStateException("设备 counter 损坏：${state.nextCounterText}")
        dao.upsert(
            state.copy(
                nextCounterText = (current + 1uL).toString(),
                updatedAt = System.currentTimeMillis(),
            ),
        )
        return deviceId to current.toString()
    }

    /**
     * 必须在事务内调用。
     *
     * [requireAncestor] = true（业务实体删除）时，没有祖先 head 就跳过；
     * 角色级快捷回复走 false 分支：PC 的 `quickReply:clearCharacter` 对 `qr-char-<id>`
     * 直接落 delete，而那个 id 从来没有单独记账过（整库只有 `quick-replies-root` 一个实体）。
     * 若因「没有 head」就静默跳过，删除语义会丢失，长期离线的设备会把该角色的集合带回。
     */
    private suspend fun tombstoneInTx(
        entityType: String,
        entityId: String,
        requireAncestor: Boolean = true,
        /** 被删实体的父：PC 的 `deletes` 也带 parentId（`chat.ts:100/211`），delete fence 靠它归属。 */
        parentId: String? = null,
    ): Boolean {
        val head = db.syncMetaDao().getHead(entityType, entityId)
        if (head == null && requireAncestor) return false
        val (device, counter) = allocateCounterInTx()
        val version = VersionVectorJson.decode(head?.versionJson ?: "{}").toMutableMap()
        version[device] = counter
        val now = System.currentTimeMillis()
        val emptyHash = MigrationIdentity.contentHash(emptyMap())
        db.syncMetaDao().upsertHead(
            head?.copy(
                versionJson = VersionVectorJson.encode(version),
                hash = emptyHash,
                deleted = true,
                updatedAt = now,
            )
                ?: EntityHeadEntity(
                    entityType = entityType,
                    entityId = entityId,
                    versionJson = VersionVectorJson.encode(version),
                    hash = emptyHash,
                    deleted = true,
                    updatedAt = now,
                ),
        )
        db.syncMetaDao().insertChange(
            ChangeLogEntity(
                dotDevice = device,
                dotCounter = counter,
                entityType = entityType,
                entityId = entityId,
                envelopeJson = LocalEnvelope(
                    entityType = entityType,
                    entityId = entityId,
                    payload = emptyMap(),
                    deviceId = device,
                    counter = counter,
                    version = version,
                    parentId = parentId,
                    deleted = true,
                    updatedAt = now,
                    contentHash = emptyHash,
                ).toJson(),
                origin = Origin.Local.wire,
                recordedAt = now,
            ),
        )
        return true
    }

    /**
     * 删除的业务行清除与 tombstone 写入必须在**同一事务**内完成，
     * 否则崩溃会留下 "有 tombstone 无业务行删除"（或反向）的半提交状态。
     */
    private suspend fun deleteWithTombstone(
        entityType: String,
        entityId: String,
        parentId: String? = null,
        businessDelete: suspend () -> Unit,
    ) {
        db.withTransaction {
            businessDelete()
            tombstoneInTx(entityType, entityId, parentId = parentId)
        }
    }

    // ------------------------------------------------------------ 角色

    override fun observeCharacters(): Flow<List<LocalCharacterEntity>> = db.characterDao().observeAll()

    override suspend fun listCharacters(): List<LocalCharacterEntity> = io { db.characterDao().listAll() }

    override suspend fun getCharacter(id: String): LocalCharacterEntity? = io { db.characterDao().getById(id) }

    override suspend fun searchCharacters(
        query: String,
        sortBy: String,
        limit: Int,
        offset: Int,
    ): List<LocalCharacterEntity> = io {
        // UI token 先收敛成白名单值再进查询：`sortBy` 出现在 `CASE WHEN` 里，
        // 但真正被 ORDER BY 引用的列名必须始终是 SQL 文本，所以绝不能透传用户输入。
        db.characterDao().search(query, CharacterSortColumn.resolve(sortBy), limit, offset)
    }

    override suspend fun countCharacters(query: String): Int = io { db.characterDao().countMatching(query) }

    override suspend fun putCharacter(entity: LocalCharacterEntity) {
        val now = System.currentTimeMillis()
        val row = entity.copy(updatedAt = now, createdAt = if (entity.createdAt == 0L) now else entity.createdAt)
        withJournal(
            EntityTypes.CHARACTER,
            row.id,
            Origin.Local,
            payload = { characterPayload(row) },
        ) {
            db.characterDao().upsert(row)
        }
    }

    override suspend fun characterBindingImpact(id: String): BindingImpact = io {
        BindingImpact(characters = 0, sessions = db.characterDao().countSessions(id))
    }

    override suspend fun characterMessageCount(id: String): Int = io { db.characterDao().countMessages(id) }

    /**
     * S5-01/S5-06：删角色前，先在**同一事务**内清掉它的角色级快捷回复。
     *
     * 顺序是约束而非风格：快捷回复的整库 journal 必须排在角色 tombstone 之前，
     * 这样按 `seq` 重放变更日志的设备永远看不到「父角色已 tombstone、子集合还在库里」的中间态
     * （总方案 §6.3 依赖冲突 / 方案 §2「不得产生可见孤儿数据」）。
     */
    override suspend fun deleteCharacter(id: String) {
        db.withTransaction {
            deleteCharacterQuickRepliesInTx(id)
            db.characterDao().delete(id)
            tombstoneInTx(EntityTypes.CHARACTER, id)
        }
    }

    /**
     * 阶段 5：改为委托 [EntityPayloads.characterPayload]。
     *
     * 阶段 3 直接把 Room 列名写进 journal（`exampleDialogueJson`/`lorebookId`/`avatarPath`…），
     * 而 `shared/contracts/schemas/character-payload.schema.json` 是 `additionalProperties:false`
     * 且键名为 `exampleDialog`/`boundLorebookIds`/`boundPresetId`——本机自己产出的信封
     * 会被共享契约判为非法，且与 PC `characterEntityPayload` 的哈希永不相等。
     */
    private fun characterPayload(row: LocalCharacterEntity): Map<String, Any?> =
        EntityPayloads.characterPayload(row)

    // ------------------------------------------------------------ 世界书 / 预设 / 人设 / 正则 / 快捷回复

    override fun observeLorebooks(): Flow<List<LocalLorebookEntity>> = db.lorebookDao().observeAll()

    override suspend fun listLorebooks(): List<LocalLorebookEntity> = io { db.lorebookDao().listAll() }

    override suspend fun searchLorebooks(
        query: String,
        limit: Int,
        offset: Int,
    ): List<LocalLorebookEntity> = io { db.lorebookDao().search(query, limit, offset) }

    override suspend fun countLorebooks(query: String): Int = io { db.lorebookDao().countMatching(query) }

    override suspend fun listLorebookIds(): List<String> = io { db.lorebookDao().listIds() }

    override suspend fun getLorebook(id: String): LocalLorebookEntity? = io { db.lorebookDao().getById(id) }

    override suspend fun putLorebook(entity: LocalLorebookEntity) {
        // canonical 正文必须是合法 JSON 对象。少了这道校验时，一份坏正文会被
        // `lorebookPayload` 静默解析成空 Map：本地条目还在、发出去的 payload 却是空文档，
        // 而且 `requirePayloadWithinLimit` 量的是派生 payload，超大写入因此完全不被拦。
        require(JsonValues.isJsonObjectText(entity.canonicalJson)) {
            "世界书 ${entity.id} 的 canonical 正文不是合法 JSON 对象，拒绝写入（不静默降级为空文档）"
        }
        val now = System.currentTimeMillis()
        val row = entity.copy(updatedAt = now, createdAt = if (entity.createdAt == 0L) now else entity.createdAt)
        withJournal(
            EntityTypes.LOREBOOK,
            row.id,
            Origin.Local,
            payload = { EntityPayloads.lorebookPayload(row) },
        ) {
            db.lorebookDao().upsert(row)
        }
    }

    override suspend fun deleteLorebook(id: String) =
        deleteWithTombstone(EntityTypes.LOREBOOK, id) { db.lorebookDao().delete(id) }

    /**
     * S5-02：删除被绑定的世界书要先解绑角色与会话。
     *
     * 解绑逐行经 [putCharacter] / [putSession] 落库而不是裸 `UPDATE`：
     * 这两个都是同步实体，跳过 journal 就等于对端永远看不到解绑，
     * 同步完成后别的设备仍指向已删世界书（§5.1 的写入不变量）。
     */
    override suspend fun deleteLorebookUnbindingReferences(id: String): BindingImpact {
        val impact = lorebookBindingImpact(id)
        db.withTransaction {
            rewriteUnbound(
                characters = db.lorebookDao().listBoundCharacters(id).map { row ->
                    row.copy(
                        lorebookId = row.lorebookId?.takeIf { it != id },
                        boundLorebookIdsJson = withoutIdInArray(row.boundLorebookIdsJson, id),
                    )
                },
                sessions = db.lorebookDao().listBoundSessions(id).map { row ->
                    row.copy(lorebookIdsJson = withoutIdInArray(row.lorebookIdsJson, id))
                },
            )
            db.lorebookDao().delete(id)
            tombstoneInTx(EntityTypes.LOREBOOK, id)
        }
        return impact
    }

    /** 解绑的落库入口：只走带 journal 的写路径。 */
    private suspend fun rewriteUnbound(
        characters: List<LocalCharacterEntity>,
        sessions: List<LocalSessionEntity>,
    ) {
        characters.forEach { putCharacter(it) }
        sessions.forEach { putSession(it) }
    }

    /** 从 JSON 数组文本列里去掉一个 id，保持其余顺序（顺序进 payload，顺序进哈希）。 */
    private fun withoutIdInArray(json: String, id: String): String =
        JsonValues.stringify(JsonValues.parseArray(json).filterNot { it == id })

    override suspend fun lorebookBindingImpact(id: String): BindingImpact = io {
        BindingImpact(
            characters = db.lorebookDao().countBoundCharacters(id),
            sessions = db.lorebookDao().countBoundSessions(id),
        )
    }

    override fun observePresets(): Flow<List<LocalPresetEntity>> = db.presetDao().observeAll()

    override suspend fun listPresets(): List<LocalPresetEntity> = io { db.presetDao().listAll() }

    override suspend fun listPresetIds(): List<String> = io { db.presetDao().listIds() }

    override suspend fun getPreset(id: String): LocalPresetEntity? = io { db.presetDao().getById(id) }

    override suspend fun listPresetSection(builtin: Boolean): List<LocalPresetEntity> = io {
        db.presetDao().listByBuiltin(builtin)
    }

    override suspend fun searchPresets(
        builtin: Boolean,
        query: String,
        limit: Int,
        offset: Int,
    ): List<LocalPresetEntity> = io { db.presetDao().search(builtin, query, limit, offset) }

    override suspend fun countPresets(builtin: Boolean, query: String): Int = io {
        db.presetDao().countMatching(builtin, query)
    }

    override suspend fun putPreset(entity: LocalPresetEntity) {
        val now = System.currentTimeMillis()
        val row = entity.copy(updatedAt = now, createdAt = if (entity.createdAt == 0L) now else entity.createdAt)
        withJournal(
            EntityTypes.PRESET,
            row.id,
            Origin.Local,
            payload = { EntityPayloads.presetPayload(row) },
        ) {
            db.presetDao().upsert(row)
        }
    }

    /**
     * 阶段 5 S5-03：删除被引用的预设必须**先解绑再删**，且解绑本身也是业务写。
     *
     * 为什么在同一事务里做：分两个事务会出现「预设已删、会话仍指向它」的中间态，
     * 崩溃后无法判定该会话原本用的是哪个预设；而 PC 端删除预设是单文件动作，
     * 引用留在会话里。Android 把会话引用列显式置空，避免生成孤儿引用。
     */
    override suspend fun deletePresetUnbindingReferences(id: String): BindingImpact {
        val impact = presetBindingImpact(id)
        db.withTransaction {
            rewriteUnbound(
                characters = db.presetDao().listBoundCharacters(id).map { it.copy(defaultPresetId = null) },
                sessions = db.presetDao().listBoundSessions(id).map { it.copy(presetId = null) },
            )
            db.presetDao().delete(id)
            tombstoneInTx(EntityTypes.PRESET, id)
        }
        return impact
    }

    override suspend fun deletePreset(id: String) =
        deleteWithTombstone(EntityTypes.PRESET, id) { db.presetDao().delete(id) }

    override suspend fun presetBindingImpact(id: String): BindingImpact = io {
        BindingImpact(
            characters = db.presetDao().countBoundCharacters(id),
            sessions = db.presetDao().countBoundSessions(id),
        )
    }

    override fun observePersonas(): Flow<List<LocalPersonaEntity>> = db.personaDao().observeAll()

    override suspend fun listPersonas(): List<LocalPersonaEntity> = io { db.personaDao().listAll() }

    override suspend fun getPersona(id: String): LocalPersonaEntity? = io { db.personaDao().getById(id) }

    override suspend fun putPersona(entity: LocalPersonaEntity) {
        val now = System.currentTimeMillis()
        val row = entity.copy(updatedAt = now, createdAt = if (entity.createdAt == 0L) now else entity.createdAt)
        withJournal(
            EntityTypes.PERSONA,
            row.id,
            Origin.Local,
            payload = { EntityPayloads.personaPayload(row) },
        ) {
            db.personaDao().upsert(row)
        }
    }

    override suspend fun deletePersona(id: String) =
        deleteWithTombstone(EntityTypes.PERSONA, id) { db.personaDao().delete(id) }

    override suspend fun personaBindingImpact(id: String): BindingImpact = io {
        BindingImpact(
            characters = db.personaDao().countBoundCharacters(id),
            sessions = db.personaDao().countBoundSessions(id),
        )
    }

    override suspend fun deletePersonaUnbindingReferences(id: String): BindingImpact {
        val impact = personaBindingImpact(id)
        db.withTransaction {
            rewriteUnbound(
                characters = db.personaDao().listBoundCharacters(id).map { it.copy(defaultPersonaId = null) },
                sessions = db.personaDao().listBoundSessions(id).map { it.copy(personaId = null) },
            )
            db.personaDao().delete(id)
            tombstoneInTx(EntityTypes.PERSONA, id)
        }
        return impact
    }

    override fun observeRegexRules(): Flow<List<LocalRegexRuleEntity>> = db.regexRuleDao().observeAll()

    override suspend fun listRegexRules(): List<LocalRegexRuleEntity> = io { db.regexRuleDao().listAll() }

    override suspend fun getRegexRule(id: String): LocalRegexRuleEntity? = io { db.regexRuleDao().getById(id) }

    override suspend fun putRegexRule(entity: LocalRegexRuleEntity) {
        val now = System.currentTimeMillis()
        val row = entity.copy(updatedAt = now, createdAt = if (entity.createdAt == 0L) now else entity.createdAt)
        withJournal(
            EntityTypes.REGEX_RULE,
            row.id,
            Origin.Local,
            payload = { EntityPayloads.regexRulePayload(row) },
        ) {
            db.regexRuleDao().upsert(row)
        }
    }

    override suspend fun deleteRegexRule(id: String) =
        deleteWithTombstone(EntityTypes.REGEX_RULE, id) { db.regexRuleDao().delete(id) }

    /**
     * 排序调整（方案 S5-05「启用、排序」）。
     *
     * 每条规则都要单独记账：只写库不写 journal 会让对端看到旧顺序，
     * 而顺序本身就是业务语义（正则按 `sortIndex` 链式应用）。
     */
    override suspend fun reorderRegexRules(orderedIds: List<String>) {
        db.withTransaction {
            orderedIds.forEachIndexed { index, id ->
                val existing = db.regexRuleDao().getById(id) ?: return@forEachIndexed
                if (existing.sortIndex == index) return@forEachIndexed
                val row = existing.copy(sortIndex = index, updatedAt = System.currentTimeMillis())
                withJournal(
                    EntityTypes.REGEX_RULE,
                    row.id,
                    Origin.Local,
                    payload = { EntityPayloads.regexRulePayload(row) },
                ) {
                    db.regexRuleDao().upsert(row)
                }
            }
        }
    }

    override fun observeQuickReplySets(): Flow<List<LocalQuickReplySetEntity>> = db.quickReplySetDao().observeAll()

    override suspend fun listQuickReplySets(): List<LocalQuickReplySetEntity> = io { db.quickReplySetDao().listAll() }

    override suspend fun getQuickReplySet(id: String): LocalQuickReplySetEntity? = io {
        db.quickReplySetDao().getById(id)
    }

    override suspend fun listGlobalQuickReplySets(): List<LocalQuickReplySetEntity> = io {
        db.quickReplySetDao().listGlobal()
    }

    override suspend fun listCharacterQuickReplySets(characterId: String): List<LocalQuickReplySetEntity> = io {
        db.quickReplySetDao().listForCharacter(characterId)
    }

    /**
     * 阶段 5 S5-06：快捷回复的 journal 粒度改为**整库单实体** `quick-replies-root`。
     *
     * PC 的 `quickReplyStorePayload` 把 `{global, byCharacter}` 整库记成一个实体，
     * 角色级集合删除另以 `qr-char-<characterId>` tombstone 记账。
     * Android 早期按集合行各自记账，两端实体 id 与粒度都不同 —— 同一份数据
     * 会被判成两个互不相关的实体，删除还会漏记。这里对齐 PC 粒度。
     */
    override suspend fun putQuickReplySet(entity: LocalQuickReplySetEntity) {
        val now = System.currentTimeMillis()
        val row = entity.copy(updatedAt = now, createdAt = if (entity.createdAt == 0L) now else entity.createdAt)
        db.withTransaction {
            db.quickReplySetDao().upsert(row)
            journalQuickReplyStoreInTx()
        }
    }

    override suspend fun deleteQuickReplySet(id: String) {
        db.withTransaction {
            val existing = db.quickReplySetDao().getById(id)
            db.quickReplySetDao().delete(id)
            journalQuickReplyStoreInTx()
            // 角色级集合被清空后，该角色在 byCharacter 里不再有键；PC 用独立 tombstone
            // 记录「这个角色集合被删除」，让长期离线设备不会把它带回来。
            val characterId = existing?.characterId
            if (characterId != null && db.quickReplySetDao().listForCharacter(characterId).isEmpty()) {
                tombstoneInTx(EntityTypes.QUICK_REPLY_SET, "qr-char-$characterId", requireAncestor = false)
            }
        }
    }

    /** 必须在事务内：以当前全库视图重算 quick-replies-root 的 journal。 */
    private suspend fun journalQuickReplyStoreInTx() {
        val rows = db.quickReplySetDao().listAll()
        withJournal(
            EntityTypes.QUICK_REPLY_SET,
            CanonicalEntityIds.QUICK_REPLY_ROOT,
            Origin.Local,
            payload = { EntityPayloads.quickReplyStorePayload(rows) },
        ) { }
    }

    /**
     * S5-06：清空角色级集合。无集合可清时**整段跳过**（含 journal），
     * 否则「删一个从不使用快捷回复的角色」也会凭空推进版本向量并留一条无关变更。
     */
    override suspend fun deleteCharacterQuickReplies(characterId: String) {
        db.withTransaction { deleteCharacterQuickRepliesInTx(characterId) }
    }

    /** 必须在事务内调用。 */
    private suspend fun deleteCharacterQuickRepliesInTx(characterId: String) {
        val ids = db.quickReplySetDao().listIdsForCharacter(characterId)
        if (ids.isEmpty()) return
        ids.forEach { db.quickReplySetDao().delete(it) }
        journalQuickReplyStoreInTx()
        tombstoneInTx(EntityTypes.QUICK_REPLY_SET, "qr-char-$characterId", requireAncestor = false)
    }

    // ------------------------------------------------------------ 映射模板（S5-02）

    override fun observeLorebookMappingTemplates(): Flow<List<LocalLorebookMappingTemplateEntity>> =
        db.lorebookMappingTemplateDao().observeAll()

    override suspend fun listLorebookMappingTemplates(): List<LocalLorebookMappingTemplateEntity> = io {
        db.lorebookMappingTemplateDao().listAll()
    }

    override suspend fun getLorebookMappingTemplate(id: String): LocalLorebookMappingTemplateEntity? = io {
        db.lorebookMappingTemplateDao().getById(id)
    }

    override suspend fun putLorebookMappingTemplate(entity: LocalLorebookMappingTemplateEntity) {
        // 受限 DSL 校验在落库**之前**：非法模板不允许产生任何业务行/journal。
        LorebookMappingTemplateDsl.requireValid(entity.templateJson)
        val now = System.currentTimeMillis()
        val row = entity.copy(updatedAt = now, createdAt = if (entity.createdAt == 0L) now else entity.createdAt)
        withJournal(
            EntityTypes.LOREBOOK_MAPPING_TEMPLATE,
            row.id,
            Origin.Local,
            payload = { EntityPayloads.mappingTemplatePayload(row) },
        ) {
            db.lorebookMappingTemplateDao().upsert(row)
        }
    }

    override suspend fun deleteLorebookMappingTemplate(id: String) = deleteWithTombstone(
        EntityTypes.LOREBOOK_MAPPING_TEMPLATE,
        id,
    ) { db.lorebookMappingTemplateDao().delete(id) }

    // ------------------------------------------------------------ 群组

    override fun observeGroups(): Flow<List<LocalGroupEntity>> = db.groupDao().observeAll()

    override suspend fun listGroups(): List<LocalGroupEntity> = io { db.groupDao().listAll() }

    override suspend fun putGroup(entity: LocalGroupEntity) {
        val now = System.currentTimeMillis()
        val row = entity.copy(updatedAt = now, createdAt = if (entity.createdAt == 0L) now else entity.createdAt)
        withJournal(
            "group",
            row.id,
            Origin.Local,
            payload = { EntityPayloads.groupPayload(row) },
        ) {
            db.groupDao().upsert(row)
        }
    }

    override suspend fun deleteGroup(id: String) =
        deleteWithTombstone("group", id) { db.groupDao().delete(id) }

    // ------------------------------------------------------------ 会话 / 消息

    override fun observeSessions(): Flow<List<LocalSessionEntity>> = db.sessionDao().observeAll()

    override suspend fun listSessions(): List<LocalSessionEntity> = io { db.sessionDao().listAll() }

    override suspend fun getSession(id: String): LocalSessionEntity? = io { db.sessionDao().getById(id) }

    override suspend fun putSession(entity: LocalSessionEntity) {
        val now = System.currentTimeMillis()
        val row = entity.copy(updatedAt = now, createdAt = if (entity.createdAt == 0L) now else entity.createdAt)
        // 跨实体不变量 A：父实体（角色/群组）未被 tombstone 才能建会话（总方案 §6.3）。
        require(!isTombstoned(EntityTypes.CHARACTER, row.characterId)) { "父角色已被删除，不能写入会话" }
        require(!isTombstoned("group", row.groupId)) { "父群组已被删除，不能写入会话" }
        withJournal(
            "session",
            row.id,
            Origin.Local,
            // 群会话的父是群、单聊会话的父是角色——与 PC `group.ts`/`chat.ts` 的 parentId 口径一致
            parentId = row.groupId ?: row.characterId,
            payload = { EntityPayloads.sessionPayload(row) },
        ) {
            db.sessionDao().upsert(row)
        }
    }

    override suspend fun deleteSession(id: String) {
        // 父必须在删除**之前**读：行没了以后 tombstone 的 parentId 就永久是 null，
        // 而 §6.3 的删除并发/孤儿检测正是靠它把 tombstone 归到某个角色/群下。
        val parent = io { db.sessionDao().getById(id) }?.let { it.groupId ?: it.characterId }
        deleteWithTombstone("session", id, parentId = parent) {
            db.messageDao().deleteForSession(id)
            db.memoryDao().deleteFactsForSession(id)
            db.sessionDao().delete(id)
        }
    }

    override fun observeMessages(sessionId: String): Flow<List<LocalMessageEntity>> =
        db.messageDao().observeForSession(sessionId)

    override suspend fun listMessages(sessionId: String): List<LocalMessageEntity> =
        io { db.messageDao().listForSession(sessionId) }

    /** 新增消息：分配 session 内稳定 `seq`；父会话被删除时拒绝写入（跨实体不变量 B）。 */
    override suspend fun appendMessage(entity: LocalMessageEntity) {
        val now = System.currentTimeMillis()
        withJournal(
            "message",
            entity.id,
            Origin.Local,
            parentId = entity.sessionId,
            payload = { EntityPayloads.messagePayload(entity) },
            business = {
                require(db.sessionDao().getById(entity.sessionId) != null) { "父会话不存在，拒绝写入消息" }
                require(!isTombstoned("session", entity.sessionId)) { "父会话已被删除，拒绝写入消息" }
                val seq = if (entity.seq >= 0) entity.seq else db.messageDao().nextSeq(entity.sessionId)
                db.messageDao().upsert(
                    entity.copy(
                        seq = seq,
                        logicalTime = if (entity.logicalTime == 0L) now else entity.logicalTime,
                        createdAt = if (entity.createdAt == 0L) now else entity.createdAt,
                        updatedAt = now,
                    ),
                )
            },
        )
    }

    override suspend fun updateMessage(entity: LocalMessageEntity) {
        val now = System.currentTimeMillis()
        withJournal(
            "message",
            entity.id,
            Origin.Local,
            parentId = entity.sessionId,
            payload = { EntityPayloads.messagePayload(entity) },
        ) {
            val existing = db.messageDao().getById(entity.id)
            db.messageDao().upsert(
                entity.copy(
                    seq = existing?.seq ?: entity.seq,
                    createdAt = existing?.createdAt ?: now,
                    updatedAt = now,
                ),
            )
        }
    }

    override suspend fun deleteMessage(id: String, sessionId: String) =
        deleteWithTombstone("message", id, parentId = sessionId) { db.messageDao().delete(id) }

    // ------------------------------------------------------------ 记忆 / 用量 / 媒体

    override suspend fun getMemoryState(sessionId: String): LocalMemoryStateEntity? =
        io { db.memoryDao().getState(sessionId) }

    override suspend fun putMemoryState(entity: LocalMemoryStateEntity) {
        val now = System.currentTimeMillis()
        val row = entity.copy(updatedAt = now)
        withJournal(
            "memory_state",
            row.id,
            Origin.Local,
            parentId = row.sessionId,
            // 这里原先是一份**自己的 4 键内联 map**（sessionId/summary/coveredThroughSeq/budgetJson），
            // 而 CAS 路径用的是 [memoryStatePayload] 的 7 键——同一实体类型两种 payload 形状，
            // 两条生产写路径算出不同 contentHash（§2.23 修的是跨端版本，这个是**本机内部**版本）。
            // 上方的注释「保留原字段进 journal 载荷，同时补上 S4-05 新增字段」正说明它当时漏改了这一处。
            payload = { memoryStatePayload(row) },
        ) {
            db.memoryDao().upsertState(row)
        }
    }

    /** 保留原字段进 journal 载荷，同时补上 S4-05 新增字段，便于后续同步/审计。 */
    private fun memoryStatePayload(row: LocalMemoryStateEntity): Map<String, Any?> = mapOf(
        "sessionId" to row.sessionId,
        "summary" to row.summary,
        "coveredThroughSeq" to row.coveredThroughSeq,
        "budgetJson" to row.budgetJson,
        "memoryVersion" to row.memoryVersion,
        "historyRevision" to row.historyRevision,
        "factCount" to runCatching {
            org.json.JSONArray(row.factsJson).length()
        }.getOrDefault(0),
    )

    /**
     * 阶段 4 S4-05：条件写入记忆（CAS）。
     *
     * 事务内先判断行是否存在：存在则走**单条条件 UPDATE**（版本不等 → 0 行受影响 → 丢弃）；
     * 不存在则只在期望版本为 0 时以初始行插入（否则说明并发方已创建，视为过期）。
     * 只有真正应用后才写 journal——失败时磁盘与变更日志都不得变化。
     */
    override suspend fun applyMemoryStateIfVersion(
        sessionId: String,
        expectedVersion: Long,
        entity: LocalMemoryStateEntity,
    ): MemoryCasResult = io {
        val now = System.currentTimeMillis()
        val row = entity.copy(sessionId = sessionId, updatedAt = now, memoryVersion = expectedVersion + 1)
        val existing = db.memoryDao().getState(sessionId)
        if (existing == null) {
            if (expectedVersion != 0L) return@io MemoryCasResult(applied = false, currentVersion = 0L)
            withJournal("memory_state", row.id, Origin.Local, parentId = sessionId, payload = { memoryStatePayload(row) }) {
                db.memoryDao().upsertState(row)
            }
            return@io MemoryCasResult(applied = true, currentVersion = row.memoryVersion)
        }
        val affected = withJournal("memory_state", existing.id, Origin.Local, parentId = sessionId, payload = { memoryStatePayload(row) }) {
            db.memoryDao().applyStateIfVersion(
                sessionId = sessionId,
                expectedVersion = expectedVersion,
                nextVersion = expectedVersion + 1,
                summary = row.summary,
                currentState = row.currentState,
                factsJson = row.factsJson,
                historyJson = row.historyJson,
                coveredThroughSeq = row.coveredThroughSeq,
                historyRevision = row.historyRevision,
                budgetJson = row.budgetJson,
                cursorMessageId = row.memoryLastMessageId,
                factParseFailureCount = row.factParseFailureCount,
                factRetryAfterVersion = row.factRetryAfterVersion,
                updatedAt = now,
            )
        }
        MemoryCasResult(
            applied = affected > 0,
            currentVersion = if (affected > 0) expectedVersion + 1 else existing.memoryVersion,
        )
    }

    override suspend fun bumpMemoryHistoryRevision(sessionId: String): Boolean = io {
        db.memoryDao().bumpHistoryRevision(sessionId, System.currentTimeMillis()) > 0
    }

    override suspend fun listMemoryFacts(sessionId: String): List<LocalMemoryFactEntity> =
        io { db.memoryDao().listFacts(sessionId) }
    override suspend fun putMemoryFact(entity: LocalMemoryFactEntity) {
        val now = System.currentTimeMillis()
        val row = entity.copy(createdAt = if (entity.createdAt == 0L) now else entity.createdAt)
        withJournal(
            "memory_fact",
            row.id,
            Origin.Local,
            parentId = row.sessionId,
            payload = {
                mapOf(
                    "sessionId" to row.sessionId,
                    "subject" to row.subject,
                    "content" to row.content,
                    "sourceMessageId" to row.sourceMessageId,
                    "confidence" to row.confidence,
                )
            },
        ) {
            db.memoryDao().upsertFact(row)
        }
    }

    override suspend fun deleteMemoryFact(id: String) {
        // 同 deleteSession：父（会话）要在删除前读出来
        val sessionId = io { db.memoryDao().getFact(id) }?.sessionId
        deleteWithTombstone("memory_fact", id, parentId = sessionId) { db.memoryDao().deleteFact(id) }
    }

    /**
     * 用量记录按事件 ID 去重并集（总方案 §6.3）：
     * 同 ID 已存在时不产生第二条 change_log，也不刷新 head。
     */
    override suspend fun recordUsage(entity: LocalUsageRecordEntity): Boolean = db.withTransaction {
        if (db.usageDao().exists(entity.id) > 0) return@withTransaction false
        recordUsageInTx(entity)
        trimUsageToRetentionInTx()
        true
    }

    /**
     * S5-07：超过保留上限的旧用量记录必须**逐条产生 tombstone**，
     * 与 PC `electron/services/usage.ts` 的 `MAX_RECORDS = 10000` +
     * `deletes: trimmedIds` 同一语义（自动清理也要产生清理记录）。
     *
     * 裸 `DELETE` 不记账正是方案点名的「静默删除同步记录」：别的设备下一轮同步
     * 会把这些记录原样带回来，用户看到用量记录复活。
     */
    private suspend fun trimUsageToRetentionInTx() {
        val excess = db.usageDao().count() - LocalStore.MAX_USAGE_RECORDS
        if (excess <= 0) return
        val evicted = db.usageDao().oldestIds(excess)
        evicted.chunked(MAX_DELETE_BATCH).forEach { db.usageDao().deleteByIds(it) }
        evicted.forEach { tombstoneInTx(EntityTypes.USAGE_RECORD, it) }
    }

    /** 必须在事务内调用。 */
    private suspend fun recordUsageInTx(entity: LocalUsageRecordEntity) {
        val now = System.currentTimeMillis()
        // S5-07：payload 改为 PC `usage.ts` 的固定 7 键（`totalChars` 由输入+输出求和）。
        // 早前直接写 Room 列名与 `promptTokens`，与 PC 记录的不是同一份内容，跨端哈希永不相等。
        val payload = EntityPayloads.usageRecordPayload(entity)
        val (device, counter) = allocateCounterInTx()
        val previous = db.syncMetaDao().getHead(EntityTypes.USAGE_RECORD, entity.id)
        val version = (previous?.let { VersionVectorJson.decode(it.versionJson) } ?: emptyMap()).toMutableMap()
        version[device] = counter
        val contentHash = MigrationIdentity.contentHash(payload)
        db.usageDao().insert(
            entity.copy(createdAt = if (entity.createdAt == 0L) now else entity.createdAt),
        )
        db.syncMetaDao().upsertHead(
            EntityHeadEntity(
                entityType = EntityTypes.USAGE_RECORD,
                entityId = entity.id,
                versionJson = VersionVectorJson.encode(version),
                hash = contentHash,
                deleted = false,
                updatedAt = now,
            ),
        )
        db.syncMetaDao().insertChange(
            ChangeLogEntity(
                dotDevice = device,
                dotCounter = counter,
                entityType = EntityTypes.USAGE_RECORD,
                entityId = entity.id,
                envelopeJson = LocalEnvelope(
                    entityType = EntityTypes.USAGE_RECORD,
                    entityId = entity.id,
                    payload = payload,
                    deviceId = device,
                    counter = counter,
                    version = version,
                    updatedAt = now,
                    contentHash = contentHash,
                ).toJson(),
                origin = Origin.Local.wire,
                recordedAt = now,
            ),
        )
    }

    override suspend fun listUsage(limit: Int): List<LocalUsageRecordEntity> =
        io { db.usageDao().listRecent(limit) }

    override suspend fun usageTotals(since: Long, sessionId: String?): Pair<Long, Long> = io {
        db.usageDao().sumPromptTokens(since, sessionId) to db.usageDao().sumCompletionTokens(since, sessionId)
    }

    override suspend fun usageStats(since: Long, until: Long): UsageStats = io {
        UsageStats(
            totalInput = db.usageDao().sumInputChars(since, until),
            totalOutput = db.usageDao().sumOutputChars(since, until),
            totalChars = db.usageDao().sumTotalChars(since, until),
            count = db.usageDao().countInRange(since, until),
        )
    }

    override suspend fun listUsageInRange(since: Long, until: Long, limit: Int): List<LocalUsageRecordEntity> =
        io { db.usageDao().listInRange(since, until, limit) }

    override suspend fun usageAggregate(
        dimension: UsageDimension,
        since: Long,
        until: Long,
        taskType: String,
    ): List<UsageAggregateRow> = io {
        // 逐维度分支调用固定查询（见 `LocalUsageDao` 注释）：绑定参数当不了 GROUP BY 的标识符。
        when (dimension) {
            UsageDimension.MODEL -> db.usageDao().aggregateByModel(since, until, taskType)
            UsageDimension.PROVIDER -> db.usageDao().aggregateByProvider(since, until, taskType)
            UsageDimension.CHARACTER -> db.usageDao().aggregateByCharacter(since, until, taskType)
            UsageDimension.DATE -> db.usageDao().aggregateByDate(since, until, taskType)
            UsageDimension.STATUS -> db.usageDao().aggregateByStatus(since, until, taskType)
        }
    }

    /**
     * S5-07：因果支配式的用量清理（总方案 §6.3 `usage_clear_marker` 行）。
     *
     * 全部工作在**一个事务**里：判定、删行、推进游标、记 journal 任一段单独提交，
     * 崩溃后就会出现「记录已删但游标没推进」——对端重放时会把它当成缺失事件重新带回，
     * 或者反过来「游标推进了但记录还在」，下一次清理按新游标误删更晚的并发数据。
     *
     * 游标只前进：`clearedThrough` 逐设备取最大值（方案「多个 marker 逐设备取最大值」）。
     */
    override suspend fun clearUsage(beforeVersionVector: Map<String, String>): UsageClearResult =
        db.withTransaction {
            val existing = db.usageClearMarkerDao().get(deviceId)
            val clearedThrough = CounterVectors.merge(
                existing?.let { VersionVectorJson.decode(it.clearedThroughJson) } ?: emptyMap(),
                beforeVersionVector,
            )
            val headByRecord = db.syncMetaDao().listAllHeads()
                .filter { it.entityType == EntityTypes.USAGE_RECORD }
                .associateBy { it.entityId }
            val ids = db.usageDao().listIds()
            // 读不到 head 的记录无法证明被支配，按保留处理：宁可少删，也不误删并发数据。
            val cleared = ids.filter { id ->
                val head = headByRecord[id] ?: return@filter false
                CounterVectors.dominates(VersionVectorJson.decode(head.versionJson), clearedThrough)
            }
            val clearedSet = cleared.toSet()
            val retained = ids.filterNot { it in clearedSet }
            // 分批删：`IN (:ids)` 每个 id 一个绑定参数，SQLite 的变量上限是 999，
            // 一次删完在长期使用（用量记录没有条数上限）的库上会直接抛错。
            cleared.chunked(MAX_DELETE_BATCH).forEach { db.usageDao().deleteByIds(it) }
            val tombstoned = (stringIdsOfJson(existing?.tombstonedIdsJson) + cleared).distinct()
            db.usageClearMarkerDao().upsert(
                LocalUsageClearMarkerEntity(
                    deviceId = deviceId,
                    clearedThroughJson = VersionVectorJson.encode(clearedThrough),
                    tombstonedIdsJson = JsonValues.stringify(tombstoned),
                    updatedAt = System.currentTimeMillis(),
                ),
            )
            // payload 只带 `clearedThrough`：共享 schema 是 additionalProperties:false，
            // 已抹除 id 列表属于本地 tombstone 记账，不进入跨端信封（PC 同口径）。
            withJournal(
                EntityTypes.USAGE_CLEAR_MARKER,
                deviceId,
                Origin.Local,
                payload = { UsageClearMarkerPayload.of(clearedThrough) },
            ) { }
            UsageClearResult(clearedIds = cleared, retainedIds = retained)
        }

    override suspend fun usageClearMarker(deviceId: String): LocalUsageClearMarkerEntity? = io {
        db.usageClearMarkerDao().get(deviceId)
    }

    /**
     * S5-08：恢复备份里**其他设备**的清理游标。
     *
     * 拒绝写本机自己的行：本机游标只能由 [clearUsage] 产生，那里有「只删被支配记录」的因果判定；
     * 让备份文件直接盖一个更大的 `clearedThrough` 就等于凭一个文件抹掉本机并发产生的用量，
     * 正是 §6.3 要防的事。journal 的 payload 与 [clearUsage] 同口径（只带 `clearedThrough`，
     * 共享 schema 是 `additionalProperties:false`）。
     */
    override suspend fun putUsageClearMarker(entity: LocalUsageClearMarkerEntity) {
        require(entity.deviceId.isNotBlank()) { "usage_clear_marker 缺少 deviceId" }
        require(entity.deviceId != deviceId) {
            "不允许由备份写入本机自己的清理游标（本机只能经 clearUsage 的因果判定推进）"
        }
        val clearedThrough = VersionVectorJson.decode(entity.clearedThroughJson)
        withJournal(
            EntityTypes.USAGE_CLEAR_MARKER,
            entity.deviceId,
            Origin.Local,
            payload = { UsageClearMarkerPayload.of(clearedThrough) },
        ) {
            db.usageClearMarkerDao().upsert(entity)
        }
    }

    override suspend fun listUsageClearMarkers(): List<LocalUsageClearMarkerEntity> = io {
        db.usageClearMarkerDao().listAll()
    }

    private fun stringIdsOfJson(json: String?): List<String> = JsonValues.parseArray(json).filterIsInstance<String>()

    override suspend fun putMediaManifest(entity: LocalMediaManifestEntity) {
        val now = System.currentTimeMillis()
        val row = entity.copy(
            updatedAt = now,
            createdAt = if (entity.createdAt == 0L) now else entity.createdAt,
        )
        withJournal(
            "media_manifest",
            row.id,
            Origin.Local,
            // 媒体的父是它归属的实体（owner）。PC 侧还没有 media_manifest 的独立落点（见 D-12），
            // 所以这条 parent 语义是 Android 自己定的，等 D-12 有结论再对齐。
            parentId = row.ownerId,
            payload = {
                mapOf(
                    "ownerType" to row.ownerType,
                    "ownerId" to row.ownerId,
                    "kind" to row.kind,
                    "localPath" to row.localPath,
                    "remoteUrl" to row.remoteUrl,
                    "mimeType" to row.mimeType,
                    "byteSize" to row.byteSize,
                    "hash" to row.hash,
                )
            },
        ) {
            db.mediaDao().upsert(row)
        }
    }

    override suspend fun listMediaManifests(ownerType: String, ownerId: String): List<LocalMediaManifestEntity> =
        io { db.mediaDao().listForOwner(ownerType, ownerId) }

    // ------------------------------------------------------------ 设置分区

    override fun observePublicSettings(): Flow<List<LocalPublicSettingEntity>> = db.settingsDao().observePublic()

    override suspend fun listPublicSettings(): List<LocalPublicSettingEntity> = io { db.settingsDao().listPublic() }

    /**
     * S5-07：行式存储 + **聚合 journal**。
     *
     * PC 把整份公开设置记成**一个实体** `settings-public`
     * （`electron/domain/bootstrapScanners.ts:136` 的 `entityId: 'settings-public'`、
     * `electron/ipc/settings.ts` 的 `settingsPublicPayload`）。阶段 3 按 `(section,key)` 逐键记账，
     * 两端实体 id 与粒度都不同，首次同步必然对同一份设置产生伪冲突；
     * 因此写行之后在**同一事务内**用全表视图重算 payload。
     */
    override suspend fun putPublicSetting(section: String, key: String, valueJson: String) {
        val now = System.currentTimeMillis()
        db.withTransaction {
            db.settingsDao().upsertPublic(
                LocalPublicSettingEntity(section = section, key = key, valueJson = valueJson, updatedAt = now),
            )
            val payload = EntityPayloads.settingsPublicPayload(publicSettingsAggregate())
            withJournal(
                EntityTypes.SETTINGS_PUBLIC,
                CanonicalEntityIds.SETTINGS_PUBLIC,
                Origin.Local,
                payload = { payload },
            ) { }
        }
    }

    /**
     * 行式存储折叠成 PC 的扁平 `Settings` 视图：payload 的键是**设置键**（不含 section），
     * 与 `settingsPublicPayload` 的白名单一一对应。DAO 已按 `(section, key)` 排序，
     * 跨 section 同名键按读取序后者胜出，两侧实现同规则。
     */
    private suspend fun publicSettingsAggregate(): Map<String, Any?> =
        db.settingsDao().listPublic().associate { it.key to JsonValues.parseAny(it.valueJson) }

    override fun observeDeviceSettings(): Flow<List<LocalDeviceSettingEntity>> = db.settingsDao().observeDevice()

    /** 设备本地设置：不进入同步 envelope，因此不写 change_log。 */
    override suspend fun putDeviceSetting(key: String, valueJson: String) {
        io {
            db.settingsDao().upsertDevice(
                LocalDeviceSettingEntity(key = key, valueJson = valueJson, updatedAt = System.currentTimeMillis()),
            )
        }
    }

    override suspend fun listDeviceSettings(): List<LocalDeviceSettingEntity> = io { db.settingsDao().listDevice() }

    // ------------------------------------------------------------ 连接档案（本地，不同步）

    override fun observeConnectionProfiles(): Flow<List<LocalConnectionProfileEntity>> =
        db.connectionProfileDao().observeAll()

    override suspend fun listConnectionProfiles(): List<LocalConnectionProfileEntity> =
        io { db.connectionProfileDao().listAll() }

    override suspend fun getConnectionProfile(id: String): LocalConnectionProfileEntity? =
        io { db.connectionProfileDao().getById(id) }

    override suspend fun upsertConnectionProfile(entity: LocalConnectionProfileEntity) {
        val now = System.currentTimeMillis()
        io {
            val existing = db.connectionProfileDao().getById(entity.id)
            if (existing == null) {
                db.connectionProfileDao().upsert(
                    entity.copy(createdAt = if (entity.createdAt == 0L) now else entity.createdAt, updatedAt = now),
                )
            } else {
                // 只写 public 字段：`secret_ref` 必须由 setConnectionSecret/clearConnectionSecret 单独事务维护，
                // 因此任何 public 更新都不可能用空值覆盖已存在的 secret（S3-06 硬要求）。
                db.connectionProfileDao().updatePublicFields(
                    id = entity.id,
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
        }
    }

    override suspend fun setConnectionSecret(profileId: String, secretRef: String?) {
        io {
            db.connectionProfileDao().updateSecretRef(
                id = profileId,
                ref = secretRef,
                updatedAt = System.currentTimeMillis(),
            )
        }
    }

    override suspend fun deleteConnectionProfile(id: String) {
        io { db.connectionProfileDao().delete(id) }
    }

    // ------------------------------------------------------------ 同步元数据 / 远端应用

    override suspend fun getHead(entityType: String, entityId: String): EntityHeadEntity? =
        io { db.syncMetaDao().getHead(entityType, entityId) }

    override suspend fun headCount(): Int = io { db.syncMetaDao().headCount() }

    override suspend fun isTombstoned(entityType: String, entityId: String?): Boolean {
        if (entityId == null) return false
        return io { db.syncMetaDao().getHead(entityType, entityId)?.deleted == true }
    }

    override suspend fun journalCount(origin: String): Int = io { db.syncMetaDao().countByOrigin(origin) }

    override suspend fun journalChangeCount(): Int = io { db.syncMetaDao().changeCount() }

    override suspend fun changesAfter(cursor: Long, limit: Int): List<ChangeLogEntity> =
        io { db.syncMetaDao().changesAfter(cursor, limit) }

    override suspend fun maxChangeSeq(): Long = io { db.syncMetaDao().maxChangeSeq() }

    /**
     * 远端应用：写入业务行 + head + change_log，`origin = remote`，不推进本机 dot。
     * 调用方（阶段 7 Sync Core）负责冲突判定；本方法只做落库。
     */
    override suspend fun <R> applyRemote(
        entityType: String,
        entityId: String,
        payload: () -> Map<String, Any?>,
        business: suspend () -> R,
        /** 远端信封里的 parentId 必须原样落到本机 head/journal，否则 §6.3 的跨实体不变量在应用端丢失。 */
        parentId: String?,
    ): R = withJournal(entityType, entityId, Origin.Remote, parentId = parentId, payload = payload, business = business)

    override suspend fun listTombstones(): List<EntityHeadEntity> = io { db.syncMetaDao().listTombstones() }

    override suspend fun listReceipts(limit: Int): List<SyncReceiptEntity> = io { db.syncMetaDao().listReceipts(limit) }

    override suspend fun recordReceipt(receipt: SyncReceiptEntity) {
        io { db.syncMetaDao().upsertReceipt(receipt) }
    }

    override suspend fun openConflictCount(): Int = io { db.syncMetaDao().openConflictCount() }

    override suspend fun recordConflict(conflict: ConflictEntity) {
        io { db.syncMetaDao().upsertConflict(conflict) }
    }

    override suspend fun listOpenConflicts(): List<ConflictEntity> = io { db.syncMetaDao().listOpenConflicts() }

    override suspend fun resolveConflict(id: String, resolutionJson: String) {
        io { db.syncMetaDao().resolveConflict(id, resolutionJson) }
    }

    // ------------------------------------------------------------ 迁移导入

    /**
     * S3-02 导入写路径：单事务内导入一条旧缓存投影。
     * - 保留旧 ID；`importedFrom = legacy_companion_cache` 由调用方写入实体。
     * - 若提供 [genesisContentHash] 且与本地重算的业务哈希相同，视为与 PC 投影同源，
     *   `origin = migration` 且**不生成新的并发版本**（总方案 §9.1）。
     * - 否则按本地新内容的 dot 走 `origin = local`。
     */
    override suspend fun importFromLegacy(
        entityType: String,
        entityId: String,
        genesisContentHash: String?,
        payload: () -> Map<String, Any?>,
        business: suspend () -> Unit,
    ) {
        val computed = MigrationIdentity.contentHash(payload())
        val sameHash = MigrationIdentity.isSameProjection(genesisContentHash, computed)
        withJournal(
            entityType = entityType,
            entityId = entityId,
            origin = if (sameHash) Origin.Migration else Origin.Local,
            payload = payload,
            business = business,
        )
    }
    override suspend fun setMigrationGenesisId(genesisId: String) {
        io {
            val dao = db.deviceDao()
            val state = dao.get() ?: LocalDeviceStateEntity(
                deviceId = deviceId,
                nextCounterText = "1",
                updatedAt = System.currentTimeMillis(),
            )
            dao.upsert(state.copy(migrationGenesisId = genesisId, updatedAt = System.currentTimeMillis()))
        }
    }

    override suspend fun migrationGenesisId(): String? = io { db.deviceDao().get()?.migrationGenesisId }

    override suspend fun initDeviceState() {
        io {
            val dao = db.deviceDao()
            val existing = dao.get()
            val now = System.currentTimeMillis()
            if (existing == null) {
                dao.upsert(
                    LocalDeviceStateEntity(deviceId = deviceId, nextCounterText = "1", updatedAt = now),
                )
            } else if (existing.deviceId != deviceId) {
                // 设备身份变化（重装/恢复）时更新归属，但**不复用** counter（恢复备份产生新身份）。
                dao.upsert(existing.copy(deviceId = deviceId, updatedAt = now))
            } else if (existing.nextCounterText.toULongOrNull() == null) {
                dao.upsert(existing.copy(nextCounterText = "1", updatedAt = now))
            }
        }
    }

    override suspend fun localCounts(): LocalCounts = io {
        LocalCounts(
            characters = db.characterDao().count(),
            lorebooks = db.lorebookDao().count(),
            presets = db.presetDao().count(),
            personas = db.personaDao().count(),
            sessions = db.sessionDao().count(),
            messages = db.messageDao().count(),
            usageRecords = db.usageDao().count(),
            connectionProfiles = db.connectionProfileDao().count(),
            heads = db.syncMetaDao().headCount(),
            changeLogEntries = db.syncMetaDao().changeCount(),
            mappingTemplates = db.lorebookMappingTemplateDao().count(),
            // 该表无 count 查询（每设备一行，量级 = 参与同步的设备数），listAll 足够。
            usageClearMarkers = db.usageClearMarkerDao().listAll().size,
        )
    }

    private suspend fun <R> io(block: suspend () -> R): R = withContext(Dispatchers.IO) { block() }

    // ------------------------------------------------------------ 迁移导入落库

    override suspend fun importCharacter(entity: LocalCharacterEntity) {
        db.characterDao().upsert(entity)
    }

    override suspend fun importSession(entity: LocalSessionEntity) {
        db.sessionDao().upsert(entity)
    }

    override suspend fun importMessage(entity: LocalMessageEntity) {
        db.messageDao().upsert(entity)
    }

    // ------------------------------------------------------------ 便捷写入（阶段 3 契约测试与简单调用点）

    /** 便捷：新建/更新角色并记 journal（等价于 [putCharacter] 的简写参数形式）。 */
    suspend fun putCharacter(
        entityId: String,
        name: String,
        description: String = "",
        personality: String = "",
    ) {
        val now = System.currentTimeMillis()
        putCharacter(
            LocalCharacterEntity(
                id = entityId,
                name = name,
                description = description,
                personality = personality,
                createdAt = now,
                updatedAt = now,
            ),
        )
    }

    suspend fun putPersona(
        entityId: String,
        name: String,
        description: String = "",
        persona: String = "",
    ) {
        val now = System.currentTimeMillis()
        putPersona(
            LocalPersonaEntity(
                id = entityId,
                name = name,
                description = description,
                persona = persona,
                createdAt = now,
                updatedAt = now,
            ),
        )
    }

    /** 便捷：写连接档案 public 字段（secret 由 ConnectionProfileRepository 单独事务维护）。 */
    suspend fun putConnectionProfile(
        entityId: String,
        provider: String,
        baseUrl: String,
        model: String,
    ) {
        upsertConnectionProfile(
            LocalConnectionProfileEntity(
                id = entityId,
                provider = provider,
                baseUrl = baseUrl,
                model = model,
                createdAt = 0,
                updatedAt = 0,
            ),
        )
    }

    /** 全部 head 的 (entityType, entityId) 列表（阶段 7 plan 使用）。 */
    suspend fun listHeads(): List<Pair<String, String>> = io {
        db.syncMetaDao().listAllHeads().map { it.entityType to it.entityId }
    }

    // ------------------------------------------------------------ 契约测试专用写路径
    // 只服务 shared/contracts/fixtures/repository/behavior-table.json 的 Kotlin 执行器；
    // 业务代码不得调用（entityType 直接来自 fixture，任意类型只落 contract_objects 表）。

    suspend fun contractPut(entityType: String, entityId: String, payload: Map<String, Any?>) {
        // 与 contractApplyRemote 口径一致：payload 只落通用对象表，
        // 不经过任何业务表（behavior-table 的 payload 形状与业务表 schema 无关）。
        MigrationIdentity.requireValidEntityId(entityId)
        val json = CanonicalJson.encode(payload)
        withJournal(entityType, entityId, Origin.Local, payload = { payload }) {
            db.contractObjectDao().upsert(
                com.qingyu.companion.local.db.ContractObjectEntity(
                    id = entityId,
                    payloadJson = json,
                    updatedAt = System.currentTimeMillis(),
                ),
            )
        }
    }

    suspend fun contractTombstone(entityType: String, entityId: String) {
        db.withTransaction {
            db.contractObjectDao().delete(entityId)
            tombstoneInTx(entityType, entityId)
        }
    }

    suspend fun contractApplyRemote(
        entityType: String,
        entityId: String,
        payload: Map<String, Any?>,
        deviceId: String,
        counter: String,
    ) {
        MigrationIdentity.requireValidEntityId(entityId)
        val json = MigrationIdentity.requirePayloadWithinLimit(payload)
        db.withTransaction {
            val version = mapOf(deviceId to counter)
            val hash = "sha256:" + sha256Hex(json)
            val now = System.currentTimeMillis()
            db.contractObjectDao().upsert(
                com.qingyu.companion.local.db.ContractObjectEntity(
                    id = entityId,
                    payloadJson = json,
                    updatedAt = now,
                ),
            )
            db.syncMetaDao().upsertHead(
                EntityHeadEntity(
                    entityType = entityType,
                    entityId = entityId,
                    versionJson = VersionVectorJson.encode(version),
                    hash = hash,
                    deleted = false,
                    updatedAt = now,
                ),
            )
            db.syncMetaDao().insertChange(
                ChangeLogEntity(
                    dotDevice = deviceId,
                    dotCounter = counter,
                    entityType = entityType,
                    entityId = entityId,
                    envelopeJson = LocalEnvelope(
                        entityType = entityType,
                        entityId = entityId,
                        payload = payload,
                        deviceId = deviceId,
                        counter = counter,
                        version = version,
                        updatedAt = now,
                        contentHash = hash,
                    ).toJson(),
                    origin = Origin.Remote.wire,
                    recordedAt = now,
                ),
            )
        }
    }

    suspend fun contractRead(entityId: String): String? = io { db.contractObjectDao().get(entityId)?.payloadJson }

    /** 契约命名空间内的 change_log 页（按 entityType 过滤后再截断）。 */
    suspend fun contractChangesAfter(cursor: Long, limit: Int): List<ChangeLogEntity> = io {
        db.syncMetaDao().changesAfter(cursor, Int.MAX_VALUE)
            .filter { it.entityType in CONTRACT_ENTITY_TYPES }
            .take(limit)
    }

    suspend fun contractReset() {
        io {
            db.contractObjectDao().clear()
        }
    }

    /** 用于契约测试：按 entityType 清空 head/journal 命名空间。 */
    suspend fun contractClearNamespace(namespace: String) {
        io {
            db.contractObjectDao().clearJournal(namespace)
            db.contractObjectDao().clearHeads(namespace)
        }
    }
}

enum class Origin(val wire: String) {
    Local("local"),
    Remote("remote"),
    Migration("migration"),
}

/** 契约测试（behavior-table）使用的 entityType 命名空间。 */
val CONTRACT_ENTITY_TYPES: List<String> = listOf("persona", "character", "settings_public")

/** `IN (:ids)` 每删一条就占一个绑定参数；SQLite 默认变量上限 999，留出余量分批。 */
private const val MAX_DELETE_BATCH = 500

/**
 * 版本向量的 JSON 编解码。
 * counter 是**十进制字符串**，任何路径都不得经过 Long/Int（总方案 §6.2）。
 */
object VersionVectorJson {
    fun encode(vector: Map<String, String>): String =
        CanonicalJson.encode(vector.mapValues { it.value })

    fun decode(json: String): Map<String, String> {
        val trimmed = json.trim()
        if (trimmed.isEmpty() || trimmed == "{}" || trimmed == "null") return emptyMap()
        val inner = trimmed.removePrefix("{").removeSuffix("}")
        if (inner.isBlank()) return emptyMap()
        val result = mutableMapOf<String, String>()
        // 版本向量只包含 (deviceId, counter) 的平坦字符串映射，不需要通用 JSON 解析器。
        var i = 0
        while (i < inner.length) {
            while (i < inner.length && (inner[i] == ',' || inner[i].isWhitespace())) i++
            if (i >= inner.length) break
            if (inner[i] != '"') throw IllegalArgumentException("版本向量格式非法: $json")
            val keyStart = ++i
            while (i < inner.length && inner[i] != '"') i++
            val key = inner.substring(keyStart, i)
            i++
            while (i < inner.length && (inner[i] == ':' || inner[i].isWhitespace())) i++
            if (i >= inner.length || inner[i] != '"') throw IllegalArgumentException("版本向量格式非法: $json")
            val valueStart = ++i
            while (i < inner.length && inner[i] != '"') i++
            val value = inner.substring(valueStart, i)
            i++
            result[key] = value
        }
        return result
    }
}
