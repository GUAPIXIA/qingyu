package com.qingyu.companion.content.lorebook.formats

import com.qingyu.companion.content.lorebook.CanonicalLorebook
import com.qingyu.companion.content.lorebook.LorebookAdapterError
import com.qingyu.companion.content.lorebook.LorebookAdapterExportResult
import com.qingyu.companion.content.lorebook.LorebookAdapterImportResult
import com.qingyu.companion.content.lorebook.LorebookCompatibilityAction
import com.qingyu.companion.content.lorebook.LorebookCompatibilityIssue
import com.qingyu.companion.content.lorebook.LorebookCompatibilityReport
import com.qingyu.companion.content.lorebook.LorebookCompatibilitySeverity
import com.qingyu.companion.content.lorebook.LorebookDetectionResult
import com.qingyu.companion.content.lorebook.LorebookFileMetadata
import com.qingyu.companion.content.lorebook.LorebookFormatAdapter
import com.qingyu.companion.content.lorebook.LorebookImportContext
import com.qingyu.companion.content.lorebook.LorebookJson
import com.qingyu.companion.content.lorebook.LorebookNativeMigration
import com.qingyu.companion.content.lorebook.LorebookNativeV1

/**
 * 阶段 5 S5-02：轻语原生世界书 v1
 * （`electron/services/lorebookAdapters/nativeV1.ts`）。
 *
 * 这是**存量数据**的格式：库里的旧世界书、以及 PC 早期版本写出的文件都是它。
 * 导入走 [LorebookNativeMigration]，导出走 [LorebookNativeV1.compileCanonical]，
 * 两端都必须把 `foreign["qingyu.native-v1"]` 里的未知字段贴回去——
 * 否则「Android 导出 → 旧版 PC 读」会丢掉 PC 自己写进来的前向兼容字段。
 *
 * 检测打分（`scanDepth` 72/45 + 原生字段 23 + `schemaVersion===1` 抬到 98）
 * 与 PC 逐常数相同：这个分数决定它与 canonical/character_book 谁是第一名，
 * 改动就等于改变「歧义时选谁」的结果。
 */
object LorebookNativeV1Format : LorebookFormatAdapter {

    const val ID = LorebookNativeV1.NATIVE_FOREIGN_NAMESPACE
    const val LABEL = "轻语原生世界书 v1"
    const val VERSION = "1"

    override val id: String get() = ID
    override val label: String get() = LABEL
    override val formatVersion: String get() = VERSION
    override val priority: Int get() = 90

    override fun detect(input: Any?, file: LorebookFileMetadata?): LorebookDetectionResult {
        val detected = nativeSignals(input)
        val hinted = file?.fileName?.lowercase()?.contains("native-v1") == true
        return LorebookDetectionResult(
            adapterId = ID,
            formatLabel = LABEL,
            formatVersion = VERSION,
            confidence = minOf(100, detected.score + if (hinted) 8 else 0),
            reasons = detected.reasons + if (hinted) listOf("文件名提示 native-v1") else emptyList(),
            conflicts = detected.conflicts,
        )
    }

    override fun importLorebook(
        input: Any?,
        context: LorebookImportContext,
    ): LorebookAdapterImportResult {
        val validation = LorebookNativeV1.validate(input)
        if (!validation.valid) {
            val issues = validation.issues.map {
                LorebookCompatibilityIssue.of(
                    LorebookCompatibilitySeverity.ERROR,
                    LorebookCompatibilityAction.REJECTED,
                    "native_v1_invalid",
                    it.path,
                    it.message,
                )
            }
            throw LorebookAdapterError(
                "轻语原生世界书 v1 校验失败",
                LorebookCompatibilityReport.create(ID, LABEL, VERSION, issues),
            )
        }
        val migrated = LorebookNativeMigration.migrateV1ToV2(
            validation.value ?: emptyMap(),
            LorebookNativeMigration.Options(now = context.now, contentHash = context.contentHash),
        )
        val document = context.id?.takeIf { it.isNotEmpty() }?.let { migrated.copy(id = it) } ?: migrated
        val preserved = countPreservedNamespaces(document)
        val issues = if (preserved > 0) {
            listOf(
                LorebookCompatibilityIssue.of(
                    LorebookCompatibilitySeverity.INFO, LorebookCompatibilityAction.PRESERVED,
                    "unknown_field", "$", "$preserved 个未知原生字段已保留在 namespaced foreign 中",
                ),
            )
        } else {
            emptyList()
        }
        return LorebookAdapterImportResult(
            document = document,
            report = LorebookCompatibilityReport.create(ID, LABEL, VERSION, issues),
        )
    }

    override fun exportLorebook(document: CanonicalLorebook): LorebookAdapterExportResult {
        val view = LinkedHashMap<String, Any?>(LorebookNativeV1.compileCanonical(document))
        val bookExtras = LorebookJson.record(document.foreign?.get(ID))
        // 书级未知字段要**合并回导出结果**，不是读一遍就丢掉。
        // PC 是 `{...bookExtras, ...view, entries}`（`nativeV1.ts:82-90`）：同名键以编译结果
        // 为准，extras 里独有的（例如样本的 `futureBookOption`）原样留在导出文件里。
        // 这里曾把 `bookExtras` 算出来却从未合进去——导入侧明明把它存进了 `foreign`，导出侧
        // 却不还回去，于是「导一次少一个字段」，正是方案 §2 禁止的静默丢失。
        // 阶段 0 的 28 份样本里只有 `native-v1-unknown-extensions` 带书级未知字段，
        // 所以这条偏差只有跨端比对抓得到：Android 自己闭环时两头都缺同一个字段，看不出少东西。
        val value = LinkedHashMap<String, Any?>()
        bookExtras?.let { value.putAll(it) }
        value.putAll(view)
        @Suppress("UNCHECKED_CAST")
        val viewEntries = LorebookJson.list(view["entries"]).orEmpty() as List<Map<String, Any?>>
        value["entries"] = viewEntries.mapIndexed { index, entry ->
            val merged = LinkedHashMap<String, Any?>()
            LorebookJson.record(document.entries.getOrNull(index)?.foreign?.get(ID))?.let { merged.putAll(it) }
            merged.putAll(entry)
            merged
        }
        val preserved = countPreservedNamespaces(document)
        val issues = if (preserved > 0) {
            listOf(
                LorebookCompatibilityIssue.of(
                    LorebookCompatibilitySeverity.INFO, LorebookCompatibilityAction.PRESERVED,
                    "foreign_exported", "$", "$preserved 个未知原生字段已合并回导出结果",
                ),
            )
        } else {
            emptyList()
        }
        return LorebookAdapterExportResult(
            value = value,
            report = LorebookCompatibilityReport.create(ID, LABEL, VERSION, issues),
        )
    }

    /**
     * `Object.keys(foreign[ID]).length` 的书级 + 条目级求和。
     *
     * 注意它数的是**命名空间里的键数**（native v1 的 foreign 形状是
     * `{"qingyu.native-v1": {k: v}}`，没有外部格式那层 `payload`），
     * 与 [LorebookNativeV1] 的 `collectForeign` 输出一一对应。
     */
    private fun countPreservedNamespaces(document: CanonicalLorebook): Int {
        val book = LorebookJson.record(document.foreign?.get(ID))?.size ?: 0
        return book + document.entries.sumOf { entry ->
            LorebookJson.record(entry.foreign?.get(ID))?.size ?: 0
        }
    }

    private data class NativeSignals(
        val score: Int,
        val reasons: List<String>,
        val conflicts: List<String>,
    )

    private fun nativeSignals(input: Any?): NativeSignals {
        val record = LorebookJson.record(input) ?: return NativeSignals(0, emptyList(), emptyList())
        val rawEntries = LorebookJson.list(record["entries"]) ?: return NativeSignals(0, emptyList(), emptyList())
        val objectEntries = rawEntries.mapNotNull { LorebookJson.record(it) }
        val nativeEntry = objectEntries.any {
            it.containsKey("keywords") || it.containsKey("matchMode") || it.containsKey("useRegex")
        }
        val externalEntry = objectEntries.any {
            it.containsKey("keys") || it.containsKey("key") || it.containsKey("insertion_order")
        }
        var score = if (LorebookJson.number(record["scanDepth"]) != null) 72 else 45
        val reasons = mutableListOf("entries 为数组")
        if (nativeEntry) {
            score += 23
            reasons += "条目使用 keywords/matchMode/useRegex 原生字段"
        }
        if (LorebookJson.number(record["schemaVersion"]) == 1.0) {
            score = maxOf(score, 98)
            reasons += "schemaVersion=1"
        }
        return NativeSignals(
            score = minOf(100, score),
            reasons = reasons,
            conflicts = if (externalEntry) listOf("条目同时出现原生与外部格式字段") else emptyList(),
        )
    }
}
