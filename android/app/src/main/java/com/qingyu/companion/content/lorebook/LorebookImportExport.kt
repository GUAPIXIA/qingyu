package com.qingyu.companion.content.lorebook

import com.qingyu.companion.content.lorebook.formats.LorebookCharacterBookFormat

/**
 * 阶段 5 S5-02：世界书导入导出的**门面**（业务层唯一该碰的入口）。
 *
 * ## 为什么要有这一层
 * UI 与仓储不该知道 registry、也不该自己决定「先解析文本再选适配器」。
 * 更重要的是 S5-01：`CharacterCardCodec.Draft.embeddedCharacterBook` 拿到的是
 * 角色卡里内嵌的 `character_book` **原文**，它需要的只是「文本 → canonical JSON」，
 * 而不是再来一遍格式判定流程。门面把这条约定固定下来：
 *
 * ```
 * val imported = LorebookImportExport.importEmbeddedCharacterBook(
 *     json = draft.embeddedCharacterBook,
 *     lorebookId = newId,
 *     fallbackName = draft.name,
 * )
 * ```
 *
 * ## 失败以值返回，不以异常返回
 * [Result.Rejected] 携带 PC 同款文案（`无法识别世界书格式；…`、
 * `世界书包含无法导入的结构：…`）。适配器层内部照 PC 抛 [LorebookAdapterError]，
 * 到门面这一层统一收敛成值——Android 的 UI 用 sealed class 分支渲染，
 * 不应该到处 try/catch，也不该有任何一条导入失败路径能把调用方砸穿。
 */
object LorebookImportExport {

    /** 导入结果。[Imported.report] 是给用户看的兼容性报告，不允许丢弃。 */
    sealed interface Result {
        data class Imported(
            val document: CanonicalLorebook,
            val report: LorebookCompatibilityReport,
            val detection: LorebookDetectionResult,
        ) : Result

        /** `reason` 面向用户，与 PC 的拒绝文案逐字一致。 */
        data class Rejected(
            val reason: String,
            val report: LorebookCompatibilityReport? = null,
            val candidates: List<LorebookDetectionResult> = emptyList(),
        ) : Result
    }

    /** 导出结果。 */
    sealed interface ExportResult {
        data class Exported(
            val adapterId: String,
            val formatLabel: String,
            val json: String,
            val report: LorebookCompatibilityReport,
        ) : ExportResult

        data class Unsupported(val adapterId: String, val reason: String) : ExportResult
    }

    /** 可用于导入的默认格式集（等同 PC 的 `lorebookAdapterRegistry` 单例）。 */
    val registry: LorebookAdapterRegistry
        get() = LorebookAdapterRegistry.shared

    /** 候选格式列表（UI 的「手动指定格式」下拉就用它，按 registry 的排序）。 */
    fun availableFormats(): List<LorebookFormatAdapter> = registry.list()

    /** 支持导出的格式（方案 S5-02「对支持格式导出」；映射向导不在其中）。 */
    fun exportableFormats(): List<LorebookFormatAdapter> = registry.list().filter { it.canExport }

    // ---------------------------------------------------------------- 导入

    /**
     * 从 JSON 文本导入：解析 → 检测 → 适配器导入 → 上限裁剪 → 报告合并。
     *
     * @param adapterId 显式指定格式（歧义确认后由用户选）；null 表示走自动检测
     * @param contentHash 缺省按解析后的值算 SHA-256（PC 同规则）
     */
    fun importFromText(
        text: String,
        fallbackName: String,
        id: String? = null,
        fileName: String? = null,
        extension: String? = null,
        now: Double = System.currentTimeMillis().toDouble(),
        contentHash: String? = null,
        adapterId: String? = null,
        registry: LorebookAdapterRegistry = this.registry,
    ): Result {
        if (text.toByteArray(Charsets.UTF_8).size > LorebookLimits.MAX_FILE_BYTES) {
            return Result.Rejected(
                "导入文件超过 ${LorebookLimits.MAX_FILE_BYTES / 1024 / 1024} MiB 上限",
            )
        }
        val parsed = LorebookJson.parse(text)
            ?: return Result.Rejected("无法识别世界书格式；如果知道文件结构，可使用「映射向导导入」手动指定字段路径")
        return importFromValue(
            input = parsed,
            fallbackName = fallbackName,
            id = id,
            fileName = fileName,
            extension = extension,
            now = now,
            contentHash = contentHash,
            adapterId = adapterId,
            registry = registry,
        )
    }

    /** [importFromText] 的已解析版本；角色卡内嵌世界书与备份恢复走这条（文本已在手里）。 */
    fun importFromValue(
        input: Any?,
        fallbackName: String,
        id: String? = null,
        fileName: String? = null,
        extension: String? = null,
        now: Double = System.currentTimeMillis().toDouble(),
        contentHash: String? = null,
        adapterId: String? = null,
        registry: LorebookAdapterRegistry = this.registry,
    ): Result = try {
        val imported = registry.importLorebook(
            input,
            LorebookAdapterRegistry.Options(
                id = id,
                fallbackName = fallbackName,
                file = if (fileName == null && extension == null) null
                else LorebookFileMetadata(fileName, extension),
                now = now,
                contentHash = contentHash,
                adapterId = adapterId,
            ),
        )
        Result.Imported(imported.document, imported.report, imported.detection)
    } catch (error: LorebookAdapterError) {
        Result.Rejected(error.message.orEmpty(), error.report, emptyList())
    } catch (error: IllegalStateException) {
        // 各适配器对「顶层不是对象」的 PC 约定就是抛 Error(message)，文案原样透传
        Result.Rejected(error.message ?: "世界书导入失败")
    }

    /**
     * S5-01 的交接点：角色卡内嵌 `character_book` → canonical v2 文档。
     *
     * 强制用 `character-card.character-book` 适配器，不做检测：
     * 内嵌世界书的格式在卡规范里已经写死了，再检测一遍只会让
     * 「一张卡同时像 ST」这类输入产出与 PC 不同的绑定结果。
     * 空文本返回 `null`（表示这张卡没有内嵌世界书），不视为错误。
     */
    fun importEmbeddedCharacterBook(
        json: String?,
        lorebookId: String?,
        fallbackName: String,
        now: Double = System.currentTimeMillis().toDouble(),
        contentHash: String? = null,
    ): Result? {
        if (json.isNullOrBlank()) return null
        val parsed = LorebookJson.parse(json) ?: return Result.Rejected("内嵌 character_book 不是合法 JSON")
        return importFromValue(
            input = parsed,
            fallbackName = fallbackName,
            id = lorebookId,
            now = now,
            contentHash = contentHash,
            adapterId = LorebookCharacterBookFormat.ID,
        )
    }

    // ---------------------------------------------------------------- 导出

    /**
     * canonical 文档 → 指定格式 JSON 文本。
     *
     * @param pretty 写文件用缩进 2；回库/进同步 payload 用紧凑格式
     */
    fun exportToText(
        document: CanonicalLorebook,
        adapterId: String,
        pretty: Boolean = true,
        registry: LorebookAdapterRegistry = this.registry,
    ): ExportResult {
        val adapter = registry.get(adapterId)
            ?: return ExportResult.Unsupported(adapterId, "未注册世界书格式适配器：$adapterId")
        if (!adapter.canExport) {
            return ExportResult.Unsupported(adapterId, "「${adapter.label}」不支持导出（映射向导只进不出）")
        }
        val exported = adapter.exportLorebook(document)
            ?: return ExportResult.Unsupported(adapterId, "「${adapter.label}」不支持导出（映射向导只进不出）")
        return ExportResult.Exported(
            adapterId = adapterId,
            formatLabel = adapter.label,
            json = if (pretty) LorebookJson.stringifyPretty(exported.value) else LorebookJson.stringify(exported.value),
            report = exported.report,
        )
    }

    /** 文档 → native v1 文本（写回旧版 PC / 兼容存量库）。 */
    fun exportNativeV1Json(document: CanonicalLorebook): String? =
        (exportToText(document, "qingyu.native-v1", pretty = false) as? ExportResult.Exported)?.json

    /**
     * 导出并**立刻再导入**，返回往返后的文档与报告。
     *
     * 这不是多余的便利函数：方案 §S5-02 把「导出再导入语义与 PC fixture 一致」
     * 写成验收条件，而唯一的实测办法就是走一遍这条闭环。
     * 单测里对每个可导出格式都断言它不产生 `rejected`。
     */
    fun roundTrip(
        document: CanonicalLorebook,
        adapterId: String,
        fallbackName: String,
        now: Double = System.currentTimeMillis().toDouble(),
    ): Result {
        val exported = exportToText(document, adapterId, pretty = false)
        return when (exported) {
            is ExportResult.Exported -> importFromText(
                text = exported.json,
                fallbackName = fallbackName,
                now = now,
                adapterId = adapterId,
            )
            is ExportResult.Unsupported -> Result.Rejected(exported.reason)
        }
    }

    // ---------------------------------------------------------------- 报告

    /** 兼容性报告的纯文本摘要（对话框/诊断页直接展示）。 */
    fun describeReport(report: LorebookCompatibilityReport): String = buildString {
        appendLine("格式：${report.formatLabel}（${report.adapterId} · v${report.formatVersion}）")
        appendLine("结论：${report.status.jsonValue}")
        appendLine(
            "映射 ${report.summary.mapped}，保留 ${report.summary.preserved}，" +
                "近似 ${report.summary.approximated}，丢弃 ${report.summary.dropped}，" +
                "拒绝 ${report.summary.rejected}（警告 ${report.summary.warnings}，错误 ${report.summary.errors}）",
        )
        report.issues.forEach {
            appendLine("[${it.severity.jsonValue}] ${it.path} ${it.code}：${it.message}")
        }
    }.trimEnd()

    /** 检测候选的纯文本列表（歧义时让用户挑格式用）。 */
    fun describeCandidates(candidates: List<LorebookDetectionResult>): String = candidates.joinToString("\n") {
        "${it.formatLabel}（${it.confidence}%）：${it.reasons.joinToString("；")}"
    }
}
