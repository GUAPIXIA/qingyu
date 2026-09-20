package com.qingyu.companion.content.lorebook

import com.qingyu.companion.content.lorebook.formats.LorebookAgnaiFormat
import com.qingyu.companion.content.lorebook.formats.LorebookCanonicalV2Format
import com.qingyu.companion.content.lorebook.formats.LorebookCharacterBookFormat
import com.qingyu.companion.content.lorebook.formats.LorebookNativeV1Format
import com.qingyu.companion.content.lorebook.formats.LorebookNovelAiFormat
import com.qingyu.companion.content.lorebook.formats.LorebookRisuFormat
import com.qingyu.companion.content.lorebook.formats.LorebookSillyTavernFormat
import com.qingyu.companion.content.lorebook.formats.LorebookV3Format

/**
 * 阶段 5 S5-02：格式适配器注册表
 * （`electron/services/lorebookAdapters/registry.ts`）。
 *
 * ## 选择规则（方案 §6.1「不静默猜测」的三条落地）
 * 1. 第一名置信度 < [MIN_CONFIDENCE] → **拒绝**，并提示可改用映射向导；
 * 2. 前两名分差 < [AMBIGUITY_MARGIN] → 仍然导入，但报告里给出 `ambiguous_format`，
 *    并明确说明「按优先级选择了谁」，UI 据此提示用户可指定格式（[options.adapterId]）；
 * 3. 用户显式指定格式时**跳过检测**，置信度记 100、理由记「用户手动指定格式」，
 *    且不再产生歧义告警。
 *
 * 两条阈值与排序键（置信度降序 → priority 降序 → id 字典序）都是跨端契约：
 * PC 的 fixture 里「ST 与 character_book 同时像」的样本正是靠 priority 差决定胜负的。
 *
 * ## 导入产物的统一后处理
 * 检测冲突 issue 排在 adapter 自己的 issue **之前**，最后再跑
 * [LorebookLimits.enforceImportDocumentLimits]；三份合并后才判定 `status == rejected`。
 * 顺序影响 UI 上「第一条错误」显示的是哪句，所以不能并成一团。
 */
class LorebookAdapterRegistry(adapters: List<LorebookFormatAdapter> = emptyList()) {

    /** `ImportWithRegistryOptions`。 */
    data class Options(
        val id: String? = null,
        val fallbackName: String,
        val file: LorebookFileMetadata? = null,
        val now: Double? = null,
        val contentHash: String? = null,
        /** 用户显式选择的 adapter（歧义确认后使用）；提供时跳过检测直接导入。 */
        val adapterId: String? = null,
    )

    private val adapters = LinkedHashMap<String, LorebookFormatAdapter>()

    init {
        adapters.forEach { register(it) }
    }

    fun register(adapter: LorebookFormatAdapter) {
        require(adapter.id.trim().isNotEmpty()) { "世界书 adapter id 不能为空" }
        adapters[adapter.id] = adapter
    }

    fun unregister(adapterId: String) {
        adapters.remove(adapterId)
    }

    /** `list()`：priority 降序，同分按 id 字典序。 */
    fun list(): List<LorebookFormatAdapter> =
        adapters.values.sortedWith(compareByDescending<LorebookFormatAdapter> { it.priority }.thenBy { it.id })

    fun get(adapterId: String): LorebookFormatAdapter? = adapters[adapterId]

    /** `detect()`：过滤 0 分候选，按「置信度 → priority → id」排序。 */
    fun detect(input: Any?, file: LorebookFileMetadata? = null): List<LorebookDetectionCandidate> =
        list()
            .map { adapter -> LorebookDetectionCandidate(adapter, adapter.detect(input, file)) }
            .filter { candidate -> candidate.detection.confidence > 0 }
            .sortedWith(
                compareByDescending<LorebookDetectionCandidate> { it.detection.confidence }
                    .thenByDescending { it.adapter.priority }
                    .thenBy { it.adapter.id },
            )

    /** `import()`（`import` 是 Kotlin 关键字，故改名 [importLorebook]）。 */
    fun importLorebook(input: Any?, options: Options): LorebookRegistryImportResult {
        // 方案 §15：超深结构在进入 adapter 前直接拒绝，避免后续遍历栈溢出
        try {
            LorebookLimits.assertImportJsonDepth(input)
        } catch (error: IllegalStateException) {
            throw LorebookAdapterError(error.message.orEmpty())
        }

        val forced = options.adapterId?.let { adapterId ->
            val adapter = adapters[adapterId]
                ?: throw LorebookAdapterError("未注册世界书格式适配器：$adapterId")
            LorebookDetectionCandidate(
                adapter,
                LorebookDetectionResult(
                    adapterId = adapter.id,
                    formatLabel = adapter.label,
                    formatVersion = adapter.formatVersion,
                    confidence = 100,
                    reasons = listOf("用户手动指定格式"),
                    conflicts = emptyList(),
                ),
            )
        }
        val candidates = detect(input, options.file)
        val selected = forced ?: candidates.firstOrNull()
        if (selected == null || selected.detection.confidence < MIN_CONFIDENCE) {
            throw LorebookAdapterError(
                "无法识别世界书格式；如果知道文件结构，可使用「映射向导导入」手动指定字段路径",
            )
        }

        val hash = options.contentHash
            ?: LorebookJson.sha256Hex(LorebookJson.stringify(input))
        val imported = selected.adapter.importLorebook(
            input,
            LorebookImportContext(
                id = options.id,
                fallbackName = options.fallbackName,
                now = options.now ?: System.currentTimeMillis().toDouble(),
                contentHash = hash,
                file = options.file,
            ),
        )
        val detectionIssues = selected.detection.conflicts.map {
            LorebookCompatibilityIssue.of(
                LorebookCompatibilitySeverity.WARNING, LorebookCompatibilityAction.MAPPED,
                "format_conflict", "$", it,
            )
        }
        val alternative = candidates.drop(1).firstOrNull()
        val ambiguityIssues = if (forced == null && alternative != null &&
            alternative.detection.confidence >= selected.detection.confidence - AMBIGUITY_MARGIN
        ) {
            listOf(
                LorebookCompatibilityIssue.of(
                    LorebookCompatibilitySeverity.WARNING, LorebookCompatibilityAction.MAPPED,
                    "ambiguous_format", "$",
                    "格式也接近「${alternative.detection.formatLabel}」(${alternative.detection.confidence}%)，" +
                        "已按优先级选择「${selected.detection.formatLabel}」",
                ),
            )
        } else {
            emptyList()
        }
        // 方案 §6.5/§15：导入产物统一执行条目数/正文长度/foreign 保留区/正则上限
        val limitOutcome = LorebookLimits.enforceImportDocumentLimits(imported.document)
        val report = LorebookCompatibilityReport.create(
            imported.report.adapterId,
            imported.report.formatLabel,
            imported.report.formatVersion,
            detectionIssues + ambiguityIssues + imported.report.issues + limitOutcome.issues,
        )
        if (report.isRejected) {
            val firstError = report.issues.firstOrNull { it.severity == LorebookCompatibilitySeverity.ERROR }
            throw LorebookAdapterError(
                "世界书包含无法导入的结构：${firstError?.message ?: "结构不合法"}",
                report,
            )
        }
        return LorebookRegistryImportResult(
            document = limitOutcome.document,
            report = report,
            detection = selected.detection,
        )
    }

    /**
     * `export()`。
     *
     * @return null 表示该格式不提供导出（方案 §6.3：映射向导只进不出）；
     *         未注册 id 与 PC 一样抛 [LorebookAdapterError]。
     */
    fun export(adapterId: String, document: CanonicalLorebook): LorebookAdapterExportResult? {
        val adapter = adapters[adapterId]
            ?: throw LorebookAdapterError("未注册世界书格式适配器：$adapterId")
        return adapter.exportLorebook(document)
    }

    companion object {
        /** `LOREBOOK_ADAPTER_MIN_CONFIDENCE`：识别置信度低于该值时拒绝导入（方案 §6.1：不静默猜测）。 */
        const val MIN_CONFIDENCE = 30

        /** `LOREBOOK_ADAPTER_AMBIGUITY_MARGIN`：前两名检测分差小于该值视为格式歧义，交由用户选择而不是自动挑选。 */
        const val AMBIGUITY_MARGIN = 5

        /** PC `lorebookAdapterRegistry` 的注册顺序（顺序不影响结果，排序键才影响）。 */
        val DEFAULT_ADAPTERS: List<LorebookFormatAdapter> = listOf(
            LorebookCanonicalV2Format,
            LorebookNativeV1Format,
            LorebookSillyTavernFormat,
            LorebookCharacterBookFormat,
            LorebookV3Format,
            LorebookRisuFormat,
            LorebookNovelAiFormat,
            LorebookAgnaiFormat,
        )

        /** 进程级共享注册表（对齐 PC 的模块单例；自定义格式请用 [LorebookAdapterRegistry] 新建实例）。 */
        val shared: LorebookAdapterRegistry by lazy { LorebookAdapterRegistry(DEFAULT_ADAPTERS) }

        fun detectLorebookFormats(
            input: Any?,
            file: LorebookFileMetadata? = null,
        ): List<LorebookDetectionResult> = shared.detect(input, file).map { it.detection }

        fun importLorebookWithRegistry(
            input: Any?,
            options: Options,
        ): LorebookRegistryImportResult = shared.importLorebook(input, options)

        fun exportLorebookWithAdapter(
            adapterId: String,
            document: CanonicalLorebook,
        ): LorebookAdapterExportResult? = shared.export(adapterId, document)
    }
}
