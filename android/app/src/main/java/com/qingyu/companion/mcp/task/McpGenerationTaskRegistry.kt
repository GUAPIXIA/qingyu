package com.qingyu.companion.mcp.task

import kotlinx.serialization.json.JsonElement

/**
 * 生成任务令牌与授权范围（S6-06：工具调用**只能由当前生成任务发起**）。
 *
 * - [McpGenerationTaskRegistry] 维护唯一的「当前生成任务」；只有持当前令牌的调用可以继续；
 * - 每个任务携带授权范围 [ToolGrantScope]：未授权工具、超出参数授权范围一律拒绝（越权）；
 * - 令牌含不可预测 nonce，伪造/复制旧令牌/任务结束后的令牌全部拒绝。
 */

data class GenerationTaskToken(
    val taskId: String,
    val nonce: String,
)

/** 参数约束：值必须属于 [allowedValues] 且以其 [allowedPrefix] 开头（各自为 null 表示该项不限制）。 */
data class ToolArgConstraint(
    val key: String,
    val allowedValues: Set<String>? = null,
    val allowedPrefix: String? = null,
)

/** 单个工具的授权范围。 */
data class ToolGrantScope(
    val serverId: String,
    val toolName: String,
    /** 允许出现的参数键集合；null 表示不限制键集合。 */
    val argKeysAllowed: Set<String>? = null,
    /** 逐参数取值约束。 */
    val argConstraints: List<ToolArgConstraint> = emptyList(),
)

sealed class TaskVerification {
    data object Current : TaskVerification()
    data object UnknownToken : TaskVerification()
    data object StaleToken : TaskVerification()
    data object Completed : TaskVerification()
}

sealed class ScopeCheck {
    data object Ok : ScopeCheck()
    data class UnauthorizedTool(val detail: String) : ScopeCheck()
    data class OverreachArgs(val detail: String) : ScopeCheck()
}

class McpGenerationTaskRegistry {

    private data class ActiveTask(
        val taskId: String,
        val token: GenerationTaskToken,
        val scopes: List<ToolGrantScope>,
        var completed: Boolean = false,
    )

    private var current: ActiveTask? = null
    private var previous: ActiveTask? = null
    private var nonceCounter = 0L

    /** 开始一个生成任务，返回任务令牌；上一任务立即作废（stale）。 */
    @Synchronized
    fun begin(taskId: String, scopes: List<ToolGrantScope>): GenerationTaskToken {
        val token = GenerationTaskToken(taskId = taskId, nonce = "n${++nonceCounter}-${taskId.hashCode()}")
        previous = current?.takeIf { !it.completed }
        current = ActiveTask(taskId, token, scopes)
        return token
    }

    /** 结束任务：令牌立即失效，后续携带该令牌的调用一律拒绝。 */
    @Synchronized
    fun complete(token: GenerationTaskToken) {
        val task = current ?: return
        if (task.token == token) task.completed = true
    }

    @Synchronized
    fun verify(token: GenerationTaskToken): TaskVerification {
        val task = current
            ?: return if (previous?.token == token) TaskVerification.StaleToken else TaskVerification.UnknownToken
        return when {
            task.token == token && task.completed -> TaskVerification.Completed
            task.token == token -> TaskVerification.Current
            previous?.token == token -> TaskVerification.StaleToken
            else -> TaskVerification.UnknownToken
        }
    }

    /** 越权检查：工具必须在授权清单内，参数必须落在授权范围里。 */
    @Synchronized
    fun checkScope(token: GenerationTaskToken, serverId: String, toolName: String, args: Map<String, JsonElement>): ScopeCheck {
        if (verify(token) !is TaskVerification.Current) {
            return ScopeCheck.UnauthorizedTool("工具调用不是由当前生成任务发起")
        }
        val task = current!!
        val scope = task.scopes.firstOrNull { it.serverId == serverId && it.toolName == toolName }
            ?: return ScopeCheck.UnauthorizedTool("工具 $toolName 未在本任务授权清单内")

        scope.argKeysAllowed?.let { allowed ->
            val extra = args.keys.filter { it !in allowed }
            if (extra.isNotEmpty()) {
                return ScopeCheck.OverreachArgs("参数超出授权范围: ${extra.sorted().joinToString(", ")}")
            }
        }
        for (constraint in scope.argConstraints) {
            val value = args[constraint.key] ?: continue
            val text = (value as? kotlinx.serialization.json.JsonPrimitive)?.content ?: continue
            val valueOk = constraint.allowedValues?.let { text in it } ?: true
            val prefixOk = constraint.allowedPrefix?.let { text.startsWith(it) } ?: true
            if (!valueOk || !prefixOk) {
                return ScopeCheck.OverreachArgs("参数 ${constraint.key} 超出授权范围")
            }
        }
        return ScopeCheck.Ok
    }
}
