package com.qingyu.companion.network

import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.network.connection.ConnectionLease
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * WebSocket 客户端。
 * 职责：通过不含令牌的 WS/WSS URL 与 Authorization Header 连接并分发事件。
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

    /**
     * 带连接租约的建链（B-05）：WS 回调与重连定时器校验 [lease]，
     * 旧代次事件不得驱动新连接状态。默认委托旧签名（测试替身兼容）。
     */
    suspend fun connect(connection: ServerConnection, lease: ConnectionLease) {
        connect(connection)
    }

    /** 主动断开并停止重连。 */
    fun disconnect()

    /** 停止当前生成（WS 帧 ai:stop，映射 PC 侧 abort）。 */
    suspend fun stopGeneration(requestId: String)

    /** 事件缺口计数：缓冲溢出丢弃的事件数（B-07 诊断；旧实现默认恒 0）。 */
    val eventGaps: StateFlow<Int>
        get() = _zeroEventGaps

    /**
     * F-03：事件丢弃对账请求（值为 sessionId）。
     * critical 事件（done/error/task 终态/checkpoint 等，chunk 除外）tryEmit 失败时发出；
     * 订阅方（AppContainer 接线到 ChatRepository.refreshSession）据此触发该会话 REST 重拉。
     * 默认实现为无输出的空流（旧替身无需改动）。
     */
    val reconciliationRequests: SharedFlow<String>
        get() = _emptyReconciliationRequests

    /**
     * F-01：发送 task:subscribe（载荷 { sessionIds, cursors }，对齐 taskWsAdapter）。
     * 仅当前连接 capabilities 含 task_events_v2 时发送并返回 true；订阅会被记住，
     * 断线重连成功（onOpen）后自动重发。false = 未连接/能力未命中，未发送。
     */
    suspend fun subscribeTasks(sessionIds: List<String>, cursors: Map<String, Long> = emptyMap()): Boolean = false

    /** 断网暂停重连循环（B-06；coordinator 驱动，旧实现默认无操作）。 */
    fun onNetworkLost() { }

    /** 网络恢复：取消退避立即重连（B-06；旧实现默认无操作）。 */
    fun onNetworkAvailable() { }
}

private val _zeroEventGaps: StateFlow<Int> by lazy {
    kotlinx.coroutines.flow.MutableStateFlow(0)
}

private val _emptyReconciliationRequests: SharedFlow<String> by lazy {
    kotlinx.coroutines.flow.MutableSharedFlow(
        replay = 0,
        extraBufferCapacity = 8,
        onBufferOverflow = kotlinx.coroutines.channels.BufferOverflow.DROP_OLDEST,
    )
}
