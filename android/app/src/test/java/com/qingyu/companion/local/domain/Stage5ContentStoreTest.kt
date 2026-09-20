package com.qingyu.companion.local.domain

import android.app.Application
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.qingyu.companion.local.db.ChangeLogEntity
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalLorebookEntity
import com.qingyu.companion.local.db.LocalLorebookMappingTemplateEntity
import com.qingyu.companion.local.db.LocalPersonaEntity
import com.qingyu.companion.local.db.LocalPresetEntity
import com.qingyu.companion.local.db.LocalQuickReplySetEntity
import com.qingyu.companion.local.db.LocalRegexRuleEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.db.LocalUsageRecordEntity
import com.qingyu.companion.local.db.QingyuLocalDatabase
import com.qingyu.companion.local.testing.FakeLocalStore
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 5「内容管理功能对齐」的仓储层测试。
 *
 * 覆盖的是**跨端契约粒度**而不是 CRUD：payload 键名、快捷回复与公开设置的实体 id、
 * 用量清理的因果判定、映射模板的受限 DSL。这些语义在 Room 与替身上必须逐字一致，
 * 因此每个用例都跑两个实现（`LocalRepositoryContractTest` 的同款做法）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class Stage5ContentStoreTest {

    private val databases = mutableListOf<QingyuLocalDatabase>()

    @After
    fun tearDown() {
        databases.forEach { runCatching { it.close() } }
        databases.clear()
    }

    private fun newRoomStore(): LocalStore {
        val context: Application = ApplicationProvider.getApplicationContext()
        val database = Room.inMemoryDatabaseBuilder(context, QingyuLocalDatabase::class.java)
            .allowMainThreadQueries()
            .addCallback(QingyuLocalDatabase.FOREIGN_KEYS_CALLBACK)
            .build()
        databases += database
        return RoomLocalSyncRepository(database, DEVICE)
    }

    /** 每个用例都跑两遍：Room 与内存替身必须给出同样的 journal 形状。 */
    private suspend fun eachStore(block: suspend (String, LocalStore) -> Unit) {
        block("room", newRoomStore())
        block("fake", FakeLocalStore(DEVICE))
    }

    private fun payloadOf(change: ChangeLogEntity): JSONObject =
        JSONObject(change.envelopeJson).getJSONObject("payload")

    // ---------------------------------------------------------------- S5-01 角色

    @Test
    fun `character journal payload carries canonical keys not room columns`() = runBlocking {
        eachStore { name, store ->
            store.putCharacter(
                LocalCharacterEntity(
                    id = "c1",
                    name = "Alice",
                    description = "雨夜的画师",
                    personality = "安静",
                    scenario = "画廊",
                    firstMessage = "你来了。",
                    exampleDialogueJson = """["旧版有损数据"]""",
                    avatarPath = "avatars/c1.png",
                    backgroundPath = "bg/c1.png",
                    extensionsJson = """{"art":"ink"}""",
                    lorebookId = "legacy-lorebook",
                    defaultPresetId = "pr1",
                    defaultPersonaId = "pe1",
                    createdAt = 0,
                    updatedAt = 0,
                    exampleDialog = "<START>\n苏晚: 你来了",
                    systemPrompt = "扮演苏晚",
                    creator = "qingyu",
                    tagsJson = """["治愈"]""",
                    alternateGreetingsJson = """["又见面了"]""",
                    boundLorebookIdsJson = """["lb1","lb2"]""",
                ),
            )
            val change = store.changesAfter(0, 10).single()
            assertEquals("$name/entity-type", EntityTypes.CHARACTER, change.entityType)
            assertEquals("$name/entity-id", "c1", change.entityId)
            val payload = payloadOf(change)

            // Room 列名一旦泄漏进 payload，共享 schema（additionalProperties:false）就判非法。
            listOf(
                "exampleDialogueJson",
                "avatarPath",
                "backgroundPath",
                "lorebookId",
                "defaultPresetId",
                "defaultPersonaId",
                "extensionsJson",
            ).forEach { leaked ->
                assertFalse("$name/列名泄漏 $leaked", payload.has(leaked))
            }

            assertTrue("$name/exampleDialog", payload.has("exampleDialog"))
            assertTrue("$name/boundLorebookIds", payload.has("boundLorebookIds"))
            assertEquals("$name/boundPresetId", "pr1", payload.getString("boundPresetId"))
            assertEquals("$name/exampleDialog", "<START>\n苏晚: 你来了", payload.getString("exampleDialog"))
            assertEquals("$name/tags", "治愈", payload.getJSONArray("tags").getString(0))
            assertEquals("$name/greetings", "又见面了", payload.getJSONArray("alternateGreetings").getString(0))
            assertEquals("$name/lorebooks", 2, payload.getJSONArray("boundLorebookIds").length())
            assertEquals("$name/extensions", "ink", payload.getJSONObject("extensions").getString("art"))

            // 列表侧：搜索/排序/分页下推 SQL；非法排序 token 回落白名单值。
            // 排序断言用 ASCII 名——SQLite 的 COLLATE NOCASE 对中文按码位比较，与语言环境无关但可读性差。
            store.putCharacter(LocalCharacterEntity(id = "c2", name = "Bob", createdAt = 50, updatedAt = 0))
            assertEquals("$name/count", 2, store.countCharacters(""))
            assertEquals("$name/search", listOf("c1", "c2"), store.searchCharacters("", "name", 10, 0).map { it.id })
            assertEquals(
                "$name/created-desc",
                listOf("c1", "c2"),
                store.searchCharacters("", "created", 10, 0).map { it.id },
            )
            assertEquals(
                "$name/hostile-token-falls-back",
                listOf("c1", "c2"),
                store.searchCharacters("", "name; DROP TABLE local_characters", 10, 0).map { it.id },
            )
            assertEquals("$name/paged", listOf("c2"), store.searchCharacters("", "name", 1, 1).map { it.id })
            assertEquals("$name/query", listOf("c2"), store.searchCharacters("Bo", "name", 10, 0).map { it.id })
            assertEquals("$name/updated-still-whitelisted", 2, store.searchCharacters("", "updated", 10, 0).size)
        }
    }

    @Test
    fun `character delete impact and message counts are reported before deleting`() = runBlocking {
        eachStore { name, store ->
            store.putCharacter(LocalCharacterEntity(id = "c1", name = "A", createdAt = 0, updatedAt = 0))
            store.putSession(LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0))
            val impact = store.characterBindingImpact("c1")
            assertEquals("$name/sessions", 1, impact.sessions)
            assertEquals("$name/characters", 0, impact.characters)
            assertFalse("$name/not-empty", impact.isEmpty)
            assertEquals("$name/messages", 0, store.characterMessageCount("c1"))
        }
    }

    // ---------------------------------------------------------------- S5-06 快捷回复

    @Test
    fun `quick reply writes journal for the whole store under one entity id`() = runBlocking {
        eachStore { name, store ->
            store.putCharacter(LocalCharacterEntity(id = "c1", name = "A", createdAt = 0, updatedAt = 0))
            store.putQuickReplySet(
                LocalQuickReplySetEntity(
                    id = "qr-global",
                    name = "全局",
                    itemsJson = """[{"content":"你好"}]""",
                    characterId = null,
                    sortIndex = 0,
                    createdAt = 0,
                    updatedAt = 0,
                ),
            )
            store.putQuickReplySet(
                LocalQuickReplySetEntity(
                    id = "qr-char",
                    name = "角色级",
                    itemsJson = """[{"content":"再讲一遍"}]""",
                    characterId = "c1",
                    sortIndex = 1,
                    createdAt = 0,
                    updatedAt = 0,
                ),
            )
            val changes = store.changesAfter(0, 20).filter { it.entityType == EntityTypes.QUICK_REPLY_SET }
            assertEquals("$name/two-store-journals", 2, changes.size)
            changes.forEach {
                assertEquals("$name/root-id", CanonicalEntityIds.QUICK_REPLY_ROOT, it.entityId)
            }

            val payload = payloadOf(changes.last())
            assertEquals("$name/global-items", 1, payload.getJSONArray("global").length())
            val byCharacter = payload.getJSONObject("byCharacter")
            assertEquals("$name/by-character-keys", 1, byCharacter.length())
            assertEquals("$name/character-items", 1, byCharacter.getJSONArray("c1").length())

            assertEquals("$name/global-sets", listOf("qr-global"), store.listGlobalQuickReplySets().map { it.id })
            assertEquals("$name/character-sets", listOf("qr-char"), store.listCharacterQuickReplySets("c1").map { it.id })
            assertNotNull("$name/get-by-id", store.getQuickReplySet("qr-char"))

            // 删掉角色最后一个集合：整库 payload 收缩，同时补一条 qr-char-<id> tombstone。
            store.deleteQuickReplySet("qr-char")
            assertTrue(
                "$name/character-tombstone",
                store.isTombstoned(EntityTypes.QUICK_REPLY_SET, "qr-char-c1"),
            )
            val afterDelete = payloadOf(
                store.changesAfter(0, 30).last { it.entityId == CanonicalEntityIds.QUICK_REPLY_ROOT },
            )
            assertEquals("$name/by-character-cleared", 0, afterDelete.getJSONObject("byCharacter").length())
        }
    }

    @Test
    fun `deleting a character removes its scoped quick reply sets without orphans`() = runBlocking {
        eachStore { name, store ->
            store.putCharacter(LocalCharacterEntity(id = "c1", name = "A", createdAt = 0, updatedAt = 0))
            store.putQuickReplySet(
                LocalQuickReplySetEntity(
                    id = "qr-char",
                    name = "角色级",
                    itemsJson = """[{"content":"嗨"}]""",
                    characterId = "c1",
                    createdAt = 0,
                    updatedAt = 0,
                ),
            )
            val beforeJournal = store.journalChangeCount()
            store.deleteCharacter("c1")
            assertEquals("$name/no-orphan-set", emptyList<String>(), store.listCharacterQuickReplySets("c1").map { it.id })
            assertTrue(
                "$name/character-tombstoned",
                store.isTombstoned(EntityTypes.CHARACTER, "c1"),
            )
            assertTrue(
                "$name/set-tombstoned",
                store.isTombstoned(EntityTypes.QUICK_REPLY_SET, "qr-char-c1"),
            )
            // 子实体的 journal 必须排在父实体 tombstone 之前，重放时才不会出现可见孤儿。
            val types = store.changesAfter(0, 30).drop(beforeJournal).map { it.entityId }
            assertEquals(
                "$name/journal-order",
                listOf(CanonicalEntityIds.QUICK_REPLY_ROOT, "qr-char-c1", "c1"),
                types.filter { it == "c1" || it.startsWith("qr-") || it == CanonicalEntityIds.QUICK_REPLY_ROOT },
            )
            // 没有角色级集合时，删角色不得凭空多出一条快捷回复 journal（只留 tombstone 一条）。
            store.putCharacter(LocalCharacterEntity(id = "c2", name = "B", createdAt = 0, updatedAt = 0))
            val quietBefore = store.journalChangeCount()
            store.deleteCharacter("c2")
            assertEquals("$name/no-noise-journal", 1, store.journalChangeCount() - quietBefore)
        }
    }

    // ---------------------------------------------------------------- S5-07 公开设置

    @Test
    fun `public settings journal one aggregate entity instead of one entity per key`() = runBlocking {
        eachStore { name, store ->
            store.putPublicSetting("appearance", "theme", "\"dark\"")
            store.putPublicSetting("locale", "language", "\"zh-CN\"")
            val changes = store.changesAfter(0, 10)
            assertEquals("$name/two-changes", 2, changes.size)
            changes.forEach {
                assertEquals("$name/aggregate-id", CanonicalEntityIds.SETTINGS_PUBLIC, it.entityId)
                assertEquals("$name/entity-type", EntityTypes.SETTINGS_PUBLIC, it.entityType)
            }
            val first = payloadOf(changes[0])
            assertEquals("$name/first-theme", "dark", first.getString("theme"))
            assertFalse("$name/first-has-no-language", first.has("language"))
            val second = payloadOf(changes[1])
            assertEquals("$name/second-theme", "dark", second.getString("theme"))
            assertEquals("$name/second-language", "zh-CN", second.getString("language"))
            assertEquals("$name/rows-kept", 2, store.listPublicSettings().size)
        }
    }

    // ---------------------------------------------------------------- S5-07 用量

    @Test
    fun `usage aggregate groups per dimension on both implementations`() = runBlocking {
        eachStore { name, store ->
            store.recordUsage(
                LocalUsageRecordEntity(
                    id = "u1",
                    provider = "openai",
                    model = "gpt-a",
                    characterId = "c1",
                    dateKey = "2026-09-18",
                    status = "success",
                    inputChars = 10,
                    outputChars = 4,
                    promptTokens = 3,
                    completionTokens = 1,
                    createdAt = 100,
                    taskType = "main",
                ),
            )
            store.recordUsage(
                LocalUsageRecordEntity(
                    id = "u2",
                    provider = "openai",
                    model = "gpt-b",
                    characterId = "c2",
                    dateKey = "2026-09-19",
                    status = "error",
                    inputChars = 20,
                    outputChars = 0,
                    createdAt = 200,
                    taskType = "memory",
                ),
            )
            val expectedKeys = mapOf(
                // provider 两条记录相同 ⇒ 只有一组、records = 2；其余维度各两组。
                UsageDimension.MODEL to setOf("gpt-a", "gpt-b"),
                UsageDimension.PROVIDER to setOf("openai"),
                UsageDimension.CHARACTER to setOf("c1", "c2"),
                UsageDimension.DATE to setOf("2026-09-18", "2026-09-19"),
                UsageDimension.STATUS to setOf("success", "error"),
            )
            expectedKeys.forEach { (dimension, keys) ->
                val rows = store.usageAggregate(dimension, 0, Long.MAX_VALUE, "")
                assertEquals(
                    "$name/${dimension.name}-keys",
                    keys,
                    rows.mapNotNull { it.group_key }.toSet(),
                )
                assertEquals("$name/${dimension.name}-total", 2, rows.sumOf { it.records })
                assertEquals("$name/${dimension.name}-chars", 30L, rows.sumOf { it.input_chars })
                assertEquals("$name/${dimension.name}-out", 4L, rows.sumOf { it.output_chars })
            }
            // taskType 过滤与区间过滤都必须生效，否则用量页会把记忆任务的开销算进聊天。
            val mainOnly = store.usageAggregate(UsageDimension.MODEL, 0, Long.MAX_VALUE, "main")
            assertEquals("$name/task-filter", listOf("gpt-a"), mainOnly.map { it.group_key })
            assertEquals("$name/task-sums", 4L, mainOnly.single().output_chars)
            assertEquals("$name/range-filter", 0, store.usageAggregate(UsageDimension.MODEL, 0, 99, "").size)
        }
    }

    @Test
    fun `clear usage keeps records that the marker does not causally dominate`() = runBlocking {
        eachStore { name, store ->
            // 三条记录都由本机 dot 记账，counter 依次是 1/2/3。
            store.recordUsage(LocalUsageRecordEntity(id = "u-a", model = "m", createdAt = 100))
            store.recordUsage(LocalUsageRecordEntity(id = "u-b", model = "m", createdAt = 200))
            store.recordUsage(LocalUsageRecordEntity(id = "u-c", model = "m", createdAt = 300))
            assertEquals("$name/heads", mapOf("u-a" to "1", "u-b" to "2", "u-c" to "3"), usageDots(store))

            // 游标里根本没有本机 dot（记录的 device 在 marker 中无条目）⇒ 一条都不许删。
            val foreignOnly = store.clearUsage(mapOf("pc-b" to "99"))
            assertEquals("$name/absent-device-clears-nothing", emptyList<String>(), foreignOnly.clearedIds)
            assertEquals("$name/absent-device-retains-all", listOf("u-a", "u-b", "u-c"), foreignOnly.retainedIds.sorted())
            assertEquals("$name/nothing-lost", 3, store.listUsage(10).size)

            // 游标推进到本机 counter=1：A 被支配，B/C 计数器更大 ⇒ 保留。
            val cleared = store.clearUsage(mapOf(DEVICE to "1"))
            assertEquals("$name/dominated-cleared", listOf("u-a"), cleared.clearedIds)
            assertEquals("$name/higher-counter-retained", listOf("u-b", "u-c"), cleared.retainedIds.sorted())
            assertEquals("$name/a-gone", listOf("u-b", "u-c"), store.listUsage(10).map { it.id }.sorted())

            val marker = store.usageClearMarker(DEVICE)
            assertNotNull("$name/marker", marker)
            assertEquals(
                "$name/per-device-max",
                mapOf("pc-b" to "99", DEVICE to "1"),
                VersionVectorJson.decode(marker!!.clearedThroughJson),
            )
            assertEquals("$name/tombstoned-ids", listOf("u-a"), JsonValues.parseArray(marker.tombstonedIdsJson))

            // 更小的游标既不复活已删记录，也不重删，也不让任何设备的计数回退。
            val smaller = store.clearUsage(mapOf(DEVICE to "0"))
            assertEquals("$name/nothing-more-cleared", emptyList<String>(), smaller.clearedIds)
            assertEquals("$name/retained-unchanged", listOf("u-b", "u-c"), smaller.retainedIds.sorted())
            assertEquals("$name/a-still-gone", listOf("u-b", "u-c"), store.listUsage(10).map { it.id }.sorted())
            assertEquals(
                "$name/never-regress",
                mapOf("pc-b" to "99", DEVICE to "1"),
                VersionVectorJson.decode(store.usageClearMarker(DEVICE)!!.clearedThroughJson),
            )
            assertEquals(
                "$name/tombstones-accumulate",
                listOf("u-a"),
                JsonValues.parseArray(store.usageClearMarker(DEVICE)!!.tombstonedIdsJson),
            )

            // marker 本身是同步实体：journal 里必须能看到它，且 payload 符合共享 schema。
            val markerChange = store.changesAfter(0, 50).last { it.entityType == EntityTypes.USAGE_CLEAR_MARKER }
            assertEquals("$name/marker-entity-id", DEVICE, markerChange.entityId)
            val payload = payloadOf(markerChange)
            assertEquals(
                "$name/payload-keys",
                setOf("clearedThrough"),
                payload.keys().asSequence().toSet(),
            )
            val through = payload.getJSONObject("clearedThrough")
            through.keys().forEach { key ->
                assertTrue("$name/counter-is-decimal", Regex("^(0|[1-9][0-9]*)$").matches(through.getString(key)))
            }
            assertEquals("$name/marker-counted", 1, store.localCounts().usageClearMarkers)
        }
    }

    private suspend fun usageDots(store: LocalStore): Map<String, String> =
        store.listUsage(10).sortedBy { it.id }.associate { row ->
            val head = store.getHead(EntityTypes.USAGE_RECORD, row.id) ?: return@associate row.id to "<none>"
            row.id to VersionVectorJson.decode(head.versionJson).values.single()
        }

    // ---------------------------------------------------------------- S5-02 映射模板 DSL

    @Test
    fun `mapping template dsl accepts only the restricted node kinds`() {
        assertTrue(LorebookMappingTemplateDsl.isValid(VALID_TEMPLATE))
        LorebookMappingTemplateDsl.requireValid(VALID_TEMPLATE)

        val scriptKind = """{"mappings":[{"target":{"kind":"script","name":"a"},"source":{"kind":"field","name":"b"}}]}"""
        assertRejected("script-kind", scriptKind, "script")
        val executableConst = """{"mappings":[{"target":{"kind":"field","name":"a"},"source":{"kind":"const","value":"process.exit(1)"}}]}"""
        assertRejected("executable-const", executableConst, "(")
        val interpolation = """{"mappings":[{"target":{"kind":"field","name":"a"},"source":{"kind":"const","value":"${'$'}{x}"}}]}"""
        assertRejected("template-interpolation", interpolation, "$")
        assertRejected("unknown-top-level-key", """{"mappings":[],"script":"x"}""", "script")
        assertRejected("unknown-node-key", """{"mappings":[{"target":{"kind":"field","name":"a","eval":"x"},"source":{"kind":"index","at":0}}]}""", "eval")
        assertRejected("missing-mappings", """{"name":"无映射"}""", "mappings")
        assertRejected("negative-index", """{"mappings":[{"target":{"kind":"field","name":"a"},"source":{"kind":"index","at":-1}}]}""", "at")
        assertRejected("prototype-path", """{"mappings":[{"target":{"kind":"field","name":"a"},"source":{"kind":"field","name":"__proto__.x"}}]}""", "__proto__")
        assertRejected("trailing-content", """{"mappings":[]} garbage""", "多余内容")
        assertRejected("deep-nesting", """{"mappings":[{"target":{"kind":"field","name":"a"},"source":{"kind":"const","value":""" +
            "[".repeat(40) + "]".repeat(40) + """}}]}""", "深度")
        // 空映射与纯常量模板是合法的（导入向导允许先建空模板再补字段）。
        assertTrue(LorebookMappingTemplateDsl.isValid("""{"mappings":[]}"""))
    }

    @Test
    fun `invalid mapping template never reaches the database`() = runBlocking {
        eachStore { name, store ->
            val rejected = runCatching {
                store.putLorebookMappingTemplate(
                    LocalLorebookMappingTemplateEntity(
                        id = "tpl-1",
                        name = "恶意模板",
                        sourceFormat = "sillytavern",
                        templateJson = """{"mappings":[{"target":{"kind":"script","name":"a"},"source":{"kind":"field","name":"b"}}]}""",
                        createdAt = 0,
                        updatedAt = 0,
                    ),
                )
            }
            assertTrue("$name/rejected", rejected.isFailure)
            assertNull("$name/no-row", store.getLorebookMappingTemplate("tpl-1"))
            assertEquals("$name/no-journal", 0, store.journalChangeCount())

            store.putLorebookMappingTemplate(
                LocalLorebookMappingTemplateEntity(
                    id = "tpl-ok",
                    name = "Tavern 映射",
                    sourceFormat = "sillytavern",
                    templateJson = VALID_TEMPLATE,
                    createdAt = 0,
                    updatedAt = 0,
                ),
            )
            assertNotNull("$name/stored", store.getLorebookMappingTemplate("tpl-ok"))
            assertEquals("$name/listed", listOf("tpl-ok"), store.listLorebookMappingTemplates().map { it.id })
            val payload = payloadOf(store.changesAfter(0, 10).last())
            assertEquals("$name/has-mappings", 3, payload.getJSONArray("mappings").length())
            assertEquals("$name/source-format", "sillytavern", payload.getString("sourceFormat"))
            assertFalse("$name/no-id-in-payload", payload.has("id"))

            store.deleteLorebookMappingTemplate("tpl-ok")
            assertTrue("$name/tombstoned", store.isTombstoned(EntityTypes.LOREBOOK_MAPPING_TEMPLATE, "tpl-ok"))
            assertEquals("$name/template-counted", 0, store.localCounts().mappingTemplates)
        }
    }

    // ---------------------------------------------------------------- S5-03 预设解绑

    @Test
    fun `deleting a preset unbinds sessions and characters and leaves a tombstone`() = runBlocking {
        eachStore { name, store ->
            store.putCharacter(
                LocalCharacterEntity(id = "c1", name = "A", defaultPresetId = "pr1", createdAt = 0, updatedAt = 0),
            )
            store.putSession(LocalSessionEntity(id = "s1", characterId = "c1", presetId = "pr1", createdAt = 0, updatedAt = 0))
            store.putPreset(LocalPresetEntity(id = "pr1", name = "默认预设", bodyJson = """{"prompt":"p"}""", createdAt = 0, updatedAt = 0))
            store.putPreset(LocalPresetEntity(id = "pr-builtin", name = "内建", isBuiltin = true, sortIndex = 1, createdAt = 0, updatedAt = 0))

            val impact = store.presetBindingImpact("pr1")
            assertEquals("$name/impact-characters", 1, impact.characters)
            assertEquals("$name/impact-sessions", 1, impact.sessions)

            val before = store.deletePresetUnbindingReferences("pr1")
            assertEquals("$name/returns-impact", impact, before)
            assertNull("$name/preset-gone", store.getPreset("pr1"))
            assertEquals("$name/session-unbound", null, store.getSession("s1")!!.presetId)
            assertEquals("$name/character-unbound", null, store.getCharacter("c1")!!.defaultPresetId)
            assertNotNull("$name/tombstone-head", store.getHead(EntityTypes.PRESET, "pr1"))
            assertTrue("$name/tombstone-flag", store.isTombstoned(EntityTypes.PRESET, "pr1"))
            assertEquals(
                "$name/impact-is-gone-after",
                BindingImpact(characters = 0, sessions = 0),
                store.presetBindingImpact("pr1"),
            )
            // 内建分区只读地独立存在，删除用户预设不得波及它。
            assertEquals("$name/builtin-section", listOf("pr-builtin"), store.listPresetSection(true).map { it.id })
            assertEquals("$name/user-section", emptyList<String>(), store.listPresetSection(false).map { it.id })
        }
    }

    /**
     * §4 完成定义的硬条款：「所有写入进入 Repository 和 change journal」。
     *
     * 解绑改了 `character`/`session` 的行，如果只跑一句裸 UPDATE，两端行为一致地错，
     * 契约套件抓不到；所以这里断言的是**被解绑行的 head 版本必须因果推进**。
     */
    @Test
    fun `unbinding during preset delete journals the character and session rows`() = runBlocking {
        eachStore { name, store ->
            store.putCharacter(
                LocalCharacterEntity(id = "c-j", name = "A", defaultPresetId = "pr-j", createdAt = 0, updatedAt = 0),
            )
            store.putSession(
                LocalSessionEntity(id = "s-j", characterId = "c-j", presetId = "pr-j", createdAt = 0, updatedAt = 0),
            )
            store.putPreset(
                LocalPresetEntity(id = "pr-j", name = "被引用", bodyJson = """{"prompt":"p"}""", createdAt = 0, updatedAt = 0),
            )

            val characterBefore = store.getHead(EntityTypes.CHARACTER, "c-j")!!.versionJson
            val sessionBefore = store.getHead("session", "s-j")!!.versionJson
            val journalBefore = store.journalChangeCount()

            store.deletePresetUnbindingReferences("pr-j")

            val characterAfter = store.getHead(EntityTypes.CHARACTER, "c-j")!!.versionJson
            val sessionAfter = store.getHead("session", "s-j")!!.versionJson
            // `CounterVectors.dominates(被支配, 支配)`：与 `clearUsage` 的调用方向一致，
            // 所以「新版本因果推进」写作 dominates(before, after)。
            assertEquals("$name/character-unbound", null, store.getCharacter("c-j")!!.defaultPresetId)
            assertTrue(
                "$name/解绑后角色的 journal 版本必须因果推进，实际 $characterBefore → $characterAfter",
                CounterVectors.dominates(
                    VersionVectorJson.decode(characterBefore),
                    VersionVectorJson.decode(characterAfter),
                ) && VersionVectorJson.decode(characterBefore) != VersionVectorJson.decode(characterAfter),
            )
            assertTrue(
                "$name/解绑后会话的 journal 版本必须因果推进，实际 $sessionBefore → $sessionAfter",
                CounterVectors.dominates(
                    VersionVectorJson.decode(sessionBefore),
                    VersionVectorJson.decode(sessionAfter),
                ) && VersionVectorJson.decode(sessionBefore) != VersionVectorJson.decode(sessionAfter),
            )
            assertTrue(
                "$name/解绑必须留下变更纪录（预设 tombstone + 角色 + 会话至少 3 条）",
                store.journalChangeCount() >= journalBefore + 3,
            )
        }
    }

    /** S5-02：世界书删除同样要先解绑，且解绑要记账。 */
    @Test
    fun `deleting a bound lorebook unbinds characters and sessions and journals them`() = runBlocking {
        eachStore { name, store ->
            store.putLorebook(
                LocalLorebookEntity(
                    id = "lb-keep",
                    name = "保留",
                    canonicalJson = """{"schema":"qingyu_lorebook","id":"lb-keep"}""",
                    createdAt = 0,
                    updatedAt = 0,
                ),
            )
            store.putLorebook(
                LocalLorebookEntity(
                    id = "lb-gone",
                    name = "待删",
                    canonicalJson = """{"schema":"qingyu_lorebook","id":"lb-gone"}""",
                    createdAt = 0,
                    updatedAt = 0,
                ),
            )
            store.putCharacter(
                LocalCharacterEntity(
                    id = "c-lb",
                    name = "A",
                    lorebookId = "lb-gone",
                    boundLorebookIdsJson = """["lb-keep","lb-gone"]""",
                    createdAt = 0,
                    updatedAt = 0,
                ),
            )
            store.putSession(
                LocalSessionEntity(
                    id = "s-lb",
                    characterId = "c-lb",
                    lorebookIdsJson = """["lb-gone"]""",
                    createdAt = 0,
                    updatedAt = 0,
                ),
            )

            val impact = store.lorebookBindingImpact("lb-gone")
            assertEquals("$name/impact-characters", 1, impact.characters)
            assertEquals("$name/impact-sessions", 1, impact.sessions)
            val characterBefore = store.getHead(EntityTypes.CHARACTER, "c-lb")!!.versionJson

            assertEquals("$name/returns-impact", impact, store.deleteLorebookUnbindingReferences("lb-gone"))

            assertNull("$name/lorebook-gone", store.getLorebook("lb-gone"))
            assertNotNull("$name/tombstone-head", store.getHead(EntityTypes.LOREBOOK, "lb-gone"))
            val character = store.getCharacter("c-lb")!!
            assertEquals("$name/legacy-binding-cleared", null, character.lorebookId)
            assertEquals(
                "$name/其余绑定必须按原顺序保留",
                """["lb-keep"]""",
                character.boundLorebookIdsJson,
            )
            assertEquals("$name/session-unbound", "[]", store.getSession("s-lb")!!.lorebookIdsJson)
            assertEquals(
                "$name/impact-cleared",
                BindingImpact(characters = 0, sessions = 0),
                store.lorebookBindingImpact("lb-gone"),
            )
            assertTrue(
                "$name/角色解绑必须进 journal",
                CounterVectors.dominates(
                    VersionVectorJson.decode(characterBefore),
                    VersionVectorJson.decode(store.getHead(EntityTypes.CHARACTER, "c-lb")!!.versionJson),
                ) &&
                    VersionVectorJson.decode(store.getHead(EntityTypes.CHARACTER, "c-lb")!!.versionJson) !=
                    VersionVectorJson.decode(characterBefore),
            )
            assertNotNull("$name/保留的世界书还在", store.getLorebook("lb-keep"))
        }
    }

    /**
     * S5-07：自动保留上限淘汰旧用量记录时**必须产生同样的清理记录**。
     *
     * 上限值与淘汰顺序都对着 PC `usage.ts`（`MAX_RECORDS = 10000`，按 timestamp 保留最新）。
     * 这里刻意走 `recordUsage` 而不是直接删：只有这条路径会既删行又写 tombstone，
     * 也正是「静默删除同步记录」最容易被写错的地方。
     */
    @Test
    fun usageRetentionTrimEvictsOldestAndTombstonesEachEvictedRecord() = runBlocking {
        eachStore { name, store ->
            val limit = LocalStore.MAX_USAGE_RECORDS
            val oldest = ArrayList<String>(2)
            repeat(limit + 2) { index ->
                val id = if (index < 2) "u-0-$index".also { oldest += it } else "u-$index"
                assertTrue(
                    "$name/recordUsage($id) 应被接受",
                    store.recordUsage(
                        LocalUsageRecordEntity(
                            id = id,
                            provider = "mock",
                            model = "gpt-x",
                            createdAt = 1_000L + index,
                            inputChars = 1,
                            outputChars = 1,
                        ),
                    ),
                )
            }

            assertEquals("$name/保留上限", limit, store.listUsage(limit = Int.MAX_VALUE).size)
            val survivors = store.listUsage(limit = Int.MAX_VALUE).map { it.id }.toSet()
            assertTrue("$name/最旧的两条必须被淘汰", oldest.none { it in survivors })
            assertTrue("$name/最新的必须保留", "u-$limit" in survivors && "u-${limit + 1}" in survivors)
            oldest.forEach { id ->
                assertTrue("$name/$id 被淘汰必须是 tombstone 而不是无痕删除", store.isTombstoned(EntityTypes.USAGE_RECORD, id))
            }
        }
    }

    @Test
    fun `counter vector dominance and character sort whitelist`() {
        // 因果支配：每个分量都要 >=，缺分量即并发新事件。
        assertTrue(CounterVectors.dominates(mapOf("pc" to "5"), mapOf("pc" to "5", "other" to "1")))
        assertFalse(CounterVectors.dominates(mapOf("pc" to "6"), mapOf("pc" to "5")))
        assertFalse(CounterVectors.dominates(mapOf("android" to "1"), mapOf("pc" to "99")))
        assertFalse(CounterVectors.dominates(emptyMap(), mapOf("pc" to "99")))
        // UInt64 文本比较：9 < 10，且绝不经过 Long（>Long.MAX 仍是无符号串）。
        assertEquals(-1, CounterVectors.compare("9", "10"))
        assertEquals(1, CounterVectors.compare("18446744073709551615", "18446744073709551614"))
        assertEquals("18446744073709551615", CounterVectors.max("1", "18446744073709551615"))
        assertEquals(
            "per-device max",
            mapOf("a" to "9", "b" to "4"),
            CounterVectors.merge(mapOf("a" to "9", "b" to "1"), mapOf("a" to "2", "b" to "4")),
        )
        assertThrows(IllegalArgumentException::class.java) { CounterVectors.compare("007", "7") }
        assertThrows(IllegalArgumentException::class.java) { UsageClearMarkerPayload.of(mapOf("a" to "-1")) }

        assertEquals("name", CharacterSortColumn.resolve(null))
        assertEquals("name", CharacterSortColumn.resolve("bogus"))
        assertEquals("created", CharacterSortColumn.resolve("created"))
        assertEquals("updated", CharacterSortColumn.resolve("updated"))
    }

    private fun assertRejected(case: String, template: String, expectedFragment: String) {
        val failure = runCatching { LorebookMappingTemplateDsl.requireValid(template) }.exceptionOrNull()
        assertTrue("$case should be rejected", failure is IllegalArgumentException)
        assertNotNull("$case message", failure!!.message)
        assertTrue(
            "$case message names the offender: ${failure.message}",
            failure.message!!.contains(expectedFragment),
        )
        assertFalse("$case isValid", LorebookMappingTemplateDsl.isValid(template))
    }

    private companion object {
        const val DEVICE = "android-device-a"

        /** 合法模板：三种节点各一次（field / index / const）。 */
        val VALID_TEMPLATE = """
            {
              "name": "Tavern 通用映射",
              "sourceFormat": "sillytavern",
              "mappings": [
                {"target": {"kind": "field", "name": "keys"}, "source": {"kind": "field", "name": "entry.keywords"}},
                {"target": {"kind": "field", "name": "content"}, "source": {"kind": "index", "at": 0}},
                {"target": {"kind": "field", "name": "constant"}, "source": {"kind": "const", "value": true}}
              ]
            }
        """.trimIndent()
    }

    /**
     * §2「大型列表分页/搜索在数据库层执行」：世界书列表的关键字、页长与偏移都下推到 SQL。
     *
     * 这条同时是 Room 与替身的契约：总数与页内容必须同口径，
     * 否则最后一片会「还有更多」却加载出空页；排序差异也会让两端刷出不同顺序。
     * SQL 的 `COLLATE NOCASE` 只折 A-Z，替身照抄——这里不假设「大小写差不多」。
     */
    @Test
    fun `lorebook search and paging agree across both stores`() = runBlocking {
        eachStore { name, store ->
            val names = listOf("alpha", "Beta", "gamma-book", "delta", "epsilon", "zeta")
            names.forEachIndexed { index, label ->
                store.putLorebook(
                    LocalLorebookEntity(
                        id = "lb-p" + index,
                        name = label,
                        importedFrom = if (index % 2 == 0) "sillytavern" else null,
                        createdAt = 0,
                        updatedAt = 0,
                    ),
                )
            }
            // 名称序（NOCASE）：alpha, Beta, delta, epsilon, gamma-book, zeta
            assertEquals("$name/空查询词等于全部", names.size, store.countLorebooks(""))
            assertEquals(
                "$name/第一页必须按名称序给满页长",
                listOf("lb-p0", "lb-p1"),
                store.searchLorebooks("", 2, 0).map { it.id },
            )
            assertEquals(
                "$name/偏移要接得上",
                listOf("lb-p3", "lb-p4"),
                store.searchLorebooks("", 2, 2).map { it.id },
            )
            assertEquals(
                "$name/末页不足页长也不能越界",
                listOf("lb-p2", "lb-p5"),
                store.searchLorebooks("", 2, 4).map { it.id },
            )
            assertEquals("$name/名称命中数", 1, store.countLorebooks("book"))
            assertEquals(
                "$name/大小写不敏感要跨两端一致",
                listOf("lb-p2"),
                store.searchLorebooks("GAMMA", 10, 0).map { it.id },
            )
            assertEquals("$name/来源格式也参与匹配", 3, store.countLorebooks("sillytavern"))
            assertEquals(
                "$name/来源命中的顺序同样按名称",
                listOf("lb-p0", "lb-p4", "lb-p2"),
                store.searchLorebooks("sillytavern", 10, 0).map { it.id },
            )
            assertEquals("$name/查不到就是零", 0, store.countLorebooks("nothing-here"))
            assertTrue("$name/查不到时页也是空的", store.searchLorebooks("nothing-here", 10, 0).isEmpty())
        }
    }

    /**
     * §2 的同一句话落到预设列表上：1k 预设的关键字与分页都在数据库层执行。
     *
     * 大小写折叠也在这条里钉住：替身原来用 `lowercase()`（连非 ASCII 一起折），
     * 而 SQL 的 `COLLATE NOCASE` 只折 A-Z——这种差在单侧永远看不出来。
     */
    @Test
    fun `preset search and paging agree across both stores`() = runBlocking {
        eachStore { name, store ->
            val labels = listOf("alpha", "Beta", "gamma-pack", "delta", "epsilon", "zeta")
            labels.forEachIndexed { index, label ->
                store.putPreset(
                    LocalPresetEntity(
                        id = "pr-p" + index,
                        name = label,
                        description = if (index % 2 == 0) "sillytavern export" else "",
                        sortIndex = index,
                        isBuiltin = index == 0,
                        createdAt = 0,
                        updatedAt = 0,
                    ),
                )
            }
            assertEquals("$name/空查询词等于全部", labels.size - 1, store.countPresets(false, ""))
            assertEquals("$name/内建分区只含内建那一条", 1, store.countPresets(true, ""))
            assertEquals(
                "$name/第一页按 sortIndex 再名称",
                listOf("pr-p1", "pr-p2"),
                store.searchPresets(false, "", 2, 0).map { it.id },
            )
            assertEquals(
                "$name/偏移要接得上",
                listOf("pr-p3", "pr-p4"),
                store.searchPresets(false, "", 2, 2).map { it.id },
            )
            assertEquals(
                "$name/末页不足页长也不越界",
                listOf("pr-p5"),
                store.searchPresets(false, "", 2, 4).map { it.id },
            )
            assertEquals("$name/名称命中", 1, store.countPresets(false, "pack"))
            assertEquals(
                "$name/大小写不敏感两端一致",
                listOf("pr-p2"),
                store.searchPresets(false, "GAMMA", 10, 0).map { it.id },
            )
            assertEquals("$name/说明列也参与匹配", 2, store.countPresets(false, "sillytavern"))
            assertEquals("$name/内建分区不受用户查询影响", 1, store.countPresets(true, "sillytavern"))
            assertEquals("$name/查不到就是零", 0, store.countPresets(false, "nothing-here"))
        }
    }

    // ==================================================== §3「删除有引用资产的所有分支均有测试」
    //
    // 这条要求要的是**分支**，不是「删除能删掉」。漏测时最危险的漂移很具体：
    // 解绑少清一个引用列、或者解绑只写库不写 journal——两端一致地错，
    // 契约套件抓不到，最后由对端看到指向已删实体的引用才暴露。
    // 因此每个用例都跑 Room 与替身两遍（[eachStore]）。

    @Test
    fun `plain lorebook delete tombstones the book and deliberately leaves references`() = runBlocking {
        eachStore { name, store ->
            store.putLorebook(LocalLorebookEntity(id = "lb-plain", name = "被引用", createdAt = 0, updatedAt = 0))
            store.putCharacter(
                LocalCharacterEntity(id = "c-plain", name = "A", lorebookId = "lb-plain", createdAt = 0, updatedAt = 0),
            )
            assertEquals("$name/删除前应看到 1 个角色引用", 1, store.lorebookBindingImpact("lb-plain").characters)

            store.deleteLorebook("lb-plain")

            assertNull("$name/书应已删除", store.getLorebook("lb-plain"))
            assertTrue(
                "$name/头必须标 deleted，否则对端不会跟着删",
                store.getHead(EntityTypes.LOREBOOK, "lb-plain")?.deleted == true,
            )
            assertTrue(
                "$name/tombstone 列表应含该书",
                store.listTombstones().any { it.entityType == EntityTypes.LOREBOOK && it.entityId == "lb-plain" },
            )
            // 「引用仍在」是刻意钉住的现状：不带解绑的删除只是内部原语，
            // 面向用户的删除走 deleteLorebookUnbindingReferences。哪天有人把原语接到界面上，
            // 这条断言会先响，而不是悄悄留下指向已删世界书的角色。
            assertEquals("$name/原语不该顺手改角色行", "lb-plain", store.getCharacter("c-plain")?.lorebookId)
        }
    }

    @Test
    fun `lorebook unbinding delete clears every reference column and journals each row`() = runBlocking {
        eachStore { name, store ->
            store.putLorebook(LocalLorebookEntity(id = "lb-un", name = "解绑目标", createdAt = 0, updatedAt = 0))
            store.putLorebook(LocalLorebookEntity(id = "lb-keep", name = "另一个", createdAt = 0, updatedAt = 0))
            store.putCharacter(
                LocalCharacterEntity(
                    id = "c-un",
                    name = "A",
                    lorebookId = "lb-un",
                    boundLorebookIdsJson = """["lb-un","lb-keep"]""",
                    createdAt = 0,
                    updatedAt = 0,
                ),
            )
            store.putSession(
                LocalSessionEntity(
                    id = "s-un",
                    characterId = "c-un",
                    lorebookIdsJson = """["lb-un"]""",
                    createdAt = 0,
                    updatedAt = 0,
                ),
            )
            val characterBefore = store.getHead(EntityTypes.CHARACTER, "c-un")!!.versionJson
            val sessionBefore = store.getHead(EntityTypes.SESSION, "s-un")!!.versionJson

            val impact = store.deleteLorebookUnbindingReferences("lb-un")

            assertEquals("$name/影响范围要在删除前如实报出", 1, impact.characters)
            assertEquals("$name/影响范围要在删除前如实报出", 1, impact.sessions)
            val character = store.getCharacter("c-un")
            assertNull("$name/单绑定位应清掉", character?.lorebookId)
            assertFalse("$name/多绑列表应不再指向它", character!!.boundLorebookIdsJson.contains("lb-un"))
            assertTrue("$name/别的绑定必须留着", character.boundLorebookIdsJson.contains("lb-keep"))
            assertFalse(
                "$name/会话绑定也要清",
                store.getSession("s-un")!!.lorebookIdsJson.contains("lb-un"),
            )
            // 解绑本身是业务写：只写库不记账的话，对端同步完仍然指向已删世界书。
            assertTrue(
                "$name/角色行版本必须因果推进",
                CounterVectors.dominates(
                    VersionVectorJson.decode(characterBefore),
                    VersionVectorJson.decode(store.getHead(EntityTypes.CHARACTER, "c-un")!!.versionJson),
                ),
            )
            assertTrue(
                "$name/会话行版本必须因果推进",
                CounterVectors.dominates(
                    VersionVectorJson.decode(sessionBefore),
                    VersionVectorJson.decode(store.getHead(EntityTypes.SESSION, "s-un")!!.versionJson),
                ),
            )
            assertNull("$name/书应已删除", store.getLorebook("lb-un"))
            assertNotNull("$name/另一本不该被波及", store.getLorebook("lb-keep"))
        }
    }

    @Test
    fun `persona unbinding delete clears default and session persona`() = runBlocking {
        eachStore { name, store ->
            store.putPersona(LocalPersonaEntity(id = "pe-un", name = "被引用人设", createdAt = 0, updatedAt = 0))
            store.putCharacter(
                LocalCharacterEntity(id = "c-pe", name = "A", defaultPersonaId = "pe-un", createdAt = 0, updatedAt = 0),
            )
            store.putSession(
                LocalSessionEntity(id = "s-pe", characterId = "c-pe", personaId = "pe-un", createdAt = 0, updatedAt = 0),
            )
            assertEquals("$name/删除前应看到引用", 1, store.personaBindingImpact("pe-un").characters)
            assertEquals("$name/删除前应看到会话引用", 1, store.personaBindingImpact("pe-un").sessions)

            val impact = store.deletePersonaUnbindingReferences("pe-un")

            assertEquals("$name/返回的影响范围就是删除前看到的那份", 1, impact.characters)
            assertNull("$name/角色默认人设应清掉", store.getCharacter("c-pe")?.defaultPersonaId)
            assertNull("$name/会话人设应清掉", store.getSession("s-pe")?.personaId)
            assertNull("$name/人设应已删除", store.getPersona("pe-un"))
            assertTrue(
                "$name/tombstone 应含该人设",
                store.listTombstones().any { it.entityType == EntityTypes.PERSONA && it.entityId == "pe-un" },
            )
        }
    }

    @Test
    fun `plain persona and preset deletes tombstone only the target`() = runBlocking {
        eachStore { name, store ->
            store.putPersona(LocalPersonaEntity(id = "pe-a", name = "甲", createdAt = 0, updatedAt = 0))
            store.putPersona(LocalPersonaEntity(id = "pe-b", name = "乙", createdAt = 0, updatedAt = 0))
            store.deletePersona("pe-a")
            assertEquals("$name/只该少一条人设", listOf("pe-b"), store.listPersonas().map { it.id })

            store.putPreset(LocalPresetEntity(id = "pr-a", name = "甲", createdAt = 0, updatedAt = 0))
            store.putPreset(LocalPresetEntity(id = "pr-b", name = "乙", createdAt = 0, updatedAt = 0))
            store.deletePreset("pr-a")
            assertEquals("$name/只该少一条预设", listOf("pr-b"), store.listPresets().map { it.id })
            assertTrue(
                "$name/被删预设要有 tombstone",
                store.listTombstones().any { it.entityType == EntityTypes.PRESET && it.entityId == "pr-a" },
            )
            assertNull(
                "$name/留下的预设不该被误标删除",
                store.getHead(EntityTypes.PRESET, "pr-b")?.takeIf { it.deleted },
            )
        }
    }

    @Test
    fun `regex rule delete keeps the other rules order intact`() = runBlocking {
        eachStore { name, store ->
            store.putRegexRule(LocalRegexRuleEntity(id = "rx-1", name = "甲", pattern = "a", sortIndex = 0, createdAt = 0, updatedAt = 0))
            store.putRegexRule(LocalRegexRuleEntity(id = "rx-2", name = "乙", pattern = "b", sortIndex = 1, createdAt = 0, updatedAt = 0))
            store.putRegexRule(LocalRegexRuleEntity(id = "rx-3", name = "丙", pattern = "c", sortIndex = 2, createdAt = 0, updatedAt = 0))

            store.deleteRegexRule("rx-2")

            // 正则按 sortIndex 链式应用，删除中间一条不得重排其余两条：
            // 重排会改变「哪条先替换」的语义，而那是对端也要看到的结果。
            assertEquals("$name/剩余规则与顺序", listOf("rx-1" to 0, "rx-3" to 2), store.listRegexRules().map { it.id to it.sortIndex })
            assertTrue(
                "$name/被删规则要有 tombstone",
                store.listTombstones().any { it.entityType == EntityTypes.REGEX_RULE && it.entityId == "rx-2" },
            )
        }
    }

    /**
     * 快捷回复的记账粒度是整库单实体，所以这里的分支是：
     * 清空角色集合要留 `qr-char-<id>`，而**无集合可清时必须整段跳过**（连 journal 都不动）。
     * 后者不测就会退化成「删一个不用快捷回复的角色也凭空推进版本向量」。
     */
    @Test
    fun `clearing a character quick replies journals once and empty clear journals nothing`() = runBlocking {
        eachStore { name, store ->
            store.putQuickReplySet(
                LocalQuickReplySetEntity(
                    id = "qr-global",
                    name = "全局",
                    itemsJson = """[{"id":"q1","label":"l","content":"c","action":"text","order":0}]""",
                    sortIndex = 0,
                    createdAt = 0,
                    updatedAt = 0,
                ),
            )
            store.putQuickReplySet(
                LocalQuickReplySetEntity(
                    id = "qr-char",
                    name = "角色集合",
                    itemsJson = """[{"id":"q2","label":"l2","content":"c2","action":"text","order":1}]""",
                    sortIndex = 1,
                    characterId = "c-qr",
                    createdAt = 0,
                    updatedAt = 0,
                ),
            )

            val beforeCount = store.journalChangeCount()
            val beforeSeq = store.maxChangeSeq()
            store.deleteCharacterQuickReplies("c-qr")

            // 两条，不是一条：整库实体（quick-replies-root）的 payload 变了是一行，
            // 「这个角色的集合被删了」的 tombstone 是另一行——少了后者，长期离线的设备会把它带回来。
            assertEquals("$name/清空要产生变更", beforeCount + 2, store.journalChangeCount())
            assertEquals(
                "$name/清空角色集合只该动这两个实体",
                listOf(
                    EntityTypes.QUICK_REPLY_SET + "/" + CanonicalEntityIds.QUICK_REPLY_ROOT,
                    EntityTypes.QUICK_REPLY_SET + "/qr-char-c-qr",
                ).sorted(),
                store.changesAfter(beforeSeq, 20).map { it.entityType + "/" + it.entityId }.sorted(),
            )
            assertEquals("$name/全局集合必须留下", listOf("qr-global"), store.listQuickReplySets().map { it.id })
            assertTrue(
                "$name/角色级 tombstone 要存在",
                store.listTombstones().any { it.entityType == EntityTypes.QUICK_REPLY_SET && it.entityId == "qr-char-c-qr" },
            )

            val afterClear = store.journalChangeCount()
            store.deleteCharacterQuickReplies("c-never-used")
            assertEquals("$name/没有集合可清时不该产生任何变更", afterClear, store.journalChangeCount())
        }
    }

    /** 角色还有别的集合时不该留角色级 tombstone——那会让对端把还活着的集合当已删处理。 */
    @Test
    fun `deleting one of two character sets does not tombstone the character`() = runBlocking {
        eachStore { name, store ->
            store.putQuickReplySet(
                LocalQuickReplySetEntity(
                    id = "qr-a",
                    name = "甲",
                    itemsJson = """[{"id":"qa","label":"a","content":"a","action":"text","order":0}]""",
                    sortIndex = 0,
                    characterId = "c-two",
                    createdAt = 0,
                    updatedAt = 0,
                ),
            )
            store.putQuickReplySet(
                LocalQuickReplySetEntity(
                    id = "qr-b",
                    name = "乙",
                    itemsJson = """[{"id":"qb","label":"b","content":"b","action":"text","order":1}]""",
                    sortIndex = 1,
                    characterId = "c-two",
                    createdAt = 0,
                    updatedAt = 0,
                ),
            )

            store.deleteQuickReplySet("qr-a")

            assertEquals("$name/另一个集合还在", listOf("qr-b"), store.listQuickReplySets().map { it.id })
            assertFalse(
                "$name/还有集合就不该有角色级 tombstone",
                store.listTombstones().any { it.entityId == "qr-char-c-two" },
            )
        }
    }
}
