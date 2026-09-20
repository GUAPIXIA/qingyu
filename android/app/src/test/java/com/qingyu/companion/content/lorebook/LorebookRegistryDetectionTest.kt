package com.qingyu.companion.content.lorebook

import com.qingyu.companion.content.lorebook.formats.LorebookCharacterBookFormat
import com.qingyu.companion.content.lorebook.formats.LorebookSillyTavernFormat
import com.qingyu.companion.content.lorebook.formats.LorebookNativeV1Format
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 5 S5-02：格式检测与 registry 选择规则测试（方案 §6.1「不静默猜测」）。
 *
 * 三条规则各自都要有用例，因为它们对应三种**不同的用户后果**：
 * 1. 第一名低于 [LorebookAdapterRegistry.MIN_CONFIDENCE] → 整份拒绝，
 *    并提示改用映射向导；
 * 2. 前两名分差小于 [LorebookAdapterRegistry.AMBIGUITY_MARGIN] → 仍然导入，
 *    但报告里必须有 `ambiguous_format`，说清「也接近谁、为什么选了现在这个」；
 * 3. 用户显式指定格式 → 跳过检测，理由记「用户手动指定格式」，且不再报歧义。
 *
 * 第 2 条最容易在移植时丢掉：它不影响 `document`，只影响 `report`，
 * 所以只比对条目数的测试永远发现不了「Android 不再提示歧义」这种退化。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class LorebookRegistryDetectionTest {

    private fun candidatesOf(input: Any?, file: LorebookFileMetadata? = null) =
        LorebookAdapterRegistry.detectLorebookFormats(input, file)

    @Test
    fun eachFormatScoresOneHundredOnItsOwnFixture() {
        mapOf(
            "native-v1-minimal" to LorebookNativeV1Format.ID,
            "sillytavern-minimal" to LorebookSillyTavernFormat.ID,
            "character-book-minimal" to LorebookCharacterBookFormat.ID,
            "lorebook-v3-minimal" to "character-card.lorebook-v3",
            "risu-minimal" to "risu.lorebook",
            "novelai-minimal" to "novelai.lorebook",
            "agnai-minimal" to "agnai.memory-book",
        ).forEach { (fixtureId, expectedAdapterId) ->
            val top = candidatesOf(LorebookFixtures.value(fixtureId)).firstOrNull()
            assertNotNull("$fixtureId 应被识别", top)
            assertEquals("$fixtureId 首位候选", expectedAdapterId, top!!.adapterId)
            assertTrue("$fixtureId 置信度应足够高，实际 ${top.confidence}", top.confidence >= 80)
        }
    }

    @Test
    fun fileNameHintsMoveTheScoreAndAreExplanatory() {
        // PC 每个 adapter 的 confidence 都是 `Math.min(100, 基础分 + 文件名提示分)`
        // （sillyTavern.ts、characterBook.ts、nativeV1.ts 同形）：基础分 97 的样本再加 20
        // 必然撞封顶。所以「+20」要用未饱和样本验，「封顶」单独钉一条——
        // 只断言裸加法等于把 PC 的 min(100, …) 写没了。
        val objectOnlyEntries = linkedMapOf<String, Any?>(
            "entries" to linkedMapOf("1" to linkedMapOf("comment" to "甲", "content" to "正文")),
        )
        val plain = candidatesOf(objectOnlyEntries).first { it.adapterId == LorebookSillyTavernFormat.ID }
        val hinted = candidatesOf(
            objectOnlyEntries,
            LorebookFileMetadata(fileName = "world_info.json"),
        ).first { it.adapterId == LorebookSillyTavernFormat.ID }
        assertEquals("文件名提示应加 20 分", plain.confidence + 20, hinted.confidence)
        assertTrue("理由要说清分数从哪来", hinted.reasons.any { it.contains("文件名") })

        val saturated = candidatesOf(
            LorebookFixtures.value("sillytavern-minimal"),
            LorebookFileMetadata(fileName = "world_info.json"),
        ).first()
        assertEquals("超过 100 必须停在 100（PC 的 Math.min）", 100, saturated.confidence)

        val nativeHinted = candidatesOf(
            LorebookFixtures.value("native-v1-minimal"),
            LorebookFileMetadata(fileName = "my-native-v1-book.json"),
        ).first()
        assertTrue(nativeHinted.reasons.contains("文件名提示 native-v1"))
    }

    @Test
    fun nearTieIsReportedAsAmbiguousInsteadOfSilentlyPicking() {
        // 打分按 PC 逐常数算：character_book 含 keys/insertion_order → 96；
        // native 有 scanDepth(72) + 原生 keywords(+23) → 95。分差 1 < AMBIGUITY_MARGIN(5)，
        // 必须报歧义，而不是装作只有唯一答案。
        // （少了 scanDepth 就只有 45+23=68，PC 同样不认为歧义——那时第一名是独占的。）
        val input = linkedMapOf<String, Any?>(
            "name" to "两份都像",
            "scanDepth" to 4L,
            "entries" to listOf(
                linkedMapOf(
                    "keys" to listOf("A"),
                    "keywords" to listOf("A"),
                    "content" to "正文",
                    "insertion_order" to 1,
                ),
            ),
        )
        val candidates = candidatesOf(input)
        assertTrue("前两名应形成歧义：${candidates.map { it.adapterId to it.confidence }}",
            candidates.size >= 2 &&
                candidates[1].confidence >= candidates[0].confidence - LorebookAdapterRegistry.AMBIGUITY_MARGIN)

        val result = LorebookImportExport.importFromValue(input = input, fallbackName = "两份都像")
        val imported = result as LorebookImportExport.Result.Imported
        val ambiguity = imported.report.issues.filter { it.code == "ambiguous_format" }
        assertEquals("必须恰好一条歧义告警", 1, ambiguity.size)
        assertTrue(
            "告警要点名第二个候选与选择依据",
            ambiguity.first().message.contains("格式也接近") &&
                ambiguity.first().message.contains("已按优先级选择"),
        )
        // 胜出的必须就是检测第一名：报告与产物不能来自两个不同的适配器
        assertEquals(imported.detection.adapterId, imported.document.source?.adapterId)
    }

    /**
     * 既像原生 v1 又像 character_book 的样本。
     *
     * 它必须**同时**是合法的 native v1（`shared/lorebook/nativeV1.ts` 要求书级
     * id/name/description/enabled/scanDepth 与条目级 id/keywords/content/position/order/
     * probability/enabled 全齐），否则「显式指定 v1 适配器」这条路径会在 PC 自己的
     * `native_v1_invalid` 上先失败，测不到想测的选择逻辑；而条目里的 `keys`
     * 就是让它同时像 character_book 的那个外部字段。
     */
    private fun mixedV1Book(name: String) = linkedMapOf<String, Any?>(
        "id" to "lb-mixed",
        "name" to name,
        "description" to "",
        "enabled" to true,
        "scanDepth" to 4L,
        "entries" to listOf(
            linkedMapOf(
                "id" to "e1",
                "keywords" to listOf("A"),
                "keys" to listOf("A"),
                "content" to "正文",
                "position" to "before_char",
                "order" to 1L,
                "probability" to 100L,
                "enabled" to true,
            ),
        ),
    )

    @Test
    fun explicitAdapterIdSkipsDetectionAndAmbiguityWarning() {
        val input = mixedV1Book("两份都像")
        val forced = LorebookImportExport.importFromValue(
            input = input,
            fallbackName = "两份都像",
            adapterId = LorebookNativeV1Format.ID,
        ) as LorebookImportExport.Result.Imported
        assertEquals(LorebookNativeV1Format.ID, forced.document.source?.adapterId)
        assertEquals("用户指定后不应再报歧义", 0, forced.report.issues.count { it.code == "ambiguous_format" })
        assertEquals(listOf("用户手动指定格式"), forced.detection.reasons)
        assertEquals(100, forced.detection.confidence)
    }

    @Test
    fun unrecognisableInputIsRejectedWithThePcMessage() {
        val rejected = LorebookImportExport.importFromValue(
            input = linkedMapOf("foo" to 1L),
            fallbackName = "不认识",
        ) as LorebookImportExport.Result.Rejected
        assertEquals(
            "无法识别世界书格式；如果知道文件结构，可使用「映射向导导入」手动指定字段路径",
            rejected.reason,
        )
        assertNull(rejected.report)
    }

    @Test
    fun candidatesBelowTheConfidenceFloorAreRejectedEvenWhenDetected() {
        // 用一个只会给 20 分的假适配器验证阈值分支本身（而不是靠某个真实格式恰好低分）
        val weak = object : LorebookFormatAdapter {
            override val id = "test.weak"
            override val label = "弱候选"
            override val formatVersion = "1"
            override val priority = 10
            override fun detect(input: Any?, file: LorebookFileMetadata?) = LorebookDetectionResult(
                id, label, formatVersion, 20, listOf("只有一点像"), emptyList(),
            )

            override fun importLorebook(input: Any?, context: LorebookImportContext) =
                error("阈值以下不应调用到导入")

            override fun exportLorebook(document: CanonicalLorebook): LorebookAdapterExportResult? = null
        }
        val registry = LorebookAdapterRegistry(listOf(weak))
        val thrown = runCatching {
            registry.importLorebook(
                linkedMapOf<String, Any?>("entries" to emptyList<Any?>()),
                LorebookAdapterRegistry.Options(fallbackName = "x"),
            )
        }.exceptionOrNull()
        assertTrue(
            "低于 ${LorebookAdapterRegistry.MIN_CONFIDENCE} 分必须拒绝",
            thrown is LorebookAdapterError &&
                thrown.message == "无法识别世界书格式；如果知道文件结构，可使用「映射向导导入」手动指定字段路径",
        )
    }

    @Test
    fun conflictsDetectedDuringScanReachTheReportAsWarnings() {
        // 同一份条目里既有原生字段又有外部字段：native 检测会给出 conflict，报告必须带上
        val input = mixedV1Book("混着写")
        val detection = candidatesOf(input).first { it.adapterId == LorebookNativeV1Format.ID }
        assertTrue(detection.conflicts.isNotEmpty())
        val imported = LorebookImportExport.importFromValue(
            input = input,
            fallbackName = "混着写",
            adapterId = LorebookNativeV1Format.ID,
        )
        // 显式指定格式时不跑检测，因此 conflict 不会进报告——这是 PC 的行为，测试把它钉住
        assertTrue(imported is LorebookImportExport.Result.Imported)
        assertEquals(
            0,
            (imported as LorebookImportExport.Result.Imported).report.issues.count { it.code == "format_conflict" },
        )
        val auto = LorebookImportExport.importFromValue(input = input, fallbackName = "混着写")
        val autoReport = (auto as LorebookImportExport.Result.Imported).report
        assertEquals(
            "自动检测时冲突必须进报告",
            1,
            autoReport.issues.count { it.code == "format_conflict" },
        )
    }

    @Test
    fun registryRejectsEmptyAdapterIdAndUnknownExportTarget() {
        val registry = LorebookAdapterRegistry()
        val anonymous = object : LorebookFormatAdapter {
            override val id = "  "
            override val label = "无 id"
            override val formatVersion = "1"
            override val priority = 1
            override fun detect(input: Any?, file: LorebookFileMetadata?) =
                LorebookDetectionResult.mismatch(id, label, formatVersion)

            override fun importLorebook(input: Any?, context: LorebookImportContext) =
                error("不应被调用")

            override fun exportLorebook(document: CanonicalLorebook): LorebookAdapterExportResult? = null
        }
        assertEquals("世界书 adapter id 不能为空", runCatching { registry.register(anonymous) }.exceptionOrNull()?.message)
        val missing = runCatching { registry.export("nope", CanonicalLorebook()) }.exceptionOrNull()
        assertTrue(missing is LorebookAdapterError && missing.message == "未注册世界书格式适配器：nope")
    }

    @Test
    fun importIsIdempotentForTheSameInputBytes() {
        val input = LorebookFixtures.value("sillytavern-full")
        val first = LorebookImportExport.importFromValue(
            input = input, fallbackName = "书", id = "lb1", now = 5.0, contentHash = "abc",
        ) as LorebookImportExport.Result.Imported
        val second = LorebookImportExport.importFromValue(
            input = input, fallbackName = "书", id = "lb1", now = 5.0, contentHash = "abc",
        ) as LorebookImportExport.Result.Imported
        // 同一份输入必须得到同一份产物：任何一次随机 id / 时间都会让同步哈希漂移
        assertEquals(first.document.toJsonMap(), second.document.toJsonMap())
    }
}
