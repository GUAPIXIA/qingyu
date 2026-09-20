package com.qingyu.companion.content.lorebook

/**
 * 阶段 5 S5-02：canonical v2 世界书文档模型
 * （`shared/lorebook/domain/v2.ts` 的 1:1 移植）。
 *
 * ## 为什么是「宽松数据类」而不是 sealed 联合
 * TS 用 `kind: 'prompt' | 'chat' | 'outlet' | 'custom'` 的可辨识联合。这里把四种
 * 变体的字段收在同一个 [LorebookInsertion] 上（未使用的字段为 null），理由有两个：
 * 1. **导入必须无损**。适配器要处理的输入来自 7 种外部格式，任何一处「模型装不下
 *    就丢字段」都会直接违反方案 §2「未知字段保留」的要求；
 * 2. 合法性判定已经有独立出处（[LorebookValidation.validateCanonicalV2] 在**原始
 *    Map** 上做逐字段校验，与模型无关），模型再判一次只会产生第二套口径。
 *
 * ## 数字一律 `Double`
 * TS 只有 `number`。`JsonValues` 会把整数解析成 `Long`、小数解析成 `Double`，
 * 模型统一收成 `Double`，写出时由 [LorebookJson] 把整数值还原成 `Long`，
 * 所以 `revision: 1` 仍然导出成 `1` 而不是 `1.0`。
 *
 * ## 往返不丢键
 * [extra] 收集「该层 JSON 里出现、但不属于模型字段」的键，[toJsonMap] 原样回填。
 * 这是 `structuredClone(validation.value)` 的等价物：PC 的 canonical 适配器导入
 * 会整份克隆输入，未知顶层键也随之存活；Android 少了这一步就会在
 * 「PC 导出 → Android 导入 → 再导出」的路上静默瘦身。
 * `foreign` 是**模型字段**（规范定义的未知字段保留区），与 `extra`（模型外的键）
 * 是两件事，因此两者互不覆盖。
 */
data class CanonicalLorebook(
    val schema: String = SCHEMA,
    val schemaVersion: Double = SCHEMA_VERSION.toDouble(),
    val id: String = "",
    val revision: Double = 1.0,
    val name: String = "",
    val description: String = "",
    val enabled: Boolean = true,
    val defaults: LorebookDefaults = LorebookDefaults(),
    val entries: List<CanonicalLoreEntry> = emptyList(),
    val source: LorebookSourceMetadata? = null,
    val foreign: Map<String, Any?>? = null,
    val createdAt: Double = 0.0,
    val updatedAt: Double = 0.0,
    val extra: Map<String, Any?> = emptyMap(),
) {

    /** 文档级 [LorebookValidation.validateCanonicalV2] 通过时才允许落库。 */
    fun isValid(): Boolean = LorebookValidation.validateCanonicalV2(toJsonMap()).valid

    fun toJsonMap(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out.putAll(extra)
        out["schema"] = schema
        out["schemaVersion"] = schemaVersion
        out["id"] = id
        out["revision"] = revision
        out["name"] = name
        out["description"] = description
        out["enabled"] = enabled
        out["defaults"] = defaults.toJsonMap()
        out["entries"] = entries.map { it.toJsonMap() }
        source?.let { out["source"] = it.toJsonMap() }
        foreign?.let { out["foreign"] = it }
        out["createdAt"] = createdAt
        out["updatedAt"] = updatedAt
        return out
    }

    fun toJson(): String = LorebookJson.stringify(toJsonMap())

    fun prettyJson(): String = LorebookJson.stringifyPretty(toJsonMap())

    companion object {
        /** `CANONICAL_LOREBOOK_SCHEMA`。 */
        const val SCHEMA = "qingyu_lorebook"

        /** `CANONICAL_LOREBOOK_VERSION`。 */
        const val SCHEMA_VERSION = 2

        private val KNOWN_KEYS = setOf(
            "schema", "schemaVersion", "id", "revision", "name", "description", "enabled",
            "defaults", "entries", "source", "foreign", "createdAt", "updatedAt",
        )

        /**
         * canonical v2 JSON 文本 → 模型。
         *
         * 宽容读取（不校验）：校验是 [LorebookValidation] 的职责，适配器各自决定
         * 是「拒绝并给出 issues」还是「尽力 salvaged」。缺字段时取模型默认值，
         * 因此**不要**用 `fromJson(...).toJson()` 去判断一份文档是否合法。
         */
        fun fromJson(text: String): CanonicalLorebook? =
            fromMap(LorebookJson.record(LorebookJson.parse(text)))

        fun fromMap(map: Map<String, Any?>?): CanonicalLorebook? {
            val raw = LorebookJson.record(map) ?: return null
            return CanonicalLorebook(
                schema = LorebookJson.string(raw["schema"]) ?: SCHEMA,
                schemaVersion = LorebookJson.number(raw["schemaVersion"]) ?: SCHEMA_VERSION.toDouble(),
                id = LorebookJson.string(raw["id"]) ?: "",
                revision = LorebookJson.number(raw["revision"]) ?: 1.0,
                name = LorebookJson.string(raw["name"]) ?: "",
                description = LorebookJson.string(raw["description"]) ?: "",
                enabled = LorebookJson.boolean(raw["enabled"]) ?: true,
                defaults = LorebookDefaults.fromMap(raw["defaults"]),
                entries = LorebookJson.list(raw["entries"]).orEmpty().mapNotNull {
                    CanonicalLoreEntry.fromMap(it)
                },
                source = LorebookSourceMetadata.fromMap(raw["source"]),
                foreign = LorebookJson.record(raw["foreign"]),
                createdAt = LorebookJson.number(raw["createdAt"]) ?: 0.0,
                updatedAt = LorebookJson.number(raw["updatedAt"]) ?: 0.0,
                extra = LorebookJson.extrasOf(raw, KNOWN_KEYS),
            )
        }
    }
}

/** `LorebookSourceMetadata`：`importedAt` / `contentHash` 在 TS 里是必填。 */
data class LorebookSourceMetadata(
    val adapterId: String = "",
    val formatVersion: String? = null,
    val originalName: String? = null,
    val importedAt: Double = 0.0,
    val contentHash: String = "",
    val extra: Map<String, Any?> = emptyMap(),
) {
    fun toJsonMap(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out.putAll(extra)
        out["adapterId"] = adapterId
        formatVersion?.let { out["formatVersion"] = it }
        originalName?.let { out["originalName"] = it }
        out["importedAt"] = importedAt
        out["contentHash"] = contentHash
        return out
    }

    companion object {
        private val KNOWN_KEYS = setOf("adapterId", "formatVersion", "originalName", "importedAt", "contentHash")

        fun fromMap(value: Any?): LorebookSourceMetadata? {
            val raw = LorebookJson.record(value) ?: return null
            return LorebookSourceMetadata(
                adapterId = LorebookJson.string(raw["adapterId"]) ?: "",
                formatVersion = LorebookJson.string(raw["formatVersion"]),
                originalName = LorebookJson.string(raw["originalName"]),
                importedAt = LorebookJson.number(raw["importedAt"]) ?: 0.0,
                contentHash = LorebookJson.string(raw["contentHash"]) ?: "",
                extra = LorebookJson.extrasOf(raw, KNOWN_KEYS),
            )
        }
    }
}

/** `LorebookDefaultsV2`。 */
data class LorebookDefaults(
    val scanDepth: Double = 4.0,
    val recursiveScanning: Boolean = true,
    val tokenBudget: Double? = null,
    val extra: Map<String, Any?> = emptyMap(),
) {
    fun toJsonMap(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out.putAll(extra)
        out["scanDepth"] = scanDepth
        out["recursiveScanning"] = recursiveScanning
        tokenBudget?.let { out["tokenBudget"] = it }
        return out
    }

    companion object {
        private val KNOWN_KEYS = setOf("scanDepth", "recursiveScanning", "tokenBudget")

        fun fromMap(value: Any?): LorebookDefaults {
            val raw = LorebookJson.record(value) ?: return LorebookDefaults()
            return LorebookDefaults(
                scanDepth = LorebookJson.number(raw["scanDepth"]) ?: 4.0,
                recursiveScanning = LorebookJson.boolean(raw["recursiveScanning"]) ?: true,
                tokenBudget = LorebookJson.number(raw["tokenBudget"]),
                extra = LorebookJson.extrasOf(raw, KNOWN_KEYS),
            )
        }
    }
}

/** `LorebookActivationV2.regex`（TS 里是内联对象）。 */
data class LorebookRegex(
    val enabled: Boolean = false,
    val flags: String = "",
    val extra: Map<String, Any?> = emptyMap(),
) {
    fun toJsonMap(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out.putAll(extra)
        out["enabled"] = enabled
        out["flags"] = flags
        return out
    }

    companion object {
        private val KNOWN_KEYS = setOf("enabled", "flags")

        fun fromMap(value: Any?): LorebookRegex {
            val raw = LorebookJson.record(value) ?: return LorebookRegex()
            return LorebookRegex(
                enabled = LorebookJson.boolean(raw["enabled"]) ?: false,
                flags = LorebookJson.string(raw["flags"]) ?: "",
                extra = LorebookJson.extrasOf(raw, KNOWN_KEYS),
            )
        }
    }
}

/** `LorebookActivationV2`：启用/关键词/正则/key logic/大小写/整词/检索模式。 */
data class LorebookActivation(
    val mode: String = "conditional",
    val budgetTier: String = "standard",
    val primaryKeys: List<String> = emptyList(),
    val secondaryKeys: List<String> = emptyList(),
    val aliases: List<String> = emptyList(),
    val keyLogic: String = "any",
    val secondaryLogic: String? = null,
    val caseSensitive: Boolean = false,
    val wholeWords: Boolean = true,
    val regex: LorebookRegex = LorebookRegex(),
    val retrieval: String = "keyword",
    val extra: Map<String, Any?> = emptyMap(),
) {
    fun toJsonMap(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out.putAll(extra)
        out["mode"] = mode
        out["budgetTier"] = budgetTier
        out["primaryKeys"] = primaryKeys
        out["secondaryKeys"] = secondaryKeys
        out["aliases"] = aliases
        out["keyLogic"] = keyLogic
        secondaryLogic?.let { out["secondaryLogic"] = it }
        out["caseSensitive"] = caseSensitive
        out["wholeWords"] = wholeWords
        out["regex"] = regex.toJsonMap()
        out["retrieval"] = retrieval
        return out
    }

    companion object {
        private val KNOWN_KEYS = setOf(
            "mode", "budgetTier", "primaryKeys", "secondaryKeys", "aliases", "keyLogic",
            "secondaryLogic", "caseSensitive", "wholeWords", "regex", "retrieval",
        )

        fun fromMap(value: Any?): LorebookActivation {
            val raw = LorebookJson.record(value) ?: return LorebookActivation()
            return LorebookActivation(
                mode = LorebookJson.string(raw["mode"]) ?: "conditional",
                budgetTier = LorebookJson.string(raw["budgetTier"]) ?: "standard",
                primaryKeys = LorebookJson.stringArray(raw["primaryKeys"]).orEmpty(),
                secondaryKeys = LorebookJson.stringArray(raw["secondaryKeys"]).orEmpty(),
                aliases = LorebookJson.stringArray(raw["aliases"]).orEmpty(),
                keyLogic = LorebookJson.string(raw["keyLogic"]) ?: "any",
                secondaryLogic = LorebookJson.string(raw["secondaryLogic"]),
                caseSensitive = LorebookJson.boolean(raw["caseSensitive"]) ?: false,
                wholeWords = LorebookJson.boolean(raw["wholeWords"]) ?: true,
                regex = LorebookRegex.fromMap(raw["regex"]),
                retrieval = LorebookJson.string(raw["retrieval"]) ?: "keyword",
                extra = LorebookJson.extrasOf(raw, KNOWN_KEYS),
            )
        }
    }
}

/**
 * `LorebookInsertionV2`（可辨识联合的宽松表示）。
 *
 * `kind` 取值：`prompt`（用 [anchor]）、`chat`（用 [depth]/[role]）、
 * `outlet`（用 [name]）、`custom`（用 [source]/[value]）。
 * 读取时**不看 kind**，各字段按存在性取，因此 `{"kind":"chat"}` 缺 depth 也不会炸。
 */
data class LorebookInsertion(
    val kind: String = "prompt",
    val anchor: String? = null,
    val depth: Double? = null,
    val role: String? = null,
    val name: String? = null,
    val source: String? = null,
    val value: Any? = null,
    /** `value` 是否真的出现在源对象里（`custom` 的 value 可以是 JSON null）。 */
    val hasValue: Boolean = false,
    val extra: Map<String, Any?> = emptyMap(),
) {
    fun toJsonMap(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out.putAll(extra)
        out["kind"] = kind
        when (kind) {
            "chat" -> {
                depth?.let { out["depth"] = it }
                role?.let { out["role"] = it }
            }
            "outlet" -> name?.let { out["name"] = it }
            "custom" -> {
                source?.let { out["source"] = it }
                if (hasValue) out["value"] = value
            }
            else -> anchor?.let { out["anchor"] = it }
        }
        return out
    }

    companion object {
        private val KNOWN_KEYS = setOf("kind", "anchor", "depth", "role", "name", "source", "value")

        fun prompt(anchor: String): LorebookInsertion = LorebookInsertion(kind = "prompt", anchor = anchor)

        fun chat(depth: Double, role: String?): LorebookInsertion =
            LorebookInsertion(kind = "chat", depth = depth, role = role)

        fun outlet(name: String): LorebookInsertion = LorebookInsertion(kind = "outlet", name = name)

        fun custom(source: String, value: Any?): LorebookInsertion =
            LorebookInsertion(kind = "custom", source = source, value = value, hasValue = true)

        fun fromMap(value: Any?): LorebookInsertion {
            val raw = LorebookJson.record(value) ?: return LorebookInsertion()
            return LorebookInsertion(
                kind = LorebookJson.string(raw["kind"]) ?: "prompt",
                anchor = LorebookJson.string(raw["anchor"]),
                depth = LorebookJson.number(raw["depth"]),
                role = LorebookJson.string(raw["role"]),
                name = LorebookJson.string(raw["name"]),
                source = LorebookJson.string(raw["source"]),
                value = raw["value"],
                hasValue = LorebookJson.has(raw, "value"),
                extra = LorebookJson.extrasOf(raw, KNOWN_KEYS),
            )
        }
    }
}

/** `LorebookSchedulingV2.recursion`（TS 内联对象）。 */
data class LorebookRecursion(
    val exclude: Boolean = false,
    val prevent: Boolean = false,
    val minDepth: Double = 0.0,
    val extra: Map<String, Any?> = emptyMap(),
) {
    fun toJsonMap(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out.putAll(extra)
        out["exclude"] = exclude
        out["prevent"] = prevent
        out["minDepth"] = minDepth
        return out
    }

    companion object {
        private val KNOWN_KEYS = setOf("exclude", "prevent", "minDepth")

        fun fromMap(value: Any?): LorebookRecursion {
            val raw = LorebookJson.record(value) ?: return LorebookRecursion()
            return LorebookRecursion(
                exclude = LorebookJson.boolean(raw["exclude"]) ?: false,
                prevent = LorebookJson.boolean(raw["prevent"]) ?: false,
                minDepth = LorebookJson.number(raw["minDepth"]) ?: 0.0,
                extra = LorebookJson.extrasOf(raw, KNOWN_KEYS),
            )
        }
    }
}

/** `LorebookSchedulingV2.groups[]`。 */
data class LorebookGroup(
    val name: String = "",
    val weight: Double = 0.0,
    val prioritized: Boolean = false,
    val extra: Map<String, Any?> = emptyMap(),
) {
    fun toJsonMap(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out.putAll(extra)
        out["name"] = name
        out["weight"] = weight
        out["prioritized"] = prioritized
        return out
    }

    companion object {
        private val KNOWN_KEYS = setOf("name", "weight", "prioritized")

        fun fromMap(value: Any?): LorebookGroup {
            val raw = LorebookJson.record(value) ?: return LorebookGroup()
            return LorebookGroup(
                name = LorebookJson.string(raw["name"]) ?: "",
                weight = LorebookJson.number(raw["weight"]) ?: 0.0,
                prioritized = LorebookJson.boolean(raw["prioritized"]) ?: false,
                extra = LorebookJson.extrasOf(raw, KNOWN_KEYS),
            )
        }
    }
}

/** `LorebookSchedulingV2.characterFilter`（TS 内联对象）。 */
data class LorebookCharacterFilter(
    val exclude: Boolean = false,
    val names: List<String> = emptyList(),
    val tags: List<String> = emptyList(),
    val extra: Map<String, Any?> = emptyMap(),
) {
    fun toJsonMap(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out.putAll(extra)
        out["exclude"] = exclude
        out["names"] = names
        out["tags"] = tags
        return out
    }

    companion object {
        private val KNOWN_KEYS = setOf("exclude", "names", "tags")

        fun fromMap(value: Any?): LorebookCharacterFilter? {
            val raw = LorebookJson.record(value) ?: return null
            return LorebookCharacterFilter(
                exclude = LorebookJson.boolean(raw["exclude"]) ?: false,
                names = LorebookJson.stringArray(raw["names"]).orEmpty(),
                tags = LorebookJson.stringArray(raw["tags"]).orEmpty(),
                extra = LorebookJson.extrasOf(raw, KNOWN_KEYS),
            )
        }
    }
}

/** `LorebookSchedulingV2`：顺序、概率、深度、递归与时效。 */
data class LorebookScheduling(
    val order: Double = 0.0,
    val probability: Double = 100.0,
    val scanDepth: Double? = null,
    val recursion: LorebookRecursion = LorebookRecursion(),
    val groups: List<LorebookGroup> = emptyList(),
    val groupScoring: Boolean = false,
    val sticky: Double? = null,
    val cooldown: Double? = null,
    val delay: Double? = null,
    val ignoreBudget: Boolean = false,
    val characterFilter: LorebookCharacterFilter? = null,
    val generationTriggers: List<String>? = null,
    val extra: Map<String, Any?> = emptyMap(),
) {
    fun toJsonMap(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out.putAll(extra)
        out["order"] = order
        out["probability"] = probability
        scanDepth?.let { out["scanDepth"] = it }
        out["recursion"] = recursion.toJsonMap()
        out["groups"] = groups.map { it.toJsonMap() }
        out["groupScoring"] = groupScoring
        sticky?.let { out["sticky"] = it }
        cooldown?.let { out["cooldown"] = it }
        delay?.let { out["delay"] = it }
        out["ignoreBudget"] = ignoreBudget
        characterFilter?.let { out["characterFilter"] = it.toJsonMap() }
        generationTriggers?.let { out["generationTriggers"] = it }
        return out
    }

    companion object {
        private val KNOWN_KEYS = setOf(
            "order", "probability", "scanDepth", "recursion", "groups", "groupScoring",
            "sticky", "cooldown", "delay", "ignoreBudget", "characterFilter",
            "generationTriggers",
        )

        fun fromMap(value: Any?): LorebookScheduling {
            val raw = LorebookJson.record(value) ?: return LorebookScheduling()
            return LorebookScheduling(
                order = LorebookJson.number(raw["order"]) ?: 0.0,
                probability = LorebookJson.number(raw["probability"]) ?: 100.0,
                scanDepth = LorebookJson.number(raw["scanDepth"]),
                recursion = LorebookRecursion.fromMap(raw["recursion"]),
                groups = LorebookJson.list(raw["groups"]).orEmpty().mapNotNull {
                    if (LorebookJson.record(it) == null) null else LorebookGroup.fromMap(it)
                },
                groupScoring = LorebookJson.boolean(raw["groupScoring"]) ?: false,
                sticky = LorebookJson.number(raw["sticky"]),
                cooldown = LorebookJson.number(raw["cooldown"]),
                delay = LorebookJson.number(raw["delay"]),
                ignoreBudget = LorebookJson.boolean(raw["ignoreBudget"]) ?: false,
                characterFilter = LorebookCharacterFilter.fromMap(raw["characterFilter"]),
                generationTriggers = LorebookJson.list(raw["generationTriggers"])
                    ?.mapNotNull { LorebookJson.string(it) },
                extra = LorebookJson.extrasOf(raw, KNOWN_KEYS),
            )
        }
    }
}

/** `CanonicalLoreEntryV2`。`sourceId` 是 `string | number`，故保留为原始 JSON 值。 */
data class CanonicalLoreEntry(
    val id: String = "",
    val sourceId: Any? = null,
    val enabled: Boolean = true,
    val title: String? = null,
    val content: String = "",
    val summary: String? = null,
    val translation: String? = null,
    val activation: LorebookActivation = LorebookActivation(),
    val insertion: LorebookInsertion = LorebookInsertion(),
    val scheduling: LorebookScheduling = LorebookScheduling(),
    val foreign: Map<String, Any?>? = null,
    val extra: Map<String, Any?> = emptyMap(),
) {
    fun toJsonMap(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out.putAll(extra)
        out["id"] = id
        sourceId?.let { out["sourceId"] = it }
        out["enabled"] = enabled
        title?.let { out["title"] = it }
        out["content"] = content
        summary?.let { out["summary"] = it }
        translation?.let { out["translation"] = it }
        out["activation"] = activation.toJsonMap()
        out["insertion"] = insertion.toJsonMap()
        out["scheduling"] = scheduling.toJsonMap()
        foreign?.let { out["foreign"] = it }
        return out
    }

    companion object {
        private val KNOWN_KEYS = setOf(
            "id", "sourceId", "enabled", "title", "content", "summary", "translation",
            "activation", "insertion", "scheduling", "foreign",
        )

        fun fromMap(value: Any?): CanonicalLoreEntry? {
            val raw = LorebookJson.record(value) ?: return null
            return CanonicalLoreEntry(
                id = LorebookJson.string(raw["id"]) ?: "",
                sourceId = raw["sourceId"].let { if (it is Number || it is String) it else null },
                enabled = LorebookJson.boolean(raw["enabled"]) ?: true,
                title = LorebookJson.string(raw["title"]),
                content = LorebookJson.string(raw["content"]) ?: "",
                summary = LorebookJson.string(raw["summary"]),
                translation = LorebookJson.string(raw["translation"]),
                activation = LorebookActivation.fromMap(raw["activation"]),
                insertion = LorebookInsertion.fromMap(raw["insertion"]),
                scheduling = LorebookScheduling.fromMap(raw["scheduling"]),
                foreign = LorebookJson.record(raw["foreign"]),
                extra = LorebookJson.extrasOf(raw, KNOWN_KEYS),
            )
        }
    }
}

/**
 * 把 `foreign` 命名空间下的值整体替换/清除（返回新对象，不改入参）。
 *
 * 上限裁剪（[LorebookLimits.enforceImportDocumentLimits]）与适配器合并保留区都走这里，
 * 保证「命名空间存在但值为空」这种半成品状态不会留在文档里——PC 侧对应
 * `document.foreign = applyForeignCap(...)` 可能把整个键删掉的行为。
 */
internal fun Map<String, Any?>?.withForeignNamespace(
    namespace: String,
    value: Any?,
): Map<String, Any?>? {
    val current = this ?: emptyMap()
    if (value == null) return current.takeIf { it.isNotEmpty() }
    val out = LinkedHashMap<String, Any?>(current)
    out[namespace] = value
    return out
}
