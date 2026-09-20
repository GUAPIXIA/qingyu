package com.qingyu.companion.content.lorebook.formats

import com.qingyu.companion.content.lorebook.CanonicalLoreEntry
import com.qingyu.companion.content.lorebook.CanonicalLorebook
import com.qingyu.companion.content.lorebook.LorebookAdapterExportResult
import com.qingyu.companion.content.lorebook.LorebookAdapterImportResult
import com.qingyu.companion.content.lorebook.LorebookCompatibilityAction
import com.qingyu.companion.content.lorebook.LorebookCompatibilityIssue
import com.qingyu.companion.content.lorebook.LorebookCompatibilityReport
import com.qingyu.companion.content.lorebook.LorebookCompatibilitySeverity
import com.qingyu.companion.content.lorebook.LorebookDetectionResult
import com.qingyu.companion.content.lorebook.LorebookExternalFormat
import com.qingyu.companion.content.lorebook.LorebookFileMetadata
import com.qingyu.companion.content.lorebook.LorebookFormatAdapter
import com.qingyu.companion.content.lorebook.LorebookImportContext
import com.qingyu.companion.content.lorebook.LorebookJson
import com.qingyu.companion.content.lorebook.LorebookNativeV1

/**
 * 阶段 5 S5-02：Risu Lorebook
 * （`electron/services/lorebookAdapters/risu.ts`）。
 *
 * 独立 Risu 文件是 `{ type:'risu', ver:1, data: 条目数组 }`，也兼容 `data` 为
 * `{ entries }` 的变体。三个必须保住的语义：
 * 1. `mode: 'multiple'` = 全部关键词命中才触发 → canonical `keyLogic = 'all'`，
 *    这是 Risu 唯一无法用载荷字段表达、要在迁移后回填的概念；
 * 2. `extentions`（Risu 的拼写如此，**不能**改成 extensions）整体**不**标为已消费，
 *    于是除 `risu_case_sensitive` 之外的内容原样留在保留区，导出时贴回；
 * 3. 顶层除 `type`/`ver`/`data` 之外的键进 `foreign[…].wrapper`，导出时贴回顶层，
 *    `ver` 保持导入时的数值。
 */
object LorebookRisuFormat : LorebookFormatAdapter {

    const val ID = "risu.lorebook"
    const val LABEL = "Risu Lorebook"
    const val VERSION = "1"

    internal val CONFIG = LorebookExternalFormat.Config(
        id = ID,
        label = LABEL,
        version = VERSION,
        sourceKind = LorebookNativeV1.SourceKind.SILLY_TAVERN,
        style = LorebookExternalFormat.Style.SILLYTAVERN,
    )

    /**
     * Risu 条目中被本 adapter 消费的字段（在 ENTRY_KEYS 之外）。
     * extentions 整体不标为已消费：其中除 risu_case_sensitive 外的字段仍需原样保留。
     */
    private val CONSUMED_ENTRY_KEYS =
        LorebookExternalFormat.consumedKeys(listOf("secondkey", "insertorder", "mode", "alwaysActive", "activationPercent"))

    private val WRAPPER_KEYS = setOf("type", "ver", "data")

    override val id: String get() = ID
    override val label: String get() = LABEL
    override val formatVersion: String get() = VERSION
    override val priority: Int get() = 50

    /** 独立 Risu 世界书是 `{ type:'risu', ver:1, data: 条目数组 }`；兼容 data 为 `{ entries }` 的变体。 */
    private fun resolveEntries(input: Map<String, Any?>): List<Map<String, Any?>>? {
        val data = input["data"]
        LorebookJson.list(data)?.let { return it.mapNotNull { item -> LorebookJson.record(item) } }
        val record = LorebookJson.record(data)
        if (record != null) {
            val entries = LorebookJson.list(record["entries"])
            if (entries != null) return entries.mapNotNull { LorebookJson.record(it) }
        }
        return null
    }

    private fun wrapperExtras(input: Map<String, Any?>): LinkedHashMap<String, Any?> {
        val wrapper = LinkedHashMap<String, Any?>()
        input.forEach { (key, value) ->
            if (WRAPPER_KEYS.contains(key)) return@forEach
            if (value == null || LorebookJson.isPersistable(value)) wrapper[key] = LorebookJson.toJsonValue(value)
        }
        return wrapper
    }

    /** Risu 条目 → 归一化器可读的载荷字段；原始字段保留在对象上以便进入 foreign 保留区。 */
    private fun toPayloadEntry(entry: Map<String, Any?>): Map<String, Any?> {
        val activationPercent = entry["activationPercent"]
        val alwaysActive = entry["alwaysActive"] == true || entry["mode"] == "constant"
        val extensions = LorebookJson.record(entry["extentions"])
        val out = LinkedHashMap<String, Any?>(entry)
        out["keysecondary"] = entry["secondkey"] ?: ""
        out["insertion_order"] = entry["insertorder"] ?: 0
        out["constant"] = alwaysActive
        out["probability"] = activationPercent
        out["useProbability"] = activationPercent != null &&
            (LorebookJson.number(activationPercent) ?: 100.0) < 100.0
        out["caseSensitive"] = extensions?.get("risu_case_sensitive") == true
        return out
    }

    override fun detect(input: Any?, file: LorebookFileMetadata?): LorebookDetectionResult {
        val record = LorebookJson.record(input)
            ?: return LorebookDetectionResult.mismatch(ID, LABEL, VERSION)
        if (record["type"] == "risu" && resolveEntries(record) != null) {
            return LorebookDetectionResult(
                ID, LABEL, VERSION, 98,
                listOf("顶层 type=risu 且 data 为 Risu 条目数组"), emptyList(),
            )
        }
        val bare = LorebookJson.list(record["data"]).orEmpty().mapNotNull { LorebookJson.record(it) }
        if (bare.any { it.containsKey("secondkey") && it.containsKey("insertorder") }) {
            return LorebookDetectionResult(
                ID, LABEL, VERSION, 82,
                listOf("条目包含 Risu 特有的 secondkey/insertorder 字段"), emptyList(),
            )
        }
        return LorebookDetectionResult.mismatch(ID, LABEL, VERSION)
    }

    override fun importLorebook(
        input: Any?,
        context: LorebookImportContext,
    ): LorebookAdapterImportResult {
        val record = LorebookJson.record(input) ?: error("Risu Lorebook 顶层必须是对象")
        // `resolveEntries` 就是 PC 的那一行 `data.filter(isRecord)`：非对象条目在这里已经被滤掉，
        // 所以统一导入器数到的「源条目数」与「有效条目数」相等，`invalid_entries`
        // （"N 个条目不是对象，无法导入"）对 Risu 永不触发，只剩 `empty_entries`
        // （"没有可导入的世界书条目"）。曾经把未过滤的原始数组喂进 payload，
        // 于是同一份坏文件在两端得到两条不同的拒绝文案
        // （阶段 0 的 `risu/invalid.json`：PC 报「没有可导入的世界书条目」，
        // Android 报「2 个条目不是对象，无法导入」）。
        // 语义上是 PC 自己不一致：`risu.ts:105` 的 `isRecord(entry) ? toPayloadEntry(entry) : entry`
        // 里 `: entry` 分支在预过滤之后是死代码，作者的本来意图正是「不做预过滤」，
        // 而 `novelai`/`agnai` 两个适配器也确实那么做。这里先按 oracle（PC）对齐、
        // 把 PC 侧的这处不一致记进阶段报告，等 PC 单独评审要哪种文案，两端一起改。
        val entries = resolveEntries(record) ?: emptyList()
        val wrapper = wrapperExtras(record)
        val payload = linkedMapOf<String, Any?>(
            "entries" to entries.map { entry -> toPayloadEntry(entry) },
        )
        val result = LorebookExternalFormat.importExternalLorebook(
            payload,
            context,
            CONFIG.copy(consumedEntryKeys = CONSUMED_ENTRY_KEYS),
            wrapper.takeIf { it.isNotEmpty() },
        )
        // Risu mode=multiple 表示全部关键词命中才触发；canonical 以 keyLogic='all' 保留原意
        val multipleModes = entries.map { it["mode"] }
        result.document = result.document.copy(
            entries = result.document.entries.mapIndexed { index, entry ->
                if (multipleModes.getOrNull(index) == "multiple") {
                    entry.copy(activation = entry.activation.copy(keyLogic = "all"))
                } else {
                    entry
                }
            },
        )
        return result
    }

    override fun exportLorebook(document: CanonicalLorebook): LorebookAdapterExportResult {
        val storedBook = LorebookExternalFormat.foreignSection(document.foreign, ID)
        val wrapper = LorebookExternalFormat.wrapperForeign(document, ID)
        val preservedCount = LorebookExternalFormat.countPreserved(document, ID)
        val approximated = document.entries.count {
            it.insertion.kind != "prompt" || it.insertion.anchor != "prompt_end"
        }
        val issues = listOfNotNull(
            if (preservedCount > 0) {
                LorebookCompatibilityIssue.of(
                    LorebookCompatibilitySeverity.INFO, LorebookCompatibilityAction.PRESERVED,
                    "foreign_exported", "$", "$preservedCount 个未知字段已合并回导出格式",
                )
            } else {
                null
            },
            if (approximated > 0) {
                LorebookCompatibilityIssue.of(
                    LorebookCompatibilitySeverity.WARNING, LorebookCompatibilityAction.APPROXIMATED,
                    "risu_insertion_unsupported", "$.entries",
                    "Risu Lorebook 没有条目级插入位置；$approximated 个条目的位置设置无法表达，已省略",
                )
            } else {
                null
            },
        )
        val value = LinkedHashMap<String, Any?>()
        value.putAll(storedBook.first)
        value.putAll(wrapper)
        value["type"] = "risu"
        value["ver"] = LorebookJson.number(wrapper["ver"]) ?: 1.0
        value["data"] = document.entries.map { risuExportEntry(it) }
        return LorebookAdapterExportResult(
            value = value,
            report = LorebookCompatibilityReport.create(ID, LABEL, VERSION, issues),
        )
    }

    private fun risuExportEntry(entry: CanonicalLoreEntry): Map<String, Any?> {
        val stored = LorebookExternalFormat.foreignSection(entry.foreign, ID)
        val constant = entry.activation.mode == "constant"
        val multiple = entry.activation.keyLogic == "all"
        val originalMode = LorebookJson.string(stored.first["mode"])
        // 由 canonical 重建的字段拥有最高优先级；其余未知字段作为底稿保留
        val rebuilt = setOf(
            "comment", "key", "secondkey", "content", "insertorder", "mode", "alwaysActive",
            "selective", "activationPercent", "useRegex", "id",
        )
        val out = LinkedHashMap<String, Any?>()
        stored.first.forEach { (key, value) -> if (!rebuilt.contains(key)) out[key] = value }
        entry.sourceId?.let { out["id"] = it }
        out["comment"] = entry.title ?: ""
        out["key"] = (entry.activation.primaryKeys + entry.activation.aliases).joinToString(", ")
        out["secondkey"] = entry.activation.secondaryKeys.joinToString(", ")
        out["content"] = entry.content
        out["insertorder"] = entry.scheduling.order
        out["mode"] = when {
            multiple -> "multiple"
            constant -> "constant"
            else -> originalMode ?: "normal"
        }
        out["alwaysActive"] = constant
        out["selective"] = entry.activation.secondaryKeys.isNotEmpty()
        if (entry.scheduling.probability != 100.0) out["activationPercent"] = entry.scheduling.probability
        out["useRegex"] = entry.activation.regex.enabled
        out["extentions"] = LinkedHashMap<String, Any?>().apply {
            LorebookJson.record(stored.first["extentions"])?.let { putAll(it) }
            put("risu_case_sensitive", entry.activation.caseSensitive)
        }
        return out
    }
}
