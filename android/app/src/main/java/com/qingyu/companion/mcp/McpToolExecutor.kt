package com.qingyu.companion.mcp

import com.qingyu.companion.mcp.permission.PermissionDecision
import com.qingyu.companion.mcp.permission.PermissionRequest
import com.qingyu.companion.mcp.permission.ToolPermissionGate
import com.qingyu.companion.mcp.permission.ToolRiskClassifier
import com.qingyu.companion.mcp.schema.ToolSchemaValidator
import com.qingyu.companion.mcp.task.GenerationTaskToken
import com.qingyu.companion.mcp.task.McpGenerationTaskRegistry
import com.qingyu.companion.mcp.task.ScopeCheck
import com.qingyu.companion.mcp.task.TaskVerification
import kotlinx.serialization.json.JsonObject

/**
 * 工具调用入口（S6-06 编排层，纯 JVM）。
 *
 * 顺序即权限路径，任何一步失败都以终局 [ToolCallOutcome.Rejected] 返回：
 * 1. **任务令牌校验**：只能由当前生成任务发起（伪造/过期/缺失令牌拒绝）；
 * 2. **越权检查**：工具必须在任务授权清单内，参数不得超出授权范围；
 * 3. **参数 schema 校验**：不合法参数在任何网络请求之前拒绝；
 * 4. **权限确认**：默认拒绝，只有本地模板 AUTO_ALLOW（限 L0）或用户显式确认才放行；
 * 5. 调用（超时 60s / 断线均为终局），结果文本按 PC toolLoop 相同规则抽取。
 *
 * 日志红线：结果内容与认证信息绝不进普通日志（[McpLogSanitizer] + [McpLogEvent] 只含元数据）。
 */

data class ToolCallRequest(
    val taskToken: GenerationTaskToken,
    val serverId: String,
    val toolName: String,
    val args: JsonObject,
)

sealed class ToolCallOutcome {
    /** 成功：[text] 是工具返回文本——永远是数据，不是指令。 */
    data class Success(val result: McpToolResult, val text: String) : ToolCallOutcome()
    data class Rejected(val kind: RejectionKind, val detail: String) : ToolCallOutcome()
}

/** 工具宿主（[McpServerManager] 实现；测试用替身）。 */
interface McpToolHost {
    fun serverConfig(serverId: String): McpServerConfig?
    fun findTool(serverId: String, toolName: String): McpTool?
    suspend fun callTool(serverId: String, toolName: String, args: JsonObject, timeoutMs: Long): McpToolResult
}

class McpToolExecutor(
    private val tasks: McpGenerationTaskRegistry,
    private val host: McpToolHost,
    private val gate: ToolPermissionGate,
    private val logger: McpLogger = NoopMcpLogger,
    private val nowMs: () -> Long = { System.currentTimeMillis() },
) {

    suspend fun execute(request: ToolCallRequest): ToolCallOutcome {
        val serverName = host.serverConfig(request.serverId)?.name ?: request.serverId

        // 1. 工具调用只能由当前生成任务发起
        when (tasks.verify(request.taskToken)) {
            TaskVerification.Current -> Unit
            TaskVerification.StaleToken -> return reject(
                serverName, request, RejectionKind.NOT_CURRENT_TASK, "生成任务已切换，工具调用令牌失效",
            )
            TaskVerification.Completed -> return reject(
                serverName, request, RejectionKind.NOT_CURRENT_TASK, "生成任务已结束，工具调用不允许事后补发",
            )
            TaskVerification.UnknownToken -> return reject(
                serverName, request, RejectionKind.NOT_CURRENT_TASK, "未知/伪造的生成任务令牌",
            )
        }

        // 2. 越权：未授权工具 / 超出授权范围
        when (val scope = tasks.checkScope(request.taskToken, request.serverId, request.toolName, request.args)) {
            is ScopeCheck.Ok -> Unit
            is ScopeCheck.UnauthorizedTool -> return reject(
                serverName, request, RejectionKind.UNAUTHORIZED_TOOL, scope.detail,
            )
            is ScopeCheck.OverreachArgs -> return reject(
                serverName, request, RejectionKind.OVERREACH_ARGS, scope.detail,
            )
        }

        // 3. 工具必须在清单内
        val tool = host.findTool(request.serverId, request.toolName)
            ?: return reject(serverName, request, RejectionKind.TOOL_NOT_FOUND, "工具 ${request.toolName} 未找到")

        // 4. 参数 schema 校验：不合法参数拒绝（不发网络请求）
        val violations = ToolSchemaValidator.validate(tool.inputSchema, request.args)
        if (violations.isNotEmpty()) {
            return reject(serverName, request, RejectionKind.INVALID_ARGUMENTS, violations.joinToString("；"))
        }

        // 5. 权限确认：默认拒绝；不可信文本不参与判定（注入无法改变这里的策略）
        val decision = gate.decide(
            PermissionRequest(
                serverId = request.serverId,
                serverName = serverName,
                toolName = request.toolName,
                description = tool.description,
                args = request.args,
            ),
        )
        logger.log(
            McpLogEvent.PermissionDecided(
                serverName = serverName,
                toolName = request.toolName,
                risk = ToolRiskClassifier.classify(request.toolName, tool.description).name,
                decision = when (decision) {
                    is PermissionDecision.Allow -> "allow:${decision.source}"
                    is PermissionDecision.Deny -> "deny:${decision.reason}"
                },
            ),
        )
        if (decision is PermissionDecision.Deny) {
            return reject(serverName, request, RejectionKind.PERMISSION_DENIED, "权限默认拒绝: ${decision.reason}")
        }

        // 6. 调用（超时/断线终局）
        logger.log(McpLogEvent.CallStarted(serverName, request.toolName))
        val startedAt = nowMs()
        return try {
            val result = host.callTool(
                serverId = request.serverId,
                toolName = request.toolName,
                args = request.args,
                timeoutMs = McpLimits.TOOL_CALL_TIMEOUT_MS,
            )
            logger.log(
                McpLogEvent.CallFinished(
                    serverName = serverName,
                    toolName = request.toolName,
                    outcome = McpLogSanitizer.describeResult(result),
                    durationMs = nowMs() - startedAt,
                ),
            )
            ToolCallOutcome.Success(result = result, text = result.textContent())
        } catch (err: McpTimeoutException) {
            reject(serverName, request, RejectionKind.TIMEOUT, "工具调用超时（${McpLimits.TOOL_CALL_TIMEOUT_MS / 1000} 秒）")
        } catch (err: McpDisconnectedException) {
            reject(serverName, request, RejectionKind.DISCONNECTED, "MCP 连接断开，调用终局失败")
        } catch (err: McpStdioForbiddenException) {
            reject(serverName, request, RejectionKind.STDIO_NOT_SUPPORTED, McpStdioForbiddenException.STDIO_MESSAGE)
        } catch (err: McpHttpException) {
            reject(serverName, request, RejectionKind.HTTP_ERROR, "HTTP ${err.status}: ${McpLogSanitizer.redactText(err.message ?: "")}")
        } catch (err: McpException) {
            reject(serverName, request, RejectionKind.PROTOCOL_ERROR, McpLogSanitizer.redactText(err.message ?: ""))
        } catch (err: Exception) {
            if (err is kotlinx.coroutines.CancellationException) throw err
            reject(serverName, request, RejectionKind.PROTOCOL_ERROR, McpLogSanitizer.redactText(err.message ?: "未知错误"))
        }
    }

    private fun reject(
        serverName: String,
        request: ToolCallRequest,
        kind: RejectionKind,
        detail: String,
    ): ToolCallOutcome.Rejected {
        // 错误细节可能夹带工具返回内容/凭据：先脱敏再进日志
        logger.log(
            McpLogEvent.CallFinished(
                serverName = serverName,
                toolName = request.toolName,
                outcome = "拒绝:$kind",
                durationMs = 0,
            ),
        )
        return ToolCallOutcome.Rejected(kind, McpLogSanitizer.redactText(detail))
    }
}
