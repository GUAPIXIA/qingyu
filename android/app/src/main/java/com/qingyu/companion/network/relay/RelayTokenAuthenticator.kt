package com.qingyu.companion.network.relay

import okhttp3.Authenticator
import okhttp3.Request
import okhttp3.Response
import okhttp3.Route

/** Single-flight refresh; all concurrent 401 responses wait on the same monitor. */
class RelayTokenAuthenticator(
    private val provider: RelayTokenProvider,
    private val refresh: () -> String?,
    private val onInvalidated: () -> Unit,
) : Authenticator {
    private val lock = Any()

    override fun authenticate(route: Route?, response: Response): Request? {
        if (responseCount(response) > 1) { provider.invalidate(); onInvalidated(); return null }
        val failedToken = response.request.header("Authorization")?.removePrefix("Bearer ")
        val next = synchronized(lock) {
            provider.accessToken()?.takeIf { it.isNotBlank() && it != failedToken }
                ?: refresh()?.also(provider::update)
        }
        if (next.isNullOrBlank()) { provider.invalidate(); onInvalidated(); return null }
        return response.request.newBuilder().header("Authorization", "Bearer $next").build()
    }

    private fun responseCount(response: Response): Int {
        var count = 1; var prior = response.priorResponse
        while (prior != null) { count++; prior = prior.priorResponse }
        return count
    }
}
