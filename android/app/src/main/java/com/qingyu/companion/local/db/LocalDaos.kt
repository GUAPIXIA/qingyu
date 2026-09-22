package com.qingyu.companion.local.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Upsert
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

/**
 * 阶段 3 S3-01/S3-03 DAO 集合。
 *
 * 边界规则（阶段 3 文档 §2 S3-03）：
 * - DAO 不暴露给 UI；业务一致性操作只允许经 Repository 的 `@Transaction` 方法组合。
 * - 业务表 + `entity_heads` + `change_log` 必须在同一逻辑事务中写入。
 * - Flow 只从 Repository 暴露给 ViewModel。
 * - counter 一律使用十进制字符串（UInt64），任何路径都不得经过 `Long`/`INTEGER`。
 */

@Dao
interface LocalDeviceDao {
    @Query("SELECT * FROM local_device_state WHERE id = 1")
    suspend fun get(): LocalDeviceStateEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(state: LocalDeviceStateEntity)

    /**
     * 分配当前设备的下一个 counter。
     * 必须在 Repository 的事务内调用；[nextCounterText] 已经自增，返回值为本次分配值。
     */
    @Transaction
    suspend fun allocateCounter(): Pair<String, String> {
        val state = get() ?: LocalDeviceStateEntity(
            deviceId = "",
            nextCounterText = "1",
            updatedAt = System.currentTimeMillis(),
        )
        val current = state.nextCounterText.toULongOrNull() ?: 1uL
        upsert(
            state.copy(
                nextCounterText = (current + 1uL).toString(),
                updatedAt = System.currentTimeMillis(),
            ),
        )
        return state.deviceId to current.toString()
    }
}

// ---------------------------------------------------------------- 内容 DAO

/**
 * 阶段 5 S5-01：列表的搜索/排序/分页全部下推到 SQL（方案 §2「大型列表分页/搜索在数据库层执行」）。
 *
 * 为什么用 `LIKE` 而不是 FTS：压力口径是 500 角色（方案 §3），`name` 已有索引，
 * 而 FTS5 需要虚表 + 触发器维护，收益不抵复杂度。角色名搜索是可接受的全表扫。
 */
@Dao
interface LocalCharacterDao {
    @Query("SELECT * FROM local_characters ORDER BY name COLLATE NOCASE, id")
    fun observeAll(): Flow<List<LocalCharacterEntity>>

    @Query("SELECT * FROM local_characters ORDER BY name COLLATE NOCASE, id")
    suspend fun listAll(): List<LocalCharacterEntity>

    /**
     * 关键字 + 排序 + 分页一次完成。
     * [sortBy] 只允许白名单列名（调用方必须经 [CharacterSortColumn] 收敛，不能透传用户输入）。
     */
    @Query(
        """
        SELECT * FROM local_characters
        WHERE (:query = '' OR name LIKE '%' || :query || '%' OR description LIKE '%' || :query || '%')
        ORDER BY
            CASE WHEN :sortBy = 'name' THEN name END COLLATE NOCASE ASC,
            CASE WHEN :sortBy = 'created' THEN created_at END DESC,
            CASE WHEN :sortBy = 'updated' THEN updated_at END DESC,
            CASE WHEN :sortBy = 'name' THEN NULL ELSE name END COLLATE NOCASE ASC,
            id ASC
        LIMIT :limit OFFSET :offset
        """,
    )
    suspend fun search(query: String, sortBy: String, limit: Int, offset: Int): List<LocalCharacterEntity>

    @Query(
        "SELECT COUNT(*) FROM local_characters " +
            "WHERE (:query = '' OR name LIKE '%' || :query || '%' OR description LIKE '%' || :query || '%')",
    )
    suspend fun countMatching(query: String): Int

    @Query("SELECT * FROM local_characters WHERE id = :id")
    suspend fun getById(id: String): LocalCharacterEntity?

    @Query("SELECT id FROM local_characters")
    suspend fun listIds(): List<String>

    @Query("SELECT COUNT(*) FROM local_characters")
    suspend fun count(): Int

    /** 删除影响范围（方案 §2「删除均显示影响范围」）。 */
    @Query("SELECT COUNT(*) FROM local_sessions WHERE character_id = :characterId")
    suspend fun countSessions(characterId: String): Int

    @Query("SELECT COUNT(*) FROM local_messages WHERE character_id = :characterId")
    suspend fun countMessages(characterId: String): Int

    /**
     * **必须用 @Upsert 而不是 @Insert(REPLACE)**。
     *
     * SQLite 的 `INSERT OR REPLACE` 会先删除冲突行再插入，而本项目显式开启外键
     * （`PRAGMA foreign_keys = ON`）；`local_sessions.character_id` 是 `SET_NULL`，
     * 于是「更新角色卡」会把该角色下所有会话的归属置空。
     * `@Upsert` 生成 `ON CONFLICT DO UPDATE`，不删行、不触发外键动作。
     */
    @Upsert
    suspend fun upsert(entity: LocalCharacterEntity)

    @Query("DELETE FROM local_characters WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface LocalLorebookDao {
    @Query("SELECT * FROM local_lorebooks ORDER BY name COLLATE NOCASE, id")
    fun observeAll(): Flow<List<LocalLorebookEntity>>

    @Query("SELECT * FROM local_lorebooks ORDER BY name COLLATE NOCASE, id")
    suspend fun listAll(): List<LocalLorebookEntity>

    /**
     * 关键字 + 分页一次完成（方案 §2「大型列表分页/搜索在数据库层执行」）。
     *
     * 世界书一本的正文就是 MiB 级：全表 SELECT * 再在 UI 里 filter，等于
     * 「搜一个词要把 100 本完整文档先读进进程，再丢掉大部分」。
     * 匹配列（名称、来源格式）与排序都跟旧内存过滤同口径，改的只是执行位置。
     *
     * 与角色那条 search 一样的已知行为：查询词里的 % 和 _ 是 LIKE 通配符，
     * 不做转义是刻意让两个列表保持同一口径（要改就两边一起改）。
     */
    @Query(
        "SELECT * FROM local_lorebooks " +
            "WHERE (:query = '' OR name LIKE '%' || :query || '%' " +
            "OR imported_from LIKE '%' || :query || '%') " +
            "ORDER BY name COLLATE NOCASE, id LIMIT :limit OFFSET :offset",
    )
    suspend fun search(query: String, limit: Int, offset: Int): List<LocalLorebookEntity>

    /** 与 search 同一个 WHERE：页码与内容必须同口径，否则总数会和列表对不上。 */
    @Query(
        "SELECT COUNT(*) FROM local_lorebooks " +
            "WHERE (:query = '' OR name LIKE '%' || :query || '%' " +
            "OR imported_from LIKE '%' || :query || '%')",
    )
    suspend fun countMatching(query: String): Int

    @Query("SELECT * FROM local_lorebooks WHERE id = :id")
    suspend fun getById(id: String): LocalLorebookEntity?

    @Query("SELECT id FROM local_lorebooks")
    suspend fun listIds(): List<String>

    @Query("SELECT COUNT(*) FROM local_lorebooks")
    suspend fun count(): Int

    /**
     * 被角色绑定的数量（`bound_lorebook_ids_json` 是 JSON 数组列）。
     *
     * 用 `LIKE '%"id"%'` 带引号匹配，避免 id 作为子串误命中其它条目；
     * 压力口径 100 世界书 × 500 角色，可接受。
     */
    @Query(
        "SELECT COUNT(*) FROM local_characters " +
            "WHERE bound_lorebook_ids_json LIKE '%\"' || :lorebookId || '\"%' " +
            "OR lorebook_id = :lorebookId",
    )
    suspend fun countBoundCharacters(lorebookId: String): Int

    @Query(
        "SELECT COUNT(*) FROM local_sessions " +
            "WHERE lorebook_ids_json LIKE '%\"' || :lorebookId || '\"%'",
    )
    suspend fun countBoundSessions(lorebookId: String): Int

    /** S5-02：删除世界书要解绑角色与会话，同样只列出、由 Repository 改写并记 journal。 */
    @Query(
        "SELECT * FROM local_sessions " +
            "WHERE lorebook_ids_json LIKE '%\"' || :lorebookId || '\"%'",
    )
    suspend fun listBoundSessions(lorebookId: String): List<LocalSessionEntity>

    @Query(
        "SELECT * FROM local_characters " +
            "WHERE bound_lorebook_ids_json LIKE '%\"' || :lorebookId || '\"%' " +
            "OR lorebook_id = :lorebookId",
    )
    suspend fun listBoundCharacters(lorebookId: String): List<LocalCharacterEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: LocalLorebookEntity)

    @Query("DELETE FROM local_lorebooks WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface LocalPresetDao {
    @Query("SELECT * FROM local_presets ORDER BY is_default DESC, sort_index, name COLLATE NOCASE, id")
    fun observeAll(): Flow<List<LocalPresetEntity>>

    @Query("SELECT * FROM local_presets ORDER BY is_default DESC, sort_index, name COLLATE NOCASE, id")
    suspend fun listAll(): List<LocalPresetEntity>

    /**
     * 分区 + 关键字 + 分页一次完成（方案 §2「大型列表分页/搜索在数据库层执行」；
     * §3 给这一份的压力口径是 **1k 预设**）。排序与 [listByBuiltin] 逐项一致，
     * 否则「第一页」和「不分页时看到的顺序」会不同，用户翻完一页会发现顺序变了。
     *
     * 已知行为同角色/世界书两条：查询词里的 % 与 _ 是 LIKE 通配符，不做转义。
     */
    @Query(
        "SELECT * FROM local_presets WHERE is_builtin = :builtin " +
            "AND (:query = '' OR name LIKE '%' || :query || '%' OR description LIKE '%' || :query || '%') " +
            "ORDER BY sort_index, name COLLATE NOCASE, id LIMIT :limit OFFSET :offset",
    )
    suspend fun search(builtin: Boolean, query: String, limit: Int, offset: Int): List<LocalPresetEntity>

    /** 与 [search] 同一个 WHERE：页码必须由同一口径的总数算出来。 */
    @Query(
        "SELECT COUNT(*) FROM local_presets WHERE is_builtin = :builtin " +
            "AND (:query = '' OR name LIKE '%' || :query || '%' OR description LIKE '%' || :query || '%')",
    )
    suspend fun countMatching(builtin: Boolean, query: String): Int

    /** 内建/用户分区（方案 S5-03 第一条）。 */
    @Query(
        "SELECT * FROM local_presets WHERE is_builtin = :builtin " +
            "ORDER BY sort_index, name COLLATE NOCASE, id",
    )
    suspend fun listByBuiltin(builtin: Boolean): List<LocalPresetEntity>

    @Query("SELECT * FROM local_presets WHERE id = :id")
    suspend fun getById(id: String): LocalPresetEntity?

    @Query("SELECT id FROM local_presets")
    suspend fun listIds(): List<String>

    @Query("SELECT COUNT(*) FROM local_presets")
    suspend fun count(): Int

    @Query("SELECT COALESCE(MAX(sort_index), 0) FROM local_presets")
    suspend fun maxSortIndex(): Int

    @Query("SELECT COUNT(*) FROM local_sessions WHERE preset_id = :presetId")
    suspend fun countBoundSessions(presetId: String): Int

    @Query("SELECT COUNT(*) FROM local_characters WHERE default_preset_id = :presetId")
    suspend fun countBoundCharacters(presetId: String): Int

    /**
     * 被引用的行要**列出来交给 Repository 改写**，不能用一句裸 `UPDATE ... = NULL`：
     * `character`/`session` 都是同步实体，裸 UPDATE 改了行却不产生 journal，
     * 对端永远看不到这次解绑（违反总方案 §5.1「所有用户数据写入必须经过 Repository
     * 并在同一逻辑事务内生成变更记录」）。这里保留 UPDATE 的唯一用途是**没有**。
     */
    @Query("SELECT * FROM local_sessions WHERE preset_id = :presetId")
    suspend fun listBoundSessions(presetId: String): List<LocalSessionEntity>

    @Query("SELECT * FROM local_characters WHERE default_preset_id = :presetId")
    suspend fun listBoundCharacters(presetId: String): List<LocalCharacterEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: LocalPresetEntity)

    @Query("DELETE FROM local_presets WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface LocalPersonaDao {
    @Query("SELECT * FROM local_personas ORDER BY is_default DESC, name COLLATE NOCASE, id")
    fun observeAll(): Flow<List<LocalPersonaEntity>>

    @Query("SELECT * FROM local_personas ORDER BY is_default DESC, name COLLATE NOCASE, id")
    suspend fun listAll(): List<LocalPersonaEntity>

    @Query("SELECT * FROM local_personas WHERE id = :id")
    suspend fun getById(id: String): LocalPersonaEntity?

    @Query("SELECT COUNT(*) FROM local_personas")
    suspend fun count(): Int

    @Query("SELECT COUNT(*) FROM local_sessions WHERE persona_id = :personaId")
    suspend fun countBoundSessions(personaId: String): Int

    @Query("SELECT COUNT(*) FROM local_characters WHERE default_persona_id = :personaId")
    suspend fun countBoundCharacters(personaId: String): Int

    /** 同 preset：解绑走 Repository 写路径以产生 journal，不裸 UPDATE。 */
    @Query("SELECT * FROM local_sessions WHERE persona_id = :personaId")
    suspend fun listBoundSessions(personaId: String): List<LocalSessionEntity>

    @Query("SELECT * FROM local_characters WHERE default_persona_id = :personaId")
    suspend fun listBoundCharacters(personaId: String): List<LocalCharacterEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: LocalPersonaEntity)

    @Query("DELETE FROM local_personas WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface LocalRegexRuleDao {
    @Query("SELECT * FROM local_regex_rules ORDER BY sort_index, id")
    fun observeAll(): Flow<List<LocalRegexRuleEntity>>

    @Query("SELECT * FROM local_regex_rules ORDER BY sort_index, id")
    suspend fun listAll(): List<LocalRegexRuleEntity>

    @Query("SELECT * FROM local_regex_rules WHERE id = :id")
    suspend fun getById(id: String): LocalRegexRuleEntity?

    @Query("SELECT id FROM local_regex_rules")
    suspend fun listIds(): List<String>

    @Query("SELECT COUNT(*) FROM local_regex_rules")
    suspend fun count(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: LocalRegexRuleEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(entities: List<LocalRegexRuleEntity>)

    @Query("DELETE FROM local_regex_rules WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface LocalQuickReplySetDao {
    @Query("SELECT * FROM local_quick_reply_sets ORDER BY sort_index, id")
    fun observeAll(): Flow<List<LocalQuickReplySetEntity>>

    @Query("SELECT * FROM local_quick_reply_sets ORDER BY sort_index, id")
    suspend fun listAll(): List<LocalQuickReplySetEntity>

    @Query("SELECT * FROM local_quick_reply_sets WHERE character_id IS NULL ORDER BY sort_index, id")
    suspend fun listGlobal(): List<LocalQuickReplySetEntity>

    @Query("SELECT * FROM local_quick_reply_sets WHERE character_id = :characterId ORDER BY sort_index, id")
    suspend fun listForCharacter(characterId: String): List<LocalQuickReplySetEntity>

    @Query("SELECT * FROM local_quick_reply_sets WHERE id = :id")
    suspend fun getById(id: String): LocalQuickReplySetEntity?

    @Query("SELECT id FROM local_quick_reply_sets")
    suspend fun listIds(): List<String>

    @Query("SELECT COUNT(*) FROM local_quick_reply_sets")
    suspend fun count(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: LocalQuickReplySetEntity)

    @Query("DELETE FROM local_quick_reply_sets WHERE id = :id")
    suspend fun delete(id: String)

    /** 角色删除时连带清理其角色级集合（返回被清理的集合 id 供 journal 逐条 tombstone）。 */
    @Query("SELECT id FROM local_quick_reply_sets WHERE character_id = :characterId")
    suspend fun listIdsForCharacter(characterId: String): List<String>
}

// ---------------------------------------------------------------- 阶段 5 新增 DAO

@Dao
interface LocalLorebookMappingTemplateDao {
    @Query("SELECT * FROM local_lorebook_mapping_templates ORDER BY sort_index, name COLLATE NOCASE, id")
    fun observeAll(): Flow<List<LocalLorebookMappingTemplateEntity>>

    @Query("SELECT * FROM local_lorebook_mapping_templates ORDER BY sort_index, name COLLATE NOCASE, id")
    suspend fun listAll(): List<LocalLorebookMappingTemplateEntity>

    @Query("SELECT * FROM local_lorebook_mapping_templates WHERE id = :id")
    suspend fun getById(id: String): LocalLorebookMappingTemplateEntity?

    @Query("SELECT id FROM local_lorebook_mapping_templates")
    suspend fun listIds(): List<String>

    @Query("SELECT COUNT(*) FROM local_lorebook_mapping_templates")
    suspend fun count(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: LocalLorebookMappingTemplateEntity)

    @Query("DELETE FROM local_lorebook_mapping_templates WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface LocalUsageClearMarkerDao {
    @Query("SELECT * FROM local_usage_clear_markers ORDER BY device_id")
    suspend fun listAll(): List<LocalUsageClearMarkerEntity>

    @Query("SELECT * FROM local_usage_clear_markers WHERE device_id = :deviceId")
    suspend fun get(deviceId: String): LocalUsageClearMarkerEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: LocalUsageClearMarkerEntity)

    @Query("DELETE FROM local_usage_clear_markers WHERE device_id = :deviceId")
    suspend fun delete(deviceId: String)
}

@Dao
interface LocalGroupDao {
    @Query("SELECT * FROM local_groups ORDER BY name COLLATE NOCASE, id")
    fun observeAll(): Flow<List<LocalGroupEntity>>

    @Query("SELECT * FROM local_groups ORDER BY name COLLATE NOCASE, id")
    suspend fun listAll(): List<LocalGroupEntity>

    @Query("SELECT * FROM local_groups WHERE id = :id")
    suspend fun getById(id: String): LocalGroupEntity?

    /** 同 [LocalCharacterDao.upsert]：父表必须用 @Upsert，避免外键 SET_NULL 波及子行。 */
    @Upsert
    suspend fun upsert(entity: LocalGroupEntity)

    @Query("DELETE FROM local_groups WHERE id = :id")
    suspend fun delete(id: String)
}

// ---------------------------------------------------------------- 会话 / 消息 DAO

@Dao
interface LocalSessionDao {
    @Query("SELECT * FROM local_sessions ORDER BY updated_at DESC, id")
    fun observeAll(): Flow<List<LocalSessionEntity>>

    @Query("SELECT * FROM local_sessions ORDER BY updated_at DESC, id")
    suspend fun listAll(): List<LocalSessionEntity>

    @Query("SELECT * FROM local_sessions WHERE id = :id")
    suspend fun getById(id: String): LocalSessionEntity?

    @Query("SELECT id FROM local_sessions")
    suspend fun listIds(): List<String>

    @Query("SELECT COUNT(*) FROM local_sessions")
    suspend fun count(): Int

    /**
     * **必须是 @Upsert**：`local_messages.session_id` 是 `ON DELETE CASCADE`，
     * 而 `INSERT OR REPLACE` 会先删旧行——用 REPLACE 更新会话（改预设/世界书/记忆开关）
     * 会**静默删除该会话的全部消息**。`@Upsert` 不删行，因此不会触发级联。
     */
    @Upsert
    suspend fun upsert(entity: LocalSessionEntity)

    @Query("DELETE FROM local_sessions WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface LocalMessageDao {
    @Query("SELECT * FROM local_messages WHERE session_id = :sessionId ORDER BY seq ASC")
    fun observeForSession(sessionId: String): Flow<List<LocalMessageEntity>>

    @Query("SELECT * FROM local_messages WHERE session_id = :sessionId ORDER BY seq ASC")
    suspend fun listForSession(sessionId: String): List<LocalMessageEntity>

    @Query("SELECT * FROM local_messages WHERE id = :id")
    suspend fun getById(id: String): LocalMessageEntity?

    @Query("SELECT COUNT(*) FROM local_messages WHERE session_id = :sessionId")
    suspend fun countForSession(sessionId: String): Int

    @Query("SELECT COUNT(*) FROM local_messages")
    suspend fun count(): Int

    @Query("SELECT COALESCE(MAX(seq), -1) + 1 FROM local_messages WHERE session_id = :sessionId")
    suspend fun nextSeq(sessionId: String): Long

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: LocalMessageEntity)

    @Query("DELETE FROM local_messages WHERE id = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM local_messages WHERE session_id = :sessionId")
    suspend fun deleteForSession(sessionId: String)
}

/** 阶段 6 S6-01：群聊消息 DAO（v5 新表）。 */
@Dao
interface LocalGroupMessageDao {
    @Query("SELECT * FROM local_group_messages WHERE session_id = :sessionId ORDER BY seq ASC")
    fun observeForSession(sessionId: String): Flow<List<LocalGroupMessageEntity>>

    @Query("SELECT * FROM local_group_messages WHERE session_id = :sessionId ORDER BY seq ASC")
    suspend fun listForSession(sessionId: String): List<LocalGroupMessageEntity>

    @Query("SELECT * FROM local_group_messages WHERE id = :id")
    suspend fun getById(id: String): LocalGroupMessageEntity?

    @Query("SELECT COUNT(*) FROM local_group_messages WHERE session_id = :sessionId")
    suspend fun countForSession(sessionId: String): Int

    @Query("SELECT COALESCE(MAX(seq), -1) + 1 FROM local_group_messages WHERE session_id = :sessionId")
    suspend fun nextSeq(sessionId: String): Long

    /** 与 [LocalMessageDao.upsert] 同口径：本表不是任何表的外键父表，REPLACE 不会级联删除。 */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: LocalGroupMessageEntity)

    @Query("DELETE FROM local_group_messages WHERE id = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM local_group_messages WHERE session_id = :sessionId")
    suspend fun deleteForSession(sessionId: String)
}

// ---------------------------------------------------------------- 记忆 / 用量 / 媒体 DAO

@Dao
interface LocalMemoryDao {
    /**
     * 读取会话的记忆状态。
     *
     * **必须按版本降序取一行**：表上只有 `id` 主键、没有 session 唯一约束，
     * 因此历史数据理论上可能存在同一会话的多行。裸 `LIMIT 1` 取到哪一行是不确定的，
     * 一旦取到旧版本，用户可见症状就是「记忆一直不更新」——而且不报任何错。
     * 版本降序 + 更新时间降序保证读到的是最新真相。
     */
    @Query(
        "SELECT * FROM local_memory_states WHERE session_id = :sessionId " +
            "ORDER BY memory_version DESC, updated_at DESC LIMIT 1",
    )
    suspend fun getState(sessionId: String): LocalMemoryStateEntity?

    @Query(
        "SELECT * FROM local_memory_states WHERE session_id = :sessionId " +
            "ORDER BY memory_version DESC, updated_at DESC LIMIT 1",
    )
    fun observeState(sessionId: String): Flow<LocalMemoryStateEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertState(entity: LocalMemoryStateEntity)

    /**
     * 阶段 4 S4-05：**条件写入**（CAS）。仅当磁盘上的 `memory_version` 仍等于 [expectedVersion]
     * 时才写入，返回受影响行数（0 = 版本已被并发推进，调用方必须丢弃本次摘要）。
     *
     * 为什么用单条条件 UPDATE 而不是「先读再写」：读与写之间的窗口正是
     * 「生成期间用户编辑历史」发生的时刻；只有让数据库在同一语句内比较并写入，
     * 才能保证旧摘要不会覆盖新历史。
     */
    @Query(
        "UPDATE local_memory_states SET summary = :summary, current_state = :currentState, " +
            "facts_json = :factsJson, history_json = :historyJson, " +
            "covered_through_seq = :coveredThroughSeq, history_revision = :historyRevision, " +
            "budget_json = :budgetJson, memory_last_message_id = :cursorMessageId, " +
            "memory_version = :nextVersion, " +
            "fact_parse_failure_count = :factParseFailureCount, " +
            "fact_retry_after_version = :factRetryAfterVersion, updated_at = :updatedAt " +
            "WHERE session_id = :sessionId AND memory_version = :expectedVersion",
    )
    suspend fun applyStateIfVersion(
        sessionId: String,
        expectedVersion: Long,
        nextVersion: Long,
        summary: String,
        currentState: String,
        factsJson: String,
        historyJson: String,
        coveredThroughSeq: Long,
        historyRevision: Long,
        budgetJson: String,
        cursorMessageId: String?,
        factParseFailureCount: Int,
        factRetryAfterVersion: Long,
        updatedAt: Long,
    ): Int

    /**
     * 推进历史修订号（消息编辑/删除/清空时调用）。
     * 返回受影响行数；不存在记忆行时返回 0（此时无需失效任何派生记忆）。
     */
    @Query(
        "UPDATE local_memory_states SET history_revision = history_revision + 1, updated_at = :updatedAt " +
            "WHERE session_id = :sessionId",
    )
    suspend fun bumpHistoryRevision(sessionId: String, updatedAt: Long): Int

    @Query("DELETE FROM local_memory_states WHERE session_id = :sessionId")
    suspend fun deleteStateForSession(sessionId: String)

    @Query("SELECT * FROM local_memory_facts WHERE session_id = :sessionId ORDER BY created_at ASC, id")
    suspend fun listFacts(sessionId: String): List<LocalMemoryFactEntity>

    /** 删除前读一次：tombstone 的 `parentId` 必须来自这一行，删掉就再也取不到了。 */
    @Query("SELECT * FROM local_memory_facts WHERE id = :id")
    suspend fun getFact(id: String): LocalMemoryFactEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertFact(entity: LocalMemoryFactEntity)

    @Query("DELETE FROM local_memory_facts WHERE id = :id")
    suspend fun deleteFact(id: String)

    @Query("DELETE FROM local_memory_facts WHERE session_id = :sessionId")
    suspend fun deleteFactsForSession(sessionId: String)
}

@Dao
interface LocalUsageDao {
    @Query("SELECT * FROM local_usage_records ORDER BY created_at DESC, id LIMIT :limit")
    suspend fun listRecent(limit: Int): List<LocalUsageRecordEntity>

    @Query(
        "SELECT COALESCE(SUM(prompt_tokens),0) FROM local_usage_records " +
            "WHERE created_at >= :since AND (:sessionId IS NULL OR session_id = :sessionId)"
    )
    suspend fun sumPromptTokens(since: Long, sessionId: String?): Long

    @Query(
        "SELECT COALESCE(SUM(completion_tokens),0) FROM local_usage_records " +
            "WHERE created_at >= :since AND (:sessionId IS NULL OR session_id = :sessionId)"
    )
    suspend fun sumCompletionTokens(since: Long, sessionId: String?): Long

    @Query("SELECT COUNT(*) FROM local_usage_records")
    suspend fun count(): Int

    @Query("SELECT COUNT(*) FROM local_usage_records WHERE id = :id")
    suspend fun exists(id: String): Int

    /**
     * 最旧的 N 条用量记录 id（S5-07 保留上限淘汰用）。
     *
     * 排序用 `created_at, id`：PC 是按文件里的插入顺序稳定排序，Android 的 id 是 ULID
     * （同毫秒内 id 序即插入序），所以两端淘汰的是同一批。
     */
    @Query("SELECT id FROM local_usage_records ORDER BY created_at ASC, id ASC LIMIT :count")
    suspend fun oldestIds(count: Int): List<String>

    /** S4-04 用量诊断：区间内的可见字符汇总（与 PC `getSummary` 同口径）。 */
    @Query(
        "SELECT COALESCE(SUM(input_chars),0) FROM local_usage_records " +
            "WHERE created_at >= :since AND created_at <= :until AND task_type = 'main'",
    )
    suspend fun sumInputChars(since: Long, until: Long): Long

    @Query(
        "SELECT COALESCE(SUM(output_chars),0) FROM local_usage_records " +
            "WHERE created_at >= :since AND created_at <= :until AND task_type = 'main'",
    )
    suspend fun sumOutputChars(since: Long, until: Long): Long

    @Query(
        "SELECT COALESCE(SUM(input_chars + output_chars),0) FROM local_usage_records " +
            "WHERE created_at >= :since AND created_at <= :until AND task_type = 'main'",
    )
    suspend fun sumTotalChars(since: Long, until: Long): Long

    @Query(
        "SELECT COUNT(*) FROM local_usage_records " +
            "WHERE created_at >= :since AND created_at <= :until AND task_type = 'main'",
    )
    suspend fun countInRange(since: Long, until: Long): Int

    @Query(
        "SELECT * FROM local_usage_records WHERE created_at >= :since AND created_at <= :until " +
            "ORDER BY created_at DESC, id LIMIT :limit",
    )
    suspend fun listInRange(since: Long, until: Long, limit: Int): List<LocalUsageRecordEntity>

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(entity: LocalUsageRecordEntity): Long

    // ---- 阶段 5 S5-07：维度聚合与清理 ----

    @Query("SELECT id FROM local_usage_records")
    suspend fun listIds(): List<String>

    /**
     * 阶段 5 S5-07：维度聚合。
     *
     * 这里**逐维度写死查询**而不是 `GROUP BY :dimension`：SQLite 的绑定参数只能出现在
     * 值的位置，`GROUP BY 'model'` 会按常量分组、每组一条，结果是静默错误的统计。
     * 宁可多写几个方法，也不能把维度名拼进 SQL 或指望绑定参数当标识符。
     * PC 侧 `usage:aggregate` 同样按维度分支，口径一致。
     */
    @Query(
        """
        SELECT model AS group_key,
               COUNT(*) AS records,
               COALESCE(SUM(input_chars), 0) AS input_chars,
               COALESCE(SUM(output_chars), 0) AS output_chars,
               COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
               COALESCE(SUM(completion_tokens), 0) AS completion_tokens
        FROM local_usage_records
        WHERE created_at >= :since AND created_at <= :until
          AND (:taskType = '' OR task_type = :taskType)
        GROUP BY model
        ORDER BY output_chars DESC
        """,
    )
    suspend fun aggregateByModel(since: Long, until: Long, taskType: String): List<UsageAggregateRow>

    @Query(
        """
        SELECT character_id AS group_key,
               COUNT(*) AS records,
               COALESCE(SUM(input_chars), 0) AS input_chars,
               COALESCE(SUM(output_chars), 0) AS output_chars,
               COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
               COALESCE(SUM(completion_tokens), 0) AS completion_tokens
        FROM local_usage_records
        WHERE created_at >= :since AND created_at <= :until
          AND (:taskType = '' OR task_type = :taskType)
        GROUP BY character_id
        ORDER BY output_chars DESC
        """,
    )
    suspend fun aggregateByCharacter(since: Long, until: Long, taskType: String): List<UsageAggregateRow>

    @Query(
        """
        SELECT date_key AS group_key,
               COUNT(*) AS records,
               COALESCE(SUM(input_chars), 0) AS input_chars,
               COALESCE(SUM(output_chars), 0) AS output_chars,
               COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
               COALESCE(SUM(completion_tokens), 0) AS completion_tokens
        FROM local_usage_records
        WHERE created_at >= :since AND created_at <= :until
          AND (:taskType = '' OR task_type = :taskType)
        GROUP BY date_key
        ORDER BY date_key DESC
        """,
    )
    suspend fun aggregateByDate(since: Long, until: Long, taskType: String): List<UsageAggregateRow>

    @Query(
        """
        SELECT status AS group_key,
               COUNT(*) AS records,
               COALESCE(SUM(input_chars), 0) AS input_chars,
               COALESCE(SUM(output_chars), 0) AS output_chars,
               COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
               COALESCE(SUM(completion_tokens), 0) AS completion_tokens
        FROM local_usage_records
        WHERE created_at >= :since AND created_at <= :until
          AND (:taskType = '' OR task_type = :taskType)
        GROUP BY status
        ORDER BY status ASC
        """,
    )
    suspend fun aggregateByStatus(since: Long, until: Long, taskType: String): List<UsageAggregateRow>

    @Query(
        """
        SELECT provider AS group_key,
               COUNT(*) AS records,
               COALESCE(SUM(input_chars), 0) AS input_chars,
               COALESCE(SUM(output_chars), 0) AS output_chars,
               COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
               COALESCE(SUM(completion_tokens), 0) AS completion_tokens
        FROM local_usage_records
        WHERE created_at >= :since AND created_at <= :until
          AND (:taskType = '' OR task_type = :taskType)
        GROUP BY provider
        ORDER BY output_chars DESC
        """,
    )
    suspend fun aggregateByProvider(since: Long, until: Long, taskType: String): List<UsageAggregateRow>

    @Query(
        "SELECT COUNT(*) FROM local_usage_records WHERE created_at >= :since AND created_at <= :until",
    )
    suspend fun countInRangeAll(since: Long, until: Long): Int

    @Query("SELECT id FROM local_usage_records WHERE id IN (:ids)")
    suspend fun listExisting(ids: List<String>): List<String>

    @Query("DELETE FROM local_usage_records WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<String>): Int
}

/** 用量聚合行（维度键 + 计数）。`group_key` 为 NULL 表示该维度未设置（如无角色）。 */
data class UsageAggregateRow(
    val group_key: String?,
    val records: Int,
    val input_chars: Long,
    val output_chars: Long,
    val prompt_tokens: Long,
    val completion_tokens: Long,
)

@Dao
interface LocalMediaDao {
    @Query("SELECT * FROM local_media_manifests WHERE owner_type = :ownerType AND owner_id = :ownerId")
    suspend fun listForOwner(ownerType: String, ownerId: String): List<LocalMediaManifestEntity>

    @Query("SELECT * FROM local_media_manifests WHERE id = :id")
    suspend fun getById(id: String): LocalMediaManifestEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: LocalMediaManifestEntity)

    @Query("DELETE FROM local_media_manifests WHERE id = :id")
    suspend fun delete(id: String)
}

// ---------------------------------------------------------------- 设置 DAO

@Dao
interface LocalSettingsDao {
    @Query("SELECT * FROM local_public_settings ORDER BY section, key")
    suspend fun listPublic(): List<LocalPublicSettingEntity>

    @Query("SELECT * FROM local_public_settings ORDER BY section, key")
    fun observePublic(): Flow<List<LocalPublicSettingEntity>>

    @Query("SELECT * FROM local_public_settings WHERE section = :section AND key = :key")
    suspend fun getPublic(section: String, key: String): LocalPublicSettingEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertPublic(entity: LocalPublicSettingEntity)

    @Query("SELECT * FROM local_device_settings ORDER BY key")
    suspend fun listDevice(): List<LocalDeviceSettingEntity>

    @Query("SELECT * FROM local_device_settings ORDER BY key")
    fun observeDevice(): Flow<List<LocalDeviceSettingEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertDevice(entity: LocalDeviceSettingEntity)

    @Query("DELETE FROM local_device_settings WHERE key = :key")
    suspend fun deleteDevice(key: String)
}

// ---------------------------------------------------------------- 连接档案 DAO

@Dao
interface LocalConnectionProfileDao {
    @Query("SELECT * FROM local_connection_profiles ORDER BY sort_index, id")
    fun observeAll(): Flow<List<LocalConnectionProfileEntity>>

    @Query("SELECT * FROM local_connection_profiles ORDER BY sort_index, id")
    suspend fun listAll(): List<LocalConnectionProfileEntity>

    @Query("SELECT * FROM local_connection_profiles WHERE id = :id")
    suspend fun getById(id: String): LocalConnectionProfileEntity?

    @Query("SELECT COUNT(*) FROM local_connection_profiles")
    suspend fun count(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: LocalConnectionProfileEntity)

    /**
     * 只更新 public 字段，绝不触碰 `secret_ref`。
     * S3-06：public 保存与 secret 保存必须是两个独立事务。
     */
    @Query(
        """
        UPDATE local_connection_profiles
        SET provider = :provider, base_url = :baseUrl, model = :model, display_name = :displayName,
            enabled = :enabled, sort_index = :sortIndex, allow_http = :allowHttp,
            capabilities_json = :capabilitiesJson, updated_at = :updatedAt
        WHERE id = :id
        """,
    )
    suspend fun updatePublicFields(
        id: String,
        provider: String,
        baseUrl: String,
        model: String,
        displayName: String,
        enabled: Boolean,
        sortIndex: Int,
        allowHttp: Boolean,
        capabilitiesJson: String,
        updatedAt: Long,
    ): Int

    /** 只在 secret 写入成功后调用；`ref = null` 表示清除。 */
    @Query("UPDATE local_connection_profiles SET secret_ref = :ref, updated_at = :updatedAt WHERE id = :id")
    suspend fun updateSecretRef(id: String, ref: String?, updatedAt: Long): Int

    @Query("DELETE FROM local_connection_profiles WHERE id = :id")
    suspend fun delete(id: String)
}

// ---------------------------------------------------------------- 同步元数据 DAO

@Dao
interface LocalSyncMetaDao {
    @Query("SELECT * FROM entity_heads WHERE entity_type = :entityType AND entity_id = :entityId")
    suspend fun getHead(entityType: String, entityId: String): EntityHeadEntity?

    @Query("SELECT * FROM entity_heads WHERE deleted = 1")
    suspend fun listTombstones(): List<EntityHeadEntity>

    @Query("SELECT * FROM entity_heads")
    suspend fun listAllHeads(): List<EntityHeadEntity>

    @Query("SELECT COUNT(*) FROM entity_heads")
    suspend fun headCount(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertHead(head: EntityHeadEntity)

    @Insert
    suspend fun insertChange(change: ChangeLogEntity): Long

    @Query("SELECT COUNT(*) FROM change_log WHERE origin = :origin")
    suspend fun countByOrigin(origin: String): Int

    @Query("SELECT COUNT(*) FROM change_log")
    suspend fun changeCount(): Int

    @Query("SELECT * FROM change_log WHERE seq > :cursor ORDER BY seq ASC LIMIT :limit")
    suspend fun changesAfter(cursor: Long, limit: Int): List<ChangeLogEntity>

    @Query("SELECT COALESCE(MAX(seq), 0) FROM change_log")
    suspend fun maxChangeSeq(): Long

    @Query("SELECT * FROM sync_receipts ORDER BY committed_at DESC LIMIT :limit")
    suspend fun listReceipts(limit: Int): List<SyncReceiptEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertReceipt(receipt: SyncReceiptEntity)

    @Query("SELECT * FROM conflicts WHERE resolved = 0 ORDER BY detected_at ASC")
    suspend fun listOpenConflicts(): List<ConflictEntity>

    @Query("SELECT COUNT(*) FROM conflicts WHERE resolved = 0")
    suspend fun openConflictCount(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertConflict(conflict: ConflictEntity)

    @Query("UPDATE conflicts SET resolved = 1, resolution_json = :resolutionJson WHERE id = :id")
    suspend fun resolveConflict(id: String, resolutionJson: String)
}

/** 契约测试专用 DAO（见 [ContractObjectEntity]）。 */
@Dao
interface ContractObjectDao {
    @Query("SELECT * FROM contract_objects WHERE id = :id")
    suspend fun get(id: String): ContractObjectEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: ContractObjectEntity)

    @Query("DELETE FROM contract_objects WHERE id = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM contract_objects")
    suspend fun clear()

    @Query("DELETE FROM change_log WHERE entity_type = :namespace")
    suspend fun clearJournal(namespace: String)

    @Query("DELETE FROM entity_heads WHERE entity_type = :namespace")
    suspend fun clearHeads(namespace: String)

    @Query("DELETE FROM entity_heads WHERE entity_type = :namespace AND entity_id = :entityId")
    suspend fun deleteHead(namespace: String, entityId: String)
}
