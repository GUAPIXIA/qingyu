package com.qingyu.companion.embedding

import com.qingyu.companion.chatcore.ChatEmbeddingPolicy

/**
 * `embedding` 包测试共用替身：网络 / 存储 / 下载源 / 签名 / 运行时全部走接缝注入，
 * 使全部用例保持纯 JVM（无真机、无外网、无 Room）。
 */

// ---------------------------------------------------------------- 远程嵌入

class FakeEmbeddingTransport(
    private val responder: (FakeRequest) -> EmbeddingHttpResponse,
) : EmbeddingHttpTransport {
    data class FakeRequest(val url: String, val headers: Map<String, String>, val body: String, val timeoutMs: Long)

    val requests = mutableListOf<FakeRequest>()

    override fun postJson(url: String, headers: Map<String, String>, body: String, timeoutMs: Long): EmbeddingHttpResponse {
        val request = FakeRequest(url, headers, body, timeoutMs)
        requests += request
        return responder(request)
    }
}

/** 抛传输层异常的替身（失败分类用）。 */
class ThrowingEmbeddingTransport(private val error: EmbeddingTransportException) : EmbeddingHttpTransport {
    override fun postJson(url: String, headers: Map<String, String>, body: String, timeoutMs: Long): EmbeddingHttpResponse {
        throw error
    }
}

fun openAiConfig(apiKey: String? = "sk-test") = ChatEmbeddingPolicy.Config(
    provider = "openai",
    model = "text-embedding-3-small",
    baseUrl = "https://api.example.com/v1",
    apiKey = apiKey,
)

fun ollamaConfig() = ChatEmbeddingPolicy.Config(
    provider = "ollama",
    model = "nomic-embed-text",
    baseUrl = "http://127.0.0.1:11434",
    apiKey = null,
)

/** 按 index 原位填充的 OpenAI 风格响应体。 */
fun openAiResponse(vectors: List<List<Double>?>, withIndex: Boolean = true): String {
    val data = vectors.mapIndexed { position, vector ->
        val item = StringBuilder()
        item.append('{')
        if (withIndex) item.append("\"index\":$position,")
        item.append("\"embedding\":")
        item.append(vector?.joinToString(",", "[", "]") ?: "null")
        item.append('}')
        item.toString()
    }.joinToString(",")
    return "{\"data\":[$data],\"model\":\"m\"}"
}

/** Ollama 风格响应体（`embeddings` 二维数组）。 */
fun ollamaResponse(vectors: List<List<Double>>): String =
    "{\"embeddings\":[${vectors.joinToString(",") { it.joinToString(",", "[", "]") }}]}"

class RecordingEmbedder(
    private val produce: (List<String>) -> List<List<Double>>,
) : TextEmbedder {
    val calls = mutableListOf<List<String>>()

    override fun embed(texts: List<String>, inputKind: EmbeddingInputKind): List<List<Double>> {
        calls += texts
        return produce(texts)
    }
}

// ---------------------------------------------------------------- 模型包

fun manifestFields(
    payloads: Map<String, ByteArray>,
    urls: List<String> = listOf("https://models.example.com/pkg"),
    id: String = "bge-m3",
    version: String = "1.0.0",
    signature: String = "AA==",
    installedSizeOverride: Long? = null,
    recommendedMemoryMb: Long = 512,
    minimumAppVersion: String = "1.0.0",
    maxTokens: Int = 512,
    dimensions: Int = 256,
): Map<String, Any?> {
    val files = payloads.map { (path, bytes) ->
        mapOf<String, Any?>(
            "path" to path,
            "size" to bytes.size.toLong(),
            "sha256" to sha256Hex(bytes),
            "urls" to urls,
        )
    }
    val total = payloads.values.sumOf { it.size.toLong() }
    return linkedMapOf(
        "schemaVersion" to 1,
        "id" to id,
        "version" to version,
        "displayName" to "BGE M3 测试模型",
        "description" to "S6-05 测试用模型包",
        "languages" to listOf("zh", "en"),
        "license" to mapOf("name" to "MIT", "url" to "https://opensource.org/licenses/MIT"),
        "runtime" to "onnx",
        "architecture" to "bge-m3",
        "dimensions" to dimensions,
        "maxTokens" to maxTokens,
        "dtype" to "q8",
        "pooling" to "mean",
        "normalize" to true,
        "minimumAppVersion" to minimumAppVersion,
        "recommendedMemoryMb" to recommendedMemoryMb,
        "installedSize" to (installedSizeOverride ?: total),
        "files" to files,
        "catalogSignature" to signature,
    )
}

/** 用真 Ed25519 密钥给清单签名（覆盖占位签名），返回可直接 parse 的字段表。 */
fun signManifestFields(fields: Map<String, Any?>, privateKey: java.security.PrivateKey): Map<String, Any?> {
    val payload = canonicalJson(fields.filterKeys { it != EmbeddingModelManifest.CATALOG_SIGNATURE })
    val signature = java.security.Signature.getInstance("Ed25519").run {
        initSign(privateKey)
        update(payload.toByteArray(Charsets.UTF_8))
        sign()
    }
    return fields + (EmbeddingModelManifest.CATALOG_SIGNATURE to java.util.Base64.getEncoder().encodeToString(signature))
}

/** 生成 Ed25519 密钥对（JDK15+；Android 真机侧的能力探测见 Ed25519ManifestSignatureVerifier）。 */
fun generateEd25519KeyPair(): java.security.KeyPair =
    java.security.KeyPairGenerator.getInstance("Ed25519").generateKeyPair()

fun publicKeyPem(publicKey: java.security.PublicKey): String {
    val base64 = java.util.Base64.getEncoder().encodeToString(publicKey.encoded)
    return "-----BEGIN PUBLIC KEY-----\n$base64\n-----END PUBLIC KEY-----"
}

class FakeManifestSignatureVerifier(
    var supported: Boolean = true,
    var valid: Boolean = true,
) : ManifestSignatureVerifier {
    var verifyCalls = 0
    override fun isSupported(): Boolean = supported
    override fun verify(payload: ByteArray, signatureBase64: String, publicKeyPem: String): Boolean {
        verifyCalls++
        return valid
    }
}

/** 内存模型包存储：断点 / 暂存 / 提交三区，字节逐块可核对。 */
class InMemoryModelPackageStore(freeSpace: Long) : ModelPackageStore {
    var freeSpace: Long = freeSpace
    val partials = mutableMapOf<String, ByteArray>()
    val staged = mutableMapOf<String, ByteArray>()
    val committed = mutableMapOf<String, ByteArray>()
    var committedManifestJson: String? = null

    private fun key(modelId: String, version: String, path: String) = "$modelId@$version:$path"

    override fun freeSpaceBytes(): Long = freeSpace

    override fun partialSize(modelId: String, version: String, path: String): Long =
        partials[key(modelId, version, path)]?.size?.toLong() ?: 0L

    override fun appendPartial(modelId: String, version: String, path: String, chunk: ByteArray) {
        val k = key(modelId, version, path)
        partials[k] = (partials[k] ?: ByteArray(0)) + chunk
    }

    override fun readPartial(modelId: String, version: String, path: String): ByteArray =
        partials[key(modelId, version, path)] ?: ByteArray(0)

    override fun discardPartial(modelId: String, version: String, path: String) {
        partials.remove(key(modelId, version, path))
    }

    override fun stagedFile(modelId: String, version: String, path: String): ByteArray? =
        staged[key(modelId, version, path)]

    override fun writeStaged(modelId: String, version: String, path: String, bytes: ByteArray) {
        staged[key(modelId, version, path)] = bytes
    }

    override fun discardStaged(modelId: String, version: String, path: String) {
        staged.remove(key(modelId, version, path))
    }

    override fun commit(modelId: String, version: String, manifestJson: String, files: Map<String, ByteArray>) {
        committedManifestJson = manifestJson
        for ((path, bytes) in files) committed["${modelId}_$path"] = bytes
    }
}

/**
 * 分块下载源替身：按 [chunkSize] 吐块、记录每次 `(url, start)`、
 * 可注入「收满 [failAfterBytes] 字节后中断」与「服务器不支持 Range（resumed=false 且从 0 全量返回）」。
 */
class FakeModelPackageSource(
    private val payload: ByteArray,
    private val chunkSize: Int = 7,
) : ModelPackageSource {
    /** true = 服务器按 Range 续传（206）；false = 忽略 Range、返回全量（200）。 */
    var respectRange: Boolean = true

    /** 单次打开后允许送达的字节数，达到即抛 [ModelPackageDownloadException]（null = 不中断）。 */
    var failAfterBytes: Int? = null

    /** 本次打开实际送达的字节数（断点量的核对）。 */
    var lastDeliveredBytes: Int = 0

    /** (url, startInclusive) 请求记录——断点续传是否真的带 Range 就看它。 */
    val calls = mutableListOf<Pair<String, Long>>()

    override fun open(url: String, startInclusive: Long): ModelPackageChunkReader {
        calls += url to startInclusive
        val effectiveStart = if (respectRange) startInclusive else 0L
        val resumedFlag = respectRange && startInclusive > 0
        val failAfter = failAfterBytes
        lastDeliveredBytes = 0
        return object : ModelPackageChunkReader {
            private var position = effectiveStart
            override val resumed: Boolean get() = resumedFlag

            override fun nextChunk(): ByteArray? {
                if (position >= payload.size) return null
                if (failAfter != null && lastDeliveredBytes >= failAfter) {
                    throw ModelPackageDownloadException("模拟传输中断（已收 $lastDeliveredBytes 字节）")
                }
                var end = minOf(position + chunkSize, payload.size.toLong())
                if (failAfter != null) {
                    end = minOf(end, effectiveStart + failAfter)
                }
                val chunk = payload.copyOfRange(position.toInt(), end.toInt())
                position = end
                lastDeliveredBytes += chunk.size
                return if (chunk.isEmpty()) null else chunk
            }
        }
    }
}

/** 运行时替身（记录 load/embed/unload，可注入返回值）。 */
class FakeMobileEmbeddingRuntime : MobileEmbeddingRuntime {
    var loadedFiles: Map<String, ByteArray>? = null
    var embedScript: (List<String>) -> List<List<Double>> = { texts -> texts.map { listOf(1.0, 0.0) } }
    var unloadCalls = 0

    override fun load(modelFiles: Map<String, ByteArray>, manifest: EmbeddingModelManifest): LocalRuntimeLoad {
        loadedFiles = modelFiles
        return LocalRuntimeLoad.Loaded(manifest.dimensions, manifest.maxTokens)
    }

    override fun embed(texts: List<String>, inputKind: EmbeddingInputKind): List<List<Double>> = embedScript(texts)

    override fun unload() {
        unloadCalls++
    }
}
