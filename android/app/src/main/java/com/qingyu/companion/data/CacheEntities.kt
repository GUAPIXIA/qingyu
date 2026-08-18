package com.qingyu.companion.data

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query

/**
 * 缓存实体：model 层 DTO 的持久化镜像。
 * 字段与 model/Session.kt、model/Message.kt 保持一致，
 * 转换逻辑在 Repository 实现（阶段一）。
 */

@Entity(tableName = "cached_sessions")
data class CachedSession(
    @PrimaryKey val id: String,
    val characterId: String,
    val characterName: String,
    val title: String,
    val createdAt: Long,
    val updatedAt: Long,
    val messageCount: Int,
    val lastMessage: String,
)

@Entity(tableName = "cached_messages")
data class CachedMessage(
    @PrimaryKey val id: String,
    val sessionId: String,
    val characterId: String,
    val role: String,
    val content: String,
    /** 图片 URL（JSON 数组字符串） */
    val images: String,
    val timestamp: Long,
    val translation: String?,
    val swipes: String?,
    val swipeIndex: Int?,
    val replyToId: String?,
    /** token 用量（JSON 字符串，可空） */
    val usage: String?,
)

@Dao
interface CachedSessionDao {

    @Query("SELECT * FROM cached_sessions ORDER BY updatedAt DESC")
    suspend fun listAll(): List<CachedSession>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(session: CachedSession)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(sessions: List<CachedSession>)

    @Query("DELETE FROM cached_sessions WHERE id = :sessionId")
    suspend fun delete(sessionId: String)

    @Query("DELETE FROM cached_sessions")
    suspend fun clear()

    /** 数据最小化：仅保留最近 [limit] 条会话 */
    @Query(
        "DELETE FROM cached_sessions WHERE id NOT IN " +
            "(SELECT id FROM cached_sessions ORDER BY updatedAt DESC LIMIT :limit)"
    )
    suspend fun trimTo(limit: Int)
}

@Dao
interface CachedMessageDao {

    @Query(
        "SELECT * FROM cached_messages WHERE sessionId = :sessionId " +
            "ORDER BY timestamp DESC LIMIT :limit"
    )
    suspend fun listRecent(sessionId: String, limit: Int): List<CachedMessage>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(messages: List<CachedMessage>)

    @Query("DELETE FROM cached_messages WHERE id = :messageId")
    suspend fun deleteById(messageId: String)

    @Query("DELETE FROM cached_messages WHERE sessionId = :sessionId")
    suspend fun deleteBySession(sessionId: String)

    @Query("DELETE FROM cached_messages")
    suspend fun clear()

    /** 单会话内仅保留最近 [limit] 条消息，避免缓存无限增长 */
    @Query(
        "DELETE FROM cached_messages WHERE sessionId = :sessionId AND id NOT IN " +
            "(SELECT id FROM cached_messages WHERE sessionId = :sessionId " +
            "ORDER BY timestamp DESC LIMIT :limit)"
    )
    suspend fun trimTo(sessionId: String, limit: Int)

    /** M-34 修复：删除无对应会话的孤儿消息（会话裁剪后调用，防消息表含聊天明文只增不减） */
    @Query(
        "DELETE FROM cached_messages WHERE sessionId NOT IN (SELECT id FROM cached_sessions)"
    )
    suspend fun deleteOrphanMessages()
}
