package com.qingyu.companion.content

import com.qingyu.companion.model.QuickReply
import com.qingyu.companion.model.QuickReplyAction

/**
 * 阶段 5 S5-06：快捷回复的执行策略。
 *
 * 方案的原话：「文本插入与立即发送行为；**命令型回复只允许 Android 已支持命令，
 * 平台专用命令显示禁用原因**；导入导出兼容」。
 *
 * 为什么必须显式列命令表而不是「先收下、执行时再说」：
 * 快捷回复是用户从 PC 同步/导入过来的，里面完全可能出现 `/imagine`（PC 走 ComfyUI/SD WebUI，
 * Android 按总方案 §3.2 属于阶段 6 的平台扩展）。如果按钮照亮、点了没反应，
 * 用户只能靠猜来判断「是没生效还是功能不存在」。所以可用性在渲染时就要定，原因要能显示。
 *
 * 命令名单与语义来自 `src/commands/builtin/`，解析规则来自 `src/commands/parser.ts`，
 * 两处都必须与 PC 一致——同一串输入解析出不同命令名，快捷回复就会执行到别的动作上。
 */
object QuickReplyPolicy {

    data class Parsed(val name: String, val args: List<String>, val raw: String)

    /** 命令在 Android 的支持状态。 */
    enum class CommandSupport {
        /** Android 已实现，可直接执行 */
        SUPPORTED,

        /** 平台专用或后续阶段能力；按钮禁用并显示原因，不静默吞掉 */
        PLATFORM_ONLY,

        /** 两端都没有这个命令（多半是导入来的脏数据） */
        UNKNOWN,
    }

    data class CommandDecision(
        val support: CommandSupport,
        val reason: String,
        /** 该能力被安排在哪个阶段，用于把原因说清楚而不是只说「不支持」 */
        val scheduledFor: String? = null,
    )

    /** 一条快捷回复最终能不能按、按下去做什么。 */
    sealed interface Action {
        /** 宏展开后作为用户消息发送；[sendWithAi] 决定是否顺带触发 AI 回复 */
        data class InsertText(val content: String, val sendWithAi: Boolean) : Action
        data class SwitchPreset(val presetId: String) : Action
        data class RunCommand(val command: String, val parsed: Parsed) : Action
        /** 禁用态：UI 必须显示 [reason]，不得只是不响应 */
        data class Disabled(val reason: String) : Action
    }

    // ------------------------------------------------------------ 解析（对齐 PC parser.ts）

    /**
     * 与 PC `parseCommand` 逐条对齐：非 `/` 开头返回 null、命令名小写、
     * 引号内空白不切分、参数去掉外层引号。
     */
    fun parseCommand(input: String): Parsed? {
        val trimmed = input.trim()
        if (!trimmed.startsWith("/")) return null
        val rest = trimmed.substring(1)
        val tokens = TOKEN_PATTERN.findAll(rest).map { it.value }.toList()
        if (tokens.isEmpty()) return null
        return Parsed(
            name = tokens[0].lowercase(),
            args = tokens.drop(1).map { QUOTE_STRIP.replace(it, "") },
            raw = trimmed,
        )
    }

    // 与 JS `(?:[^\s"']+|"[^"]*"|'[^']*')+` 等价：引号段整体成一个 token。
    private val TOKEN_PATTERN = Regex("""[^\s"']+|"[^"]*"|'[^']*'""")
    private val QUOTE_STRIP = Regex("""^["']|["']$""")

    // ------------------------------------------------------------ 命令支持表

    /**
     * Android 侧命令支持情况。
     *
     * 只列 PC `src/commands/builtin/` 里真实存在的 14 条命令；
     * 判定依据是「Android 现在有没有等价入口」，不是「这功能该不该有」。
     */
    private val COMMANDS: Map<String, CommandDecision> = mapOf(
        "character" to CommandDecision(
            CommandSupport.SUPPORTED,
            "切换角色",
        ),
        "clear" to CommandDecision(CommandSupport.SUPPORTED, "清空当前会话"),
        "continue" to CommandDecision(CommandSupport.SUPPORTED, "AI 续写"),
        "export" to CommandDecision(CommandSupport.SUPPORTED, "导出当前会话"),
        "lorebook" to CommandDecision(CommandSupport.SUPPORTED, "切换世界书激活"),
        "persona" to CommandDecision(CommandSupport.SUPPORTED, "切换人设"),
        "preset" to CommandDecision(CommandSupport.SUPPORTED, "切换预设"),
        "regenerate" to CommandDecision(CommandSupport.SUPPORTED, "重新生成"),
        "swipe" to CommandDecision(CommandSupport.SUPPORTED, "切换候选回复"),
        "summary" to CommandDecision(CommandSupport.SUPPORTED, "生成会话摘要"),
        "token" to CommandDecision(CommandSupport.SUPPORTED, "统计上下文 token"),
        "help" to CommandDecision(
            CommandSupport.PLATFORM_ONLY,
            "命令帮助依赖 PC 的命令面板 UI",
            scheduledFor = "随快捷回复编辑器提供移动端命令列表",
        ),
        "imagine" to CommandDecision(
            CommandSupport.PLATFORM_ONLY,
            "生图依赖 ComfyUI / SD WebUI 本机服务，移动端不在本机启动",
            scheduledFor = "阶段 6（平台扩展对齐）",
        ),
        "plan" to CommandDecision(
            CommandSupport.PLATFORM_ONLY,
            "生成规划器面板是桌面端交互",
            scheduledFor = "阶段 6（平台扩展对齐）",
        ),
    )

    /** 供编辑器下拉列表使用：只列出 Android 能执行的命令名。 */
    val selectableCommands: List<String>
        get() = COMMANDS.filterValues { it.support == CommandSupport.SUPPORTED }.keys.sorted()

    fun decideCommand(command: String?): CommandDecision {
        val parsed = command?.let { parseCommand(it) }
            ?: return CommandDecision(CommandSupport.UNKNOWN, "命令为空或不是 `/` 开头")
        return COMMANDS[parsed.name]
            ?: CommandDecision(CommandSupport.UNKNOWN, "未知命令 /${parsed.name}")
    }

    /**
     * 决定一条快捷回复的行为。[commandEnabled] 为 false 时命令类一律降级为禁用说明——
     * 用于「用户显式关闭命令执行」的场景，而不是把功能做没。
     */
    fun resolve(qr: QuickReply, commandEnabled: Boolean = true): Action {
        if (!qr.enabled) return Action.Disabled("该快捷回复已停用")
        return when (qr.action) {
            QuickReplyAction.text -> Action.InsertText(qr.content, qr.sendWithAI)
            QuickReplyAction.preset -> {
                val presetId = qr.presetId
                if (presetId.isNullOrBlank()) Action.Disabled("目标是切换预设，但没有填预设 ID")
                else Action.SwitchPreset(presetId)
            }
            QuickReplyAction.command -> {
                val parsed = qr.command?.let { parseCommand(it) }
                val decision = decideCommand(qr.command)
                when {
                    !commandEnabled -> Action.Disabled("命令型快捷回复当前已整体关闭")
                    parsed != null && decision.support == CommandSupport.SUPPORTED ->
                        Action.RunCommand(qr.command.orEmpty(), parsed)
                    else -> Action.Disabled(decision.reasonFor(parsed))
                }
            }
        }
    }

    /** 把「为什么按不了」拼成一句能直接显示的话；命令名缺失时也要说清是哪条。 */
    private fun CommandDecision.reasonFor(parsed: Parsed?): String {
        val subject = parsed?.let { "/${it.name}" } ?: "该命令"
        return listOfNotNull("$subject：$reason", scheduledFor?.let { "计划 $it" }).joinToString("；")
    }
}
