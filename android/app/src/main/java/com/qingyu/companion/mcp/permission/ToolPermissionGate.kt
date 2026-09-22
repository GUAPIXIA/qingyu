package com.qingyu.companion.mcp.permission

import com.qingyu.companion.mcp.McpLimits
import com.qingyu.companion.mcp.McpPermissionTemplate
import com.qingyu.companion.mcp.McpToolRule
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject

/**
 * MCP 工具权限确认状态机（S6-06：权限默认拒绝；提示注入不得绕过权限）。
 *
 * 与 PC electron/chat/toolGate.ts 对齐：
 * - 决定只有 allow / deny 两类；超时即 deny（PC waiting_approval 60s 默认拒绝）；
 * - 默认拒绝：没有**显式允许来源**（本地权限模板 AUTO_ALLOW / 用户逐次确认）时一律拒绝；
 * - 风险分级与 PC 相同（L0-L3），L0 之外必须逐次确认；
 * - 不可信文本（工具描述、工具返回文本 [PermissionRequest.untrustedToolText]）
 *   **绝不参与放行判定**：它们只能升级风险，无法把拒绝变成允许。
 *   本类的所有放行来源只有两个本地输入：[McpPermissionTemplate]（用户本地配置）
 *   与 [ToolConfirmationPort] 的用户确认结果。
 */

/** 权限判定请求。除本地字段外均为不可信数据。 */
data class PermissionRequest(
    val serverId: String,
    val serverName: String,
    val toolName: String,
    /** 服务端提供的工具描述（不可信）：只影响展示与风险升级。 */
    val description: String = "",
    /** 调用参数（不可信）：只影响展示与越权范围检查。 */
    val args: JsonObject = JsonObject(emptyMap()),
    /**
     * 显式标注的不可信文本（例如工具上一次返回内容、模型提示词注入片段）。
     * 该字段**绝不**参与任何放行判定，仅用于测试证明注入无法改变决策。
     */
    val untrustedToolText: String = "",
)

/** 用户确认弹窗输入（UI 只展示脱敏/结构化信息，不展示 untrustedToolText）。 */
data class ConfirmationRequest(
    val serverName: String,
    val toolName: String,
    val risk: ToolRiskClassifier.Level,
    val argsPreview: String,
)

/** 确认端口（UI 接线点）：返回 true 表示用户显式「仅本次允许」。 */
fun interface ToolConfirmationPort {
    suspend fun confirm(request: ConfirmationRequest): Boolean
}

sealed class PermissionDecision {
    /** 放行来源只能是本地输入。 */
    enum class Source { TEMPLATE_AUTO_ALLOW, USER_CONFIRMED }

    enum class Reason {
        /** 权限模板显式拒绝。 */
        TEMPLATE_DENY,

        /** 用户拒绝。 */
        USER_REJECTED,

        /** 确认超时：默认拒绝。 */
        APPROVAL_TIMEOUT,

        /** 未获显式允许即默认拒绝（模板 AUTO_ALLOW 因风险升级失效且无用户确认）。 */
        DEFAULT_DENY,
    }

    data class Allow(val source: Source) : PermissionDecision()
    data class Deny(val reason: Reason) : PermissionDecision()
}

class ToolPermissionGate(
    private val template: McpPermissionTemplate,
    private val confirmation: ToolConfirmationPort,
    private val approvalTimeoutMs: Long = McpLimits.APPROVAL_TIMEOUT_MS,
) {

    val permissionTemplate: McpPermissionTemplate get() = template

    suspend fun decide(request: PermissionRequest): PermissionDecision {
        val rule = template.ruleFor(request.serverId, request.toolName)
        if (rule == McpToolRule.DENY) return PermissionDecision.Deny(PermissionDecision.Reason.TEMPLATE_DENY)

        // 风险分级只使用工具名/描述；其中描述是不可信文本，可能升级风险（取两者较高者）。
        val risk = ToolRiskClassifier.classify(request.toolName, request.description)

        // 模板 AUTO_ALLOW 只在「自动放行资格」成立时生效；不可信描述无法维持/制造放行。
        if (rule == McpToolRule.AUTO_ALLOW && ToolRiskClassifier.autoAllowEligible(request.toolName, request.description)) {
            return PermissionDecision.Allow(PermissionDecision.Source.TEMPLATE_AUTO_ALLOW)
        }

        // 其余情况：必须逐次确认；确认入口不含 untrustedToolText（注入文本不可影响弹窗决策语义）。
        val confirmed = try {
            withTimeoutOrNull(approvalTimeoutMs) {
                confirmation.confirm(
                    ConfirmationRequest(
                        serverName = request.serverName,
                        toolName = request.toolName,
                        risk = risk,
                        argsPreview = request.args.toString(),
                    ),
                )
            }
        } catch (cancelled: TimeoutCancellationException) {
            null
        }

        return when (confirmed) {
            true -> PermissionDecision.Allow(PermissionDecision.Source.USER_CONFIRMED)
            false -> PermissionDecision.Deny(PermissionDecision.Reason.USER_REJECTED)
            null -> PermissionDecision.Deny(PermissionDecision.Reason.APPROVAL_TIMEOUT)
        }
    }

    companion object {
        /** 无显式允许即拒绝的静态判定（供上层在不进入确认流程时使用）。 */
        fun defaultDeny(): PermissionDecision = PermissionDecision.Deny(PermissionDecision.Reason.DEFAULT_DENY)
    }
}
