package com.qingyu.companion.network.sync

/**
 * 阶段 7 S7-05：Android LAN 同步 transport（对接 PC `/sync/v1`）。
 *
 * - 不复用 Bridge JWT；鉴权经 LAN 一次性授权会话（scope=sync）。
 * - 分批上传/下载；同 batch 重试幂等（batchId + itemHash）。
 * - 退后台默认暂停；Doze/换网后从最后未提交 batch 安全重试。
 * - 连接前校验指纹；地址变化需重新确认。
 */
data class SyncEndpoint(
    val host: String,
    val port: Int,
    /** 服务器指纹（与 QR fingerprint 对齐；变化时必须重新确认） */
    val fingerprint: String,
    val security: SyncTransportSecurity = SyncTransportSecurity.LOCAL_CLEARTEXT,
)

enum class SyncTransportSecurity { LOCAL_CLEARTEXT, TLS }

data class SyncSessionHandle(
    val sessionId: String,
    val endpoint: SyncEndpoint,
)

data class SyncEnvelopeDto(
    val entityType: String,
    val entityId: String,
    val contentHash: String,
    val version: Map<String, String>,
    val deleted: Boolean,
    val schemaVersion: Int = 1,
    val parentId: String? = null,
    val payload: Map<String, Any?> = emptyMap(),
)

data class SyncBatch(
    val batchId: String,
    val sequence: Int,
    val envelopes: List<SyncEnvelopeDto>,
)

data class PullPage(
    val envelopes: List<SyncEnvelopeDto>,
    val nextCursor: String,
    val hasMore: Boolean,
)

sealed class SyncTransportResult<out T> {
    data class Ok<T>(val value: T) : SyncTransportResult<T>()
    data class Fail(val code: String, val retryable: Boolean, val message: String = "") : SyncTransportResult<Nothing>()
}

/** HTTP 接缝：生产接 OkHttp，测试用替身 */
interface SyncHttpEngine {
    fun request(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: String?,
        timeoutMs: Long = 30_000,
    ): SyncHttpResponse
}

data class SyncHttpResponse(val statusCode: Int, val body: String)

/**
 * 分批 + 同 batch 重试的同步客户端。
 *
 * 状态机与 PC `sessionMachine` 对齐：plan → confirm → push → prepare → commit。
 * 未提交 batch 记录在内存队列，断网/取消后可从 `pendingBatches` 续传。
 */
class LanSyncTransport(
    private val engine: SyncHttpEngine,
    private val maxBatchItems: Int = 500,
    private val maxBatchBytes: Int = 4 * 1024 * 1024,
) {
    private val pending = ArrayDeque<SyncBatch>()
    @Volatile
    private var paused = false

    fun pendingBatches(): List<SyncBatch> = pending.toList()

    fun pause() {
        paused = true
    }

    fun resume() {
        paused = false
    }

    fun isPaused(): Boolean = paused

    /** 按条数与字节上限拆批（先到为准） */
    fun splitBatches(envelopes: List<SyncEnvelopeDto>, idPrefix: String = "b"): List<SyncBatch> {
        val out = mutableListOf<SyncBatch>()
        var seq = 0
        var current = mutableListOf<SyncEnvelopeDto>()
        var bytes = 0
        fun flush() {
            if (current.isEmpty()) return
            out += SyncBatch(batchId = "$idPrefix-${seq}", sequence = seq, envelopes = current.toList())
            seq++
            current = mutableListOf()
            bytes = 0
        }
        for (env in envelopes) {
            val size = env.contentHash.length + env.entityId.length + 64
            if (current.size >= maxBatchItems || (bytes + size > maxBatchBytes && current.isNotEmpty())) {
                flush()
            }
            current += env
            bytes += size
        }
        flush()
        return out
    }

    fun baseUrl(endpoint: SyncEndpoint): String {
        val scheme = if (endpoint.security == SyncTransportSecurity.TLS) "https" else "http"
        val host = if (endpoint.host.contains(':')) "[${endpoint.host}]" else endpoint.host
        return "$scheme://${host}:${endpoint.port}/sync/v1"
    }

    /** 开 session（需已确认的 LAN 授权） */
    fun openSession(endpoint: SyncEndpoint, role: String = "android"): SyncTransportResult<SyncSessionHandle> {
        if (endpoint.fingerprint.isBlank()) {
            return SyncTransportResult.Fail("fingerprint_required", retryable = false)
        }
        return requestJson("POST", "${baseUrl(endpoint)}/session", """{"role":"$role"}""") { body ->
            val id = org.json.JSONObject(body).optString("sessionId")
            if (id.isNullOrEmpty()) SyncTransportResult.Fail("bad_session", retryable = false)
            else SyncTransportResult.Ok(SyncSessionHandle(id, endpoint))
        }
    }

    /**
     * 上传一批：同 batchId 幂等重试。
     * `maxAttempts` 含首次；网络/5xx 可重试，4xx 除 429 外不重试。
     */
    fun pushBatch(
        handle: SyncSessionHandle,
        batch: SyncBatch,
        maxAttempts: Int = 3,
    ): SyncTransportResult<String> {
        if (batch.envelopes.size > maxBatchItems) {
            return SyncTransportResult.Fail("batch_too_many", retryable = false)
        }
        // 先入队：暂停/断网后可从 pending 续传
        if (pending.none { it.batchId == batch.batchId }) pending.addLast(batch)
        if (paused) return SyncTransportResult.Fail("paused", retryable = true)
        val payload = org.json.JSONObject()
            .put("batchId", batch.batchId)
            .put("sequence", batch.sequence)
            .put("envelopes", org.json.JSONArray(batch.envelopes.map { encodeEnvelope(it) }))
            .toString()
        var last: SyncTransportResult<String> = SyncTransportResult.Fail("not_attempted", retryable = true)
        var attempt = 0
        while (attempt < maxAttempts) {
            attempt++
            last = requestJson("POST", "${baseUrl(handle.endpoint)}/session/${handle.sessionId}/push", payload) { body ->
                val json = org.json.JSONObject(body)
                SyncTransportResult.Ok(json.optString("itemHash", batch.batchId))
            }
            when (last) {
                is SyncTransportResult.Ok -> {
                    pending.removeAll { it.batchId == batch.batchId }
                    return last
                }
                is SyncTransportResult.Fail -> {
                    if (!last.retryable) return last
                }
            }
        }
        return last
    }

    fun prepare(handle: SyncSessionHandle, batchIds: List<String>): SyncTransportResult<Unit> {
        val payload = org.json.JSONObject().put("batchIds", org.json.JSONArray(batchIds)).toString()
        return requestJson("POST", "${baseUrl(handle.endpoint)}/session/${handle.sessionId}/prepare", payload) {
            SyncTransportResult.Ok(Unit)
        }
    }

    /** commit：响应丢失可用同 batch 重放（PC 侧 receipt 幂等） */
    fun commit(
        handle: SyncSessionHandle,
        batchId: String,
        peerId: String = "android",
        maxAttempts: Int = 3,
    ): SyncTransportResult<String> {
        val payload = org.json.JSONObject().put("batchId", batchId).put("peerId", peerId).toString()
        var last: SyncTransportResult<String> = SyncTransportResult.Fail("not_attempted", retryable = true)
        var attempt = 0
        while (attempt < maxAttempts) {
            attempt++
            last = requestJson("POST", "${baseUrl(handle.endpoint)}/session/${handle.sessionId}/commit", payload) { body ->
                val receipt = org.json.JSONObject(body).optJSONObject("receipt")
                SyncTransportResult.Ok(receipt?.optString("receiptId") ?: "committed")
            }
            when (last) {
                is SyncTransportResult.Ok -> return last
                is SyncTransportResult.Fail -> if (!last.retryable) return last
            }
        }
        return last
    }

    /**
     * 拉取对端增量（S7-04 pull；cursor 服务端签发，客户端不解析语义）。
     * 同 cursor 重试幂等。
     */
    fun pull(
        handle: SyncSessionHandle,
        cursor: String? = null,
        limit: Int = 200,
    ): SyncTransportResult<PullPage> {
        val payload = org.json.JSONObject()
            .put("limit", limit)
            .apply { if (cursor != null) put("cursor", cursor) }
            .toString()
        return requestJson("POST", "${baseUrl(handle.endpoint)}/session/${handle.sessionId}/pull", payload) { body ->
            val json = org.json.JSONObject(body)
            val arr = json.optJSONArray("envelopes") ?: org.json.JSONArray()
            val items = buildList {
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    val ver = mutableMapOf<String, String>()
                    val vo = o.optJSONObject("version")
                    if (vo != null) for (k in vo.keys()) ver[k] = vo.getString(k)
                    add(
                        SyncEnvelopeDto(
                            entityType = o.optString("entityType"),
                            entityId = o.optString("entityId"),
                            contentHash = o.optString("contentHash"),
                            version = ver,
                            deleted = o.optBoolean("deleted"),
                            schemaVersion = o.optInt("schemaVersion", 1),
                            parentId = if (o.isNull("parentId")) null else o.optString("parentId"),
                            payload = emptyMap(),
                        ),
                    )
                }
            }
            SyncTransportResult.Ok(
                PullPage(
                    envelopes = items,
                    nextCursor = json.optString("nextCursor", cursor ?: "0"),
                    hasMore = json.optBoolean("hasMore", false),
                ),
            )
        }
    }

    fun fetchReceipt(handle: SyncSessionHandle, batchId: String): SyncTransportResult<String> {
        return requestJson("GET", "${baseUrl(handle.endpoint)}/session/${handle.sessionId}/receipt/$batchId", null) { body ->
            val receipt = org.json.JSONObject(body).optJSONObject("receipt")
            if (receipt == null) SyncTransportResult.Fail("receipt_not_found", retryable = false)
            else SyncTransportResult.Ok(receipt.optString("receiptId"))
        }
    }

    private fun encodeEnvelope(env: SyncEnvelopeDto): org.json.JSONObject =
        org.json.JSONObject()
            .put("entityType", env.entityType)
            .put("entityId", env.entityId)
            .put("contentHash", env.contentHash)
            .put("version", org.json.JSONObject(env.version as Map<*, *>))
            .put("deleted", env.deleted)
            .put("schemaVersion", env.schemaVersion)
            .put("parentId", env.parentId)
            .put("payload", org.json.JSONObject(env.payload as Map<*, *>))

    private fun <T> requestJson(
        method: String,
        url: String,
        body: String?,
        parse: (String) -> SyncTransportResult<T>,
    ): SyncTransportResult<T> {
        return try {
            val res = engine.request(method, url, mapOf("content-type" to "application/json"), body)
            when {
                res.statusCode in 200..299 -> parse(res.body)
                res.statusCode == 429 || res.statusCode >= 500 ->
                    SyncTransportResult.Fail("http_${res.statusCode}", retryable = true)
                res.statusCode == 503 ->
                    SyncTransportResult.Fail("sync_dormant", retryable = true)
                else ->
                    SyncTransportResult.Fail("http_${res.statusCode}", retryable = false)
            }
        } catch (e: Exception) {
            SyncTransportResult.Fail("network:${e.javaClass.simpleName}", retryable = true, message = e.message ?: "")
        }
    }
}
