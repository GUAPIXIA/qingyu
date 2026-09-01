package com.qingyu.companion.network.relay

import com.qingyu.companion.model.relay.RelayStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.Interceptor
import okhttp3.Response

class RelayStatusStore {
    private val mutable = MutableStateFlow<RelayStatus>(RelayStatus.Disconnected)
    val state: StateFlow<RelayStatus> = mutable.asStateFlow()
    fun update(value: RelayStatus) { mutable.value = value }
}

class RelayCacheStatusInterceptor(private val store: RelayStatusStore) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val response = chain.proceed(chain.request())
        val source = response.header("X-Qingyu-Data-Source")
        val pcOnline = response.header("X-Qingyu-PC-Online")?.toBooleanStrictOrNull() ?: true
        if (source == "cache") {
            val seconds = response.header("X-Qingyu-Cache-Age")?.toLongOrNull()
            if (seconds == null || seconds < 0) store.update(RelayStatus.CacheExpired)
            else store.update(RelayStatus.UsingCache(seconds * 1000, pcOnline))
        } else store.update(RelayStatus.Live(pcOnline))
        return response
    }
}
