package com.qingyu.companion.data

import com.qingyu.companion.model.ServerConnection

/**
 * 已配对连接持久化。
 * 实现见 DataStoreConnectionStore（DataStore Preferences）：JWT 与设备指纹序列化存储。
 * 注意：令牌绑定设备指纹（方案 §6.2）；本文件不含任何密钥材料入库。
 */
interface ConnectionStore {

    suspend fun loadAll(): List<ServerConnection>

    suspend fun save(connection: ServerConnection)

    suspend fun remove(deviceId: String)

    /** 记住上次使用的连接，启动时自动激活 */
    suspend fun setActive(deviceId: String?)

    suspend fun getActive(): ServerConnection?

    /** "退出时清除"：删除全部连接与缓存（方案 §6.9） */
    suspend fun wipe()
}
