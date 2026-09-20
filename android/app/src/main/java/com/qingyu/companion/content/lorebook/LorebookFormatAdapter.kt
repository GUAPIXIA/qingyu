package com.qingyu.companion.content.lorebook

/**
 * 阶段 5 S5-02：格式适配器的接口与上下文
 * （`shared/lorebook/adapters/types.ts`）。
 *
 * 与 TS 的两处签名差异都是 Kotlin 侧的必要调整，不改变语义：
 * - `import` 是 Kotlin 关键字，方法名改成 [importLorebook]；
 * - TS 的 `LorebookFormatAdapter.export` 每个实现都必须提供，而方案 S5-02 要求
 *   「对**支持**的格式导出」——映射向导按 §6.3 明确不提供导出。因此这里加了
 *   [canExport]，[exportLorebook] 在不支持时返回 null，由 registry 给出用户可读的拒绝。
 *
 * 另外 [LorebookAdapterImportResult] 的 `document`/`report` 是 `var`：PC 的 lorebook_v3 /
 * Risu / NovelAI 三个适配器都会在 `importExternalLorebook` 返回后**重写** report（补 wrapper issue、
 * 换 formatVersion）。Kotlin 里要么把它做成可变属性，要么每个适配器各写一遍
 * 归一化流程——后者会直接产生第二套导入语义，所以选了前者。
 */

/** `LorebookFileMetadata`：文件名参与若干格式的检测打分，所以必须透传。 */
data class LorebookFileMetadata(
    val fileName: String? = null,
    val extension: String? = null,
)

/** `LorebookDetectionResult`。 */
data class LorebookDetectionResult(
    val adapterId: String,
    val formatLabel: String,
    val formatVersion: String,
    val confidence: Int,
    val reasons: List<String>,
    val conflicts: List<String>,
) {
    fun toJsonMap(): Map<String, Any?> = linkedMapOf(
        "adapterId" to adapterId,
        "formatLabel" to formatLabel,
        "formatVersion" to formatVersion,
        "confidence" to confidence,
        "reasons" to reasons,
        "conflicts" to conflicts,
    )

    companion object {
        /** 完全不匹配（`confidence: 0`）——检测分支大量以「提前返回这个」收尾。 */
        fun mismatch(adapterId: String, formatLabel: String, formatVersion: String) =
            LorebookDetectionResult(adapterId, formatLabel, formatVersion, 0, emptyList(), emptyList())
    }
}

/** `LorebookImportContext`。 */
data class LorebookImportContext(
    val id: String? = null,
    val fallbackName: String,
    val now: Double,
    val contentHash: String,
    val file: LorebookFileMetadata? = null,
)

/** `LorebookAdapterImportResult`。 */
data class LorebookAdapterImportResult(
    var document: CanonicalLorebook,
    var report: LorebookCompatibilityReport,
)

/** `LorebookAdapterExportResult`：[value] 是可直接序列化成文件的 JSON 值。 */
data class LorebookAdapterExportResult(
    val value: Any?,
    val report: LorebookCompatibilityReport,
) {
    /** 导出成紧凑 JSON 文本。 */
    fun toJsonText(): String = LorebookJson.stringify(value)

    /** 导出成缩进 2 的 JSON 文本（写文件用）。 */
    fun toPrettyJsonText(): String = LorebookJson.stringifyPretty(value)
}

/** `LorebookRegistryImportResult`。 */
data class LorebookRegistryImportResult(
    val document: CanonicalLorebook,
    val report: LorebookCompatibilityReport,
    val detection: LorebookDetectionResult,
)

/** `LorebookFormatAdapter`。 */
interface LorebookFormatAdapter {
    val id: String
    val label: String
    val formatVersion: String
    val priority: Int

    /** 该格式能否表达导出；false 时 [exportLorebook] 返回 null。 */
    val canExport: Boolean
        get() = true

    fun detect(input: Any?, file: LorebookFileMetadata? = null): LorebookDetectionResult

    /**
     * 导入。
     *
     * @throws LorebookAdapterError 结构非法（canonical/native 校验失败），消息与 PC 一致
     * @throws IllegalStateException 顶层类型不对（PC 侧直接 `throw new Error(...)` 的那些分支）
     */
    fun importLorebook(input: Any?, context: LorebookImportContext): LorebookAdapterImportResult

    fun exportLorebook(document: CanonicalLorebook): LorebookAdapterExportResult?
}

/** 检测候选（registry 内部用：adapter 与其检测结果成对排序）。 */
data class LorebookDetectionCandidate(
    val adapter: LorebookFormatAdapter,
    val detection: LorebookDetectionResult,
)
