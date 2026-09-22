package com.qingyu.companion.imagegen

import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException

/**
 * 阶段 6 S6-04「生图与 ComfyUI」公共契约（Android 侧）。
 *
 * 对齐 PC 当前有效能力（`electron/services/imageGen.ts`、`shared/types.ts` 生图配置形状）：
 * - 三类**网络端点**（OpenAI Images / SD WebUI / ComfyUI）按 PC 的请求协议、返回解析实现；
 * - 鉴权从本地注入（[ImageGenHttpRequest.authHeaders]），**不进入任何日志/toString 字符串**；
 * - PC 已删除的能力不复活：自动生图（`imageGenAutoEnabled` 链路）、ComfyUI 内置工作流回退、
 *   SD 风格 Comfy 通用参数字段（steps/cfg/sampler 等，ComfyUI 只用节点级 overrides）。
 *
 * 协议构造/响应解析/安全判定全部是纯 JVM 可测逻辑；网络执行经 [ImageGenTransport] 接口注入。
 */

/** 生图提供商（wire 值与 PC `ImageGenProvider` 一致）。 */
enum class ImageGenProvider(val wire: String) {
    OpenAI("openai"),
    SdWebUi("sd-webui"),
    ComfyUi("comfyui"),
    ;

    companion object {
        fun fromWire(value: String): ImageGenProvider? =
            entries.firstOrNull { it.wire == value.lowercase() }
    }
}

/**
 * 生图模型配置（镜像 `shared/types.ts` 的 OpenAiImageGenConfig / SdWebUiImageGenConfig /
 * ComfyImageGenConfig）。apiKey 为本地注入的秘密，禁止写入日志与 toString。
 */
sealed class ImageGenConfig {
    abstract val id: String
    abstract val name: String
    abstract val apiKey: String
    abstract val baseUrl: String
    abstract val enabled: Boolean
    abstract val order: Int
    abstract val provider: ImageGenProvider

    /** OpenAI DALL-E 配置。 */
    data class OpenAi(
        override val id: String,
        override val name: String,
        override val apiKey: String,
        override val baseUrl: String,
        override val enabled: Boolean = true,
        override val order: Int = 0,
        val model: String = "",
        val size: String = "1024x1024",
        val quality: String = "standard",
    ) : ImageGenConfig() {
        override val provider: ImageGenProvider = ImageGenProvider.OpenAI

        override fun toString(): String =
            "ImageGenConfig.OpenAi(id=$id, name=$name, baseUrl=$baseUrl, model=$model, size=$size, quality=$quality)"
    }

    /** SD WebUI (Automatic1111) 配置。 */
    data class SdWebUi(
        override val id: String,
        override val name: String,
        override val apiKey: String,
        override val baseUrl: String,
        override val enabled: Boolean = true,
        override val order: Int = 0,
        val model: String = "",
        val size: String = "512x512",
        val negativePrompt: String? = null,
        val steps: Int? = null,
        val cfgScale: Double? = null,
        val sampler: String? = null,
    ) : ImageGenConfig() {
        override val provider: ImageGenProvider = ImageGenProvider.SdWebUi

        override fun toString(): String =
            "ImageGenConfig.SdWebUi(id=$id, name=$name, baseUrl=$baseUrl, size=$size, steps=$steps, cfgScale=$cfgScale, sampler=$sampler)"
    }

    /**
     * ComfyUI 配置：以工作流快照为唯一事实来源，参数只通过 [overrides] 按节点精确覆盖。
     * 不提供内置工作流回退（PC 已移除 `defaultComfyWorkflow`）。
     */
    data class ComfyUi(
        override val id: String,
        override val name: String,
        override val apiKey: String,
        override val baseUrl: String,
        override val enabled: Boolean = true,
        override val order: Int = 0,
        val workflow: String = "",
        val bindings: ComfyWorkflowBindings? = null,
        val negativePromptMode: ComfyNegativePromptMode? = null,
        val negativePromptPreset: String? = null,
        val overrides: Map<String, Any?>? = null,
        val workflowMeta: ComfyWorkflowMeta? = null,
    ) : ImageGenConfig() {
        override val provider: ImageGenProvider = ImageGenProvider.ComfyUi

        override fun toString(): String =
            "ImageGenConfig.ComfyUi(id=$id, name=$name, baseUrl=$baseUrl, workflowChars=${workflow.length}, overrides=${overrides?.keys ?: emptySet()})"
    }
}

/**
 * 一次生图请求的可选项（PC `ImageGenOptions`）。
 * [negativePrompt] 为 null 表示“本次请求未指定”（等价 PC 的 `undefined`），
 * 空字符串表示“显式清空负面提示词”。
 */
data class ImageGenRequestOptions(
    val negativePrompt: String? = null,
    val size: String? = null,
    val quality: String? = null,
)

/** 失败分类（重试策略与用户提示的唯一依据）。 */
enum class ImageGenFailureKind {
    /** 配置非法（缺工作流、入口失效、localhost 迁移未完成等）。 */
    CONFIG,

    /** 安全边界拒绝（非 http(s) scheme、内网元数据地址、重定向越界等）。 */
    SECURITY,

    /** 鉴权失败（401/403）。 */
    AUTH,

    /** 限流/额度（429）。 */
    RATE_LIMIT,

    /** 请求非法（400/422 等）。 */
    BAD_REQUEST,

    /** 目标不存在（404）。 */
    NOT_FOUND,

    /** 服务端错误（5xx）。 */
    SERVER,

    /** 超时。 */
    TIMEOUT,

    /** 连接失败（拒绝/不可达/IO）。 */
    CONNECTION,

    /** 响应不符合协议（无法解析/字段缺失/伪 MIME）。 */
    PROTOCOL,

    /** 结果为空。 */
    EMPTY_RESULT,

    /** 结果校验失败（hash/大小/内容不匹配）。 */
    VALIDATION,
}

/**
 * 结构化失败。[toString] **不输出 message**（对齐 `ModelError` 的日志纪律），
 * 防止供应商回显内容或意外拼接的秘密进入日志。
 */
data class ImageGenFailure(
    val kind: ImageGenFailureKind,
    val code: String,
    val message: String,
    val retryable: Boolean,
    val httpStatus: Int? = null,
) {
    fun toUserMessage(): String = when (code) {
        "HTTP_401", "HTTP_403" -> "认证失败：请检查 API Key 是否有效"
        "HTTP_429" -> "请求过于频繁或额度已用完，请稍后重试"
        "TIMEOUT" -> "请求超时，请检查网络后重试"
        "CONNECTION_REFUSED" -> "连接被拒绝，请确认服务已启动且端口正确"
        "UNSUPPORTED_SCHEME" -> "仅支持 http/https 地址"
        "LOCALHOST_ENDPOINT" -> message
        else -> message
    }

    override fun toString(): String =
        "ImageGenFailure(kind=$kind, code=$code, retryable=$retryable, httpStatus=$httpStatus)"
}

/** 配置/工作流非法：调用侧归类为 [ImageGenFailureKind.CONFIG]。 */
class ImageGenConfigException(message: String) : Exception(message)

/** 协议请求（纯数据）。鉴权头单独存放且永不进入日志字符串。 */
data class ImageGenHttpRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String> = emptyMap(),
    val body: String? = null,
    /** 本地注入的鉴权头（Bearer / X-API-Key 等）；只允许出现在真实网络执行层。 */
    val authHeaders: Map<String, String> = emptyMap(),
    val timeoutMs: Long,
) {
    /** 真实发送的完整头（仅供网络执行层使用，禁止日志打印）。 */
    fun allHeaders(): Map<String, String> = headers + authHeaders

    /** 日志安全视图：鉴权值全部脱敏为 `***`。 */
    fun toLogString(): String {
        val masked = (headers + authHeaders).mapValues { entry ->
            if (isSensitiveHeader(entry.key)) "***" else entry.value
        }
        return "ImageGenHttpRequest(method=$method, url=$url, headers=$masked, bodyChars=${body?.length ?: 0})"
    }

    override fun toString(): String = toLogString()

    companion object {
        private val SENSITIVE_HEADERS = setOf("authorization", "x-api-key", "proxy-authorization", "cookie")

        fun isSensitiveHeader(name: String): Boolean = name.lowercase() in SENSITIVE_HEADERS
    }
}

/** 协议响应（纯数据）。 */
data class ImageGenHttpResponse(
    val statusCode: Int,
    val contentType: String? = null,
    val body: ByteArray = ByteArray(0),
) {
    fun text(): String = body.toString(Charsets.UTF_8)

    /** 去掉参数后的 MIME（如 `image/png; charset=binary` → `image/png`），小写。 */
    fun normalizedContentType(): String? =
        contentType?.substringBefore(';')?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }

    override fun toString(): String =
        "ImageGenHttpResponse(statusCode=$statusCode, contentType=$contentType, bodyChars=${body.size})"
}

/** 网络执行抽象：实现层（OkHttp）由主代理接线；测试用替身断言请求形状与失败分类。 */
fun interface ImageGenTransport {
    /** 同步执行一次请求。调用方负责在 IO 线程调用；异常由 [ImageGenClient] 归类。 */
    fun execute(request: ImageGenHttpRequest): ImageGenHttpResponse
}

/** 时间与休眠抽象：ComfyUI 历史轮询需要可测的时钟。 */
interface ImageGenClock {
    fun nowMs(): Long
    fun sleepMs(ms: Long)
}

/** 默认真实时钟（生产执行层使用）。 */
object SystemImageGenClock : ImageGenClock {
    override fun nowMs(): Long = System.currentTimeMillis()
    override fun sleepMs(ms: Long) {
        if (ms > 0) Thread.sleep(ms)
    }
}

/** 端点返回的解码后图片（尚未校验）。 */
data class PlainImage(
    val mimeType: String,
    val bytes: ByteArray,
)

/** 一次生图的终局。 */
sealed class ImageGenOutcome {
    data class Success(val images: List<VerifiedImage>) : ImageGenOutcome()
    data class Failure(val failure: ImageGenFailure) : ImageGenOutcome()
}

/** 连接测试结果（PC `TestConnectionResult`）。 */
data class ImageGenConnectionTestResult(
    val success: Boolean,
    val message: String? = null,
    val failure: ImageGenFailure? = null,
)

/** 按 HTTP 状态归类失败；message 由调用侧按 PC 文案组装后传入。 */
fun classifyHttpStatus(prefix: String, status: Int, message: String): ImageGenFailure {
    val (kind, retryable) = when {
        status == 401 || status == 403 -> ImageGenFailureKind.AUTH to false
        status == 429 -> ImageGenFailureKind.RATE_LIMIT to true
        status == 408 -> ImageGenFailureKind.TIMEOUT to true
        status == 404 -> ImageGenFailureKind.NOT_FOUND to false
        status in 500..599 -> ImageGenFailureKind.SERVER to true
        status in 400..499 -> ImageGenFailureKind.BAD_REQUEST to false
        else -> ImageGenFailureKind.PROTOCOL to false
    }
    return ImageGenFailure(kind, "${prefix}_HTTP_$status", message, retryable, status)
}

/** 网络异常归类（超时/拒绝/其它 IO）。 */
fun classifyTransportException(err: Throwable): ImageGenFailure = when (err) {
    is SocketTimeoutException, is InterruptedIOException ->
        ImageGenFailure(ImageGenFailureKind.TIMEOUT, "TIMEOUT", "请求超时，请检查网络后重试", true)
    is java.net.ConnectException ->
        ImageGenFailure(ImageGenFailureKind.CONNECTION, "CONNECTION_REFUSED", "连接被拒绝，请确认服务已启动且端口正确", true)
    is IOException ->
        ImageGenFailure(ImageGenFailureKind.CONNECTION, "CONNECTION_ERROR", "网络连接失败：${err.message ?: ""}", true)
    else ->
        ImageGenFailure(ImageGenFailureKind.PROTOCOL, "UNEXPECTED_ERROR", err.message ?: "未知错误", false)
}
