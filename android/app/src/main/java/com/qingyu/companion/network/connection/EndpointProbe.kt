package com.qingyu.companion.network.connection

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.qingyu.companion.model.ServerConnection
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/**
 * 候选端点来源（B-03 优先级标注）。
 */
enum class CandidateOrigin {
    /** 上次成功端点：立即探测，最高优先 */
    LAST_SUCCESS,

    /** 配对时 QR/保存的端点 */
    QR,

    /** mDNS 当前发现 */
    MDNS,

    /** 用户手动输入 */
    MANUAL,

    /** 旧记录 host/port 合成兜底 */
    LEGACY,
}

/** 带来源标注的候选端点。 */
data class RankedEndpoint(
    val endpoint: ConnectionEndpoint,
    val origin: CandidateOrigin,
)

/**
 * 探测结果（GET /api/v1/server/info 轻量握手）。
 * [serverId]/[capabilities] 为 PC 回填字段；旧版 PC 未实现时为 null（未知 ≠ 不匹配）。
 */
data class ProbeOutcome(
    val endpoint: ConnectionEndpoint,
    val success: Boolean,
    val rttMs: Long,
    val serverId: String? = null,
    val apiVersion: Int? = null,
    val appVersion: String? = null,
    val capabilities: Set<String> = emptySet(),
    val failureReason: FailureReason? = null,
)

sealed interface ProbeRaceResult {
    data class Winner(val outcome: ProbeOutcome) : ProbeRaceResult

    /** 全部候选失败；[failures] 按探测顺序记录（空 = 无候选）。 */
    data class NoCandidate(val failures: List<ProbeOutcome>) : ProbeRaceResult
}

/**
 * 候选集合构建（纯函数，JVM 可测）。
 * 规则（B-03）：
 * - 顺序：上次成功 → QR/保存 endpoints → mDNS 发现 → 手动 → 旧 host/port 兜底；
 * - 按 host + port + security 去重，保留先出现（高优先）的来源。
 */
object EndpointCandidates {

    fun dedupeKey(endpoint: ConnectionEndpoint): String =
        "${endpoint.host.lowercase()}|${endpoint.port}|${endpoint.security}"

    fun build(
        connection: ServerConnection?,
        discovered: List<ConnectionEndpoint> = emptyList(),
        manual: ConnectionEndpoint? = null,
    ): List<RankedEndpoint> {
        val ranked = mutableListOf<RankedEndpoint>()
        val seen = HashSet<String>()

        fun add(endpoint: ConnectionEndpoint, origin: CandidateOrigin) {
            if (!seen.add(dedupeKey(endpoint))) return
            ranked += RankedEndpoint(endpoint, origin)
        }

        if (connection != null) {
            connection.lastSuccessfulEndpoint?.let { add(it, CandidateOrigin.LAST_SUCCESS) }
            connection.endpoints.forEach { add(it, CandidateOrigin.QR) }
        }
        discovered.forEach { add(it, CandidateOrigin.MDNS) }
        manual?.let { add(it, CandidateOrigin.MANUAL) }
        if (connection != null) {
            // 旧记录（或 endpoint 字段缺失）时 host/port 合成兜底；不删旧数据
            runCatching { add(connection.legacyEndpoint, CandidateOrigin.LEGACY) }
        }
        return ranked
    }

    /**
     * serverId 匹配判定：observed=null 表示旧版 PC 未上报（未知，不作拒绝依据）；
     * expected=null 表示本地记录尚未回填。两者之外必须严格相等——
     * “响应快”但 serverId 不同的候选（另一台 PC 恰好同 IP）绝不能胜出。
     */
    fun serverIdMatches(expected: String?, observed: String?): Boolean =
        expected == null || observed == null || expected == observed
}

/**
 * 候选竞速（B-03）：
 * - 第一候选（上次成功）立即探测；
 * - 其余延迟 [staggerMs]（默认 150ms）并发启动，在途 ≤ [maxInFlight]（默认 3）；
 * - 首个 serverId 匹配的成功候选胜出并取消其余；
 * - 探测超时由注入的 [probe] 实现自行保证（OkHttp 实现单次 ~2s）。
 *
 * [probe] 抽象出来使竞速调度可 JVM 单测（虚拟时间）。
 */
class EndpointProber(
    private val probe: suspend (ConnectionEndpoint) -> ProbeOutcome,
    private val staggerMs: Long = 150L,
    private val maxInFlight: Int = 3,
) {
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    suspend fun race(
        candidates: List<RankedEndpoint>,
        expectedServerId: String?,
    ): ProbeRaceResult = coroutineScope {
        if (candidates.isEmpty()) return@coroutineScope ProbeRaceResult.NoCandidate(emptyList())
        val winner = CompletableDeferred<ProbeOutcome>()
        val failures = mutableListOf<ProbeOutcome>()
        val failuresLock = Any()
        val permits = Semaphore(maxInFlight.coerceAtLeast(1))
        val jobs = candidates.mapIndexed { index, ranked ->
            async {
                // 第一候选（上次成功）立即探测；其余错峰 150ms 启动（B-03）
                if (index > 0) delay(staggerMs)
                if (winner.isCompleted) return@async null
                permits.withPermit {
                    if (winner.isCompleted) return@withPermit
                    val outcome = runCatching { probe(ranked.endpoint) }
                        .getOrElse {
                            ProbeOutcome(
                                endpoint = ranked.endpoint,
                                success = false,
                                rttMs = 0,
                                failureReason = classifyProbeFailure(it),
                            )
                        }
                    if (outcome.success && EndpointCandidates.serverIdMatches(expectedServerId, outcome.serverId)) {
                        winner.complete(outcome)
                    } else {
                        val rejected = if (outcome.success) {
                            // 响应成功但身份不符：视为未送达目标 PC，不得因快而接受
                            outcome.copy(success = false, failureReason = FailureReason.ServerStopped)
                        } else {
                            outcome
                        }
                        synchronized(failuresLock) { failures += rejected }
                    }
                }
                null
            }
        }
        // 全体失败时不挂死：等全部 job 结束后以 NoCandidate 收敛
        val all = async { jobs.forEach { it.await() } }
        val result = kotlinx.coroutines.selects.select<ProbeRaceResult> {
            winner.onAwait { ProbeRaceResult.Winner(winner.getCompleted()!!) }
            all.onAwait { ProbeRaceResult.NoCandidate(synchronized(failuresLock) { failures.toList() }) }
        }
        if (result is ProbeRaceResult.Winner) {
            // 先取消汇总 job，再取消落选探测（顺序反了会让 all 的 await 抛 CE 使 scope 失败）
            all.cancel()
            jobs.forEach { it.cancel() }
        }
        result
    }

    private fun classifyProbeFailure(t: Throwable): FailureReason = classifyThrowable(t)

    companion object {
        /** 异常 → FailureReason 归一化（纯函数，JVM 可测）。 */
        fun classifyThrowable(t: Throwable): FailureReason = when {
            t is SocketTimeoutException -> FailureReason.Timeout
            t is UnknownHostException -> FailureReason.Dns
            t is SSLException -> FailureReason.Tls
            t is ConnectException || t is NoRouteToHostException -> FailureReason.Tcp
            else -> FailureReason.Unknown
        }
    }
}

/**
 * 真实探测：轻量 `GET /api/v1/server/info`（匿名，无 Authorization）。
 * 不经过 QingyuApi（探测专用短超时 client 由 NetworkStack.probeClient 提供）。
 */
@Serializable
private data class ServerInfoProbeResponse(
    val apiVersion: Int? = null,
    val appVersion: String? = null,
    val serverId: String? = null,
    val capabilities: List<String>? = null,
)

class HttpEndpointProber(
    private val client: OkHttpClient,
    private val path: String = "api/v1/server/info",
) {
    suspend fun probe(endpoint: ConnectionEndpoint): ProbeOutcome = withContext(Dispatchers.IO) {
        val startedAt = System.nanoTime()
        val request = Request.Builder()
            .url(endpoint.toHttpUrl().removeSuffix("/") + "/" + path)
            .header("User-Agent", PROBE_UA)
            .get()
            .build()
        try {
            client.newCall(request).execute().use { response ->
                val rtt = (System.nanoTime() - startedAt) / 1_000_000
                if (!response.isSuccessful) {
                    ProbeOutcome(endpoint, success = false, rttMs = rtt, failureReason = FailureReason.ServerStopped)
                } else {
                    val body = response.body?.string().orEmpty()
                    val parsed = runCatching {
                        PROBE_JSON.decodeFromString(ServerInfoProbeResponse.serializer(), body)
                    }.getOrNull()
                    if (parsed == null) {
                        // 应答存在但不是本服务的 JSON（端口被其他程序占用）
                        ProbeOutcome(endpoint, success = false, rttMs = rtt, failureReason = FailureReason.ServerStopped)
                    } else {
                        ProbeOutcome(
                            endpoint = endpoint,
                            success = true,
                            rttMs = rtt,
                            serverId = parsed.serverId,
                            apiVersion = parsed.apiVersion,
                            appVersion = parsed.appVersion,
                            capabilities = parsed.capabilities?.toSet() ?: emptySet(),
                        )
                    }
                }
            }
        } catch (t: Throwable) {
            val rtt = (System.nanoTime() - startedAt) / 1_000_000
            Log.w(
                "QingyuEndpointProbe",
                "Probe failed endpoint=${endpoint.host}:${endpoint.port} " +
                    "type=${t::class.java.simpleName} message=${t.message}",
            )
            ProbeOutcome(endpoint, success = false, rttMs = rtt, failureReason = EndpointProber.classifyThrowable(t))
        }
    }

    private companion object {
        const val PROBE_UA = "qingyu-companion-android-probe/0.1"
        val PROBE_JSON = kotlinx.serialization.json.Json {
            ignoreUnknownKeys = true
            isLenient = true
        }
    }
}
