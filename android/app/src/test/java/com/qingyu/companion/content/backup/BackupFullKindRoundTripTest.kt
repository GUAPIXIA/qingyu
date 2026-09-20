package com.qingyu.companion.content.backup

import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalLorebookEntity
import com.qingyu.companion.local.db.LocalLorebookMappingTemplateEntity
import com.qingyu.companion.local.db.LocalMessageEntity
import com.qingyu.companion.local.db.LocalPersonaEntity
import com.qingyu.companion.local.db.LocalPresetEntity
import com.qingyu.companion.local.db.LocalQuickReplySetEntity
import com.qingyu.companion.local.db.LocalRegexRuleEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.db.LocalUsageRecordEntity
import com.qingyu.companion.local.testing.FakeLocalStore
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 5 S5-08：**每一种实体 + 媒体**都要活过 `create → inspect → restore`。
 *
 * ## 为什么必须有这一条
 * 本阶段此前唯一的端到端往返用例只盯 `usage_clear_marker`（它自己的文档就写着「专门盯 …」），
 * 于是「打包器写了什么 / 恢复器读什么」对**其余每一类**都没有核对过——
 * 两边各说各话不会被任何门禁发现：单测各测各的、金丝雀只管 payload、设备用例只管失败路径。
 *
 * 写这条的当下就抓到一个真缺陷：**媒体一个都没被备份**。
 * `MediaImportGate` 把文件放在 `media/<kind>/<sha>.<ext>`，实体里的 `avatarRef` 就是那个相对路径，
 * 而 `create()` 只扫 `mediaRoot.listFiles()` 的**顶层文件**（非递归）——所以头像/背景全都没进包，
 * `counts["media"]` 恒为 0，恢复端拿到的是**指向缺失文件的引用**，而且没有任何报错或提示。
 * 旧注释写的是「只带被实体引用得到的文件」，即注释描述的是意图、代码做的是另一件事。
 *
 * 因此这条用例的职责有两层：① 每类实体的**逐字段**保真；② 媒体按真实布局（子目录）往返。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class BackupFullKindRoundTripTest {

    private fun mediaRoot(label: String): File =
        File(System.getProperty("java.io.tmpdir"), "qingyu-fullkind-$label-${System.nanoTime()}")
            .apply { mkdirs() }

    @Test
    fun everyEntityKindAndMediaSurvivesTheRoundTrip() = runBlocking {
        val source = FakeLocalStore("pc-device")
        val srcMedia = mediaRoot("src")
        seedEveryKind(source, srcMedia)

        val orchestrator = BackupOrchestrator(source, srcMedia, "0.3.0")
        val bundle = orchestrator.create()

        // 预检：只读、且能把条目数与来源报出来
        val plan = orchestrator.inspect(bundle.bytes)
        assertNotNull(plan, "自己产出的包必须能通过预检")
        assertEquals(3, bundle.manifest.counts["media"], "三份媒体都必须进包（这正是此前漏掉的那一类）")

        // 恢复到另一台设备
        val target = FakeLocalStore("android-device")
        val dstMedia = mediaRoot("dst")
        val outcome = BackupOrchestrator(target, dstMedia, "0.3.0").restore(bundle.bytes)
        assertTrue(outcome.ok, "恢复必须成功：${outcome.error}")

        // ---- 角色（含被引用的媒体相对路径）
        val character = target.listCharacters().single()
        assertEquals("c-1", character.id)
        assertEquals("角色一", character.name)
        assertEquals("描述", character.description)
        assertEquals("SP", character.systemPrompt)
        assertEquals("""["a","b"]""", character.tagsJson)
        assertEquals("""["备选"]""", character.alternateGreetingsJson)
        assertEquals("""["lb-1"]""", character.boundLorebookIdsJson)
        assertEquals("""{"x":1}""", character.extensionsJson)
        assertEquals("avatar/aaa.png", character.avatarPath)
        assertEquals("background/bbb.jpg", character.backgroundPath)

        // ---- 世界书 / 预设 / 人设 / 正则 / 映射模板
        // 用**解析后取值**比较，不用整串相等：恢复端会把文档重新序列化，键序/空白不保证逐字节相同
        val lorebook = org.json.JSONObject(target.listLorebooks().single().canonicalJson)
        assertEquals("lb-1", lorebook.getString("id"))
        assertEquals("书一", lorebook.getString("name"))
        assertEquals(0, lorebook.getJSONArray("entries").length())
        val preset = target.listPresets().single()
        assertEquals("预设一", preset.name)
        val presetBody = org.json.JSONObject(preset.bodyJson)
        assertEquals(0.8, presetBody.getDouble("temperature"))
        assertEquals("预设一", presetBody.getString("name"), "整个预设对象（含元数据）都要回到 bodyJson")
        val persona = target.listPersonas().single()
        assertEquals("p", persona.persona)
        assertEquals("persona/ccc.png", persona.avatarPath)
        val rule = target.listRegexRules().single()
        assertEquals("a", rule.pattern)
        assertEquals("b", rule.replacement)
        assertEquals("output", rule.scope)
        val template = target.listLorebookMappingTemplates().single()
        assertEquals("模板一", template.name)
        val mapping = org.json.JSONObject(template.templateJson).getJSONArray("mappings").getJSONObject(0)
        assertEquals(
            "entries",
            mapping.getJSONObject("target").getString("name"),
            "映射模板的映射内容必须原样带过来（受限 DSL 的节点结构就是模板的全部意义）",
        )
        // ---- 快捷回复（整库替换语义）
        assertEquals("""[{"label":"x"}]""", target.listQuickReplySets().single().itemsJson)

        // ---- 会话与消息（含翻译 / 候选 / 序号）
        val session = target.listSessions().single()
        assertEquals("s-1", session.id)
        assertEquals("会话一", session.title)
        assertEquals("""["lb-1"]""", session.lorebookIdsJson)
        val messages = target.listMessages("s-1").sortedBy { it.seq }
        assertEquals(listOf("m-1", "m-2"), messages.map { it.id })
        assertEquals(listOf("你好", "你也好"), messages.map { it.content })
        assertEquals("hello", messages[1].translation)
        assertEquals("""["甲","乙"]""", messages[1].swipesJson)
        assertEquals(1, messages[1].swipeIndex)
        assertEquals(listOf(0L, 1L), messages.map { it.seq })

        // ---- 用量记录
        val usage = target.listUsage(limit = 100).single()
        assertEquals("u-1", usage.id)
        assertEquals(3, usage.inputChars)
        assertEquals(4, usage.outputChars)

        // ---- 恢复计数（媒体走 mediaRestored，其余走 applied）
        assertEquals(1, outcome.applied["characters"])
        assertEquals(1, outcome.applied["sessions"])
        assertEquals(3, outcome.mediaRestored, "三份媒体都要真正落位到目标目录")

        // ---- 媒体文件本身：按真实布局（<kind>/ 子目录）逐字节保真
        for (rel in listOf("avatar/aaa.png", "background/bbb.jpg", "persona/ccc.png")) {
            val restored = File(dstMedia, rel)
            assertTrue(restored.isFile, "$rel 必须被恢复到目标媒体目录（引用指向的正是它）")
            assertEquals(
                File(srcMedia, rel).readBytes().toList(),
                restored.readBytes().toList(),
                "$rel 的内容必须逐字节一致",
            )
        }
    }

    /** 用**真实写入路径**铺满每一类实体；媒体按 `MediaImportGate` 的真实布局放进 `<kind>/`。 */
    private suspend fun seedEveryKind(source: FakeLocalStore, media: File) {
        source.putCharacter(
            LocalCharacterEntity(
                id = "c-1",
                name = "角色一",
                description = "描述",
                personality = "性格",
                scenario = "场景",
                firstMessage = "你好",
                exampleDialog = "示例",
                systemPrompt = "SP",
                tagsJson = """["a","b"]""",
                alternateGreetingsJson = """["备选"]""",
                boundLorebookIdsJson = """["lb-1"]""",
                extensionsJson = """{"x":1}""",
                avatarPath = "avatar/aaa.png",
                backgroundPath = "background/bbb.jpg",
                createdAt = 1L,
                updatedAt = 2L,
            ),
        )
        source.putLorebook(
            LocalLorebookEntity(
                id = "lb-1",
                name = "书一",
                canonicalJson = VALID_LOREBOOK_JSON,
                createdAt = 1L,
                updatedAt = 2L,
            ),
        )
        source.putPreset(
            LocalPresetEntity(
                id = "p-1",
                name = "预设一",
                // 约定：bodyJson 是「整个预设对象（含 name/description/isBuiltin）+ id」，
                // 见 `SyncPayloadGoldenTest.presetPayloadIsWholeBodyMinusId`。种子必须按这个形状，
                // 否则测的是「往返会把非约定形状归一化」——那不是缺陷。
                bodyJson = PRESET_JSON,
                description = "d",
                createdAt = 1L,
                updatedAt = 2L,
            ),
        )
        source.putPersona(
            LocalPersonaEntity(
                id = "pe-1",
                name = "人设一",
                description = "d",
                persona = "p",
                avatarPath = "persona/ccc.png",
                createdAt = 1L,
                updatedAt = 2L,
            ),
        )
        source.putRegexRule(
            LocalRegexRuleEntity(
                id = "r-1",
                name = "规则一",
                pattern = "a",
                replacement = "b",
                flags = "g",
                scope = "output",
                enabled = true,
                sortIndex = 0,
                createdAt = 1L,
                updatedAt = 2L,
            ),
        )
        source.putLorebookMappingTemplate(
            LocalLorebookMappingTemplateEntity(
                id = "t-1",
                name = "模板一",
                sourceFormat = "generic",
                templateJson = VALID_TEMPLATE_JSON,
                createdAt = 1L,
                updatedAt = 2L,
            ),
        )
        source.putQuickReplySet(
            LocalQuickReplySetEntity(
                id = "q-1",
                name = "集合一",
                itemsJson = """[{"label":"x"}]""",
                sortIndex = 0,
                characterId = null,
                createdAt = 1L,
                updatedAt = 2L,
            ),
        )
        source.putSession(
            LocalSessionEntity(
                id = "s-1",
                characterId = "c-1",
                title = "会话一",
                lorebookIdsJson = """["lb-1"]""",
                createdAt = 1L,
                updatedAt = 2L,
            ),
        )
        source.appendMessage(
            LocalMessageEntity(
                id = "m-1",
                sessionId = "s-1",
                characterId = "c-1",
                role = "user",
                content = "你好",
                logicalTime = 10L,
                seq = 0L,
                createdAt = 1L,
                updatedAt = 2L,
            ),
        )
        source.appendMessage(
            LocalMessageEntity(
                id = "m-2",
                sessionId = "s-1",
                characterId = "c-1",
                role = "assistant",
                content = "你也好",
                translation = "hello",
                swipesJson = """["甲","乙"]""",
                swipeIndex = 1,
                logicalTime = 11L,
                seq = 1L,
                createdAt = 1L,
                updatedAt = 2L,
            ),
        )
        source.recordUsage(
            LocalUsageRecordEntity(
                id = "u-1",
                model = "gpt",
                createdAt = 5L,
                characterId = "c-1",
                sessionId = "s-1",
                inputChars = 3,
                outputChars = 4,
            ),
        )

        // 媒体：**按真实布局**放进 <kind>/ 子目录（顶层平铺是错的布局，测不出这个缺陷）
        writeMedia(media, "avatar/aaa.png", byteArrayOf(1, 2, 3))
        writeMedia(media, "background/bbb.jpg", ByteArray(1024) { (it % 200).toByte() })
        writeMedia(media, "persona/ccc.png", byteArrayOf(9, 9))
    }

    private fun writeMedia(root: File, rel: String, bytes: ByteArray) {
        val file = File(root, rel)
        file.parentFile?.mkdirs()
        file.writeBytes(bytes)
    }

    private companion object {
        /** 一份**通过受限 DSL 校验**的最小模板（顶层只允许 mappings / name / sourceFormat）。 */
        private const val VALID_TEMPLATE_JSON =
            """{"name":"模板一","sourceFormat":"generic","mappings":[""" +
                """{"target":{"kind":"field","name":"entries"},"source":{"kind":"field","name":"book"}}]}"""

        /**
         * 一份**形态正确**的 canonical v2 世界书文档（含 `id`）。
         *
         * 注意 `id` 必须在文档里：备份的条目路径是 `lorebooks/<id>.json`，而恢复端是按
         * **文档里的 `id`** 建行的——所以「文档缺 id」会让整本书被静默跳过。
         */
        private const val VALID_LOREBOOK_JSON =
            """{"schema":"qingyu.lorebook","schemaVersion":2,"id":"lb-1","revision":1,""" +
                """"name":"书一","description":"","enabled":true,"defaults":{"scanDepth":10},""" +
                """"entries":[],"createdAt":1,"updatedAt":2}"""

        /** 约定形状的预设正文：整个对象 + `id`（`bodyJson` 就该长这样）。 */
        private const val PRESET_JSON =
            """{"id":"p-1","name":"预设一","description":"d","isBuiltin":false,"temperature":0.8}"""
    }
}
