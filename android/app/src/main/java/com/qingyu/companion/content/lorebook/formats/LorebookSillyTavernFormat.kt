package com.qingyu.companion.content.lorebook.formats

import com.qingyu.companion.content.lorebook.LorebookAdapterExportResult
import com.qingyu.companion.content.lorebook.LorebookAdapterImportResult
import com.qingyu.companion.content.lorebook.LorebookDetectionResult
import com.qingyu.companion.content.lorebook.LorebookExternalFormat
import com.qingyu.companion.content.lorebook.LorebookFileMetadata
import com.qingyu.companion.content.lorebook.LorebookFormatAdapter
import com.qingyu.companion.content.lorebook.LorebookImportContext
import com.qingyu.companion.content.lorebook.LorebookJson
import com.qingyu.companion.content.lorebook.LorebookNativeV1
import com.qingyu.companion.content.lorebook.CanonicalLorebook

/**
 * 阶段 5 S5-02：SillyTavern World Info
 * （`electron/services/lorebookAdapters/sillyTavern.ts`）。
 *
 * ST 的条目既可能是数组、也可能是 **uid 键控对象**（导出文件的常见形状），
 * 后者会额外拿 65/97 分——这正是它与 `character_book` 的主要区分依据。
 * 打分常数、文件名提示（+20）与冲突说明都照抄 PC：
 * 方案 §S5-02 末句要求「格式检测结果与 PC fixture 一致」，
 * 而 registry 的歧义判定只看前两名的分差（[LorebookAdapterRegistry.LOREBOOK_ADAPTER_AMBIGUITY_MARGIN]），
 * 动一个常数就可能把「报歧义」变成「静默选一个」。
 */
object LorebookSillyTavernFormat : LorebookFormatAdapter {

    const val ID = "sillytavern.world-info"
    const val LABEL = "SillyTavern World Info"
    const val VERSION = "2026-07"

    internal val CONFIG = LorebookExternalFormat.Config(
        id = ID,
        label = LABEL,
        version = VERSION,
        sourceKind = LorebookNativeV1.SourceKind.SILLY_TAVERN,
        style = LorebookExternalFormat.Style.SILLYTAVERN,
    )

    override val id: String get() = ID
    override val label: String get() = LABEL
    override val formatVersion: String get() = VERSION
    override val priority: Int get() = 80

    private val HINT = Regex("sillytavern|world[-_ ]?info", RegexOption.IGNORE_CASE)

    override fun detect(input: Any?, file: LorebookFileMetadata?): LorebookDetectionResult {
        val record = LorebookJson.record(input)
        if (record == null || !record.containsKey("entries")) {
            return LorebookDetectionResult.mismatch(ID, LABEL, VERSION)
        }
        val entries = when {
            LorebookJson.record(record["entries"]) != null ->
                LorebookJson.record(record["entries"])!!.values.mapNotNull { LorebookJson.record(it) }
            LorebookJson.list(record["entries"]) != null ->
                LorebookJson.list(record["entries"])!!.mapNotNull { LorebookJson.record(it) }
            else -> emptyList()
        }
        val hasStFields = entries.any {
            it.containsKey("uid") || it.containsKey("key") || it.containsKey("keysecondary") || it.containsKey("disable")
        }
        val hasCcFields = entries.any { it.containsKey("keys") || it.containsKey("insertion_order") }
        val objectEntries = LorebookJson.record(record["entries"]) != null
        val hinted = HINT.containsMatchIn(file?.fileName ?: "")
        val confidence = minOf(
            100,
            (if (objectEntries && hasStFields) 97 else if (hasStFields) 82 else if (objectEntries) 65 else 0) +
                if (hinted) 20 else 0,
        )
        val reasons = mutableListOf<String>()
        if (objectEntries) reasons += "entries 使用 ST 常见的 uid 键控对象"
        if (hasStFields) reasons += "条目包含 uid/key/keysecondary/disable 字段"
        if (hinted) reasons += "文件名提示 SillyTavern World Info"
        return LorebookDetectionResult(
            adapterId = ID,
            formatLabel = LABEL,
            formatVersion = VERSION,
            confidence = confidence,
            reasons = reasons,
            conflicts = if (hasCcFields) listOf("同时检测到 character_book 的 keys/insertion_order 字段") else emptyList(),
        )
    }

    override fun importLorebook(
        input: Any?,
        context: LorebookImportContext,
    ): LorebookAdapterImportResult {
        val record = LorebookJson.record(input) ?: error("SillyTavern World Info 顶层必须是对象")
        return LorebookExternalFormat.importExternalLorebook(record, context, CONFIG)
    }

    override fun exportLorebook(document: CanonicalLorebook): LorebookAdapterExportResult =
        LorebookExternalFormat.exportExternalLorebook(document, CONFIG)
}
