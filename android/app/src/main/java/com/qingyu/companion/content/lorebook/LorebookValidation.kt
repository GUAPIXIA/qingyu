package com.qingyu.companion.content.lorebook

/**
 * 阶段 5 S5-02：canonical v2 文档校验
 * （`shared/lorebook/domain/validation.ts` 的逐条移植）。
 *
 * ## 为什么校验的是原始 Map 而不是模型
 * `CanonicalLorebook` 是**宽容**的（缺字段给默认值、未知键进 `extra`），
 * 用它做校验就等于「先把非法输入洗成合法再判合法」。
 * PC 侧 `validateCanonicalLorebookV2(value: unknown)` 收的就是未加工的解析结果，
 * 这里保持同一入口：所有判定读 `Map`/`List`，缺键按 JS 的 `undefined` 处理。
 *
 * ## issues 的顺序也是契约
 * PC 按字段声明顺序 push，前端直接把 `issues` 列表画出来；
 * 顺序变了虽然不影响 `valid`，但会让跨端 fixture 的逐条比对失败。
 * 所以下面的读取顺序与 TS 一一对应，不做「优化重排」。
 */
object LorebookValidation {

    /** `CanonicalValidationResult`：`valid` 为真时 [value] 是可用的原始文档。 */
    data class Result(
        val valid: Boolean,
        val value: Map<String, Any?>?,
        val issues: List<LorebookValidationIssue>,
    )

    private val PROMPT_ANCHORS = setOf(
        "before_character", "after_character", "before_examples", "after_examples",
        "authors_note_top", "authors_note_bottom", "prompt_end",
    )
    private val ROLES = setOf("system", "user", "assistant")
    private val SECONDARY_LOGIC = setOf("and_any", "and_all", "not_any", "not_all")
    private val GENERATION_TRIGGERS = setOf("normal", "continue", "impersonate", "swipe", "regenerate", "quiet")
    private val ACTIVATION_MODES = setOf("constant", "conditional")
    private val BUDGET_TIERS = setOf("protected", "standard", "supplemental")
    private val KEY_LOGICS = setOf("any", "all")
    private val RETRIEVAL_MODES = setOf("keyword", "semanticPreferred", "semanticRequired", "hybrid")

    /** `validateCanonicalLorebookV2`。 */
    fun validateCanonicalV2(input: Any?): Result {
        val issues = mutableListOf<LorebookValidationIssue>()
        fun add(path: String, message: String) { issues += LorebookValidationIssue(path, message) }

        val document = LorebookJson.record(input)
        if (document == null) {
            return Result(false, null, listOf(LorebookValidationIssue("$", "文档必须是对象")))
        }
        if (document["schema"] != CanonicalLorebook.SCHEMA) add("$.schema", "schema 不匹配")
        if (LorebookJson.number(document["schemaVersion"]) != CanonicalLorebook.SCHEMA_VERSION.toDouble()) {
            add("$.schemaVersion", "schemaVersion 不匹配")
        }
        if (LorebookJson.string(document["id"]) == null) add("$.id", "id 必须是字符串")
        val revision = LorebookJson.number(document["revision"])
        if (revision == null || !isInteger(revision) || revision < 1) add("$.revision", "revision 必须是正整数")
        if (LorebookJson.string(document["name"]) == null) add("$.name", "name 必须是字符串")
        if (LorebookJson.string(document["description"]) == null) add("$.description", "description 必须是字符串")
        if (LorebookJson.boolean(document["enabled"]) == null) add("$.enabled", "enabled 必须是布尔值")
        if (!finiteAtLeastZero(document["createdAt"])) add("$.createdAt", "createdAt 必须是非负时间戳")
        if (!finiteAtLeastZero(document["updatedAt"])) add("$.updatedAt", "updatedAt 必须是非负时间戳")

        if (LorebookJson.has(document, "source")) {
            val source = LorebookJson.record(document["source"])
            if (source == null) {
                add("$.source", "source 必须是对象")
            } else {
                if (LorebookJson.string(source["adapterId"]) == null) add("$.source.adapterId", "adapterId 必须是字符串")
                if (LorebookJson.has(source, "formatVersion") && LorebookJson.string(source["formatVersion"]) == null) {
                    add("$.source.formatVersion", "formatVersion 必须是字符串")
                }
                if (LorebookJson.has(source, "originalName") && LorebookJson.string(source["originalName"]) == null) {
                    add("$.source.originalName", "originalName 必须是字符串")
                }
                if (!finiteAtLeastZero(source["importedAt"])) add("$.source.importedAt", "importedAt 必须是非负时间戳")
                if (LorebookJson.string(source["contentHash"]) == null) add("$.source.contentHash", "contentHash 必须是字符串")
            }
        }
        validateForeign(document["foreign"], "$.foreign", issues)

        val defaults = LorebookJson.record(document["defaults"])
        if (defaults == null) {
            add("$.defaults", "defaults 必须是对象")
        } else {
            val scanDepth = LorebookJson.number(defaults["scanDepth"])
            if (scanDepth == null || scanDepth < 0) add("$.defaults.scanDepth", "scanDepth 必须是非负数")
            if (LorebookJson.boolean(defaults["recursiveScanning"]) == null) {
                add("$.defaults.recursiveScanning", "recursiveScanning 必须是布尔值")
            }
            if (LorebookJson.has(defaults, "tokenBudget") && !isNonNegativeInteger(defaults["tokenBudget"])) {
                add("$.defaults.tokenBudget", "tokenBudget 必须是非负整数")
            }
        }

        val entries = LorebookJson.list(document["entries"])
        if (entries == null) {
            add("$.entries", "entries 必须是数组")
        } else {
            entries.forEachIndexed { index, entry -> validateEntry(entry, index, issues) }
        }
        return if (issues.isEmpty()) Result(true, document, emptyList()) else Result(false, null, issues)
    }

    /** `isCanonicalLorebookV2`。 */
    fun isCanonicalV2(input: Any?): Boolean = validateCanonicalV2(input).valid

    /** 文本入口：非法 JSON 与「不是对象」都归成 `$ 文档必须是对象`。 */
    fun validateCanonicalJson(text: String): Result = validateCanonicalV2(LorebookJson.parse(text))

    // ------------------------------------------------------------------ 条目

    private fun validateEntry(input: Any?, index: Int, issues: MutableList<LorebookValidationIssue>) {
        val path = "$.entries[$index]"
        fun add(at: String, message: String) { issues += LorebookValidationIssue(at, message) }

        val entry = LorebookJson.record(input)
        if (entry == null) {
            add(path, "条目必须是对象")
            return
        }
        if (LorebookJson.string(entry["id"]) == null) add("$path.id", "id 必须是字符串")
        if (LorebookJson.has(entry, "sourceId")) {
            val sourceId = entry["sourceId"]
            if (sourceId !is String && LorebookJson.number(sourceId) == null) {
                add("$path.sourceId", "sourceId 必须是字符串或数字")
            }
        }
        if (LorebookJson.boolean(entry["enabled"]) == null) add("$path.enabled", "enabled 必须是布尔值")
        if (LorebookJson.string(entry["content"]) == null) add("$path.content", "content 必须是字符串")
        for (key in listOf("title", "summary", "translation")) {
            if (LorebookJson.has(entry, key) && LorebookJson.string(entry[key]) == null) {
                add("$path.$key", "$key 必须是字符串")
            }
        }
        validateForeign(entry["foreign"], "$path.foreign", issues)

        val activation = LorebookJson.record(entry["activation"])
        if (activation == null) {
            add("$path.activation", "activation 必须是对象")
        } else {
            if (!ACTIVATION_MODES.contains(LorebookJson.string(activation["mode"]))) {
                add("$path.activation.mode", "不支持的 activation mode")
            }
            if (!BUDGET_TIERS.contains(LorebookJson.string(activation["budgetTier"]))) {
                add("$path.activation.budgetTier", "不支持的 budget tier")
            }
            for (key in listOf("primaryKeys", "secondaryKeys", "aliases")) {
                if (LorebookJson.stringArray(activation[key]) == null) {
                    add("$path.activation.$key", "$key 必须是字符串数组")
                }
            }
            if (!KEY_LOGICS.contains(LorebookJson.string(activation["keyLogic"]))) {
                add("$path.activation.keyLogic", "不支持的 key logic")
            }
            if (LorebookJson.has(activation, "secondaryLogic") &&
                !SECONDARY_LOGIC.contains(LorebookJson.string(activation["secondaryLogic"]))
            ) {
                add("$path.activation.secondaryLogic", "不支持的 secondary logic")
            }
            if (LorebookJson.boolean(activation["caseSensitive"]) == null) {
                add("$path.activation.caseSensitive", "caseSensitive 必须是布尔值")
            }
            if (LorebookJson.boolean(activation["wholeWords"]) == null) {
                add("$path.activation.wholeWords", "wholeWords 必须是布尔值")
            }
            val regex = LorebookJson.record(activation["regex"])
            if (regex == null || LorebookJson.boolean(regex["enabled"]) == null ||
                LorebookJson.string(regex["flags"]) == null
            ) {
                add("$path.activation.regex", "regex 结构无效")
            }
            if (!RETRIEVAL_MODES.contains(LorebookJson.string(activation["retrieval"]))) {
                add("$path.activation.retrieval", "不支持的 retrieval mode")
            }
        }

        validateInsertion(entry["insertion"], path, ::add)

        val scheduling = LorebookJson.record(entry["scheduling"])
        if (scheduling == null) {
            add("$path.scheduling", "scheduling 必须是对象")
        } else {
            if (LorebookJson.number(scheduling["order"]) == null) {
                add("$path.scheduling.order", "order 必须是有限数字")
            }
            val probability = LorebookJson.number(scheduling["probability"])
            if (probability == null || probability < 0 || probability > 100) {
                add("$path.scheduling.probability", "probability 必须在 0-100")
            }
            if (LorebookJson.has(scheduling, "scanDepth") && !isNonNegativeInteger(scheduling["scanDepth"])) {
                add("$path.scheduling.scanDepth", "scanDepth 必须是非负整数")
            }
            val recursion = LorebookJson.record(scheduling["recursion"])
            if (recursion == null) {
                add("$path.scheduling.recursion", "recursion 结构无效")
            } else {
                if (LorebookJson.boolean(recursion["exclude"]) == null) {
                    add("$path.scheduling.recursion.exclude", "exclude 必须是布尔值")
                }
                if (LorebookJson.boolean(recursion["prevent"]) == null) {
                    add("$path.scheduling.recursion.prevent", "prevent 必须是布尔值")
                }
                if (!isNonNegativeInteger(recursion["minDepth"])) {
                    add("$path.scheduling.recursion.minDepth", "minDepth 必须是非负整数")
                }
            }
            val groups = LorebookJson.list(scheduling["groups"])
            if (groups == null) {
                add("$path.scheduling.groups", "groups 必须是数组")
            } else {
                groups.forEachIndexed { groupIndex, group ->
                    val groupPath = "$path.scheduling.groups[$groupIndex]"
                    val record = LorebookJson.record(group)
                    if (record == null) {
                        add(groupPath, "group 必须是对象")
                        return@forEachIndexed
                    }
                    if (LorebookJson.string(record["name"]) == null) add("$groupPath.name", "name 必须是字符串")
                    val weight = LorebookJson.number(record["weight"])
                    if (weight == null || weight < 0) add("$groupPath.weight", "weight 必须是非负数")
                    if (LorebookJson.boolean(record["prioritized"]) == null) {
                        add("$groupPath.prioritized", "prioritized 必须是布尔值")
                    }
                }
            }
            if (LorebookJson.boolean(scheduling["groupScoring"]) == null) {
                add("$path.scheduling.groupScoring", "groupScoring 必须是布尔值")
            }
            if (LorebookJson.boolean(scheduling["ignoreBudget"]) == null) {
                add("$path.scheduling.ignoreBudget", "ignoreBudget 必须是布尔值")
            }
            for (key in listOf("sticky", "cooldown", "delay")) {
                if (LorebookJson.has(scheduling, key) && !isNonNegativeInteger(scheduling[key])) {
                    add("$path.scheduling.$key", "$key 必须是非负整数")
                }
            }
            if (LorebookJson.has(scheduling, "characterFilter")) {
                val filterPath = "$path.scheduling.characterFilter"
                val filter = LorebookJson.record(scheduling["characterFilter"])
                if (filter == null) {
                    add(filterPath, "characterFilter 必须是对象")
                } else {
                    if (LorebookJson.boolean(filter["exclude"]) == null) add("$filterPath.exclude", "exclude 必须是布尔值")
                    if (LorebookJson.stringArray(filter["names"]) == null) add("$filterPath.names", "names 必须是字符串数组")
                    if (LorebookJson.stringArray(filter["tags"]) == null) add("$filterPath.tags", "tags 必须是字符串数组")
                }
            }
            val triggers = LorebookJson.list(scheduling["generationTriggers"])
            if (scheduling.containsKey("generationTriggers") &&
                (triggers == null || !triggers.all { GENERATION_TRIGGERS.contains(LorebookJson.string(it)) })
            ) {
                add("$path.scheduling.generationTriggers", "包含不支持的 generation trigger")
            }
        }
    }

    private fun validateInsertion(
        input: Any?,
        path: String,
        add: (String, String) -> Unit,
    ) {
        val insertion = LorebookJson.record(input)
        val kind = insertion?.let { LorebookJson.string(it["kind"]) }
        if (insertion == null || kind == null) {
            add("$path.insertion", "insertion 结构无效")
            return
        }
        when (kind) {
            "prompt" -> if (!PROMPT_ANCHORS.contains(LorebookJson.string(insertion["anchor"]))) {
                add("$path.insertion.anchor", "不支持的 prompt anchor")
            }
            "chat" -> {
                if (!isNonNegativeInteger(insertion["depth"])) add("$path.insertion.depth", "depth 必须是非负整数")
                if (LorebookJson.has(insertion, "role") && !ROLES.contains(LorebookJson.string(insertion["role"]))) {
                    add("$path.insertion.role", "不支持的 chat role")
                }
            }
            "outlet" -> if (LorebookJson.string(insertion["name"]) == null) {
                add("$path.insertion.name", "outlet name 必须是字符串")
            }
            "custom" -> {
                if (LorebookJson.string(insertion["source"]) == null) {
                    add("$path.insertion.source", "custom source 必须是字符串")
                }
                if (!LorebookJson.isJsonValue(insertion["value"])) {
                    add("$path.insertion.value", "custom value 必须是 JSON 值")
                }
            }
            else -> add("$path.insertion.kind", "不支持的 insertion kind")
        }
    }

    private fun validateForeign(
        value: Any?,
        path: String,
        issues: MutableList<LorebookValidationIssue>,
    ) {
        if (value == null) return
        if (LorebookJson.record(value) == null || !LorebookJson.isJsonValue(value)) {
            issues += LorebookValidationIssue(path, "foreign 必须是 JSON 对象")
        }
    }

    // ------------------------------------------------------------------ 数字判定

    /** `Number.isInteger` 的等价判定（入参必须已有限）。 */
    private fun isInteger(value: Double): Boolean = value == Math.floor(value)

    private fun finiteAtLeastZero(value: Any?): Boolean {
        val number = LorebookJson.number(value) ?: return false
        return number >= 0
    }

    /** `finiteNumber(value, 0) && Number.isInteger(value)`。 */
    private fun isNonNegativeInteger(value: Any?): Boolean {
        val number = LorebookJson.number(value) ?: return false
        return number >= 0 && isInteger(number)
    }
}
