package com.qingyu.companion.embedding

import com.qingyu.companion.chatcore.ChatEmbeddingPolicy
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * 阶段 6 S6-05 第 1 档：**远程 OpenAI-compatible / Ollama 嵌入客户端**。
 *
 * 对齐 PC `electron/services/embedding.ts` 的可观测语义：
 * - `openai`：`POST {baseUrl}/embeddings`，`Authorization: Bearer …`（有 key 才带）；
 * - `ollama`：`POST {baseUrl}/api/embed`，不带鉴权头；
 * - 单条输入截断 8000 字符：**查询保尾、索引文档保头**；
 * - 单批 32 条、超时 60s；**任一批失败即整体失败**（不静默跳批）；
 * - OpenAI 返回按 `index` **原位填充**（PC M-3 修复口径），缺失项补零向量；
 * - 结果数量不足时补零向量对齐输入数量（沿用批次已知维度）。
 *
 * 与 PC 的**有意偏差（仅数量不匹配一种情形）**：PC 的 Ollama 分支在数量不匹配时
 * 直接返回短数组，导致后续批次整体前移（文本 i 配上文本 i+1 的向量——PC M-3
 * 修过 OpenAI 分支的同一类错位）。本实现对两种协议都按输入数量补零对齐：
 * 数量不匹配时**宁可少命中，不可错命中**。其余语义逐条保持一致。
 *
 * 鉴权本地注入：apiKey 只进 `Authorization` 头，绝不进 URL / 请求体 /
 * 异常文案 / [describeForLog]（由 `RemoteEmbeddingClientTest` 钉死）。
 */
object EmbeddingProtocols {
    /** 单条输入的最大字符数（避免超长条目超出模型输入限制，PC `MAX_INPUT_CHARS`）。 */
    const val MAX_INPUT_CHARS = 8000

    /** 单批嵌入条数（PC `BATCH_SIZE`）。 */
    const val BATCH_SIZE = 32

    /** 请求超时（PC `TIMEOUT_MS`）。 */
    const val TIMEOUT_MS = 60_000L

    /** 截断过长文本：查询保留最新尾部，索引文档保留开头（PC `truncateEmbeddingInput`）。 */
    fun truncateEmbeddingInput(text: String, inputKind: EmbeddingInputKind, max: Int = MAX_INPUT_CHARS): String {
        if (text.length <= max) return text
        return if (inputKind == EmbeddingInputKind.QUERY) text.takeLast(max) else text.take(max)
    }

    /** 去掉**一个**结尾斜杠（与 PC `baseUrl.replace(/\/$/, '')` 同口径）。 */
    internal fun stripTrailingSlash(baseUrl: String): String =
        if (baseUrl.endsWith("/")) baseUrl.dropLast(1) else baseUrl

    fun requestUrl(config: ChatEmbeddingPolicy.Config): String {
        val base = stripTrailingSlash(config.baseUrl?.trim().orEmpty())
        return when (config.provider) {
            "ollama" -> "$base/api/embed"
            else -> "$base/embeddings"
        }
    }

    /** 鉴权头本地注入：只有 OpenAI 兼容协议且 apiKey 非空时带 `Authorization`。 */
    fun requestHeaders(config: ChatEmbeddingPolicy.Config): Map<String, String> {
        val headers = linkedMapOf("Content-Type" to "application/json")
        if (config.provider != "ollama" && !config.apiKey.isNullOrEmpty()) {
            headers["Authorization"] = "Bearer ${config.apiKey}"
        }
        return headers
    }

    fun requestBody(config: ChatEmbeddingPolicy.Config, inputs: List<String>): String {
        val body = JSONObject()
        body.put("model", config.model)
        body.put("input", JSONArray(inputs))
        return body.toString()
    }

    /** 日志/异常可读描述：**永远不包含 apiKey**。 */
    fun describeForLog(config: ChatEmbeddingPolicy.Config): String =
        "${config.provider}:${config.model}@${config.baseUrl.orEmpty()}（凭据已省略）"

    /**
     * 解析响应体为与输入等长的向量列表（缺失项补零）。
     *
     * - openai：`{data:[{index?, embedding:[…]}]}`，按 `index` 原位填充（PC M-3）；
     * - ollama：`{embeddings:[[…]]}`；单输入时兼容一维数组形态；
     * - 响应体不是合法 JSON → [EmbeddingFailureKind.INVALID_RESPONSE]
     *   （PC 同位置是 JSON.parse 抛错，同样向上失败）。
     */
    fun parseResponse(provider: String, responseText: String, inputCount: Int): List<List<Double>> {
        val root = try {
            JSONObject(responseText)
        } catch (error: JSONException) {
            throw EmbeddingException(EmbeddingFailureKind.INVALID_RESPONSE, "响应不是合法 JSON：${error.message}", error)
        }
        return if (provider == "ollama") parseOllamaEmbeddings(root, inputCount)
        else parseOpenAiEmbeddings(root, inputCount)
    }

    private fun parseOpenAiEmbeddings(root: JSONObject, inputCount: Int): List<List<Double>> {
        val data = root.optJSONArray("data") ?: JSONArray()
        val result = arrayOfNulls<List<Double>>(inputCount)
        var knownDim = 0
        for (position in 0 until data.length()) {
            val item = data.optJSONObject(position) ?: continue
            val embedding = item.optJSONArray("embedding") ?: continue
            val vector = numericList(embedding)
            if (vector.isEmpty()) continue
            // PC M-3：按 index 原位填充（index 缺失时取数组位置），避免整体前移错位
            val index = if (item.has("index") && item.get("index") is Number) item.getInt("index") else position
            if (index in 0 until inputCount) {
                result[index] = vector
                knownDim = vector.size
            }
        }
        return fillMissing(result, inputCount, knownDim)
    }

    private fun parseOllamaEmbeddings(root: JSONObject, inputCount: Int): List<List<Double>> {
        val raw = root.optJSONArray("embeddings") ?: JSONArray()
        val parsed = mutableListOf<List<Double>>()
        // 兼容：单输入时 Ollama 可能返回一维数组（PC `embedOllama` 的同名兼容）
        if (inputCount == 1 && raw.length() > 0 && raw.opt(0) is Number) {
            val flat = numericList(raw)
            return if (flat.isEmpty()) listOf(emptyList()) else listOf(flat)
        }
        for (position in 0 until raw.length()) {
            val embedding = raw.optJSONArray(position) ?: continue
            parsed += numericList(embedding)
        }
        var knownDim = 0
        for (vector in parsed) {
            if (vector.isNotEmpty()) {
                knownDim = vector.size
                break
            }
        }
        val result = arrayOfNulls<List<Double>>(inputCount)
        for (index in 0 until minOf(parsed.size, inputCount)) {
            if (parsed[index].isNotEmpty()) result[index] = parsed[index]
        }
        return fillMissing(result, inputCount, knownDim)
    }

    private fun numericList(array: JSONArray): List<Double> {
        val values = mutableListOf<Double>()
        for (index in 0 until array.length()) {
            val value = array.opt(index)
            if (value is Number) values += value.toDouble() else return emptyList()
        }
        return values
    }

    private fun fillMissing(result: Array<List<Double>?>, inputCount: Int, knownDim: Int): List<List<Double>> {
        val fallback = List(knownDim) { 0.0 }
        return (0 until inputCount).map { index -> result[index] ?: fallback }
    }
}

/** 嵌入 HTTP 传输层（网络接缝；实现可以是 OkHttp，测试用替身）。 */
interface EmbeddingHttpTransport {
    /**
     * POST JSON 并返回状态码与响应体。
     *
     * 传输层失败抛 [EmbeddingTransportException]（[EmbeddingTransportException.timedOut]
     * 区分超时与普通网络错误，供失败分类使用）。
     */
    fun postJson(url: String, headers: Map<String, String>, body: String, timeoutMs: Long): EmbeddingHttpResponse
}

data class EmbeddingHttpResponse(val statusCode: Int, val body: String)

class EmbeddingTransportException(
    message: String,
    val timedOut: Boolean = false,
    cause: Throwable? = null,
) : Exception(message, cause)

/**
 * 远程嵌入客户端：批量 + 截断 + 失败分类。
 *
 * 配置复用 [ChatEmbeddingPolicy.Config]（阶段 4 的判定层），保证
 * 「什么配置才算可用」「阈值取多少」「向量空间是什么」两端只有一个口径。
 * 配置变化请**新建客户端**（配置改变即向量空间改变，旧索引按
 * [SemanticIndexPolicy] 不可复用，客户端无状态换配置的余地）。
 */
class RemoteEmbeddingClient(
    private val transport: EmbeddingHttpTransport,
    private val config: ChatEmbeddingPolicy.Config,
) : TextEmbedder {

    override fun embed(texts: List<String>, inputKind: EmbeddingInputKind): List<List<Double>> =
        embedWithConfig(config, texts, inputKind)

    /** 批量嵌入（自动分批 + 截断，任一批失败即抛 [EmbeddingException]，对齐 PC `embedTexts`）。 */
    fun embedWithConfig(
        config: ChatEmbeddingPolicy.Config,
        texts: List<String>,
        inputKind: EmbeddingInputKind,
    ): List<List<Double>> {
        if (texts.isEmpty()) return emptyList()
        if (config.provider == "local") {
            throw EmbeddingException(
                EmbeddingFailureKind.MISCONFIGURED,
                "local 提供方必须通过设备本地模型运行时调用（[MobileEmbeddingRuntime]）",
            )
        }
        ensureConfigured(config)
        val clean = texts.map { EmbeddingProtocols.truncateEmbeddingInput(it, inputKind) }
        val results = mutableListOf<List<Double>>()
        for (start in clean.indices step EmbeddingProtocols.BATCH_SIZE) {
            val batch = clean.subList(start, minOf(start + EmbeddingProtocols.BATCH_SIZE, clean.size))
            results += embedBatch(config, batch)
        }
        // 兜底：结果数量不足时补零向量（沿用批次已知维度，避免维度不一致导致下游点积错乱）
        var knownDim = 0
        for (vector in results) {
            if (vector.isNotEmpty()) {
                knownDim = vector.size
                break
            }
        }
        while (results.size < clean.size) results += List(knownDim) { 0.0 }
        return results
    }

    /** 测试嵌入服务连接：嵌入固定文本并返回向量维度（对齐 PC `testEmbedding`）。 */
    fun testConnection(): EmbeddingConnectionProbe {
        if (config.provider == "local") {
            return EmbeddingConnectionProbe(false, null, "local 提供方必须通过设备本地模型运行时自检")
        }
        return try {
            val vectors = embedWithConfig(config, listOf("测试"), EmbeddingInputKind.PASSAGE)
            val dim = vectors.firstOrNull()?.size ?: 0
            if (dim <= 0) EmbeddingConnectionProbe(false, null, "嵌入服务未返回有效向量")
            else EmbeddingConnectionProbe(true, dim, null)
        } catch (error: EmbeddingException) {
            EmbeddingConnectionProbe(false, null, "${error.kind.label}：${error.detail}")
        }
    }

    private fun embedBatch(config: ChatEmbeddingPolicy.Config, batch: List<String>): List<List<Double>> {
        val url = EmbeddingProtocols.requestUrl(config)
        val headers = EmbeddingProtocols.requestHeaders(config)
        val body = EmbeddingProtocols.requestBody(config, batch)
        val response = try {
            transport.postJson(url, headers, body, EmbeddingProtocols.TIMEOUT_MS)
        } catch (error: EmbeddingTransportException) {
            val kind = if (error.timedOut) EmbeddingFailureKind.TIMEOUT else EmbeddingFailureKind.NETWORK
            throw EmbeddingException(kind, "${EmbeddingProtocols.describeForLog(config)}：${error.message}", error)
        }
        if (response.statusCode !in 200..299) {
            throw EmbeddingException(classifyStatus(response.statusCode), httpErrorDetail(config, response))
        }
        return EmbeddingProtocols.parseResponse(config.provider, response.body, batch.size)
    }

    /** HTTP 状态 → 失败分类（纯函数，单独可测）。 */
    fun classifyStatus(statusCode: Int): EmbeddingFailureKind = when {
        statusCode == 401 || statusCode == 403 -> EmbeddingFailureKind.AUTH_FAILED
        statusCode == 429 -> EmbeddingFailureKind.RATE_LIMITED
        statusCode == 408 || statusCode == 504 -> EmbeddingFailureKind.TIMEOUT
        statusCode in 500..599 -> EmbeddingFailureKind.HTTP_ERROR
        statusCode in 400..499 -> EmbeddingFailureKind.HTTP_ERROR
        else -> EmbeddingFailureKind.INVALID_RESPONSE
    }

    /**
     * 错误文案沿用 PC 的形状（`嵌入服务错误 ${status}: ${正文前 300 字符}`），
     * 但先过 describeForLog 确保不含凭据。
     */
    private fun httpErrorDetail(config: ChatEmbeddingPolicy.Config, response: EmbeddingHttpResponse): String {
        val snippet = response.body.take(300)
        return "${EmbeddingProtocols.describeForLog(config)} → 嵌入服务错误 ${response.statusCode}: $snippet"
    }

    private fun ensureConfigured(config: ChatEmbeddingPolicy.Config) {
        if (!ChatEmbeddingPolicy.isEmbeddingConfigured(config)) {
            throw EmbeddingException(
                EmbeddingFailureKind.NOT_CONFIGURED,
                "嵌入服务未配置（需填写模型及有效连接${if (config.provider == "openai") "，OpenAI 兼容还需 apiKey" else ""}）",
            )
        }
    }
}

data class EmbeddingConnectionProbe(val ok: Boolean, val dimensions: Int?, val error: String?)
