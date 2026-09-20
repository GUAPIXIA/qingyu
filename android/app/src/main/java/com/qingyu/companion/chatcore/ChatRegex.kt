package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-01：正则规则引擎（对齐 `shared/chat-core/regex.ts`）。
 *
 * 与 TS 的差异全部收敛到 [JsRegex]（全局标志 / 替换串语义 / 标志集）。
 * 安全约束与 PC 保持一致：模式长度上限 500，单次替换文本长度上限 200_000。
 */
object ChatRegex {

    const val MAX_PATTERN_LENGTH = 500
    const val MAX_TEXT_LENGTH = 200_000

    /** 正则规则（字段与 `shared/types.ts` 的 `RegexRule` 对齐）。 */
    data class Rule(
        val id: String,
        val name: String,
        val pattern: String,
        val replacement: String,
        val flags: String = "g",
        val enabled: Boolean = true,
        val scope: String = "output",
        val group: String? = null,
        val stage: String = "text",
        val triggerPattern: String? = null,
        val triggerFlags: String = "i",
        val stopStrings: List<String> = emptyList(),
    )

    data class ApplyResult(val text: String, val applied: Int, val matched: Int)

    /** 等价 `safeRegExp`：模式空/超长/非法或标志非法返回 null。 */
    fun safeRegExp(pattern: String, flags: String = "g"): Regex? {
        if (pattern.isEmpty() || pattern.length > MAX_PATTERN_LENGTH) return null
        return JsRegex.compile(pattern, flags)
    }

    /** 规则的 scope 是否匹配（`both` 同时匹配 input/output）。 */
    fun ruleMatchesScope(rule: Rule, scope: String): Boolean =
        rule.scope == scope || rule.scope == "both"

    /**
     * 规则是否作用于指定阶段。
     * text 阶段：`stage` 为 text（缺省）；markdown 阶段：仅 output 且 `stage = markdown`。
     */
    fun ruleMatchesStage(rule: Rule, scope: String, stage: String): Boolean {
        val ruleStage = rule.stage
        if (stage == "text") return ruleStage == "text"
        if (scope != "output") return false
        return ruleStage == "markdown"
    }

    /** 触发条件：triggerPattern 为空总是执行；否则需匹配（默认 flags `i`）。 */
    fun ruleTriggers(rule: Rule, text: String): Boolean {
        val pattern = rule.triggerPattern?.trim()
        if (pattern.isNullOrEmpty()) return true
        val regex = safeRegExp(pattern, rule.triggerFlags.ifEmpty { "i" }) ?: return false
        return regex.containsMatchIn(text)
    }

    /** 应用单条规则（只做触发检查 + 替换，scope/stage 由调用方过滤）。 */
    fun applyRuleOnce(text: String, rule: Rule): Pair<String, Boolean> {
        if (!rule.enabled) return text to false
        val pattern = rule.pattern.trim()
        if (pattern.isEmpty()) return text to false
        if (!ruleTriggers(rule, text)) return text to false
        val regex = safeRegExp(pattern, rule.flags.ifEmpty { "g" }) ?: return text to false
        if (text.length > MAX_TEXT_LENGTH) return text to false
        return runCatching {
            JsRegex.jsReplace(text, regex, rule.replacement, JsRegex.isGlobal(rule.flags.ifEmpty { "g" }))
        }.getOrElse { text to false }
    }

    /** 按规则列表原序应用匹配 scope + stage 的规则。 */
    fun applyRegexRules(text: String, rules: List<Rule>, scope: String, stage: String): ApplyResult {
        if (text.isEmpty() || rules.isEmpty()) return ApplyResult(text, 0, 0)
        var result = text
        var applied = 0
        var matched = 0
        for (rule in rules) {
            if (!rule.enabled) continue
            if (!ruleMatchesScope(rule, scope)) continue
            if (!ruleMatchesStage(rule, scope, stage)) continue
            applied++
            val (next, replaced) = applyRuleOnce(result, rule)
            if (replaced) matched++
            result = next
        }
        return ApplyResult(result, applied, matched)
    }

    /** output 两阶段应用：先 text 后 markdown。 */
    fun applyOutputRegexRules(text: String, rules: List<Rule>): String {
        if (text.isEmpty() || rules.isEmpty()) return text
        var result = applyRegexRules(text, rules, "output", "text").text
        result = applyRegexRules(result, rules, "output", "markdown").text
        return result
    }

    /** 第一个停止字符串位置（最短命中优先，保持列表顺序）；未命中 -1。 */
    fun findStopIndex(text: String, stopStrings: List<String>): Int {
        if (text.isEmpty() || stopStrings.isEmpty()) return -1
        var best = -1
        for (s in stopStrings) {
            if (s.isEmpty()) continue
            val idx = text.indexOf(s)
            if (idx != -1 && (best == -1 || idx < best)) best = idx
        }
        return best
    }

    /** 按停止字符串截断（截断后 trimEnd）。 */
    fun truncateAtStop(text: String, stopStrings: List<String>): Pair<String, Boolean> {
        val idx = findStopIndex(text, stopStrings)
        if (idx == -1) return text to false
        return text.substring(0, idx).trimEnd() to true
    }

    /** 提取启用 output 规则（排除 markdown 阶段）的停止字符串，去空去重保持顺序。 */
    fun collectStopStrings(rules: List<Rule>): List<String> {
        val result = mutableListOf<String>()
        val seen = mutableSetOf<String>()
        for (rule in rules) {
            if (!rule.enabled) continue
            if (!ruleMatchesScope(rule, "output")) continue
            if (rule.stage == "markdown") continue
            for (s in rule.stopStrings) {
                val t = s.trim()
                if (t.isNotEmpty() && seen.add(t)) result += t
            }
        }
        return result
    }
}
