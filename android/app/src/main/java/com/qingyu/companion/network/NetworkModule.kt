package com.qingyu.companion.network

import com.qingyu.companion.network.connection.EndpointNormalizer
import kotlinx.serialization.json.Json
import okhttp3.ConnectionPool
import okhttp3.Dispatcher
import okhttp3.Dns
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.logging.HttpLoggingInterceptor
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * 网络层装配：仅保留共享网络栈（Dispatcher / ConnectionPool / Dns）与安全拦截器。
 * 旧伴侣 REST/WS/Relay 工厂已按 S9-07 删除。
 */
class NetworkStack(
    val dispatcher: Dispatcher = Dispatcher().apply {
        maxRequests = 8
        maxRequestsPerHost = 4
    },
    val connectionPool: ConnectionPool = ConnectionPool(5, 60L, TimeUnit.SECONDS),
    val dns: Dns = Dns.SYSTEM,
    private val debugLog: Boolean = false,
) {
    val baseClient: OkHttpClient = OkHttpClient.Builder()
        .dispatcher(dispatcher)
        .connectionPool(connectionPool)
        .dns(dns)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    fun restClient(
        tokenProvider: () -> String?,
        onUnauthorized: (() -> Unit)? = null,
    ): OkHttpClient = baseClient.newBuilder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(DynamicBearerInterceptor(tokenProvider, onUnauthorized))
        .apply { maybeLog(debugLog) }
        .addInterceptor(RedirectPolicyInterceptor())
        .build()

    fun restClient(
        token: String?,
        debugLog: Boolean,
        onUnauthorized: (() -> Unit)? = null,
    ): OkHttpClient = baseClient.newBuilder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .apply {
            if (token != null) addInterceptor(BearerTokenInterceptor(token, onUnauthorized))
            if (debugLog) maybeLog(true)
        }
        .addInterceptor(RedirectPolicyInterceptor())
        .build()

    fun mediaClient(): OkHttpClient = baseClient.newBuilder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(RedirectPolicyInterceptor())
        .build()

    private fun OkHttpClient.Builder.maybeLog(enabled: Boolean) {
        if (!enabled) return
        addInterceptor(
            HttpLoggingInterceptor { message ->
                val sanitized = message
                    .replace(Regex("Authorization:\\s*Bearer\\s+\\S+", RegexOption.IGNORE_CASE), "Authorization: Bearer ***")
                    .replace(Regex("token=\\S+"), "token=***")
                if (!sanitized.contains("***", ignoreCase = true) || sanitized.startsWith("-->") || sanitized.startsWith("<--")) {
                    android.util.Log.d("OkHttp", sanitized)
                }
            }.apply {
                level = HttpLoggingInterceptor.Level.HEADERS
                redactHeader("Authorization")
            },
        )
    }
}

object NetworkModule {

    val sharedStack: NetworkStack by lazy { NetworkStack() }

    val json: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
        coerceInputValues = true
    }

    fun createHttpClient(
        token: String?,
        debugLog: Boolean,
        onUnauthorized: (() -> Unit)? = null,
    ): OkHttpClient = sharedStack.restClient(token, debugLog, onUnauthorized)

    fun isPrivateHost(host: String): Boolean = EndpointNormalizer.isLocalHost(host)

    const val USER_AGENT = "qingyu-companion-android/0.1"
}

private class BearerTokenInterceptor(
    private val token: String,
    private val onUnauthorized: (() -> Unit)? = null,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request().newBuilder()
            .header("Authorization", "Bearer $token")
            .header("User-Agent", NetworkModule.USER_AGENT)
            .build()
        val response = chain.proceed(request)
        if (response.code == 401 && onUnauthorized != null) {
            onUnauthorized()
        }
        return response
    }
}

private class DynamicBearerInterceptor(
    private val tokenProvider: () -> String?,
    private val onUnauthorized: (() -> Unit)? = null,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val builder = chain.request().newBuilder()
            .header("User-Agent", NetworkModule.USER_AGENT)
        tokenProvider()?.takeIf { it.isNotBlank() }?.let {
            builder.header("Authorization", "Bearer $it")
        }
        val response = chain.proceed(builder.build())
        if (response.code == 401 && onUnauthorized != null) onUnauthorized()
        return response
    }
}

internal class RedirectPolicyInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        var request = chain.request()
        var response = chain.proceed(request)
        var hops = 0
        while (isRedirect(response.code) && hops < MAX_REDIRECTS) {
            val location = response.header("Location")?.trim().orEmpty()
            val target = location.takeIf { it.isNotEmpty() }?.let { request.url.resolve(it) }
            if (target == null ||
                !EndpointNormalizer.decideRedirectAllowed(request.url.toString(), target.toString())
            ) {
                response.close()
                throw IOException("重定向被安全策略拒绝: ${request.url} -> $location")
            }
            val builder = request.newBuilder().url(target)
            if (target.host != request.url.host) builder.removeHeader("Authorization")
            response.close()
            request = builder.build()
            response = chain.proceed(request)
            hops++
        }
        return response
    }

    private fun isRedirect(code: Int): Boolean =
        code == 301 || code == 302 || code == 303 || code == 307 || code == 308

    private companion object {
        const val MAX_REDIRECTS = 5
    }
}
