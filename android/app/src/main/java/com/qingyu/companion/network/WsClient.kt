package com.qingyu.companion.network

import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.ServerConnection
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * WebSocket 客户端。
 * 职责：连接 ws://host:port/ws?token=xxx，解析 WsEnvelope 并分发为 [CompanionEvent]。
 * 事件名一对一映射 IPC 事件（ai:chunk/ai:done/ai:error），
 * 外加 session:updated（依赖 PC 侧阶段 0c 事件总线）与心跳。
 *
 * 断线重连策略：指数退避（1s 起，封顶 30s）；弱网下 ai:chunk 由 UI 层批量渲染
 * （复用 PC 侧 chunkAccumulator 的节流思路，见方案 §8 风险表）。
 */
interface WsClient {

    enum class State { DISCONNECTED, CONNECTING, CONNECTED, RECONNECTING }

    /** 连接状态（驱动 UI 连接状态栏） */
    val state: StateFlow<State>

    /** 事件流：chunk/done/error/sessionUpdated。有订阅者期间缓存，无订阅者时丢弃。 */
    val events: SharedFlow<CompanionEvent>

    /** 建立（或切换到）与指定 PC 的连接。幂等：重复调用会先关闭旧连接。 */
    suspend fun connect(connection: ServerConnection)

    /** 主动断开并停止重连。 */
    fun disconnect()

    /** 停止当前生成（WS 帧 ai:stop，映射 PC 侧 abort）。 */
    suspend fun stopGeneration(requestId: String)
}
