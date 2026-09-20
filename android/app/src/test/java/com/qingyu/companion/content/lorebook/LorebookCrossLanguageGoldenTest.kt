package com.qingyu.companion.content.lorebook

import com.qingyu.companion.content.ContentIoFixtures
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 5 S5-02 的**跨语言**世界书往返（方案 §3：「每种外部格式使用阶段 0 fixture 做
 * PC 导入 → Android 导出 → PC 再导入，以及反向流程」）。
 *
 * ## 为什么单独有这一个测试类
 * 仓库里原有的世界书往返测试（[LorebookExportRoundTripTest]）是 Android **自己闭环**：
 * Android 导、Android 导回。它抓不到「两端对同一份外部格式的理解本来就不同」——
 * 而那正是方案 §12.1 点名的 P0 风险（同一本书在两台设备上各自成立）。
 * `content-io/lorebook-*.json` 早就由 PC 实现冻结了 PC 的导出对象与再导入结果，
 * 但此前**只有 TS 自己读**，fixture 是死的。这里把它接成活的：
 *
 * 1. [detectionCandidatesMatchPcOnTheSameInputs]——同一份输入，两端候选格式必须逐个一致
 *    （判定错了后面整条链路都错，所以连**顺序**一起比，不只是比集合）；
 * 2. [androidReimportOfPcExportLandsOnPcsCanonical]——**PC 导出 → Android 再导入**，
 *    结果与 PC 自己再导入同一份导出所得的 canonical 逐字段相等（反向流程）；
 * 3. [androidExportOfPcCanonicalMatchesPcExport]——同一份 canonical，两端**导出器**产物相等；
 * 4. [stage0CatalogFixturesRoundTripIdenticallyOnBothEnds]——把 1/2/3 三道搬到
 *    **阶段 0 的 28 份真实外部文件**上再跑一遍，外加兼容性报告逐字段相等。
 *
 * ## 比较前为什么先归一
 * fixture 里的时间戳、contentHash、条目 id 是 TS 侧的哨兵值
 * （`src/test/setup.ts` 把 nanoid 全局 mock 成自增 `mock-id-N`，跨端不可复现）。
 * 这三类都不是业务语义，[normalizeVolatile] 在两端同一规则下抹掉；
 * 抹掉之后还不相等，就是真的语义漂移。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class LorebookCrossLanguageGoldenTest {

    /** `lorebook-detect` 与 `lorebook-import-roundtrip` 来自同一组 `LOREBOOK_INPUTS`，按 label 对齐。 */
    private val inputsByLabel: Map<String, Any?> = ContentIoFixtures.cases("lorebook-detect")
        .associate { it.getString("label") to ContentIoFixtures.valueOf(it, "input") }

    @Test
    fun detectionCandidatesMatchPcOnTheSameInputs() {
        for (case in ContentIoFixtures.cases("lorebook-detect")) {
            val label = case.getString("label")
            val file = ContentIoFixtures.valueOf(case, "file") as Map<*, *>?
            val candidates = LorebookImportExport.registry.detect(
                ContentIoFixtures.valueOf(case, "input"),
                file?.let { LorebookFileMetadata(it["fileName"] as String?, it["extension"] as String?) },
            )
            assertEquals(
                ContentIoFixtures.canonical(ContentIoFixtures.valueOf(case, "candidates") as List<*>),
                ContentIoFixtures.canonical(candidates.map { it.detection.toJsonMap() }),
                "$label：检测候选与 PC 不一致（适配器、置信度、理由或冲突提示有偏差）",
            )
        }
        val thresholds = ContentIoFixtures.cases("lorebook-detect").first().getJSONObject("thresholds")
        assertEquals(
            thresholds.getInt("minConfidence"),
            LorebookAdapterRegistry.MIN_CONFIDENCE,
            "低于该置信度即拒绝导入的阈值与 PC 不一致",
        )
        assertEquals(
            thresholds.getInt("ambiguityMargin"),
            LorebookAdapterRegistry.AMBIGUITY_MARGIN,
            "前两名分差小于该值即视为歧义的阈值与 PC 不一致",
        )
    }

    @Test
    fun androidReimportOfPcExportLandsOnPcsCanonical() {
        val checked = mutableListOf<String>()
        val rejected = mutableListOf<String>()
        for (case in ContentIoFixtures.cases("lorebook-import-roundtrip")) {
            val label = case.getString("label")
            val adapterId = ContentIoFixtures.stringOf(case, "adapterId")
            if (!case.getBoolean("ok")) {
                // PC 拒绝的输入，Android 必须同样拒绝、且文案逐字一致：
                // 导入失败提示是用户直接读到的文字，两套文案就是两套产品。
                val result = LorebookImportExport.importFromValue(
                    input = requireNotNull(inputsByLabel[label]) { "$label：detect fixture 里没有它的输入" },
                    fallbackName = FALLBACK_NAME,
                    id = "book-$label",
                    now = FIXED_NOW,
                )
                val reason = (result as? LorebookImportExport.Result.Rejected)?.reason
                assertEquals(case.getString("error"), reason, "$label：拒绝文案与 PC 不一致")
                rejected += label
                continue
            }
            val exported = ContentIoFixtures.valueOf(case, "exported")
            assertNotNull(exported, "$label：PC 导出了空对象？fixture 坏了")
            val reimported = LorebookImportExport.importFromValue(
                input = exported,
                fallbackName = FALLBACK_NAME,
                id = "book-$label",
                fileName = "re-$label.json",
                extension = "json",
                now = FIXED_NOW,
                // 不指定 adapterId：PC 这一腿也是自动检测，指定了就测不到两端判定的差异
            )
            val document = (reimported as? LorebookImportExport.Result.Imported)?.document
            assertNotNull(
                document,
                "$label：Android 把 PC 的导出导回来时失败了：${(reimported as? LorebookImportExport.Result.Rejected)?.reason}",
            )
            val expected = normalizeVolatile(ContentIoFixtures.valueOf(case, "roundTripDocument"))
            // 比 canonical 文本而不是比 Map：`JsonValues` 把 PC 的 `2` 读成 Long、
            // Android 的模型统一收成 Double 2.0，直接比对象会出现一片假偏差，
            // 真偏差反而被淹在噪声里（[ContentIoFixtures] 的类注释就是为这件事立的规矩）。
            assertEquals(
                ContentIoFixtures.canonical(expected as Map<*, *>),
                ContentIoFixtures.canonical(normalizeVolatile(document!!.toJsonMap()) as Map<*, *>),
                "PC 导出 → Android 再导入 的结果与 PC 自己再导入的不一致（label=$label adapterId=$adapterId）",
            )
            checked += label
        }
        assertEquals(7, checked.size, "跨端往返必须覆盖 fixture 里全部 7 条可导入用例")
        assertEquals(listOf("array-input", "empty-object"), rejected.sorted(), "PC 拒绝的用例一条都没比对上")
    }

    @Test
    fun androidExportOfPcCanonicalMatchesPcExport() {
        for (case in ContentIoFixtures.cases("lorebook-import-roundtrip")) {
            val label = case.getString("label")
            if (!case.getBoolean("ok")) continue
            val adapterId = ContentIoFixtures.stringOf(case, "adapterId") ?: continue
            val pcExport = ContentIoFixtures.valueOf(case, "exported") ?: continue
            val restored = LorebookJson.record(
                ContentIoFixtures.valueOf(case, "document")?.let { restoreVolatile(it) },
            )
            assertNotNull(restored, "$label：fixture 里的 canonical 文档不是对象")
            val document = CanonicalLorebook.fromMap(restored)
            assertNotNull(document, "$label：Android 读不动 PC 的 canonical 文档")
            val export = LorebookImportExport.exportToText(document!!, adapterId, pretty = false)
            assertTrue(
                export is LorebookImportExport.ExportResult.Exported,
                "$label：Android 导出被判定不支持：${(export as? LorebookImportExport.ExportResult.Unsupported)?.reason}",
            )
            assertEquals(
                ContentIoFixtures.canonical(pcExport as Map<*, *>),
                ContentIoFixtures.canonical(
                    LorebookJson.parse((export as LorebookImportExport.ExportResult.Exported).json)
                        ?: error("$label：Android 导出的不是合法 JSON"),
                ),
                "$label：同一份 canonical 在两端导出的外部格式不一致",
            )
        }
    }

    /**
     * **阶段 0 fixture**（28 份真实外部文件）上的完整跨端往返。
     *
     * 与上面两个用例的区别：那里的输入是 TS 里手写的 9 个样本，够测语义、不够测形状；
     * 阶段 0 抓来的文件才带得上「ST 的 `key` 是字符串而 `uid` 是数字」
     * 「`extensions` 各家写法不一」这类真实畸变。方案 §3 点名的正是这一批。
     *
     * 一条样本要同时过四道：
     * 1. 检测：选中的适配器、置信度、冲突提示；
     * 2. 导入：canonical 逐字段（含 `foreign` 保留区）；
     * 3. 报告：成功/近似/保留/丢弃的问题码与计数（方案 §2 要求导入必须把这些显示出来）；
     * 4. 导出：同一份 canonical 两端产出的外部格式逐字节相等。
     *
     * 这四道合起来就是 §3 那句「PC 导入 → Android 导出 → PC 再导入」：
     * 两端导出物逐字节相等（第 4 道），所以「Android 导出后 PC 再导入」的结果
     * 与「PC 导出后 PC 再导入」必然相同，而后者是 PC 自己已测过的闭环
     * （`lorebook-import-roundtrip` 的 `roundTripDocument`）。
     * 选这个组合而不是把 Android 的产物搬进 TS 再跑一遍，理由是断言落在
     * **同一棵 canonical 树**上，比对更严、也不用多养一个跨语言工件。
     */
    @Test
    fun stage0CatalogFixturesRoundTripIdenticallyOnBothEnds() {
        var imported = 0
        var rejected = 0
        for (case in ContentIoFixtures.cases("lorebook-catalog-canonical")) {
            val id = case.getString("id")
            val path = case.getString("path")
            val result = LorebookImportExport.importFromValue(
                input = LorebookFixtures.value(id),
                fallbackName = "fallback-$id",
                id = "adapter-$id",
                fileName = path,
                now = FIXED_NOW,
                contentHash = "hash-$id",
            )
            if (!case.getBoolean("ok")) {
                val reason = (result as? LorebookImportExport.Result.Rejected)?.reason
                assertEquals(
                    case.getString("error"),
                    reason,
                    "$id（$path）：PC 判定拒绝，Android 的拒绝文案却不一致",
                )
                rejected += 1
                continue
            }
            val importedResult = result as? LorebookImportExport.Result.Imported
            assertNotNull(
                importedResult,
                "$id（$path）：PC 能导入，Android 却失败：${(result as? LorebookImportExport.Result.Rejected)?.reason}",
            )
            val document = importedResult!!.document
            val adapterId = requireNotNull(ContentIoFixtures.stringOf(case, "adapterId"))
            assertEquals(
                ContentIoFixtures.canonical(ContentIoFixtures.valueOf(case, "detection") as Map<*, *>),
                ContentIoFixtures.canonical(
                    linkedMapOf(
                        "adapterId" to importedResult.detection.adapterId,
                        "confidence" to importedResult.detection.confidence,
                        "conflicts" to importedResult.detection.conflicts,
                    ),
                ),
                "$id：检测选中的格式与置信度不一致（后面整条链路都跟着错）",
            )
            assertEquals(
                ContentIoFixtures.canonical(normalizeVolatile(ContentIoFixtures.valueOf(case, "document")) as Map<*, *>),
                ContentIoFixtures.canonical(normalizeVolatile(document.toJsonMap()) as Map<*, *>),
                "$id：同一份阶段 0 样本在两端导入出的 canonical 不一致",
            )
            assertEquals(
                ContentIoFixtures.canonical(
                    normalizeVolatile(ContentIoFixtures.valueOf(case, "report") as Map<*, *>),
                ),
                ContentIoFixtures.canonical(normalizeVolatile(importedResult.report.toJsonMap())),
                "$id：兼容性报告不一致（用户看到的『近似/保留/丢弃』计数与问题码必须同一套）",
            )
            val export = LorebookImportExport.exportToText(document, adapterId, pretty = false)
            assertTrue(
                export is LorebookImportExport.ExportResult.Exported,
                "$id：Android 导不出 PC 能导的 $adapterId",
            )
            assertEquals(
                ContentIoFixtures.canonical(ContentIoFixtures.valueOf(case, "exported") as Map<*, *>),
                ContentIoFixtures.canonical(
                    LorebookJson.parse((export as LorebookImportExport.ExportResult.Exported).json)
                        ?: error("$id：Android 导出的不是合法 JSON"),
                ),
                "$id：同一份 canonical 在两端导出的外部格式不一致",
            )
            imported += 1
        }
        // 21 + 7 = 28：一条都不能被 `continue` 掉而不计数。
        // 注意别拿 `catalog.json` 的 `expected.importable` 推这个数——`native-v1-invalid`
        // 在那儿标的是 `importable: true`，而 PC 的导入器实际会抛
        // （`轻语原生世界书 v1 校验失败`）：那个字段说的是「检测能不能认出格式」，
        // 不是「导入会不会成功」。阶段 0 目录里的这处口径差已记进报告。
        assertEquals(21, imported, "阶段 0 可导入样本必须全部走一遍")
        assertEquals(7, rejected, "阶段 0 的 invalid 样本必须全部落在拒绝分支上")
    }

    /**
     * PC 用到的每个适配器在 Android 侧都得存在且可导出。
     *
     * 单独成一条而不并进上面的往返用例，是因为它属于「注册表口径」而不是「某份文档的语义」：
     * 一旦某端少注册一个格式，上面几条会在具体字段上失败，看不出根因是整块缺失。
     */
    @Test
    fun everyAdapterPcUsesIsRegisteredAndExportableOnAndroid() {
        val adapterIds = ContentIoFixtures.cases("lorebook-import-roundtrip")
            .filter { it.getBoolean("ok") }
            .map { requireNotNull(ContentIoFixtures.stringOf(it, "adapterId")) { "${it.getString("label")}：PC 没有记来源适配器" } }
            .distinct()
            .sorted()
        assertEquals(
            listOf(
                "agnai.memory-book",
                "character-card.character-book",
                "character-card.lorebook-v3",
                "qingyu.native-v1",
                "risu.lorebook",
                "sillytavern.world-info",
            ),
            adapterIds,
            "fixture 覆盖到的来源格式变了——跨端往返的用例集要一起看",
        )
        adapterIds.forEach { adapterId ->
            val adapter = LorebookImportExport.registry.get(adapterId)
            assertNotNull(adapter, "PC 用到 $adapterId，Android registry 里却没有它")
            assertTrue(adapter!!.canExport, "$adapterId 在 PC 能导出、在 Android 却被标成不可导出")
        }
    }

    private companion object {
        const val FALLBACK_NAME = "回退名"
        const val FIXED_NOW = 1_700_000_000_000.0
        const val SENTINEL_TIME = "<volatile:timestamp>"
        const val SENTINEL_HASH = "<volatile:sha256>"
        const val SENTINEL_ENTRY_ID = "<volatile:entry-id>"
        val TIME_KEYS = setOf("importedAt", "createdAt", "updatedAt")

        /**
         * 两端同一规则抹掉易变值：时间戳、内容哈希、**导入器自己造的**条目 id。
         *
         * 书级 `id`（PC 传进去的 `book-<label>`）保留——它是调用方给定的，
         * 两端不一致就说明 Android 没把 `options.id` 透传到文档里。
         * 条目 `id` 只在 `id != sourceId` 时抹掉：判据与 TS 侧
         * `normalizeCanonicalEntryIds` 逐字对齐，两端各抹一遍才不会把
         * `v1e` 这类「外部格式本来就带、导出时还要原样写回去」的确定值一起抹掉。
         */
        fun normalizeVolatile(value: Any?): Any? = when (value) {
            is List<*> -> value.map { normalizeVolatile(it) }

            is Map<*, *> -> value.entries.associate { (key, raw) ->
                val name = key.toString()
                name to when {
                    name in TIME_KEYS -> SENTINEL_TIME
                    name == "contentHash" && raw is String -> SENTINEL_HASH
                    name == "entries" -> (raw as? List<*>)?.map { entry ->
                        (entry as? Map<*, *>)?.let { normalizeEntryId(it) }
                            ?: normalizeVolatile(entry)
                    } ?: raw

                    else -> normalizeVolatile(raw)
                }
            }

            else -> value
        }

        private fun normalizeEntryId(entry: Map<*, *>): Map<String, Any?> = entry.entries.associate { (key, raw) ->
            val name = key.toString()
            name to when {
                name == "id" && raw is String && raw != entry["sourceId"] -> SENTINEL_ENTRY_ID
                name == "id" && raw is Number && raw != entry["sourceId"] -> SENTINEL_ENTRY_ID
                else -> normalizeVolatile(raw)
            }
        }

        /** [normalizeVolatile] 的逆操作：把哨兵换回合法类型，好让 Android 的宽容模型读得进去。 */
        fun restoreVolatile(value: Any?): Any? = when (value) {
            is List<*> -> value.map { restoreVolatile(it) }

            is Map<*, *> -> value.entries.associate { (key, raw) ->
                val name = key.toString()
                val restored = restoreVolatile(raw)
                name to when {
                    name == "id" && restored == SENTINEL_ENTRY_ID -> "restored-entry"
                    restored == SENTINEL_TIME -> FIXED_NOW
                    restored == SENTINEL_HASH -> "0".repeat(64)
                    else -> restored
                }
            }

            SENTINEL_TIME -> FIXED_NOW
            SENTINEL_HASH -> "0".repeat(64)
            else -> value
        }
    }
}
