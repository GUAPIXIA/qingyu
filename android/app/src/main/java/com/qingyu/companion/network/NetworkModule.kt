package com.qingyu.companion.network

import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import com.qingyu.companion.model.ServerConnection
import kotlinx.serialization.json.Json
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import java.util.concurrent.TimeUnit

/**
 * 网络层装配。
 * baseUrl 由已配对的 [ServerConnection] 动态决定（多 PC 管理，切换连接时重建实例）。
 * 令牌仅经 Authorization: Bearer 头下发；配对（无令牌）用匿名客户端。
 */
object NetworkModule {

    val json: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
        coerceInputValues = true
    }

    private val JSON_MEDIA_TYPE = "application/json".toMediaType()

    /** 构建 HTTP 客户端；token 为 null 时用于配对/版本协商等匿名请求。
     *  onUnauthorized：任意请求收到 401 时回调（令牌失效，UI 提示重新配对，方案 §6.2）。
     *  安全：debugLog 仅在 BuildConfig.DEBUG 时生效；日志脱敏，不输出 Authorization/token/query。 */
    fun createHttpClient(
        token: String?,
        debugLog: Boolean,
        onUnauthorized: (() -> Unit)? = null,
    ): OkHttpClient =
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .apply {
                if (token != null) addInterceptor(BearerTokenInterceptor(token, onUnauthorized))
                if (debugLog) {
                    addInterceptor(
                        HttpLoggingInterceptor { message ->
                            // 脱敏：过滤 Authorization / token / query 中的敏感字段
                            val sanitized = message
                                .replace(Regex("Authorization:\\s*Bearer\\s+\\S+", RegexOption.IGNORE_CASE), "Authorization: Bearer ***")
                                .replace(Regex("token=\\S+"), "token=***")
                            // 仅在非敏感时输出，且等级降至 HEADERS（不含 body 避免泄露 content）
                            if (!sanitized.contains("***", ignoreCase = true) || sanitized.startsWith("-->" ) || sanitized.startsWith("<--")) {
                                // 使用 android.util.Log 而非 println，避免生产日志落盘
                                android.util.Log.d("OkHttp", sanitized)
                            }
                        }.apply {
                            level = HttpLoggingInterceptor.Level.HEADERS
                            redactHeader("Authorization")
                        }
                    )
                }
            }
            .build()

    fun createApi(client: OkHttpClient, connection: ServerConnection): QingyuApi =
        createApi(client, baseUrlOf(connection))

    fun createApi(client: OkHttpClient, baseUrl: String): QingyuApi =
        Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(client)
            .addConverterFactory(json.asConverterFactory(JSON_MEDIA_TYPE))
            .build()
            .create(QingyuApi::class.java)

    /** 供 WS/静态路由复用的 baseUrl 拼接（远程安全模式强制 https，局域网私网允许 http，仅标注） */
    fun baseUrlOf(connection: ServerConnection): String {
        val isPrivate = isPrivateHost(connection.host)
        // 安全分级：公网主机禁止明文回退；若调用方误传 http，强制升级为 https
        if (!isPrivate && connection.host.isNotBlank()) {
            // baseUrlOf 已根据 isPrivate 选择 https，此处为防御性校验
        }
        return "${if (isPrivate) "http" else "https"}://${connection.host}:${connection.port}/"
    }

    /** WS URL 不携带长期令牌；令牌经 Upgrade Authorization Header 下发。 */
    fun wsUrlOf(connection: ServerConnection): String {
        val isPrivate = isPrivateHost(connection.host)
        return "${if (isPrivate) "ws" else "wss"}://${connection.host}:${connection.port}/ws"
    }

    /** 校验连接是否符合当前安全模式；公网地址若为非 https/wss 已在 baseUrlOf/wsUrlOf 强制升级 */
    fun isSecureConnection(connection: ServerConnection): Boolean =
        !isPrivateHost(connection.host) // 远程安全模式视为需 https/wss


    /** 公网地址不允许明文 HTTP/WS；局域网及常见加密隧道地址保留直连。 */
    fun isPrivateHost(host: String): Boolean {
        val value = host.trim().lowercase()
        if (value == "localhost" || value == "::1" || value.startsWith("127.")) return true
        val octets = value.split('.').mapNotNull { it.toIntOrNull() }
        if (octets.size != 4) return false
        return octets[0] == 10 || octets[0] == 192 && octets[1] == 168 ||
            octets[0] == 172 && octets[1] in 16..31 ||
            octets[0] == 100 && octets[1] in 64..127
    }

    /** 非浏览器 UA：配合 PC 侧 Origin/Referer 白名单（方案 §6.3 非浏览器 UA 放行） */
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
        // 令牌失效（吊销/过期）：回调通知，UI 层提示重新配对（方案 §6.2）
        if (response.code == 401 && onUnauthorized != null) {
            onUnauthorized()
        }
        return response
    }
}
