package com.qingyu.companion.local.migration

import android.content.Context
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import java.io.File

/**
 * 阶段 3 S3-02：旧伴侣缓存（`qingyu-companion-cache`）**只读快照读取器**。
 *
 * 硬规则：
 * - 启动迁移前先把旧库及 `-wal`/`-shm` 复制成只读快照，**绝不**让新版 Room 原地升级旧库；
 * - 快照以「副本 + WAL checkpoint 自包含化」方式打开，缺失表/列只记录警告，不修改原始旧库；
 * - v1—v7 的表结构差异通过「探测列是否存在」吸收，不引入 Room 实体。
 *
 * [legacyDbName] / [snapshotDbName] 可注入，便于测试为每个用例分配独立文件
 * （避免上一用例残留的库文件造成版本冲突）；生产使用默认名。
 */
class LegacyCacheReader(
    context: Context,
    val legacyDbName: String = LEGACY_DB_NAME,
    val snapshotDbName: String = SNAPSHOT_DB_NAME,
) {

    private val appContext: Context = context.applicationContext

    companion object {
        const val LEGACY_DB_NAME = "qingyu-companion-cache"
        const val SNAPSHOT_DB_NAME = "qingyu-companion-cache.snapshot"

        /** 旧缓存已知版本区间；阶段 0 数据域审计结论（S3-01 要求保留 v1—v7 兼容测试）。 */
        val SUPPORTED_VERSIONS = 1..7
    }

    /** 旧库文件是否存在（含未 checkpoint 的 WAL 内容）。 */
    fun legacyDatabaseExists(): Boolean = appContext.getDatabasePath(legacyDbName).exists()

    fun snapshotExists(): Boolean = appContext.getDatabasePath(snapshotDbName).exists()

    /**
     * 复制旧库 + WAL/SHM 为只读快照，并让快照**自包含**。
     *
     * 只读约束：整个过程只读原始旧库；checkpoint 只作用在快照副本上。
     * 「WAL 未 checkpoint」是真实旧版本状态（阶段 3 §3 要求覆盖），因此流程是：
     * 1. 逐字节复制主库 + `-wal` + `-shm`；
     * 2. 用底层 `SQLiteDatabase.openDatabase(..., CREATE_IF_NECESSARY)` 打开**副本**并
     *    `PRAGMA wal_checkpoint(TRUNCATE)`，把 WAL 合并进副本主库。
     *    这一步不用 `SQLiteOpenHelper`：helper 会在 `user_version` 不一致时改写版本并写入事务，
     *    正好会打断 WAL 恢复。底层直接打开不引入任何版本变更。
     * 3. 删除副本的 `-wal`/`-shm`，使副本成为普通自包含数据库文件。
     */
    fun snapshotLegacyCache(): SnapshotResult {
        val source = appContext.getDatabasePath(legacyDbName)
        if (!source.exists()) return SnapshotResult(created = false, copiedFiles = emptyList())

        val target = appContext.getDatabasePath(snapshotDbName)
        target.parentFile?.mkdirs()
        val copied = mutableListOf<String>()
        for (suffix in listOf("", "-wal", "-shm")) {
            val from = File(source.path + suffix)
            val to = File(target.path + suffix)
            if (from.exists()) {
                from.copyTo(to, overwrite = true)
                copied += to.name
            } else if (to.exists()) {
                to.delete()
            }
        }

        checkpointSnapshot(target)

        File(target.path + "-wal").takeIf { it.exists() }?.delete()
        File(target.path + "-shm").takeIf { it.exists() }?.delete()
        return SnapshotResult(created = true, copiedFiles = copied)
    }

    /** 把副本的 WAL 合并进副本主库；失败时保留原样（后续按损坏/不可打开处理）。 */
    private fun checkpointSnapshot(snapshotFile: File) {
        if (!File(snapshotFile.path + "-wal").exists()) return
        runCatching {
            android.database.sqlite.SQLiteDatabase.openDatabase(
                snapshotFile.absolutePath,
                null,
                android.database.sqlite.SQLiteDatabase.CREATE_IF_NECESSARY,
            ).use { db ->
                runCatching { db.rawQuery("PRAGMA wal_checkpoint(TRUNCATE)", null).use { it.moveToFirst() } }
            }
        }
    }

    /**
     * 打开只读快照；快照不存在时返回 null。
     *
     * 关键实现约束（否则会破坏「旧库只读」前提）：
     *
     * `SQLiteOpenHelper` 在文件 `user_version` 与自身 `version` 不一致时会回调 `onUpgrade`
     * 并**改写 `user_version`**（=`PRAGMA user_version=N`）。若此时把版本误判为某个值，
     * 会向副本写入事务并**打断 WAL 恢复**，快照直接变成空库。
     * 因此这里先用 [resolvedVersion] 解析出真实版本（主库头为主，WAL 模式回退读 `-wal` 头），
     * 再用同版本号构造 helper，使 `onUpgrade` 永不触发、WAL 正常重放。
     *
     * 打开方式必须可写：WAL 恢复需要可写目录；安全性由「快照是副本 + 本类不提供写方法」保证。
     */
    fun openSnapshot(): SupportSQLiteDatabase? {
        val file = appContext.getDatabasePath(snapshotDbName)
        if (!file.exists()) return null
        val version = resolvedVersion(file)
        return runCatching {
            val configuration = SupportSQLiteOpenHelper.Configuration.builder(appContext)
                .name(file.absolutePath)
                .callback(object : SupportSQLiteOpenHelper.Callback(version) {
                    override fun onCreate(db: SupportSQLiteDatabase) = Unit
                    override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
                    override fun onDowngrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
                })
                .build()
            FrameworkSQLiteOpenHelperFactory().create(configuration).writableDatabase
        }.getOrNull()
    }

    /** 版本解析：主库头优先；为 0（WAL 目录未 checkpoint）时回退读 `-wal` 头（两种端序都尝试）。 */
    internal fun resolvedVersion(file: File): Int {
        readUserVersion(file).takeIf { it > 0 }?.let { return it }
        val wal = File(file.path + "-wal")
        if (wal.exists() && wal.length() >= 64) {
            readIntAt(wal, 60, bigEndian = true)
                .takeIf { it in LegacyCacheReader.SUPPORTED_VERSIONS }
                ?.let { return it }
            readIntAt(wal, 60, bigEndian = false)
                .takeIf { it in LegacyCacheReader.SUPPORTED_VERSIONS }
                ?.let { return it }
        }
        return 1
    }

    /**
     * 读取 SQLite 头部的 4 字节整数（主库与 WAL 头的 schema 版本均在偏移 60）。
     * 目录仍为 WAL 模式时主库头可能是 0，真实版本位于 `-wal` 头。
     */
    internal fun readUserVersion(file: File): Int = readIntAt(file, 60, bigEndian = true)

    private fun readIntAt(file: File, offset: Long, bigEndian: Boolean): Int {
        if (!file.exists() || file.length() < offset + 4) return 0
        return runCatching {
            java.io.RandomAccessFile(file, "r").use { raf ->
                raf.seek(offset)
                val bytes = ByteArray(4)
                if (raf.read(bytes) != 4) return 0
                if (bigEndian) {
                    ((bytes[0].toInt() and 0xFF) shl 24) or
                        ((bytes[1].toInt() and 0xFF) shl 16) or
                        ((bytes[2].toInt() and 0xFF) shl 8) or
                        (bytes[3].toInt() and 0xFF)
                } else {
                    ((bytes[3].toInt() and 0xFF) shl 24) or
                        ((bytes[2].toInt() and 0xFF) shl 16) or
                        ((bytes[1].toInt() and 0xFF) shl 8) or
                        (bytes[0].toInt() and 0xFF)
                }
            }
        }.getOrDefault(0)
    }

    /** 读取旧库 schema 版本（只读）。 */
    fun readVersion(db: SupportSQLiteDatabase): Int = db.version

    fun tableExists(db: SupportSQLiteDatabase, table: String): Boolean {
        db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?", arrayOf(table)).use { cursor ->
            return cursor.moveToFirst()
        }
    }

    fun columnNames(db: SupportSQLiteDatabase, table: String): Set<String> {
        if (!tableExists(db, table)) return emptySet()
        val columns = mutableSetOf<String>()
        db.query("PRAGMA table_info($table)").use { cursor ->
            val nameIndex = cursor.getColumnIndex("name")
            while (cursor.moveToNext()) {
                if (nameIndex >= 0) columns += cursor.getString(nameIndex)
            }
        }
        return columns
    }

    /** 只读扫描：产出迁移向导所需的计数与缺失警告。 */
    fun scan(db: SupportSQLiteDatabase): LegacyCacheScan {
        val version = runCatching { readVersion(db) }.getOrDefault(0)
        val unsupported = version !in SUPPORTED_VERSIONS

        val characterColumns = columnNames(db, "cached_sessions")
        val messageColumns = columnNames(db, "cached_messages")
        val outboxColumns = columnNames(db, "outbox_messages")

        val characterIds = mutableSetOf<String>()
        val sessionIds = mutableSetOf<String>()
        var sessionCount = 0
        var messageCount = 0

        if (characterColumns.isNotEmpty()) {
            db.query("SELECT DISTINCT characterId FROM cached_sessions").use { c ->
                val index = c.getColumnIndex("characterId")
                while (c.moveToNext()) {
                    if (index >= 0) c.getString(index)?.takeIf { it.isNotBlank() }?.let { characterIds += it }
                }
            }
            db.query("SELECT id FROM cached_sessions").use { c ->
                val index = c.getColumnIndex("id")
                while (c.moveToNext()) {
                    sessionCount++
                    if (index >= 0) c.getString(index)?.let { sessionIds += it }
                }
            }
        }
        if (messageColumns.isNotEmpty()) {
            db.query("SELECT COUNT(*) FROM cached_messages").use { c ->
                if (c.moveToFirst()) messageCount = c.getInt(0)
            }
        }

        val outboxUnsent = if (outboxColumns.isNotEmpty()) {
            val stateColumn = if ("state" in outboxColumns) "state" else "NULL"
            val unsentStates = listOf("queued", "sending", "relay_queued", "user_committed", "awaiting_ai", "failed_send", "failed_generation")
            val placeholders = unsentStates.joinToString(",") { "?" }
            db.query(
                "SELECT COUNT(*) FROM outbox_messages WHERE $stateColumn IN ($placeholders)",
                unsentStates.toTypedArray(),
            ).use { c ->
                if (c.moveToFirst()) c.getInt(0) else 0
            }
        } else {
            0
        }
        val outboxConfirmed = if (outboxColumns.isNotEmpty() && "remoteUserMessageId" in outboxColumns) {
            db.query(
                "SELECT COUNT(*) FROM outbox_messages WHERE remoteUserMessageId IS NOT NULL AND remoteUserMessageId != ''",
            ).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }
        } else {
            0
        }

        // 旧缓存只有会话投影，没有世界书/预设详情表：任何被引用的世界书/预设都视为「详情缺失」，
        // 迁移向导必须显示警告而不是假装完整（S3-02）。
        val warnings = mutableListOf<String>()
        if (unsupported) {
            warnings += "旧缓存 schema 版本 $version 不在已验证区间 ${SUPPORTED_VERSIONS.first}—${SUPPORTED_VERSIONS.last}"
        }
        if (characterIds.isEmpty() && sessionCount == 0 && messageCount == 0) {
            warnings += "旧缓存为空或结构与预期不符"
        }

        return LegacyCacheScan(
            schemaVersion = version,
            hasAnyData = sessionCount > 0 || messageCount > 0 || characterIds.isNotEmpty(),
            characterCount = characterIds.size,
            sessionCount = sessionCount,
            messageCount = messageCount,
            outboxUnsentCount = outboxUnsent,
            outboxConfirmedCount = outboxConfirmed,
            missingLorebookIds = emptyList(),
            missingPresetIds = emptyList(),
            extraWarnings = warnings,
        )
    }

    /** 未 checkpoint 的 WAL 是否存在（升级前备份必须包含它）。 */
    fun walPresent(): Boolean = File(appContext.getDatabasePath(legacyDbName).path + "-wal").exists()

    /** 旧库是否损坏（可打开但无法完成一次基本读取）。 */
    fun isCorrupted(db: SupportSQLiteDatabase): Boolean = runCatching {
        db.query("SELECT COUNT(*) FROM sqlite_master").use { it.moveToFirst() }
    }.isFailure

    data class SnapshotResult(val created: Boolean, val copiedFiles: List<String>)
}

