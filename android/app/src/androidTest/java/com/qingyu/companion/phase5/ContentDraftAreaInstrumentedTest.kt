package com.qingyu.companion.phase5

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.room.Room
import com.qingyu.companion.data.ContentDraftStore
import com.qingyu.companion.data.PreferencesContentDraftStore
import com.qingyu.companion.local.db.QingyuLocalDatabase
import com.qingyu.companion.local.domain.CanonicalEntityIds
import com.qingyu.companion.local.domain.EntityTypes
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.local.domain.RoomLocalSyncRepository
import com.qingyu.companion.ui.characters.CharacterEditorViewModel
import com.qingyu.companion.ui.content.ContentDraftCodec
import com.qingyu.companion.ui.lorebooks.LorebookEditorViewModel
import com.qingyu.companion.ui.personas.PersonaEditorViewModel
import com.qingyu.companion.ui.presets.PresetEditorViewModel
import com.qingyu.companion.ui.quickreplies.QuickReplyEditorViewModel
import com.qingyu.companion.ui.regex.RegexEditorViewModel
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 阶段 5 §2 的草稿区：**六个编辑器逐个验证**「键入只写草稿区，保存或离开确认才产生一次业务变更」。
 *
 * 这条要求是三件事，缺一件都不算做到，所以每条用例按同一顺序验完：
 * 1. 未保存的编辑**只在草稿区**：草稿里能解码出那一行，库里查不到，`change_log` 与
 *    `entity_heads` 一行不多（否则每次键入都是一条同步变更，对端会看到同一实体的成百上千个版本）；
 * 2. 换一个新 ViewModel 实例（等价于进程被系统回收后再进来）能从**同一个草稿区**接上，
 *    并且界面知道自己是恢复出来的（`draftRestored`）；
 * 3. 点保存恰好落一条 journal、版本向量推到 1，并且**草稿被清掉**——
 *    留着会让下次进来又恢复出一份已经保存过的内容。
 *
 * 用 `runBlocking(Dispatchers.Main)` 而不是 Compose 走查：`viewModelScope` 就在这个 dispatcher 上，
 * 而这里要验的是数据行为不是渲染（Compose 测试宿主会饿死 viewModelScope 这件事已经记在
 * `ContentUiWalkthroughInstrumentedTest` 的注释里，别再往那上面搭结论）。
 *
 * 草稿分区的键名直接取 [EntityTypes]：草稿区与同步层用同一套实体名是刻意的，
 * 改名会在这里变红，而不是留下一堆再也读不到的旧草稿。
 */
@RunWith(AndroidJUnit4::class)
class ContentDraftAreaInstrumentedTest {

    private lateinit var db: QingyuLocalDatabase
    private lateinit var store: LocalStore
    private lateinit var drafts: ContentDraftStore
    private lateinit var mediaRoot: File

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        db = Room.inMemoryDatabaseBuilder(context, QingyuLocalDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        store = RoomLocalSyncRepository(db, "draft-area-device")
        drafts = PreferencesContentDraftStore(context)
        mediaRoot = File(context.cacheDir, "draft-media").apply { mkdirs() }
    }

    @After
    fun cleanDraftSlots() = runBlocking(Dispatchers.Main) {
        // 六个编辑器的「新建」共用 "new" 这把键，DataStore 又是按进程活的单例：
        // 不清就会有用例被上一条的残留草稿改变行为
        listOf(
            EntityTypes.CHARACTER, EntityTypes.LOREBOOK, EntityTypes.PRESET,
            EntityTypes.PERSONA, EntityTypes.REGEX_RULE, EntityTypes.QUICK_REPLY_SET,
        ).forEach { drafts.clear(it, NEW_KEY) }
        db.close()
    }

    // ---------------------------------------------------------------- 六个编辑器

    @Test
    fun characterDraftStaysOutOfTheJournalUntilSave() = runBlocking(Dispatchers.Main) {
        val marker = "草稿角色名"
        val vm = CharacterEditorViewModel(store, mediaRoot, drafts)
        vm.startCreate()
        vm.edit { it.copy(name = marker, firstMessage = "写到一半的问候语") }

        assertDraftOnly("角色", EntityTypes.CHARACTER, ContentDraftCodec::decodeCharacter) { row ->
            row.name == marker && row.firstMessage == "写到一半的问候语"
        }
        assertTrue("未保存的角色不能出现在库里", store.listCharacters().isEmpty())

        val vm2 = CharacterEditorViewModel(store, mediaRoot, drafts)
        vm2.startCreate()
        waitUntilTrue("新实例没有恢复到草稿") { vm2.editor.value.draftRestored }
        assertEquals(marker, vm2.editor.value.draft?.draft?.name)
        assertEquals("写到一半的问候语", vm2.editor.value.draft?.draft?.firstMessage)
        assertEquals("恢复阶段不该记账", 0, store.journalChangeCount())

        vm2.save()
        val id = waitUntilValue("保存后库里没有这一行") { store.listCharacters().firstOrNull()?.id }
        assertOneJournaledChange(EntityTypes.CHARACTER, id)
    }

    @Test
    fun lorebookDraftKeepsUnsavedEntries() = runBlocking(Dispatchers.Main) {
        val marker = "草稿世界书"
        val vm = LorebookEditorViewModel(store, drafts)
        vm.startCreate()
        vm.editDocument { it.copy(name = marker) }
        vm.addEntry()

        assertDraftOnly("世界书", EntityTypes.LOREBOOK, ContentDraftCodec::decodeLorebook) { row ->
            // 条目数组是整本文档的正文，草稿行里必须已经带着它（addEntry 之后）
            row.name == marker && row.canonicalJson.contains("\"entries\"")
        }
        assertTrue("未保存的世界书不能出现在库里", store.listLorebooks().isEmpty())

        val vm2 = LorebookEditorViewModel(store, drafts)
        vm2.startCreate()
        waitUntilTrue("新实例没有恢复出草稿") { vm2.editor.value.draftRestored }
        assertEquals(marker, vm2.editor.value.document?.name)
        assertEquals("条目必须跟着草稿回来", 1, vm2.editor.value.document?.entries?.size)

        vm2.save()
        val id = waitUntilValue("保存后库里没有这一本") { store.listLorebooks().firstOrNull()?.id }
        assertOneJournaledChange(EntityTypes.LOREBOOK, id)
    }

    @Test
    fun presetDraftKeepsUnsavedBodyEdits() = runBlocking(Dispatchers.Main) {
        val marker = "草稿预设"
        val vm = PresetEditorViewModel(store, drafts)
        vm.startCreate()
        vm.edit { it.copy(name = marker) }
        vm.editNumber("temperature", 0.42)

        assertDraftOnly("预设", EntityTypes.PRESET, ContentDraftCodec::decodePreset) { row ->
            row.name == marker && row.bodyJson.contains("0.42")
        }
        assertTrue("未保存的预设不能出现在库里", store.listPresets().isEmpty())

        val vm2 = PresetEditorViewModel(store, drafts)
        vm2.startCreate()
        waitUntilTrue("新实例没有恢复出草稿") { vm2.editor.value.draftRestored }
        assertEquals(marker, vm2.editor.value.draft?.draft?.name)
        assertTrue(
            "bodyJson 里的改动也必须恢复出来",
            vm2.editor.value.draft?.draft?.bodyJson?.contains("0.42") == true,
        )

        vm2.save()
        val id = waitUntilValue("保存后库里没有这一条") { store.listPresets().firstOrNull()?.id }
        assertOneJournaledChange(EntityTypes.PRESET, id)
    }

    @Test
    fun personaDraftKeepsUnsavedText() = runBlocking(Dispatchers.Main) {
        val marker = "草稿人设"
        val vm = PersonaEditorViewModel(store, mediaRoot, drafts)
        vm.startCreate()
        vm.edit { it.copy(name = marker, persona = "写到一半的人设描述") }

        assertDraftOnly("人设", EntityTypes.PERSONA, ContentDraftCodec::decodePersona) { row ->
            row.name == marker && row.persona == "写到一半的人设描述"
        }
        assertTrue("未保存的人设不能出现在库里", store.listPersonas().isEmpty())

        val vm2 = PersonaEditorViewModel(store, mediaRoot, drafts)
        vm2.startCreate()
        waitUntilTrue("新实例没有恢复出草稿") { vm2.editor.value.draftRestored }
        assertEquals("写到一半的人设描述", vm2.editor.value.draft?.draft?.persona)

        vm2.save()
        val id = waitUntilValue("保存后库里没有这一条") { store.listPersonas().firstOrNull()?.id }
        assertOneJournaledChange(EntityTypes.PERSONA, id)
    }

    /**
     * 正则的重点是「半成品模式也丢不了」：一条没写完的 `(a+` 连编译都过不了，
     * 但它同样是用户的劳动，必须能存进草稿区、回来接着改。
     */
    @Test
    fun regexDraftKeepsAnUncompilablePattern() = runBlocking(Dispatchers.Main) {
        val marker = "草稿规则"
        val vm = RegexEditorViewModel(store, drafts)
        vm.startCreate()
        vm.edit { it.copy(name = marker, pattern = "(a+", replacement = "$1") }

        assertDraftOnly("正则", EntityTypes.REGEX_RULE, ContentDraftCodec::decodeRegexRule) { row ->
            row.name == marker && row.pattern == "(a+" && row.replacement == "$1"
        }
        assertTrue("未保存的规则不能出现在库里", store.listRegexRules().isEmpty())

        val vm2 = RegexEditorViewModel(store, drafts)
        vm2.startCreate()
        waitUntilTrue("新实例没有恢复出草稿") { vm2.editor.value.draftRestored }
        assertEquals("(a+", vm2.editor.value.draft?.draft?.pattern)

        vm2.save()
        val id = waitUntilValue("保存后库里没有这一条") { store.listRegexRules().firstOrNull()?.id }
        assertOneJournaledChange(EntityTypes.REGEX_RULE, id)
    }

    /**
     * 快捷回复是六个编辑器里唯一「一次编辑动两份数据」的：集合行 + 条目数组。
     * 草稿必须把条目一起带走，否则恢复出来是个空集合，比不恢复更糟。
     */
    @Test
    fun quickReplyDraftKeepsItemsNotJustTheSetRow() = runBlocking(Dispatchers.Main) {
        val marker = "草稿集合"
        val vm = QuickReplyEditorViewModel(store, drafts)
        vm.startCreateSet(null)
        vm.editRow { it.copy(name = marker) }
        vm.addItem()
        val itemId = waitUntilValue("添加条目后草稿里应有一条") {
            vm.set.value.draft?.draft?.items?.firstOrNull()?.id
        }
        vm.updateItem(itemId) { it.copy(label = "未保存的快捷键条目") }

        assertDraftOnly("集合", EntityTypes.QUICK_REPLY_SET, ContentDraftCodec::decodeQuickReplySet) { row ->
            row.name == marker && row.itemsJson.contains("未保存的快捷键条目")
        }
        assertTrue("未保存的集合不能出现在库里", store.listQuickReplySets().isEmpty())

        val vm2 = QuickReplyEditorViewModel(store, drafts)
        vm2.startCreateSet(null)
        waitUntilTrue("新实例没有恢复出草稿") { vm2.set.value.draftRestored }
        val restored = vm2.set.value.draft?.draft
        assertEquals(marker, restored?.row?.name)
        assertEquals("条目必须一起回来", 1, restored?.items?.size)
        assertEquals("未保存的快捷键条目", restored?.items?.firstOrNull()?.label)

        vm2.saveSet()
        waitUntilValue("保存后库里没有这一条") { store.listQuickReplySets().firstOrNull()?.id }
        // 快捷回复的记账粒度是**整库单实体**（与 PC 的 `QUICK_REPLY_ROOT_ID` 对齐），
        // 不是每行一个 id：head 要找 quick-replies-root，按集合行的 id 查永远是 null。
        assertOneJournaledChange(EntityTypes.QUICK_REPLY_SET, CanonicalEntityIds.QUICK_REPLY_ROOT)
    }

    // ---------------------------------------------------------------- 放弃草稿

    /**
     * 离开确认里选「放弃」：草稿必须**清掉**，但同样不能记账。
     *
     * 只 `clearEditor()` 不清草稿区会留下这样一条路径：用户明确说了不要这份内容，
     * 下次点「新建」却恢复出被放弃的那份——比丢草稿更难发现。
     */
    @Test
    fun discardingDraftClearsTheSlotAndStillProducesNoChange() = runBlocking(Dispatchers.Main) {
        val vm = CharacterEditorViewModel(store, mediaRoot, drafts)
        vm.startCreate()
        vm.edit { it.copy(name = "准备放弃的角色") }
        waitUntilValue("草稿没落盘") { drafts.get(EntityTypes.CHARACTER, NEW_KEY) }

        vm.discardDraftAndClose()
        waitUntilTrue("放弃之后草稿区还有内容") { drafts.get(EntityTypes.CHARACTER, NEW_KEY) == null }
        assertEquals("放弃草稿不该产生 journal", 0, store.journalChangeCount())
        assertEquals("放弃草稿不该产生 entity_heads", 0, store.headCount())

        // 再进来必须是干净的编辑器，而不是被放弃的那份
        val vm2 = CharacterEditorViewModel(store, mediaRoot, drafts)
        vm2.startCreate()
        delay(AUTOSAVE_SETTLE_MS)
        assertTrue(
            "已放弃的草稿被重新恢复了",
            vm2.editor.value.draftRestored.not() && vm2.editor.value.draft?.draft?.name.isNullOrEmpty(),
        )
    }

    // ---------------------------------------------------------------- 共用断言

    /**
     * 「这次编辑只进了草稿区」：草稿能解码成行、行列上就是刚编辑的值，
     * 且 journal / heads 一行不多。
     *
     * 顺带用真实编辑器的输出验 codec：只断言「DataStore 里有一串字符串」的话，
     * 草稿写坏了也能过，恢复那一步就会在用户身上才暴露。
     */
    private suspend fun <T : Any> assertDraftOnly(
        label: String,
        kind: String,
        decode: (String) -> T?,
        matches: (T) -> Boolean,
    ) {
        val json = waitUntilValue("$label 的编辑没有落进草稿区") { drafts.get(kind, NEW_KEY) }
        assertTrue("$label 的草稿必须是 JSON 行快照", json.startsWith("{"))
        val row = decode(json)
        assertNotNull("$label 的草稿解码不出来（codec 与编辑器写入不对齐）", row)
        assertTrue("$label 的草稿内容与本次编辑不一致", matches(requireNotNull(row)))
        assertEquals("$label 的键入不该产生 journal 变更", 0, store.journalChangeCount())
        assertEquals("$label 的键入不该推进版本向量", 0, store.headCount())
    }

    /** 保存 = 一次业务变更：journal 一条、head 版本向量到 1，并且草稿槽被清掉。 */
    private suspend fun assertOneJournaledChange(kind: String, entityId: String) {
        assertEquals("一次保存必须恰好一条变更", 1, store.journalChangeCount())
        assertEquals("一次保存恰好推进一个实体", 1, store.headCount())
        val head = store.getHead(kind, entityId)
        assertNotNull("保存没有留下 entity_heads（$kind/$entityId）", head)
        assertEquals(
            "首次保存应把版本向量推到 1",
            "1",
            JSONObject(requireNotNull(head).versionJson).optString(store.deviceId()),
        )
        // 清槽在写库**之后**才发生（先落成功再丢草稿，顺序不能反），所以要等它。
        // 这里等的是同一台机器上真实存在的异步窗口，不是放宽断言：条件本身一个字没改。
        waitUntilTrue("保存后草稿区没有清空，下次进来会恢复出一份已保存的内容") {
            drafts.get(kind, NEW_KEY) == null
        }
    }

    /**
     * 轮询等到 [probe] 给出非 null。测试线程就是主线程，`delay` 会让 `viewModelScope`
     * 的协程推进，所以等得到真实的自动保存落盘（防抖 300 ms + DataStore 提交）。
     */
    private suspend fun <T> waitUntilValue(message: String, probe: suspend () -> T?): T {
        var attempts = 0
        while (attempts++ < WAIT_TICKS) {
            probe()?.let { return it }
            delay(100L)
        }
        throw AssertionError("$message：等待 ${WAIT_TICKS * 100} ms 后仍没有值")
    }

    private suspend fun waitUntilTrue(message: String, probe: suspend () -> Boolean) {
        var attempts = 0
        while (attempts++ < WAIT_TICKS) {
            if (probe()) return
            delay(100L)
        }
        throw AssertionError("$message：等待 ${WAIT_TICKS * 100} ms 后仍不成立")
    }

    private companion object {
        const val NEW_KEY = "new"
        const val WAIT_TICKS = 80
        const val AUTOSAVE_SETTLE_MS = 700L
    }
}
