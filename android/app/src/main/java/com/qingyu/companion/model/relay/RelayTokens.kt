package com.qingyu.companion.model.relay

import kotlinx.serialization.Serializable

@Serializable
data class RelayRefreshRequest(val refreshToken: String)

@Serializable
data class RelayTokens(
    val spaceId: String,
    val deviceId: String,
    val accessToken: String,
    val refreshToken: String,
    val accessTokenExpiresAt: Long,
    val tokenVersion: Int = 1,
)
