package com.qingyu.companion.network.relay

import okhttp3.OkHttpClient
import okhttp3.Request

class RelayConnectionProbe(private val client: OkHttpClient) {
    fun isReady(baseUrl: String): Boolean {
        val url = RelayUrlPolicy.normalizeBaseUrl(baseUrl).newBuilder().encodedPath("/relay/v1/health/ready").build()
        return runCatching { client.newCall(Request.Builder().url(url).get().build()).execute().use { it.isSuccessful } }.getOrDefault(false)
    }
}
