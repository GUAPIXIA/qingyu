package com.qingyu.companion.content.lorebook

import com.qingyu.companion.content.lorebook.formats.LorebookAgnaiFormat
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
 * 阶段 5 S5-02：逐格式导入结果与 `foreign` 保留的一致性测试。
 *
 * ## 为什么需要 Robolectric
 * 这一层的 JSON ⇄ Kotlin 转换全部经 [LorebookJson] → `JsonValues` → `org.json`。
 * `org.json` 在 Android 是框架类，纯 JVM 单测里（`returnDefaultValues` 模式下）
 * 只会拿到无意义的默认值，所以本包所有用例都跑在 Robolectric 下
 * （与 `chatcore/ChatLorebookCompileTest` 同一套配置）。
 *
 * ## 断言的两类内容
 * 1. **canonical 字段**：位置、深度、关键词、key logic、概率、递归、检索模式——
 *    这些直接决定编辑器与运行时的行为；
 * 2. **`foreign` 保留区**：未知字段必须按 `<adapterId> → {fields|extensions}` 的
 *    形状存下来。只断言「条目数对不对」的测试放不住方案 §2 的未知字段保留要求。
 *
 * fixture 一律是 PC 的同一批字节（见 [LorebookFixtures]），
 * 因此这里失败就等于「Android 的映射与 PC 分叉」，而不是「本地测试期望写错了」。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class LorebookFormatImportTest {

    /**
     * 与 PC `lorebookAdapterRegistry.test.ts#importFixture` 同样的调用条件：
     * 它每次都把 fixture 的相对路径当 `fileName` 传进去，而路径里的
     * `native-v1` / `character-book` / `world_info` 等字样正是各 adapter 的文件名提示来源。
     * 不传 fileName 就等于拿另一个输入去比 PC 的冻结结果，选出的 adapter 会不同。
     */
    private fun fileNameOf(fixtureId: String): String = LorebookFixtures.entry(fixtureId).path

    private fun import(fixtureId: String, adapterId: String? = null): CanonicalLorebook {
        val result = LorebookImportExport.importFromValue(
            input = LorebookFixtures.value(fixtureId),
            fallbackName = "fallback-$fixtureId",
            id = "fixture-$fixtureId",
            now = 1_700_000_000_000.0,
            contentHash = "hash-$fixtureId",
            fileName = fileNameOf(fixtureId),
            adapterId = adapterId,
        )
        assertTrue(
            "$fixtureId 导入应成功：${(result as? LorebookImportExport.Result.Rejected)?.reason}",
            result is LorebookImportExport.Result.Imported,
        )
        return (result as LorebookImportExport.Result.Imported).document
    }

    private fun reportOf(fixtureId: String): LorebookCompatibilityReport {
        val result = LorebookImportExport.importFromValue(
            input = LorebookFixtures.value(fixtureId),
            fallbackName = "fallback-$fixtureId",
            id = "fixture-$fixtureId",
            now = 1_700_000_000_000.0,
            contentHash = "hash",
            fileName = fileNameOf(fixtureId),
        )
        return (result as LorebookImportExport.Result.Imported).report
    }

    /** 走 registry 的导入结果（保留 Imported/Rejected 分支给需要断言拒绝的用例）。 */
    private fun importResult(fixtureId: String): LorebookImportExport.Result =
        LorebookImportExport.importFromValue(
            input = LorebookFixtures.value(fixtureId),
            fallbackName = fixtureId,
            fileName = fileNameOf(fixtureId),
        )

    // ------------------------------------------------------------ catalog 冻结的粗粒度期望

    @Test
    fun everyCatalogFixtureMatchesPcNameAndEntryCount() {
        // PC `formatFixtures.test.ts` 只把 **P0 四个格式族**的书名/条目数冻结进 catalog
        // （`it.each(catalog.fixtures.filter(P0_FORMATS.includes(...)))`）。
        // P1（risu / novelai / agnai）的样本本身没有书级名字——
        // `common.ts` 走的是 `context.fallbackName`，所以 catalog 里那几个
        // 「Risu 最小世界书样本」是旧归一化器的字段，不是 registry 的期望值。
        // 名字因此只对 P0 断言，条目数与文档 id 对全部样本断言。
        val p0Formats = setOf(
            "qingyu-native-v1", "sillytavern-world-info", "character-book-v2-v3", "lorebook-v3",
        )
        LorebookFixtures.catalog.filter { it.importable && it.kind != "invalid" }.forEach { fixture ->
            val document = import(fixture.id)
            if (fixture.format in p0Formats) {
                assertEquals("${fixture.id} 书名", fixture.name, document.name)
            }
            assertEquals("${fixture.id} 条目数", fixture.entries, document.entries.size)
            assertEquals("${fixture.id} 文档 id", "fixture-${fixture.id}", document.id)
        }
    }

    // ------------------------------------------------------------ SillyTavern World Info

    @Test
    fun sillyTavernFullMapsEveryRuntimeField() {
        val document = import("sillytavern-full")
        assertEquals(LorebookSillyTavernFormat.ID, document.source?.adapterId)
        assertEquals(LorebookSillyTavernFormat.VERSION, document.source?.formatVersion)
        assertEquals(6.0, document.defaults.scanDepth, 1e-9)
        assertTrue(document.defaults.recursiveScanning)
        assertNull("ST 样本没有 token_budget", document.defaults.tokenBudget)

        val entry = document.entries.first()
        // uid 10 → 归一化 id 是文本 "10"，sourceId 保留原始数字（导出时要按它回填 uid）
        assertEquals("10", entry.id)
        assertEquals(10L, entry.sourceId)
        assertEquals(listOf("王城", "首都"), entry.activation.primaryKeys)
        assertEquals(listOf("帝国", "皇帝"), entry.activation.secondaryKeys)
        // selectiveLogic 3 → and_all
        assertEquals("and_all", entry.activation.secondaryLogic)
        assertEquals("constant", entry.activation.mode)
        assertEquals("protected", entry.activation.budgetTier)
        assertEquals("any", entry.activation.keyLogic)
        assertEquals("hybrid", entry.activation.retrieval)
        assertTrue(entry.activation.caseSensitive)
        assertTrue(!entry.activation.wholeWords)
        assertTrue(!entry.activation.regex.enabled)
        assertEquals("chat 深度与角色取自 position=4", LorebookInsertion.chat(2.0, "system"), entry.insertion)
        assertEquals(250.0, entry.scheduling.order, 1e-9)
        assertEquals(80.0, entry.scheduling.probability, 1e-9)
        assertEquals(1.0, entry.scheduling.scanDepth!!, 1e-9)
        assertTrue(entry.scheduling.recursion.exclude)
        assertTrue(entry.scheduling.recursion.prevent)
        assertEquals(2.0, entry.scheduling.recursion.minDepth, 1e-9)
        assertEquals(listOf("王族", "地点"), entry.scheduling.groups.map { it.name })
        assertEquals(250.0, entry.scheduling.groups.first().weight, 1e-9)
        assertTrue(entry.scheduling.groups.first().prioritized)
        assertTrue(entry.scheduling.groupScoring)
        assertEquals(3.0, entry.scheduling.sticky!!, 1e-9)
        assertEquals(2.0, entry.scheduling.cooldown!!, 1e-9)
        assertEquals(1.0, entry.scheduling.delay!!, 1e-9)
        assertEquals(listOf("normal", "continue"), entry.scheduling.generationTriggers)
        assertNotNull(entry.scheduling.characterFilter)
        assertTrue(!entry.scheduling.characterFilter!!.exclude)
        assertEquals(listOf("Alice"), entry.scheduling.characterFilter!!.names)
        assertEquals(listOf("royal"), entry.scheduling.characterFilter!!.tags)

        // 第二条：position=2 是作者注释锚点，vectorized 但无关键词 → 纯语义
        val second = document.entries[1]
        assertEquals(LorebookInsertion.prompt("authors_note_top"), second.insertion)
        assertEquals("semanticPreferred", second.activation.retrieval)
        assertEquals(100.0, second.scheduling.probability, 1e-9)
    }

    @Test
    fun sillyTavernUnknownFieldsGoToNamespacedForeign() {
        val document = import("sillytavern-unknown-extensions")
        val bookForeign = document.foreign?.get(LorebookSillyTavernFormat.ID)
        assertNotNull("书级未知字段必须留在 foreign", bookForeign)
        @Suppress("UNCHECKED_CAST")
        val payload = (bookForeign as Map<String, Any?>)["payload"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val fields = payload["fields"] as Map<String, Any?>
        assertTrue("futureBookOption 必须在保留区", fields.containsKey("futureBookOption"))

        val entry = document.entries.first()
        @Suppress("UNCHECKED_CAST")
        val entryForeign = entry.foreign?.get(LorebookSillyTavernFormat.ID) as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val extensions = entryForeign["extensions"] as Map<String, Any?>
        assertEquals(
            "extensions 内未消费的键单独成组",
            "vNext",
            extensions["future_trigger"],
        )
        assertTrue("report 必须说这是保留而非丢弃", reportOf("sillytavern-unknown-extensions").status ==
            LorebookCompatibilityStatus.PRESERVED)
    }

    // ------------------------------------------------------------ CCv2/CCv3 character_book

    @Test
    fun characterBookPrefersExtensionsOverTopLevel() {
        val document = import("character-book-full")
        assertEquals(LorebookCharacterBookFormat.ID, document.source?.adapterId)
        assertEquals(6.0, document.defaults.scanDepth, 1e-9)
        assertEquals(1024.0, document.defaults.tokenBudget!!, 1e-9)
        assertTrue(!document.defaults.recursiveScanning)

        val entry = document.entries.first()
        assertEquals("capital", entry.id)
        // 顶层 position="after_char" 与 extensions.position=4 冲突 → 按 CC 规则取后者
        assertEquals(LorebookInsertion.chat(3.0, "user"), entry.insertion)
        assertEquals(65.0, entry.scheduling.probability, 1e-9)
        assertTrue(entry.activation.regex.enabled)
        assertEquals("hybrid", entry.activation.retrieval)
        assertEquals("and_any", entry.activation.secondaryLogic)
        assertTrue(entry.scheduling.ignoreBudget)
        assertEquals(2.0, entry.scheduling.scanDepth!!, 1e-9)
        assertEquals(1.0, entry.scheduling.recursion.minDepth, 1e-9)
        assertTrue(entry.scheduling.characterFilter!!.exclude)
        assertEquals(listOf("continue"), entry.scheduling.generationTriggers)
        assertEquals(4.0, entry.scheduling.sticky!!, 1e-9)
        // position 冲突必须显式报出来，不能静默选一个
        assertTrue(
            "report 应含 position_conflict",
            reportOf("character-book-full").issues.any { it.code == "position_conflict" },
        )

        val second = document.entries[1]
        assertEquals("law", second.id)
        assertEquals("constant", second.activation.mode)
        assertEquals(LorebookInsertion.prompt("before_character"), second.insertion)
    }

    @Test
    fun characterBookKeepsUnknownExtensionEntries() {
        val document = import("character-book-unknown-extensions")
        val entry = document.entries.first()
        @Suppress("UNCHECKED_CAST")
        val namespace = entry.foreign?.get(LorebookCharacterBookFormat.ID) as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val extensions = namespace["extensions"] as Map<String, Any?>
        assertNotNull(extensions["future_entry_field"])
    }

    // ------------------------------------------------------------ lorebook_v3

    @Test
    fun lorebookV3UnwrapsEnvelopeAndRecordsSpecVersion() {
        val document = import("lorebook-v3-full")
        assertEquals(LorebookV3Format.ID, document.source?.adapterId)
        assertEquals("spec_version 必须进 source.formatVersion", "3.0", document.source?.formatVersion)
        assertEquals(8.0, document.defaults.scanDepth, 1e-9)
        assertEquals(2048.0, document.defaults.tokenBudget!!, 1e-9)
        assertEquals("7", document.entries.first().id)
        assertEquals(90.0, document.entries.first().scheduling.probability, 1e-9)
        assertEquals("constant", document.entries.first().activation.mode)
        assertTrue(!document.entries[1].enabled)
    }

    @Test
    fun lorebookV3KeepsWrapperKeysOutsideTheEnvelope() {
        val withExtra = linkedMapOf<String, Any?>(
            "spec" to "lorebook_v3",
            "spec_version" to "3.1",
            "data" to linkedMapOf(
                "name" to "包装测试",
                "entries" to listOf(
                    linkedMapOf("keys" to listOf("A"), "content" to "正文", "id" to "a"),
                ),
            ),
            "thirdPartyField" to linkedMapOf("kept" to true),
        )
        val result = LorebookImportExport.importFromValue(
            input = withExtra,
            fallbackName = "包装测试",
            now = 1.0,
            contentHash = "h",
        ) as LorebookImportExport.Result.Imported
        assertEquals("3.1", result.document.source?.formatVersion)
        @Suppress("UNCHECKED_CAST")
        val namespace = result.document.foreign?.get(LorebookV3Format.ID) as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val wrapper = namespace["wrapper"] as Map<String, Any?>
        assertNotNull("信封上的第三方字段必须进 wrapper 保留区", wrapper["thirdPartyField"])
    }

    @Test
    fun lorebookV3RejectsInvalidWrapper() {
        val result = LorebookImportExport.importFromValue(
            input = linkedMapOf("spec" to "lorebook_v3"),
            fallbackName = "坏包装",
        )
        assertTrue(result is LorebookImportExport.Result.Rejected)
        assertEquals("lorebook_v3 包装结构无效", (result as LorebookImportExport.Result.Rejected).reason)
    }

    // ------------------------------------------------------------ native v1

    @Test
    fun nativeV1FullCarriesLegacyRuntimeSemantics() {
        val document = import("native-v1-full")
        assertEquals(LorebookNativeV1Format.ID, document.source?.adapterId)
        assertEquals("1", document.source?.formatVersion)
        assertEquals(8.0, document.defaults.scanDepth, 1e-9)
        assertTrue(!document.defaults.recursiveScanning)
        assertEquals(2048.0, document.defaults.tokenBudget!!, 1e-9)

        val entry = document.entries.first()
        // 正则关键词整体是一个 key（`/王(城|都)/iu` 不能被逗号切开）
        assertEquals(listOf("公主", "/王(城|都)/iu"), entry.activation.primaryKeys)
        assertEquals("and_any", entry.activation.secondaryLogic)
        assertEquals(LorebookInsertion.chat(2.0, "system"), entry.insertion)
        // PC `migrations/v1-to-v2.ts#entryFromLegacy`：legacy `priority: 'detail'`
        // 落成 canonical 预算层 `supplemental`（runtime 编译时再由它推导回 'detail'，
        // 见 LorebookRuntimeCompileTest 的 priority 断言）。
        assertEquals("supplemental", entry.activation.budgetTier)
        assertEquals(42.0, entry.scheduling.order, 1e-9)
        assertEquals(85.0, entry.scheduling.probability, 1e-9)
        assertEquals(listOf("royal"), entry.scheduling.groups.map { it.name })
        assertEquals(150.0, entry.scheduling.groups.first().weight, 1e-9)
        assertTrue(entry.scheduling.groups.first().prioritized)
        assertEquals("王城公主设定", entry.summary)
        assertEquals("Princess lives in the capital.", entry.translation)
        assertTrue(entry.scheduling.ignoreBudget)
        assertEquals(3.0, entry.scheduling.scanDepth!!, 1e-9)
        // PC `migrations/v1-to-v2.ts#retrievalFromLegacy`：legacy `matchMode` 只有
        // keyword/semantic 两种能原样落地，`both`（以及缺省）一律落成 canonical 的 `hybrid`
        // ——`LorebookRetrievalMode` 里根本没有 `both` 这个值。
        assertEquals("hybrid", entry.activation.retrieval)
        assertTrue(!entry.activation.regex.enabled)
        assertEquals("iu", entry.activation.regex.flags)
    }

    @Test
    fun nativeV1UnknownFieldsStayUnderQingyuNamespace() {
        val document = import("native-v1-unknown-extensions")
        @Suppress("UNCHECKED_CAST")
        val bookForeign = document.foreign?.get(LorebookNativeV1Format.ID) as Map<String, Any?>
        assertTrue("futureBookOption 必须留在保留区", bookForeign.containsKey("futureBookOption"))
        @Suppress("UNCHECKED_CAST")
        val entryForeign = document.entries.first().foreign?.get(LorebookNativeV1Format.ID) as Map<String, Any?>
        assertTrue(entryForeign.containsKey("futureEntryOption"))
    }

    @Test
    fun invalidFixturesAreRejectedWithStructuredReport() {
        listOf(
            "sillytavern-invalid" to "empty_entries",
            "character-book-invalid" to "empty_entries",
            "lorebook-v3-invalid" to "empty_entries",
            "novelai-invalid" to "invalid_entries",
            "agnai-invalid" to "invalid_entries",
        ).forEach { (fixtureId, expectedCode) ->
            val rejected = importResult(fixtureId) as? LorebookImportExport.Result.Rejected
            assertNotNull("$fixtureId 必须被拒绝", rejected)
            assertTrue(
                "$fixtureId 的拒绝原因应包含 $expectedCode，实际 ${rejected?.report?.issues?.map { it.code }}",
                rejected?.report?.issues.orEmpty().any { it.code == expectedCode },
            )
            assertEquals("$fixtureId 必须是 rejected 态", LorebookCompatibilityStatus.REJECTED, rejected?.report?.status)
        }
        // PC `lorebookAdapterRegistry.test.ts` 对**每一个** kind=invalid 样本都要求
        // 「抛 LorebookAdapterError 且 report.summary.errors > 0」；上面点名 code 的样本
        // 之外，剩下两个至少要把「有错误、被拒绝」这条钉住。
        listOf("native-v1-invalid", "risu-invalid").forEach { fixtureId ->
            val rejected = importResult(fixtureId) as? LorebookImportExport.Result.Rejected
            assertNotNull("$fixtureId 必须被拒绝", rejected)
            assertEquals("$fixtureId 必须是 rejected 态", LorebookCompatibilityStatus.REJECTED, rejected?.report?.status)
            assertTrue(
                "$fixtureId 报告里必须有至少一条 error（实际 ${rejected?.report?.issues?.map { it.code }}）",
                (rejected?.report?.summary?.errors ?: 0) > 0,
            )
        }
    }

    /**
     * Risu 的坏文件报「没有可导入的世界书条目」，**不是**「N 个条目不是对象」。
     *
     * 这不是 Android 偷懒，而是 PC 的既有行为：`risu.ts#resolveEntries` 里
     * `data.filter(isRecord)` 已把非对象条目滤掉，统一导入器数到的源条目数与有效条目数
     * 相等，`invalid_entries` 对 Risu 永不触发（`novelai`/`agnai` 没做这层预过滤，
     * 它们确实会报计数）。两端必须由同一条 golden 钉住，见
     * [LorebookCrossLanguageGoldenTest] 第 4 道。
     *
     * 这条文案本身在 PC 侧是自相矛盾的（`risu.ts:101-105` 的注释与 `: entry` 死分支
     * 都表明作者本来想「不做预过滤」），已立案 **D-7**：含个别坏条目的 Risu 书会被
     * 静默少导几条、报告里一行不提，与阶段 5 §2「导入必须显示跳过/失败」冲突。
     * 等 PC 侧决定改哪一端后，这条断言与 golden 一起动。
     */
    @Test
    fun risuInvalidIsRejectedWithPcEmptyEntriesMessage() {
        val rejected = LorebookImportExport.importFromValue(
            input = LorebookFixtures.value("risu-invalid"),
            fallbackName = "risu-invalid",
        ) as LorebookImportExport.Result.Rejected
        val codes = rejected.report?.issues?.map { it.code }.orEmpty()
        assertTrue("必须报 empty_entries（实际 $codes）", codes.contains("empty_entries"))
        assertTrue(
            "不能报 invalid_entries：PC 的 Risu 适配器预过滤过条目，这条文案是两端偏差（D-7）",
            !codes.contains("invalid_entries"),
        )
    }

    // ------------------------------------------------------------ P1 生态格式

    @Test
    fun risuDistinguishesMultipleAndConstantModes() {
        val document = import("risu-full")
        assertEquals(LorebookRisuFormat.ID, document.source?.adapterId)
        val first = document.entries.first()
        // PC `risu.ts#toPayloadEntry`：`alwaysActive === true || mode === 'constant'` 才常驻。
        // 所以 mode='multiple'（alwaysActive=false）必须是 conditional，
        // mode='constant' 必须是 constant——两者混成同一个值就等于常驻条目退化成长词触发。
        assertEquals("conditional", first.activation.mode)
        assertEquals("multiple 必须翻成 keyLogic=all", "all", first.activation.keyLogic)
        assertEquals(listOf("星陨峡谷", "流星"), first.activation.primaryKeys)
        assertEquals(listOf("夜晚"), first.activation.secondaryKeys)
        assertEquals(5.0, first.scheduling.order, 1e-9)
        assertEquals(80.0, first.scheduling.probability, 1e-9)
        assertTrue(first.activation.caseSensitive)
        assertEquals("多重条件条目", first.title)
        // extentions 故意不标为已消费：除 risu_case_sensitive 外的内容要原样留着
        @Suppress("UNCHECKED_CAST")
        val namespace = first.foreign?.get(LorebookRisuFormat.ID) as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val fields = namespace["fields"] as Map<String, Any?>
        assertNotNull(fields["extentions"])

        val constant = document.entries[1]
        assertEquals("constant", constant.activation.mode)
        assertEquals(-10.0, constant.scheduling.order, 1e-9)
        assertEquals("any", constant.activation.keyLogic)
        assertEquals(100.0, constant.scheduling.probability, 1e-9)
    }

    @Test
    fun novelAiMapsTextAndForceActivationAndWarnsOnVersion() {
        val document = import("novelai-full")
        assertEquals(LorebookNovelAiFormat.ID, document.source?.adapterId)
        val first = document.entries.first()
        assertEquals("星陨峡谷每逢秋夜会出现流星雨。", first.content)
        assertEquals(listOf("星陨峡谷"), first.activation.primaryKeys)
        assertEquals(listOf("峡谷"), first.activation.secondaryKeys)
        assertEquals("星陨峡谷", first.title)
        assertEquals(3.0, first.scheduling.order, 1e-9)
        assertEquals(65.0, first.scheduling.probability, 1e-9)
        assertEquals(201L, first.sourceId)
        assertEquals("conditional", first.activation.mode)
        val constant = document.entries[1]
        assertEquals("constant", constant.activation.mode)
        assertEquals("keyword", constant.activation.retrieval)
        // category / searchRange 没有对应概念 → 保留区
        @Suppress("UNCHECKED_CAST")
        val namespace = first.foreign?.get(LorebookNovelAiFormat.ID) as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val fields = namespace["fields"] as Map<String, Any?>
        assertEquals("地点", fields["category"])
        // 保留区里的数字按 TS 的 `number` 语义存成 Double（`LorebookJson.toJsonValue`）；
        // 写回文本时 `normalizeForWrite` 会把整数值还原成 `1000`，哈希与 PC 仍一致。
        assertEquals(1000.0, fields["searchRange"])
    }

    @Test
    fun novelAiTopLevelExtrasStayInWrapper() {
        val document = import("novelai-unknown-extensions")
        @Suppress("UNCHECKED_CAST")
        val namespace = document.foreign?.get(LorebookNovelAiFormat.ID) as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val wrapper = namespace["wrapper"] as Map<String, Any?>
        assertNotNull(wrapper["futureBookMeta"])
    }

    @Test
    fun agnaiMapsNameAndEntryOntoCanonicalTitleAndContent() {
        val document = import("agnai-full")
        assertEquals(LorebookAgnaiFormat.ID, document.source?.adapterId)
        assertEquals("Agnai 完整记忆书", document.name)
        val first = document.entries.first()
        assertEquals("agn-201", first.id)
        assertEquals("星陨峡谷", first.title)
        assertEquals("星陨峡谷每逢秋夜会出现流星雨。", first.content)
        assertEquals(listOf("星陨峡谷", "峡谷"), first.activation.primaryKeys)
        assertEquals(3.0, first.scheduling.order, 1e-9)
        assertTrue(!document.entries[1].enabled)
        assertEquals("prompt_end", document.entries[1].insertion.anchor)
    }

    @Test
    fun agnaiKeepsUnmappedEntryFields() {
        val document = import("agnai-unknown-extensions")
        @Suppress("UNCHECKED_CAST")
        val namespace = document.entries.first().foreign?.get(LorebookAgnaiFormat.ID) as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val fields = namespace["fields"] as Map<String, Any?>
        // 同 novelai 的 searchRange：保留区数字是 TS `number`（Double），不是 Long。
        assertEquals(3.0, fields["futureEntryWeight"])
        @Suppress("UNCHECKED_CAST")
        val bookNamespace = document.foreign?.get(LorebookAgnaiFormat.ID) as? Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val bookFields = bookNamespace?.get("payload")?.let { (it as Map<String, Any?>)["fields"] } as? Map<String, Any?>
        assertEquals("manual", bookFields?.get("futureBookKind"))
    }

    @Test
    fun canonicalDocumentIsValidatedAfterEveryImport() {
        // 每个格式的产物都必须能通过 canonical v2 校验——否则编辑器打开就是空白页
        listOf(
            "native-v1-full", "sillytavern-full", "character-book-full", "lorebook-v3-full",
            "risu-full", "novelai-full", "agnai-full",
        ).forEach { fixtureId ->
            val document = import(fixtureId)
            val validation = LorebookValidation.validateCanonicalV2(document.toJsonMap())
            assertTrue(
                "$fixtureId 的产物应合法：${validation.issues.take(3)}",
                validation.valid,
            )
        }
    }
}
