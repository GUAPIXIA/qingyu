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
 * 阶段 5 S5-02：`lorebook_mapping_template` 的受限 DSL 与应用它的导入。
 *
 * 两类断言分别对应两条独立的风险：
 * 1. **安全**（方案 §S5-02 末句「路径表达式必须使用受限 DSL，不得携带可执行脚本」）：
 *    模板来自用户导入的外部文件，因此键必须封闭、路径只能是字段名序列、
 *    出现 `(`/`)`/`;`/反引号/`$` 这类可执行内容特征字符即拒绝，
 *    并且体积与嵌套深度在解析**之前**就限住。
 * 2. **功能**：应用模板后必须得到合法的 canonical v2，
 *    未映射字段进 `qingyu.mapping` 保留区，且按 §6.3 不提供导出。
 *
 * 注意 [com.qingyu.companion.local.domain.LorebookMappingTemplateDsl] 是另一份
 * 并行开发的节点式校验器；本文件同时验证
 * [LorebookMappingTemplates.fromDslJson] 只在**无损**时才折叠，否则显式拒绝。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class LorebookMappingTemplateTest {

    private val minimalTemplate = LorebookMappingTemplate(
        id = "tpl-1",
        name = "通用样本",
        createdAt = 1.0,
        updatedAt = 1.0,
        entriesPath = "data.book.entries",
        fields = LorebookMappingFieldPaths(keys = "trigger", content = "text", title = "label"),
    )

    @Test
    fun importsEntriesFromAnArbitraryShape() {
        val raw = linkedMapOf(
            "title" to "第三方格式书",
            "data" to linkedMapOf(
                "book" to linkedMapOf(
                    "entries" to listOf(
                        linkedMapOf("trigger" to "王城, 首都", "text" to "王城是帝国首都。", "label" to "王城"),
                        linkedMapOf("trigger" to listOf("遗迹"), "text" to "遗迹在北方。", "label" to "遗迹"),
                    ),
                ),
            ),
        )
        val result = LorebookMappingTemplates.importWithTemplate(
            raw = raw,
            template = minimalTemplate,
            id = "lb-map",
            fallbackName = "兜底名",
            now = 7.0,
            contentHash = "h",
        )
        assertEquals(2, result.document.entries.size)
        assertEquals("mapping.tpl-1", result.document.source?.adapterId)
        assertEquals("template", result.document.source?.formatVersion)
        assertEquals("第三方格式书", result.document.name)
        assertEquals(listOf("王城", "首都"), result.document.entries[0].activation.primaryKeys)
        assertEquals("王城", result.document.entries[0].title)
        assertEquals("遗迹在北方。", result.document.entries[1].content)
        // 归一化产物必须过 canonical 校验，否则编辑器打不开
        assertTrue(LorebookValidation.validateCanonicalV2(result.document.toJsonMap()).valid)
        assertEquals(0, result.summary.rejected)
    }

    @Test
    fun unmappedFieldsStayInTheMappingNamespace() {
        val raw = linkedMapOf(
            "entries" to listOf(
                linkedMapOf("trigger" to "A", "text" to "正文", "vendorOnly" to linkedMapOf("x" to 1L)),
            ),
        )
        val template = minimalTemplate.copy(entriesPath = "entries")
        val result = LorebookMappingTemplates.importWithTemplate(raw, template, fallbackName = "书", now = 1.0, contentHash = "h")
        @Suppress("UNCHECKED_CAST")
        val namespace = result.document.entries.first().foreign?.get("qingyu.mapping") as? Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val source = namespace?.get("source") as? Map<String, Any?>
        assertNotNull("未映射字段必须留在 qingyu.mapping 下", source?.get("vendorOnly"))
        assertEquals(1, result.issues.count { it.code == "mapping_unknown_field" })
    }

    @Test
    fun missingTemplatePathsAreReportedPerEntryInsteadOfSilentlyDefaulting() {
        val raw = linkedMapOf(
            "entries" to listOf(
                linkedMapOf("trigger" to "A", "text" to "正文"), // 没有 label
            ),
        )
        val template = minimalTemplate.copy(entriesPath = "entries")
        val result = LorebookMappingTemplates.importWithTemplate(raw, template, fallbackName = "书", now = 1.0, contentHash = "h")
        val missing = result.issues.filter { it.code == "mapping_field_missing" }
        assertEquals(1, missing.size)
        assertTrue(missing.first().message.contains("title"))
        assertEquals(1, result.summary.dropped)
    }

    @Test
    fun nonArrayEntriesPathIsRejectedWithAContextualPath() {
        val result = LorebookMappingTemplates.importWithTemplate(
            raw = linkedMapOf("data" to linkedMapOf("book" to "不是数组")),
            template = minimalTemplate,
            fallbackName = "书",
        )
        assertEquals(1, result.issues.size)
        assertEquals("mapping_entries_not_found", result.issues.first().code)
        assertEquals("data.book.entries", result.issues.first().path)
        assertTrue(result.document.entries.isEmpty())
        assertEquals(1, result.summary.rejected)
        // 拒绝时也要给出一份结构合法的「空文档」，调用方才能直接展示诊断
        assertTrue(LorebookValidation.validateCanonicalV2(result.document.toJsonMap()).valid)
    }

    @Test
    fun topLevelArrayTemplateUsesEmptyEntriesPath() {
        val template = minimalTemplate.copy(entriesPath = "")
        val result = LorebookMappingTemplates.importWithTemplate(
            raw = listOf(linkedMapOf("trigger" to "A", "text" to "正文")),
            template = template,
            fallbackName = "书",
            now = 1.0,
            contentHash = "h",
        )
        assertEquals(1, result.document.entries.size)
        assertEquals("书", result.document.name)
    }

    // ------------------------------------------------------------ 受限 DSL 的安全边界

    @Test
    fun templateRejectsExecutableLookingPaths() {
        listOf(
            "process.exit()",
            "a; rm -rf",
            "`id`",
            "\${jndi:ldap://x}",
            "constructor",
            "__proto__.x",
        ).forEach { hostile ->
            val json = LorebookJson.stringify(
                linkedMapOf(
                    "id" to "t", "name" to "模板", "createdAt" to 1.0, "updatedAt" to 1.0,
                    "entriesPath" to "entries",
                    "fields" to linkedMapOf("keys" to hostile, "content" to "content"),
                ),
            )
            val thrown = runCatching { LorebookMappingTemplates.requireTemplate(json) }.exceptionOrNull()
            assertTrue("应拒绝路径 '$hostile'", thrown is IllegalArgumentException)
        }
    }

    @Test
    fun templateKeysAreClosed() {
        val json = LorebookJson.stringify(
            linkedMapOf(
                "id" to "t", "name" to "模板", "entriesPath" to "entries",
                "fields" to linkedMapOf("keys" to "k", "content" to "c"),
                "evalScript" to "alert(1)",
            ),
        )
        val thrown = runCatching { LorebookMappingTemplates.requireTemplate(json) }.exceptionOrNull()
        assertTrue(thrown is IllegalArgumentException)
        assertTrue(thrown?.message?.contains("evalScript") == true)
    }

    @Test
    fun templateRequiresNonEmptyKeyAndContentPaths() {
        val json = LorebookJson.stringify(
            linkedMapOf(
                "id" to "t", "name" to "模板", "entriesPath" to "entries",
                "fields" to linkedMapOf("keys" to "  ", "content" to "c"),
            ),
        )
        assertTrue(runCatching { LorebookMappingTemplates.requireTemplate(json) }.isFailure)
    }

    @Test
    fun deeplyNestedTemplateIsRejectedBeforeParsing() {
        val nested = "[".repeat(400) + "]".repeat(400)
        val thrown = runCatching { LorebookMappingTemplates.requireTemplate(nested) }.exceptionOrNull()
        assertTrue(thrown is IllegalArgumentException)
        assertTrue(thrown?.message?.contains("嵌套深度") == true)
    }

    @Test
    fun templateRoundTripsThroughJson() {
        val parsed = LorebookMappingTemplates.requireTemplate(LorebookJson.stringify(minimalTemplate.toJsonMap()))
        assertEquals(minimalTemplate, parsed)
        assertTrue(LorebookMappingTemplates.isMappingTemplate(minimalTemplate.toJsonMap()))
        assertNull(LorebookMappingTemplates.guessMappingTemplate(42L))
    }

    @Test
    fun guessFindsCommonShapesWithoutInventingPaths() {
        val guessed = LorebookMappingTemplates.guessMappingTemplate(
            linkedMapOf("entries" to listOf(linkedMapOf("keys" to listOf("A"), "comment" to "标题", "content" to "正文"))),
            name = "猜的",
            now = 100.0,
        )
        assertNotNull(guessed)
        assertEquals("entries", guessed!!.entriesPath)
        assertEquals("keys", guessed.fields.keys)
        assertEquals("content", guessed.fields.content)
        assertEquals("comment", guessed.fields.title)
        // 没有关键词字段时不能瞎猜出一个路径来
        assertNull(LorebookMappingTemplates.guessMappingTemplate(linkedMapOf("entries" to listOf(linkedMapOf("x" to 1L)))))
    }

    // ------------------------------------------------------------ 与节点式 DSL 的桥

    @Test
    fun nodeStyleTemplateFoldsLosslesslyWhenEveryNodeIsAFieldChain() {
        val dsl = LorebookJson.stringify(
            linkedMapOf(
                "name" to "节点式模板",
                "sourceFormat" to "generic",
                "mappings" to listOf(
                    linkedMapOf(
                        "target" to linkedMapOf("kind" to "field", "name" to "entries"),
                        "source" to linkedMapOf("kind" to "field", "name" to "book", "of" to linkedMapOf("kind" to "field", "name" to "data")),
                    ),
                    linkedMapOf(
                        "target" to linkedMapOf("kind" to "field", "name" to "keys"),
                        "source" to linkedMapOf("kind" to "field", "name" to "trigger"),
                    ),
                    linkedMapOf(
                        "target" to linkedMapOf("kind" to "field", "name" to "content"),
                        "source" to linkedMapOf("kind" to "field", "name" to "text"),
                    ),
                ),
            ),
        )
        val template = LorebookMappingTemplates.fromDslJson(dsl)
        assertEquals("data.book", template.entriesPath)
        assertEquals("trigger", template.fields.keys)
        assertEquals("text", template.fields.content)
    }

    @Test
    fun nodeStyleTemplateWithIndexOrConstNodesIsRejectedNotGuessed() {
        val dsl = LorebookJson.stringify(
            linkedMapOf(
                "mappings" to listOf(
                    linkedMapOf(
                        "target" to linkedMapOf("kind" to "field", "name" to "entries"),
                        "source" to linkedMapOf("kind" to "field", "name" to "entries"),
                    ),
                    linkedMapOf(
                        "target" to linkedMapOf("kind" to "field", "name" to "content"),
                        "source" to linkedMapOf("kind" to "const", "value" to "硬编码正文"),
                    ),
                ),
            ),
        )
        val thrown = runCatching { LorebookMappingTemplates.fromDslJson(dsl) }.exceptionOrNull()
        assertTrue("含 const 节点的模板不能静默丢映射", thrown is IllegalArgumentException)
    }

    @Test
    fun mappingWizardOffersNoExport() {
        // 方案 §6.3：映射向导只进不出。registry 里根本不存在 mapping.* 适配器。
        assertNull(LorebookImportExport.registry.get("mapping.tpl-1"))
        val exported = LorebookImportExport.exportToText(
            LorebookMappingTemplates.importWithTemplate(
                linkedMapOf("entries" to listOf(linkedMapOf("trigger" to "A", "text" to "B"))),
                minimalTemplate.copy(entriesPath = "entries"),
                fallbackName = "书",
            ).document,
            "mapping.tpl-1",
        )
        assertTrue(exported is LorebookImportExport.ExportResult.Unsupported)
    }
}
