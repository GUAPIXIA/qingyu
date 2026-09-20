package com.qingyu.companion.local.domain

import com.qingyu.companion.local.db.ChangeLogEntity
import com.qingyu.companion.local.db.ConflictEntity
import com.qingyu.companion.local.db.EntityHeadEntity
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalConnectionProfileEntity
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
import com.qingyu.companion.local.db.SyncReceiptEntity
import com.qingyu.companion.local.db.UsageAggregateRow
import kotlinx.coroutines.flow.Flow

/** 本地库计数快照（迁移向导与诊断使用）。 */
data class LocalCounts(
    val characters: Int = 0,
    val lorebooks: Int = 0,
    val presets: Int = 0,
    val personas: Int = 0,
    val sessions: Int = 0,
    val messages: Int = 0,
    val usageRecords: Int = 0,
    val connectionProfiles: Int = 0,
    val heads: Int = 0,
    val changeLogEntries: Int = 0,
    /** S5-02：映射模板是同步实体，恢复/迁移的 counts 校验必须看得见它。 */
    val mappingTemplates: Int = 0,
    /** S5-07：用量清理游标（每设备一行）；漏计会让 Backup V3 的 counts 校验假通过。 */
    val usageClearMarkers: Int = 0,
) {
    val isEmpty: Boolean
        get() = characters == 0 && sessions == 0 && messages == 0 && lorebooks == 0 && presets == 0 &&
            personas == 0 && usageRecords == 0
}

/**
 * 阶段 3 S3-03：本地权威数据入口（唯一允许写 `qingyu-local.db` 的抽象）。
 *
 * 分层规则（总方案 §5.1）：
 * - UI 只能经 ViewModel/use case 调用本接口，不能直接触碰 DAO 或 Room。
 * - 每次本地业务写都会在同一逻辑事务中生成 change journal 与 entity head。
 * - `Flow` 只从本层向上暴露。
 */
/**
 * 阶段 4 S4-05：记忆条件写入（CAS）结果。
 *
 * `applied = false` 表示磁盘版本已被并发推进（生成期间用户编辑了历史），
 * 调用方必须**丢弃本次摘要**并上报 `stale_version`，不得重试覆盖。
 */
data class MemoryCasResult(
    val applied: Boolean,
    /** 应用后的版本（applied=true）或磁盘上的当前版本（applied=false） */
    val currentVersion: Long,
)

/**
 * 阶段 4 S4-04：用量区间汇总。
 *
 * 与 PC `getSummary` 同口径：都是**可见字符**的合计与记录条数，而不是 token——
 * token 依赖端点是否上报 usage，字符数始终可得。
 */
data class UsageStats(
    val totalInput: Long,
    val totalOutput: Long,
    val totalChars: Long,
    val count: Int,
)

interface LocalStore {

    fun deviceId(): String

    /**
     * 在**单个数据库事务**内执行 [block]，用于 Backup V3 恢复这类一次改动跨多实体的批量写
     * （方案 §S5-08：先全包校验和预览，再 checkpoint 和原子应用）。
     *
     * 为什么暴露在接口上：恢复要把角色/世界书/预设/人设/正则/快捷回复/会话一起写回。
     * 每个 put 各自提交会留下「预设已换、会话还指着旧预设」的中间态，
     * 崩溃后再也分不清哪些行是这次恢复做的。
     */
    suspend fun <R> inTransaction(block: suspend () -> R): R

    // ---- 内容 ----
    fun observeCharacters(): Flow<List<LocalCharacterEntity>>
    suspend fun listCharacters(): List<LocalCharacterEntity>
    suspend fun getCharacter(id: String): LocalCharacterEntity?

    /**
     * S5-01 角色列表：关键字、排序、分页**一次下推到 SQL**。
     *
     * 方案 §2 明确「大型列表分页/搜索在数据库层执行」；压力口径是 500 角色，
     * 在内存里 filter+sort 会把整表读进 UI 层，滚动时反复触发。
     * [sortBy] 是 UI token，必须先经 [CharacterSortColumn.resolve] 收敛成白名单值。
     */
    suspend fun searchCharacters(query: String, sortBy: String, limit: Int, offset: Int): List<LocalCharacterEntity>

    /** S5-01 分页总数：与 [searchCharacters] 同口径，否则页码与内容会对不上。 */
    suspend fun countCharacters(query: String): Int
    suspend fun putCharacter(entity: LocalCharacterEntity)

    /**
     * S5-01 删除影响范围。
     *
     * `characters` 恒为 0（角色不被别的角色引用），会话数在 [BindingImpact.sessions]；
     * 消息条数走 [characterMessageCount]，因为确认框要分开说「N 个会话 / M 条消息」。
     */
    suspend fun characterBindingImpact(id: String): BindingImpact

    /** S5-01：该角色名下的消息条数（会话可被删除，消息按冗余 characterId 统计）。 */
    suspend fun characterMessageCount(id: String): Int

    /**
     * S5-01/S5-06 删除角色：同一事务内连带清理**角色级快捷回复**。
     *
     * 快捷回复集合按 `character_id` 绑定，没有外键级联（PC 是单文件整库），
     * 只删角色行会留下无人认领的集合（方案「不得产生可见孤儿数据」）。
     */
    suspend fun deleteCharacter(id: String)

    fun observeLorebooks(): Flow<List<LocalLorebookEntity>>
    suspend fun listLorebooks(): List<LocalLorebookEntity>

    /** S5-02 §2：世界书列表的关键字 + 分页在 SQL 里完成（与 searchCharacters 同形）。 */
    suspend fun searchLorebooks(query: String, limit: Int, offset: Int): List<LocalLorebookEntity>

    /** 与 searchLorebooks 同口径的总数：分页页码要的是它，不是当前页长度。 */
    suspend fun countLorebooks(query: String): Int
    suspend fun listLorebookIds(): List<String>

    /** S5-02 编辑器入口：按 id 读取单本世界书（列表页只给 id）。 */
    suspend fun getLorebook(id: String): LocalLorebookEntity?
    suspend fun putLorebook(entity: LocalLorebookEntity)
    suspend fun deleteLorebook(id: String)

    /**
     * S5-02：删除被角色/会话绑定的世界书，先解绑再删。
     * 与 [deletePresetUnbindingReferences] 同一口径：解绑本身是业务写，必须进 journal。
     */
    suspend fun deleteLorebookUnbindingReferences(id: String): BindingImpact

    /** S5-02：删除世界书前显示的影响范围（绑定它的角色数与会话数）。 */
    suspend fun lorebookBindingImpact(id: String): BindingImpact

    fun observePresets(): Flow<List<LocalPresetEntity>>
    suspend fun listPresets(): List<LocalPresetEntity>
    suspend fun listPresetIds(): List<String>

    /** S5-03 编辑器入口：按 id 读取单个预设。 */
    suspend fun getPreset(id: String): LocalPresetEntity?

    /** S5-03 内建/用户分区：内建预设只读、不可删除，必须与用户预设分列展示。 */
    suspend fun listPresetSection(builtin: Boolean): List<LocalPresetEntity>

    /** S5-03 §2：预设分区的关键字 + 分页下推 SQL（1k 预设不整表进内存）。 */
    suspend fun searchPresets(
        builtin: Boolean,
        query: String,
        limit: Int,
        offset: Int,
    ): List<LocalPresetEntity>

    /** 与 [searchPresets] 同口径的总数。 */
    suspend fun countPresets(builtin: Boolean, query: String): Int
    suspend fun putPreset(entity: LocalPresetEntity)
    suspend fun deletePreset(id: String)

    /** S5-03：删除被引用预设的影响范围（引用它的角色数与会话数）。 */
    suspend fun presetBindingImpact(id: String): BindingImpact

    /** S5-03「显示影响并安全解绑」：引用置空与预设删除同事务，返回删除前的影响范围。 */
    suspend fun deletePresetUnbindingReferences(id: String): BindingImpact

    fun observePersonas(): Flow<List<LocalPersonaEntity>>
    suspend fun listPersonas(): List<LocalPersonaEntity>

    /** S5-04 编辑器入口：按 id 读取单个人设。 */
    suspend fun getPersona(id: String): LocalPersonaEntity?
    suspend fun putPersona(entity: LocalPersonaEntity)
    suspend fun deletePersona(id: String)

    /** S5-04：删除人设的影响范围（默认人设与会话覆盖都会指向它）。 */
    suspend fun personaBindingImpact(id: String): BindingImpact

    /** S5-04「删除引用处理」：解绑与删除同事务，避免会话指向已不存在的人设。 */
    suspend fun deletePersonaUnbindingReferences(id: String): BindingImpact

    fun observeRegexRules(): Flow<List<LocalRegexRuleEntity>>
    suspend fun listRegexRules(): List<LocalRegexRuleEntity>

    /** S5-05 编辑器入口：按 id 读取单条规则。 */
    suspend fun getRegexRule(id: String): LocalRegexRuleEntity?
    suspend fun putRegexRule(entity: LocalRegexRuleEntity)
    suspend fun deleteRegexRule(id: String)

    /**
     * S5-05 排序：按给定顺序重写 `sortIndex`。
     *
     * 正则按 `sortIndex` **链式**应用（前一条的输出是后一条的输入），顺序本身是业务语义，
     * 因此每条改序都必须单独进 journal，否则对端看到旧顺序会产出不同文本。
     */
    suspend fun reorderRegexRules(orderedIds: List<String>)

    fun observeQuickReplySets(): Flow<List<LocalQuickReplySetEntity>>
    suspend fun listQuickReplySets(): List<LocalQuickReplySetEntity>

    /** S5-06 编辑器入口：按 id 读取单个集合。 */
    suspend fun getQuickReplySet(id: String): LocalQuickReplySetEntity?

    /** S5-06「全局与角色级集合」：`characterId == null` 的集合才是全局的。 */
    suspend fun listGlobalQuickReplySets(): List<LocalQuickReplySetEntity>

    /** S5-06：某角色名下的集合（进入角色页时只读这一部分）。 */
    suspend fun listCharacterQuickReplySets(characterId: String): List<LocalQuickReplySetEntity>
    suspend fun putQuickReplySet(entity: LocalQuickReplySetEntity)
    suspend fun deleteQuickReplySet(id: String)

    /**
     * S5-06/S5-01：清空某角色的快捷回复（角色删除时连带调用）。
     *
     * 与 [deleteQuickReplySet] 一样要重算 `quick-replies-root` 的整库 journal，
     * 并对该角色补一条 `qr-char-<id>` tombstone——只删行不记账，长期离线设备会把它带回。
     */
    suspend fun deleteCharacterQuickReplies(characterId: String)

    // ---- 世界书映射模板（S5-02，同步实体） ----

    /** 模板列表（导入向导的下拉数据源）。 */
    fun observeLorebookMappingTemplates(): Flow<List<LocalLorebookMappingTemplateEntity>>
    suspend fun listLorebookMappingTemplates(): List<LocalLorebookMappingTemplateEntity>
    suspend fun getLorebookMappingTemplate(id: String): LocalLorebookMappingTemplateEntity?

    /** 写入前强制经 [LorebookMappingTemplateDsl] 白名单校验：模板是用户导入文件，不得夹带脚本。 */
    suspend fun putLorebookMappingTemplate(entity: LocalLorebookMappingTemplateEntity)
    suspend fun deleteLorebookMappingTemplate(id: String)

    // ---- 群组（阶段 6） ----
    fun observeGroups(): Flow<List<LocalGroupEntity>>
    suspend fun listGroups(): List<LocalGroupEntity>
    suspend fun putGroup(entity: LocalGroupEntity)
    suspend fun deleteGroup(id: String)

    // ---- 会话 / 消息 ----
    fun observeSessions(): Flow<List<LocalSessionEntity>>
    suspend fun listSessions(): List<LocalSessionEntity>
    suspend fun getSession(id: String): LocalSessionEntity?
    suspend fun putSession(entity: LocalSessionEntity)
    suspend fun deleteSession(id: String)

    fun observeMessages(sessionId: String): Flow<List<LocalMessageEntity>>
    suspend fun listMessages(sessionId: String): List<LocalMessageEntity>
    suspend fun appendMessage(entity: LocalMessageEntity)
    suspend fun updateMessage(entity: LocalMessageEntity)
    suspend fun deleteMessage(id: String, sessionId: String)

    // ---- 记忆 / 用量 / 媒体 ----
    suspend fun getMemoryState(sessionId: String): LocalMemoryStateEntity?
    suspend fun putMemoryState(entity: LocalMemoryStateEntity)

    /**
     * 阶段 4 S4-05：**条件写入记忆**（CAS）。只有磁盘版本仍等于 [expectedVersion] 才应用，
     * 否则返回 `applied = false` 且**磁盘保持不变**（调用方据此上报 `stale_version`）。
     *
     * 存在记忆行时用单条条件 UPDATE；不存在时以 [entity] 作为初始行写入
     * （仅当 [expectedVersion] == 0，否则视为版本已过期）。
     */
    suspend fun applyMemoryStateIfVersion(
        sessionId: String,
        expectedVersion: Long,
        entity: LocalMemoryStateEntity,
    ): MemoryCasResult

    /** 推进历史修订号（消息编辑/删除/清空），使基于旧历史的派生记忆过期。 */
    suspend fun bumpMemoryHistoryRevision(sessionId: String): Boolean
    suspend fun listMemoryFacts(sessionId: String): List<LocalMemoryFactEntity>
    suspend fun putMemoryFact(entity: LocalMemoryFactEntity)
    suspend fun deleteMemoryFact(id: String)

    /** 事件 ID 去重并集；已存在时返回 false 且不新增 journal。 */
    suspend fun recordUsage(entity: LocalUsageRecordEntity): Boolean
    suspend fun listUsage(limit: Int): List<LocalUsageRecordEntity>
    suspend fun usageTotals(since: Long, sessionId: String? = null): Pair<Long, Long>

    /** S4-04 用量诊断：区间内的字符与条数汇总（与 PC `getSummary` 同口径）。 */
    suspend fun usageStats(since: Long, until: Long): UsageStats

    /** 区间内的用量记录（按时间倒序）。 */
    suspend fun listUsageInRange(since: Long, until: Long, limit: Int): List<LocalUsageRecordEntity>

    /**
     * S5-07 维度聚合（方案：按模型、角色、日期和成功/失败分类）。
     *
     * 维度**不能**拼进 SQL：SQLite 的绑定参数只能出现在值的位置，`GROUP BY :dimension`
     * 会按常量分组、每组一条，得到静默错误的统计。因此实现侧按 [UsageDimension] 分支
     * 调用各自的固定查询，替身用同一套分支口径，两侧结果必须一致。
     * [taskType] 传空串表示不限任务类型（否则按 `main`/`memory`/… 过滤）。
     */
    suspend fun usageAggregate(
        dimension: UsageDimension,
        since: Long,
        until: Long,
        taskType: String,
    ): List<UsageAggregateRow>

    /**
     * S5-07 清空用量（总方案 §6.3 `usage_clear_marker` 行）。
     *
     * 只清除被 [beforeVersionVector] **因果支配**的记录：并发期间新写入、或该设备
     * 不在游标里的记录一律保留。「按时间删全部」会把别人刚产生的事件抹掉，
     * 而对端的 journal 里那条事件还在——这就是删除复活的根因。
     */
    suspend fun clearUsage(beforeVersionVector: Map<String, String>): UsageClearResult

    /** S5-07/S5-08：读取某设备的清理游标（Backup V3 的 counts 与恢复校验需要）。 */
    suspend fun usageClearMarker(deviceId: String): LocalUsageClearMarkerEntity?

    /**
     * S5-08：落一条**来自备份/对端**的清理游标，并照常写 journal。
     *
     * 只允许写别的设备的行键：本机自己的游标必须由 `clearUsage` 产生——那条路径带因果判定
     * （只删被 `clearedThrough` 支配的记录）。让备份直接盖掉本机游标等于伪造一次本机清理，
     * 会把「并发产生的新用量」一起抹掉（§6.3 明确要求那些记录保留）。
     */
    suspend fun putUsageClearMarker(entity: LocalUsageClearMarkerEntity)

    companion object {
        /**
         * 用量记录保留上限。**必须与 PC `electron/services/usage.ts` 的 `MAX_RECORDS` 同数**：
         * 两端保留不同的记录集，等于同一空间里两台设备看到不同的用量历史。
         */
        const val MAX_USAGE_RECORDS = 10_000
    }

    /**
     * 全部设备的清理游标。Backup V3（S5-08）要把它整份打进
     * `config/usageClearMarkers.json`：只打本机那一条会让恢复端丢掉
     * 「对端已经清到哪」这个事实，之后同步又会把已清记录复活。
     */
    suspend fun listUsageClearMarkers(): List<LocalUsageClearMarkerEntity>

    suspend fun putMediaManifest(entity: LocalMediaManifestEntity)
    suspend fun listMediaManifests(ownerType: String, ownerId: String): List<LocalMediaManifestEntity>

    // ---- 设置分区 ----
    fun observePublicSettings(): Flow<List<LocalPublicSettingEntity>>
    suspend fun listPublicSettings(): List<LocalPublicSettingEntity>

    /**
     * S5-07：写一条公开设置。存储仍是 (section, key) 行式，但 **journal 以整份设置为一个实体**。
     *
     * PC 把 settings_public 记成单实体 `settings-public`
     * （`electron/domain/bootstrapScanners.ts:136`、`electron/ipc/settings.ts:settingsPublicPayload`）。
     * 按键记账会让两端对同一份设置使用不同实体 id 与不同粒度，首次同步即产生伪冲突。
     */
    suspend fun putPublicSetting(section: String, key: String, valueJson: String)
    fun observeDeviceSettings(): Flow<List<LocalDeviceSettingEntity>>
    suspend fun listDeviceSettings(): List<LocalDeviceSettingEntity>
    suspend fun putDeviceSetting(key: String, valueJson: String)

    // ---- 连接档案（设备本地，不进入同步 envelope） ----
    fun observeConnectionProfiles(): Flow<List<LocalConnectionProfileEntity>>
    suspend fun listConnectionProfiles(): List<LocalConnectionProfileEntity>
    suspend fun getConnectionProfile(id: String): LocalConnectionProfileEntity?
    suspend fun upsertConnectionProfile(entity: LocalConnectionProfileEntity)
    suspend fun setConnectionSecret(profileId: String, secretRef: String?)
    suspend fun deleteConnectionProfile(id: String)

    // ---- 同步元数据 ----
    suspend fun getHead(entityType: String, entityId: String): EntityHeadEntity?
    suspend fun headCount(): Int
    suspend fun isTombstoned(entityType: String, entityId: String?): Boolean
    suspend fun journalCount(origin: String): Int
    suspend fun journalChangeCount(): Int
    suspend fun changesAfter(cursor: Long, limit: Int): List<ChangeLogEntity>
    suspend fun maxChangeSeq(): Long
    suspend fun listTombstones(): List<EntityHeadEntity>
    suspend fun listReceipts(limit: Int): List<SyncReceiptEntity>
    suspend fun recordReceipt(receipt: SyncReceiptEntity)
    suspend fun openConflictCount(): Int
    suspend fun recordConflict(conflict: ConflictEntity)
    suspend fun listOpenConflicts(): List<ConflictEntity>
    suspend fun resolveConflict(id: String, resolutionJson: String)

    /** 远端应用（阶段 7）：`origin = remote`，不推进本机 dot。 */
    suspend fun <R> applyRemote(
        entityType: String,
        entityId: String,
        payload: () -> Map<String, Any?>,
        business: suspend () -> R,
    ): R

    // ---- 迁移 / 设备 ----
    suspend fun importFromLegacy(
        entityType: String,
        entityId: String,
        genesisContentHash: String?,
        payload: () -> Map<String, Any?>,
        business: suspend () -> Unit,
    )

    suspend fun setMigrationGenesisId(genesisId: String)
    suspend fun migrationGenesisId(): String?
    suspend fun initDeviceState()
    suspend fun localCounts(): LocalCounts

    // ---- 迁移导入（只允许由 importFromLegacy 在事务内调用） ----

    /** 直接落库角色行，不写 journal；journal 由 [importFromLegacy] 负责。 */
    suspend fun importCharacter(entity: LocalCharacterEntity)

    suspend fun importSession(entity: LocalSessionEntity)

    suspend fun importMessage(entity: LocalMessageEntity)
}
