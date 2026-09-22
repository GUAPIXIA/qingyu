package com.qingyu.companion.mcp

/**
 * MCP 错误与终局结果类型（S6-06：超时、断线必须是终局，不得无限挂起）。
 * 所有异常都是纯 JVM 类型，不依赖 Android API。
 */

sealed class McpException(message: String) : Exception(message)

/** stdio 本地进程是架构禁令（总方案 §3.2）：任何启动路径都以此错误终局。 */
class McpStdioForbiddenException(message: String = STDIO_MESSAGE) : McpException(message) {
    companion object {
        const val STDIO_MESSAGE = "stdio MCP 仅 PC 支持（platformSupport=pc_only），Android 不启动本地进程"
    }
}

/** 连接断开：pending 请求全部以此终局失败。 */
class McpDisconnectedException(message: String = "MCP 连接已断开") : McpException(message)

/** 请求超时：单次调用以此终局，不留后台重试。 */
class McpTimeoutException(message: String) : McpException(message)

/** 协议错误（消息形状不符、schema 非法等）。 */
class McpProtocolException(message: String) : McpException(message)

/** JSON-RPC error 响应。 */
class McpRpcException(val code: Long?, message: String) : McpException(message)

/** HTTP 传输层错误（非 2xx/202 等）。 */
class McpHttpException(val status: Int, message: String) : McpException(message)

/** 配置校验失败。 */
class McpConfigInvalidException(message: String) : McpException(message)

/** 工具调用被拒绝/失败的终局原因（覆盖阶段 6 §3 测试矩阵第 5 条全部分支）。 */
enum class RejectionKind {
    /** 非当前生成任务发起（伪造/过期/缺失任务令牌）——工具调用只能由当前生成任务发起。 */
    NOT_CURRENT_TASK,

    /** 未授权工具：不在本任务授权清单内。 */
    UNAUTHORIZED_TOOL,

    /** 超出授权范围：参数越界。 */
    OVERREACH_ARGS,

    /** 参数不合法（不符合工具参数 schema）。 */
    INVALID_ARGUMENTS,

    /** 权限默认拒绝（模板拒绝 / 用户拒绝 / 确认超时）。 */
    PERMISSION_DENIED,

    /** 调用超时（终局）。 */
    TIMEOUT,

    /** 连接断开（终局）。 */
    DISCONNECTED,

    /** 工具不存在。 */
    TOOL_NOT_FOUND,

    /** stdio 不支持。 */
    STDIO_NOT_SUPPORTED,

    /** 协议错误。 */
    PROTOCOL_ERROR,

    /** 服务端 JSON-RPC error。 */
    RPC_ERROR,

    /** HTTP 传输错误。 */
    HTTP_ERROR,
}
