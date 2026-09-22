package com.qingyu.companion.mcp

import com.qingyu.companion.mcp.task.GenerationTaskToken
import com.qingyu.companion.mcp.task.McpGenerationTaskRegistry
import com.qingyu.companion.mcp.task.ScopeCheck
import com.qingyu.companion.mcp.task.TaskVerification
import com.qingyu.companion.mcp.task.ToolArgConstraint
import com.qingyu.companion.mcp.task.ToolGrantScope
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * 生成任务令牌与越权检查测试（S6-06：工具调用只能由当前生成任务发起；越权拒绝）。
 */
class GenerationTaskGuardTest {

    private val registry = McpGenerationTaskRegistry()
    private val scope = ToolGrantScope(
        serverId = "srv-1",
        toolName = "search",
        argKeysAllowed = setOf("query", "path"),
        argConstraints = listOf(ToolArgConstraint(key = "path", allowedPrefix = "/docs/")),
    )

    @Test
    fun `只有当前生成任务的令牌被接受`() {
        val token = registry.begin("task-1", listOf(scope))
        assertTrue(registry.verify(token) is TaskVerification.Current, "当前任务令牌必须被接受，否则正常生成无法调用工具")

        val forged = GenerationTaskToken(taskId = token.taskId, nonce = "伪造-nonce")
        assertTrue(registry.verify(forged) is TaskVerification.UnknownToken, "伪造 nonce 的令牌必须拒绝")

        val other = GenerationTaskToken(taskId = "other-task", nonce = token.nonce)
        assertTrue(registry.verify(other) is TaskVerification.UnknownToken, "其他任务的令牌必须拒绝")
    }

    @Test
    fun `任务切换与结束后旧令牌失效`() {
        val first = registry.begin("task-1", listOf(scope))
        val second = registry.begin("task-2", listOf(scope))
        assertTrue(registry.verify(first) is TaskVerification.StaleToken, "新任务开始后旧令牌必须失效，防止过期任务继续调工具")

        registry.complete(second)
        assertTrue(registry.verify(second) is TaskVerification.Completed, "任务结束后令牌必须失效，禁止事后补发工具调用")
    }

    @Test
    fun `未授权工具越权拒绝`() {
        val token = registry.begin("task-1", listOf(scope))
        val check = registry.checkScope(
            token, "srv-1", "delete_file",
            buildJsonObject { put("path", "/docs/a") },
        )
        assertTrue(check is ScopeCheck.UnauthorizedTool, "不在授权清单里的工具必须按越权拒绝")
    }

    @Test
    fun `超出授权范围的参数越权拒绝`() {
        val token = registry.begin("task-1", listOf(scope))

        val extraKey = registry.checkScope(
            token, "srv-1", "search",
            buildJsonObject { put("query", "x"); put("shell", "rm -rf") },
        )
        assertTrue(extraKey is ScopeCheck.OverreachArgs, "授权范围之外的参数键必须按越权拒绝")

        val outOfPrefix = registry.checkScope(
            token, "srv-1", "search",
            buildJsonObject { put("path", "/etc/passwd") },
        )
        assertTrue(outOfPrefix is ScopeCheck.OverreachArgs, "参数值越过授权前缀（/docs/）必须按越权拒绝")
    }

    @Test
    fun `授权范围内的调用通过`() {
        val token = registry.begin("task-1", listOf(scope))
        val ok = registry.checkScope(
            token, "srv-1", "search",
            buildJsonObject { put("query", "轻语"); put("path", "/docs/notes.md") },
        )
        assertTrue(ok is ScopeCheck.Ok, "参数完全落在授权范围内时必须放行，否则正常调用被误杀")
    }

    @Test
    fun `非当前任务令牌直接判越权`() {
        val stale = registry.begin("task-1", listOf(scope))
        registry.begin("task-2", listOf(scope))
        val check = registry.checkScope(stale, "srv-1", "search", buildJsonObject { put("query", "x") })
        assertTrue(check is ScopeCheck.UnauthorizedTool, "过期任务令牌的调用必须在越权检查处被拒绝")
    }

    @Test
    fun `allowedValues 约束同样生效`() {
        val enumScope = ToolGrantScope(
            serverId = "srv-1",
            toolName = "lookup",
            argConstraints = listOf(ToolArgConstraint(key = "mode", allowedValues = setOf("fast"))),
        )
        val token = registry.begin("task-1", listOf(enumScope))
        val ok = registry.checkScope(token, "srv-1", "lookup", buildJsonObject { put("mode", "fast") })
        assertTrue(ok is ScopeCheck.Ok, "取值在授权集合内必须放行")
        val bad = registry.checkScope(token, "srv-1", "lookup", buildJsonObject { put("mode", "deep-scan") })
        assertTrue(bad is ScopeCheck.OverreachArgs, "取值超出授权集合必须按越权拒绝")
    }
}
