package com.qingyu.companion.model.relay

import kotlinx.serialization.Serializable

@Serializable
data class RelayPairingQr(
    val version: Int,
    val scheme: String,
    val relayBaseUrl: String,
    val ticket: String,
    val displayName: String,
    val expiresAt: Long,
)

@Serializable
data class RelayPairClaimRequest(
    val ticket: String? = null,
    val code: String? = null,
    val deviceName: String,
    val deviceFingerprint: String,
)

@Serializable
data class RelayPairClaimResponse(val pairRequestId: String, val claimSecret: String)

@Serializable
data class RelayPairResult(
    val status: String,
    val spaceId: String? = null,
    val deviceId: String? = null,
    val accessToken: String? = null,
    val refreshToken: String? = null,
    val accessTokenExpiresAt: Long? = null,
)
