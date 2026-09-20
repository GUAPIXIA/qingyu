package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-03：域错误分类与脱敏
 * （对齐 `shared/chat-core/errors.ts`）。
 *
 * 所有 AI/Provider/持久化/权限错误先脱敏再映射为 DomainError；
 * 客户端据 `code` 决定重试/提示，**不暴露供应商原文、本地路径、stack**。
 */
object ChatDomainErrors {

    /** 全部域错误码（顺序即 fixture 与统计口径）。 */
    val CODES = listOf(
        "INVALID_COMMAND",
        "UNAUTHORIZED",
        "VERSION_INCOMPATIBLE",
        "SESSION_NOT_FOUND",
        "CHARACTER_NOT_FOUND",
        "TASK_CONFLICT",
        "TASK_NOT_FOUND",
        "PROVIDER_TIMEOUT",
        "PROVIDER_RATE_LIMITED",
        "PROVIDER_UNAVAILABLE",
        "CONTEXT_TOO_LARGE",
        "INVALID_MODEL_RESPONSE",
        "TOOL_PERMISSION_DENIED",
        "TOOL_FAILED",
        "PERSISTENCE_FAILED",
        "TASK_INTERRUPTED",
        "UNKNOWN",
    )

    /**
     * 默认可重试的错误码。
     * 注意 `TASK_INTERRUPTED` **不在**其中：阶段 4 §S4-03 要求进程死亡后未完成任务标记
     * interrupted 且**不自动重发**，以免重复计费；重试必须由用户显式发起。
     */
    val RETRYABLE_CODES = setOf(
        "PROVIDER_TIMEOUT",
        "PROVIDER_RATE_LIMITED",
        "PROVIDER_UNAVAILABLE",
        "PERSISTENCE_FAILED",
    )

    data class DomainError(
        val code: String,
        val message: String,
        val retryable: Boolean,
        val safeDetails: Map<String, String>? = null,
    )

    fun createDomainError(
        code: String,
        message: String,
        retryable: Boolean? = null,
        safeDetails: Map<String, String>? = null,
    ): DomainError = DomainError(
        code = code,
        message = message,
        retryable = retryable ?: RETRYABLE_CODES.contains(code),
        safeDetails = safeDetails,
    )

    private val API_KEY = Regex("sk-[a-zA-Z0-9_-]{10,}")
    private val BEARER = Regex("Bearer\\s+[a-zA-Z0-9._-]{10,}", RegexOption.IGNORE_CASE)
    private val WINDOWS_PATH = Regex("[A-Z]:\\\\[^\\s\"]+")
    private val UNIX_PATH = Regex("/[^\\s\"]+\\.(?:json|log|db)")

    /** 简易脱敏：剥离 API Key / Bearer / 文件绝对路径（供错误映射前使用），并截断到 500 字符。 */
    fun sanitizeErrorMessage(raw: String): String {
        var value = API_KEY.replace(raw, "sk-***")
        value = BEARER.replace(value, "Bearer ***")
        value = WINDOWS_PATH.replace(value, "<path>")
        value = UNIX_PATH.replace(value, "<path>")
        return value.take(500)
    }
}
