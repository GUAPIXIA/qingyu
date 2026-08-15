package com.qingyu.companion.network

import com.qingyu.companion.model.ServerConnection
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * 多 PC 连接管理。
 * 职责：
 * - 维护已配对设备列表（持久化于 data 层）
 * - 切换当前活跃连接时重建 Retrofit/WS 实例
 * - 暴露连接状态供 UI 状态栏与断线重连提示
 * - 重连时校验 fingerprint（防中间人，方案 §6.8）
 */
interface ConnectionManager {

    /** 当前活跃连接（null = 未配对/未选择） */
    val activeConnection: ServerConnection?

    /** 活跃连接的响应式流，供 UI 观察 */
    val activeFlow: StateFlow<ServerConnection?>

    /** 令牌失效事件（401，PC 端吊销/过期）：UI 提示重新配对（方案 §6.2） */
    val tokenInvalidated: SharedFlow<Unit>

    /** 启动时从持久化恢复上次连接并自动建链 */
    suspend fun restore()

    suspend fun listConnections(): List<ServerConnection>

    /** 扫码/手动输 IP 配对成功后保存并激活 */
    suspend fun addConnection(connection: ServerConnection)

    suspend fun switchTo(deviceId: String)

    /** PC 端吊销或用户主动移除 */
    suspend fun remove(deviceId: String)

    /** M-31 修复：退出时清除——断开活跃连接与 WS（wipeLocalData 使用，彻底断开不再重连） */
    suspend fun disconnectAll()

    /** 版本协商：启动时校验 X-Api-Version 兼容性（方案 §4.3） */
    suspend fun checkCompatibility(connection: ServerConnection): CompatibilityResult

    /** 当前活跃连接的鉴权 API（无活跃连接返回 null） */
    fun activeApi(): QingyuApi?

    /** 匿名 API（配对前 serverInfo/pair 使用） */
    fun anonApi(connection: ServerConnection): QingyuApi

    sealed interface CompatibilityResult {
        data object Compatible : CompatibilityResult

        /** PC 不可达（桥接未开/网络不通），与版本不兼容区分开 */
        data object Unreachable : CompatibilityResult

        /** 需要升级哪一侧 */
        data class UpgradeRequired(val side: Side) : CompatibilityResult

        enum class Side { ANDROID, PC }
    }
}
