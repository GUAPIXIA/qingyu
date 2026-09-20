package com.qingyu.companion.network.models

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 阶段 3 S3-05：模型直连执行层。
 *
 * - 不依赖 PC：Android 直接访问用户配置的模型服务（总方案 §3.3「不用 Relay RPC 模拟独立 Android」）。
 * - 流式与非流式共用同一 adapter、同一请求构造与认证头（连接测试 = 真实生成路径）。
 * - 可取消：返回 [ModelRequestHandle]，`cancel()` 立即中止 socket。
 * - 错误分类统一映射为 [ModelError]（`retryable` 决定重试策略）。
 */
class ModelClient(
    private val client: OkHttpClient = defaultClient(),
) {

    /** 流式生成（无需句柄时使用）。 */
    fun stream(
        adapter: ModelAdapter,
        profile: ConnectionProfilePublic,
        request: ModelChatRequest,
        apiKey: String?,
    ): Flow<ModelStreamEvent> = streamWithHandle(adapter, profile, request, apiKey).first

    /** 流式生成 + 可取消句柄。 */
    fun streamWithHandle(
        adapter: ModelAdapter,
        profile: ConnectionProfilePublic,
        request: ModelChatRequest,
        apiKey: String?,
    ): Pair<Flow<ModelStreamEvent>, ModelRequestHandle> {
        var activeCall: Call? = null
        val cancelled = AtomicBoolean(false)
        val handle = object : ModelRequestHandle {
            override fun cancel() {
                cancelled.set(true)
                activeCall?.cancel()
            }

            override val isCancelled: Boolean get() = cancelled.get()
        }
        val flow = streamInternal(adapter, profile, request, apiKey, cancelled) { activeCall = it }
        return flow to handle
    }

    /** 非流式请求（连接测试 / `stream = false`）。 */
    suspend fun complete(
        adapter: ModelAdapter,
        profile: ConnectionProfilePublic,
        request: ModelChatRequest,
        apiKey: String?,
    ): ModelStreamEvent = withContext(Dispatchers.IO) completeBlock@{
        val built = try {
            adapter.buildChatRequest(profile, request.copy(stream = false), apiKey)
        } catch (e: IllegalArgumentException) {
            return@completeBlock ModelStreamEvent.Failure(
                ModelError("INVALID_CONFIG", e.message ?: "配置非法", retryable = false),
            )
        }
        try {
            client.newCall(built.toRequest()).execute().use { response ->
                if (!response.isSuccessful) {
                    ModelStreamEvent.Failure(httpError(response.code, response.body?.string()))
                } else {
                    val body = response.body?.string().orEmpty()
                    if (body.isEmpty()) {
                        ModelStreamEvent.Failure(ModelError("EMPTY_RESPONSE", "响应为空", retryable = true))
                    } else {
                        adapter.parseNonStreamingBody(body)
                    }
                }
            }
        } catch (e: Exception) {
            ModelStreamEvent.Failure(e.toModelError())
        }
    }

    /**
     * 连接测试：走与真实生成**完全相同**的 adapter / 认证头 / base URL 规范化路径。
     * 只发一条最小消息，验收「能连上、能返回、能解析」。
     */
    suspend fun testConnection(
        adapter: ModelAdapter,
        profile: ConnectionProfilePublic,
        request: ModelChatRequest,
        apiKey: String?,
    ): ConnectionTestResult {
        val started = System.currentTimeMillis()
        val event = complete(adapter, profile, request, apiKey)
        val latency = System.currentTimeMillis() - started
        return when (event) {
            is ModelStreamEvent.Chunk ->
                ConnectionTestResult(ok = true, latencyMs = latency, capabilities = adapter.capabilities())
            is ModelStreamEvent.Completed ->
                ConnectionTestResult(ok = true, latencyMs = latency, capabilities = adapter.capabilities())
            is ModelStreamEvent.Failure -> ConnectionTestResult(
                ok = false,
                latencyMs = latency,
                capabilities = adapter.capabilities(),
                error = event.error,
            )
        }
    }

    // ---------------------------------------------------------------- 内部

    private fun streamInternal(
        adapter: ModelAdapter,
        profile: ConnectionProfilePublic,
        request: ModelChatRequest,
        apiKey: String?,
        cancelled: AtomicBoolean,
        onCall: (Call) -> Unit,
    ): Flow<ModelStreamEvent> = callbackFlow streamBlock@{
        val built = try {
            adapter.buildChatRequest(profile, request.copy(stream = true), apiKey)
        } catch (e: IllegalArgumentException) {
            trySend(ModelStreamEvent.Failure(ModelError("INVALID_CONFIG", e.message ?: "配置非法", retryable = false)))
            close()
            return@streamBlock
        }
        val call = client.newCall(built.toRequest())
        onCall(call)
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                // 用户取消：不发出业务错误事件，直接结束流；调用方用 handle.isCancelled 区分。
                if (!cancelled.get()) {
                    trySend(ModelStreamEvent.Failure(e.toModelError()))
                }
                close()
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { res ->
                    if (cancelled.get()) {
                        close()
                        return
                    }
                    if (!res.isSuccessful) {
                        trySend(ModelStreamEvent.Failure(httpError(res.code, res.body?.string())))
                        close()
                        return
                    }
                    val source = res.body?.source()
                    if (source == null) {
                        trySend(ModelStreamEvent.Failure(ModelError("EMPTY_RESPONSE", "响应为空", retryable = true)))
                        close()
                        return
                    }
                    val terminal = readStream(adapter, source, cancelled) { event -> trySend(event) }
                    if (!terminal && !cancelled.get()) {
                        trySend(ModelStreamEvent.Completed(finishReason = "eof", usage = null))
                    }
                    close()
                }
            }
        })
        awaitClose { cancelled.set(true); call.cancel() }
    }

    /**
     * 读取 SSE / NDJSON 流。
     *
     * 分片边界规则（S3-05 要求覆盖「分片边界」）：
     * - `readUtf8Line()` 保证跨 socket 分片的行被正确拼接，只在完整行上返回；
     * - SSE 允许一条物理行内出现多个 `data:` 事件（供应商压缩换行时常见），
     *   因此再按 `data:` 边界二次切分，逐条交给 adapter；
     * - 无换行的供应商（部分兼容网关）在流结束时由 `readUtf8Line()` 返回残余行，不丢内容。
     *
     * 返回是否观察到显式完成事件。
     */
    private fun readStream(
        adapter: ModelAdapter,
        source: okio.BufferedSource,
        cancelled: AtomicBoolean,
        emit: (ModelStreamEvent) -> Unit,
    ): Boolean {
        var terminal = false
        while (!cancelled.get()) {
            val line = try {
                source.readUtf8Line() ?: break
            } catch (e: Exception) {
                if (!cancelled.get()) emit(ModelStreamEvent.Failure(e.toModelError()))
                break
            }
            if (line.isBlank()) continue
            for (fragment in splitSseFragments(line)) {
                when (val event = adapter.parseSseLine(fragment)) {
                    is ModelStreamEvent.Chunk -> {
                        if (event.value.finished) terminal = true
                        emit(event)
                    }
                    is ModelStreamEvent.Completed -> {
                        terminal = true
                        emit(event)
                    }
                    is ModelStreamEvent.Failure -> {
                        // EMPTY_DELTA：SSE 心跳/角色帧，无正文也无用量，属于正常流内噪声
                        if (event.error.code != EMPTY_DELTA_CODE) {
                            terminal = true
                            emit(event)
                        }
                    }
                    null -> Unit
                }
            }
        }
        return terminal
    }

    /** 把「可能含多条 data: 事件」的物理行切成单条事件片段。 */
    private fun splitSseFragments(line: String): List<String> {
        val normalized = line.trimEnd('\r')
        if (!normalized.startsWith("data:")) return listOf(normalized)
        val marker = "data:"
        val occurrences = Regex(Regex.escape(marker)).findAll(normalized).count()
        if (occurrences <= 1) return listOf(normalized)
        val parts = mutableListOf<String>()
        var index = 0
        while (index < normalized.length) {
            val next = normalized.indexOf(marker, index + marker.length)
            if (next < 0) {
                parts += normalized.substring(index)
                break
            }
            parts += normalized.substring(index, next)
            index = next
        }
        return parts.map { it.trimEnd() }.filter { it.isNotBlank() }
    }
}

/** 由 [ModelClient.streamWithHandle] 暴露的取消句柄；此处不再定义额外事件类型。 */

/** 与 adapter 内部约定的「无内容增量」哨兵码；流式路径忽略，非流式路径转为空响应错误。 */
internal const val EMPTY_DELTA_CODE = OpenAiCompatibleAdapter.EMPTY_DELTA_CODE

internal fun BuiltHttpRequest.toRequest(): Request {
    val builder = Request.Builder().url(url)
    headers.forEach { (k, v) -> builder.header(k, v) }
    return builder.method(method, body.toRequestBody("application/json".toMediaType())).build()
}

internal fun httpError(status: Int, body: String?): ModelError {
    val detail = body?.let { extractJsonString(it, "message") }?.takeIf { it.isNotBlank() }
        ?: body?.take(200)?.takeIf { it.isNotBlank() }
        ?: ""
    val code = "HTTP_$status"
    val retryable = status == 408 || status == 409 || status == 425 || status == 429 || status >= 500
    return ModelError(code = code, message = detail.ifEmpty { "HTTP $status" }, retryable = retryable, httpStatus = status)
}

internal fun Throwable.toModelError(): ModelError = when (this) {
    is SocketTimeoutException -> ModelError("TIMEOUT", "请求超时", retryable = true)
    is UnknownHostException -> ModelError("DNS_FAILURE", "无法解析服务器地址", retryable = true)
    is IOException -> ModelError("IO_ERROR", message ?: "网络错误", retryable = true)
    else -> ModelError("UNKNOWN", message ?: this::class.simpleName ?: "未知错误", retryable = false)
}

internal fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(15, TimeUnit.SECONDS)
    // 流式生成首 token 可能较慢；readTimeout 只约束「两次读之间」的间隔
    .readTimeout(180, TimeUnit.SECONDS)
    .writeTimeout(60, TimeUnit.SECONDS)
    .callTimeout(0, TimeUnit.MILLISECONDS)
    // 认证头由 adapter 构造并逐请求校验；不跟随重定向，避免凭据被带到非预期主机
    .followRedirects(false)
    .followSslRedirects(false)
    .retryOnConnectionFailure(false)
    .build()
