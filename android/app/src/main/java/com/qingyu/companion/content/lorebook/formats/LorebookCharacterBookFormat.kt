package com.qingyu.companion.content.lorebook.formats

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
 * 阶段 5 S5-02：CCv2/CCv3 `character_book`
 * （`electron/services/lorebookAdapters/characterBook.ts`）。
 *
 * 也是角色卡**内嵌**世界书的落点：`CharacterCardCodec.Draft.embeddedCharacterBook`
 * 交给 [com.qingyu.companion.content.lorebook.LorebookImportExport] 后，
 * 由 registry 以最高概率选中本格式（条目里有 `keys`/`insertion_order`/`use_regex` 任一到 96 分）。
 * 注意检测要求 `entries` 是**数组**（CC 规范如此），对象形状让给 SillyTavern。
 */
object LorebookCharacterBookFormat : LorebookFormatAdapter {

    const val ID = "character-card.character-book"
    const val LABEL = "CCv2/CCv3 character_book"
    const val VERSION = "2/3"

    internal val CONFIG = LorebookExternalFormat.Config(
        id = ID,
        label = LABEL,
        version = VERSION,
        sourceKind = LorebookNativeV1.SourceKind.CHARACTER_BOOK,
        style = LorebookExternalFormat.Style.CHARACTER_BOOK,
    )

    override val id: String get() = ID
    override val label: String get() = LABEL
    override val formatVersion: String get() = VERSION
    override val priority: Int get() = 85

    private val HINT = Regex("character[-_ ]?book", RegexOption.IGNORE_CASE)

    override fun detect(input: Any?, file: LorebookFileMetadata?): LorebookDetectionResult {
        val record = LorebookJson.record(input)
        val entries = record?.let { LorebookJson.list(it["entries"]) }
            ?: return LorebookDetectionResult.mismatch(ID, LABEL, VERSION)
        val objectEntries = entries.mapNotNull { LorebookJson.record(it) }
        val hasCcFields = objectEntries.any {
            it.containsKey("keys") || it.containsKey("insertion_order") || it.containsKey("use_regex")
        }
        val hasNativeFields = objectEntries.any { it.containsKey("keywords") || it.containsKey("matchMode") }
        val hinted = HINT.containsMatchIn(file?.fileName ?: "")
        val confidence = minOf(
            100,
            (if (hasCcFields) 96 else if (LorebookJson.number(record["scan_depth"]) != null) 68 else 35) +
                if (hinted) 25 else 0,
        )
        val reasons = mutableListOf("entries 为数组")
        if (hasCcFields) reasons += "条目包含 keys/insertion_order/use_regex 字段"
        if (hinted) reasons += "文件名提示 character_book"
        return LorebookDetectionResult(
            adapterId = ID,
            formatLabel = LABEL,
            formatVersion = VERSION,
            confidence = confidence,
            reasons = reasons,
            conflicts = if (hasNativeFields) listOf("同时检测到轻语原生 keywords/matchMode 字段") else emptyList(),
        )
    }

    override fun importLorebook(
        input: Any?,
        context: LorebookImportContext,
    ): LorebookAdapterImportResult {
        val record = LorebookJson.record(input) ?: error("character_book 顶层必须是对象")
        return LorebookExternalFormat.importExternalLorebook(record, context, CONFIG)
    }

    override fun exportLorebook(document: CanonicalLorebook): LorebookAdapterExportResult =
        LorebookExternalFormat.exportExternalLorebook(document, CONFIG)
}
