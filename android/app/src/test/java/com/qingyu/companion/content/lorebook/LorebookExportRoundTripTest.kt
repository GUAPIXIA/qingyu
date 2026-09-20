package com.qingyu.companion.content.lorebook

import com.qingyu.companion.content.lorebook.formats.LorebookAgnaiFormat
import com.qingyu.companion.content.lorebook.formats.LorebookCanonicalV2Format
import com.qingyu.companion.content.lorebook.formats.LorebookCharacterBookFormat
import com.qingyu.companion.content.lorebook.formats.LorebookNativeV1Format
import com.qingyu.companion.content.lorebook.formats.LorebookNovelAiFormat
import com.qingyu.companion.content.lorebook.formats.LorebookRisuFormat
import com.qingyu.companion.content.lorebook.formats.LorebookSillyTavernFormat
import com.qingyu.companion.content.lorebook.formats.LorebookV3Format
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 5 S5-02：导出与「导出再导入」闭环测试（方案 §S5-02 的验收条件本身）。
 *
 * 每个支持导出的格式都要走 `canonical → 外部格式 → canonical`，断言：
 * 1. 闭环不产生 `rejected`（能导出的格式必须还能导回来）；
 * 2. 条目数、正文、关键词、启用状态、插入位置逐条不变；
 * 3. 第一份文档里的 `foreign` 在闭环后仍在（未知字段不会「导一次少一批」）。
 *
 * 已知且**刻意保留**的信息差（PC 同规则，不是 Android 的偏差）：
 * - Risu / NovelAI / Agnai 没有条目级插入位置 → 非 `prompt_end` 的条目导出时报
 *   `*_insertion_unsupported`，闭环后位置退化成 `prompt_end`；
 * - Agnai 没有常驻字段 → `constant` 条目闭环后按关键词触发；
 * - character_book 导出用 `vectorized` 布尔近似检索模式，`semanticRequired` 会落成 `hybrid`。
 * 这些差异都有报告，测试则**断言报告里确实有**——静默退化才是方案 §2 禁止的事。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class LorebookExportRoundTripTest {

    private val formatsSupportingExport = listOf(
        LorebookCanonicalV2Format.ID,
        LorebookNativeV1Format.ID,
        LorebookSillyTavernFormat.ID,
        LorebookCharacterBookFormat.ID,
        LorebookV3Format.ID,
        LorebookRisuFormat.ID,
        LorebookNovelAiFormat.ID,
        LorebookAgnaiFormat.ID,
    )

    @Test
    fun everyRegisteredFormatDeclaresExportSupport() {
        formatsSupportingExport.forEach { adapterId ->
            val adapter = LorebookImportExport.registry.get(adapterId)
            assertNotNull("registry 应包含 $adapterId", adapter)
            assertTrue("$adapterId 应支持导出", adapter?.canExport == true)
        }
        assertEquals(
            "导出格式清单应与注册表一致",
            formatsSupportingExport.sorted(),
            LorebookImportExport.exportableFormats().map { it.id }.sorted(),
        )
    }

    @Test
    fun exportThenReimportPreservesEntrySemantics() {
        listOf(
            "native-v1-full",
            "sillytavern-full",
            "character-book-full",
            "lorebook-v3-full",
            "risu-full",
            "novelai-full",
            "agnai-full",
        ).forEach { fixtureId ->
            val original = importOf(fixtureId)
            val adapterId = requireNotNull(original.source?.adapterId)
            val roundTripped = LorebookImportExport.roundTrip(
                document = original,
                adapterId = adapterId,
                fallbackName = original.name,
                now = 1_700_000_000_000.0,
            )
            val imported = roundTripped as? LorebookImportExport.Result.Imported
            assertNotNull(
                "$fixtureId 经 $adapterId 导出后应能导回：${(roundTripped as? LorebookImportExport.Result.Rejected)?.reason}",
                imported,
            )
            val back = imported!!.document
            assertEquals("$fixtureId 闭环条目数", original.entries.size, back.entries.size)
            assertEquals("$fixtureId 闭环书名", original.name, back.name)
            assertEquals("$fixtureId 闭环扫描深度", original.defaults.scanDepth, back.defaults.scanDepth, 1e-9)
            assertEquals("$fixtureId 闭环递归开关", original.defaults.recursiveScanning, back.defaults.recursiveScanning)
            assertEquals("$fixtureId 闭环 token 预算", original.defaults.tokenBudget, back.defaults.tokenBudget)
            original.entries.forEachIndexed { index, entry ->
                val mirrored = back.entries[index]
                assertEquals("$fixtureId[$index] 正文", entry.content, mirrored.content)
                assertEquals("$fixtureId[$index] 启用", entry.enabled, mirrored.enabled)
                assertEquals("$fixtureId[$index] 顺序", entry.scheduling.order, mirrored.scheduling.order, 1e-9)
                assertEquals(
                    "$fixtureId[$index] 主关键词（别名与主词同权）",
                    entry.activation.primaryKeys + entry.activation.aliases,
                    mirrored.activation.primaryKeys + mirrored.activation.aliases,
                )
                assertEquals(
                    "$fixtureId[$index] 二级关键词",
                    entry.activation.secondaryKeys,
                    mirrored.activation.secondaryKeys,
                )
                assertEquals(
                    "$fixtureId[$index] 常驻性",
                    entry.activation.mode,
                    mirrored.activation.mode,
                )
                assertEquals(
                    "$fixtureId[$index] 概率",
                    entry.scheduling.probability,
                    mirrored.scheduling.probability,
                    1e-9,
                )
            }
            assertForeignSurvivesRoundTrip(fixtureId, original, back)
        }
    }

    @Test
    fun canonicalRoundTripIsByteStableForTheDocumentShape() {
        val original = importOf("sillytavern-full")
        val exported = LorebookImportExport.exportToText(original, LorebookCanonicalV2Format.ID, pretty = false)
            as LorebookImportExport.ExportResult.Exported
        val back = LorebookImportExport.importFromText(
            text = exported.json,
            fallbackName = original.name,
        ) as LorebookImportExport.Result.Imported
        // canonical 是最外层信封，闭环必须逐字段等值（含 foreign 与未知顶层键）
        assertEquals(original.toJsonMap(), back.document.toJsonMap())
        assertEquals(LorebookCompatibilityStatus.EXACT, back.report.status)
    }

    @Test
    fun exportFormatsThatCannotPlaceEntriesReportTheDegradation() {
        // 插入位置无法表达时必须有 approximated 报告，而不是安静地丢掉
        val document = importOf("character-book-full")
            .let { source ->
                source.copy(
                    entries = source.entries.map { it.copy(insertion = LorebookInsertion.chat(2.0, "user")) },
                )
            }
        listOf(LorebookRisuFormat.ID, LorebookNovelAiFormat.ID, LorebookAgnaiFormat.ID).forEach { adapterId ->
            val exported = LorebookImportExport.exportToText(document, adapterId)
                as LorebookImportExport.ExportResult.Exported
            assertTrue(
                "$adapterId 应报告插入位置无法表达，实际 ${exported.report.issues.map { it.code }}",
                exported.report.issues.any { it.code.endsWith("insertion_unsupported") },
            )
            assertEquals(LorebookCompatibilityStatus.APPROXIMATED, exported.report.status)
        }
    }

    @Test
    fun unknownFieldsComeBackOutOfExport() {
        val document = importOf("character-book-unknown-extensions")
        val adapterId = LorebookCharacterBookFormat.ID
        val exported = LorebookImportExport.exportToText(document, adapterId)
            as LorebookImportExport.ExportResult.Exported
        assertTrue(
            "导出报告要说明合并了多少未知字段",
            exported.report.issues.any { it.code == "foreign_exported" },
        )
        val back = LorebookImportExport.importFromText(
            text = exported.json,
            fallbackName = document.name,
            adapterId = adapterId,
        ) as LorebookImportExport.Result.Imported
        val mirrored = back.document.entries.first().foreign?.get(adapterId)
        @Suppress("UNCHECKED_CAST")
        val extensions = (mirrored as Map<String, Any?>)["extensions"] as Map<String, Any?>
        assertNotNull("future_entry_field 必须随导出回来", extensions["future_entry_field"])
    }

    @Test
    fun nativeV1ExportIsReadableByTheLegacyValidatorAndCarriesRuntimeHints() {
        val document = importOf("sillytavern-full")
        val exported = LorebookImportExport.exportToText(document, LorebookNativeV1Format.ID, pretty = false)
            as LorebookImportExport.ExportResult.Exported
        val validation = LorebookNativeV1.validate(LorebookJson.parse(exported.json))
        assertTrue("native v1 导出必须过 v1 校验：${validation.issues.take(3)}", validation.valid)
        val entry = LorebookJson.record(
            LorebookJson.list(LorebookJson.record(LorebookJson.parse(exported.json))?.get("entries"))?.first(),
        )
        assertNotNull("回编译要带 runtime（完整插入位置的唯一载体）", LorebookJson.record(entry?.get("runtime")))
    }

    @Test
    fun unsupportedAdapterExportIsAnExplicitRejection() {
        val document = importOf("native-v1-minimal")
        val missing = LorebookImportExport.exportToText(document, "no.such.adapter")
        assertTrue(missing is LorebookImportExport.ExportResult.Unsupported)
        assertEquals(
            "未注册世界书格式适配器：no.such.adapter",
            (missing as LorebookImportExport.ExportResult.Unsupported).reason,
        )
        assertNull(LorebookImportExport.registry.get("no.such.adapter"))
    }

    private fun importOf(fixtureId: String): CanonicalLorebook {
        val result = LorebookImportExport.importFromValue(
            input = LorebookFixtures.value(fixtureId),
            fallbackName = "fallback-$fixtureId",
            id = "fixture-$fixtureId",
            now = 1_700_000_000_000.0,
            contentHash = "hash-$fixtureId",
        )
        return (result as LorebookImportExport.Result.Imported).document
    }

    /** 闭环后 foreign 命名空间只能多不能少（少了就是「导一次丢一批」）。 */
    private fun assertForeignSurvivesRoundTrip(
        fixtureId: String,
        original: CanonicalLorebook,
        back: CanonicalLorebook,
    ) {
        /**
         * 保留区的**键名集合**。
         *
         * 原先只比数量，那有两个问题：字段被替换成另一个未知键时数量不变、断言静默放过；
         * 而且失败消息只说「0 对 1」，看不出是哪个键挤进来的。
         * 「模型外的键原样、原序保留」是方案 §2 对导入导出的明确要求，所以要比名字。
         */
        fun namespaceKeys(foreign: Map<String, Any?>?, adapterId: String): Set<String> {
            val namespace = LorebookJson.record(foreign?.get(adapterId)) ?: return emptySet()
            val payload = LorebookJson.record(namespace["payload"]) ?: namespace
            val fields = LorebookJson.record(payload["fields"])?.keys ?: emptySet()
            val extensions = LorebookJson.record(payload["extensions"])?.keys ?: emptySet()
            return if (fields.isNotEmpty() || extensions.isNotEmpty()) fields + extensions else namespace.keys
        }
        val adapterId = requireNotNull(original.source?.adapterId)

        /**
         * 往返允许**新增**的键（不允许多一个别的，也不允许丢任何一个）。
         *
         * `risu` 的 `extentions` 是 PC 侧行为，不是 Android 漂移：`risu.ts:169` 无条件写
         * `extentions: {…}`，所以导出再导入时这个键会新进保留区。**PC 自己生成的 golden 就是这样**
         * （`content-io/lorebook-import-roundtrip.json` 的 `risu` 用例：首导入
         * `fields=["text"]`，往返后 `fields=["text","extentions"]`）。
         * 把它列成显式白名单而不是改回「只比数量」，是因为数量断言会放过
         * 「字段被换成另一个未知键」这种真实损坏。
         */
        val allowedGrowth: Set<String> = if (adapterId == "risu.lorebook") setOf("extentions") else emptySet()

        fun assertNamespacePreserved(where: String, before: Map<String, Any?>?, after: Map<String, Any?>?) {
            val lost = namespaceKeys(before, adapterId) - namespaceKeys(after, adapterId)
            val grew = namespaceKeys(after, adapterId) - namespaceKeys(before, adapterId)
            assertTrue("$where 保留区字段在往返后丢失：$lost", lost.isEmpty())
            assertTrue("$where 保留区多出了未登记的键：$grew（已登记：$allowedGrowth）", allowedGrowth.containsAll(grew))
        }
        assertNamespacePreserved("$fixtureId 书级", original.foreign, back.foreign)
        original.entries.forEachIndexed { index, entry ->
            assertNamespacePreserved(
                "$fixtureId[$index] 条目",
                entry.foreign,
                back.entries[index].foreign,
            )
        }
    }
}
