package com.qingyu.companion.content.lorebook

/**
 * 阶段 5 S5-02：外部格式（SillyTavern / character_book / Risu / NovelAI / Agnai /
 * lorebook_v3）共用的导入导出机器。移植自 `electron/services/lorebookAdapters/common.ts`。
 *
 * ## 一条流水线，两种风格
 * 所有外部格式都走同一条路：
 * 归一化器（[LorebookNativeV1.normalize]）→ native v1 → canonical v2（[LorebookNativeMigration]）
 * → 本文件的 [importExternalLorebook] 补上「只有原始文件里才有」的东西
 * （插入位置、sourceId、title、`foreign` 保留区）。
 * 两条风格差异（`sillytavern` 与 `character_book`）只体现在**读字段的优先级**上：
 * character_book 以 `extensions.*` 为准，sillytavern 以顶层为准。
 *
 * ## `undefined` 与 `null` 必须分得开
 * JS 的 `??` 把两者都当空，但 `=== undefined` 只认前者。ST 的
 * `{"position": null}` 在 PC 上会落到 custom 分支（`value` 保留为 JSON null），
 * 而**没有** position 键的条目落到 `prompt_end`。Kotlin 的 `Map[key]` 把两者压成同一个
 * null，会让这两种输入得到不同结果——所以位置读取一律经 [lookup] 取，
 * 缺键返回 [ABSENT]。这是本文件最容易看漏、也最容易造成跨端漂移的一处。
 *
 * ## 导出为什么要「先铺底稿、再覆写」
 * `externalEntry`/`exportExternalLorebook` 都以 `...stored.fields` 开头，
 * 再由 canonical 重建的字段覆盖。顺序反了就会把用户导入时带进来、
 * 但轻语没有对应概念的字段（如 `extensions.position` 之外的第三方扩展）吃掉，
 * 那正是方案 §2「未知字段保留」要防的静默丢数据。
 */
object LorebookExternalFormat {

    /** `ExternalAdapterConfig.style`。 */
    enum class Style {
        SILLYTAVERN,
        CHARACTER_BOOK,
    }

    /** `ExternalAdapterConfig`。 */
    data class Config(
        val id: String,
        val label: String,
        val version: String,
        val sourceKind: LorebookNativeV1.SourceKind,
        val style: Style,
        /**
         * adapter 实际消费的条目级字段。已列出的字段不再进入 unknown 保留区；
         * 未消费字段仍按 unknown 保留并可随同格式导出合并回去。
         * 为 null 时使用 ST/CC 全集；P1 生态格式应传入自己的消费集。
         */
        val consumedEntryKeys: Set<String>? = null,
    )

    /** 组合适配器消费字段集：ENTRY_KEYS 基础上追加格式特有字段。 */
    fun consumedKeys(extra: List<String>): Set<String> = ENTRY_KEYS + extra

    // ------------------------------------------------------------------ 字段集

    private val BOOK_KEYS = setOf(
        "id", "name", "description", "entries", "enabled", "disable",
        "scanDepth", "scan_depth", "recursiveScanning", "recursive_scanning",
        "tokenBudget", "token_budget", "extensions",
    )

    private val ENTRY_KEYS = setOf(
        "id", "uid", "keywords", "keys", "key", "content", "position", "depth", "role",
        "order", "insertion_order", "probability", "enabled", "disable", "constant",
        "useRegex", "use_regex", "regexFlags", "regex_flags", "secondaryKeywords",
        "secondary_keys", "keysecondary", "selective", "selectiveLogic", "selective_logic",
        "caseSensitive", "case_sensitive", "matchWholeWords", "match_whole_words",
        "excludeRecursion", "exclude_recursion", "preventRecursion", "prevent_recursion",
        "scanDepth", "scan_depth", "delayUntilRecursion", "delay_until_recursion",
        "group", "groupOverride", "group_override", "groupWeight", "group_weight",
        "useGroupScoring", "use_group_scoring", "characterFilter", "character_filter",
        "triggers", "sticky", "cooldown", "delay", "ignoreBudget", "ignore_budget",
        "matchMode", "match_mode", "vectorized", "priority", "summary", "translation",
        "useProbability", "use_probability", "extensions", "comment", "name", "outletName",
        "outlet_name",
    )

    private val EXTENSION_KEYS = setOf(
        "position", "depth", "role", "probability", "useProbability", "use_probability",
        "constant", "vectorized", "useRegex", "use_regex", "regexFlags", "regex_flags",
        "selective", "selectiveLogic", "selective_logic", "caseSensitive", "case_sensitive",
        "matchWholeWords", "match_whole_words", "excludeRecursion", "exclude_recursion",
        "preventRecursion", "prevent_recursion", "scanDepth", "scan_depth",
        "delayUntilRecursion", "delay_until_recursion", "group", "groupOverride",
        "group_override", "groupWeight", "group_weight", "useGroupScoring",
        "use_group_scoring", "characterFilter", "character_filter", "triggers", "sticky",
        "cooldown", "delay", "ignoreBudget", "ignore_budget", "matchMode", "match_mode",
        "priority", "outletName", "outlet_name",
    )

    /** 代表 JS 的 `undefined`（键不存在），与「值确实是 null」区分开。 */
    private val ABSENT = Any()

    // ------------------------------------------------------------------ 导入

    /**
     * `importExternalLorebook`。
     *
     * @param wrapperExtras 包装层（lorebook_v3 的 `spec` 之外的顶层键、Risu/NovelAI 的顶层杂项）
     *                      原样进 `foreign[config.id].wrapper`，导出时贴回顶层。
     */
    fun importExternalLorebook(
        payload: Map<String, Any?>,
        context: LorebookImportContext,
        config: Config,
        wrapperExtras: Map<String, Any?>? = null,
        newId: () -> String = com.qingyu.companion.chatcore.Ulid::newId,
    ): LorebookAdapterImportResult {
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

        val normalized = LorebookNativeV1.normalize(
            payload,
            LorebookNativeV1.NormalizeOptions(
                id = context.id,
                fallbackName = context.fallbackName,
                sourceKind = config.sourceKind,
            ),
            newId,
        )
        var document = LorebookNativeMigration.migrateV1ToV2(
            normalized,
            LorebookNativeMigration.Options(now = context.now, contentHash = context.contentHash),
        )
        document = document.copy(
            source = LorebookSourceMetadata(
                adapterId = config.id,
                formatVersion = config.version,
                originalName = LorebookJson.string(normalized["name"]) ?: "",
                importedAt = context.now,
                contentHash = context.contentHash,
            ),
        )

        val bookFields = collectExtras(payload, BOOK_KEYS, "$", issues)
        val bookExtensions = collectExtras(
            LorebookJson.record(payload["extensions"]),
            emptySet(),
            "$.extensions",
            issues,
        )
        val bookForeign = LinkedHashMap<String, Any?>()
        foreignPayload(bookFields, bookExtensions)?.let { bookForeign["payload"] = it }
        if (!wrapperExtras.isNullOrEmpty()) bookForeign["wrapper"] = wrapperExtras
        if (bookForeign.isNotEmpty()) {
            document = document.copy(foreign = mergeNamespace(document.foreign, config.id, bookForeign))
        }

        val rawEntryValue = payload["entries"]
        val sourceEntryList = sourceEntries(rawEntryValue)
        val sourceCount = when {
            LorebookJson.list(rawEntryValue) != null -> LorebookJson.list(rawEntryValue)!!.size
            LorebookJson.record(rawEntryValue) != null -> LorebookJson.record(rawEntryValue)!!.size
            else -> 0
        }
        if (sourceCount > sourceEntryList.size) {
            add(
                LorebookCompatibilitySeverity.ERROR, LorebookCompatibilityAction.REJECTED, "invalid_entries",
                "$.entries",
                "${sourceCount - sourceEntryList.size} 个条目不是对象，无法导入",
            )
        }
        if (sourceEntryList.isEmpty()) {
            add(
                LorebookCompatibilitySeverity.ERROR, LorebookCompatibilityAction.REJECTED,
                "empty_entries", "$.entries", "没有可导入的世界书条目",
            )
        }

        val consumedEntryKeys = config.consumedEntryKeys ?: ENTRY_KEYS
        val nextEntries = document.entries.mapIndexed { index, entry ->
            val sourceEntry = sourceEntryList.getOrNull(index) ?: return@mapIndexed entry
            val rawEntry = sourceEntry.second
            val entryPath = "$.entries[${sourceEntry.first}]"
            val fields = collectExtras(rawEntry, consumedEntryKeys, entryPath, issues)
            val extensions = collectExtras(
                LorebookJson.record(rawEntry["extensions"]),
                EXTENSION_KEYS,
                "$entryPath.extensions",
                issues,
            )
            val foreign = foreignPayload(fields, extensions)
            // `rawEntry.id ?? rawEntry.uid ?? sourceEntry.key`：显式 null 也继续兜底，与 ?? 一致
            val rawSourceId = rawEntry["id"] ?: rawEntry["uid"] ?: sourceEntry.first
            val sourceId = if (rawSourceId is String || rawSourceId is Number) rawSourceId else entry.sourceId
            val title = (rawEntry["comment"] as? String) ?: (rawEntry["name"] as? String)
            entry.copy(
                sourceId = sourceId,
                title = title?.takeIf { it.isNotEmpty() } ?: entry.title,
                insertion = insertionFromSource(rawEntry, config, entryPath, issues),
                foreign = if (foreign == null) {
                    entry.foreign
                } else {
                    mergeNamespace(entry.foreign, config.id, foreign)
                },
            )
        }
        document = document.copy(entries = nextEntries)

        return LorebookAdapterImportResult(
            document = document,
            report = LorebookCompatibilityReport.create(config.id, config.label, config.version, issues),
        )
    }

    /** `sourceEntries`：数组按下标、对象按键取值，非对象成员跳过（键名用于 sourceId 兜底）。 */
    private fun sourceEntries(value: Any?): List<Pair<String, Map<String, Any?>>> = when {
        LorebookJson.list(value) != null -> LorebookJson.list(value)!!.mapIndexedNotNull { index, item ->
            LorebookJson.record(item)?.let { index.toString() to it }
        }
        LorebookJson.record(value) != null -> LorebookJson.record(value)!!.mapNotNull { (key, item) ->
            LorebookJson.record(item)?.let { key to it }
        }
        else -> emptyList()
    }

    /**
     * `collectExtras`：已知字段之外的键进保留区。
     *
     * PC 在这里同时产出三类 issue：危险键丢弃、非 JSON 值丢弃、未知字段保留。
     * 「保留」是 info 级，因为它正是方案 §2 要求的**可观测**行为，而不是损失。
     */
    private fun collectExtras(
        value: Map<String, Any?>?,
        known: Set<String>,
        path: String,
        issues: MutableList<LorebookCompatibilityIssue>,
    ): LinkedHashMap<String, Any?> {
        val extras = LinkedHashMap<String, Any?>()
        if (value == null) return extras
        fun add(
            severity: LorebookCompatibilitySeverity,
            action: LorebookCompatibilityAction,
            code: String,
            at: String,
            message: String,
        ) {
            issues += LorebookCompatibilityIssue.of(severity, action, code, at, message)
        }
        value.forEach { (key, raw) ->
            if (LorebookJson.DANGEROUS_KEYS.contains(key)) {
                add(
                    LorebookCompatibilitySeverity.WARNING, LorebookCompatibilityAction.DROPPED,
                    "dangerous_key", "$path.$key", "危险键已忽略",
                )
                return@forEach
            }
            if (known.contains(key)) return@forEach
            val present = raw == null || LorebookJson.isPersistable(raw)
            if (!present) {
                add(
                    LorebookCompatibilitySeverity.WARNING, LorebookCompatibilityAction.DROPPED,
                    "non_json_field", "$path.$key", "字段不是可持久化的 JSON 值，已忽略",
                )
                return@forEach
            }
            extras[key] = LorebookJson.toJsonValue(raw)
            add(
                LorebookCompatibilitySeverity.INFO, LorebookCompatibilityAction.PRESERVED,
                "unknown_field", "$path.$key", "未知字段已原样保留在 namespaced foreign 中",
            )
        }
        return extras
    }

    /** `collectWrapperExtras`：包装层未知键（同 [collectExtras]，path 固定为 `$`）。 */
    fun collectWrapperExtras(
        raw: Map<String, Any?>,
        known: Set<String>,
        issues: MutableList<LorebookCompatibilityIssue>,
    ): LinkedHashMap<String, Any?> = collectExtras(raw, known, "$", issues)

    /** `foreignPayload`：fields/extensions 都为空时返回 null（PC 是 undefined）。 */
    private fun foreignPayload(
        fields: Map<String, Any?>,
        extensions: Map<String, Any?>,
    ): Map<String, Any?>? {
        val payload = LinkedHashMap<String, Any?>()
        if (fields.isNotEmpty()) payload["fields"] = fields
        if (extensions.isNotEmpty()) payload["extensions"] = extensions
        return payload.takeIf { it.isNotEmpty() }
    }

    /** `{...foreign, [namespace]: value}`（Kotlin 里要显式建表）。 */
    private fun mergeNamespace(
        foreign: Map<String, Any?>?,
        namespace: String,
        value: Any?,
    ): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        foreign?.let { out.putAll(it) }
        out[namespace] = value
        return out
    }

    /**
     * `foreignSection`：读取某 adapter 命名空间下按 fields/extensions 分组的未知字段（导出底稿）。
     *
     * 命名空间有两种历史形状：`{payload:{fields,extensions}}`（外部格式用）与
     * 直接 `{k:v}`（native v1 迁移用）。PC 靠 `isRecord(namespace.payload)` 分流，
     * 这里同口径；`fields`/`extensions` 缺失时给空表而不是 null，
     * 因为调用方全是 `Object.keys(...)`，缺表等价于 0 个字段。
     */
    fun foreignSection(
        foreign: Map<String, Any?>?,
        adapterId: String,
    ): Pair<Map<String, Any?>, Map<String, Any?>> {
        val namespace = LorebookJson.record(foreign?.get(adapterId))
        val payload = LorebookJson.record(namespace?.get("payload")) ?: namespace
        val record = LorebookJson.record(payload) ?: return emptyMap<String, Any?>() to emptyMap()
        return (LorebookJson.record(record["fields"]) ?: emptyMap()) to
            (LorebookJson.record(record["extensions"]) ?: emptyMap())
    }

    /** `wrapperForeign`：包装层保留区。 */
    fun wrapperForeign(document: CanonicalLorebook, adapterId: String): Map<String, Any?> {
        val namespace = LorebookJson.record(document.foreign?.get(adapterId)) ?: return emptyMap()
        return LorebookJson.record(namespace["wrapper"]) ?: emptyMap()
    }

    // ------------------------------------------------------------------ 插入位置

    private fun lookup(record: Map<String, Any?>, key: String): Any? =
        if (record.containsKey(key)) record[key] else ABSENT

    /** JS `a ?? b`：[ABSENT] 与 null 都是 nullish。 */
    private fun nullish(left: Any?, right: Any?): Any? =
        if (left === ABSENT || left == null) right else left

    /**
     * JS `value !== undefined`。
     *
     * 显式 `null` 在 JS 里是「有值」，所以这里只把 [ABSENT] 当作缺失：
     * `position_conflict` 那条告警的触发条件依赖这个区分（`{"position": null}` 与
     * `{"extensions":{"position":0}}` 在 PC 上确实会报冲突）。
     */
    private fun present(value: Any?): Boolean = value !== ABSENT

    private fun textOf(value: Any?): String? = value as? String

    private fun numericOf(value: Any?): Double? = LorebookJson.number(value)

    /** `sourceField`：两种风格唯一的取值优先级差异。 */
    private fun sourceField(raw: Map<String, Any?>, config: Config, key: String): Any? {
        val extensions = LorebookJson.record(raw["extensions"]) ?: emptyMap()
        return if (config.style == Style.CHARACTER_BOOK) {
            extensions[key] ?: raw[key]
        } else {
            raw[key] ?: extensions[key]
        }
    }

    /** `normalizeRole`：ST 用 0/1/2，轻语原生用字符串。 */
    private fun normalizeRole(value: Any?): String? = when {
        value == "system" || numericOf(value) == 0.0 -> "system"
        value == "user" || numericOf(value) == 1.0 -> "user"
        value == "assistant" || numericOf(value) == 2.0 -> "assistant"
        else -> null
    }

    /** `insertionFromSource`。 */
    private fun insertionFromSource(
        raw: Map<String, Any?>,
        config: Config,
        path: String,
        issues: MutableList<LorebookCompatibilityIssue>,
    ): LorebookInsertion {
        fun add(
            severity: LorebookCompatibilitySeverity,
            action: LorebookCompatibilityAction,
            code: String,
            at: String,
            message: String,
        ) {
            issues += LorebookCompatibilityIssue.of(severity, action, code, at, message)
        }

        val rawPosition = lookup(raw, "position")
        val extensionPosition = lookup(LorebookJson.record(raw["extensions"]) ?: emptyMap(), "position")
        if (config.style == Style.CHARACTER_BOOK && present(rawPosition) && present(extensionPosition) &&
            rawPosition != extensionPosition
        ) {
            add(
                LorebookCompatibilitySeverity.WARNING, LorebookCompatibilityAction.MAPPED,
                "position_conflict", "$path.extensions.position",
                "顶层 position 与 extensions.position 冲突；按 character_book 扩展规则采用 extensions.position",
            )
        }
        val value = if (config.style == Style.CHARACTER_BOOK) {
            nullish(extensionPosition, rawPosition)
        } else {
            nullish(rawPosition, extensionPosition)
        }
        val numeric = numericOf(value)
        val text = textOf(value)

        if (numeric == 0.0 || text == "before" || text == "before_char" || text == "before_character") {
            return LorebookInsertion.prompt("before_character")
        }
        if (numeric == 1.0 || text == "after" || text == "after_char" || text == "after_character") {
            return LorebookInsertion.prompt("after_character")
        }
        if (numeric == 4.0 || text == "at_depth" || text == "depth") {
            val depth = maxOf(0.0, Math.floor(numericOf(sourceField(raw, config, "depth")) ?: 4.0))
            val role = normalizeRole(sourceField(raw, config, "role"))
            return LorebookInsertion(kind = "chat", depth = depth, role = role)
        }
        // 运行时 renderer 对这 4 个锚点原位渲染（方案 §9.1），此处为精确映射而非近似
        val anchor = when {
            numeric == 2.0 || text == "authors_note_top" || text == "before_an" -> "authors_note_top"
            numeric == 3.0 || text == "authors_note_bottom" || text == "after_an" -> "authors_note_bottom"
            numeric == 5.0 || text == "before_examples" -> "before_examples"
            numeric == 6.0 || text == "after_examples" -> "after_examples"
            else -> null
        }
        if (anchor != null) {
            add(
                LorebookCompatibilitySeverity.INFO, LorebookCompatibilityAction.MAPPED,
                "insertion_anchor", "$path.position",
                "插入位置已保留；运行时将按作者注释/示例区锚点原位渲染",
            )
            return LorebookInsertion.prompt(anchor)
        }
        if (numeric == 7.0 || text == "outlet") {
            val outlet = sourceField(raw, config, "outletName") ?: sourceField(raw, config, "outlet_name")
            add(
                LorebookCompatibilitySeverity.WARNING, LorebookCompatibilityAction.APPROXIMATED,
                "runtime_outlet_fallback", "$path.position",
                "命名 outlet 已保留；普通聊天消息协议没有对应插槽，运行时回退到提示词末尾并输出诊断",
            )
            return LorebookInsertion.outlet(
                (outlet as? String)?.takeIf { it.isNotEmpty() } ?: "default",
            )
        }
        // 只有「键不存在」才落到 prompt_end；显式 `null` 在 PC 上会一路走到 custom 分支。
        if (value === ABSENT || text == "at_end" || text == "prompt_end") {
            return LorebookInsertion.prompt("prompt_end")
        }
        add(
            LorebookCompatibilitySeverity.WARNING, LorebookCompatibilityAction.APPROXIMATED,
            "custom_insertion", "$path.position",
            "未知插入位置已作为 custom 值保留；运行时回退到提示词末尾并输出诊断",
        )
        // PC 是 `toJsonValue(value) ?? null`：不可持久化的值落成 JSON null 而不是「键不存在」。
        return LorebookInsertion.custom(config.id, LorebookJson.toJsonValue(value))
    }

    // ------------------------------------------------------------------ 导出

    /** `roleNumber`：canonical 角色 → ST/CC 的 0/1/2。 */
    private fun roleNumber(role: String?): Any? = when (role) {
        "system" -> 0.0
        "user" -> 1.0
        "assistant" -> 2.0
        else -> null
    }

    /** `custom` 的 `value` 可能是 JSON null（合法）或「键不存在」（TS 里是 undefined，写出时键消失）。 */
    private fun customPosition(insertion: LorebookInsertion): Any? =
        if (insertion.hasValue) insertion.value else ABSENT

    /**
     * `insertionPosition`：canonical 插入位置 → 外部格式的 `position`（+ chat/outlet 的附加扩展）。
     *
     * 返回的 position 可能是 [ABSENT]：TS 那里是 `positions[anchor]` 取不到键得到
     * `undefined`，`{position: undefined}` 经 `JSON.stringify` 后**整个键消失**。
     * 用 null 表达会写出 `"position": null`，与 PC 的导出文本不同。
     */
    private fun insertionPosition(insertion: LorebookInsertion): Pair<Any?, Map<String, Any?>?> {
        if (insertion.kind == "chat") {
            val extension = LinkedHashMap<String, Any?>()
            extension["depth"] = insertion.depth ?: 0.0
            roleNumber(insertion.role)?.let { extension["role"] = it }
            return 4.0 to extension
        }
        if (insertion.kind == "outlet") {
            return 7.0 to linkedMapOf("outlet_name" to (insertion.name ?: "default"))
        }
        if (insertion.kind == "custom") {
            return customPosition(insertion) to null
        }
        val position: Any? = when (insertion.anchor) {
            "before_character" -> 0.0
            "after_character" -> 1.0
            "authors_note_top" -> 2.0
            "authors_note_bottom" -> 3.0
            "before_examples" -> 5.0
            "after_examples" -> 6.0
            "prompt_end" -> "at_end"
            else -> ABSENT
        }
        return position to null
    }

    /** `externalEntry`。 */
    private fun externalEntry(entry: CanonicalLoreEntry, config: Config): LinkedHashMap<String, Any?> {
        val stored = foreignSection(entry.foreign, config.id)
        val insertion = insertionPosition(entry.insertion)
        val vectorized = entry.activation.retrieval != "keyword"
        val keys = entry.activation.primaryKeys + entry.activation.aliases

        val out = LinkedHashMap<String, Any?>()
        if (config.style == Style.SILLYTAVERN) {
            out.putAll(stored.first)
            out["uid"] = entry.sourceId ?: entry.id
            out["key"] = keys
            out["keysecondary"] = entry.activation.secondaryKeys.toList()
            out["selective"] = entry.activation.secondaryKeys.isNotEmpty()
            entry.activation.secondaryLogic?.let { out["selectiveLogic"] = it }
            out["content"] = entry.content
            putUnlessAbsent(out, "position", insertion.first)
            insertion.second?.let { out.putAll(it) }
            out["order"] = entry.scheduling.order
            out["probability"] = entry.scheduling.probability
            out["useProbability"] = entry.scheduling.probability != 100.0
            out["disable"] = !entry.enabled
            out["constant"] = entry.activation.mode == "constant"
            out["vectorized"] = vectorized
            out["caseSensitive"] = entry.activation.caseSensitive
            out["matchWholeWords"] = entry.activation.wholeWords
            out["excludeRecursion"] = entry.scheduling.recursion.exclude
            out["preventRecursion"] = entry.scheduling.recursion.prevent
            if (entry.scheduling.recursion.minDepth > 0) out["delayUntilRecursion"] = entry.scheduling.recursion.minDepth
            entry.scheduling.scanDepth?.let { out["scanDepth"] = it }
            if (entry.scheduling.groups.isNotEmpty()) {
                out["group"] = entry.scheduling.groups.joinToString(", ") { it.name }
            }
            if (entry.scheduling.groups.firstOrNull()?.prioritized == true) out["groupOverride"] = true
            entry.scheduling.groups.firstOrNull()?.let { out["groupWeight"] = it.weight }
            out["useGroupScoring"] = entry.scheduling.groupScoring
            entry.scheduling.characterFilter?.let { filter ->
                out["characterFilter"] = linkedMapOf(
                    "isExclude" to filter.exclude,
                    "names" to filter.names.toList(),
                    "tags" to filter.tags.toList(),
                )
            }
            entry.scheduling.generationTriggers?.let { out["triggers"] = it.toList() }
            entry.scheduling.sticky?.let { out["sticky"] = it }
            entry.scheduling.cooldown?.let { out["cooldown"] = it }
            entry.scheduling.delay?.let { out["delay"] = it }
            if (stored.second.isNotEmpty()) out["extensions"] = stored.second
            return out
        }

        val richExtensions = LinkedHashMap<String, Any?>(stored.second)
        if (insertion.first != 0.0 && insertion.first != 1.0) {
            putUnlessAbsent(richExtensions, "position", insertion.first)
        }
        insertion.second?.let { richExtensions.putAll(it) }
        richExtensions["probability"] = entry.scheduling.probability
        richExtensions["use_probability"] = entry.scheduling.probability != 100.0
        richExtensions["vectorized"] = vectorized
        richExtensions["selective"] = entry.activation.secondaryKeys.isNotEmpty()
        entry.activation.secondaryLogic?.let { richExtensions["selective_logic"] = it }
        richExtensions["case_sensitive"] = entry.activation.caseSensitive
        richExtensions["match_whole_words"] = entry.activation.wholeWords
        richExtensions["exclude_recursion"] = entry.scheduling.recursion.exclude
        richExtensions["prevent_recursion"] = entry.scheduling.recursion.prevent
        richExtensions["ignore_budget"] = entry.scheduling.ignoreBudget
        entry.scheduling.scanDepth?.let { richExtensions["scan_depth"] = it }
        if (entry.scheduling.recursion.minDepth > 0) {
            richExtensions["delay_until_recursion"] = entry.scheduling.recursion.minDepth
        }
        if (entry.scheduling.groups.isNotEmpty()) {
            richExtensions["group"] = entry.scheduling.groups.joinToString(", ") { it.name }
        }
        if (entry.scheduling.groups.firstOrNull()?.prioritized == true) richExtensions["group_override"] = true
        entry.scheduling.groups.firstOrNull()?.let { richExtensions["group_weight"] = it.weight }
        richExtensions["use_group_scoring"] = entry.scheduling.groupScoring
        entry.scheduling.characterFilter?.let { filter ->
            richExtensions["character_filter"] = linkedMapOf(
                "isExclude" to filter.exclude,
                "names" to filter.names.toList(),
                "tags" to filter.tags.toList(),
            )
        }
        entry.scheduling.generationTriggers?.let { richExtensions["triggers"] = it.toList() }
        entry.scheduling.sticky?.let { richExtensions["sticky"] = it }
        entry.scheduling.cooldown?.let { richExtensions["cooldown"] = it }
        entry.scheduling.delay?.let { richExtensions["delay"] = it }

        out.putAll(stored.first)
        out["id"] = entry.sourceId ?: entry.id
        out["keys"] = keys
        out["secondary_keys"] = entry.activation.secondaryKeys.toList()
        out["content"] = entry.content
        out["enabled"] = entry.enabled
        out["insertion_order"] = entry.scheduling.order
        out["position"] = if (insertion.first == 1.0) "after_char" else "before_char"
        out["constant"] = entry.activation.mode == "constant"
        out["use_regex"] = entry.activation.regex.enabled
        if (richExtensions.isNotEmpty()) out["extensions"] = richExtensions
        return out
    }

    /** 只在值不是 [ABSENT] 时写键（对齐 `JSON.stringify` 丢弃 undefined 的行为）。 */
    private fun putUnlessAbsent(target: LinkedHashMap<String, Any?>, key: String, value: Any?) {
        if (value !== ABSENT) target[key] = value
    }

    /** `exportExternalLorebook`。 */
    fun exportExternalLorebook(
        document: CanonicalLorebook,
        config: Config,
    ): LorebookAdapterExportResult {
        val stored = foreignSection(document.foreign, config.id)
        val entries = document.entries.map { externalEntry(it, config) }
        val value = LinkedHashMap<String, Any?>()
        value.putAll(stored.first)
        value["name"] = document.name
        value["description"] = document.description
        value["scan_depth"] = document.defaults.scanDepth
        value["recursive_scanning"] = document.defaults.recursiveScanning
        document.defaults.tokenBudget?.let { value["token_budget"] = it }
        if (stored.second.isNotEmpty()) value["extensions"] = stored.second
        value["entries"] = if (config.style == Style.SILLYTAVERN) {
            val byUid = LinkedHashMap<String, Any?>()
            entries.forEachIndexed { index, entry ->
                val sourceId = document.entries[index].sourceId
                val key = when {
                    sourceId is String -> sourceId
                    sourceId is Number -> LorebookJson.jsNumberText(LorebookJson.number(sourceId) ?: 0.0)
                    else -> index.toString()
                }
                byUid[key] = entry
            }
            byUid
        } else {
            entries
        }

        val preservedCount = countPreserved(document, config.id)
        val issues = if (preservedCount > 0) {
            listOf(
                LorebookCompatibilityIssue.of(
                    LorebookCompatibilitySeverity.INFO, LorebookCompatibilityAction.PRESERVED,
                    "foreign_exported", "$", "$preservedCount 个未知字段已合并回导出格式",
                ),
            )
        } else {
            emptyList()
        }
        return LorebookAdapterExportResult(
            value = value,
            report = LorebookCompatibilityReport.create(config.id, config.label, config.version, issues),
        )
    }

    /** 本书 + 各条目在该 adapter 命名空间下保留的未知字段总数（`foreign_exported` 报告用）。 */
    fun countPreserved(document: CanonicalLorebook, adapterId: String): Int {
        val book = foreignSection(document.foreign, adapterId)
        return book.first.size + book.second.size + document.entries.sumOf { entry ->
            val section = foreignSection(entry.foreign, adapterId)
            section.first.size + section.second.size
        }
    }
}