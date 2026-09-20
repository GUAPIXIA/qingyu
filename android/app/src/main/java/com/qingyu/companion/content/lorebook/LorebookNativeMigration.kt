package com.qingyu.companion.content.lorebook

/**
 * 阶段 5 S5-02：native v1 → canonical v2 迁移
 * （`shared/lorebook/migrations/v1-to-v2.ts` + `migrations/index.ts` 的移植）。
 *
 * 这一层是**唯一**把「运行时形状」（position/depth/matchMode/priority…）
 * 抬升成「编辑器形状」（activation/insertion/scheduling）的地方，
 * 所以外部格式的导入也是先归一化成 native v1、再过这里——
 * 三条路径（原生、外部、映射模板）共用同一份迁移，才能保证
 * 「Android 导入 → PC 再导入」不产生第二套语义。
 *
 * 两处刻意的收紧，都写在这里而不是散落到各适配器：
 * 1. `entry.id` 在非字符串时按 `String(number)` 的口径转成文本
 *    （TS 靠 `validateNativeLorebookV1` 保证是字符串，Android 侧多一层兜底，
 *    不会因此接受任何 PC 拒绝的输入——那条路径上 validator 仍会先拒绝）。
 * 2. `collectForeign` 跳过原型链键。TS 的 `jsonValue()` 没做这个检查，
 *    但在 JS 里 `result["__proto__"] = …` 根本不会成为一个自有键，
 *    等价于「丢弃」；Kotlin 的 Map 会真的存进去，所以必须显式跳过才等价。
 */
object LorebookNativeMigration {

    /** `MigrateNativeV1Options`。 */
    data class Options(
        val now: Double,
        val contentHash: String,
        val revision: Double? = null,
    )

    private val BOOK_KEYS = setOf(
        "id", "name", "description", "entries", "enabled", "scanDepth", "recursiveScanning",
        "tokenBudget", "schemaVersion", "runtime",
    )

    private val ENTRY_KEYS = setOf(
        "id", "keywords", "content", "position", "depth", "role", "order", "probability", "enabled",
        "useRegex", "regexFlags", "secondaryKeywords", "selectiveLogic", "caseSensitive", "matchWholeWords",
        "excludeRecursion", "preventRecursion", "scanDepth", "delayUntilRecursion", "inclusionGroups",
        "inclusionGroupPrioritized", "inclusionGroupWeight", "useGroupScoring", "characterFilter",
        "generationTriggers", "sticky", "cooldown", "delay", "ignoreBudget", "matchMode", "translation",
        "priority", "summary", "runtime",
    )

    private val PROMPT_ANCHORS = setOf(
        "before_character", "after_character", "before_examples", "after_examples",
        "authors_note_top", "authors_note_bottom", "prompt_end",
    )
    private val ROLES = setOf("system", "user", "assistant")
    private val RETRIEVAL_MODES = setOf("keyword", "semanticPreferred", "semanticRequired", "hybrid")

    /**
     * `migrateLorebookDocumentToLatest`：读到的文档既可能是 canonical v2，
     * 也可能是仍留在库里的 native v1。
     *
     * 旧版本曾把 `defaults.tokenBudget = 0` 保存为「硬上限为零」，会让整本世界书静默失效，
     * 所以读取时先宽容归一化成「未设置」；后续保存自然写回正整数或缺省字段。
     */
    fun migrateToLatest(input: Any?, options: Options): CanonicalLorebook {
        val normalized = normalizeLegacyZeroTokenBudget(input)
        LorebookValidation.validateCanonicalV2(normalized).value?.let { canonical ->
            return CanonicalLorebook.fromMap(canonical) ?: throw LorebookMigrationError(
                "世界书既不是有效的 canonical v2，也不是有效的 native v1",
                listOf(LorebookValidationIssue("$", "canonical v2 文档无法建模")),
            )
        }
        val legacy = LorebookNativeV1.validate(normalized)
        if (!legacy.valid) {
            throw LorebookMigrationError(
                "世界书既不是有效的 canonical v2，也不是有效的 native v1",
                legacy.issues.map { LorebookValidationIssue(it.path, "${it.code.jsonValue}: ${it.message}") },
            )
        }
        return migrateV1ToV2(legacy.value ?: emptyMap(), options)
    }

    /** `migrateNativeLorebookV1ToV2`。入参是 native v1 形状的原始对象（已校验或归一化产物）。 */
    fun migrateV1ToV2(lorebook: Map<String, Any?>, options: Options): CanonicalLorebook {
        val seenIds = mutableSetOf<String>()
        val entries = LorebookJson.list(lorebook["entries"]).orEmpty().map { raw ->
            entryFromLegacy(LorebookJson.record(raw) ?: emptyMap())
        }.map { entry ->
            // 方案 §13.1 契约：重复 source ID 不得产生冲突条目 ID；对同一输入确定性去重
            if (!seenIds.contains(entry.id)) {
                seenIds += entry.id
                return@map entry
            }
            var suffix = 2
            while (seenIds.contains("${entry.id}-$suffix")) suffix += 1
            val deduped = entry.copy(id = "${entry.id}-$suffix")
            seenIds += deduped.id
            deduped
        }

        val name = LorebookJson.string(lorebook["name"]) ?: ""
        val tokenBudget = LorebookJson.number(lorebook["tokenBudget"])
        return CanonicalLorebook(
            id = LorebookJson.string(lorebook["id"]) ?: "",
            revision = maxOf(1.0, Math.floor(options.revision ?: 1.0)),
            name = name,
            description = LorebookJson.string(lorebook["description"]) ?: "",
            enabled = LorebookJson.boolean(lorebook["enabled"]) ?: true,
            defaults = LorebookDefaults(
                scanDepth = LorebookJson.number(lorebook["scanDepth"]) ?: 0.0,
                recursiveScanning = lorebook["recursiveScanning"] != false,
                tokenBudget = tokenBudget?.takeIf { it > 0 },
            ),
            entries = entries,
            source = LorebookSourceMetadata(
                adapterId = LorebookNativeV1.NATIVE_FOREIGN_NAMESPACE,
                formatVersion = "1",
                originalName = name,
                importedAt = options.now,
                contentHash = options.contentHash,
            ),
            foreign = collectForeign(lorebook, BOOK_KEYS, LorebookNativeV1.NATIVE_FOREIGN_NAMESPACE),
            createdAt = options.now,
            updatedAt = options.now,
        )
    }

    // ------------------------------------------------------------------ 条目迁移

    private fun entryFromLegacy(entry: Map<String, Any?>): CanonicalLoreEntry {
        val priority = LorebookJson.string(entry["priority"])
        val constant = priority == "always"
        val budgetTier = when (priority) {
            "always" -> "protected"
            "detail" -> "supplemental"
            else -> "standard"
        }
        val delayUntilRecursion = entry["delayUntilRecursion"]
        val recursionDepth = when {
            delayUntilRecursion == true -> 1.0
            LorebookJson.number(delayUntilRecursion) != null ->
                maxOf(1.0, Math.floor(LorebookJson.number(delayUntilRecursion)!!))
            else -> 0.0
        }
        val groupWeight = maxOf(0.0, LorebookJson.number(entry["inclusionGroupWeight"]) ?: 100.0)
        val groupPrioritized = entry["inclusionGroupPrioritized"] == true
        val entryId = idText(entry["id"])

        return CanonicalLoreEntry(
            id = entryId,
            sourceId = entry["id"] as? String ?: entry["id"] as? Number,
            enabled = LorebookJson.boolean(entry["enabled"]) ?: true,
            content = LorebookJson.string(entry["content"]) ?: "",
            summary = LorebookJson.string(entry["summary"]),
            translation = LorebookJson.string(entry["translation"]),
            activation = LorebookActivation(
                mode = if (constant) "constant" else "conditional",
                budgetTier = budgetTier,
                primaryKeys = LorebookJson.stringArray(entry["keywords"]).orEmpty().toList(),
                secondaryKeys = LorebookJson.stringArray(entry["secondaryKeywords"]).orEmpty().toList(),
                aliases = emptyList(),
                keyLogic = "any",
                secondaryLogic = LorebookJson.string(entry["selectiveLogic"])?.takeIf { it.isNotEmpty() },
                caseSensitive = entry["caseSensitive"] == true,
                wholeWords = entry["matchWholeWords"] != false,
                regex = LorebookRegex(
                    enabled = entry["useRegex"] == true,
                    flags = LorebookJson.string(entry["regexFlags"]) ?: "i",
                ),
                retrieval = runtimeRetrieval(entry),
            ),
            insertion = insertionFromLegacy(entry),
            scheduling = LorebookScheduling(
                order = LorebookJson.number(entry["order"]) ?: 0.0,
                probability = LorebookJson.number(entry["probability"]) ?: 100.0,
                scanDepth = LorebookJson.number(entry["scanDepth"]),
                recursion = LorebookRecursion(
                    exclude = entry["excludeRecursion"] == true,
                    prevent = entry["preventRecursion"] == true,
                    minDepth = recursionDepth,
                ),
                groups = LorebookJson.stringArray(entry["inclusionGroups"]).orEmpty().map { name ->
                    LorebookGroup(name = name, weight = groupWeight, prioritized = groupPrioritized)
                },
                groupScoring = entry["useGroupScoring"] == true,
                sticky = LorebookJson.number(entry["sticky"]),
                cooldown = LorebookJson.number(entry["cooldown"]),
                delay = LorebookJson.number(entry["delay"]),
                ignoreBudget = entry["ignoreBudget"] == true,
                characterFilter = LorebookJson.record(entry["characterFilter"])?.let { filter ->
                    LorebookCharacterFilter(
                        exclude = LorebookJson.boolean(filter["exclude"]) ?: false,
                        names = LorebookJson.stringArray(filter["names"]).orEmpty().toList(),
                        tags = LorebookJson.stringArray(filter["tags"]).orEmpty().toList(),
                    )
                },
                generationTriggers = LorebookJson.stringArray(entry["generationTriggers"])?.toList(),
            ),
            foreign = collectForeign(entry, ENTRY_KEYS, LorebookNativeV1.NATIVE_FOREIGN_NAMESPACE),
        )
    }

    /** `retrievalFromLegacy`：`both`/缺省都落 `hybrid`（旧数据 undefined 视为 both）。 */
    private fun retrievalFromLegacy(matchMode: Any?): String = when (matchMode) {
        "keyword" -> "keyword"
        "semantic" -> "semanticPreferred"
        else -> "hybrid"
    }

    /** `runtimeRetrieval`：编译器写过的 `runtime.retrieval` 优先于旧的 `matchMode`。 */
    private fun runtimeRetrieval(entry: Map<String, Any?>): String {
        val value = LorebookJson.string(LorebookJson.record(entry["runtime"])?.get("retrieval"))
        return if (value != null && RETRIEVAL_MODES.contains(value)) value else retrievalFromLegacy(entry["matchMode"])
    }

    private fun insertionFromLegacy(entry: Map<String, Any?>): LorebookInsertion {
        runtimeInsertion(entry)?.let { return it }
        when (entry["position"]) {
            "before_char" -> return LorebookInsertion.prompt("before_character")
            "after_char" -> return LorebookInsertion.prompt("after_character")
            "at_depth" -> return LorebookInsertion.chat(
                depth = maxOf(0.0, Math.floor(LorebookJson.number(entry["depth"]) ?: 0.0)),
                role = LorebookJson.string(entry["role"])?.takeIf { it.isNotEmpty() },
            )
        }
        return LorebookInsertion.prompt("prompt_end")
    }

    /**
     * `runtimeInsertion`：兼容视图里已经带着完整 canonical 插入位置时直接采用，
     * 避免把 `position` 已降级过的信息再反推一次（PC 注释：执行器优先用 runtime）。
     */
    private fun runtimeInsertion(entry: Map<String, Any?>): LorebookInsertion? {
        val runtime = LorebookJson.record(entry["runtime"]) ?: return null
        val insertion = LorebookJson.record(runtime["insertion"]) ?: return null
        return when (LorebookJson.string(insertion["kind"])) {
            "chat" -> {
                val depth = LorebookJson.number(insertion["depth"]) ?: return null
                // `role !== undefined && !ROLES.includes(role)` → 整个插入位置作废，
                // 所以显式 null / 非字符串 / 未知角色都必须拒绝，不能让 Kotlin 的
                // 「null 等于缺失」把这条判定吞掉。
                val role = if (LorebookJson.has(insertion, "role")) {
                    val raw = insertion["role"]
                    if (raw !is String || !ROLES.contains(raw)) return null
                    raw
                } else {
                    null
                }
                LorebookInsertion(kind = "chat", depth = maxOf(0.0, Math.floor(depth)), role = role)
            }
            "prompt" -> {
                val anchor = LorebookJson.string(insertion["anchor"])
                if (anchor == null || !PROMPT_ANCHORS.contains(anchor)) null else LorebookInsertion.fromMap(insertion)
            }
            "outlet" -> if (insertion["name"] is String) LorebookInsertion.fromMap(insertion) else null
            "custom" -> {
                val source = LorebookJson.string(insertion["source"]) ?: return null
                // `jsonValue(undefined) === undefined` → 拒绝；`jsonValue(null) === null` → 接受。
                if (!LorebookJson.has(insertion, "value")) return null
                val raw = insertion["value"]
                if (raw != null && !LorebookJson.isPersistable(raw)) return null
                LorebookInsertion.custom(source, LorebookJson.toJsonValue(raw))
            }
            else -> null
        }
    }

    // ------------------------------------------------------------------ foreign 收集

    /** `collectForeign`：已知字段之外的键整体进 `<namespace>`，一个都没有时返回 null。 */
    private fun collectForeign(
        value: Map<String, Any?>,
        known: Set<String>,
        namespace: String,
    ): Map<String, Any?>? {
        val extras = LinkedHashMap<String, Any?>()
        value.forEach { (key, item) ->
            if (known.contains(key) || LorebookJson.DANGEROUS_KEYS.contains(key)) return@forEach
            val converted = if (item == null || LorebookJson.isPersistable(item)) LorebookJson.toJsonValue(item) else null
            if (converted != null || item == null) extras[key] = converted
        }
        return extras.takeIf { it.isNotEmpty() }?.let { mapOf(namespace to it) }
    }

    /** 顶层 `defaults.tokenBudget === 0` 的历史数据：读时抹掉这个键。 */
    private fun normalizeLegacyZeroTokenBudget(input: Any?): Any? {
        val record = LorebookJson.record(input) ?: return input
        if (record["schema"] != CanonicalLorebook.SCHEMA) return input
        val defaults = LorebookJson.record(record["defaults"]) ?: return input
        if (LorebookJson.number(defaults["tokenBudget"]) != 0.0) return input
        if (!defaults.containsKey("tokenBudget")) return input
        val nextDefaults = LinkedHashMap<String, Any?>(defaults)
        nextDefaults.remove("tokenBudget")
        val next = LinkedHashMap<String, Any?>(record)
        next["defaults"] = nextDefaults
        return next
    }

    /** `String(rawId)` 口径的 id 文本化（数字不带 `.0`）。 */
    private fun idText(value: Any?): String = when (value) {
        is String -> value
        is Number -> LorebookJson.jsNumberText(LorebookJson.number(value) ?: 0.0)
        else -> value?.toString().orEmpty()
    }
}
