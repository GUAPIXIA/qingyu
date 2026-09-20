package com.qingyu.companion.content.lorebook

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 5 S5-02：导入边界（方案 §15、§6.5）测试。
 *
 * 这一层是**安全边界**而不是体验优化：超深结构会在遍历阶段打爆栈，
 * 超大 foreign 保留区会把一次导入变成一次内存事故。
 * 所以断言重点是「超限的东西以什么形态被拒/被丢」：
 * - 深度：进适配器**之前**就抛，消息带上限；
 * - 条目数、正文长度：`rejected` + `error`，整个导入失败；
 * - 保留区体积、危险 flags、超长正则关键词：`warning` + 丢弃/近似，
 *   导入仍然成功，但报告里必须逐条说清丢了什么。
 *
 * 数值全部引用 [LorebookLimits] 常量：上限本身是 PC 已发布语义，
 * 测试不重新写死一遍，改 PC 常量时这里会跟着变（而不是变成一条假绿灯）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class LorebookImportLimitsTest {

    private fun entry(id: String, content: String = "正文", foreign: Map<String, Any?>? = null) = CanonicalLoreEntry(
        id = id,
        content = content,
        activation = LorebookActivation(primaryKeys = listOf(id)),
        foreign = foreign,
    )

    private fun documentOf(vararg entries: CanonicalLoreEntry) = CanonicalLorebook(
        id = "lb",
        name = "上限测试",
        entries = entries.toList(),
    )

    @Test
    fun deeplyNestedInputIsRejectedBeforeAdaptersRun() {
        val deep = buildString {
            repeat(LorebookLimits.MAX_JSON_DEPTH + 8) { append("{\"a\":") }
            append("1")
            repeat(LorebookLimits.MAX_JSON_DEPTH + 8) { append("}") }
        }
        val parsed = LorebookJson.parse(deep)
        assertNotNull("样本本身要能解析，测的才是深度检查而不是解析器", parsed)
        val thrown = runCatching { LorebookLimits.assertImportJsonDepth(parsed) }.exceptionOrNull()
        assertTrue(thrown is IllegalStateException)
        assertEquals(
            "JSON 嵌套深度超过限制（${LorebookLimits.MAX_JSON_DEPTH} 层），已拒绝导入",
            thrown?.message,
        )
        // registry 把这条包装成用户可读的 LorebookAdapterError（同一个入口文案）
        val rejected = LorebookImportExport.importFromText(deep, fallbackName = "超深")
        assertTrue(rejected is LorebookImportExport.Result.Rejected)
        assertEquals(
            "JSON 嵌套深度超过限制（${LorebookLimits.MAX_JSON_DEPTH} 层），已拒绝导入",
            (rejected as LorebookImportExport.Result.Rejected).reason,
        )
    }

    @Test
    fun depthWithinTheLimitIsAccepted() {
        val shallow = buildString {
            repeat(8) { append("{\"a\":") }
            append("1")
            repeat(8) { append("}") }
        }
        LorebookLimits.assertImportJsonDepth(LorebookJson.parse(shallow))
    }

    @Test
    fun tooManyEntriesRejectsTheWholeImport() {
        val entries = (0..LorebookLimits.MAX_ENTRIES).map { entry("e$it") }
        val outcome = LorebookLimits.enforceImportDocumentLimits(
            documentOf().copy(entries = entries),
        )
        assertEquals(1, outcome.issues.size)
        val issue = outcome.issues.first()
        assertEquals("too_many_entries", issue.code)
        assertEquals(LorebookCompatibilityAction.REJECTED, issue.action)
        // 条数超限时**不裁剪**：要么全收要么全拒，半本世界书是最坏结果
        assertEquals(entries.size, outcome.document.entries.size)
    }

    @Test
    fun oversizedEntryContentRejectsImport() {
        val outcome = LorebookLimits.enforceImportDocumentLimits(
            documentOf(entry("big", "字".repeat(LorebookLimits.MAX_ENTRY_CONTENT_CHARS + 1))),
        )
        val issue = outcome.issues.first()
        assertEquals("entry_content_too_long", issue.code)
        assertEquals(LorebookCompatibilitySeverity.ERROR, issue.severity)
        assertTrue(issue.path.endsWith(".content"))
    }

    @Test
    fun oversizedForeignNamespacesAreDroppedButContentSurvives() {
        val fat = "x".repeat(LorebookLimits.MAX_FOREIGN_CHARS_PER_ENTRY + 100)
        val outcome = LorebookLimits.enforceImportDocumentLimits(
            documentOf(entry("e1", foreign = mapOf("vendor" to fat))),
        )
        assertEquals("foreign_entry_too_large", outcome.issues.first().code)
        assertEquals(LorebookCompatibilityAction.DROPPED, outcome.issues.first().action)
        assertNull("超限保留区要被丢掉", outcome.document.entries.first().foreign)
        assertEquals("正文与触发词不受影响", "正文", outcome.document.entries.first().content)
        assertEquals(listOf("e1"), outcome.document.entries.first().activation.primaryKeys)
    }

    @Test
    fun wholeBookForeignBudgetDropsTheTailNotTheHead() {
        // 每个命名空间都在单条上限内，但总和超全书上限：按遍历顺序丢后面的
        val perNamespace = "y".repeat(LorebookLimits.MAX_FOREIGN_CHARS_PER_ENTRY - 64)
        val namespaces = (0..LorebookLimits.MAX_FOREIGN_CHARS_PER_BOOK / perNamespace.length)
            .associate { "ns$it" to perNamespace }
        val outcome = LorebookLimits.enforceImportDocumentLimits(
            documentOf(entry("e1")).copy(foreign = namespaces),
        )
        assertTrue(outcome.issues.isNotEmpty())
        assertTrue(outcome.issues.all { it.code == "foreign_budget_exhausted" })
        val kept = requireNotNull(outcome.document.foreign)
        assertTrue("前面的命名空间要先留下", kept.containsKey("ns0"))
        assertTrue("留下的总量必须在上限内", kept.values.sumOf { LorebookJson.charsOf(it) } <= LorebookLimits.MAX_FOREIGN_CHARS_PER_BOOK)
    }

    @Test
    fun dangerousRegexFlagsAreSanitizedAndReported() {
        val document = documentOf(
            CanonicalLoreEntry(
                id = "e1",
                content = "正文",
                activation = LorebookActivation(
                    primaryKeys = listOf("A"),
                    regex = LorebookRegex(enabled = true, flags = "igsx"),
                ),
            ),
        )
        val outcome = LorebookLimits.enforceImportDocumentLimits(document)
        val issue = outcome.issues.first { it.code == "regex_flags_sanitized" }
        assertEquals(LorebookCompatibilityAction.APPROXIMATED, issue.action)
        // PC `limits.ts`：`[...flags].filter(允许).join('')` —— **保持原顺序**只删不改排，
        // 所以 `igsx` 的产物是 `igs` 而不是字母序的 `gis`；重排会改变 flags 的字节，
        // 进而改变 canonical payload 的哈希。
        assertEquals("igs", outcome.document.entries.first().activation.regex.flags)
        assertTrue(issue.message.contains("igs"))
    }

    @Test
    fun allDangerousFlagsBecomeTheEmptyStringAndSaySo() {
        val document = documentOf(
            CanonicalLoreEntry(
                id = "e1",
                content = "正文",
                activation = LorebookActivation(
                    regex = LorebookRegex(enabled = true, flags = "xd"),
                ),
            ),
        )
        val outcome = LorebookLimits.enforceImportDocumentLimits(document)
        assertEquals("", outcome.document.entries.first().activation.regex.flags)
        assertTrue(outcome.issues.first { it.code == "regex_flags_sanitized" }.message.contains("（无）"))
    }

    @Test
    fun overlongRegexPatternsAreDroppedOneByOne() {
        val tooLong = "a".repeat(LorebookLimits.MAX_REGEX_PATTERN_LENGTH + 1)
        val document = documentOf(
            CanonicalLoreEntry(
                id = "e1",
                content = "正文",
                activation = LorebookActivation(
                    primaryKeys = listOf("好的", tooLong),
                    secondaryKeys = listOf(tooLong),
                    regex = LorebookRegex(enabled = true, flags = "i"),
                ),
            ),
        )
        val outcome = LorebookLimits.enforceImportDocumentLimits(document)
        assertEquals(listOf("好的"), outcome.document.entries.first().activation.primaryKeys)
        assertEquals(emptyList<String>(), outcome.document.entries.first().activation.secondaryKeys)
        assertEquals(2, outcome.issues.count { it.code == "regex_pattern_too_long" })
    }

    @Test
    fun regexLimitsOnlyApplyWhenRegexIsOn() {
        val tooLong = "a".repeat(LorebookLimits.MAX_REGEX_PATTERN_LENGTH + 1)
        val document = documentOf(
            CanonicalLoreEntry(
                id = "e1",
                content = "正文",
                activation = LorebookActivation(primaryKeys = listOf(tooLong), regex = LorebookRegex(enabled = false, flags = "xz")),
            ),
        )
        val outcome = LorebookLimits.enforceImportDocumentLimits(document)
        assertEquals("未启用正则时不动 flags 与关键词", 0, outcome.issues.size)
        assertEquals("xz", outcome.document.entries.first().activation.regex.flags)
        assertEquals(listOf(tooLong), outcome.document.entries.first().activation.primaryKeys)
    }

    @Test
    fun registryFoldsLimitIssuesIntoTheCompatibilityReport() {
        val input = linkedMapOf(
            "name" to "带危险 flags 的书",
            "entries" to listOf(
                linkedMapOf(
                    "keys" to listOf("A", "b".repeat(LorebookLimits.MAX_REGEX_PATTERN_LENGTH + 5)),
                    "content" to "正文",
                    "use_regex" to true,
                    "extensions" to linkedMapOf("regex_flags" to "gisx"),
                    "id" to "e1",
                ),
            ),
        )
        val result = LorebookImportExport.importFromValue(input = input, fallbackName = "书")
        val imported = result as LorebookImportExport.Result.Imported
        val codes = imported.report.issues.map { it.code }
        assertTrue("报告应含 flags 清洗：$codes", codes.contains("regex_flags_sanitized"))
        assertTrue("报告应含超长关键词：$codes", codes.contains("regex_pattern_too_long"))
        assertEquals(LorebookCompatibilityStatus.APPROXIMATED, imported.report.status)
        assertEquals(
            "超长的那条正则关键词要被丢掉，留下的是合法的那条",
            listOf("A"),
            imported.document.entries.first().activation.primaryKeys,
        )
    }
}
