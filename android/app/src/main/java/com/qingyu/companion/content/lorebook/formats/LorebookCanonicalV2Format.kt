package com.qingyu.companion.content.lorebook.formats

import com.qingyu.companion.content.lorebook.CanonicalLorebook
import com.qingyu.companion.content.lorebook.LorebookAdapterError
import com.qingyu.companion.content.lorebook.LorebookAdapterImportResult
import com.qingyu.companion.content.lorebook.LorebookAdapterExportResult
import com.qingyu.companion.content.lorebook.LorebookCompatibilityIssue
import com.qingyu.companion.content.lorebook.LorebookCompatibilityReport
import com.qingyu.companion.content.lorebook.LorebookCompatibilityAction
import com.qingyu.companion.content.lorebook.LorebookCompatibilitySeverity
import com.qingyu.companion.content.lorebook.LorebookDetectionResult
import com.qingyu.companion.content.lorebook.LorebookFileMetadata
import com.qingyu.companion.content.lorebook.LorebookFormatAdapter
import com.qingyu.companion.content.lorebook.LorebookImportContext
import com.qingyu.companion.content.lorebook.LorebookJson
import com.qingyu.companion.content.lorebook.LorebookValidation

/**
 * 阶段 5 S5-02：轻语 canonical v2 自身
 * （`electron/services/lorebookAdapters/canonicalV2.ts`）。
 *
 * 这是编辑器保存/读取与「Android 导出 → PC 导入」的直通格式：
 * 检测要求 `schema` 与 `schemaVersion` 同时命中，因此它永远以 100 分压倒
 * 所有启发式格式；反过来只要差一个键就整份 0 分，绝不「猜」它是 canonical。
 *
 * 导入必须**先校验再建模**（PC 是 `structuredClone(validation.value)`）：
 * 校验失败时抛出的 `LorebookAdapterError` 带着逐条 `canonical_v2_invalid` issue，
 * 用户在导入预览里看到的路径（`$.entries[3].activation.mode` 之类）就是从这里来的。
 */
object LorebookCanonicalV2Format : LorebookFormatAdapter {

    const val ID = "qingyu.canonical-v2"
    const val LABEL = "轻语 Canonical 世界书 v2"
    const val VERSION = "2"

    override val id: String get() = ID
    override val label: String get() = LABEL
    override val formatVersion: String get() = VERSION
    override val priority: Int get() = 100

    override fun detect(input: Any?, file: LorebookFileMetadata?): LorebookDetectionResult {
        val record = LorebookJson.record(input)
        val exact = record != null && record["schema"] == CanonicalLorebook.SCHEMA &&
            LorebookJson.number(record["schemaVersion"]) == CanonicalLorebook.SCHEMA_VERSION.toDouble()
        return LorebookDetectionResult(
            adapterId = ID,
            formatLabel = LABEL,
            formatVersion = VERSION,
            confidence = if (exact) 100 else 0,
            reasons = if (exact) listOf("schema=qingyu_lorebook 且 schemaVersion=2") else emptyList(),
            conflicts = emptyList(),
        )
    }

    override fun importLorebook(
        input: Any?,
        context: LorebookImportContext,
    ): LorebookAdapterImportResult {
        val validation = LorebookValidation.validateCanonicalV2(input)
        if (!validation.valid) {
            val issues = validation.issues.map {
                LorebookCompatibilityIssue.of(
                    LorebookCompatibilitySeverity.ERROR,
                    LorebookCompatibilityAction.REJECTED,
                    "canonical_v2_invalid",
                    it.path,
                    it.message,
                )
            }
            throw LorebookAdapterError(
                "Canonical 世界书 v2 校验失败",
                LorebookCompatibilityReport.create(ID, LABEL, VERSION, issues),
            )
        }
        val document = CanonicalLorebook.fromMap(validation.value)
            ?: throw LorebookAdapterError("Canonical 世界书 v2 校验失败")
        return LorebookAdapterImportResult(
            // `if (context.id) document.id = context.id`：空串在 PC 里同样是 falsy，不能覆盖
            document = context.id?.takeIf { it.isNotEmpty() }?.let { document.copy(id = it) } ?: document,
            report = LorebookCompatibilityReport.create(ID, LABEL, VERSION),
        )
    }

    override fun exportLorebook(document: CanonicalLorebook): LorebookAdapterExportResult =
        LorebookAdapterExportResult(
            value = document.toJsonMap(),
            report = LorebookCompatibilityReport.create(ID, LABEL, VERSION),
        )
}
