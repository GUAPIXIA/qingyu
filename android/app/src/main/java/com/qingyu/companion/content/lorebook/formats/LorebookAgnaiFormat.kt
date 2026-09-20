package com.qingyu.companion.content.lorebook.formats

import com.qingyu.companion.content.lorebook.CanonicalLorebook
import com.qingyu.companion.content.lorebook.CanonicalLoreEntry
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
 * 阶段 5 S5-02：CCv2/CCv3 `character_book`
 * （`electron/services/lorebookAdapters/characterBook.ts`）。
 *
 * 也是角色卡**内嵌**世界书的落点：`CharacterCardCodec.Draft.embeddedCharacterBook`
 * 交给 [com.qingyu.companion.content.lorebook.LorebookImportExport] 后，
 * 由 registry 以最高概率选中本格式（条目里有 `keys`/`insertion_order`/`use_regex` 任一到 96 分）。
 * 注意检测要求 `entries` 是**数组**（CC 规范如此），对象形状让给 SillyTavern。
 */
/**
 * 阶段 5 S5-02：Agnai Memory Book
 * （`electron/services/lorebookAdapters/agnai.ts`）。
 *
 * Agnai 的条目形状是 `{name, entry, keywords[], priority, enabled, id}`：
 * 标题在 `name`、正文在 `entry`。适配器先把它们翻译成归一化器认识的载荷键
 * （`comment`/`content`/`insertion_order`），**同时保留原键**，
 * 于是未消费字段仍按 unknown 进 `foreign`、导出时又能合并回去。
 *
 * 与 NovelAI 的区分靠 `entry` + `keywords` 组合，一旦同时出现 NovelAI 字段
 * 就扣 40 分并给出冲突说明——这是「宁可报歧义也不猜」的具体落地。
 */
object LorebookAgnaiFormat : LorebookFormatAdapter {

    const val ID = "agnai.memory-book"
    const val LABEL = "Agnai Memory Book"
    const val VERSION = "1"

    internal val CONFIG = LorebookExternalFormat.Config(
        id = ID,
        label = LABEL,
        version = VERSION,
        sourceKind = LorebookNativeV1.SourceKind.CHARACTER_BOOK,
        style = LorebookExternalFormat.Style.CHARACTER_BOOK,
    )

    /** Agnai 条目中被本 adapter 消费的字段（在 ENTRY_KEYS 之外）；其余原样保留。 */
    private val CONSUMED_ENTRY_KEYS = LorebookExternalFormat.consumedKeys(listOf("entry"))

    override val id: String get() = ID
    override val label: String get() = LABEL
    override val formatVersion: String get() = VERSION
    override val priority: Int get() = 50

    override fun detect(input: Any?, file: LorebookFileMetadata?): LorebookDetectionResult {
        val record = LorebookJson.record(input)
        val entries = record?.let { LorebookJson.list(it["entries"]) }
            ?: return LorebookDetectionResult.mismatch(ID, LABEL, VERSION)
        val objectEntries = entries.mapNotNull { LorebookJson.record(it) }
        // Agnai 记忆书条目的特征组合：name（标题）+ entry（正文）+ keywords（关键词数组）
        val agnaiEntries = objectEntries.filter {
            it["entry"] is String && LorebookJson.list(it["keywords"]) != null
        }
        if (agnaiEntries.isEmpty()) return LorebookDetectionResult.mismatch(ID, LABEL, VERSION)
        val hasNovelAiFields = objectEntries.any { it.containsKey("text") || it.containsKey("forceActivation") }
        val confidence = minOf(
            100,
            88 + (if (LorebookJson.string(record["name"]) != null) 4 else 0) - (if (hasNovelAiFields) 40 else 0),
        )
        return LorebookDetectionResult(
            adapterId = ID,
            formatLabel = LABEL,
            formatVersion = VERSION,
            confidence = confidence,
            reasons = listOf("${agnaiEntries.size} 个条目使用 Agnai 的 name/entry/keywords 组合"),
            conflicts = if (hasNovelAiFields) listOf("同时检测到 NovelAI 的 text/forceActivation 字段") else emptyList(),
        )
    }

    override fun importLorebook(
        input: Any?,
        context: LorebookImportContext,
    ): LorebookAdapterImportResult {
        val record = LorebookJson.record(input) ?: error("Agnai Memory Book 顶层必须是对象")
        // 载荷保留书级字段（name/description）并原样透传非对象条目，让统一导入器生成拒绝报告
        val rawEntries = LorebookJson.list(record["entries"]) ?: emptyList<Any?>()
        val payload = LinkedHashMap<String, Any?>(record)
        payload["entries"] = rawEntries.map { entry ->
            val recordEntry = LorebookJson.record(entry) ?: return@map entry
            toPayloadEntry(recordEntry)
        }
        return LorebookExternalFormat.importExternalLorebook(
            payload,
            context,
            CONFIG.copy(consumedEntryKeys = CONSUMED_ENTRY_KEYS),
        )
    }

    override fun exportLorebook(document: CanonicalLorebook): LorebookAdapterExportResult {
        val storedBook = LorebookExternalFormat.foreignSection(document.foreign, ID)
        val preservedCount = storedBook.first.size + storedBook.second.size +
            document.entries.sumOf { entry ->
                val section = LorebookExternalFormat.foreignSection(entry.foreign, ID)
                section.first.size + section.second.size
            }
        val approximated = document.entries.count {
            it.insertion.kind != "prompt" || it.insertion.anchor != "prompt_end"
        }
        val constantCount = document.entries.count { it.activation.mode == "constant" }
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
                    "agnai_insertion_unsupported", "$.entries",
                    "Agnai Memory Book 通过记忆区插入正文，没有条目级提示词位置；" +
                        "$approximated 个条目的位置设置无法表达，已省略",
                )
            } else {
                null
            },
            if (constantCount > 0) {
                LorebookCompatibilityIssue.of(
                    LorebookCompatibilitySeverity.WARNING, LorebookCompatibilityAction.APPROXIMATED,
                    "agnai_constant_unsupported", "$.entries",
                    "Agnai Memory Book 条目没有常驻字段；$constantCount 个常驻条目导出后将按关键词触发",
                )
            } else {
                null
            },
        )
        val value = LinkedHashMap<String, Any?>()
        value.putAll(storedBook.first)
        value["name"] = document.name
        value["description"] = document.description
        value["entries"] = document.entries.map { agnaiExportEntry(it) }
        return LorebookAdapterExportResult(
            value = value,
            report = LorebookCompatibilityReport.create(ID, LABEL, VERSION, issues),
        )
    }

    /** Agnai 条目 → 归一化器可读的载荷字段；原始字段保留在对象上以便进入 foreign 保留区。 */
    private fun toPayloadEntry(entry: Map<String, Any?>): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>(entry)
        out["comment"] = entry["name"]
        out["content"] = entry["entry"]
        out["insertion_order"] = entry["priority"] ?: 0
        return out
    }

    /** `agnaiExportEntry`：canonical 重建的字段拥有最高优先级，其余未知字段作为底稿保留。 */
    private fun agnaiExportEntry(entry: CanonicalLoreEntry): Map<String, Any?> {
        val stored = LorebookExternalFormat.foreignSection(entry.foreign, ID)
        val rebuilt = setOf("id", "name", "entry", "keywords", "priority", "enabled")
        val out = LinkedHashMap<String, Any?>()
        stored.first.forEach { (key, value) -> if (!rebuilt.contains(key)) out[key] = value }
        entry.sourceId?.let { out["id"] = it }
        out["name"] = entry.title ?: ""
        out["entry"] = entry.content
        out["keywords"] = entry.activation.primaryKeys + entry.activation.aliases
        out["priority"] = entry.scheduling.order
        out["enabled"] = entry.enabled
        return out
    }
}
