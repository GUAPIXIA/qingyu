package com.qingyu.companion.network.models

/**
 * 阶段 3 S3-05：模型适配器的**实际 HTTP 执行层**。
 *
 * 统一接口（阶段 3 §2 S3-05）至少返回：chunk、结构化完成原因、用量、供应商错误、
 * 可取消句柄和能力探测结果。
 *
 * 安全要求：
 * - 默认只允许 HTTPS；用户在该连接档案中显式启用后才允许 LAN HTTP/Ollama；
 * - 证书错误不提供全局「忽略所有证书」开关；
 * - base URL 经 [requireSafeBaseUrl] 规范化，认证头由 adapter 构造，
 *   重定向不会把凭据带到非预期主机（OkHttp 关闭自动重定向，本层不跟随）。
 */
data class ModelUsage(
    val promptTokens: Int?,
    val completionTokens: Int?,
) {
    val total: Int?
        get() = if (promptTokens == null && completionTokens == null) null else
            (promptTokens ?: 0) + (completionTokens ?: 0)
}

data class ModelStreamResult(
    val finishReason: String,
    val usage: ModelUsage,
)

/**
 * 可取消句柄：调用方在 ViewModel 取消时调用 [cancel]；
 * 底层 OkHttp `Call.cancel()` 会同步中止 socket 读取。
 */
interface ModelRequestHandle {
    fun cancel()

    val isCancelled: Boolean
}

/** 连接测试结果（与真实生成共用同一 adapter 与认证头构造）。 */
data class ConnectionTestResult(
    val ok: Boolean,
    val latencyMs: Long,
    val capabilities: ModelCapabilities,
    val error: ModelError? = null,
) {
    override fun toString(): String = "ConnectionTestResult(ok=$ok, latencyMs=$latencyMs, error=$error)"
}
