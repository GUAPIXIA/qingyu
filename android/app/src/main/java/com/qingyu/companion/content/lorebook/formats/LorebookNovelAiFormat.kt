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
 * 阶段 5 S5-02：NovelAI Lorebook
 * （`electron/services/lorebookAdapters/novelai.ts`）。
 *
 * NovelAI 的正文在 `text`、二级关键词是**单个逗号分隔字符串** `secondKey`、
 * 常驻叫 `forceActivation`、顺序叫 `priority`。适配器把它们翻译成归一化器认识的
 * 载荷键，同时保留原始键，所以 `searchRange`、`category` 这类轻语没有对应概念的
 * 字段照旧进 `foreign`，导出时贴回去。
 *
 * `lorebookVersion` 不是 4 时只报一条 `mapped` 级告警并按 v4 字段尽力导入——
 * PC 明确不拒绝它，这里也不许拒绝（拒绝就是导入结果不一致）。
 */
object LorebookNovelAiFormat : LorebookFormatAdapter {

    const val ID = "novelai.lorebook"
    const val LABEL = "NovelAI Lorebook"
    const val VERSION = "4"

    internal val CONFIG = LorebookExternalFormat.Config(
        id = ID,
        label = LABEL,
        version = VERSION,
        sourceKind = LorebookNativeV1.SourceKind.CHARACTER_BOOK,
        style = LorebookExternalFormat.Style.CHARACTER_BOOK,
    )

    /** NovelAI 条目中被本 adapter 消费的字段（在 ENTRY_KEYS 之外）；其余（searchRange、category 等）原样保留。 */
    private val CONSUMED_ENTRY_KEYS =
        LorebookExternalFormat.consumedKeys(listOf("text", "secondKey", "forceActivation", "useRegExp"))

    private val WRAPPER_KEYS = setOf("entries")

    override val id: String get() = ID
    override val label: String get() = LABEL
    override val formatVersion: String get() = VERSION
    override val priority: Int get() = 50

    /** NovelAI 条目 → 归一化器可读的载荷字段；原始字段保留在对象上以便进入 foreign 保留区。 */
    private fun toPayloadEntry(entry: Map<String, Any?>): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>(entry)
        out["content"] = entry["text"]
        out["keysecondary"] = entry["secondKey"]
        out["constant"] = entry["forceActivation"] == true
        out["insertion_order"] = entry["priority"] ?: 0
        out["useRegex"] = entry["useRegExp"] as? Boolean
        return out
    }

    private fun wrapperExtras(input: Map<String, Any?>): LinkedHashMap<String, Any?> {
        val wrapper = LinkedHashMap<String, Any?>()
        input.forEach { (key, value) ->
            if (WRAPPER_KEYS.contains(key)) return@forEach
            if (value == null || LorebookJson.isPersistable(value)) wrapper[key] = LorebookJson.toJsonValue(value)
        }
        return wrapper
    }

    override fun detect(input: Any?, file: LorebookFileMetadata?): LorebookDetectionResult {
        val record = LorebookJson.record(input)
            ?: return LorebookDetectionResult.mismatch(ID, LABEL, VERSION)
        val version = LorebookJson.number(record["lorebookVersion"])
        if (version != null && record.containsKey("entries")) {
            return LorebookDetectionResult(
                ID, LABEL, VERSION,
                if (LorebookJson.list(record["entries"]) != null) 98 else 90,
                listOf("顶层 lorebookVersion 是 NovelAI Lorebook 的版本标记"), emptyList(),
            )
        }
        val entries = LorebookJson.list(record["entries"]).orEmpty().mapNotNull { LorebookJson.record(it) }
        if (entries.any { it.containsKey("text") && it.containsKey("forceActivation") }) {
            return LorebookDetectionResult(
                ID, LABEL, VERSION, 80,
                listOf("条目包含 NovelAI 特有的 text/forceActivation 字段"), emptyList(),
            )
        }
        return LorebookDetectionResult.mismatch(ID, LABEL, VERSION)
    }

    override fun importLorebook(
        input: Any?,
        context: LorebookImportContext,
    ): LorebookAdapterImportResult {
        val record = LorebookJson.record(input) ?: error("NovelAI Lorebook 顶层必须是对象")
        // 不做预过滤：非对象条目交给统一导入器计数并生成结构化拒绝报告
        val rawEntries = LorebookJson.list(record["entries"]) ?: emptyList()
        val wrapper = wrapperExtras(record)
        val payload = linkedMapOf<String, Any?>(
            "entries" to rawEntries.map { entry ->
                val asRecord = LorebookJson.record(entry)
                if (asRecord != null) toPayloadEntry(asRecord) else entry
            },
        )
        val result = LorebookExternalFormat.importExternalLorebook(
            payload,
            context,
            CONFIG.copy(consumedEntryKeys = CONSUMED_ENTRY_KEYS),
            wrapper.takeIf { it.isNotEmpty() },
        )
        val version = LorebookJson.number(record["lorebookVersion"])
        if (version != null && version != 4.0) {
            result.report = LorebookCompatibilityReport.create(
                ID, LABEL, VERSION,
                result.report.issues + LorebookCompatibilityIssue.of(
                    LorebookCompatibilitySeverity.WARNING, LorebookCompatibilityAction.MAPPED,
                    "novelai_version_mismatch", "$.lorebookVersion",
                    "NovelAI lorebookVersion=${LorebookJson.jsNumberText(version)} 未在本适配器验证范围内（4），按 v4 字段尽力导入",
                ),
            )
        }
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
                    "novelai_insertion_unsupported", "$.entries",
                    "NovelAI Lorebook 通过记忆区插入正文，没有条目级提示词位置；" +
                        "$approximated 个条目的位置设置无法表达，已省略",
                )
            } else {
                null
            },
        )
        val value = LinkedHashMap<String, Any?>()
        value.putAll(storedBook.first)
        value.putAll(wrapper)
        value["lorebookVersion"] = LorebookJson.number(wrapper["lorebookVersion"]) ?: 4.0
        value["entries"] = document.entries.map { novelAiExportEntry(it) }
        return LorebookAdapterExportResult(
            value = value,
            report = LorebookCompatibilityReport.create(ID, LABEL, VERSION, issues),
        )
    }

    private fun novelAiExportEntry(entry: CanonicalLoreEntry): Map<String, Any?> {
        val stored = LorebookExternalFormat.foreignSection(entry.foreign, ID)
        // 由 canonical 重建的字段拥有最高优先级；其余未知字段作为底稿保留
        val rebuilt = setOf(
            "id", "text", "keys", "secondKey", "comment", "enabled", "forceActivation",
            "vectorized", "caseSensitive", "useProbability", "probability", "priority", "useRegExp",
        )
        val out = LinkedHashMap<String, Any?>()
        stored.first.forEach { (key, value) -> if (!rebuilt.contains(key)) out[key] = value }
        entry.sourceId?.let { out["id"] = it }
        out["text"] = entry.content
        out["keys"] = entry.activation.primaryKeys + entry.activation.aliases
        out["secondKey"] = entry.activation.secondaryKeys.joinToString(", ")
        out["comment"] = entry.title ?: ""
        out["enabled"] = entry.enabled
        out["forceActivation"] = entry.activation.mode == "constant"
        out["vectorized"] = entry.activation.retrieval != "keyword"
        out["caseSensitive"] = entry.activation.caseSensitive
        out["useProbability"] = entry.scheduling.probability != 100.0
        out["probability"] = entry.scheduling.probability
        out["priority"] = entry.scheduling.order
        out["useRegExp"] = entry.activation.regex.enabled
        return out
    }
}
