package com.qingyu.companion.content.lorebook

/**
 * 阶段 5 S5-02：兼容性报告与适配层错误
 * （`shared/lorebook/adapters/types.ts` 的报告部分 + `lorebookAdapters/report.ts` +
 * `lorebookAdapters/error.ts`）。
 *
 * 报告是**用户可见**的：方案 S5-02 要求「对支持格式导出并生成兼容性报告」，
 * 而 §6.5 的口径是「近似、丢弃、拒绝都必须显式说出来，不许静默改语义」。
 * 所以 `code` / `severity` / `action` 三元组和 `status` 的推导规则都是契约的一部分，
 * 改任何一个都会让 Android 的报告与 PC 对不上——文案（中文）同样如此，
 * 因此这里**原样保留 PC 的字符串**而不是重写一套。
 */

/** `CompatibilitySeverity`。 */
enum class LorebookCompatibilitySeverity(val jsonValue: String) {
    INFO("info"),
    WARNING("warning"),
    ERROR("error"),
}

/** `CompatibilityAction`：该字段最终怎么处理的。 */
enum class LorebookCompatibilityAction(val jsonValue: String) {
    MAPPED("mapped"),
    PRESERVED("preserved"),
    APPROXIMATED("approximated"),
    DROPPED("dropped"),
    REJECTED("rejected"),
}

/** `LorebookCompatibilityIssue`。 */
data class LorebookCompatibilityIssue(
    val severity: LorebookCompatibilitySeverity,
    val action: LorebookCompatibilityAction,
    val code: String,
    val path: String,
    val message: String,
) {
    fun toJsonMap(): Map<String, Any?> = linkedMapOf(
        "severity" to severity.jsonValue,
        "action" to action.jsonValue,
        "code" to code,
        "path" to path,
        "message" to message,
    )

    companion object {
        /** `compatibilityIssue(severity, action, code, path, message)`。 */
        fun of(
            severity: LorebookCompatibilitySeverity,
            action: LorebookCompatibilityAction,
            code: String,
            path: String,
            message: String,
        ): LorebookCompatibilityIssue =
            LorebookCompatibilityIssue(severity, action, code, path, message)
    }
}

/** `LorebookCompatibilityReport.status`。 */
enum class LorebookCompatibilityStatus(val jsonValue: String) {
    EXACT("exact"),
    PRESERVED("preserved"),
    APPROXIMATED("approximated"),
    REJECTED("rejected"),
}

/** `LorebookCompatibilityReport.summary`。 */
data class LorebookCompatibilitySummary(
    val mapped: Int = 0,
    val preserved: Int = 0,
    val approximated: Int = 0,
    val dropped: Int = 0,
    val rejected: Int = 0,
    val warnings: Int = 0,
    val errors: Int = 0,
)

/**
 * `LorebookCompatibilityReport`。
 *
 * `status` 的推导顺序（与 PC 完全一致，先 rejected 再 approximated 再 preserved）：
 * 有 `rejected` 动作**或**任何 `error` 级 issue 即整体拒绝；
 * 有丢弃或近似则是 `approximated`；只有保留区是 `preserved`；否则 `exact`。
 * 顺序很重要：一份「保留了未知字段但也丢了超限字段」的报告必须是 `approximated`，
 * 反过来就会让用户以为什么都没丢。
 */
data class LorebookCompatibilityReport(
    val adapterId: String,
    val formatLabel: String,
    val formatVersion: String,
    val status: LorebookCompatibilityStatus,
    val issues: List<LorebookCompatibilityIssue>,
    val summary: LorebookCompatibilitySummary,
) {
    val isRejected: Boolean
        get() = status == LorebookCompatibilityStatus.REJECTED

    fun toJsonMap(): Map<String, Any?> = linkedMapOf(
        "adapterId" to adapterId,
        "formatLabel" to formatLabel,
        "formatVersion" to formatVersion,
        "status" to status.jsonValue,
        "issues" to issues.map { it.toJsonMap() },
        "summary" to linkedMapOf(
            "mapped" to summary.mapped,
            "preserved" to summary.preserved,
            "approximated" to summary.approximated,
            "dropped" to summary.dropped,
            "rejected" to summary.rejected,
            "warnings" to summary.warnings,
            "errors" to summary.errors,
        ),
    )

    companion object {
        /** `createCompatibilityReport(adapterId, formatLabel, formatVersion, issues)`。 */
        fun create(
            adapterId: String,
            formatLabel: String,
            formatVersion: String,
            issues: List<LorebookCompatibilityIssue> = emptyList(),
        ): LorebookCompatibilityReport {
            fun count(action: LorebookCompatibilityAction) = issues.count { it.action == action }
            val summary = LorebookCompatibilitySummary(
                mapped = count(LorebookCompatibilityAction.MAPPED),
                preserved = count(LorebookCompatibilityAction.PRESERVED),
                approximated = count(LorebookCompatibilityAction.APPROXIMATED),
                dropped = count(LorebookCompatibilityAction.DROPPED),
                rejected = count(LorebookCompatibilityAction.REJECTED),
                warnings = issues.count { it.severity == LorebookCompatibilitySeverity.WARNING },
                errors = issues.count { it.severity == LorebookCompatibilitySeverity.ERROR },
            )
            val status = when {
                summary.rejected > 0 || summary.errors > 0 -> LorebookCompatibilityStatus.REJECTED
                summary.dropped > 0 || summary.approximated > 0 -> LorebookCompatibilityStatus.APPROXIMATED
                summary.preserved > 0 -> LorebookCompatibilityStatus.PRESERVED
                else -> LorebookCompatibilityStatus.EXACT
            }
            return LorebookCompatibilityReport(adapterId, formatLabel, formatVersion, status, issues, summary)
        }
    }
}

/**
 * `LorebookAdapterError`：导入被拒或结构非法时抛出，附带完整报告。
 *
 * `message` 是**面向用户**的文案（PC 侧直接显示在导入结果里），
 * 所以抛出方的字符串一律照抄，不做本地化重写。
 */
class LorebookAdapterError(
    message: String,
    val report: LorebookCompatibilityReport? = null,
) : IllegalStateException(message)

/**
 * `LorebookMigrationError`：既不是合法 canonical v2、也不是合法 native v1
 * （`shared/lorebook/migrations/index.ts`）。
 */
class LorebookMigrationError(
    message: String,
    val issues: List<LorebookValidationIssue>,
) : IllegalStateException(message)

/** `CanonicalValidationIssue`：路径 + 中文说明。 */
data class LorebookValidationIssue(val path: String, val message: String)
