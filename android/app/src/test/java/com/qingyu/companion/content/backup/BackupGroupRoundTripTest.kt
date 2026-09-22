package com.qingyu.companion.content.backup

import com.qingyu.companion.local.db.LocalGroupEntity
import com.qingyu.companion.local.db.LocalGroupMessageEntity
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
 * U-6-8：Backup V3 覆盖群数据——群行（**9 个调度列逐一断言**）与群消息（identity 三键/轮次/
 * logicalTime/图片）全字段往返，以及「合并不整替」语义。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class BackupGroupRoundTripTest {

    private fun mediaRoot(label: String): File =
        File(System.getProperty("java.io.tmpdir"), "qingyu-backup-group-$label-${System.nanoTime()}")
            .apply { mkdirs() }

    private fun groupRow() = LocalGroupEntity(
        id = "g1", name = "远征队", mode = "group",
        characterIdsJson = """["c1","c2"]""", memoryEnabled = true,
        avatarPath = "avatar/aa.png", importedFrom = "card",
        createdAt = 100, updatedAt = 200,
        chatMode = "free", autoMode = true, maxRounds = 5, speakerInterval = 1700,
        currentSpeakerIndex = 1, presetId = "p9", systemPrompt = "群系统提示",
        lorebookIdsJson = """["lb1","lb2"]""", defaultNarrativeMode = "omniscient",
    )

    private fun groupSession() = LocalSessionEntity(
        id = "gs1", groupId = "g1", title = "群会话", createdAt = 1, updatedAt = 2,
    )

    private fun groupMessage(id: String, seq: Long) = LocalGroupMessageEntity(
        id = id, sessionId = "gs1", groupId = "g1", characterId = "c1",
        content = "正文-$id", imagesJson = """["a/1.png"]""", round = 2,
        translation = "译-$id", replyToId = "req-1", status = "sent",
        mentionedIdsJson = """["c2"]""", narrativeMode = "immersive",
        speakerKind = "character", generationKind = "manual",
        dialogueDirectionsJson = """["方向"]""", dialogueDirectionsGeneratedAt = 33,
        generationNotice = "提示-$id", generationError = null, contentRenderMode = "markdown",
        logicalTime = 1000 + seq, seq = seq, importedFrom = null,
        createdAt = 10, updatedAt = 20,
    )

    @Test
    fun `群行与群消息全字段往返：九个调度列与 identity 三键一个都不能丢`(): Unit = runBlocking {
        val source = FakeLocalStore("pc-device")
        source.putGroup(groupRow())
        source.putSession(groupSession())
        source.appendGroupMessage(groupMessage("m1", 1))
        source.appendGroupMessage(groupMessage("m2", 2))

        val bundle = BackupOrchestrator(source, mediaRoot("src"), "0.3.0").create()
        val target = FakeLocalStore("android-device")
        val outcome = BackupOrchestrator(target, mediaRoot("dst"), "0.3.0").restore(bundle.bytes)
        assertTrue(outcome.ok, "恢复应当成功：${outcome.error}")
        assertEquals(1, outcome.applied["groups"], "群行必须被恢复")
        assertEquals(2, outcome.applied["groupMessages"], "群消息必须被恢复")

        val g = target.getGroup("g1")
        assertNotNull(g, "群行丢失")
        assertEquals("远征队", g!!.name, "群名")
        assertEquals("free", g.chatMode, "调度列 chatMode 必须往返")
        assertEquals(true, g.autoMode, "调度列 autoMode 必须往返")
        assertEquals(5, g.maxRounds, "调度列 maxRounds 必须往返")
        assertEquals(1700, g.speakerInterval, "调度列 speakerInterval 必须往返")
        assertEquals(1, g.currentSpeakerIndex, "调度列 currentSpeakerIndex 必须往返")
        assertEquals("p9", g.presetId, "调度列 presetId 必须往返")
        assertEquals("群系统提示", g.systemPrompt, "调度列 systemPrompt 必须往返")
        assertEquals("""["lb1","lb2"]""", g.lorebookIdsJson, "调度列 lorebookIdsJson 必须原样往返")
        assertEquals("omniscient", g.defaultNarrativeMode, "调度列 defaultNarrativeMode 必须往返")
        assertEquals("""["c1","c2"]""", g.characterIdsJson, "成员序必须往返（排序是发言计划输入）")

        val messages = target.listGroupMessages("gs1").sortedBy { it.seq }
        assertEquals(2, messages.size, "两条群消息都要回来")
        val m1 = messages.first { it.id == "m1" }
        assertEquals("immersive", m1.narrativeMode, "identity 三键 narrativeMode 必须往返")
        assertEquals("character", m1.speakerKind, "identity 三键 speakerKind 必须往返")
        assertEquals("manual", m1.generationKind, "identity 三键 generationKind 必须往返")
        assertEquals(2, m1.round, "轮次必须往返（共用轮号语义的存档依据）")
        assertEquals(1001L, m1.logicalTime, "logicalTime 必须往返（排序键）")
        assertEquals("""["a/1.png"]""", m1.imagesJson, "图片引用必须往返")
        assertEquals("译-m1", m1.translation, "译文必须往返")
        assertEquals("提示-m1", m1.generationNotice, "提示字段必须往返")
    }

    @Test
    fun `恢复是合并语义：同 id 覆盖、备份没有的本地群保留`(): Unit = runBlocking {
        val source = FakeLocalStore("pc-device")
        source.putGroup(groupRow())
        source.putSession(groupSession())
        val bundle = BackupOrchestrator(source, mediaRoot("src2"), "0.3.0").create()

        val target = FakeLocalStore("android-device")
        target.putGroup(groupRow().copy(name = "旧名", chatMode = "polling"))
        target.putGroup(LocalGroupEntity(id = "g-local", name = "本地群", mode = "group", characterIdsJson = "[]", createdAt = 0, updatedAt = 0))
        val outcome = BackupOrchestrator(target, mediaRoot("dst2"), "0.3.0").restore(bundle.bytes)
        assertTrue(outcome.ok, "恢复应当成功：${outcome.error}")

        assertEquals("远征队", target.getGroup("g1")!!.name, "同 id 群必须被备份覆盖")
        assertEquals("free", target.getGroup("g1")!!.chatMode, "调度列随覆盖一并更新")
        assertNotNull(target.getGroup("g-local"), "备份没有的本地群必须保留（合并不整替）")
    }
}
