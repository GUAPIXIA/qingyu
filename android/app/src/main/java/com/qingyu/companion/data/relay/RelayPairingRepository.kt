package com.qingyu.companion.data.relay

import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import com.qingyu.companion.model.relay.RelayPairClaimRequest
import com.qingyu.companion.model.relay.RelayPairResult
import com.qingyu.companion.model.relay.RelayPairingQr
import com.qingyu.companion.network.NetworkModule
import com.qingyu.companion.network.relay.RelayApi
import com.qingyu.companion.network.relay.RelayUrlPolicy
import kotlinx.coroutines.delay
import okhttp3.MediaType.Companion.toMediaType
import retrofit2.Retrofit

class RelayPairingRepository {
    fun parseQr(raw: String): RelayPairingQr {
        val qr = NetworkModule.json.decodeFromString(RelayPairingQr.serializer(), raw)
        require(qr.version == 1 && qr.scheme == "qingyu-relay-pair" && qr.expiresAt > System.currentTimeMillis()) { "服务器连接码无效或已过期" }
        RelayUrlPolicy.normalizeBaseUrl(qr.relayBaseUrl)
        return qr
    }

    suspend fun claimAndWait(baseUrl: String, ticket: String?, code: String?, deviceName: String, fingerprint: String): RelayPairResult {
        val api = api(baseUrl)
        val claim = api.claim(RelayPairClaimRequest(ticket, code, deviceName, fingerprint))
        val deadline = System.currentTimeMillis() + 60_000
        while (System.currentTimeMillis() < deadline) {
            val result = api.pairResult(claim.pairRequestId, "PairClaim ${claim.claimSecret}")
            if (result.status != "pending") return result
            delay(1_000)
        }
        throw IllegalStateException("电脑端确认超时")
    }

    private fun api(baseUrl: String): RelayApi = Retrofit.Builder()
        .baseUrl(RelayUrlPolicy.normalizeBaseUrl(baseUrl).newBuilder().encodedPath("/relay/v1/").build())
        .client(NetworkModule.sharedStack.pairingClient())
        .addConverterFactory(NetworkModule.json.asConverterFactory("application/json".toMediaType()))
        .build().create(RelayApi::class.java)
}
