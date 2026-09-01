package com.qingyu.companion.network

import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.model.ConnectionMode
import com.qingyu.companion.network.relay.RelayUrlPolicy
import com.qingyu.companion.network.relay.RelayApi
import com.qingyu.companion.network.connection.ConnectionEndpoint
import com.qingyu.companion.network.connection.EndpointNormalizer
import com.qingyu.companion.network.connection.TransportSecurity
import kotlinx.serialization.json.Json
import okhttp3.ConnectionPool
import okhttp3.Dispatcher
import okhttp3.Dns
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * 网络层装配。
 * baseUrl 由已配对的 [ServerConnection] 动态决定（多 PC 管理，切换连接时重建实例）。
 * 令牌仅经 Authorization: Bearer 头下发；配对（无令牌）用匿名客户端。
 *
 * A-04：协议选择（http/ws vs https/wss）不再由本文件内联判断，
 * 统一收敛到 [ConnectionEndpoint]（经 [EndpointNormalizer] 规范化构造）——
 * 公网地址无法构造出 LOCAL_CLEARTEXT 端点，调用方无法手工拼出公网 http。
 * A-05：OkHttp 关闭自动重定向，由 [RedirectPolicyInterceptor] 依据
 * [EndpointNormalizer.decideRedirectAllowed] 逐跳校验后手动跟随。
 *
 * B-04：改为 [NetworkStack] 共享基础设施（Dispatcher / ConnectionPool / Dns 全局唯一），
 * REST / 配对 / 探测 / WS / Coil 全部从 [baseClient] 派生，
 * 复用连接与 DNS 缓存但不共享会互相踩踏的超时配置。
 * 注意：[RedirectPolicyInterceptor] 必须在各派生 client 的**最后**一个 addInterceptor
 * （最内层），保证跨主机跳转的 removeHeader("Authorization") 不被更外层的
 * Bearer 拦截器重新注入（沿用 A-05 的安全排序约束）。
 * [NetworkModule] 公开函数签名保持兼容（过渡期调用方零改动），内部委托 [sharedStack]。
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
    /** 公共底座：仅共享连接池/DNS/调度器与重定向关闭；拦截器由各派生 client 自行按序追加。 */
    val baseClient: OkHttpClient = OkHttpClient.Builder()
        .dispatcher(dispatcher)
        .connectionPool(connectionPool)
        .dns(dns)
        // 重定向安全：禁用内置自动跟随，交由 RedirectPolicyInterceptor 按策略跟随
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    /**
     * REST 客户端：[tokenProvider] 按请求读取当前令牌（B-04——认证拦截器
     * 每请求求值，切换连接/重配对后同一 client 实例不会用冻结的旧 token 发新请求）。
     */
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

    /** 兼容签名：固定令牌的 REST 客户端（token=null 即匿名）。 */
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

    /**
     * 配对客户端（B-03）：PC 端人工确认最长挂起 55s，
     * 必须独立长超时（read ≥ 90s），禁止复用 2s 短超时探测 client。
     */
    fun pairingClient(): OkHttpClient = baseClient.newBuilder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .apply { maybeLog(debugLog) }
        .addInterceptor(RedirectPolicyInterceptor())
        .build()

    /** 候选探测客户端（B-03）：单次探测 2s 封顶，失败即换下一候选。 */
    fun probeClient(): OkHttpClient = baseClient.newBuilder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(2, TimeUnit.SECONDS)
        .addInterceptor(RedirectPolicyInterceptor())
        .build()

    /** WS 客户端：长连接不设读超时，ping 探活；与 REST 共享连接池与 DNS。 */
    fun webSocketClient(): OkHttpClient = baseClient.newBuilder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    /** 媒体（Coil 图片）客户端：共享池，独立中等超时。 */
    fun mediaClient(): OkHttpClient = baseClient.newBuilder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(RedirectPolicyInterceptor())
        .build()

    private val stackMediaType = "application/json".toMediaType()

    fun api(client: OkHttpClient, endpoint: ConnectionEndpoint): QingyuApi =
        Retrofit.Builder()
            .baseUrl(endpoint.toHttpUrl())
            .client(client)
            .addConverterFactory(NetworkModule.json.asConverterFactory(stackMediaType))
            .build()
            .create(QingyuApi::class.java)

    fun api(client: OkHttpClient, connection: ServerConnection): QingyuApi =
        NetworkModule.createApi(client, NetworkModule.baseUrlOf(connection))

    /** Relay 控制面 API（配对/刷新）；与 Bridge 兼容网关使用不同固定前缀。 */
    fun relayApi(client: OkHttpClient, baseUrl: String): RelayApi =
        Retrofit.Builder()
            .baseUrl(RelayUrlPolicy.normalizeBaseUrl(baseUrl).newBuilder().encodedPath("/relay/v1/").build())
            .client(client)
            .addConverterFactory(NetworkModule.json.asConverterFactory(stackMediaType))
            .build()
            .create(RelayApi::class.java)

    private fun OkHttpClient.Builder.maybeLog(enabled: Boolean) {
        if (!enabled) return
        addInterceptor(
            HttpLoggingInterceptor { message ->
                // 脱敏：过滤 Authorization / token / query 中的敏感字段
                val sanitized = message
                    .replace(Regex("Authorization:\\s*Bearer\\s+\\S+", RegexOption.IGNORE_CASE), "Authorization: Bearer ***")
                    .replace(Regex("token=\\S+"), "token=***")
                if (!sanitized.contains("***", ignoreCase = true) || sanitized.startsWith("-->") || sanitized.startsWith("<--")) {
                    // 使用 android.util.Log 而非 println，避免生产日志落盘
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

    /** B-04 全局共享网络栈（AppContainer 自建实例注入；默认对象走这一份）。 */
    val sharedStack: NetworkStack by lazy { NetworkStack() }

    val json: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
        coerceInputValues = true
    }

    private val JSON_MEDIA_TYPE = "application/json".toMediaType()

    /** 构建 HTTP 客户端；token 为 null 时用于配对/版本协商等匿名请求。
     *  onUnauthorized：任意请求收到 401 时回调（令牌失效，UI 提示重新配对，方案 §6.2）。
     *  安全：debugLog 仅在 BuildConfig.DEBUG 时生效；日志脱敏，不输出 Authorization/token/query；
     *  重定向关闭自动跟随，经安全策略逐跳校验（拒绝降级到公网/非本地明文）。
     *  B-04：底层共享 [NetworkStack] 的 Dispatcher/ConnectionPool/Dns。 */
    fun createHttpClient(
        token: String?,
        debugLog: Boolean,
        onUnauthorized: (() -> Unit)? = null,
    ): OkHttpClient = sharedStack.restClient(token, debugLog, onUnauthorized)

    fun createApi(client: OkHttpClient, connection: ServerConnection): QingyuApi =
        createApi(client, baseUrlOf(connection))

    fun createApi(client: OkHttpClient, baseUrl: String): QingyuApi =
        Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(client)
            .addConverterFactory(json.asConverterFactory(JSON_MEDIA_TYPE))
            .build()
            .create(QingyuApi::class.java)

    /**
     * 从持久化连接配置规范化出端点（清洗 host、识别本地/公网、强制安全等级）。
     * B-02/B-05：若已回填上次成功端点（coordinator 竞速胜出后 copy 更新），
     * 优先使用它——PC 换 IP/端口后仍能用验证过的地址建链；旧记录无该字段时回退 host/port 合成。
     */
    fun endpointOf(connection: ServerConnection): ConnectionEndpoint =
        if (connection.mode == ConnectionMode.RELAY) {
            val url = RelayUrlPolicy.normalizeBaseUrl(requireNotNull(connection.relay) { "Relay 连接缺少元数据" }.baseUrl)
            ConnectionEndpoint(url.host, url.port, TransportSecurity.TLS_SYSTEM)
        } else connection.lastSuccessfulEndpoint ?: EndpointNormalizer.normalize(connection.host, connection.port)

    /** REST baseUrl 统一入口（Coil/TTS/静态资源同样只能经此取 URL）。 */
    fun httpBaseUrl(endpoint: ConnectionEndpoint): String = endpoint.toHttpUrl()

    /** WS URL 统一入口；不携带长期令牌，令牌经 Upgrade Authorization Header 下发。 */
    fun wsBaseUrl(endpoint: ConnectionEndpoint): String = endpoint.toWsUrl()

    /** 供 WS/静态路由复用的 baseUrl 拼接（协议由 EndpointPolicy 唯一裁决）。 */
    fun baseUrlOf(connection: ServerConnection): String = when (connection.mode) {
        ConnectionMode.LAN -> httpBaseUrl(endpointOf(connection))
        ConnectionMode.RELAY -> RelayUrlPolicy.bridgeBaseUrl(requireNotNull(connection.relay).baseUrl)
    }

    /** WS URL 不携带长期令牌；令牌经 Upgrade Authorization Header 下发。 */
    fun wsUrlOf(connection: ServerConnection): String = when (connection.mode) {
        ConnectionMode.LAN -> wsBaseUrl(endpointOf(connection))
        ConnectionMode.RELAY -> RelayUrlPolicy.androidWsUrl(requireNotNull(connection.relay).baseUrl)
    }

    /** 校验连接是否符合当前安全模式：非本地端点必须走 TLS（https/wss）。 */
    fun isSecureConnection(connection: ServerConnection): Boolean =
        endpointOf(connection).security != TransportSecurity.LOCAL_CLEARTEXT

    /**
     * 公网地址不允许明文 HTTP/WS；局域网及常见加密隧道地址保留直连。
     * 由 A-04 的 [EndpointNormalizer.isLocalHost] 取代（新增 IPv6 ULA/link-local、.local 识别），
     * 保留本函数仅为兼容既有调用方。
     */
    @Deprecated("由 EndpointPolicy（EndpointNormalizer + ConnectionEndpoint）取代，仅为兼容既有调用方保留")
    fun isPrivateHost(host: String): Boolean = EndpointNormalizer.isLocalHost(host)

    /** 非浏览器 UA：配合 PC 侧 Origin/Referer 白名单（方案 §6.3 非浏览器 UA 放行） */
    const val USER_AGENT = "qingyu-companion-android/0.1"
}

/** 固定令牌版（兼容既有测试与旧调用路径）。 */
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
        // 令牌失效（吊销/过期）：回调通知，UI 层提示重新配对（方案 §6.2）
        if (response.code == 401 && onUnauthorized != null) {
            onUnauthorized()
        }
        return response
    }
}

/**
 * 按请求求值的 Bearer 拦截器（B-04：认证信息不冻结在 client 构建时刻，
 * 与活跃连接状态配合，切换连接后不会用旧连接 token 发新请求）。
 * provider 返回 null/空白时以匿名身份发出。
 */
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

/**
 * 重定向安全策略（短期方案 §5 第 3 条）：
 * 自动跟随已关闭，3xx 必须经 [EndpointNormalizer.decideRedirectAllowed] 判定后手动跟随——
 * 拒绝明文跳到非本地（含 HTTPS→HTTP 降级、公网→本地跳转），跨主机跳转剥离 Authorization，
 * 防止长期令牌随重定向泄露给他机。
 */
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
            // 跨主机重定向不携带原凭据（防令牌泄露）
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
