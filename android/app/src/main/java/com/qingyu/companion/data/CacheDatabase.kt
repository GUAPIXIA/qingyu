package com.qingyu.companion.data

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * 离线缓存数据库。
 * 定位（方案 §3.1 / §6.9）：仅缓存最近 N 条会话，断网可回看（只读）；
 * 支持"退出时清除"，不设云端备份。缓存是 PC 数据的只读快照，
 * 重连后以 PC 为准刷新。
 */
@Database(
    entities = [CachedSession::class, CachedMessage::class, OutboxMessage::class, TaskCursorEntity::class],
    // v2：CachedMessage 新增 usage 列（token 用量缓存）。
    // v3：CachedSession 新增 characterName 列（全局会话列表展示角色名）
    // v4：OutboxMessage 持久化发件箱（P1-4.1 B1-2）
    // v5：OutboxMessage 扩列（F-03/F-05）——deviceId/characterId/updatedAt/nextAttemptAt/
    //     remoteUserMessageId/taskId/lastErrorCode/lastErrorMessage，经 [MIGRATION_4_5] 显式迁移；
    //     schema JSON 随仓库保留（app/schemas/，exportSchema=true）
    // v6：新增 task_cursors 表（F-02 task 事件 cursor），经 [MIGRATION_5_6] 显式迁移，
    //     仅 CREATE TABLE，不动 outbox/cached_*
    // v7：cached_messages 新增 generationNotice/generationError/contentRenderMode 三列
    //     （S6：消费 PC 端结构化收尾状态），经 [MIGRATION_6_7] 显式 ALTER，仅动缓存快照表
    version = 7,
    // F-05：开启 schema 导出（schemas 目录见 app/build.gradle.kts 的 ksp room.schemaLocation），
    // 每个版本 JSON 随仓库保留，迁移 SQL 必须与导出 schema 逐字段核对
    exportSchema = true,
)
abstract class CacheDatabase : RoomDatabase() {

    abstract fun sessionDao(): CachedSessionDao

    abstract fun messageDao(): CachedMessageDao

    abstract fun outboxDao(): OutboxDao

    abstract fun taskCursorDao(): TaskCursorDao

    companion object {
        const val DB_NAME = "qingyu-companion-cache"
        /** 最近会话缓存上限（方案 §6.9 数据最小化） */
        const val MAX_CACHED_SESSIONS = 10

        /**
         * 迁移策略（F-05，方案 §16.3 数据库回滚）：
         * - v4→v5 走本显式迁移，绝不清库：任何老版本升到 v5，outbox 数据必须存活。
         * - cached_sessions/cached_messages 是只读快照，可丢弃重建；但重建只允许写在
         *   后续版本的显式 Migration SQL 内（仅 DROP/CREATE 这两张表，不得连带 outbox）——
         *   AppContainer 不再注册全库 fallbackToDestructiveMigration。
         * - v1/v2/v3 老库允许破坏性重建（fallbackToDestructiveMigrationFrom）：outbox 表
         *   v4 才引入，v≤3 库中不存在 outbox 数据，破坏不损失发件箱。
         * - 迁移失败时直接抛异常（宁可崩溃也不静默清库），满足"先备份/隔离 Outbox，不直接清库"。
         */

        /**
         * MIGRATION_4_5 的全部 SQL（供 [MIGRATION_4_5] 执行与 OutboxSchemaV5Test 断言）。
         * 每条语句与 app/schemas/com.qingyu.companion.data.CacheDatabase/5.json 的
         * outbox_messages 列逐字段对应（列名/类型 affinity/NOT NULL/默认值）；
         * NOT NULL 列必须带 DEFAULT（SQLite ADD COLUMN 约束 + 回填存量行）。
         */
        val MIGRATION_4_5_STATEMENTS: List<String> = listOf(
            "ALTER TABLE outbox_messages ADD COLUMN deviceId TEXT NOT NULL DEFAULT 'legacy'",
            "ALTER TABLE outbox_messages ADD COLUMN characterId TEXT",
            "ALTER TABLE outbox_messages ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE outbox_messages ADD COLUMN nextAttemptAt INTEGER",
            "ALTER TABLE outbox_messages ADD COLUMN remoteUserMessageId TEXT",
            "ALTER TABLE outbox_messages ADD COLUMN taskId TEXT",
            "ALTER TABLE outbox_messages ADD COLUMN lastErrorCode TEXT",
            "ALTER TABLE outbox_messages ADD COLUMN lastErrorMessage TEXT",
        )

        /**
         * v4→v5：仅对 outbox_messages 做 ALTER 扩列。
         * v4/v5 的 cached_sessions/cached_messages 表结构相同，无需处理。
         *
         * F-04 归属修复已落地：见 OnlineChatRepository.repairLegacyOutbox（应用启动路径
         * AppContainer.start 调用一次），读取当前 active deviceId 回填 deviceId='legacy'
         * 的未完成行；无法唯一确定归属的旧 pending 消息不自动发送，经
         * ChatRepository.pendingLegacyOutbox 暴露给 UI 提示"旧版本待发送消息，需要选择目标 PC"。
         */
        val MIGRATION_4_5: Migration = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                for (sql in MIGRATION_4_5_STATEMENTS) {
                    db.execSQL(sql)
                }
            }
        }

        /**
         * MIGRATION_5_6 的全部 SQL（供 [MIGRATION_5_6] 执行与 OutboxSchemaV6Test 断言）。
         * 与 app/schemas/com.qingyu.companion.data.CacheDatabase/6.json 的 task_cursors
         * 定义逐字段对应（列名/affinity/NOT NULL/复合主键）。
         */
        val MIGRATION_5_6_STATEMENTS: List<String> = listOf(
            "CREATE TABLE IF NOT EXISTS task_cursors (" +
                "deviceId TEXT NOT NULL, " +
                "taskId TEXT NOT NULL, " +
                "sessionId TEXT NOT NULL, " +
                "lastSequence INTEGER NOT NULL, " +
                "updatedAt INTEGER NOT NULL, " +
                "PRIMARY KEY(deviceId, taskId))",
        )

        /** v5→v6：仅 CREATE TABLE task_cursors；outbox/cached_* 一律不动。 */
        val MIGRATION_5_6: Migration = object : Migration(5, 6) {
            override fun migrate(db: SupportSQLiteDatabase) {
                for (sql in MIGRATION_5_6_STATEMENTS) {
                    db.execSQL(sql)
                }
            }
        }

        /**
         * MIGRATION_6_7 的全部 SQL（供 [MIGRATION_6_7] 执行与 OutboxSchemaV7Test 断言）。
         * 与 app/schemas/com.qingyu.companion.data.CacheDatabase/7.json 的 cached_messages
         * 列逐字段对应；三列均可空（旧行回填 NULL，旧 PC 缺字段时解码为 null）。
         */
        val MIGRATION_6_7_STATEMENTS: List<String> = listOf(
            "ALTER TABLE cached_messages ADD COLUMN generationNotice TEXT",
            "ALTER TABLE cached_messages ADD COLUMN generationError TEXT",
            "ALTER TABLE cached_messages ADD COLUMN contentRenderMode TEXT",
        )

        /**
         * v6→v7：仅对 cached_messages 做 ALTER 扩列（缓存快照，可安全回填 NULL）；
         * outbox_messages 与 task_cursors 一律不动，保证发件箱与任务游标存活。
         */
        val MIGRATION_6_7: Migration = object : Migration(6, 7) {
            override fun migrate(db: SupportSQLiteDatabase) {
                for (sql in MIGRATION_6_7_STATEMENTS) {
                    db.execSQL(sql)
                }
            }
        }
    }
}
