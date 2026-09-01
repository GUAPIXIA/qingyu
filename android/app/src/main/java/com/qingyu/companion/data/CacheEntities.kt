package com.qingyu.companion.data

import androidx.room.ColumnInfo
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

/**
 * 发件箱：持久化待发送消息，App 被杀/断网后可恢复（P1-4.1 B1-2）。
 * 对齐 PC TaskStore：requestId 幂等。
 *
 * v5（F-03/F-05 schema 扩列）：PC 隔离（deviceId）与发送链路标识列。
 *
 * F-04 八态状态机（OutboxStateMachine 为唯一写入权威，见 data/send/）：
 * ```
 * queued ──sending(开始发送)──▶ sending ──PC 确认用户消息落盘(remoteUserMessageId)──▶ user_committed
 *   ▲                             │                                                  │
 *   │ 重试(failed_send→queued)    │发送失败                                          │任务开始(taskId)
 *   └─────────────────────────────┘                                                  ▼
 *                                     completed ◀──生成完成── awaiting_ai ◀──────────┘
 *                                   （completed 保留短期审计记录，clearCompleted 清理）
 * 发送失败→failed_send；生成失败→failed_generation；取消→cancelled。
 * ```
 * 列语义（v5 全部接线）：
 * - deviceId：归属 PC；写入当前连接 id；'legacy' = 无法确定归属（不得自动发送，F-04 归属修复）
 * - remoteUserMessageId：PC 已确认落盘的用户消息 id（幂等/对账）
 * - taskId：PC 端生成任务 id（生成重试/取消/事件补拉）
 * - lastErrorCode/lastErrorMessage：最后失败原因（脱敏，不含 token/正文）
 * - updatedAt：每次状态转换刷新；nextAttemptAt：失败退避调度时间点
 * - error 列为 v4 遗留，保留 schema 兼容，F-04 起不再写入（统一 lastError*）
 */
@Entity(tableName = "outbox_messages")
data class OutboxMessage(
    @PrimaryKey val requestId: String,
    val sessionId: String,
    val content: String,
    /** 图片：JSON 数组字符串（临时文件路径或 base64，读取时按需解析） */
    val imagesJson: String,
    val replyToId: String?,
    val createdAt: Long,
    val retryCount: Int = 0,
    /** queued|sending|relay_queued|user_committed|awaiting_ai|completed|failed_send|failed_generation|cancelled */
    val state: String,
    /** v4 遗留列，F-04 起不再写入（保留 schema 兼容，统一 lastError*） */
    val error: String? = null,
    // ---------- v5 新增列（F-03/F-05）：新行走 Kotlin 默认值；v4 老行由 MIGRATION_4_5 回填 ----------
    /** 归属 PC 设备；v4 老行迁移后为 'legacy'，待 F-04 启动归属修复回填 */
    @ColumnInfo(defaultValue = "legacy")
    val deviceId: String = "legacy",
    val characterId: String? = null,
    /** 行最后更新时间；迁移旧行回填 0，发送链路维护时间戳归 F-04 */
    @ColumnInfo(defaultValue = "0")
    val updatedAt: Long = 0,
    /** 下次重试时间（F-04 重试调度用） */
    val nextAttemptAt: Long? = null,
    /** PC 已确认落盘的用户消息 id（去重/对账，F-04 接线） */
    val remoteUserMessageId: String? = null,
    /** PC 端生成任务 id（AI 阶段重试/取消，F-04 接线） */
    val taskId: String? = null,
    val lastErrorCode: String? = null,
    val lastErrorMessage: String? = null,
)

@Dao
interface OutboxDao {
    @Query("SELECT * FROM outbox_messages WHERE sessionId = :sessionId ORDER BY createdAt ASC")
    suspend fun listForSession(sessionId: String): List<OutboxMessage>

    @Query("SELECT * FROM outbox_messages WHERE sessionId = :sessionId ORDER BY createdAt ASC")
    fun observeForSession(sessionId: String): kotlinx.coroutines.flow.Flow<List<OutboxMessage>>

    @Query("SELECT * FROM outbox_messages ORDER BY createdAt ASC")
    suspend fun listAll(): List<OutboxMessage>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(item: OutboxMessage)

    @Query("SELECT * FROM outbox_messages WHERE requestId = :requestId")
    suspend fun getById(requestId: String): OutboxMessage?

    @Query("UPDATE outbox_messages SET state = :state, error = :error, retryCount = :retryCount WHERE requestId = :requestId")
    suspend fun updateState(requestId: String, state: String, error: String?, retryCount: Int)

    @Query("DELETE FROM outbox_messages WHERE requestId = :requestId")
    suspend fun delete(requestId: String)

    @Query("DELETE FROM outbox_messages WHERE sessionId = :sessionId AND state = 'completed'")
    suspend fun clearCompleted(sessionId: String)

    @Query("DELETE FROM outbox_messages WHERE state = 'completed'")
    suspend fun clearAllCompleted()

    @Query("DELETE FROM outbox_messages WHERE sessionId NOT IN (SELECT id FROM cached_sessions)")
    suspend fun deleteOrphan()

    @Query("DELETE FROM outbox_messages")
    suspend fun clear()

    /** 未完成态全集（F-04 八态；completed/cancelled 为终态不入列） */
    @Query(
        "SELECT * FROM outbox_messages WHERE state IN " +
            "('queued','sending','relay_queued','user_committed','awaiting_ai','failed_send','failed_generation') " +
            "ORDER BY createdAt ASC"
    )
    suspend fun listPending(): List<OutboxMessage>

    /** 指定 PC 的未完成行（切 PC 隔离：只发送/展示归属当前活跃设备的行） */
    @Query(
        "SELECT * FROM outbox_messages WHERE deviceId = :deviceId AND state IN " +
            "('queued','sending','relay_queued','user_committed','awaiting_ai','failed_send','failed_generation') " +
            "ORDER BY createdAt ASC"
    )
    suspend fun listPendingForDevice(deviceId: String): List<OutboxMessage>

    /** 无法确定归属（'legacy'）的未完成行——不得自动发送，仅提示用户选择目标 PC（F-04） */
    @Query(
        "SELECT * FROM outbox_messages WHERE deviceId = 'legacy' AND state IN " +
            "('queued','sending','relay_queued','user_committed','awaiting_ai','failed_send','failed_generation') " +
            "ORDER BY createdAt ASC"
    )
    suspend fun listLegacyPending(): List<OutboxMessage>

    @Query(
        "SELECT COUNT(*) FROM outbox_messages WHERE deviceId = 'legacy' AND state IN " +
            "('queued','sending','relay_queued','user_committed','awaiting_ai','failed_send','failed_generation')"
    )
    suspend fun countLegacyPending(): Int

    /**
     * F-04 启动归属修复：一次性把 deviceId='legacy' 且仍在排队中的行回填为当前活跃 PC。
     * 只改归属与时间戳，不改状态/内容——修复后各行照常走各自状态的重试/恢复路径。
     */
    @Query(
        "UPDATE outbox_messages SET deviceId = :deviceId, updatedAt = :now WHERE deviceId = 'legacy' AND state IN " +
            "('queued','sending','relay_queued','user_committed','awaiting_ai','failed_send','failed_generation')"
    )
    suspend fun adoptLegacyPending(deviceId: String, now: Long): Int
}

/**
 * F-02：task 事件 cursor（Room v6）。
 * 以 (deviceId, taskId) 复合主键——cursor 绑定 PC，切换 PC 不共享（各 PC 的 sequence 空间独立）。
 * 处理规则（TaskCursorLogic，纯函数）：
 * - sequence == last + 1：应用并更新 cursor
 * - sequence <= last：重复事件，忽略
 * - sequence > last + 1：暂停应用，REST 补拉 /api/v2/tasks/:taskId/events?afterSequence=last
 * - 补拉仍缺失：取 task 快照（checkpoint/最终结果）兜底
 */
@Entity(tableName = "task_cursors", primaryKeys = ["deviceId", "taskId"])
data class TaskCursorEntity(
    val deviceId: String,
    val taskId: String,
    val sessionId: String,
    val lastSequence: Long,
    val updatedAt: Long,
)

@Dao
interface TaskCursorDao {
    @Query("SELECT * FROM task_cursors WHERE deviceId = :deviceId AND taskId = :taskId")
    suspend fun get(deviceId: String, taskId: String): TaskCursorEntity?

    @Query("SELECT * FROM task_cursors WHERE deviceId = :deviceId")
    suspend fun listForDevice(deviceId: String): List<TaskCursorEntity>

    @Query("SELECT * FROM task_cursors WHERE deviceId = :deviceId AND sessionId = :sessionId")
    suspend fun listForSession(deviceId: String, sessionId: String): List<TaskCursorEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(cursor: TaskCursorEntity)

    @Query("DELETE FROM task_cursors WHERE deviceId = :deviceId")
    suspend fun clearDevice(deviceId: String)

    @Query("DELETE FROM task_cursors")
    suspend fun clear()
}

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
