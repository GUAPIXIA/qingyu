package com.qingyu.companion.mcp.permission

/**
 * 工具风险分级（与 PC electron/mcp/toolPermission.ts 的 classifyToolRisk 正则语义一致：L0-L3）。
 *
 * L0 明确无副作用（time/date/math/calculate）；L1 默认；L2 有副作用（send/post/create/...）；
 * L3 高危（shell/exec/delete/filesystem/...）。
 *
 * **不可信输入中立性**（阶段 6 §3 第 5 条：提示注入不得绕过权限）：
 * 工具名与描述都是服务端（不可信）文本。它们可以**升级**风险（触发更严格的确认），
 * 但**永远不能**把「需要确认」降级成「自动放行」——自动放行资格 [autoAllowEligible]
 * 要求工具名**单独**命中 L0 且加入描述后仍然不升级；真正的放行还需要用户本地权限模板
 * 显式配置 AUTO_ALLOW（模板只能由用户写入，远端文本改不了）。
 */
object ToolRiskClassifier {

    enum class Level { L0, L1, L2, L3 }

    private val L3_REGEX = Regex("""shell|exec|process|terminal|delete|remove|write[_ -]?file|filesystem""")
    private val L2_REGEX = Regex("""send|post|create|update|modify|upload|publish|message|task""")
    private val L0_REGEX = Regex("""time|date|math|calculate|calculator""")

    /** PC 同构分级：按 L3 > L2 > L0 > 兜底 L1 的顺序匹配组合文本。 */
    fun classify(name: String, description: String = ""): Level {
        val value = "$name $description".lowercase()
        return when {
            L3_REGEX.containsMatchIn(value) -> Level.L3
            L2_REGEX.containsMatchIn(value) -> Level.L2
            L0_REGEX.containsMatchIn(value) -> Level.L0
            else -> Level.L1
        }
    }

    /**
     * 自动放行（AUTO_ALLOW 模板）资格：名称单独为 L0，且描述加入后仍是 L0。
     * 描述里的注入文本（例如给 read_file 注入 "calculate math"）无法把 L1 降成 L0。
     */
    fun autoAllowEligible(name: String, description: String): Boolean =
        classify(name, "") == Level.L0 && classify(name, description) == Level.L0

    /** 风险是否要求人工确认（L1 及以上必须确认；L0 仅在模板显式 AUTO_ALLOW 时免确认）。 */
    fun requiresConfirmation(level: Level): Boolean = level != Level.L0
}
