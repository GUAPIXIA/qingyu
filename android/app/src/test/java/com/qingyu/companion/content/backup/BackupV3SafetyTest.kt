package com.qingyu.companion.content.backup

import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 5 S5-08：Backup V3 的安全边界与预检行为。
 *
 * 这些用例覆盖的是方案 §3 测试矩阵里「Backup V3 覆盖篡改 hash、缺条目、重复条目、
 * ZIP bomb 上限、路径穿越、磁盘满和恢复回滚」中**可在纯函数层判定**的部分；
 * 磁盘满与恢复回滚需要真实文件系统和 Room，落在 instrumentation 测试里。
 *
 * 跑在 Robolectric 上：清单序列化走 `org.json`（Android 框架类），纯 JVM 下是
 * 「not mocked」桩，`JSONObject.put` 直接抛异常，预检逻辑根本没机会执行。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class BackupV3SafetyTest {

    @Test
    fun rejectsEveryTraversalAndAbsolutePathShape() {
        val rejected = listOf(
            "/etc/passwd",
            "C:\\evil\\path",
            "..\\escape",
            "../up-one",
            "a/../../b",
            "with\u0000nul",
            "drive:prefix",
            "back\\slash",
            "",
            "   ",
        )
        rejected.forEach { name ->
            assertTrue(
                BackupV3.rejectReasonForEntryName(name) != null,
                "应被拒绝却通过了校验：${name.escapeForMessage()}",
            )
        }
    }

    @Test
    fun acceptsThePortableLayoutPcWrites() {
        listOf(
            "characters/01ABC.json",
            "lorebooks/01ABC.json",
            "presets/01ABC.json",
            "templates/01ABC.json",
            "chats/01ABC/messages.json",
            "groups/01ABC.json",
            "config/personas.json",
            "config/regex/rules.json",
            "config/quickReplies.json",
            "config/usage.json",
            "config/usageClearMarkers.json",
            "config/settings.json",
            "media/01ABC.png",
            BackupV3.MANIFEST_NAME,
        ).forEach { name ->
            assertEquals(null, BackupV3.rejectReasonForEntryName(name), "合法备份路径被误拒：$name")
        }
    }

    @Test
    fun inspectRefusesTamperedHashesMissingEntriesAndUnlistedEntries() {
        val entries = listOf(
            BackupV3.Entry("characters/c1.json", """{"name":"甲"}""".toByteArray()),
            BackupV3.Entry("config/personas.json", "[]".toByteArray()),
        )
        val manifest = BackupV3.manifestOf(entries, "0.17.2", "android", 1L, counts = mapOf("characters" to 1))
        val archive = BackupV3.build(entries, manifest)

        assertTrue(BackupV3.inspect(archive) is BackupV3.InspectResult.Ok, "完好备份应通过预检")

        // 篡改一条正文但沿用旧清单：哈希必须对不上
        val tampered = entries.toMutableList().apply {
            this[0] = BackupV3.Entry("characters/c1.json", """{"name":"乙"}""".toByteArray())
        }
        assertRejected(BackupV3.build(tampered, manifest), "篡改必须被拒")

        // 清单里有、包里没有
        assertRejected(BackupV3.build(entries.dropLast(1), manifest), "缺条目必须被拒")

        // 包里有、清单里没有（夹带条目）
        val smuggled = entries + BackupV3.Entry("config/settings.json", """{"theme":"dark"}""".toByteArray())
        assertRejected(BackupV3.build(smuggled, manifest), "未登记条目必须被拒")
    }

    /** §3 测试矩阵的「重复条目」：同名两条必须整包拒绝，而不是后写覆盖前写。 */
    @Test
    fun duplicateEntryNamesAreRejectedRatherThanLastOneWins() {
        val entries = listOf(BackupV3.Entry("characters/c1.json", """{"name":"甲"}""".toByteArray()))
        val manifest = BackupV3.manifestOf(entries, "0.17.2", "android", 1L, counts = mapOf("characters" to 1))
        val archive = BackupV3.build(entries, manifest)

        // 我们自己**造不出**重复包：`ZipOutputStream` 在 putNextEntry 就拒绝同名条目。
        // 但预检必须能挡住**别人**做的包（PC 侧 JS zip 库允许同名条目，恶意包也这么来），
        // 所以这里手工拼一个：把一个合法包的第一段 local header + 数据整块复制到
        // 中央目录之前。`ZipInputStream` 顺序读 local header，会把它当成两个同名条目。
        val duplicated = runCatching { BackupV3.build(entries + entries, manifest) }.exceptionOrNull()
        assertTrue(
            duplicated != null,
            "打包侧本就不该能产出重复条目；如果可以，这条前提就失效了",
        )

        val crafted = spliceFirstLocalEntry(archive)
        val result = BackupV3.inspect(crafted)
        assertTrue(
            result is BackupV3.InspectResult.Rejected && result.reason.contains("重复"),
            "外部重复包必须被预检拒掉，实际：$result",
        )
    }

    /** 复制归档里第一个条目的 local header + 数据段，插到中央目录之前。 */
    private fun spliceFirstLocalEntry(archive: ByteArray): ByteArray {
        val centralStart = indexOfSignature(archive, pkCentral)
        val localStart = indexOfSignature(archive, pkLocal)
        assertTrue(centralStart > localStart, "拼不出合法的 ZIP 结构：central=$centralStart local=$localStart")
        val firstEntryBlock = archive.copyOfRange(localStart, centralStart)
        return archive.copyOfRange(0, centralStart) + firstEntryBlock + archive.copyOfRange(centralStart, archive.size)
    }

    /**
     * §3 测试矩阵的「ZIP bomb 上限」之一：条目数。
     *
     * **单条目 64 MiB 那条不在这里测**：要触发它必须先真的解出 64 MiB，
     * 在默认堆的 JVM 测试里会把堆打爆（实测报 `ZIP 解析失败：Java heap space`，
     * 断言拿到的不是「过大」而是 OOM 转成的拒绝）。硬把断言改成「拒绝就行」是假绿，
     * 所以那条留在报告 §5 里，用大堆的 instrumentation 用例补。
     *
     * **2026-09-20 更新**：这里原先还记着一个设计问题——`inspect` 把整包与每个条目的字节
     * 都留在内存里、上限却是 1 GiB，而 Android 单应用堆只有它的 1/4–1/8，
     * 于是「备份变大」会 OOM 并被报成「ZIP 解析失败」。现在三件事都修完了：
     * - `inspect` 按 [BackupV3.residentBudgetBytes] 在**单条目超预算时先拒**，
     *   并用 [BackupV3.describeInspectFailure] 把 OOM 与「包损坏」分开说；
     * - `inspect` 与恢复路径都改成**逐条目流式**（`Preview` 不再持有条目字节），
     *   所以「总量大但每条都不大」的备份不再被拒——下面 `totalSizeMayExceedTheBudgetAsLongAsEachEntryFits`
     *   钉住这条新能力，解压总量由契约上限（1 GiB，防 ZIP bomb）把关；
     * - 因此口径从「拒绝得诚实且可执行」变成了「拒绝得诚实，且放得下的就真能恢复」。
     */
    @Test
    fun entryCountCapRejectsZipBomb() {
        val tooMany = (0..BackupV3.MAX_ENTRIES).map { index ->
            BackupV3.Entry("characters/c$index.json", "{}".toByteArray())
        }
        val manifest = BackupV3.manifestOf(tooMany, "0.17.2", "android", 1L, counts = emptyMap())
        val result = BackupV3.inspect(BackupV3.build(tooMany, manifest))
        assertTrue(
            result is BackupV3.InspectResult.Rejected && result.reason.contains("条目数超过上限"),
            "条目数超限必须被拒，实际：$result",
        )
    }

    /**
     * 驻留预算是「**单条目**契约上限 64 MiB」与「可用堆的一半」取小，并且先把源包自身扣掉。
     *
     * 纯函数（堆大小可注入）：设备上的真实堆值不该成为断言的一部分，
     * 否则同一条用例在不同机器上断的是不同的数。
     *
     * **2026-09-20 语义变化**：以前它约束「所有条目解压后**之和**」（因为 `inspect` 把整包条目
     * 都留在内存里）。改成逐条目流式之后，内存上只剩「最大的那一个条目」这条约束，
     * 所以堆很大时预算被 **64 MiB 的单条目契约**夹住，而不是 1 GiB 的解压总量。
     */
    @Test
    fun residentBudgetIsTheSmallerOfThePerEntryCeilingAndHalfTheHeadroom() {
        val mib = 1024L * 1024L
        // 堆很小：预算由堆决定 = (堆 − 源包) × 0.5
        assertEquals(
            (100L * mib - 10L * mib) / 2,
            BackupV3.residentBudgetBytes(sourceBytes = 10L * mib, heapMaxBytes = 100L * mib),
            "预算必须先把源包自身从堆里扣掉，再取一半",
        )
        // 堆很大：被**单条目**契约上限夹住（不再是 1 GiB 的解压总量）
        assertEquals(
            BackupV3.MAX_SINGLE_ENTRY_BYTES,
            BackupV3.residentBudgetBytes(sourceBytes = 1024L, heapMaxBytes = 64L * 1024 * mib),
            "再大的堆也只能容纳一个 64 MiB 的条目",
        )
        // 源包自己就吃掉整个堆：没有预算可用（返回 0，调用方据此直接拒，而不是等 OOM）
        assertEquals(0L, BackupV3.residentBudgetBytes(sourceBytes = 200L, heapMaxBytes = 100L))
    }

    /**
     * **单个条目**超出预算必须在解压过程中被拒，而且文案要说清是「本机放不下」。
     *
     * 这条注入一个极小的预算，从而不必真的分配几百 MB——否则要复现同一个场景得先有
     * 一个几百 MB 的合法备份，用例既慢又依赖机型堆大小。最后一条断言是对照组：
     * 同一个包给足预算必须通过，防止把「这包本来就坏」误当成「超预算」。
     */
    @Test
    fun anEntryLargerThanTheResidentBudgetIsRejectedByTheBudgetNotByTheHeap() {
        val entries = listOf(
            BackupV3.Entry("characters/small.json", ByteArray(4 * 1024) { 'a'.code.toByte() }),
            // 这一个比注入的预算还大
            BackupV3.Entry("media/avatar/big.png", ByteArray(256 * 1024) { 'b'.code.toByte() }),
        )
        val manifest = BackupV3.manifestOf(entries, "0.17.2", "android", 1L, counts = emptyMap())
        val archive = BackupV3.build(entries, manifest)

        val result = BackupV3.inspect(archive, budgetBytes = 128 * 1024)
        assertTrue(result is BackupV3.InspectResult.Rejected, "单条目超预算必须被拒，实际：$result")
        val reason = (result as BackupV3.InspectResult.Rejected).reason
        assertTrue("单条目" in reason && "上限" in reason, "拒绝原因必须报出是单条目超限：$reason")
        assertTrue("ZIP 解析失败" !in reason, "不能把「本机放不下」说成「ZIP 坏了」：$reason")
        assertTrue("PC" in reason, "文案要给出下一步（PC）：$reason")

        assertTrue(
            BackupV3.inspect(archive, budgetBytes = 8L * 1024 * 1024) is BackupV3.InspectResult.Ok,
            "同一份备份在预算充足时必须通过——这是上面那条的对照组",
        )
    }

    /**
     * **本轮新增的能力**（§5-P1-d 结案）：解压**总量**超过驻留预算的备份现在能通过预检。
     *
     * 以前预检把「所有条目解压后之和」与预算比，于是「总量很大但每个条目都不大」的备份
     * （正是真实备份的形状：一堆头像 + 若干会话）在**本机明明放得下**的情况下被拒。
     * 改成逐条目流式后，约束只落在单条目上；总量由契约上限（1 GiB，防 ZIP bomb）把关。
     *
     * 断言 ①总量确实超过注入预算（否则这条用例什么都没测）②预检仍然通过；
     * ③而**单个**条目一旦超过同一个预算就被拒——即预算没有失效，只是量纲变了。
     */
    @Test
    fun totalSizeMayExceedTheBudgetAsLongAsEachEntryFits() {
        val budget = 128L * 1024
        val entries = (0 until 8).map { index ->
            BackupV3.Entry("characters/normal$index.json", ByteArray(64 * 1024) { 'a'.code.toByte() })
        }
        val manifest = BackupV3.manifestOf(entries, "0.17.2", "android", 1L, counts = emptyMap())
        val archive = BackupV3.build(entries, manifest)

        val total = entries.sumOf { it.bytes.size.toLong() }
        assertTrue(
            total > budget,
            "这条用例的前提是「总量大于预算」：total=$total budget=$budget",
        )
        assertTrue(
            BackupV3.inspect(archive, budgetBytes = budget) is BackupV3.InspectResult.Ok,
            "逐条目流式之后，总量超预算但每条都放得下的备份必须通过预检",
        )

        val oversized = listOf(BackupV3.Entry("characters/huge.json", ByteArray((budget + 1).toInt()) { 'a'.code.toByte() }))
        val oversizedArchive = BackupV3.build(
            oversized,
            BackupV3.manifestOf(oversized, "0.17.2", "android", 1L, counts = emptyMap()),
        )
        assertTrue(
            BackupV3.inspect(oversizedArchive, budgetBytes = budget) is BackupV3.InspectResult.Rejected,
            "同一个预算对**单条目**仍然有效",
        )
    }

    /**
     * OOM 与「包损坏」必须是两句不同的话。
     *
     * 前两条测 [BackupV3.describeInspectFailure] 本身（纯函数、确定性）：真的制造一次 OOM
     * 需要按机型堆大小调参，那种用例本身就不稳定，属于「用不稳定的用例证明一件稳定的事」。
     * 第三条从 `inspect` 入口把「包损坏」那一支端到端跑一遍——该函数的调用点只有一处。
     */
    @Test
    fun outOfMemoryIsReportedAsAMemoryProblemNotNullAsZipCorruption() {
        val oom = BackupV3.describeInspectFailure(OutOfMemoryError("Java heap space"), 150L * 1024 * 1024)
        assertTrue("内存不足" in oom, "OOM 必须说成内存问题：$oom")
        assertTrue("ZIP 解析失败" !in oom, "OOM 不能被说成套 ZIP 解析失败：$oom")
        assertTrue("PC" in oom, "文案要给出下一步（改在 PC 上恢复）：$oom")
        assertTrue("150 MB" in oom, "文案要带上已解压量，便于用户判断：$oom")

        val corrupt = BackupV3.describeInspectFailure(java.util.zip.ZipException("bad header"), 0)
        assertTrue("ZIP 解析失败" in corrupt, "真正的解析失败仍要说成解析失败：$corrupt")
    }

    /** 坏包的端到端：一个 deflate 条目却塞着垃圾字节，`inspect` 必须整体拒绝而不是抛出去。 */
    @Test
    fun aCorruptArchiveIsRejectedThroughTheSamePathInsteadOfThrowing() {
        val result = BackupV3.inspect(fakeDeflateEntryWithGarbage())
        assertTrue(result is BackupV3.InspectResult.Rejected, "坏包必须被拒，实际：$result")
        val reason = (result as BackupV3.InspectResult.Rejected).reason
        assertTrue(
            "ZIP 解析失败" in reason || "缺少 manifest.json" in reason,
            "坏包要么报解析失败、要么报缺少清单，但不能是内存问题：$reason",
        )
    }

    /** 手工拼一个「local header 声明 deflate、数据是垃圾」的最小 ZIP，用于走坏包分支。 */
    private fun fakeDeflateEntryWithGarbage(): ByteArray {
        val name = "x.json".toByteArray(Charsets.US_ASCII)
        val buffer = java.nio.ByteBuffer.allocate(30 + name.size + 8).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        buffer.put(byteArrayOf(0x50, 0x4B, 0x03, 0x04))
        buffer.putShort(20.toShort())   // version needed
        buffer.putShort(0.toShort())    // flags
        buffer.putShort(8.toShort())    // method = deflate
        buffer.putShort(0.toShort())    // mod time
        buffer.putShort(0.toShort())    // mod date
        buffer.putInt(0)                // crc32
        buffer.putInt(8)                // compressed size
        buffer.putInt(8)                // uncompressed size
        buffer.putShort(name.size.toShort())
        buffer.putShort(0.toShort())    // extra len
        buffer.put(name)
        repeat(8) { buffer.put(0xFF.toByte()) }
        return buffer.array()
    }

    @Test
    fun buildRefusesAnIllegalEntryNameInsteadOfWritingIt() {
        val entries = listOf(BackupV3.Entry("../escape.json", "{}".toByteArray()))
        val manifest = BackupV3.manifestOf(entries, "0.17.2", "android", 1L, counts = emptyMap())
        val failure = runCatching { BackupV3.build(entries, manifest) }.exceptionOrNull()
        assertTrue(failure is IllegalArgumentException, "非法条目名应在打包阶段就抛出，而不是产出一个危险包")
    }

    @Test
    fun manifestSurvivesAJsonRoundTrip() {
        val entries = listOf(BackupV3.Entry("presets/p1.json", "{}".toByteArray()))
        val manifest = BackupV3.manifestOf(
            entries, "0.17.2", "android", 1_700_000_000_000L,
            counts = mapOf("presets" to 1),
        )
        val parsed = BackupV3.parseManifest(BackupV3.manifestJson(manifest))
        assertEquals(manifest.counts, parsed?.counts)
        assertEquals(manifest.hashes, parsed?.hashes)
        assertEquals(manifest.excluded, parsed?.excluded)
        assertEquals(manifest.contentDigest, parsed?.contentDigest)
        assertEquals(BackupV3.BACKUP_VERSION, parsed?.version)
        assertEquals(manifest.totalBytes, parsed?.totalBytes)
    }

    @Test
    fun hashComparisonToleratesMissingPrefixAndCase() {
        val hash = BackupV3.sha256("abc".toByteArray())
        assertTrue(hash.startsWith("sha256:"))
        assertTrue(BackupV3.sameHash(hash, hash))
        assertTrue(BackupV3.sameHash(hash.removePrefix("sha256:"), hash))
        assertTrue(BackupV3.sameHash(hash.uppercase(), hash), "PC 清单存的是裸 hex，大小写与前缀都该容忍")
        assertTrue(!BackupV3.sameHash("", hash), "空期望值不能算匹配")
    }

    @Test
    fun contentDigestDependsOnContentNotOrder() {
        val a = BackupV3.Entry("characters/a.json", "1".toByteArray())
        val b = BackupV3.Entry("characters/b.json", "2".toByteArray())
        val first = BackupV3.manifestOf(listOf(a, b), "v", "android", 1L, counts = emptyMap())
        val second = BackupV3.manifestOf(listOf(b, a), "v", "android", 1L, counts = emptyMap())
        assertEquals(first.contentDigest, second.contentDigest, "同一批条目换顺序不该得到不同备份指纹")

        val changed = BackupV3.manifestOf(listOf(a, b.copy(bytes = "9".toByteArray())), "v", "android", 1L, counts = emptyMap())
        assertTrue(first.contentDigest != changed.contentDigest, "内容变了指纹必须变")
    }

    @Test
    fun secretMarkersAreCaughtBeforePackaging() {
        val hits = BackupCollections.assertNoSecrets(
            listOf(BackupV3.Entry("config/settings.json", """{"semanticTrigger":{"apiKey":"sk-x"}}""".toByteArray())),
        )
        assertTrue(hits.isNotEmpty(), "密钥类键名必须被自检拦住")
        assertTrue(
            BackupCollections.assertNoSecrets(
                listOf(BackupV3.Entry("characters/c1.json", """{"name":"甲"}""".toByteArray())),
            ).isEmpty(),
            "正常内容不该被误报",
        )
    }

    @Test
    fun excludedListCoversEverySensitiveCategoryTheSpecNames() {
        // 方案 S5-08：默认排除 API Key、设备身份、spaceKey、令牌、向量索引和日志
        val joined = BackupV3.EXCLUDED_ITEMS.joinToString(",").lowercase()
        listOf("apikey", "device", "spacekey", "token", "vector", "log").forEach { marker ->
            assertTrue(joined.contains(marker), "排除清单缺少 $marker 类别：$joined")
        }
    }

    /**
     * U-6-8：`groups/` 条目与其余条目同受三条红线约束——篡改、未登记（夹带）、路径穿越。
     * 群数据此前没有任何安全覆盖，三条里漏掉任何一条都是「借备份文件写库」的入口。
     */
    @Test
    fun groupEntriesAreCoveredByTamperSmugglingAndTraversalRejections() {
        val entries = listOf(
            BackupV3.Entry("groups/g1.json", """{"id":"g1","name":"甲"}""".toByteArray()),
            BackupV3.Entry("chats/gs1.json", """{"id":"gs1","groupId":"g1"}""".toByteArray()),
        )
        val manifest = BackupV3.manifestOf(entries, "0.17.2", "android", 1L, counts = mapOf("groups" to 1))
        assertTrue(
            BackupV3.inspect(BackupV3.build(entries, manifest)) is BackupV3.InspectResult.Ok,
            "完好的群条目必须过预检（否则自己导出的包自己恢复不了）",
        )

        // 篡改群行正文但沿用旧清单：哈希必须对不上
        val tampered = listOf(
            BackupV3.Entry("groups/g1.json", """{"id":"g1","name":"乙"}""".toByteArray()),
            entries[1],
        )
        assertRejected(BackupV3.build(tampered, manifest), "groups/ 条目被篡改必须整包拒收")

        // 清单里有、包里没有
        assertRejected(BackupV3.build(listOf(entries[1]), manifest), "缺 groups/ 条目必须整包拒收")

        // 包里有、清单里没有（夹带群条目）
        val smuggled = entries + BackupV3.Entry("groups/evil.json", "{}".toByteArray())
        assertRejected(BackupV3.build(smuggled, manifest), "未登记的 groups/ 条目必须整包拒收")

        // 路径穿越形状：条目名校验拒，打包侧也直接抛
        assertTrue(
            BackupV3.rejectReasonForEntryName("groups/../escape.json") != null,
            "groups/ 前缀不能洗白上级目录片段（否则可写出任意路径）",
        )
        val failure = runCatching {
            BackupV3.build(listOf(BackupV3.Entry("groups/../escape.json", "{}".toByteArray())), manifest)
        }.exceptionOrNull()
        assertTrue(failure is IllegalArgumentException, "穿越形状必须在打包阶段就抛出，实际：$failure")
    }

    /**
     * U-6-8：合法条目前缀清单必须登记 `groups/`。
     * 装配层按 [BackupCollections.ENTITY_PREFIXES] 决定哪些前缀是「合法备份路径」，
     * 漏登记的后果是自己导出的 `groups/` 条目被预检当非法路径拒收。
     */
    @Test
    fun collectionRegistryKeepsGroupsAndChatsRegisteredAsLegalEntryPrefixes() {
        listOf(BackupV3.Paths.GROUPS, BackupV3.Paths.CHATS).forEach { prefix ->
            assertTrue(
                prefix in BackupCollections.ENTITY_PREFIXES,
                "合法条目前缀清单必须登记 ${prefix}，否则自己导出的条目会被拒收",
            )
        }
    }

    private fun assertRejected(bytes: ByteArray, message: String) {
        val result = BackupV3.inspect(bytes)
        assertTrue(result is BackupV3.InspectResult.Rejected, "$message（实际通过）")
    }

    /** ZIP 的 local file header 与 central directory 签名（前两个字节是 "PK"）。 */
    private val pkLocal = byteArrayOf(0x50, 0x4B, 0x03, 0x04)
    private val pkCentral = byteArrayOf(0x50, 0x4B, 0x01, 0x02)

    private fun indexOfSignature(bytes: ByteArray, signature: ByteArray): Int {
        outer@ for (index in 0..bytes.size - signature.size) {
            for (offset in signature.indices) {
                if (bytes[index + offset] != signature[offset]) continue@outer
            }
            return index
        }
        return -1
    }

    private fun String.escapeForMessage(): String = replace("\u0000", "\\0").ifBlank { "<blank>" }
}
