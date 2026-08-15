package com.qingyu.companion.data

import androidx.room.Database
import androidx.room.RoomDatabase

/**
 * 离线缓存数据库。
 * 定位（方案 §3.1 / §6.9）：仅缓存最近 N 条会话，断网可回看（只读）；
 * 支持"退出时清除"，不设云端备份。缓存是 PC 数据的只读快照，
 * 重连后以 PC 为准刷新。
 */
@Database(
    entities = [CachedSession::class, CachedMessage::class],
    // v2：CachedMessage 新增 usage 列（token 用量缓存）。缓存为只读快照，
    // schema 变更时经 fallbackToDestructiveMigration 清库重建（无需保留迁移）
    // v3：CachedSession 新增 characterName 列（全局会话列表展示角色名）
    version = 3,
    exportSchema = false,
)
abstract class CacheDatabase : RoomDatabase() {

    abstract fun sessionDao(): CachedSessionDao

    abstract fun messageDao(): CachedMessageDao

    companion object {
        const val DB_NAME = "qingyu-companion-cache"
        /** 最近会话缓存上限（方案 §6.9 数据最小化） */
        const val MAX_CACHED_SESSIONS = 10
    }
}
