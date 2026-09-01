package com.qingyu.companion.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/**
 * QR v2 解析（实施文档 §8 D-02/D-03，纯函数 + DTO；接线归 ui/pairing 并行代理）。
 *
 * 双格式兼容：
 * - v2：`{ version:2, scheme:"qingyu-pair", serverId, displayName, apiVersion,
 *   capabilities, pairingCode, expiresAt, endpoints:[{host,port,security}], certificatePin }`
 * - 旧格式：`{ host, port, fingerprint }`（无 version 字段 → 按 legacy 解码 [PairingQrPayload]）
 *
 * 校验顺序（D-03 步骤 1）：JSON 可解析 → version → scheme → 有效期 → endpoints
 * → pairingCode 非空。serverId 只用于稳定识别，不是密码（D-01）。
 * 本文件不改动 Pairing.kt 与 ui/pairing 包（其他代理所有权），供其直接调用。
 */

@Serializable
data class PairingQrV2Endpoint(
    val host: String,
    val port: Int,
    /** LOCAL_CLEARTEXT / TLS_SYSTEM / TLS_PINNED（与 network/connection/TransportSecurity 对齐的字符串） */
    val security: String? = null,
)

@Serializable
data class PairingQrV2Payload(
    val version: Int = 2,
    val scheme: String = SCHEME,
    val serverId: String = "",
    val displayName: String = "",
    val apiVersion: Int = 1,
    val capabilities: Set<String> = emptySet(),
    val pairingCode: String = "",
    val expiresAt: Long = 0L,
    val endpoints: List<PairingQrV2Endpoint> = emptyList(),
    val certificatePin: String? = null,
) {
    companion object {
        const val SCHEME = "qingyu-pair"
        const val VERSION = 2
    }
}

/** 解析结果：v2 / legacy / 非法（携带原因供 UI 文案） */
sealed interface PairingQrResult {
    data class V2(val payload: PairingQrV2Payload) : PairingQrResult
    data class Legacy(val payload: PairingQrPayload) : PairingQrResult
    data class Invalid(val reason: PairingQrInvalidReason, val detail: String = "") : PairingQrResult
}

enum class PairingQrInvalidReason {
    NOT_JSON,
    VERSION_UNSUPPORTED,
    SCHEME_MISMATCH,
    EXPIRED,
    NO_VALID_ENDPOINT,
    MISSING_PAIRING_CODE,
    LEGACY_INCOMPLETE,
}

/**
 * 解析配对二维码（不抛异常；所有失败路径归入 [PairingQrResult.Invalid]）。
 * @param now 当前毫秒（注入便于测试过期判定）
 */
fun parsePairingQr(raw: String, json: Json, now: Long = System.currentTimeMillis()): PairingQrResult {
    val root = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull()
        ?: return PairingQrResult.Invalid(PairingQrInvalidReason.NOT_JSON)

    val versionEl = (root["version"] as? JsonPrimitive)?.intOrNull
    return when {
        // 无 version 字段：旧格式 { host, port, fingerprint }
        versionEl == null -> {
            val legacy = runCatching { json.decodeFromJsonElement(PairingQrPayload.serializer(), root) }
                .getOrNull()
            if (legacy == null || legacy.host.isBlank() || legacy.port !in 1..65535) {
                PairingQrResult.Invalid(PairingQrInvalidReason.LEGACY_INCOMPLETE)
            } else {
                PairingQrResult.Legacy(legacy)
            }
        }
        // 有 version 但不是 2：明确拒绝（未来版本不误当旧格式）
        versionEl != PairingQrV2Payload.VERSION ->
            PairingQrResult.Invalid(PairingQrInvalidReason.VERSION_UNSUPPORTED, "v$versionEl")
        else -> {
            val payload = runCatching {
                json.decodeFromJsonElement(PairingQrV2Payload.serializer(), root)
            }.getOrNull()
                ?: return PairingQrResult.Invalid(PairingQrInvalidReason.NOT_JSON, "v2 schema")
            when {
                payload.scheme != PairingQrV2Payload.SCHEME ->
                    PairingQrResult.Invalid(PairingQrInvalidReason.SCHEME_MISMATCH, payload.scheme)
                // expiresAt>0 才校验（0 = 不过期，PC 可不填）
                payload.expiresAt in 1 until now ->
                    PairingQrResult.Invalid(PairingQrInvalidReason.EXPIRED)
                payload.endpoints.none { it.host.isNotBlank() && it.port in 1..65535 } ->
                    PairingQrResult.Invalid(PairingQrInvalidReason.NO_VALID_ENDPOINT)
                payload.pairingCode.isBlank() ->
                    PairingQrResult.Invalid(PairingQrInvalidReason.MISSING_PAIRING_CODE)
                else -> PairingQrResult.V2(payload)
            }
        }
    }
}

/** v2 载荷中第一个可用 endpoint（UI 连接目标；调用方再按 TransportSecurity 规范化） */
fun PairingQrV2Payload.firstUsableEndpoint(): PairingQrV2Endpoint? =
    endpoints.firstOrNull { it.host.isNotBlank() && it.port in 1..65535 }
