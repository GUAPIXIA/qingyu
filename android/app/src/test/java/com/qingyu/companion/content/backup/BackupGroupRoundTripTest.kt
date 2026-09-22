package com.qingyu.companion.content.backup

import com.qingyu.companion.local.db.LocalGroupEntity
import com.qingyu.companion.local.db.LocalGroupMessageEntity
import com.qingyu.companion.local.db.LocalMessageEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.testing.FakeLocalStore
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * U-6-8：Backup V3 覆盖群数据的 `create → inspect → restore` 往返。
 *
 * 盯四件事：
 * 1. 群行**全字段**往返——9 个调度列逐一断言（chatMode=free、defaultNarrativeMode=omniscient、
 *    lorebookIdsJson 数组形状都在里面）；
 * 2. 群消息全字段往返——identity 三键 + round/seq/logicalTime + imagesJson；
 * 3. 群会话（groupId 非空）与普通会话**互不串**：两张消息表各归各；
 * 4. 合并语义（同 gid 覆盖、备份没有的本地群保留）与「落位不依赖 ZIP 条目顺序」。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class BackupGroupRoundTripTest {

    private fun mediaRoot(label: String): File =
        File(System.getProperty("java.io.tmpdir"), "qingyu-backup-group-$label-${System.nanoTime()}")
            .apply { mkdirs() }

    /** 群行：9 个调度列全部取**非默认值**，任何一个列没进包都会在这里变红。 */
    private fun groupRow() = LocalGroupEntity(
        id = "g1",
        name = "远征队",
        mode = "round_robin",
        characterIdsJson = """["c1","c2"]""",
        memoryEnabled = true,
        avatarPath = "avatar/aa.png",
        importedFrom = "card",
        createdAt = 100,
        updatedAt = 200,
        chatMode = "free",
        autoMode = true,
        maxRounds = 5,
        speakerInterval = 1700,
        currentSpeakerIndex = 1,
        presetId = "p9",
        systemPrompt = "群系统提示",
        lorebookIdsJson = """["lb1","lb2"]""",
        defaultNarrativeMode = "omniscient",
    )

    private fun groupSession() = LocalSessionEntity(
        id = "gs1",
        groupId = "g1",
        title = "群会话",
        personaId = "pe-1",
        presetId = "sp-1",
        lorebookIdsJson = """["lb1"]""",
        narrativeMode = "omniscient",
        createdAt = 1,
        updatedAt = 2,
    )

    /** 群消息：identity 三键、round/seq/logicalTime、imagesJson 与其余可选列全给上。 */
    private fun groupMessage(id: String, seq: Long) = LocalGroupMessageEntity(
        id = id,
        sessionId = "gs1",
        groupId = "g1",
        characterId = "c1",
        content = "正文-$id",
        imagesJson = """["a/1.png"]""",
        round = 2,
        translation = "译-$id",
        replyToId = "req-1",
        status = "sent",
        mentionedIdsJson = """["c2"]""",
        narrativeMode = "immersive",
        speakerKind = "character",
        generationKind = "manual",
        dialogueDirectionsJson = """["方向"]""",
        dialogueDirectionsGeneratedAt = 33,
        generationNotice = "提示-$id",
        generationError = null,
        contentRenderMode = "markdown",
        logicalTime = 1000 + seq,
        seq = seq,
        importedFrom = null,
        createdAt = 10,
        updatedAt = 20,
    )

    @Test
    fun `群行与群消息全字段往返：九个调度列与 identity 三键一个都不能丢`(): Unit = runBlocking {
        val source = FakeLocalStore("pc-device")
        source.putGroup(groupRow())
        source.putSession(groupSession())
        source.appendGroupMessage(groupMessage("m1", 1))
        source.appendGroupMessage(groupMessage("m2", 2))

        val bundle = BackupOrchestrator(source, mediaRoot("src"), "0.3.0").create()

        // manifest counts 必须含群计数：预览页按它报「这个包里有什么」
        assertEquals(1, bundle.manifest.counts["groups"], "manifest counts 缺群行计数")
        assertEquals(1, bundle.manifest.counts["groupSessions"], "manifest counts 缺群会话计数")
        assertEquals(2, bundle.manifest.counts["groupMessages"], "manifest counts 缺群消息计数")

        val target = FakeLocalStore("android-device")
        val outcome = BackupOrchestrator(target, mediaRoot("dst"), "0.3.0").restore(bundle.bytes)
        assertTrue(outcome.ok, "恢复应当成功：${outcome.error}")
        assertEquals(1, outcome.applied["groups"], "群行必须被恢复")
        assertEquals(1, outcome.applied["groupSessions"], "群会话必须被计入 groupSessions（键总在，值要真）")
        assertEquals(2, outcome.applied["groupMessages"], "群消息必须被恢复")
        assertEquals(1, outcome.applied["sessions"], "sessions 仍计全部会话行（含群会话，口径不变）")

        // ---- 群行：9 个调度列逐一断言 + 其余列保真
        val g = target.getGroup("g1")
        assertNotNull(g, "群行丢失")
        assertEquals("远征队", g!!.name, "群名必须往返")
        assertEquals("free", g.chatMode, "调度列 chatMode 必须往返（free 是三种发言调度之一）")
        assertEquals(true, g.autoMode, "调度列 autoMode 必须往返")
        assertEquals(5, g.maxRounds, "调度列 maxRounds 必须往返")
        assertEquals(1700, g.speakerInterval, "调度列 speakerInterval 必须往返")
        assertEquals(1, g.currentSpeakerIndex, "调度列 currentSpeakerIndex 必须往返")
        assertEquals("p9", g.presetId, "调度列 presetId 必须往返")
        assertEquals("群系统提示", g.systemPrompt, "调度列 systemPrompt 必须往返")
        assertEquals("""["lb1","lb2"]""", g.lorebookIdsJson, "调度列 lorebookIdsJson 必须按数组形状原样往返")
        assertEquals("omniscient", g.defaultNarrativeMode, "调度列 defaultNarrativeMode 必须往返（omniscient 全局叙事）")
        assertEquals("""["c1","c2"]""", g.characterIdsJson, "成员序必须往返（排序是发言计划输入）")
        assertEquals("round_robin", g.mode, "旧调度列 mode 也要保真")
        assertEquals(true, g.memoryEnabled, "memoryEnabled 必须往返")
        assertEquals("avatar/aa.png", g.avatarPath, "群头像引用必须往返")
        assertEquals("card", g.importedFrom, "导入来源必须随包保真（丢了兼容性提示就没了）")
        assertEquals(100L, g.createdAt, "createdAt 必须往返")

        // ---- 群会话行（groupId 非空）
        val gs = target.getSession("gs1")
        assertNotNull(gs, "群会话丢失")
        assertEquals("g1", gs!!.groupId, "群会话归属必须往返（groupId 决定恢复时进哪张消息表）")
        assertEquals("群会话", gs.title, "群会话标题必须往返")
        assertEquals("pe-1", gs.personaId, "群会话人设必须往返")
        assertEquals("sp-1", gs.presetId, "群会话预设必须往返")
        assertEquals("""["lb1"]""", gs.lorebookIdsJson, "群会话世界书必须往返")
        assertEquals("omniscient", gs.narrativeMode, "群会话叙事模式必须往返")

        // ---- 群消息：identity 三键 + round/seq/logicalTime + imagesJson
        val messages = target.listGroupMessages("gs1").sortedBy { it.seq }
        assertEquals(2, messages.size, "两条群消息都要回来")
        assertEquals(listOf("m1", "m2"), messages.map { it.id }, "消息 id 与顺序必须保持")
        val m1 = messages.first { it.id == "m1" }
        assertEquals("immersive", m1.narrativeMode, "identity 三键 narrativeMode 必须往返")
        assertEquals("character", m1.speakerKind, "identity 三键 speakerKind 必须往返")
        assertEquals("manual", m1.generationKind, "identity 三键 generationKind 必须往返")
        assertEquals(2, m1.round, "round 必须往返（共用轮号语义的存档依据）")
        assertEquals(1L, m1.seq, "seq 必须往返（它是 (sessionId, seq) 唯一索引的一半，丢了会撞唯一索引）")
        assertEquals(1001L, m1.logicalTime, "logicalTime 必须往返（排序键）")
        assertEquals("""["a/1.png"]""", m1.imagesJson, "imagesJson 必须按数组形状原样往返")
        assertEquals("正文-m1", m1.content, "正文必须往返")
        assertEquals("译-m1", m1.translation, "译文必须往返")
        assertEquals("提示-m1", m1.generationNotice, "生成提示必须往返")
        assertEquals("markdown", m1.contentRenderMode, "渲染模式必须往返")
        assertEquals("""["c2"]""", m1.mentionedIdsJson, "提及列表必须往返")
        assertEquals("sent", m1.status, "发送状态必须往返")
        assertEquals("req-1", m1.replyToId, "回复指向必须往返")
        assertEquals("""["方向"]""", m1.dialogueDirectionsJson, "下一步方向必须往返")
        assertEquals(33L, m1.dialogueDirectionsGeneratedAt, "方向生成时间必须往返")
        assertNull(m1.generationError, "未设置的可选列必须保持未设置，不能被恢复塞默认值")
        assertEquals(null, m1.importedFrom, "导入来源 null 也必须原样往返（存档不改写来源标记）")
    }

    @Test
    fun `群会话与普通会话互不串：两张消息表各归各`(): Unit = runBlocking {
        val source = FakeLocalStore("pc-device")
        source.putGroup(groupRow())
        source.putSession(groupSession())
        source.appendGroupMessage(groupMessage("m1", 1))
        source.appendGroupMessage(groupMessage("m2", 2))
        // 一条普通会话 + 两条单聊消息（与群会话同包共存）
        source.putSession(
            LocalSessionEntity(id = "s1", characterId = "c1", title = "单聊", createdAt = 1, updatedAt = 2),
        )
        source.appendMessage(
            LocalMessageEntity(id = "p1", sessionId = "s1", characterId = "c1", role = "user", content = "在吗",
                logicalTime = 5, seq = 0, createdAt = 1, updatedAt = 2),
        )
        source.appendMessage(
            LocalMessageEntity(id = "p2", sessionId = "s1", characterId = "c1", role = "assistant", content = "在",
                logicalTime = 6, seq = 1, createdAt = 1, updatedAt = 2),
        )

        val bundle = BackupOrchestrator(source, mediaRoot("src-mix"), "0.3.0").create()
        val target = FakeLocalStore("android-device")
        val outcome = BackupOrchestrator(target, mediaRoot("dst-mix"), "0.3.0").restore(bundle.bytes)
        assertTrue(outcome.ok, "恢复应当成功：${outcome.error}")

        assertEquals("g1", target.getSession("gs1")!!.groupId, "群会话归属必须保持")
        assertNull(target.getSession("s1")!!.groupId, "普通会话不能被恢复成群会话")
        assertEquals(listOf("p1", "p2"), target.listMessages("s1").map { it.id }, "单聊消息必须回到单聊表")
        assertEquals(listOf("m1", "m2"), target.listGroupMessages("gs1").sortedBy { it.seq }.map { it.id }, "群消息必须回到群消息表")
        assertTrue(
            target.listMessages("gs1").isEmpty(),
            "群会话绝不能长出单聊消息行（串表会把群消息渲染进单聊记录）",
        )
        assertTrue(
            target.listGroupMessages("s1").isEmpty(),
            "普通会话绝不能长出群消息行（串表会让单聊消息带群调度字段）",
        )
        assertEquals(2, outcome.applied["sessions"], "两种会话都计入 sessions")
        assertEquals(1, outcome.applied["groupSessions"], "只有 groupId 非空的会计入 groupSessions")
        assertEquals(2, outcome.applied["groupMessages"], "groupMessages 只计群消息")
    }

    @Test
    fun `恢复是合并语义：同 id 覆盖、备份没有的本地群保留`(): Unit = runBlocking {
        val source = FakeLocalStore("pc-device")
        source.putGroup(groupRow())
        source.putSession(groupSession())
        val bundle = BackupOrchestrator(source, mediaRoot("src2"), "0.3.0").create()

        val target = FakeLocalStore("android-device")
        target.putGroup(groupRow().copy(name = "旧名", chatMode = "polling"))
        target.putGroup(
            LocalGroupEntity(id = "g-local", name = "本地群", mode = "sequential", characterIdsJson = "[]", createdAt = 0, updatedAt = 0),
        )
        val outcome = BackupOrchestrator(target, mediaRoot("dst2"), "0.3.0").restore(bundle.bytes)
        assertTrue(outcome.ok, "恢复应当成功：${outcome.error}")

        assertEquals("远征队", target.getGroup("g1")!!.name, "同 id 群必须被备份覆盖")
        assertEquals("free", target.getGroup("g1")!!.chatMode, "调度列随覆盖一并更新")
        assertNotNull(target.getGroup("g-local"), "备份没有的本地群必须保留（合并不整替）")
        assertEquals(1, outcome.applied["groups"], "counts 只数备份里恢复的群行")
    }

    @Test
    fun `恢复落位与 ZIP 条目顺序无关：逆序包也按依赖顺序落库`(): Unit = runBlocking {
        val source = FakeLocalStore("pc-device")
        source.putGroup(groupRow())
        source.putSession(groupSession())
        source.appendGroupMessage(groupMessage("m1", 1))
        val bundle = BackupOrchestrator(source, mediaRoot("src4"), "0.3.0").create()

        // 把条目顺序整个倒过来：打包方顺序不受我们控制，三遍式的原则就是不信它。
        // 消息若单独成条目（而不是内嵌在会话条目里），逆序就会在会话之前落位、撞「父会话不存在」。
        val collected = ArrayList<BackupV3.Entry>()
        BackupV3.streamEntries(bundle.bytes) { path, payload ->
            collected += BackupV3.Entry(path, payload)
        }
        assertTrue(collected.size >= 3, "这条用例的前提是包里有多个条目，实际 ${collected.size}")
        val reversed = BackupV3.build(collected.reversed(), bundle.manifest)

        val target = FakeLocalStore("android-device")
        val outcome = BackupOrchestrator(target, mediaRoot("dst4"), "0.3.0").restore(reversed)
        assertTrue(outcome.ok, "条目顺序不该影响恢复结果：${outcome.error}")
        assertNotNull(target.getGroup("g1"), "群行必须落库（第二遍，父实体）")
        assertNotNull(target.getSession("gs1"), "群会话必须落库（第三遍）")
        assertEquals(
            listOf("m1"),
            target.listGroupMessages("gs1").map { it.id },
            "群消息必须在会话之后落库——顺序由遍数保证，不靠 ZIP 内排列",
        )
    }
}
