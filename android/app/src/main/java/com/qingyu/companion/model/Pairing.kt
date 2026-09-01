package com.qingyu.companion.model

import com.qingyu.companion.network.connection.ConnectionEndpoint
import com.qingyu.companion.network.connection.EndpointNormalizer
import kotlinx.serialization.Serializable

/**
 * 配对流程 DTO（方案 §5.1）。
 * 流程：扫码（{ host, port, fingerprint }，5 分钟有效）
 *   -> 携带设备名/指纹请求配对 -> PC 侧人工确认 -> 签发长期 JWT。
 */

/** 二维码解析结果 */
@Serializable
data class PairingQrPayload(
    val host: String,
    val port: Int,
    val fingerprint: String,
)

@Serializable
enum class ConnectionMode { LAN, RELAY }

@Serializable
data class RelayConnectionMeta(
    val baseUrl: String,
    val spaceId: String,
    val accessTokenExpiresAt: Long,
    val tokenGeneration: Long = 0,
)

/** POST /api/v1/auth/pair 请求 */
@Serializable
data class PairRequest(
    /** 扫码得到的一次性配对码 */
    val pairingCode: String,
    val deviceName: String,
    val deviceFingerprint: String,
)

/** POST /api/v1/auth/pair 响应 */
@Serializable
data class PairResponse(
    /** 长期设备令牌（JWT，绑定设备指纹） */
    val token: String,
    /** PC 端显示用的设备记录 ID，便于吊销 */
    val deviceId: String,
)

/**
 * 已配对的 PC 连接配置（本地持久化）
 *  - fingerprint：PC 侧服务器公钥/设备指纹（非本机随机 UUID），用于重连校验防中间人（路线图 4.3 命名区分）
 *  - token：长期 JWT，已通过 Keystore 加密落盘（EncryptedSharedPreferences）
 *
 * B-02 扩充（全部带默认值，旧 JSON 记录可直接解码）：
 *  - serverId：PC 桥接层实例的稳定标识（跨 IP/端口变化识别同一台 PC）；
 *    旧记录为 null，仍使用 deviceId 作为本地索引，首次成功握手后回填。
 *  - endpoints：配对/发现阶段获得的候选端点集合（QR v2、mDNS、手动）。
 *  - lastSuccessfulEndpoint / lastConnectedAt：上次成功的规范化端点与时间戳，候选竞速优先探测。
 *  - capabilities：握手协商得到的能力集合（阶段 C 设置同步 v2 等）。
 * 读取阶段绝不删除旧 fingerprint / token / host / port（兼容基线）。
 */
@Serializable
data class ServerConnection(
    /** 用户自定义名称，如「家里的工作站」 */
    val name: String,
    val host: String,
    val port: Int,
    val token: String,
    val deviceId: String,
    /** PC 侧服务器公钥指纹（配对时记录，重连校验），与 DeviceIdentity.deviceInstallationId 区分 */
    val fingerprint: String,
    /** PC 实例稳定标识（/server/info 回填）；null = 旧记录尚未回填 */
    val serverId: String? = null,
    /** 配对协议版本（QR v2 / pair 响应协商），旧记录默认 1 */
    val pairingProtocolVersion: Int = 1,
    /** 候选端点集合（去重由 coordinator/probe 负责） */
    val endpoints: List<ConnectionEndpoint> = emptyList(),
    /** 上次成功建链的端点；候选竞速第一优先 */
    val lastSuccessfulEndpoint: ConnectionEndpoint? = null,
    /** 上次成功 Connected 的 epoch millis；0 = 从未成功 */
    val lastConnectedAt: Long = 0,
    /** PC 能力集合（握手回填） */
    val capabilities: Set<String> = emptySet(),
    /** 追加字段均带默认值，旧 ServerConnection JSON 自动按 LAN 读取。 */
    val mode: ConnectionMode = ConnectionMode.LAN,
    val relay: RelayConnectionMeta? = null,
) {
    /** host/port 合成的规范化端点（旧记录/未携带 endpoints 时的兜底候选）。 */
    val legacyEndpoint: ConnectionEndpoint
        get() = EndpointNormalizer.normalize(host, port)
}
