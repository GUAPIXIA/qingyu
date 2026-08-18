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
     *  onUnauthorized：任意请求收到 401 时回调（令牌失效，UI 提示重新配对，方案 §6.2）。 */
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
                        HttpLoggingInterceptor().apply {
                            level = HttpLoggingInterceptor.Level.BASIC
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

    /** 供 WS/静态路由复用的 baseUrl 拼接 */
    fun baseUrlOf(connection: ServerConnection): String =
        "http://${connection.host}:${connection.port}/"

    /** WS 端点：令牌经 query 传递（PC 桥接层按 token 校验） */
    fun wsUrlOf(connection: ServerConnection): String =
        "ws://${connection.host}:${connection.port}/ws?token=${connection.token}"

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
