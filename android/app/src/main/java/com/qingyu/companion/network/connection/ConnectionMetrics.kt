package com.qingyu.companion.network.connection

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/**
 * 单次连接尝试指标（B-07）。
 * 脱敏约束：不落 token / 配对码 / 消息正文；deviceId 以单向哈希存储，
 * endpointType 只存安全等级与主机哈希前缀，不存明文 host/port。
 */
data class ConnectionMetric(
    val attemptId: String,
    val deviceIdHash: String,
    /** epoch millis */
    val startedAt: Long,
    /** 例如 LOCAL_CLEARTEXT / TLS_SYSTEM（+端点来源） */
    val endpointType: String,
    val discoveryMs: Long?,
    val probeMs: Long?,
    val wsMs: Long?,
    /** connected / failed / needs_repair */
    val result: String,
    val failureReason: String?,
)

/** 指标存储抽象：内存实现供 JVM 测试与降级路径，文件实现供真机。 */
interface ConnectionMetricStore {
    suspend fun record(metric: ConnectionMetric)
    suspend fun recent(): List<ConnectionMetric>
}

/**
 * 环形缓冲（纯逻辑，JVM 可测）：仅保留最近 [capacity]（默认 100）条，超出丢最旧。
 */
class MetricRingBuffer(val capacity: Int = DEFAULT_CAPACITY) {
    private val items = ArrayDeque<ConnectionMetric>()

    val size: Int get() = items.size

    /** 追加并返回溢出时被淘汰的条目（未溢出返回空表）。 */
    fun add(metric: ConnectionMetric): List<ConnectionMetric> {
        items.addLast(metric)
        val evicted = mutableListOf<ConnectionMetric>()
        while (items.size > capacity) {
            evicted += items.removeFirst()
        }
        return evicted
    }

    fun snapshot(): List<ConnectionMetric> = items.toList()

    companion object {
        const val DEFAULT_CAPACITY = 100
    }
}

/**
 * 连接指标收集器：内存环形 + 可选 JSON-lines 落盘（应用私有目录，非 Room——阶段 F 统一迁移）。
 * 落盘失败静默降级为纯内存，不影响连接主流程。
 */
class ConnectionMetrics(
    private val file: File? = null,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    capacity: Int = MetricRingBuffer.DEFAULT_CAPACITY,
) : ConnectionMetricStore {

    private val mutex = Mutex()
    private var buffer = MetricRingBuffer(capacity)
    /** 落盘序列（仅文件实现有意义） */
    private var persisted = false

    /** F-03：进程内事件计数器（如 ws_event_drop）。仅记键名与次数，不落任何敏感数据。 */
    private val counters = ConcurrentHashMap<String, Long>()

    /**
     * F-03 前置：计数器自增（线程安全，进程内生命周期，不持久化）。
     * 键名为固定枚举字符串（如 "ws_event_drop"），禁止携带 token/配对码/消息正文。
     */
    fun increment(key: String) {
        counters.merge(key, 1L) { old, _ -> old + 1 }
    }

    /** 读取单个计数器当前值（诊断/测试用）。 */
    fun counter(key: String): Long = counters[key] ?: 0L

    /** 全部计数器快照（诊断输出用；返回副本，键名升序无敏感数据）。 */
    fun counters(): Map<String, Long> = counters.toMap()

    override suspend fun record(metric: ConnectionMetric) {
        withContextIo {
            mutex.withLock {
                buffer.add(metric)
                if (file != null) appendToFile(metric)
            }
        }
    }

    override suspend fun recent(): List<ConnectionMetric> = withContextIo {
        mutex.withLock {
            if (!persisted && file != null) {
                // 进程重启后惰性加载磁盘指标（容忍坏行）
                buffer = MetricRingBuffer(buffer.capacity)
                runCatching {
                    val f = file
                    if (f != null && f.exists()) {
                        f.readLines().forEach { line ->
                            decodeLine(line)?.let { buffer.add(it) }
                        }
                    }
                }
                persisted = true
            }
            buffer.snapshot()
        }
    }

    /**
     * 诊断快照（B-07，供设置页"连接诊断"接线）：纯数据输出，不含 UI。
     * 保证无 token / 配对码 / 消息正文 / 明文 host。
     */
    suspend fun snapshotForDiagnostics(
        state: ConnectionState?,
        connection: ServerConnectionSummary?,
    ): ConnectionDiagnostics {
        val metrics = recent()
        val lastFailure = metrics.lastOrNull { it.result != RESULT_CONNECTED }
        val lastSuccess = metrics.lastOrNull { it.result == RESULT_CONNECTED }
        return ConnectionDiagnostics(
            stateLabel = describeState(state),
            endpointType = connection?.endpointType,
            securityMode = connection?.securityMode,
            serverId = connection?.serverId,
            apiVersion = connection?.apiVersion,
            pairingProtocolVersion = connection?.pairingProtocolVersion,
            lastRttMs = lastSuccess?.probeMs,
            lastConnectedAt = lastSuccess?.startedAt,
            lastFailure = lastFailure?.let {
                DiagnosticsFailure(
                    startedAt = it.startedAt,
                    endpointType = it.endpointType,
                    reason = it.failureReason ?: "unknown",
                )
            },
            recentAttempts = metrics.size,
            recentResults = metrics.takeLast(10).map { it.result },
            counters = counters().toSortedMap(),
        )
    }

    private fun appendToFile(metric: ConnectionMetric) {
        val f = file ?: return
        runCatching {
            f.parentFile?.mkdirs()
            f.appendText(encodeLine(metric) + "\n")
            // 文件侧同样截断至 capacity，防止无限膨胀
            val lines = f.readLines()
            if (lines.size > buffer.capacity) {
                f.writeText(lines.takeLast(buffer.capacity).joinToString("\n") + "\n")
            }
            persisted = true
        }
    }

    private suspend fun <T> withContextIo(block: suspend () -> T): T =
        kotlinx.coroutines.withContext(ioDispatcher) { block() }

    companion object {
        const val RESULT_CONNECTED = "connected"
        const val RESULT_FAILED = "failed"
        const val RESULT_NEEDS_REPAIR = "needs_repair"

        /** deviceId 脱敏：SHA-256 前 12 hex（本地对账足够，不可逆）。 */
        fun hashDeviceId(deviceId: String): String =
            MessageDigest.getInstance("SHA-256")
                .digest(deviceId.toByteArray())
                .joinToString("") { "%02x".format(it) }
                .take(12)

        /** JSON lines 编解码（手写极简格式，避免为指标引入 serializer 依赖面）。 */
        fun encodeLine(metric: ConnectionMetric): String {
            val sb = StringBuilder()
            sb.append('{')
            appendStr(sb, "id", metric.attemptId); sb.append(',')
            appendStr(sb, "dev", metric.deviceIdHash); sb.append(',')
            sb.append("\"ts\":").append(metric.startedAt).append(',')
            appendStr(sb, "ep", metric.endpointType); sb.append(',')
            appendOptLong(sb, "disc", metric.discoveryMs); sb.append(',')
            appendOptLong(sb, "probe", metric.probeMs); sb.append(',')
            appendOptLong(sb, "ws", metric.wsMs); sb.append(',')
            appendStr(sb, "res", metric.result); sb.append(',')
            if (metric.failureReason == null) {
                sb.append("\"fail\":null")
            } else {
                appendStr(sb, "fail", metric.failureReason)
            }
            sb.append('}')
            return sb.toString()
        }

        fun decodeLine(line: String): ConnectionMetric? = runCatching {
            if (!line.startsWith("{") || !line.endsWith("}")) return null
            val map = parseFlatJson(line)
            ConnectionMetric(
                attemptId = map["id"] as? String ?: return null,
                deviceIdHash = map["dev"] as? String ?: "",
                startedAt = (map["ts"] as? Number)?.toLong() ?: return null,
                endpointType = map["ep"] as? String ?: "",
                discoveryMs = (map["disc"] as? Number)?.toLong(),
                probeMs = (map["probe"] as? Number)?.toLong(),
                wsMs = (map["ws"] as? Number)?.toLong(),
                result = map["res"] as? String ?: return null,
                failureReason = map["fail"] as? String,
            )
        }.getOrNull()

        private fun appendStr(sb: StringBuilder, key: String, value: String) {
            sb.append('"').append(key).append("\":\"").append(escape(value)).append('"')
        }

        private fun appendOptLong(sb: StringBuilder, key: String, value: Long?) {
            sb.append('"').append(key).append("\":")
            if (value == null) sb.append("null") else sb.append(value)
        }

        private fun escape(v: String): String =
            v.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "")

        /** 扁平 JSON 解析（只处理本文件写出的单层结构）。 */
        private fun parseFlatJson(text: String): Map<String, Any?> {
            val body = text.removePrefix("{").removeSuffix("}")
            val out = LinkedHashMap<String, Any?>()
            var i = 0
            while (i < body.length) {
                val keyStart = body.indexOf('"', i)
                if (keyStart < 0) break
                val keyEnd = body.indexOf('"', keyStart + 1)
                val key = body.substring(keyStart + 1, keyEnd)
                val colon = body.indexOf(':', keyEnd)
                var j = colon + 1
                while (j < body.length && body[j] == ' ') j++
                when (body[j]) {
                    '"' -> {
                        val sb = StringBuilder()
                        j++
                        while (j < body.length) {
                            val c = body[j]
                            if (c == '\\' && j + 1 < body.length) {
                                val n = body[j + 1]
                                sb.append(if (n == 'n') '\n' else n)
                                j += 2
                            } else if (c == '"') {
                                j++
                                break
                            } else {
                                sb.append(c)
                                j++
                            }
                        }
                        out[key] = sb.toString()
                    }
                    'n' -> { out[key] = null; j += 4 }
                    else -> {
                        val tokenStart = j
                        while (j < body.length && body[j] != ',') j++
                        out[key] = body.substring(tokenStart, j).trim().toLong()
                    }
                }
                while (j < body.length && (body[j] == ',' || body[j] == ' ')) j++
                i = j
            }
            return out
        }

        private fun describeState(state: ConnectionState?): String = when (state) {
            null -> "unknown"
            ConnectionState.Idle -> "idle"
            is ConnectionState.Discovering -> "discovering"
            is ConnectionState.Probing -> "probing(${state.candidates.size} candidates)"
            is ConnectionState.AwaitingApproval -> "awaiting_approval"
            is ConnectionState.Authenticating -> "authenticating"
            is ConnectionState.ConnectingRealtime -> "connecting_realtime"
            is ConnectionState.Connected -> "connected(rtt=${state.rttMs}ms)"
            is ConnectionState.UsingCache -> "using_cache(age=${state.cacheAgeMs}ms)"
            is ConnectionState.Degraded -> "degraded(rest=${state.restAvailable},ws=${state.wsAvailable})"
            is ConnectionState.Reconnecting -> "reconnecting(attempt=${state.attempt})"
            is ConnectionState.NeedsRepair -> "needs_repair(${state.reason})"
        }
    }
}

/** 诊断快照的输入摘要（由 coordinator 从当前连接投影，不含敏感值）。 */
data class ServerConnectionSummary(
    val deviceIdHash: String,
    val serverId: String?,
    val endpointType: String,
    val securityMode: String,
    val apiVersion: Int?,
    val pairingProtocolVersion: Int,
)

/** 设置页"连接诊断"的纯数据输出（UI 接线由主代理完成）。 */
data class ConnectionDiagnostics(
    val stateLabel: String,
    val endpointType: String?,
    val securityMode: String?,
    val serverId: String?,
    val apiVersion: Int?,
    val pairingProtocolVersion: Int?,
    val lastRttMs: Long?,
    val lastConnectedAt: Long?,
    val lastFailure: DiagnosticsFailure?,
    val recentAttempts: Int,
    val recentResults: List<String>,
    /** F-03：进程内事件计数器快照（如 ws_event_drop；仅键名+次数，无敏感数据） */
    val counters: Map<String, Long> = emptyMap(),
)

data class DiagnosticsFailure(
    val startedAt: Long,
    val endpointType: String,
    val reason: String,
)
