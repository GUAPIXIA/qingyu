package com.qingyu.companion.content.lorebook

/**
 * 阶段 5 S5-02：导入边界的安全与体积上限
 * （`shared/lorebook/limits.ts` 的逐条移植，方案 §15、§6.5）。
 *
 * 上限数值**照抄 TS 常量**，一个都不重新估：
 * `LOREBOOK_IMPORT_LIMITS` 与 `LOREBOOK_REGEX_ALLOWED_FLAGS` 都是 PC 已发布语义的一部分，
 * 改任何一个都会让同一份外部文件在两端得到不同的导入结果
 * （比如 40 层嵌套在 PC 能导入、在 Android 被拒）。
 *
 * 只约束外部数据进入时的规模；用户后续编辑不在此限制范围内，
 * 存量世界书也不会因为上限调整而无法保存。
 */
object LorebookLimits {

    /** `LOREBOOK_IMPORT_LIMITS.maxFileBytes`：单个导入文件的最大字节数（与自动匹配扫描的 20 MB 上限一致）。 */
    const val MAX_FILE_BYTES: Long = 20L * 1024L * 1024L

    /** `maxEntries`：一次导入的最大条目数。 */
    const val MAX_ENTRIES = 20_000

    /** `maxEntryContentChars`：单条正文最大字符数。 */
    const val MAX_ENTRY_CONTENT_CHARS = 200_000

    /** `maxJsonDepth`：JSON 最大嵌套深度（防御超深结构导致遍历栈溢出）。 */
    const val MAX_JSON_DEPTH = 64

    /** `maxForeignCharsPerEntry`：单条目 foreign 保留区最大字符数。 */
    const val MAX_FOREIGN_CHARS_PER_ENTRY = 32 * 1024

    /** `maxForeignCharsPerBook`：整本书 foreign 保留区最大字符数。 */
    const val MAX_FOREIGN_CHARS_PER_BOOK = 512 * 1024

    /** `maxRegexPatternLength`：正则 pattern 最大长度。 */
    const val MAX_REGEX_PATTERN_LENGTH = 1000

    /** `LOREBOOK_REGEX_ALLOWED_FLAGS`：允许的正则 flags 白名单（方案 §15：正则限制长度和 flags）。 */
    const val REGEX_ALLOWED_FLAGS = "gimsuy"

    /**
     * 迭代检查 JSON 嵌套深度（PC `assertImportJsonDepth`）。
     *
     * 用显式栈而不是递归：递归遍历在超深结构上本身就会先栈溢出，
     * 那样就失去了「防御遍历栈溢出」这层防护的意义。
     *
     * 深度语义与 PC 一致：入参自身算第 0 层，只有**子节点**才 `depth + 1`，
     * 判定是 `current.depth > maxDepth`，所以 `maxDepth=64` 允许到第 65 层被拒。
     * 少一层多一层都会让同一份文件在两端一个能导入一个被拒。
     */
    fun assertImportJsonDepth(value: Any?, maxDepth: Int = MAX_JSON_DEPTH) {
        if (value !is Map<*, *> && value !is List<*>) return
        val stack = ArrayDeque<Pair<Any?, Int>>()
        stack.addLast(value to 0)
        while (stack.isNotEmpty()) {
            val (current, depth) = stack.removeLast()
            if (depth > maxDepth) {
                throw IllegalStateException("JSON 嵌套深度超过限制（$maxDepth 层），已拒绝导入")
            }
            val children: List<Any?> = when {
                current is List<*> -> current
                current is Map<*, *> -> current.values.toList()
                else -> continue
            }
            for (item in children) {
                if (item is Map<*, *> || item is List<*>) stack.addLast(item to depth + 1)
            }
        }
    }

    /**
     * 对导入产物执行方案 §6.5/§15 的上限检查：
     * 超限的保留区丢弃并显式报告，正文/条目数超限则以 rejected 拒绝整个导入。
     *
     * 与 PC 的**唯一**实现差异：TS 就地 mutate `document`，这里返回新对象。
     * 原因是 Kotlin 侧文档是不可变数据类；语义（哪些键被删、哪个命名空间被丢、
     * flags 被改成什么、超长正则关键词被丢哪几条）逐条保持一致。
     *
     * 检查顺序同样是契约：条目总数 → 书级 foreign → 逐条目（正文长度 → 条目 foreign
     * → flags 清洗 → 超长正则关键词），因为 `code` 与 `path` 会进报告，
     * 用户看到的第一条拒绝原因必须与 PC 一致。
     */
    fun enforceImportDocumentLimits(document: CanonicalLorebook): LimitsOutcome {
        val issues = mutableListOf<LorebookCompatibilityIssue>()
        fun add(
            severity: LorebookCompatibilitySeverity,
            action: LorebookCompatibilityAction,
            code: String,
            path: String,
            message: String,
        ) {
            issues += LorebookCompatibilityIssue.of(severity, action, code, path, message)
        }

        if (document.entries.size > MAX_ENTRIES) {
            add(
                LorebookCompatibilitySeverity.ERROR, LorebookCompatibilityAction.REJECTED, "too_many_entries",
                "$.entries",
                "条目数 ${document.entries.size} 超过上限 $MAX_ENTRIES，已拒绝导入",
            )
            return LimitsOutcome(document, issues)
        }

        var foreignBudget = MAX_FOREIGN_CHARS_PER_BOOK
        /**
         * 逐个命名空间做体积裁剪。
         *
         * 返回 null 覆盖三种情况，都与 PC 一致（TS 里是 `document.foreign = undefined`
         * 从而**删掉整个键**）：本来就没有 foreign、空对象、以及全部命名空间都被丢弃。
         * 保留区为空却把 `{}` 留在文档里会让实体哈希与 PC 不同。
         */
        fun applyForeignCap(foreign: Map<String, Any?>?, path: String): Map<String, Any?>? {
            if (foreign == null) return null
            val kept = LinkedHashMap<String, Any?>()
            foreign.forEach { (namespace, value) ->
                val size = LorebookJson.charsOf(value)
                if (size > MAX_FOREIGN_CHARS_PER_ENTRY) {
                    add(
                        LorebookCompatibilitySeverity.WARNING, LorebookCompatibilityAction.DROPPED,
                        "foreign_entry_too_large", "$path.$namespace",
                        "未知字段保留区「$namespace」（约 $size 字符）超过单条上限，已丢弃；正文与触发词不受影响",
                    )
                    return@forEach
                }
                if (size > foreignBudget) {
                    add(
                        LorebookCompatibilitySeverity.WARNING, LorebookCompatibilityAction.DROPPED,
                        "foreign_budget_exhausted", "$path.$namespace",
                        "全书未知字段保留区总量超过上限（$MAX_FOREIGN_CHARS_PER_BOOK 字符），已丢弃「$namespace」",
                    )
                    return@forEach
                }
                foreignBudget -= size
                kept[namespace] = value
            }
            return kept.takeIf { it.isNotEmpty() }
        }

        var nextDocument = document.copy(foreign = applyForeignCap(document.foreign, "$"))
        val nextEntries = document.entries.mapIndexed { index, entry ->
            val path = "$.entries[$index]"
            if (entry.content.length > MAX_ENTRY_CONTENT_CHARS) {
                add(
                    LorebookCompatibilitySeverity.ERROR, LorebookCompatibilityAction.REJECTED,
                    "entry_content_too_long", "$path.content",
                    "条目正文 ${entry.content.length} 字符超过单条上限 $MAX_ENTRY_CONTENT_CHARS，已拒绝导入",
                )
            }
            var nextEntry = entry.copy(foreign = applyForeignCap(entry.foreign, path))
            if (nextEntry.activation.regex.enabled) {
                val flags = nextEntry.activation.regex.flags.filter { REGEX_ALLOWED_FLAGS.contains(it) }
                if (flags != nextEntry.activation.regex.flags) {
                    add(
                        LorebookCompatibilitySeverity.WARNING, LorebookCompatibilityAction.APPROXIMATED,
                        "regex_flags_sanitized", "$path.activation.regex",
                        "正则 flags「${nextEntry.activation.regex.flags}」包含不支持或危险的标志，" +
                            "已调整为「${if (flags.isEmpty()) "（无）" else flags}」",
                    )
                    nextEntry = nextEntry.copy(
                        activation = nextEntry.activation.copy(
                            regex = nextEntry.activation.regex.copy(flags = flags),
                        ),
                    )
                }
                val dropLongPatterns: (List<String>, String) -> List<String> = { keys, keyPath ->
                    keys.filter { key ->
                        if (key.length <= MAX_REGEX_PATTERN_LENGTH) {
                            true
                        } else {
                            add(
                                LorebookCompatibilitySeverity.WARNING, LorebookCompatibilityAction.DROPPED,
                                "regex_pattern_too_long", keyPath,
                                "正则表达式长度 ${key.length} 超过上限 $MAX_REGEX_PATTERN_LENGTH，该关键词已被丢弃",
                            )
                            false
                        }
                    }
                }
                nextEntry = nextEntry.copy(
                    activation = nextEntry.activation.copy(
                        primaryKeys = dropLongPatterns(
                            nextEntry.activation.primaryKeys,
                            "$path.activation",
                        ),
                        secondaryKeys = dropLongPatterns(
                            nextEntry.activation.secondaryKeys,
                            "$path.activation",
                        ),
                    ),
                )
            }
            nextEntry
        }
        nextDocument = nextDocument.copy(entries = nextEntries)
        return LimitsOutcome(nextDocument, issues)
    }

    /** 裁剪后的文档 + 产生的 issues（PC 是「就地裁剪 + 返回 issues」）。 */
    data class LimitsOutcome(
        val document: CanonicalLorebook,
        val issues: List<LorebookCompatibilityIssue>,
    )
}
