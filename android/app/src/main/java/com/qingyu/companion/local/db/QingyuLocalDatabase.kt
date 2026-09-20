package com.qingyu.companion.local.db

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.TypeConverter
import androidx.room.TypeConverters
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * 阶段 3 本地权威库 `qingyu-local.db`。
 *
 * - **不原地升级** `qingyu-companion-cache`：旧库只作为一次性迁移来源（S3-02）。
 * - `version = 1` 是阶段 3 首次落地；**v1→v2 由阶段 4 S4-05 引入**（记忆版本/CAS 与任务类型），
 *   必须提供显式 `Migration`，禁止 destructive fallback。
 * - 外键约束显式声明并在 `onOpen` 强制打开（Room 默认并不自动开启 `PRAGMA foreign_keys`）。
 */
@Database(
    entities = [
        LocalDeviceStateEntity::class,
        LocalCharacterEntity::class,
        LocalLorebookEntity::class,
        LocalPresetEntity::class,
        LocalPersonaEntity::class,
        LocalRegexRuleEntity::class,
        LocalQuickReplySetEntity::class,
        LocalGroupEntity::class,
        LocalSessionEntity::class,
        LocalMessageEntity::class,
        LocalMemoryStateEntity::class,
        LocalMemoryFactEntity::class,
        LocalUsageRecordEntity::class,
        LocalMediaManifestEntity::class,
        LocalPublicSettingEntity::class,
        LocalDeviceSettingEntity::class,
        LocalConnectionProfileEntity::class,
        LocalLorebookMappingTemplateEntity::class,
        LocalUsageClearMarkerEntity::class,
        EntityHeadEntity::class,
        ChangeLogEntity::class,
        SyncReceiptEntity::class,
        ConflictEntity::class,
        ContractObjectEntity::class,
    ],
    version = 4,
    exportSchema = true,
)
@TypeConverters(BoolConverters::class)
abstract class QingyuLocalDatabase : RoomDatabase() {
    abstract fun deviceDao(): LocalDeviceDao
    abstract fun characterDao(): LocalCharacterDao
    abstract fun lorebookDao(): LocalLorebookDao
    abstract fun presetDao(): LocalPresetDao
    abstract fun personaDao(): LocalPersonaDao
    abstract fun regexRuleDao(): LocalRegexRuleDao
    abstract fun quickReplySetDao(): LocalQuickReplySetDao
    abstract fun groupDao(): LocalGroupDao
    abstract fun sessionDao(): LocalSessionDao
    abstract fun messageDao(): LocalMessageDao
    abstract fun memoryDao(): LocalMemoryDao
    abstract fun usageDao(): LocalUsageDao
    abstract fun mediaDao(): LocalMediaDao
    abstract fun settingsDao(): LocalSettingsDao
    abstract fun connectionProfileDao(): LocalConnectionProfileDao
    abstract fun lorebookMappingTemplateDao(): LocalLorebookMappingTemplateDao
    abstract fun usageClearMarkerDao(): LocalUsageClearMarkerDao
    abstract fun syncMetaDao(): LocalSyncMetaDao
    abstract fun contractObjectDao(): ContractObjectDao

    companion object {
        const val NAME = "qingyu-local.db"

        /**
         * v1 → v2（阶段 4 S4-05）：仅新增列，**不重建任何表**，因此既有业务行与 journal 全部存活。
         *
         * 逐列说明见 `LocalEntities.kt` 的实体注释：
         * - `local_memory_states`：记忆版本（CAS 依据）、当前状态、事实/历史规范 JSON、历史修订号；
         * - `local_usage_records`：任务类型（记忆用量与聊天用量分开统计）。
         *
         * 所有新增列都带 DEFAULT，保证已有行在迁移后立即可读（旧会话 = 无记忆、版本 0）。
         */
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE local_memory_states ADD COLUMN memory_version INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE local_memory_states ADD COLUMN current_state TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_memory_states ADD COLUMN facts_json TEXT NOT NULL DEFAULT '[]'")
                db.execSQL("ALTER TABLE local_memory_states ADD COLUMN history_json TEXT NOT NULL DEFAULT '[]'")
                db.execSQL("ALTER TABLE local_memory_states ADD COLUMN history_revision INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE local_memory_states ADD COLUMN memory_last_message_id TEXT")
                db.execSQL("ALTER TABLE local_memory_states ADD COLUMN fact_parse_failure_count INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE local_memory_states ADD COLUMN fact_retry_after_version INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE local_usage_records ADD COLUMN task_type TEXT NOT NULL DEFAULT 'main'")
                db.execSQL("ALTER TABLE local_usage_records ADD COLUMN input_chars INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE local_usage_records ADD COLUMN output_chars INTEGER NOT NULL DEFAULT 0")
                // 会话级长记忆开关与策略（S4-05）：与记忆状态分行存放，
                // 因为「已开启但还没生成内容」是合法状态
                db.execSQL("ALTER TABLE local_sessions ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE local_sessions ADD COLUMN memory_mode TEXT NOT NULL DEFAULT 'manual'")
                db.execSQL("ALTER TABLE local_sessions ADD COLUMN auto_memory_interval INTEGER NOT NULL DEFAULT 10")
            }
        }

        /**
         * v2 → v3（阶段 4 S4-04/S4-06）：仅新增列，**不重建任何表**。
         *
         * 补的是「装配器有输入、本地却无处存」的那批字段：
         * - `local_sessions.narrative_mode` / `response_length_mode`：会话级叙事模式与篇幅意图；
         * - `local_sessions.recent_triggered_ids_json`：世界书近因窗口（没有它，
         *   运行时的 recency 加权恒为 0——能力已接、数据没接）；
         * - `local_sessions.lorebook_compression_cache_json`：世界书超限压缩缓存；
         * - `local_sessions.compressed_summary` / `compressed_range_json`：历史压缩摘要与覆盖范围。
         *
         * 所有新增列都带 DEFAULT，旧会话迁移后立即可读（= 未设置/空窗口/无缓存）。
         */
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE local_sessions ADD COLUMN narrative_mode TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_sessions ADD COLUMN response_length_mode TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_sessions ADD COLUMN recent_triggered_ids_json TEXT NOT NULL DEFAULT '[]'")
                db.execSQL("ALTER TABLE local_sessions ADD COLUMN lorebook_compression_cache_json TEXT NOT NULL DEFAULT '{}'")
                db.execSQL("ALTER TABLE local_sessions ADD COLUMN compressed_summary TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_sessions ADD COLUMN compressed_range_json TEXT NOT NULL DEFAULT ''")
            }
        }

        /**
         * v3 → v4（阶段 5）：**只加列、只加表、只加索引，不重建任何既有表**。
         *
         * 两部分内容：
         * 1. 内容实体的可编辑字段（角色卡 V1/V2/V3 全字段、预设内建分区与排序、
         *    人设头像、正则兼容注记、快捷回复角色作用域、用量维度）；
         * 2. 总方案 §6.1 里阶段 3 未落地的两个同步实体表
         *    （`local_lorebook_mapping_templates`、`local_usage_clear_markers`）。
         *
         * 所有新列都带 DEFAULT，旧行迁移后立即可读：
         * 「未设置」用空串 / `-1` / `NULL` 表达，**不用空值冒充用户主动清空**——
         * 角色卡字段为空和字段不存在，在导入导出语义上是两回事。
         *
         * 新表 DDL 必须与 Room 依据 `@Entity` 生成的建表语句逐字对齐（含索引名），
         * 否则 `validate` 在打开数据库时直接抛 IllegalStateException。
         */
        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                // ---- 角色：Character Card 全字段 ----
                db.execSQL("ALTER TABLE local_characters ADD COLUMN example_dialog TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_characters ADD COLUMN alternate_greetings_json TEXT NOT NULL DEFAULT '[]'")
                db.execSQL("ALTER TABLE local_characters ADD COLUMN group_only_greetings_json TEXT NOT NULL DEFAULT '[]'")
                db.execSQL("ALTER TABLE local_characters ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_characters ADD COLUMN post_history_instructions TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_characters ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'")
                db.execSQL("ALTER TABLE local_characters ADD COLUMN creator TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_characters ADD COLUMN creator_notes TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_characters ADD COLUMN character_version TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_characters ADD COLUMN bound_lorebook_ids_json TEXT NOT NULL DEFAULT '[]'")
                db.execSQL("ALTER TABLE local_characters ADD COLUMN author_note_json TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_characters ADD COLUMN embedded_lorebook_json TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_characters ADD COLUMN default_memory_mode TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_characters ADD COLUMN default_memory_enabled INTEGER NOT NULL DEFAULT -1")
                db.execSQL("ALTER TABLE local_characters ADD COLUMN default_memory_interval INTEGER NOT NULL DEFAULT -1")
                db.execSQL("ALTER TABLE local_characters ADD COLUMN default_narrative_mode TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_characters ADD COLUMN card_spec_version TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_characters ADD COLUMN translated_content_json TEXT NOT NULL DEFAULT ''")
                // ---- 预设：内建/用户分区、排序、启用 ----
                db.execSQL("ALTER TABLE local_presets ADD COLUMN is_builtin INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE local_presets ADD COLUMN description TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_presets ADD COLUMN sort_index INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE local_presets ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_local_presets_sort_index` ON `local_presets` (`sort_index`)")
                // ---- 人设：头像 ----
                db.execSQL("ALTER TABLE local_personas ADD COLUMN avatar_path TEXT")
                // ---- 正则：PC `RegexRule` 的其余业务字段 + 本地兼容元数据 ----
                db.execSQL("ALTER TABLE local_regex_rules ADD COLUMN `group` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_regex_rules ADD COLUMN stage TEXT NOT NULL DEFAULT 'text'")
                db.execSQL("ALTER TABLE local_regex_rules ADD COLUMN trigger_pattern TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_regex_rules ADD COLUMN trigger_flags TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_regex_rules ADD COLUMN stop_strings_json TEXT NOT NULL DEFAULT '[]'")
                db.execSQL("ALTER TABLE local_regex_rules ADD COLUMN source_format TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE local_regex_rules ADD COLUMN compat_notes_json TEXT NOT NULL DEFAULT '[]'")
                // ---- 快捷回复：角色作用域 ----
                db.execSQL("ALTER TABLE local_quick_reply_sets ADD COLUMN character_id TEXT")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_local_quick_reply_sets_character_id` ON `local_quick_reply_sets` (`character_id`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_local_quick_reply_sets_sort_index` ON `local_quick_reply_sets` (`sort_index`)")
                // ---- 用量：成功/失败与按角色、按日期聚合维度 ----
                db.execSQL("ALTER TABLE local_usage_records ADD COLUMN status TEXT NOT NULL DEFAULT 'success'")
                db.execSQL("ALTER TABLE local_usage_records ADD COLUMN character_id TEXT")
                db.execSQL("ALTER TABLE local_usage_records ADD COLUMN date_key TEXT NOT NULL DEFAULT ''")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_local_usage_records_character_id` ON `local_usage_records` (`character_id`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_local_usage_records_model` ON `local_usage_records` (`model`)")
                // ---- 同步实体新表 ----
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `local_lorebook_mapping_templates` (
                        `id` TEXT NOT NULL,
                        `name` TEXT NOT NULL,
                        `source_format` TEXT NOT NULL,
                        `template_json` TEXT NOT NULL DEFAULT '{}',
                        `enabled` INTEGER NOT NULL DEFAULT 1,
                        `sort_index` INTEGER NOT NULL DEFAULT 0,
                        `imported_from` TEXT,
                        `created_at` INTEGER NOT NULL,
                        `updated_at` INTEGER NOT NULL,
                        PRIMARY KEY(`id`)
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_local_lorebook_mapping_templates_name` " +
                        "ON `local_lorebook_mapping_templates` (`name`)",
                )
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `local_usage_clear_markers` (
                        `device_id` TEXT NOT NULL,
                        `cleared_through_json` TEXT NOT NULL DEFAULT '{}',
                        `tombstoned_ids_json` TEXT NOT NULL DEFAULT '[]',
                        `updated_at` INTEGER NOT NULL,
                        PRIMARY KEY(`device_id`)
                    )
                    """.trimIndent(),
                )
            }
        }

        /** 全部显式迁移（顺序无关；Room 按 from→to 自行选择）。 */
        val MIGRATIONS: Array<Migration> = arrayOf(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4)

        /** 每次打开本地库都显式开启外键，保证显式删除策略真正生效。 */
        val FOREIGN_KEYS_CALLBACK = object : Callback() {
            override fun onOpen(db: SupportSQLiteDatabase) {
                super.onOpen(db)
                db.execSQL("PRAGMA foreign_keys = ON")
            }
        }
    }
}

class BoolConverters {
    @TypeConverter
    fun fromBool(v: Boolean): Int = if (v) 1 else 0

    @TypeConverter
    fun toBool(v: Int): Boolean = v != 0
}
