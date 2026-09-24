package com.qingyu.companion.network.sync

import com.qingyu.companion.synccore.crypto.SyncCrypto
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicReference

/**
 * 阶段 8 S8-04：Android ServerTransport。
 *
 * - 用户点击后才建 session / plan / push / pull / commit；
 * - 未点击不预连、不刷 token；
 * - 加密在进入 transport 前完成；解密只在本地 staging；
 * - access token 单飞刷新；非 retryable 不盲重试。
 */
class ServerSyncTransport(
    private val baseUrl: String,
    private val accessTokenProvider: suspend () -> String,
    private val refreshAccessToken: (suspend () -> String)? = null,
    private val http: HttpExecutor = UrlHttpExecutor(),
    private val retryBaseMs: Long = 200L,
    private val maxRetries: Int = 4,
) {

    fun interface HttpExecutor {
        fun execute(method: String, url: String, headers: Map<String, String>, body: String?): Pair<Int, String>
    }

    class ServerTransportException(
        val code: String,
        message: String,
        val retryable: Boolean,
        val requestId: String? = null,
    ) : Exception(message)

    data class WireEntity(
        val entityType: String,
        val entityId: String,
        val parentId: String?,
        val schemaVersion: Int,
        val version: Map<String, String>,
        val versionHash: String,
        val dotDevice: String,
        val dotCounter: String,
        val deleted: Boolean,
        val updatedAt: Long,
        val keyEpoch: Int,
        val cipherRevision: Int,
        val cipherHash: String,
        val contentTag: String,
        val ciphertext: String? = null,
        val blobManifestId: String? = null,
        val serverSeq: String? = null,
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("entityType", entityType)
            put("entityId", entityId)
            put("parentId", parentId ?: JSONObject.NULL)
            put("schemaVersion", schemaVersion)
            put("version", JSONObject(version as Map<*, *>))
            put("versionHash", versionHash)
            put("dot", JSONObject().put("deviceId", dotDevice).put("counter", dotCounter))
            put("deleted", deleted)
            put("updatedAt", updatedAt)
            put("keyEpoch", keyEpoch)
            put("cipherRevision", cipherRevision)
            put("cipherHash", cipherHash)
            put("contentTag", contentTag)
            if (ciphertext != null) put("ciphertext", ciphertext)
            if (blobManifestId != null) put("blobManifestId", blobManifestId)
        }

        companion object {
            fun fromJson(o: JSONObject): WireEntity {
                val version = mutableMapOf<String, String>()
                val vo = o.getJSONObject("version")
                for (k in vo.keys()) version[k] = vo.getString(k)
                val dot = o.getJSONObject("dot")
                return WireEntity(
                    entityType = o.getString("entityType"),
                    entityId = o.getString("entityId"),
                    parentId = if (o.isNull("parentId")) null else o.getString("parentId"),
                    schemaVersion = o.getInt("schemaVersion"),
                    version = version,
                    versionHash = o.getString("versionHash"),
                    dotDevice = dot.getString("deviceId"),
                    dotCounter = dot.getString("counter"),
                    deleted = o.getBoolean("deleted"),
                    updatedAt = o.getLong("updatedAt"),
                    keyEpoch = o.getInt("keyEpoch"),
                    cipherRevision = o.getInt("cipherRevision"),
                    cipherHash = o.getString("cipherHash"),
                    contentTag = o.getString("contentTag"),
                    ciphertext = if (o.has("ciphertext") && !o.isNull("ciphertext")) o.getString("ciphertext") else null,
                    blobManifestId = if (o.has("blobManifestId") && !o.isNull("blobManifestId")) o.getString("blobManifestId") else null,
                    serverSeq = if (o.has("serverSeq")) o.getString("serverSeq") else null,
                )
            }
        }
    }

    private val refreshOnce = AtomicReference<suspend () -> String?>(null)

    @Volatile
    private var aborted = false

    fun cancel() {
        aborted = true
    }

    private fun assertNotCancelled() {
        if (aborted) throw ServerTransportException("CANCELLED", "已取消", retryable = false)
    }

    private suspend fun singleFlightRefresh(): String {
        val refresh = refreshAccessToken ?: throw ServerTransportException("UNAUTHORIZED", "需要刷新 token", true)
        return refresh()
    }

    private suspend fun request(method: String, path: String, body: JSONObject? = null, retried: Boolean = false): JSONObject {
        assertNotCancelled()
        var lastError: ServerTransportException? = null
        var attempt = 0
        while (attempt <= maxRetries) {
            assertNotCancelled()
            try {
                val token = accessTokenProvider()
                val headers = mapOf(
                    "Authorization" to "Bearer $token",
                    "Content-Type" to "application/json",
                )
                val (status, text) = http.execute(method, baseUrl.trimEnd('/') + path, headers, body?.toString())
                val json = if (text.isBlank()) JSONObject() else JSONObject(text)
                if (status == 401 && refreshAccessToken != null && !retried) {
                    singleFlightRefresh()
                    return request(method, path, body, retried = true)
                }
                if (status !in 200..299) {
                    val err = json.optJSONObject("error")
                    val code = err?.optString("code") ?: "NON_RETRYABLE"
                    val retryable = err?.optBoolean("retryable") ?: false
                    val mapped = when (code) {
                        "QUOTA_EXCEEDED" -> "QUOTA_EXCEEDED"
                        "SESSION_EXPIRED" -> "SESSION_EXPIRED"
                        "DEVICE_REVOKED" -> "DEVICE_REVOKED"
                        "BATCH_REPLAY_MISMATCH" -> "BATCH_REPLAY_MISMATCH"
                        "HASH_MISMATCH" -> "HASH_MISMATCH"
                        "INVALID_TOKEN" -> "UNAUTHORIZED"
                        else -> "NON_RETRYABLE"
                    }
                    val exception = ServerTransportException(
                        mapped,
                        err?.optString("message") ?: "HTTP $status",
                        retryable,
                        err?.optString("requestId"),
                    )
                    if (!retryable) throw exception
                    lastError = exception
                } else {
                    return json
                }
            } catch (e: ServerTransportException) {
                if (!e.retryable) throw e
                lastError = e
            } catch (_: IOException) {
                lastError = ServerTransportException("NETWORK", "网络错误", retryable = true)
            }
            if (attempt < maxRetries) {
                delay(retryBaseMs shl attempt)
            }
            attempt++
        }
        throw lastError ?: ServerTransportException("NETWORK", "重试耗尽", retryable = true)
    }

    suspend fun createSession(deviceId: String, knownVersions: Map<String, String> = emptyMap()): JSONObject {
        val body = JSONObject().put("protocolVersion", 1).put("deviceId", deviceId)
        if (knownVersions.isNotEmpty()) body.put("knownVersions", JSONObject(knownVersions as Map<*, *>))
        return request("POST", "/sync/v1/sessions", body)
    }

    suspend fun getSession(sessionId: String): JSONObject =
        request("GET", "/sync/v1/sessions/$sessionId")

    suspend fun plan(sessionId: String, knownVersions: Map<String, String> = emptyMap()): JSONObject {
        val body = JSONObject()
        if (knownVersions.isNotEmpty()) body.put("knownVersions", JSONObject(knownVersions as Map<*, *>))
        return request("POST", "/sync/v1/sessions/$sessionId/plan", body)
    }

    suspend fun push(sessionId: String, batchId: String, envelopes: List<WireEntity>): JSONObject {
        val arr = JSONArray()
        envelopes.forEach { arr.put(it.toJson()) }
        val body = JSONObject().put("batchId", batchId).put("envelopes", arr)
        return request("POST", "/sync/v1/sessions/$sessionId/push", body)
    }

    suspend fun pull(sessionId: String, cursor: String? = null, limit: Int = 200): JSONObject {
        val body = JSONObject()
        if (cursor != null) body.put("cursor", cursor)
        body.put("limit", limit)
        return request("POST", "/sync/v1/sessions/$sessionId/pull", body)
    }

    suspend fun commit(sessionId: String, vector: Map<String, String>): JSONObject {
        val body = JSONObject().put("vector", JSONObject(vector as Map<*, *>))
        return request("POST", "/sync/v1/sessions/$sessionId/commit", body)
    }

    suspend fun abort(sessionId: String): JSONObject =
        request("DELETE", "/sync/v1/sessions/$sessionId")

    /**
     * 完整服务器同步流。encrypt/decrypt 由调用方注入。
     */
    suspend fun runSyncFlow(
        deviceId: String,
        knownVersions: Map<String, String> = emptyMap(),
        collectUpload: suspend () -> List<WireEntity>,
        applyDownload: suspend (List<WireEntity>) -> Map<String, String>,
        onProgress: ((phase: String, sent: Int, received: Int) -> Unit)? = null,
        batchSize: Int = 200,
    ): JSONObject {
        onProgress?.invoke("session", 0, 0)
        val session = createSession(deviceId, knownVersions)
        val sessionId = session.getString("sessionId")
        onProgress?.invoke("plan", 0, 0)
        plan(sessionId, knownVersions)
        val upload = collectUpload()
        var sent = 0
        var batchIndex = 0
        var i = 0
        while (i < upload.size) {
            assertNotCancelled()
            val slice = upload.subList(i, minOf(i + batchSize, upload.size))
            onProgress?.invoke("push", sent, 0)
            push(sessionId, "up-$sessionId-$batchIndex", slice)
            sent += slice.size
            batchIndex++
            i += batchSize
        }
        var cursor: String? = null
        var downloaded = 0
        val all = mutableListOf<WireEntity>()
        while (true) {
            assertNotCancelled()
            val page = pull(sessionId, cursor)
            val arr = page.getJSONArray("envelopes")
            for (idx in 0 until arr.length()) {
                all.add(WireEntity.fromJson(arr.getJSONObject(idx)))
            }
            downloaded += arr.length()
            onProgress?.invoke("pull", sent, downloaded)
            cursor = page.getString("nextCursor")
            if (!page.getBoolean("hasMore")) break
        }
        onProgress?.invoke("validate", sent, downloaded)
        val vector = applyDownload(all)
        onProgress?.invoke("commit", sent, downloaded)
        val receipt = commit(sessionId, vector)
        onProgress?.invoke("done", sent, downloaded)
        return receipt
    }
}

/** 默认 HttpURLConnection 执行器（单测可替换） */
class UrlHttpExecutor : ServerSyncTransport.HttpExecutor {
    override fun execute(method: String, url: String, headers: Map<String, String>, body: String?): Pair<Int, String> {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 15_000
            conn.readTimeout = 60_000
            headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
            if (body != null) {
                conn.doOutput = true
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            return status to text
        } finally {
            conn.disconnect()
        }
    }
}
