package com.qingyu.companion.content.lorebook

import com.qingyu.companion.chatcore.ChatLorebookBudget
import com.qingyu.companion.chatcore.ChatLorebookCompile
import com.qingyu.companion.chatcore.ChatLorebookRuntime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 5 S5-02：导入产物 → 运行时编译的接缝测试。
 *
 * 这是整个适配层**最要紧**的一条断言：适配器产出的是 canonical v2 文档，
 * 而真正决定「用户绑定了世界书之后会不会注入」的是
 * [ChatLorebookCompile]——它按**键名**读 `activation` / `insertion` / `scheduling`。
 * 键名错一个字母，编译结果就是一条条被 `mapNotNull` 静默丢掉的空列表，
 * 全程不抛异常。所以这里必须走完整的 `导入 → JSON → compile → 字段核对`，
 * 而不是只比对内存里的数据类。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class LorebookRuntimeCompileTest {

    private fun compiledFrom(fixtureId: String): Pair<CanonicalLorebook, ChatLorebookRuntime.Book> {
        val result = LorebookImportExport.importFromValue(
            input = LorebookFixtures.value(fixtureId),
            fallbackName = "fallback-$fixtureId",
            id = "lb-$fixtureId",
            now = 1.0,
            contentHash = "h",
        )
        val document = (result as LorebookImportExport.Result.Imported).document
        val compiled = ChatLorebookCompile.compile(document.toJson(), "lb-$fixtureId", document.name)
        assertNotNull("$fixtureId 的 JSON 必须能被运行时编译", compiled)
        return document to compiled!!
    }

    @Test
    fun everyFormatCompilesToNonEmptyRuntimeEntries() {
        listOf(
            "native-v1-full", "sillytavern-full", "character-book-full", "lorebook-v3-full",
            "risu-full", "novelai-full", "agnai-full",
        ).forEach { fixtureId ->
            val (document, book) = compiledFrom(fixtureId)
            assertEquals(
                "$fixtureId 编译后条目数必须与文档一致（少一条就是键名对不上被静默丢了）",
                document.entries.size,
                book.entries.size,
            )
            assertTrue("$fixtureId 条目不能为空", book.entries.isNotEmpty())
            book.entries.forEach { entry ->
                assertTrue("$fixtureId 条目 id 不能为空", entry.id.isNotEmpty())
                assertTrue("$fixtureId 条目正文不能为空", entry.content.isNotEmpty())
            }
        }
    }

    @Test
    fun defaultsLandOnTheRuntimeBook() {
        val (document, book) = compiledFrom("character-book-full")
        assertEquals("lb-character-book-full", book.id)
        assertEquals(document.name, book.name)
        assertEquals(Integer.valueOf(6), book.scanDepth)
        assertEquals(Integer.valueOf(1024), book.tokenBudget)
        assertEquals(false, book.recursiveScanning)
    }

    @Test
    fun insertionKindDrivesPositionDepthAndRole() {
        val (_, book) = compiledFrom("sillytavern-full")
        val chat = book.entries.first()
        assertEquals("at_depth", chat.position)
        assertEquals(Integer.valueOf(2), chat.depth)
        assertEquals("system", chat.role)
        assertEquals(ChatLorebookBudget.Insertion.Chat(2, "system"), chat.insertion)

        val anchor = book.entries[1]
        // authors_note_top 没有旧式 position 等价物：回退 at_end，但 insertion 必须原样透传，
        // 否则渲染层就分不出「作者注释」和「提示词末尾」。
        assertEquals("at_end", anchor.position)
        assertEquals(ChatLorebookBudget.Insertion.Prompt("authors_note_top"), anchor.insertion)
    }

    @Test
    fun activationAndSchedulingFieldsAreRead() {
        val (document, book) = compiledFrom("native-v1-full")
        val entry = book.entries.first()
        val runtimeEntry = document.entries.first()
        assertEquals(runtimeEntry.id, entry.id)
        // aliases 与 primaryKeys 同权参与触发
        assertEquals(runtimeEntry.activation.primaryKeys + runtimeEntry.activation.aliases, entry.keywords)
        assertEquals(runtimeEntry.activation.secondaryKeys, entry.secondaryKeywords)
        assertEquals("and_any", entry.selectiveLogic)
        assertEquals(false, entry.useRegex)
        assertEquals("iu", entry.regexFlags)
        assertEquals(false, entry.caseSensitive)
        assertEquals(false, entry.matchWholeWords)
        assertEquals(42, entry.order)
        assertEquals(85.0, entry.probability!!, 1e-9)
        assertEquals(Integer.valueOf(3), entry.scanDepth)
        assertEquals(true, entry.preventRecursion)
        assertEquals(true, entry.excludeRecursion)
        assertEquals(true, entry.ignoreBudget)
        assertEquals(listOf("normal", "continue"), entry.generationTriggers)
        assertEquals(listOf("Alice"), entry.characterFilter?.names)
        assertEquals(listOf("royal"), entry.characterFilter?.tags)
        assertEquals(false, entry.characterFilter?.exclude)
        assertEquals("王城公主设定", entry.summary)
        // priority 由 mode/budgetTier 推导（detail = supplemental 预算层）
        assertEquals("detail", entry.priority)
    }

    @Test
    fun constantEntriesBecomeAlwaysPriority() {
        val (_, book) = compiledFrom("character-book-full")
        assertEquals("always", book.entries[1].priority)
        assertEquals("before_char", book.entries[1].position)
        assertEquals("conditional", book.entries[0].priority)
    }

    @Test
    fun compiledBookActuallyTriggersThroughTheRuntime() {
        // 端到端：外部格式 → canonical → 编译 → 运行时真的注入
        val (document, book) = compiledFrom("sillytavern-full")
        // 该 fixture 的第一条自带角色绑定：`characterFilter(names=[Alice], tags=[royal])`。
        // 运行时对 names 与 tags 是**各维都必须命中**（`contextAllowed`），所以这里必须给出
        // 条目自己声明的上下文；不给就被角色过滤挡掉——那是正确行为，不是缺陷。
        // 补上下文的同一时间断言不放宽：仍然要求这条真的被注入。
        val result = ChatLorebookRuntime.execute(
            ChatLorebookRuntime.Input(
                lorebooks = listOf(book),
                scanText = "我们抵达王城，皇帝也在场。",
                budget = 2000,
                model = "gpt-4o-mini",
                charName = "苏晚",
                characterNames = listOf("Alice"),
                characterTags = listOf("royal"),
                // 第一条 probability=80：注入确定性随机源，否则用例会随机失败
                random = { 0.0 },
            ),
        )
        assertTrue(
            "导入的书必须能真正触发。触发结果=${result.triggeredEntryKeys}；" +
                "编译条目=${book.entries.map { e -> "${e.id}:pri=${e.priority}:cf=${e.characterFilter}:gt=${e.generationTriggers}" }}；" +
                "丢弃 total=${result.droppedCount} always=${result.alwaysDropped} " +
                "cond=${result.conditionalDropped} detail=${result.detailDropped}",
            result.triggeredEntryKeys.isNotEmpty(),
        )
        assertTrue(
            result.atDepth.any { it.content.contains("王城是帝国首都") } ||
                result.beforeChar.any { it.contains("王城是帝国首都") } ||
                result.afterChar.any { it.contains("王城是帝国首都") } ||
                result.atEnd.any { it.contains("王城是帝国首都") },
        )
    }

    @Test
    fun retrievalModeSurvivesTheCompileBoundary() {
        // 此前 ChatLorebookCompile 的注释声称把 retrieval 映成 matchMode，代码却从未读过它，
        // 于是「这条要求的是哪条通道」在运行时里根本不存在，也就没人能说出
        // 「本机没有语义/词法通道」这件事（阶段 5 报告 §5 里那条悬而未决的 P1）。
        // 这条断言把该字段钉在编译边界上。
        val legal = setOf("keyword", "hybrid", "semanticPreferred", "semanticRequired")
        val observed = mutableSetOf<String>()
        listOf(
            "native-v1-full", "sillytavern-full", "character-book-full", "lorebook-v3-full",
            "risu-full", "novelai-full", "agnai-full",
        ).forEach { fixtureId ->
            val (document, book) = compiledFrom(fixtureId)
            assertEquals("$fixtureId 条目数", document.entries.size, book.entries.size)
            document.entries.forEachIndexed { index, source ->
                val mode = source.activation.retrieval
                assertTrue(
                    "$fixtureId 第 $index 条的 retrieval「$mode」不在 canonical 允许的四种之内",
                    legal.contains(mode),
                )
                assertEquals(
                    "$fixtureId 第 $index 条的 retrieval 必须原样进入运行时" +
                        "（丢字段就等于丢了「它要求哪条通道」）",
                    mode,
                    book.entries[index].retrieval,
                )
                observed += mode
            }
        }
        assertTrue(
            "七个 full 夹具里必须至少有一条不是 keyword，否则这条断言形同空跑" +
                "（真实导入路径确实会产出 hybrid：SillyTavern 的 vectorized=true 且有关键词）。实测=$observed",
            observed.any { it != "keyword" },
        )
    }

    @Test
    fun rejectedImportsNeverReachTheRuntime() {
        // 空条目文件不能既「导入失败」又留下一本可编译的空书
        val rejected = LorebookImportExport.importFromValue(
            input = LorebookFixtures.value("character-book-invalid"),
            fallbackName = "空书",
        )
        assertTrue(rejected is LorebookImportExport.Result.Rejected)
        val compiled = ChatLorebookCompile.compile(
            CanonicalLorebook(entries = emptyList()).toJson(),
            "lb",
            "空书",
        )
        assertNotNull(compiled)
        assertTrue(compiled!!.entries.isEmpty())
        assertNull(ChatLorebookCompile.compile("not-json", "lb", "坏文档"))
    }
}
