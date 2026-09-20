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
/**
 * 阶段 5 S5-02：Character Card V3 的独立 `lorebook_v3` 包装
 * （`electron/services/lorebookAdapters/lorebookV3.ts`）。
 *
 * 它是 `{spec:'lorebook_v3', spec_version, data}` 信封 + 内部 character_book。
 * 两个必须保住的细节：
 * 1. 信封上除 `spec`/`spec_version`/`data` 之外的键进 `foreign[…].wrapper`，
 *    导出时**贴回顶层**，否则第三方工具加的字段一 round-trip 就没了；
 * 2. `formatVersion` 取 `spec_version`（字符串时），document.source 与 report 都要跟着改——
 *    PC 用 `spec_version` 记录「这份文件声称自己是哪版」，编辑器与兼容性报告都读它。
 */
object LorebookV3Format : LorebookFormatAdapter {

    const val ID = "character-card.lorebook-v3"
    const val LABEL = "Character Card lorebook_v3"
    const val VERSION = "3.0"

    internal val CONFIG = LorebookExternalFormat.Config(
        id = ID,
        label = LABEL,
        version = VERSION,
        sourceKind = LorebookNativeV1.SourceKind.CHARACTER_BOOK,
        style = LorebookExternalFormat.Style.CHARACTER_BOOK,
    )

    private val WRAPPER_KEYS = setOf("spec", "spec_version", "data")

    override val id: String get() = ID
    override val label: String get() = LABEL
    override val formatVersion: String get() = VERSION
    override val priority: Int get() = 95

    override fun detect(input: Any?, file: LorebookFileMetadata?): LorebookDetectionResult {
        val record = LorebookJson.record(input)
        val spec = record?.get("spec")
        val exact = spec == "lorebook_v3" && LorebookJson.record(record["data"]) != null
        val partial = spec == "lorebook_v3"
        val reasons = when {
            exact -> listOf("spec=lorebook_v3", "data 为对象")
            partial -> listOf("spec=lorebook_v3")
            else -> emptyList()
        }
        return LorebookDetectionResult(
            adapterId = ID,
            formatLabel = LABEL,
            formatVersion = VERSION,
            confidence = if (exact) 100 else if (partial) 90 else 0,
            reasons = reasons,
            conflicts = if (partial && !exact) listOf("lorebook_v3 缺少对象类型 data") else emptyList(),
        )
    }

    override fun importLorebook(
        input: Any?,
        context: LorebookImportContext,
    ): LorebookAdapterImportResult {
        val record = LorebookJson.record(input)
        val data = record?.let { LorebookJson.record(it["data"]) }
        if (record == null || record["spec"] != "lorebook_v3" || data == null) {
            throw com.qingyu.companion.content.lorebook.LorebookAdapterError("lorebook_v3 包装结构无效")
        }
        val wrapperIssues = mutableListOf<LorebookCompatibilityIssue>()
        val wrapperExtras = LorebookExternalFormat.collectWrapperExtras(record, WRAPPER_KEYS, wrapperIssues)
        val result = LorebookExternalFormat.importExternalLorebook(data, context, CONFIG, wrapperExtras)
        val specVersion = LorebookJson.string(record["spec_version"]) ?: VERSION
        result.report = LorebookCompatibilityReport.create(
            ID,
            LABEL,
            specVersion,
            wrapperIssues + result.report.issues,
        )
        val source = result.document.source
        result.document = result.document.copy(
            source = (source ?: com.qingyu.companion.content.lorebook.LorebookSourceMetadata()).copy(
                formatVersion = specVersion,
            ),
        )
        return result
    }

    override fun exportLorebook(document: CanonicalLorebook): LorebookAdapterExportResult {
        val payload = LorebookExternalFormat.exportExternalLorebook(document, CONFIG)
        val wrapper = LorebookExternalFormat.wrapperForeign(document, ID)
        val value = LinkedHashMap<String, Any?>()
        value.putAll(wrapper)
        value["spec"] = "lorebook_v3"
        value["spec_version"] = if (document.source?.adapterId == ID) {
            document.source.formatVersion ?: VERSION
        } else {
            VERSION
        }
        value["data"] = payload.value
        return LorebookAdapterExportResult(value = value, report = payload.report)
    }
}
