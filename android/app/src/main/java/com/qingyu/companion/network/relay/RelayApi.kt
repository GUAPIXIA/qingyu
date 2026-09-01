package com.qingyu.companion.network.relay

import com.qingyu.companion.model.relay.RelayPairClaimRequest
import com.qingyu.companion.model.relay.RelayPairClaimResponse
import com.qingyu.companion.model.relay.RelayPairResult
import com.qingyu.companion.model.relay.RelayRefreshRequest
import com.qingyu.companion.model.relay.RelayTokens
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Path

interface RelayApi {
    @POST("pair-tickets/claim")
    suspend fun claim(@Body request: RelayPairClaimRequest): RelayPairClaimResponse

    @GET("pair-requests/{id}")
    suspend fun pairResult(@Path("id") id: String, @Header("Authorization") claimAuthorization: String): RelayPairResult

    @POST("tokens/refresh")
    suspend fun refresh(@Body request: RelayRefreshRequest): RelayTokens
}
