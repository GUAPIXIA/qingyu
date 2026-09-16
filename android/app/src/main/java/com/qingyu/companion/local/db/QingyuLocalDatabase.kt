package com.qingyu.companion.local.db

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.Transaction
import androidx.room.TypeConverter
import androidx.room.TypeConverters

/**
 * 阶段 3 本地权威库 `qingyu-local.db`（version 1）。
 * 不原地升级 `qingyu-companion-cache`；旧缓存仅只读导入。
 */

@Entity(tableName = "local_device_state")
data class LocalDeviceStateEntity(
    @PrimaryKey val id: Int = 1,
    @ColumnInfo(name = "device_id") val deviceId: String,
    @ColumnInfo(name = "next_counter_text") val nextCounterText: String,
    @ColumnInfo(name = "migration_genesis_id") val migrationGenesisId: String? = null,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

@Entity(tableName = "local_characters")
data class LocalCharacterEntity(
    @PrimaryKey val id: String,
    val name: String,
    val description: String = "",
    val personality: String = "",
    val scenario: String = "",
    val firstMessage: String = "",
    val tagsJson: String = "[]",
    @ColumnInfo(name = "imported_from") val importedFrom: String? = null,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

@Entity(tableName = "local_personas")
data class LocalPersonaEntity(
    @PrimaryKey val id: String,
    val name: String,
    val description: String = "",
    val persona: String = "",
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

@Entity(tableName = "local_connection_profiles")
data class LocalConnectionProfileEntity(
    @PrimaryKey val id: String,
    val provider: String,
    @ColumnInfo(name = "base_url") val baseUrl: String,
    val model: String,
    val enabled: Boolean = true,
    val sortIndex: Int = 0,
    /** 仅引用；明文永不入库 */
    @ColumnInfo(name = "secret_ref") val secretRef: String? = null,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

@Entity(tableName = "entity_heads")
data class EntityHeadEntity(
    @PrimaryKey(autoGenerate = true) val rowId: Long = 0,
    @ColumnInfo(name = "entity_type") val entityType: String,
    @ColumnInfo(name = "entity_id") val entityId: String,
    @ColumnInfo(name = "version_json") val versionJson: String,
    val hash: String,
    val deleted: Boolean = false,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

@Entity(tableName = "change_log")
data class ChangeLogEntity(
    @PrimaryKey(autoGenerate = true) val seq: Long = 0,
    @ColumnInfo(name = "dot_device") val dotDevice: String,
    @ColumnInfo(name = "dot_counter") val dotCounter: String,
    @ColumnInfo(name = "entity_type") val entityType: String,
    @ColumnInfo(name = "entity_id") val entityId: String,
    val envelopeJson: String,
    /** local | remote | bootstrap */
    val origin: String,
    @ColumnInfo(name = "recorded_at") val recordedAt: Long,
)

class BoolConverters {
    @TypeConverter
    fun fromBool(v: Boolean): Int = if (v) 1 else 0

    @TypeConverter
    fun toBool(v: Int): Boolean = v != 0
}

@Dao
interface LocalDeviceDao {
    @Query("SELECT * FROM local_device_state WHERE id = 1")
    fun get(): LocalDeviceStateEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsert(state: LocalDeviceStateEntity)
}

@Dao
interface LocalCharacterDao {
    @Query("SELECT * FROM local_characters ORDER BY name COLLATE NOCASE")
    fun listAll(): List<LocalCharacterEntity>

    @Query("SELECT * FROM local_characters WHERE id = :id")
    fun getById(id: String): LocalCharacterEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsert(entity: LocalCharacterEntity)

    @Query("DELETE FROM local_characters WHERE id = :id")
    fun delete(id: String)
}

@Dao
interface LocalPersonaDao {
    @Query("SELECT * FROM local_personas ORDER BY name COLLATE NOCASE")
    fun listAll(): List<LocalPersonaEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsert(entity: LocalPersonaEntity)

    @Query("DELETE FROM local_personas WHERE id = :id")
    fun delete(id: String)
}

@Dao
interface LocalConnectionProfileDao {
    @Query("SELECT * FROM local_connection_profiles ORDER BY sortIndex, id")
    fun listAll(): List<LocalConnectionProfileEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsert(entity: LocalConnectionProfileEntity)

    @Query("DELETE FROM local_connection_profiles WHERE id = :id")
    fun delete(id: String)
}

@Dao
interface LocalSyncMetaDao {
    @Insert
    fun insertHead(head: EntityHeadEntity)

    @Query(
        """
        UPDATE entity_heads SET version_json = :versionJson, hash = :hash, deleted = :deleted, updated_at = :updatedAt
        WHERE entity_type = :entityType AND entity_id = :entityId
        """,
    )
    fun updateHead(
        entityType: String,
        entityId: String,
        versionJson: String,
        hash: String,
        deleted: Boolean,
        updatedAt: Long,
    ): Int

    @Query("SELECT * FROM entity_heads WHERE entity_type = :entityType AND entity_id = :entityId LIMIT 1")
    fun getHead(entityType: String, entityId: String): EntityHeadEntity?

    @Insert
    fun insertChange(change: ChangeLogEntity): Long

    @Query("SELECT COUNT(*) FROM change_log WHERE origin = :origin")
    fun countByOrigin(origin: String): Int

    @Query("SELECT * FROM change_log WHERE seq > :cursor ORDER BY seq ASC LIMIT :limit")
    fun changesAfter(cursor: Long, limit: Int): List<ChangeLogEntity>

    @Transaction
    fun upsertHead(
        entityType: String,
        entityId: String,
        versionJson: String,
        hash: String,
        deleted: Boolean,
        updatedAt: Long,
    ) {
        val updated = updateHead(entityType, entityId, versionJson, hash, deleted, updatedAt)
        if (updated == 0) {
            insertHead(
                EntityHeadEntity(
                    entityType = entityType,
                    entityId = entityId,
                    versionJson = versionJson,
                    hash = hash,
                    deleted = deleted,
                    updatedAt = updatedAt,
                ),
            )
        }
    }
}

@Database(
    entities = [
        LocalDeviceStateEntity::class,
        LocalCharacterEntity::class,
        LocalPersonaEntity::class,
        LocalConnectionProfileEntity::class,
        EntityHeadEntity::class,
        ChangeLogEntity::class,
    ],
    version = 1,
    exportSchema = true,
)
@TypeConverters(BoolConverters::class)
abstract class QingyuLocalDatabase : RoomDatabase() {
    abstract fun deviceDao(): LocalDeviceDao
    abstract fun characterDao(): LocalCharacterDao
    abstract fun personaDao(): LocalPersonaDao
    abstract fun connectionProfileDao(): LocalConnectionProfileDao
    abstract fun syncMetaDao(): LocalSyncMetaDao

    companion object {
        const val NAME = "qingyu-local.db"
    }
}
