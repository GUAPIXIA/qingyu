package com.qingyu.companion.content.lorebook

/**
 * 阶段 5 S5-02：受限映射模板（`lorebook_mapping_template` 的正文）与应用它的导入。
 *
 * 移植自 `shared/lorebook/adapters/mapping.ts`（模板形状与路径解析）与
 * `electron/services/lorebookAdapters/mappingImport.ts`（应用模板导入）。
 *
 * ## 为什么需要它
 * 未知 Tavern fork / 通用 JSON 没有可靠的自动识别特征，方案 §6.1 又禁止静默猜测，
 * 所以留一条「用户自己指认条目数组与关键字段路径」的口子；模板可复用，
 * 并且按总方案 §6.1 是**同步实体**（`local_lorebook_mapping_templates` 表）。
 *
 * ## 受限 DSL：只搬字段，不求值
 * 模板来自用户导入的外部文件，历史上这类问题的形态是「在映射表达式里塞 JS/Shell 片段，
 * 导入器再用 eval/模板引擎求值」。这里从两头堵住：
 * 1. 路径**只**是点分字段名序列（[LorebookMappingTemplates.resolvePath]），没有表达式语法；
 * 2. 解析前限体积与嵌套深度，解析后做键封闭与「可执行内容特征字符」检查。
 *
 * ## 与 `LorebookMappingTemplateDsl` 的关系（待收敛，勿静默改语义）
 * Android 侧另有一份节点式白名单校验器
 * [com.qingyu.companion.local.domain.LorebookMappingTemplateDsl]（S5-02 并行开发），
 * 它认的是 `{mappings:[{target,source}]}` + `field`/`index`/`const` 三类节点，
 * 与 PC 的点分路径**不同形**。二者可无损互转的只有「纯 `field` 链」那一子集。
 * 本文件的取舍是：
 * - 导入引擎以 PC 形状为唯一真源（方案 §S5-02 末句要求导入结果与 PC fixture 一致）；
 * - [LorebookMappingTemplates.fromDslJson] 把节点式模板折回点分路径，
 *   出现 `index`/`const` 或未知 target 时**显式拒绝**而不是猜；
 * - 键封闭与特征字符规则在此重述了一份，落地后应与 `LorebookMappingTemplateDsl`
 *   合并成一处（谁先定稿谁为准），否则会出现在「落库校验通过、导入执行拒绝」的裂缝。
 */

/** `LorebookMappingFieldPaths`。 */
data class LorebookMappingFieldPaths(
    /** 每条目的关键词字段：数组或逗号分隔字符串。 */
    val keys: String,
    val content: String,
    val title: String? = null,
    val secondaryKeys: String? = null,
    val enabled: String? = null,
    val order: String? = null,
    val probability: String? = null,
    val constant: String? = null,
    val useRegex: String? = null,
) {
    /** 按名字取字段路径（PC 的 `template.fields[name]` 索引访问）。 */
    fun valueOf(name: String): String? = when (name) {
        "keys" -> keys
        "content" -> content
        "title" -> title
        "secondaryKeys" -> secondaryKeys
        "enabled" -> enabled
        "order" -> order
        "probability" -> probability
        "constant" -> constant
        "useRegex" -> useRegex
        else -> null
    }

    /** 全部已配置的路径（算「哪些源键已被消费」时用）。 */
    fun allPaths(): List<String> = listOfNotNull(
        keys, content, title, secondaryKeys, enabled, order, probability, constant, useRegex,
    )

    fun toJsonMap(): Map<String, Any?> = linkedMapOf<String, Any?>().apply {
        // 必须写全 `this@...`：在 `apply` 里裸写 `keys` 解析到的是**正在构造的那张 Map 的
        // keySet 视图**（`Map.keys`），不是字段路径。它是个活引用，序列化的时候已经变成
        // `["keys","content","title"]`，于是模板导入时 keys/namePath 全解析不出来、
        // 静默退化成兜底名与空关键词——正是「不静默改含义」要防的那类错。
        put("keys", this@LorebookMappingFieldPaths.keys)
        put("content", content)
        title?.let { put("title", it) }
        secondaryKeys?.let { put("secondaryKeys", it) }
        enabled?.let { put("enabled", it) }
        order?.let { put("order", it) }
        probability?.let { put("probability", it) }
        constant?.let { put("constant", it) }
        useRegex?.let { put("useRegex", it) }
    }
}

/** `LorebookMappingTemplate`。 */
data class LorebookMappingTemplate(
    val id: String,
    val name: String,
    val createdAt: Double,
    val updatedAt: Double,
    /** 条目数组的 JSON 路径（如 `entries`、`data.book.entries`）；留空表示顶层就是数组。 */
    val entriesPath: String,
    /** 书名字段路径；留空时读取顶层 name，仍没有则用导入文件名兜底。 */
    val namePath: String? = null,
    val fields: LorebookMappingFieldPaths,
) {
    fun toJsonMap(): Map<String, Any?> = linkedMapOf<String, Any?>().apply {
        put("id", id)
        put("name", name)
        put("createdAt", createdAt)
        put("updatedAt", updatedAt)
        put("entriesPath", entriesPath)
        namePath?.let { put("namePath", it) }
        put("fields", fields.toJsonMap())
    }

    fun toJson(): String = LorebookJson.stringify(toJsonMap())
}

/** `LorebookMappingSeverity`。 */
enum class LorebookMappingSeverity(val jsonValue: String) {
    INFO("info"),
    WARNING("warning"),
    ERROR("error"),
}

/** `LorebookMappingAction`（映射向导没有 `approximated` 这一档）。 */
enum class LorebookMappingAction(val jsonValue: String) {
    MAPPED("mapped"),
    PRESERVED("preserved"),
    DROPPED("dropped"),
    REJECTED("rejected"),
}

/** `LorebookMappingIssue`。 */
data class LorebookMappingIssue(
    val severity: LorebookMappingSeverity,
    val action: LorebookMappingAction,
    val code: String,
    val path: String,
    val message: String,
)

/** `LorebookMappingImportResult.summary`。 */
data class LorebookMappingSummary(
    val mapped: Int = 0,
    val preserved: Int = 0,
    val approximated: Int = 0,
    val dropped: Int = 0,
    val rejected: Int = 0,
    val warnings: Int = 0,
    val errors: Int = 0,
)

/** `LorebookMappingImportResult`。 */
data class LorebookMappingImportResult(
    val document: CanonicalLorebook,
    val issues: List<LorebookMappingIssue>,
    val summary: LorebookMappingSummary,
)

/** 模板解析、校验、猜测与应用。 */
object LorebookMappingTemplates {

    private const val FOREIGN_NAMESPACE = "qingyu.mapping"

    /** 模板体积上限（解析前）：与节点式校验器同一量级，防止超大文件先进了解析器。 */
    private const val MAX_TEMPLATE_BYTES = 256 * 1024

    /** 嵌套深度上限（解析前）：防止深度嵌套 JSON 在解析阶段就打爆栈。 */
    private const val MAX_TEMPLATE_DEPTH = 32

    private val FIELD_PATH_KEYS = setOf(
        "keys", "content", "title", "secondaryKeys", "enabled", "order",
        "probability", "constant", "useRegex",
    )

    private val TEMPLATE_KEYS = setOf(
        "id", "name", "createdAt", "updatedAt", "entriesPath", "namePath", "fields",
    )

    /** 可执行内容特征字符：函数调用、语句分隔、模板插值都用得到它们。 */
    private const val FORBIDDEN_CHARS = "();`$"

    private val KEY_SEPARATOR = Regex("[,，\\n]+")

    /** `namePath` 缺省时的书名候选，按顺序取第一个非空字符串。顺序即口径，不要随手调整。 */
    private val DEFAULT_BOOK_NAME_PATHS = listOf("name", "title")

    // ---------------------------------------------------------------- 解析与校验

    /**
     * 校验并解析模板 JSON 文本。
     *
     * @throws IllegalArgumentException 体积/深度/键封闭/路径非法，消息点名 offending 键
     */
    fun requireTemplate(text: String): LorebookMappingTemplate {
        val bytes = text.toByteArray(Charsets.UTF_8).size
        require(bytes <= MAX_TEMPLATE_BYTES) { "映射模板 $bytes 字节超过上限 $MAX_TEMPLATE_BYTES 字节" }
        require(rawNestingDepth(text) <= MAX_TEMPLATE_DEPTH) { "映射模板嵌套深度超过上限 $MAX_TEMPLATE_DEPTH" }
        val root = LorebookJson.record(LorebookJson.parse(text))
            ?: throw IllegalArgumentException("映射模板必须是 JSON 对象")
        return requireTemplate(root)
    }

    fun requireTemplate(root: Map<String, Any?>): LorebookMappingTemplate {
        root.forEach { (key, _) ->
            require(TEMPLATE_KEYS.contains(key)) { "映射模板含未知键: '$key'" }
        }
        val id = LorebookJson.string(root["id"]).orEmpty()
        val name = LorebookJson.string(root["name"]).orEmpty()
        val entriesPath = LorebookJson.string(root["entriesPath"])
        val fieldsMap = LorebookJson.record(root["fields"])
        require(id.isNotEmpty()) { "映射模板缺少非空 'id'" }
        require(name.trim().isNotEmpty()) { "映射模板缺少非空 'name'" }
        requireNotNull(entriesPath) { "映射模板缺少字符串 'entriesPath'" }
        requireNotNull(fieldsMap) { "映射模板缺少对象 'fields'" }
        fieldsMap.forEach { (key, _) ->
            require(FIELD_PATH_KEYS.contains(key)) { "映射模板 fields 含未知键: '$key'" }
        }
        requireSafeText(entriesPath, "entriesPath")
        requirePath(entriesPath, "entriesPath")
        LorebookJson.string(root["namePath"])?.let { namePath ->
            requireSafeText(namePath, "namePath")
            requirePath(namePath, "namePath")
        }

        fun fieldPath(key: String, requiredField: Boolean): String? {
            val raw = fieldsMap[key]
            if (raw == null && !fieldsMap.containsKey(key)) {
                require(!requiredField) { "映射模板 fields 缺少 '$key'" }
                return null
            }
            require(raw is String) { "映射模板 fields.$key 必须是字符串，实际 ${raw?.let{i->i::class.simpleName} ?: null}：$raw" }
            requireSafeText(raw, "fields.$key")
            requirePath(raw, "fields.$key")
            if (requiredField) require(raw.trim().isNotEmpty()) { "映射模板 fields.$key 不能为空" }
            return raw
        }

        val keys = fieldPath("keys", true)
        val content = fieldPath("content", true)
        return LorebookMappingTemplate(
            id = id,
            name = name,
            createdAt = LorebookJson.number(root["createdAt"]) ?: 0.0,
            updatedAt = LorebookJson.number(root["updatedAt"]) ?: 0.0,
            entriesPath = entriesPath,
            namePath = LorebookJson.string(root["namePath"]),
            fields = LorebookMappingFieldPaths(
                keys = requireNotNull(keys),
                content = requireNotNull(content),
                title = fieldPath("title", false),
                secondaryKeys = fieldPath("secondaryKeys", false),
                enabled = fieldPath("enabled", false),
                order = fieldPath("order", false),
                probability = fieldPath("probability", false),
                constant = fieldPath("constant", false),
                useRegex = fieldPath("useRegex", false),
            ),
        )
    }

    /** `isMappingTemplate`：宽松判定（不抛异常），用于「这是不是一个模板」的分支。 */
    fun isMappingTemplate(value: Any?): Boolean {
        val template = LorebookJson.record(value) ?: return false
        val fields = LorebookJson.record(template["fields"]) ?: return false
        return LorebookJson.string(template["id"])?.isNotEmpty() == true &&
            LorebookJson.string(template["name"])?.trim()?.isNotEmpty() == true &&
            template["entriesPath"] is String &&
            LorebookJson.string(fields["keys"])?.trim()?.isNotEmpty() == true &&
            LorebookJson.string(fields["content"])?.trim()?.isNotEmpty() == true
    }

    /**
     * 节点式 DSL（`{mappings:[{target,source}]}`）→ 点分路径模板。
     *
     * 只接受**无损**折叠：每条 `source`/`target` 都必须是 `field` 节点的线性链，
     * 且 target 落在受支持的 9 个字段之一（`entries` 表示条目数组）。
     * 出现 `index`/`const` 就抛错——静默丢掉一条映射比拒绝更糟，用户会以为模板生效了。
     */
    fun fromDslJson(text: String): LorebookMappingTemplate {
        val root = LorebookJson.record(LorebookJson.parse(text))
            ?: throw IllegalArgumentException("映射模板必须是 JSON 对象")
        val mappings = LorebookJson.list(root["mappings"])
            ?: throw IllegalArgumentException("映射模板缺少数组 'mappings'")
        var entriesPath: String? = null
        val paths = LinkedHashMap<String, String>()
        mappings.forEachIndexed { index, item ->
            val mapping = LorebookJson.record(item)
                ?: throw IllegalArgumentException("映射模板 mappings[$index] 必须是对象")
            val target = dslFieldChain(mapping["target"])
                ?: throw IllegalArgumentException("映射模板 mappings[$index].target 不是纯 field 链，无法折叠")
            val source = dslFieldChain(mapping["source"])
                ?: throw IllegalArgumentException("映射模板 mappings[$index].source 不是纯 field 链，无法折叠")
            if (target == "entries") {
                entriesPath = source
            } else {
                require(FIELD_PATH_KEYS.contains(target)) { "映射模板 target '$target' 不在受支持字段内" }
                paths[target] = source
            }
        }
        return requireTemplate(
            linkedMapOf(
                "id" to (LorebookJson.string(root["id"]) ?: "dsl-${LorebookJson.string(root["sourceFormat"]) ?: "template"}"),
                "name" to (LorebookJson.string(root["name"]) ?: "导入模板"),
                "createdAt" to 0.0,
                "updatedAt" to 0.0,
                "entriesPath" to (entriesPath ?: ""),
                "fields" to LinkedHashMap(paths),
            ),
        )
    }

    /**
     * `{kind:'field', name, of:<上一节点>}` 的链 → 点分路径。
     * 任何非 `field` 节点（`index`/`const`）或形状不符都返回 null，交给调用方拒绝。
     */
    private fun dslFieldChain(node: Any?): String? {
        val segments = mutableListOf<String>()
        var current: Any? = node
        while (true) {
            val record = LorebookJson.record(current) ?: return null
            when (LorebookJson.string(record["kind"])) {
                "field" -> {
                    val name = LorebookJson.string(record["name"]) ?: return null
                    try {
                        requireSafeText(name, "field.name")
                        requirePath(name, "field.name")
                    } catch (error: IllegalArgumentException) {
                        return null
                    }
                    segments.add(0, name)
                    if (!record.containsKey("of")) return segments.joinToString(".")
                    current = record["of"]
                }
                else -> return null
            }
        }
    }

    // ---------------------------------------------------------------- 路径解析

    /**
     * `resolveMappingPath`：按点分路径读取值；危险键、空段与类型不符都得到 null。
     *
     * 留空路径表示根节点本身（PC 同规则，所以 `entriesPath: ""` 就是「顶层即数组」）。
     */
    fun resolvePath(root: Any?, path: String): Any? {
        if (path.trim().isEmpty()) return root
        var current: Any? = root
        for (segment in path.split('.')) {
            if (segment.isEmpty() || LorebookJson.DANGEROUS_KEYS.contains(segment)) return null
            val record = LorebookJson.record(current) ?: return null
            if (!record.containsKey(segment)) return null
            current = record[segment]
        }
        return current
    }

    /** 与 [resolvePath] 同一条遍历，但区分「键不存在」与「值是 null」（PC 判 `!== undefined`）。 */
    fun hasPath(root: Any?, path: String): Boolean {
        if (path.trim().isEmpty()) return true
        var current: Any? = root
        for (segment in path.split('.')) {
            if (segment.isEmpty() || LorebookJson.DANGEROUS_KEYS.contains(segment)) return false
            val record = LorebookJson.record(current) ?: return false
            if (!record.containsKey(segment)) return false
            current = record[segment]
        }
        return true
    }

    private val commonEntryContainers = listOf("entries", "data.entries", "data.book.entries", "book.entries")
    private val commonKeyFields = listOf("keys", "key", "keywords", "keyPrimary", "keys_primary")
    private val commonContentFields = listOf("content", "text", "entry", "value")
    private val commonTitleFields = listOf("comment", "name", "displayName", "displayname", "title")

    /**
     * `guessMappingTemplate`：从导入样本猜测受限映射模板
     * （仅猜测常见形状；用户可在向导中修改后保存）。
     */
    fun guessMappingTemplate(
        sample: Any?,
        name: String = "猜测模板",
        now: Double = System.currentTimeMillis().toDouble(),
    ): LorebookMappingTemplate? {
        LorebookJson.list(sample)?.let { return guessFromArray(it, "", name, now) }
        val record = LorebookJson.record(sample) ?: return null
        for (container in commonEntryContainers) {
            val list = LorebookJson.list(resolvePath(record, container))
            if (list != null && list.isNotEmpty()) {
                guessFromArray(list, container, name, now)?.let { return it }
            }
        }
        return null
    }

    private fun guessFromArray(
        entries: List<Any?>,
        container: String,
        name: String,
        now: Double,
    ): LorebookMappingTemplate? {
        val candidate = entries.mapNotNull { LorebookJson.record(it) }.firstOrNull() ?: return null
        fun pick(options: List<String>): String? = options.firstOrNull { candidate.containsKey(it) }
        val keys = pick(commonKeyFields) ?: return null
        val content = pick(commonContentFields) ?: return null
        val title = pick(commonTitleFields)
        return LorebookMappingTemplate(
            id = "guess-${LorebookJson.jsNumberText(now)}",
            name = name,
            createdAt = now,
            updatedAt = now,
            entriesPath = container,
            fields = LorebookMappingFieldPaths(keys = keys, content = content, title = title),
        )
    }

    // ---------------------------------------------------------------- 应用模板导入

    /**
     * `importLorebookWithMappingTemplate`：条目数组 + 受限字段路径 → canonical v2。
     *
     * 模板未覆盖的条目字段原样保留在 `qingyu.mapping` 命名空间供诊断；
     * 按方案 §6.3，映射向导**不提供导出**。
     */
    @Suppress("LongMethod", "CyclomaticComplexity")
    fun importWithTemplate(
        raw: Any?,
        template: LorebookMappingTemplate,
        id: String? = null,
        fallbackName: String,
        now: Double = System.currentTimeMillis().toDouble(),
        contentHash: String? = null,
    ): LorebookMappingImportResult {
        val issues = mutableListOf<LorebookMappingIssue>()

        fun summarize(
            document: CanonicalLorebook,
            collected: List<LorebookMappingIssue>,
        ): LorebookMappingImportResult {
            fun count(action: LorebookMappingAction) = collected.count { it.action == action }
            return LorebookMappingImportResult(
                document = document,
                issues = collected,
                summary = LorebookMappingSummary(
                    mapped = count(LorebookMappingAction.MAPPED),
                    preserved = count(LorebookMappingAction.PRESERVED),
                    approximated = 0,
                    dropped = count(LorebookMappingAction.DROPPED),
                    rejected = count(LorebookMappingAction.REJECTED),
                    warnings = collected.count { it.severity == LorebookMappingSeverity.WARNING },
                    errors = collected.count { it.severity == LorebookMappingSeverity.ERROR },
                ),
            )
        }
        fun issue(
            severity: LorebookMappingSeverity,
            action: LorebookMappingAction,
            code: String,
            path: String,
            message: String,
        ) {
            issues += LorebookMappingIssue(severity, action, code, path, message)
        }
        fun reject(code: String, message: String): LorebookMappingImportResult {
            val rejected = listOf(
                LorebookMappingIssue(
                    LorebookMappingSeverity.ERROR, LorebookMappingAction.REJECTED,
                    code, template.entriesPath.ifEmpty { "$" }, message,
                ),
            )
            return summarize(
                rejectedDocument(id, fallbackName, template, now, contentHash),
                rejected,
            )
        }

        // 与 registry 导入同一条安全边界（方案 §15）
        try {
            LorebookLimits.assertImportJsonDepth(raw)
        } catch (error: IllegalStateException) {
            val rejected = listOf(
                LorebookMappingIssue(
                    LorebookMappingSeverity.ERROR, LorebookMappingAction.REJECTED,
                    "json_depth_exceeded", "$", error.message.orEmpty(),
                ),
            )
            return summarize(rejectedDocument(id, fallbackName, template, now, contentHash), rejected)
        }

        val entriesPath = template.entriesPath
        val entriesValue = LorebookJson.list(resolvePath(raw, entriesPath))
            ?: return reject("mapping_entries_not_found", "条目数组路径未指向数组，无法导入")
        val rawEntries = entriesValue.mapNotNull { LorebookJson.record(it) }
        if (rawEntries.size < entriesValue.size) {
            issue(
                LorebookMappingSeverity.ERROR, LorebookMappingAction.REJECTED, "mapping_invalid_entries",
                entriesPath.ifEmpty { "$" },
                "${entriesValue.size - rawEntries.size} 个条目不是对象，无法导入",
            )
        }
        if (rawEntries.isEmpty()) {
            issue(
                LorebookMappingSeverity.ERROR, LorebookMappingAction.REJECTED, "mapping_empty_entries",
                entriesPath.ifEmpty { "$" }, "没有可导入的世界书条目",
            )
        }

        // consumed 只看路径首段：条目对象上与任一被映射路径同名的键都不再进保留区
        val consumed = template.fields.allPaths()
            .filter { it.isNotEmpty() }
            .map { it.split('.').first() }
            .toSet()
        // 书名：显式 `namePath` 优先；没写时按**固定顺序**试 `name` → `title`。
        // 只试 `name` 的旧写法会让「书名放在 title」的第三方格式静默退化成兜底名：
        // 用户导入完看到一本叫「兜底名」的书，而系统一个字都没提示，正是方案 §2 禁止的静默改含义。
        var bookName: String? = null
        for (path in listOfNotNull(template.namePath) + DEFAULT_BOOK_NAME_PATHS) {
            val candidate = resolvePath(raw, path) as? String
            if (!candidate.isNullOrBlank()) {
                bookName = candidate
                break
            }
        }

        val payloadEntries = rawEntries.mapIndexed { index, entry ->
            // 名字必须是 `entryKeys` 而不是 `keys`：下面在 `linkedMapOf(...).apply { }` 里，
            // 裸写 `keys` 会绑到**接收者那张 Map 的 keySet**（隐式接收者比外层局部变量更近），
            // 于是每条目的关键词被写成 `["keys","content",…]` 这种垃圾词——
            // 表面现象是「导入的世界书一条都触发不了」，而且不报错。
            val entryKeys = mappingStringList(resolvePath(entry, template.fields.keys))
            val content = resolvePath(entry, template.fields.content)
            val secondary = template.fields.secondaryKeys
                ?.let { mappingStringList(resolvePath(entry, it)) }
                ?: emptyList()
            for (name in listOf(
                "keys", "content", "secondaryKeys", "title", "enabled", "order",
                "probability", "constant", "useRegex",
            )) {
                val sourcePath = template.fields.valueOf(name) ?: continue
                if (hasPath(entry, sourcePath)) {
                    issue(
                        LorebookMappingSeverity.INFO, LorebookMappingAction.MAPPED, "mapping_field",
                        "$.entries[$index].$sourcePath", "字段 $name 已按模板映射",
                    )
                } else {
                    issue(
                        LorebookMappingSeverity.WARNING, LorebookMappingAction.DROPPED, "mapping_field_missing",
                        "$.entries[$index].$sourcePath", "模板字段 $name（$sourcePath）在该条目上不存在",
                    )
                }
            }
            val probability = template.fields.probability
                ?.let { LorebookJson.number(resolvePath(entry, it)) }
            val foreignSource = LinkedHashMap<String, Any?>()
            entry.forEach { (key, value) ->
                if (consumed.contains(key) || LorebookJson.DANGEROUS_KEYS.contains(key)) return@forEach
                if (value == null || LorebookJson.isPersistable(value)) {
                    foreignSource[key] = LorebookJson.toJsonValue(value)
                }
            }
            if (foreignSource.isNotEmpty()) {
                issue(
                    LorebookMappingSeverity.INFO, LorebookMappingAction.PRESERVED, "mapping_unknown_field",
                    "$.entries[$index]",
                    "${foreignSource.size} 个未映射字段已保留在 $FOREIGN_NAMESPACE 命名空间",
                )
            }
            val titleValue = template.fields.title?.let { resolvePath(entry, it) } as? String
            val enabledValue = template.fields.enabled?.let { LorebookJson.boolean(resolvePath(entry, it)) }
            val constantValue = template.fields.constant?.let { LorebookJson.boolean(resolvePath(entry, it)) }
            val useRegexValue = template.fields.useRegex?.let { LorebookJson.boolean(resolvePath(entry, it)) }
            val orderValue = template.fields.order?.let { LorebookJson.number(resolvePath(entry, it)) }
            MappingPayloadEntry(
                values = linkedMapOf<String, Any?>().apply {
                    put("keys", entryKeys)
                    put("content", content as? String ?: "")
                    if (secondary.isNotEmpty()) put("secondaryKeywords", secondary)
                    // 归一化器不读标题字段；迁移后在 canonical 上回填
                    if (!titleValue.isNullOrEmpty()) put("entryTitle", titleValue)
                    if (enabledValue == false) put("disable", true)
                    orderValue?.let { put("insertion_order", it) }
                    if (probability != null) {
                        put("probability", probability)
                        put("useProbability", probability < 100.0)
                    }
                    if (constantValue == true) put("constant", true)
                    if (useRegexValue == true) put("useRegex", true)
                },
                title = titleValue?.takeIf { it.isNotEmpty() },
                foreignSource = foreignSource.takeIf { it.isNotEmpty() },
            )
        }

        val normalized = LorebookNativeV1.normalize(
            linkedMapOf<String, Any?>().apply {
                if (bookName != null && bookName.trim().isNotEmpty()) put("name", bookName)
                put("entries", payloadEntries.map { it.values })
            },
            LorebookNativeV1.NormalizeOptions(
                id = id,
                fallbackName = fallbackName,
                sourceKind = LorebookNativeV1.SourceKind.CHARACTER_BOOK,
            ),
        )
        val migrated = LorebookNativeMigration.migrateV1ToV2(
            normalized,
            LorebookNativeMigration.Options(now = now, contentHash = contentHash ?: "mapping-template"),
        )
        val withForeign = migrated.entries.mapIndexed { index, entry ->
            val source = payloadEntries.getOrNull(index)
            var next = entry
            source?.title?.let { next = next.copy(title = it) }
            source?.foreignSource?.let { foreign ->
                val merged = LinkedHashMap<String, Any?>()
                next.foreign?.let { merged.putAll(it) }
                merged[FOREIGN_NAMESPACE] = linkedMapOf("source" to foreign)
                next = next.copy(foreign = merged)
            }
            next
        }
        val document = migrated.copy(
            entries = withForeign,
            source = (migrated.source ?: LorebookSourceMetadata()).copy(
                adapterId = "mapping.${template.id}",
                formatVersion = "template",
                originalName = migrated.name,
                importedAt = migrated.createdAt,
                contentHash = contentHash ?: "mapping-template",
            ),
        )
        // 导入产物统一执行条目数/正文长度/foreign 保留区/正则上限
        val limitOutcome = LorebookLimits.enforceImportDocumentLimits(document)
        // PC 在这里把 approximated 折叠成 dropped：映射向导没有「近似」这一档。
        val limitIssues = limitOutcome.issues.map {
            LorebookMappingIssue(
                LorebookMappingSeverity.valueOf(it.severity.name),
                if (it.action == LorebookCompatibilityAction.APPROXIMATED) {
                    LorebookMappingAction.DROPPED
                } else {
                    LorebookMappingAction.valueOf(it.action.name)
                },
                it.code,
                it.path,
                it.message,
            )
        }
        return summarize(limitOutcome.document, issues + limitIssues)
    }

    private data class MappingPayloadEntry(
        val values: Map<String, Any?>,
        val title: String?,
        val foreignSource: Map<String, Any?>?,
    )

    private fun rejectedDocument(
        id: String?,
        fallbackName: String,
        template: LorebookMappingTemplate,
        now: Double,
        contentHash: String?,
    ): CanonicalLorebook = CanonicalLorebook(
        id = id ?: "mapping-rejected",
        name = fallbackName,
        description = "",
        enabled = true,
        defaults = LorebookDefaults(scanDepth = 4.0, recursiveScanning = true),
        entries = emptyList(),
        source = LorebookSourceMetadata(
            adapterId = "mapping.${template.id}",
            formatVersion = "template",
            importedAt = now,
            contentHash = contentHash ?: "mapping-template",
        ),
        createdAt = now,
        updatedAt = now,
    )

    /** `stringListValue`：数组或 `,`/`，`/换行 分隔的字符串。 */
    private fun mappingStringList(value: Any?): List<String> {
        LorebookJson.list(value)?.let { items ->
            return items.filterIsInstance<String>().map { it.trim() }.filter { it.isNotEmpty() }
        }
        val text = value as? String ?: return emptyList()
        return text.split(KEY_SEPARATOR).map { it.trim() }.filter { it.isNotEmpty() }
    }

    // ---------------------------------------------------------------- DSL 守卫

    private fun requireSafeText(text: String, where: String) {
        val offending = text.firstOrNull { FORBIDDEN_CHARS.contains(it) }
        require(offending == null) {
            "映射模板 $where 含可执行内容特征字符 '$offending'，已拒绝"
        }
    }

    private fun requirePath(path: String, where: String) {
        if (path.isEmpty()) return
        for (segment in path.split('.')) {
            require(segment.isNotEmpty()) { "$where 存在空路径段: '$path'" }
            require(!LorebookJson.DANGEROUS_KEYS.contains(segment)) {
                "映射模板 $where 的字段路径含危险键: '$segment'"
            }
        }
    }

    /** 解析前的粗粒度嵌套深度（忽略字符串内的括号），防止深度嵌套在解析阶段就打爆栈。 */
    private fun rawNestingDepth(text: String): Int {
        var depth = 0
        var max = 0
        var inString = false
        var escaped = false
        for (ch in text) {
            if (inString) {
                when {
                    escaped -> escaped = false
                    ch == '\\' -> escaped = true
                    ch == '"' -> inString = false
                }
                continue
            }
            when (ch) {
                '"' -> inString = true
                '{', '[' -> {
                    depth++
                    if (depth > max) max = depth
                }
                '}', ']' -> depth--
            }
        }
        return max
    }
}
