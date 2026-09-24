package com.qingyu.companion.network.sync

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * S7-05：[SyncHttpEngine] 的 OkHttp 实现。
 *
 * - 不携带 Bridge JWT（同步走 LAN 一次性授权会话）；
 * - 独立超时，与聊天 REST 分离；
 * - 复用 [NetworkStack.baseClient] 连接池可由调用方传入。
 */
class OkHttpSyncEngine(
    private val client: OkHttpClient = defaultSyncClient(),
) : SyncHttpEngine {

    override fun request(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: String?,
        timeoutMs: Long,
    ): SyncHttpResponse {
        val scoped = client.newBuilder()
            .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .connectTimeout(minOf(timeoutMs, 10_000), TimeUnit.MILLISECONDS)
            .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .build()
        val media = "application/json; charset=utf-8".toMediaType()
        val requestBody = when {
            body == null && method.equals("GET", ignoreCase = true) -> null
            body == null -> ByteArray(0).toRequestBody(null)
            else -> body.toRequestBody(media)
        }
        val builder = Request.Builder().url(url)
        for ((k, v) in headers) builder.header(k, v)
        builder.method(method.uppercase(), requestBody)
        scoped.newCall(builder.build()).execute().use { res ->
            return SyncHttpResponse(res.code, res.body?.string().orEmpty())
        }
    }

    companion object {
        fun defaultSyncClient(): OkHttpClient = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
    }
}

/** 同步专用 IOException 分类（便于 transport 标 retryable） */
class SyncHttpIoException(message: String, cause: Throwable? = null) : IOException(message, cause)
