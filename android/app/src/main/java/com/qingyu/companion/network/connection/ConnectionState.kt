package com.qingyu.companion.network.connection

/**
 * 连接失败原因（B-01）：从异常/协议结果归一化的封闭枚举，
 * UI 与重连策略只依赖本类型，不再拼接原始异常文本。
 */
sealed interface FailureReason {
    /** 无任何可用网络（ConnectivityManager 判定） */
    data object NoNetwork : FailureReason

    /** DNS 解析失败 */
    data object Dns : FailureReason

    /** TCP 连接被拒/不可达 */
    data object Tcp : FailureReason

    /** TLS 握手失败（证书链/协议不兼容） */
    data object Tls : FailureReason

    /** 探测/握手超时 */
    data object Timeout : FailureReason

    /** 应答者不是目标 PC（serverId 不匹配）或 PC 服务已停止 */
    data object ServerStopped : FailureReason

    /** WebSocket 建立后被关闭/读失败 */
    data object WsClosed : FailureReason

    data object Unknown : FailureReason
}

/**
 * 需要用户介入修复的原因（B-01）：不可通过自动重连恢复。
 */
sealed interface RepairReason {
    /** 令牌失效（REST/WS 401/403，PC 吊销或过期） */
    data object Unauthorized : RepairReason

    /** PC 服务器指纹变化（疑似中间人或重装） */
    data object FingerprintChanged : RepairReason

    /** API 版本不兼容（需要升级某一侧） */
    data object ApiIncompatible : RepairReason

    /** 证书变化（阶段 D pinning 后使用） */
    data object CertificateChanged : RepairReason
}

/**
 * 连接全生命周期状态（B-01）：把「存了哪个 PC / 当前尝试哪个地址 / WS 状态 / 为何失败」
 * 收敛为 [ConnectionCoordinator] 的单一状态流。
 * UI（阶段 B 后由主代理接线）只消费本状态，不自行拼接网络错误。
 */
sealed interface ConnectionState {
    /** 未配对/未选择连接 */
    data object Idle : ConnectionState

    /** 已选定目标设备，正在收集候选端点 */
    data class Discovering(val deviceId: String) : ConnectionState

    /** 候选端点竞速探测中 */
    data class Probing(val deviceId: String, val candidates: List<ConnectionEndpoint>) : ConnectionState

    /** 配对请求挂起等待 PC 端人工确认（expiresAt = epoch millis） */
    data class AwaitingApproval(val serverName: String, val expiresAt: Long) : ConnectionState

    /** 端点已选定，REST 鉴权握手中（回填 serverId/capabilities） */
    data class Authenticating(val endpoint: ConnectionEndpoint) : ConnectionState

    /** WebSocket 建链中 */
    data class ConnectingRealtime(val endpoint: ConnectionEndpoint) : ConnectionState

    data class Connected(
        val deviceId: String,
        val endpoint: ConnectionEndpoint,
        /** 建链成功时刻（epoch millis） */
        val connectedAt: Long,
        /** 最近一次往返时延（探测 RTT，millis） */
        val rttMs: Long,
    ) : ConnectionState

    /** Relay 返回缓存响应，PC 当前不在线。 */
    data class UsingCache(val cacheAgeMs: Long, val pcOnline: Boolean = false) : ConnectionState

    /** REST 与 WS 可用性不一致（如 WS 掉线但 REST 仍通） */
    data class Degraded(val restAvailable: Boolean, val wsAvailable: Boolean, val reason: FailureReason) : ConnectionState

    /** 自动重连等待中（attempt 从 1 起；nextAttemptAt = epoch millis） */
    data class Reconnecting(val attempt: Int, val nextAttemptAt: Long, val reason: FailureReason) : ConnectionState

    /** 自动重连无法恢复，需用户重新配对/确认 */
    data class NeedsRepair(val deviceId: String, val reason: RepairReason) : ConnectionState
}
