package com.qingyu.companion.data

import kotlinx.serialization.SerializationException
import retrofit2.HttpException
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/**
 * 领域错误：统一 Repository 层异常，避免 Boolean/null 吞错（P1-4.4）。
 * UI 据类型决定：重新配对 / 升级 PC / 重试 / 离线查看。
 */
sealed class CompanionError(
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause) {

    /** 401 / token 失效 → 重新配对 */
    class Unauthorized(message: String = "未授权，请重新配对", cause: Throwable? = null) :
        CompanionError(message, cause)

    /** 版本不兼容（426 或 X-Api-Version 校验失败）→ 升级 PC 或安卓 */
    class IncompatibleVersion(message: String = "版本不兼容，请升级", cause: Throwable? = null) :
        CompanionError(message, cause)

    /** 无网络 / 无法连接 PC → 离线查看 */
    class Offline(message: String = "无法连接 PC，请检查网络", cause: Throwable? = null) :
        CompanionError(message, cause)

    /** 超时 */
    class Timeout(message: String = "请求超时，请重试", cause: Throwable? = null) :
        CompanionError(message, cause)

    /** 服务端拒绝（4xx/5xx，含 code） */
    class ServerRejected(
        val code: Int,
        message: String,
        cause: Throwable? = null,
    ) : CompanionError(message, cause)

    /** 解析失败（DTO 不兼容） */
    class ParseError(message: String = "数据解析失败", cause: Throwable? = null) :
        CompanionError(message, cause)

    /** 未知 */
    class Unknown(message: String = "未知错误", cause: Throwable? = null) :
        CompanionError(message, cause)
}

/** 将任意异常映射为 CompanionError */
fun Throwable.toCompanionError(): CompanionError {
    if (this is CompanionError) return this
    if (this is HttpException) {
        val code = code()
        val msg = message() ?: response()?.errorBody()?.string()?.take(200) ?: "HTTP $code"
        return when (code) {
            401 -> CompanionError.Unauthorized(msg, this)
            426 -> CompanionError.IncompatibleVersion(msg, this)
            else -> CompanionError.ServerRejected(code, msg, this)
        }
    }
    if (this is SocketTimeoutException) return CompanionError.Timeout(cause?.message ?: message ?: "超时", this)
    if (this is UnknownHostException || this is ConnectException) {
        return CompanionError.Offline(cause?.message ?: message ?: "无法连接", this)
    }
    if (this is IOException) {
        val msg = message?.lowercase() ?: ""
        return when {
            "timeout" in msg -> CompanionError.Timeout(message ?: "超时", this)
            "unable to resolve host" in msg || "failed to connect" in msg -> CompanionError.Offline(message ?: "离线", this)
            else -> CompanionError.Offline(message ?: "网络错误", this)
        }
    }
    if (this is SerializationException) return CompanionError.ParseError(message ?: "解析失败", this)
    // 检查 cause 链中是否有上述类型
    cause?.let { c ->
        if (c is HttpException || c is IOException || c is SerializationException) return c.toCompanionError()
    }
    return CompanionError.Unknown(message ?: "未知错误", this)
}

/** 用户可读提示（UI 层据类型展示可恢复操作） */
fun CompanionError.userMessage(): String = when (this) {
    is CompanionError.Unauthorized -> "未授权或令牌失效，请重新配对"
    is CompanionError.IncompatibleVersion -> "版本不兼容，请升级 PC 与安卓至最新"
    is CompanionError.Offline -> "离线或无法连接 PC，已显示本地缓存"
    is CompanionError.Timeout -> "请求超时，请重试"
    is CompanionError.ServerRejected -> "服务拒绝 ($code)：$message"
    is CompanionError.ParseError -> "数据解析失败，请升级"
    is CompanionError.Unknown -> message ?: "未知错误"
}

/** 是否可重试 */
fun CompanionError.isRetryable(): Boolean = when (this) {
    is CompanionError.Timeout -> true
    is CompanionError.Offline -> true
    is CompanionError.ServerRejected -> code in 500..599
    is CompanionError.Unknown -> true
    else -> false
}
