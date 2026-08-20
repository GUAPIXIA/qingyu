package com.qingyu.companion.model

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

/** 已配对的 PC 连接配置（本地持久化）
 *  - fingerprint：PC 侧服务器公钥/设备指纹（非本机随机 UUID），用于重连校验防中间人（路线图 4.3 命名区分）
 *  - token：长期 JWT，已通过 Keystore 加密落盘（EncryptedSharedPreferences）
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
)
