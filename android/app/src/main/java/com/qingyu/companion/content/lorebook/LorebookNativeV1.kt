package com.qingyu.companion.content.lorebook

import com.qingyu.companion.chatcore.Ulid

/**
 * 阶段 5 S5-02：轻语原生世界书 v1（native v1）的模型、归一化、校验与回编译。
 *
 * 移植自三处 PC 实现，它们共同构成外部格式导入的「中间层」：
 * - `electron/services/lorebookImport.ts` —— `unwrapLorebookPayload` + `normalizeImportedLorebook`
 * - `shared/lorebook/nativeV1.ts` —— `validateNativeLorebookV1`
 * - `shared/lorebook/runtime/compile.ts` —— `compileCanonicalLorebookV2`（导出 native v1 时用）
 *
 * ## 为什么这一层用 `Map<String, Any?>` 而不是数据类
 * TS 里 `Lorebook` / `LoreEntry` 就是普通对象，而且**同一层要服务两类互不相同的调用方**：
 * 1. 原生 v1 适配器：手里是用户原始文件，`migrateNativeLorebookV1ToV2` 要用
 *    `collectForeign(entry, ENTRY_KEYS, …)` 逐键找出「已知字段之外」的东西；
 * 2. 外部格式适配器：手里是归一化器的产物，键集是固定下发的。
 * 换成数据类就得给每个可选字段造一个「不存在 / 值为 null」的区分，
 * 而 TS 靠的正是 `undefined` 与 `null` 的自然差别；
 * 一旦这个区分错位，`foreign` 里就会多出本该没有的键，跨端哈希立刻分叉。
 * 所以这里保持 Map，键缺失 == JS `undefined`，值 `null` == JS `null`。
 *
 * ## 输出键序
 * 与 TS 对象字面量一致。哈希比较走 canonical 排序，但用户手工 diff 与
 * fixture 逐字比对都依赖键序，不要「顺手」整理。
 */
object LorebookNativeV1 {

    /** 与 `electron/services/lorebookImport.ts` 的 `LoreSourceKind` 一致。 */
    enum class SourceKind(val jsonValue: String) {
        NATIVE("native"),
        SILLY_TAVERN("sillytavern"),
        CHARACTER_BOOK("character_book"),
    }

    /** `NativeV1ValidationIssue.code`。 */
    enum class ValidationCode(val jsonValue: String) {
        REQUIRED("required"),
        TYPE("type"),
        ENUM("enum"),
        RANGE("range"),
    }

    /** `NativeV1ValidationIssue`。 */
    data class Issue(val path: String, val code: ValidationCode, val message: String)

    /** `NativeV1ValidationResult`：`value` 是**原始**输入对象（PC 也直接把它交给迁移器）。 */
    data class ValidationResult(
        val valid: Boolean,
        val value: Map<String, Any?>?,
        val issues: List<Issue>,
    )

    /** `NormalizeLorebookOptions`。 */
    data class NormalizeOptions(
        /** 调用方完成 safeId 校验后传入；内嵌世界书通常直接传新生成的 id。 */
        val id: String? = null,
        val fallbackName: String,
        /**
         * 来源格式。阶段 7 起为必填：格式识别是 adapter 的职责（多证据打分、可解释），
         * 统一导入器不再按单条字段猜测来源。
         */
        val sourceKind: SourceKind,
    )

    // -------------------------------------------------------------- 归一化（导入方向）

    /** `unwrapLorebookPayload`：lorebook_v3 使用 `{spec, data}` 包装；其他格式直接以顶层对象为书体。 */
    fun unwrapPayload(raw: Any?): Map<String, Any?> {
        val record = LorebookJson.record(raw) ?: return emptyMap()
        val data = LorebookJson.record(record["data"])
        if (record["spec"] == "lorebook_v3" && data != null) return data
        return record
    }

    /**
     * `normalizeImportedLorebook`：将轻语原生、SillyTavern、CCv2/CCv3 character_book
     * 与 lorebook_v3 统一归一化为运行时 Lorebook。
     *
     * 独立导入和角色卡内嵌导入必须共同调用此函数（方案 S5-01 的内嵌世界书提取也走这里），
     * 否则同一份 `character_book` 会在两条路径上得到不同结果。
     *
     * @param newId 缺 id 时的生成器；默认 ULID。测试注入固定值以获得确定性产物
     *              （PC 用 `nanoid()`，本来就是随机的，所以两端只要求「非空且唯一」）。
     */
    fun normalize(raw: Any?, options: NormalizeOptions, newId: () -> String = Ulid::newId): Map<String, Any?> {
        val payload = unwrapPayload(raw)
        val scanDepthValue = firstFinite(payload["scanDepth"], payload["scan_depth"]) ?: 4.0
        val importedTokenBudget = firstFinite(payload["tokenBudget"], payload["token_budget"])
        val enabled = LorebookJson.boolean(payload["enabled"])
            ?: (payload["disable"] != true)

        val out = LinkedHashMap<String, Any?>()
        out["id"] = options.id
            ?: (LorebookJson.string(payload["id"])?.takeIf { it.trim().isNotEmpty() } ?: newId())
        out["name"] = LorebookJson.string(payload["name"])?.takeIf { it.trim().isNotEmpty() } ?: options.fallbackName
        out["description"] = LorebookJson.string(payload["description"]) ?: ""
        out["entries"] = entriesOf(payload["entries"]).mapIndexed { index, entry ->
            normalizeEntry(entry, index.toDouble(), options.sourceKind, newId)
        }
        out["enabled"] = enabled
        // 保留 0；它在 ST/CC 规范中有明确含义，不能在导入边界静默改成 1。
        out["scanDepth"] = maxOf(0.0, floorOf(scanDepthValue))
        when {
            LorebookJson.boolean(payload["recursiveScanning"]) != null ->
                out["recursiveScanning"] = payload["recursiveScanning"]
            LorebookJson.boolean(payload["recursive_scanning"]) != null ->
                out["recursiveScanning"] = payload["recursive_scanning"]
            else -> Unit
        }
        if (importedTokenBudget != null && floorOf(importedTokenBudget) > 0) {
            out["tokenBudget"] = floorOf(importedTokenBudget)
        }
        return out
    }

    /** `entriesFrom`：数组取成员、对象取值（保持键序），非对象成员丢弃。 */
    private fun entriesOf(raw: Any?): List<Map<String, Any?>> = when {
        LorebookJson.list(raw) != null -> LorebookJson.list(raw)!!.mapNotNull { LorebookJson.record(it) }
        LorebookJson.record(raw) != null -> LorebookJson.record(raw)!!.values.mapNotNull { LorebookJson.record(it) }
        else -> emptyList()
    }

    /** `normalizeEntry`。返回的 Map 的键集合与 TS 对象字面量逐项对应。 */
    private fun normalizeEntry(
        raw: Map<String, Any?>,
        index: Double,
        source: SourceKind,
        newId: () -> String,
    ): Map<String, Any?> {
        val extensions = LorebookJson.record(raw["extensions"]) ?: emptyMap()
        // fields = { ...extensions, ...raw }：raw 覆盖同名 extension 键。
        val fields = LinkedHashMap<String, Any?>(extensions)
        fields.putAll(raw)
        // extended(camel, snake)：raw[camel] ?? raw[snake] ?? extensions[camel] ?? extensions[snake]
        fun extended(camel: String, snake: String = camel): Any? =
            raw[camel] ?: raw[snake] ?: extensions[camel] ?: extensions[snake]

        val keywords = stringList(raw["keywords"] ?: raw["keys"] ?: raw["key"])
        val secondaryKeywords =
            stringList(raw["secondaryKeywords"] ?: raw["secondary_keys"] ?: raw["keysecondary"])
        val selectiveLogic = selectiveLogicOf(fields, secondaryKeywords)

        val rawId = raw["id"] ?: raw["uid"]
        val id = (rawId as? String ?: (rawId as? Number)?.let { numberText(LorebookJson.number(rawId)) })
            ?.takeIf { it.trim().isNotEmpty() } ?: newId()

        val order = firstFinite(raw["order"], raw["insertion_order"]) ?: index
        val probabilityValue = if (extended("useProbability", "use_probability") == false) {
            100.0
        } else {
            firstFinite(extended("probability")) ?: 100.0
        }
        val probability = minOf(100.0, maxOf(0.0, probabilityValue))
        val enabled = LorebookJson.boolean(raw["enabled"]) ?: (raw["disable"] != true)

        val priorityValue = extended("priority")
        val explicitPriority = (priorityValue as? String)?.takeIf {
            it == "always" || it == "conditional" || it == "detail"
        }
        val priority = explicitPriority ?: (extended("constant") as? Boolean)
            ?.takeIf { it }
            ?.let { "always" }

        val matchModeValue = extended("matchMode", "match_mode")
        val explicitMatchMode = (matchModeValue as? String)?.takeIf {
            it == "keyword" || it == "semantic" || it == "both"
        }
        var matchMode = explicitMatchMode
        if (matchMode == null && source != SourceKind.NATIVE) {
            // ST 的 vectorized 是额外触发通道：有 key 时保留关键词+语义，无 key 时为纯语义。
            // 标准 character_book 没有语义匹配字段，按规范只走关键词。
            matchMode = if (extended("vectorized") == true) {
                if (keywords.isNotEmpty()) "both" else "semantic"
            } else {
                "keyword"
            }
        }

        val useRegex = LorebookJson.boolean(extended("useRegex", "use_regex"))
        val entryScanDepth = firstFinite(extended("scanDepth", "scan_depth"))
        val rawDelayUntilRecursion = extended("delayUntilRecursion", "delay_until_recursion")
        val delayUntilRecursion =
            if (rawDelayUntilRecursion == true) 1.0 else firstFinite(rawDelayUntilRecursion)
        val inclusionGroups = plainStringList(extended("group"))
        val characterFilter = characterFilterOf(extended("characterFilter", "character_filter"))
        val generationTriggers = generationTriggersOf(extended("triggers"))
        val sticky = firstFinite(extended("sticky"))
        val cooldown = firstFinite(extended("cooldown"))
        val delay = firstFinite(extended("delay"))

        // ST position=4（at_depth）的 depth 缺省是 4；其他位置 depth 无意义保持 0。
        // 需先算 position 再校正 depth 默认值。
        val position = normalizePosition(
            if (source == SourceKind.CHARACTER_BOOK) (extensions["position"] ?: raw["position"])
            else extended("position"),
        )
        val explicitDepth = firstFinite(extended("depth"))
        val hasExplicitDepth = explicitDepth != null
        val depth = if (hasExplicitDepth) {
            maxOf(0.0, floorOf(explicitDepth))
        } else {
            if (position == "at_depth" && source != SourceKind.NATIVE) 4.0 else 0.0
        }
        // ST at_depth 条目的 role：注入消息角色（仅 at_depth 有意义，其他位置忽略）
        val role = if (position == "at_depth") depthRoleOf(extended("role")) else null

        val out = LinkedHashMap<String, Any?>()
        out["id"] = id
        out["keywords"] = keywords
        out["content"] = LorebookJson.string(raw["content"]) ?: ""
        out["position"] = position
        out["depth"] = depth
        role?.let { out["role"] = it }
        out["order"] = order
        out["probability"] = probability
        out["enabled"] = enabled
        useRegex?.let { out["useRegex"] = it }
        (extended("regexFlags", "regex_flags") as? String)?.let { out["regexFlags"] = it }
        if (secondaryKeywords.isNotEmpty()) out["secondaryKeywords"] = secondaryKeywords
        selectiveLogic?.let { out["selectiveLogic"] = it }
        (extended("caseSensitive", "case_sensitive") as? Boolean)?.let { out["caseSensitive"] = it }
        (extended("matchWholeWords", "match_whole_words") as? Boolean)?.let { out["matchWholeWords"] = it }
        if (extended("excludeRecursion", "exclude_recursion") == true) out["excludeRecursion"] = true
        if (extended("preventRecursion", "prevent_recursion") == true) out["preventRecursion"] = true
        entryScanDepth?.let { out["scanDepth"] = maxOf(0.0, floorOf(it)) }
        delayUntilRecursion?.let { out["delayUntilRecursion"] = maxOf(1.0, floorOf(it)) }
        if (inclusionGroups.isNotEmpty()) out["inclusionGroups"] = inclusionGroups
        if (extended("groupOverride", "group_override") == true) out["inclusionGroupPrioritized"] = true
        firstFinite(extended("groupWeight", "group_weight"))?.let {
            out["inclusionGroupWeight"] = maxOf(0.0, it)
        }
        if (extended("useGroupScoring", "use_group_scoring") == true) out["useGroupScoring"] = true
        characterFilter?.let { out["characterFilter"] = it }
        generationTriggers?.let { out["generationTriggers"] = it }
        if (sticky != null && sticky > 0) out["sticky"] = floorOf(sticky)
        if (cooldown != null && cooldown > 0) out["cooldown"] = floorOf(cooldown)
        if (delay != null && delay > 0) out["delay"] = floorOf(delay)
        if (extended("ignoreBudget", "ignore_budget") == true) out["ignoreBudget"] = true
        matchMode?.let { out["matchMode"] = it }
        priority?.let { out["priority"] = it }
        (raw["summary"] as? String)?.let { out["summary"] = it }
        (raw["translation"] as? String)?.let { out["translation"] = it }
        return out
    }

    /**
     * ST 的正则 key 可能包含逗号；完整的 `/pattern/flags` 必须作为单个 key 保留。
     * 其余情况按 `,`/`，`/换行 拆分。
     */
    private fun stringList(value: Any?): List<String> {
        LorebookJson.list(value)?.let { items ->
            return items.filterIsInstance<String>().map { it.trim() }.filter { it.isNotEmpty() }
        }
        val text = value as? String ?: return emptyList()
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return emptyList()
        if (REGEX_LITERAL.matches(trimmed)) return listOf(trimmed)
        return trimmed.split(KEY_SEPARATOR).map { it.trim() }.filter { it.isNotEmpty() }
    }

    /** 不认正则字面量：数组成员也要再拆一次（ST `group` 常写成 `"a, b"` 数组）。 */
    private fun plainStringList(value: Any?): List<String> {
        LorebookJson.list(value)?.let { items ->
            return items.filterIsInstance<String>()
                .flatMap { it.split(KEY_SEPARATOR) }
                .map { it.trim() }
                .filter { it.isNotEmpty() }
        }
        val text = value as? String ?: return emptyList()
        return text.split(KEY_SEPARATOR).map { it.trim() }.filter { it.isNotEmpty() }
    }

    private fun selectiveLogicOf(
        fields: Map<String, Any?>,
        secondaryKeywords: List<String>,
    ): String? {
        if (secondaryKeywords.isEmpty() || fields["selective"] == false) return null
        val value = fields["selectiveLogic"] ?: fields["selective_logic"]
        val numeric = LorebookJson.number(value)
        (value as? String)?.let { text ->
            when (text) {
                "and_any", "AND ANY" -> return "and_any"
                "not_all", "NOT ALL" -> return "not_all"
                "not_any", "NOT ANY" -> return "not_any"
                "and_all", "AND ALL" -> return "and_all"
            }
        }
        when (numeric) {
            0.0 -> return "and_any"
            1.0 -> return "not_all"
            2.0 -> return "not_any"
            3.0 -> return "and_all"
        }
        return if (fields["selective"] == true) "and_any" else null
    }

    private fun characterFilterOf(value: Any?): Map<String, Any?>? {
        val record = LorebookJson.record(value) ?: return null
        val names = plainStringList(record["names"])
        val tags = plainStringList(record["tags"])
        if (names.isEmpty() && tags.isEmpty() && record["isExclude"] != true && record["exclude"] != true) {
            return null
        }
        return linkedMapOf(
            "exclude" to (record["exclude"] == true || record["isExclude"] == true),
            "names" to names,
            "tags" to tags,
        )
    }

    private fun generationTriggersOf(value: Any?): List<String>? {
        val triggers = plainStringList(value)
            .map { it.lowercase() }
            .filter { GENERATION_TRIGGERS.contains(it) }
        if (triggers.isEmpty()) return null
        return triggers.distinct()
    }

    /** `normalizePosition`。 */
    private fun normalizePosition(value: Any?): String = when {
        value == "before_char" || value == "before" || value == 0 || LorebookJson.number(value) == 0.0 -> "before_char"
        value == "after_char" || value == "after" || value == 1 || LorebookJson.number(value) == 1.0 -> "after_char"
        // 当前 ST：4 = in-chat at depth。旧字符串别名继续兼容。
        value == "at_depth" || value == "depth" || LorebookJson.number(value) == 4.0 -> "at_depth"
        value == "at_end" -> "at_end"
        // ST 的 AN / example-message / outlet 位置在轻语暂无等价位置，统一降级到 system 尾部，
        // 避免像旧映射那样把 position=2 错当成 chat depth。
        else -> "at_end"
    }

    /** ST/CC at_depth role：原始 ST JSON 使用 0/1/2，轻语原生格式使用字符串。 */
    private fun depthRoleOf(value: Any?): String? = when {
        value == "system" || LorebookJson.number(value) == 0.0 -> "system"
        value == "user" || LorebookJson.number(value) == 1.0 -> "user"
        value == "assistant" || LorebookJson.number(value) == 2.0 -> "assistant"
        else -> null
    }

    // ------------------------------------------------------------ native v1 校验

    /** `validateNativeLorebookV1`：未知字段允许存在，以冻结已知字段而不阻断前向扩展。 */
    fun validate(input: Any?): ValidationResult {
        val issues = mutableListOf<Issue>()
        fun add(path: String, code: ValidationCode, message: String) {
            issues += Issue(path, code, message)
        }

        val book = LorebookJson.record(input)
        if (book == null) {
            return ValidationResult(false, null, listOf(Issue("$", ValidationCode.TYPE, "世界书顶层必须是对象")))
        }

        stringField(book, "id", "$", issues, true)
        stringField(book, "name", "$", issues, true)
        stringField(book, "description", "$", issues, true)
        booleanField(book, "enabled", "$", issues, true)
        numberField(book, "scanDepth", "$", issues, NumberFieldOptions(required = true, integer = true, min = 0.0))
        booleanField(book, "recursiveScanning", "$", issues)
        numberField(book, "tokenBudget", "$", issues, NumberFieldOptions(integer = true, min = 0.0))

        if (!requiredField(book, "entries", "$", issues)) return ValidationResult(false, null, issues)
        val entries = LorebookJson.list(book["entries"])
        if (entries == null) {
            add("$.entries", ValidationCode.TYPE, "entries 必须是数组")
        } else {
            entries.forEachIndexed { index, entry -> validateEntry(entry, index, issues) }
        }
        return if (issues.isEmpty()) {
            ValidationResult(true, book, emptyList())
        } else {
            ValidationResult(false, null, issues)
        }
    }

    private data class NumberFieldOptions(
        val required: Boolean = false,
        val integer: Boolean = false,
        val min: Double? = null,
        val max: Double? = null,
    )

    /**
     * `record[key] !== undefined`。
     *
     * 只判 `containsKey`，**不**把显式 `null` 当作缺失：TS 里 `null` 是「有值」，
     * 会继续走类型检查并产出 `type` issue；若在这里当成缺失，报出来的就是
     * `required` + 「缺少必填字段」，同一份坏文件两端给出的原因不同。
     */
    private fun requiredField(
        record: Map<String, Any?>,
        key: String,
        path: String,
        issues: MutableList<Issue>,
    ): Boolean {
        if (record.containsKey(key)) return true
        issues += Issue("$path.$key", ValidationCode.REQUIRED, "缺少必填字段 $key")
        return false
    }

    private fun stringField(
        record: Map<String, Any?>,
        key: String,
        path: String,
        issues: MutableList<Issue>,
        required: Boolean = false,
    ) {
        if (!required && !record.containsKey(key)) return
        if (required && !requiredField(record, key, path, issues)) return
        if (record[key] !is String) {
            issues += Issue("$path.$key", ValidationCode.TYPE, "$key 必须是字符串")
        }
    }

    private fun booleanField(
        record: Map<String, Any?>,
        key: String,
        path: String,
        issues: MutableList<Issue>,
        required: Boolean = false,
    ) {
        if (!required && !record.containsKey(key)) return
        if (required && !requiredField(record, key, path, issues)) return
        if (record[key] !is Boolean) {
            issues += Issue("$path.$key", ValidationCode.TYPE, "$key 必须是布尔值")
        }
    }

    private fun numberField(
        record: Map<String, Any?>,
        key: String,
        path: String,
        issues: MutableList<Issue>,
        options: NumberFieldOptions = NumberFieldOptions(),
    ) {
        if (!options.required && !record.containsKey(key)) return
        if (options.required && !requiredField(record, key, path, issues)) return
        val value = record[key]
        val number = LorebookJson.number(value)
        if (value !is Number || number == null) {
            issues += Issue("$path.$key", ValidationCode.TYPE, "$key 必须是有限数字")
            return
        }
        if (options.integer && !isIntegerValue(number)) {
            issues += Issue("$path.$key", ValidationCode.TYPE, "$key 必须是整数")
        }
        options.min?.let {
            if (number < it) issues += Issue("$path.$key", ValidationCode.RANGE, "$key 不能小于 $it")
        }
        options.max?.let {
            if (number > it) issues += Issue("$path.$key", ValidationCode.RANGE, "$key 不能大于 $it")
        }
    }

    private fun stringArrayField(
        record: Map<String, Any?>,
        key: String,
        path: String,
        issues: MutableList<Issue>,
        required: Boolean = false,
    ) {
        if (!required && !record.containsKey(key)) return
        if (required && !requiredField(record, key, path, issues)) return
        val items = LorebookJson.list(record[key])
        if (items == null) {
            issues += Issue("$path.$key", ValidationCode.TYPE, "$key 必须是字符串数组")
            return
        }
        items.forEachIndexed { index, item ->
            if (item !is String) {
                issues += Issue("$path.$key[$index]", ValidationCode.TYPE, "数组成员必须是字符串")
            }
        }
    }

    private fun enumField(
        record: Map<String, Any?>,
        key: String,
        path: String,
        issues: MutableList<Issue>,
        allowed: Set<String>,
    ) {
        if (!record.containsKey(key)) return
        val value = record[key]
        if (value !is String || !allowed.contains(value)) {
            issues += Issue("$path.$key", ValidationCode.ENUM, "$key 不是受支持的枚举值")
        }
    }

    @Suppress("LongMethod")
    private fun validateEntry(input: Any?, index: Int, issues: MutableList<Issue>) {
        val path = "$.entries[$index]"
        fun add(code: ValidationCode, message: String, at: String = path) {
            issues += Issue(at, code, message)
        }

        val entry = LorebookJson.record(input)
        if (entry == null) {
            add(ValidationCode.TYPE, "世界书条目必须是对象")
            return
        }

        stringField(entry, "id", path, issues, true)
        stringArrayField(entry, "keywords", path, issues, true)
        stringField(entry, "content", path, issues, true)
        if (requiredField(entry, "position", path, issues)) {
            enumField(entry, "position", path, issues, POSITIONS)
        }
        numberField(entry, "depth", path, issues, NumberFieldOptions(integer = true, min = 0.0))
        enumField(entry, "role", path, issues, ROLES)
        numberField(entry, "order", path, issues, NumberFieldOptions(required = true))
        numberField(
            entry, "probability", path, issues,
            NumberFieldOptions(required = true, min = 0.0, max = 100.0),
        )
        booleanField(entry, "enabled", path, issues, true)
        booleanField(entry, "useRegex", path, issues)
        stringField(entry, "regexFlags", path, issues)
        stringArrayField(entry, "secondaryKeywords", path, issues)
        enumField(entry, "selectiveLogic", path, issues, SELECTIVE_LOGIC)
        booleanField(entry, "caseSensitive", path, issues)
        booleanField(entry, "matchWholeWords", path, issues)
        booleanField(entry, "excludeRecursion", path, issues)
        booleanField(entry, "preventRecursion", path, issues)
        numberField(entry, "scanDepth", path, issues, NumberFieldOptions(integer = true, min = 0.0))

        if (entry.containsKey("delayUntilRecursion")) {
            val value = entry["delayUntilRecursion"]
            if (value !is Boolean) {
                val number = LorebookJson.number(value)
                if (value !is Number || number == null || !isIntegerValue(number) || number < 1) {
                    add(ValidationCode.TYPE, "delayUntilRecursion 必须是布尔值或大于等于 1 的整数", "$path.delayUntilRecursion")
                }
            }
        }

        stringArrayField(entry, "inclusionGroups", path, issues)
        booleanField(entry, "inclusionGroupPrioritized", path, issues)
        numberField(entry, "inclusionGroupWeight", path, issues, NumberFieldOptions(min = 0.0))
        booleanField(entry, "useGroupScoring", path, issues)

        if (entry.containsKey("characterFilter")) {
            val filterPath = "$path.characterFilter"
            val filter = LorebookJson.record(entry["characterFilter"])
            if (filter == null) {
                add(ValidationCode.TYPE, "characterFilter 必须是对象", filterPath)
            } else {
                booleanField(filter, "exclude", filterPath, issues, true)
                stringArrayField(filter, "names", filterPath, issues, true)
                stringArrayField(filter, "tags", filterPath, issues, true)
            }
        }

        if (entry.containsKey("generationTriggers")) {
            val triggers = LorebookJson.list(entry["generationTriggers"])
            if (triggers == null) {
                add(ValidationCode.TYPE, "generationTriggers 必须是数组", "$path.generationTriggers")
            } else {
                triggers.forEachIndexed { triggerIndex, trigger ->
                    if (trigger !is String || !GENERATION_TRIGGERS.contains(trigger)) {
                        add(
                            ValidationCode.ENUM, "不支持的生成触发类型",
                            "$path.generationTriggers[$triggerIndex]",
                        )
                    }
                }
            }
        }

        numberField(entry, "sticky", path, issues, NumberFieldOptions(integer = true, min = 0.0))
        numberField(entry, "cooldown", path, issues, NumberFieldOptions(integer = true, min = 0.0))
        numberField(entry, "delay", path, issues, NumberFieldOptions(integer = true, min = 0.0))
        booleanField(entry, "ignoreBudget", path, issues)
        enumField(entry, "matchMode", path, issues, MATCH_MODES)
        stringField(entry, "translation", path, issues)
        enumField(entry, "priority", path, issues, PRIORITIES)
        stringField(entry, "summary", path, issues)
    }

    // ---------------------------------------------------------- canonical → native（导出方向）

    /**
     * `compileCanonicalLorebookV2`：canonical v2 → 当前 UI/触发器使用的兼容 Lorebook 视图。
     *
     * 原生 v1 导出必须经过它，因为 PC 的 `nativeV1Adapter.export` 就是
     * 「先回编译成 Lorebook，再把 `foreign['qingyu.native-v1']` 合并回去」。
     * 少一步回编译，导出的就是 canonical 而不是 native v1，PC 端读不回来。
     */
    fun compileCanonical(document: CanonicalLorebook): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out["id"] = document.id
        out["name"] = document.name
        out["description"] = document.description
        out["enabled"] = document.enabled
        out["scanDepth"] = document.defaults.scanDepth
        out["recursiveScanning"] = document.defaults.recursiveScanning
        document.defaults.tokenBudget?.let { out["tokenBudget"] = it }
        out["entries"] = document.entries.map { entry ->
            val compiled = LinkedHashMap<String, Any?>(compileEntry(entry))
            val runtime = LinkedHashMap<String, Any?>()
            runtime["insertion"] = entry.insertion.toJsonMap()
            runtime["retrieval"] = entry.activation.retrieval
            document.source?.adapterId?.takeIf { it.isNotEmpty() }?.let { runtime["adapterId"] = it }
            entry.title?.takeIf { it.isNotEmpty() }?.let { runtime["title"] = it }
            compiled["runtime"] = runtime
            compiled
        }
        val bookRuntime = LinkedHashMap<String, Any?>()
        bookRuntime["schemaVersion"] = document.schemaVersion
        bookRuntime["revision"] = document.revision
        document.source?.adapterId?.takeIf { it.isNotEmpty() }?.let { bookRuntime["adapterId"] = it }
        document.source?.formatVersion?.takeIf { it.isNotEmpty() }?.let { bookRuntime["formatVersion"] = it }
        out["runtime"] = bookRuntime
        return out
    }

    private fun compileEntry(entry: CanonicalLoreEntry): Map<String, Any?> {
        val firstGroup = entry.scheduling.groups.firstOrNull()
        val keywordProvenance = compileKeywordProvenance(entry)
        val matchMode = when (entry.activation.retrieval) {
            "keyword" -> "keyword"
            "hybrid" -> "both"
            else -> "semantic"
        }
        val priority = when {
            entry.activation.mode == "constant" -> "always"
            entry.activation.budgetTier == "supplemental" -> "detail"
            else -> "conditional"
        }

        val out = LinkedHashMap<String, Any?>()
        out["id"] = entry.id
        out["keywords"] = entry.activation.primaryKeys + entry.activation.aliases
        out["content"] = entry.content
        out.putAll(compileInsertion(entry.insertion))
        out["order"] = entry.scheduling.order
        out["probability"] = entry.scheduling.probability
        out["enabled"] = entry.enabled
        out["useRegex"] = entry.activation.regex.enabled
        out["regexFlags"] = entry.activation.regex.flags
        if (entry.activation.secondaryKeys.isNotEmpty()) {
            out["secondaryKeywords"] = entry.activation.secondaryKeys.toList()
        }
        entry.activation.secondaryLogic?.let { out["selectiveLogic"] = it }
        out["caseSensitive"] = entry.activation.caseSensitive
        out["matchWholeWords"] = entry.activation.wholeWords
        out["excludeRecursion"] = entry.scheduling.recursion.exclude
        out["preventRecursion"] = entry.scheduling.recursion.prevent
        entry.scheduling.scanDepth?.let { out["scanDepth"] = it }
        if (entry.scheduling.recursion.minDepth > 0) out["delayUntilRecursion"] = entry.scheduling.recursion.minDepth
        if (entry.scheduling.groups.isNotEmpty()) {
            out["inclusionGroups"] = entry.scheduling.groups.map { it.name }
        }
        if (firstGroup != null && firstGroup.prioritized) out["inclusionGroupPrioritized"] = true
        firstGroup?.let { out["inclusionGroupWeight"] = it.weight }
        out["useGroupScoring"] = entry.scheduling.groupScoring
        entry.scheduling.characterFilter?.let { filter ->
            out["characterFilter"] = linkedMapOf(
                "exclude" to filter.exclude,
                "names" to filter.names.toList(),
                "tags" to filter.tags.toList(),
            )
        }
        entry.scheduling.generationTriggers?.let { out["generationTriggers"] = it.toList() }
        entry.scheduling.sticky?.let { out["sticky"] = it }
        entry.scheduling.cooldown?.let { out["cooldown"] = it }
        entry.scheduling.delay?.let { out["delay"] = it }
        out["ignoreBudget"] = entry.scheduling.ignoreBudget
        out["matchMode"] = matchMode
        out["priority"] = priority
        entry.summary?.let { out["summary"] = it }
        entry.translation?.let { out["translation"] = it }
        keywordProvenance?.let { out["keywordProvenance"] = it }
        return out
    }

    private fun compileInsertion(insertion: LorebookInsertion): Map<String, Any?> = when {
        insertion.kind == "chat" -> {
            val out = LinkedHashMap<String, Any?>()
            out["position"] = "at_depth"
            out["depth"] = maxOf(0.0, floorOf(insertion.depth ?: 0.0))
            insertion.role?.let { out["role"] = it }
            out
        }
        insertion.kind == "prompt" && insertion.anchor == "before_character" -> linkedMapOf("position" to "before_char")
        insertion.kind == "prompt" && insertion.anchor == "after_character" -> linkedMapOf("position" to "after_char")
        else -> linkedMapOf<String, Any?>("position" to "at_end")
    }

    /**
     * 从 native-v1 foreign 命名空间还原 AI 扩词来源记录（阶段4 enrichment 管线）。
     * 只信任结构合法的条目，其余静默丢弃——provenance 是追溯注记，损坏不致命。
     */
    private fun compileKeywordProvenance(entry: CanonicalLoreEntry): Map<String, Any?>? {
        val foreign = LorebookJson.record(entry.foreign?.get(NATIVE_FOREIGN_NAMESPACE)) ?: return null
        val raw = LorebookJson.record(foreign["keywordProvenance"]) ?: return null
        val result = LinkedHashMap<String, Any?>()
        raw.forEach { (keyword, meta) ->
            if (LorebookJson.DANGEROUS_KEYS.contains(keyword)) return@forEach
            if (keyword.isEmpty()) return@forEach
            val record = LorebookJson.record(meta) ?: return@forEach
            val provider = LorebookJson.string(record["provider"]) ?: return@forEach
            val model = LorebookJson.string(record["model"]) ?: return@forEach
            val generatedAt = LorebookJson.number(record["generatedAt"]) ?: return@forEach
            result[keyword] = linkedMapOf(
                "provider" to provider,
                "model" to model,
                "generatedAt" to generatedAt,
                "mode" to if (record["mode"] == "enrich") "enrich" else "localize",
            )
        }
        return result.takeIf { it.isNotEmpty() }
    }

    // ------------------------------------------------------------------ 小工具

    /** `finiteNumber(...values)`：返回第一个有限数字。 */
    private fun firstFinite(vararg values: Any?): Double? {
        for (value in values) {
            val number = LorebookJson.number(value) ?: continue
            return number
        }
        return null
    }

    private fun isIntegerValue(value: Double): Boolean = value == Math.floor(value)

    /** `Math.floor` */
    private fun floorOf(value: Double): Double = Math.floor(value)

    /** `String(number)`：整数不带小数点（`uid: 10` 必须变成 `"10"` 而不是 `"10.0"`）。 */
    private fun numberText(value: Double?): String? = value?.let { LorebookJson.jsNumberText(it) }

    /** `foreign` 里原生 v1 命名空间键（迁移器与适配器共用）。 */
    const val NATIVE_FOREIGN_NAMESPACE = "qingyu.native-v1"

    private val KEY_SEPARATOR = Regex("[,，\\n]+")

    /** ST 正则关键词字面量：`/^\/[\s\S]+\/[a-z]*$/i`。 */
    private val REGEX_LITERAL = Regex("^/[\\s\\S]+/[a-z]*$", RegexOption.IGNORE_CASE)

    private val POSITIONS = setOf("before_char", "after_char", "at_depth", "at_end")
    private val ROLES = setOf("system", "user", "assistant")
    private val SELECTIVE_LOGIC = setOf("and_any", "and_all", "not_any", "not_all")
    private val MATCH_MODES = setOf("keyword", "semantic", "both")
    private val PRIORITIES = setOf("always", "conditional", "detail")
    private val GENERATION_TRIGGERS = setOf("normal", "continue", "impersonate", "swipe", "regenerate", "quiet")
}
