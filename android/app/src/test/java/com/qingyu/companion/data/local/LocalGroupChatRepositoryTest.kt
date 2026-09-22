package com.qingyu.companion.data.local

import com.qingyu.companion.chatcore.LocalChatGenerationUseCase
import com.qingyu.companion.chatcore.ModelGateway
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalGroupMessageEntity
import com.qingyu.companion.local.db.LocalMemoryStateEntity
import com.qingyu.companion.local.testing.FakeLocalStore
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.network.models.ModelRequestHandle
import com.qingyu.companion.network.models.ModelStreamEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 阶段 6 S6-01：本地权威群聊数据层的行为测试。
 *
 * 覆盖「关闭 PC 后群聊独立可用」的数据面：群创建带 PC 新建默认值、
 * 设置补丁白名单、成员增删排序、群会话管理、消息幂等写入与轮次/身份快照、
 * 编辑/删除推进历史修订号（派生记忆检查点）、删除群级联。
 *
 * 群 **AI 回复**（groupAiReply）仍在 S6-01d 生成闭环中落地，本测试不覆盖。
 */
class LocalGroupChatRepositoryTest {

    private class SilentGateway : ModelGateway {
        override fun stream(
            provider: ModelProvider,
            profile: ConnectionProfilePublic,
            request: ModelChatRequest,
            apiKey: String?,
        ): Pair<Flow<ModelStreamEvent>, ModelRequestHandle> {
            val handle = object : ModelRequestHandle {
                override fun cancel() = Unit
                override val isCancelled: Boolean = false
            }
            return flow<ModelStreamEvent> { } to handle
        }
    }

    private class Seq {
        private var n = 0
        fun next(): String = "id-${++n}"
    }

    private class Fixture(val store: FakeLocalStore, val repository: LocalChatRepository)

    private fun fixture(): Fixture {
        val store = runBlocking {
            FakeLocalStore("android-test").apply {
                putCharacter(LocalCharacterEntity(id = "c1", name = "苏晚", createdAt = 0, updatedAt = 0))
                putCharacter(LocalCharacterEntity(id = "c2", name = "顾言", createdAt = 0, updatedAt = 0))
                putCharacter(LocalCharacterEntity(id = "c3", name = "林澈", createdAt = 0, updatedAt = 0))
            }
        }
        val seq = Seq()
        val generation = LocalChatGenerationUseCase(
            store = store,
            gateway = SilentGateway(),
            profileProvider = { null },
            apiKeyProvider = { null },
            idFactory = { seq.next() },
            now = { 1_000L },
        )
        return Fixture(store, LocalChatRepository(store, generation, CoroutineScope(kotlinx.coroutines.SupervisorJob())) { seq.next() })
    }

    // ---------------------------------------------------------------- 群创建与设置

    @Test
    fun createGroupUsesPcDefaultsAndMemberNameFallback(): Unit = runBlocking {
        val f = fixture()
        f.repository.createGroup(name = null, memberIds = listOf("c1", "c2"))
        val group = f.repository.listGroups().single()
        assertEquals("缺省群名必须用成员名「、」连接（PC confirmCreate 口径）", "苏晚、顾言", group.name)
        assertEquals("新建群默认 polling（PC 同）", "polling", group.chatMode)
        assertEquals("新建群默认不自动接力", false, group.autoMode)
        assertEquals("新建群 maxRounds=1", 1, group.maxRounds)
        assertEquals("新建群接力间隔 2000ms", 2000, group.speakerInterval)
        assertEquals("新建群发言索引 0", 0, group.currentSpeakerIndex)
        assertEquals("新建群默认预设 builtin-default", "builtin-default", group.presetId)
        assertEquals("成员顺序即轮转顺序，必须原样保留", listOf("c1", "c2"), group.memberIds)
    }

    @Test
    fun patchGroupAppliesWhitelistAndRejectsUnknownOrInvalidKeys(): Unit = runBlocking {
        val f = fixture()
        f.repository.createGroup(name = "群", memberIds = listOf("c1", "c2", "c3"))
        val id = f.repository.listGroups().single().id

        f.repository.patchGroup(
            id,
            mapOf(
                "chatMode" to "free",
                "autoMode" to true,
                "maxRounds" to 3,
                "speakerInterval" to 1500,
                "currentSpeakerIndex" to 2,
                "systemPrompt" to "群规",
                "lorebookIds" to listOf("lb1"),
                "presetId" to null,
                "defaultNarrativeMode" to "omniscient",
            ),
        )
        val updated = f.repository.listGroups().single()
        assertEquals("chatMode 补丁生效", "free", updated.chatMode)
        assertEquals("autoMode 补丁生效", true, updated.autoMode)
        assertEquals("maxRounds 补丁生效", 3, updated.maxRounds)
        assertEquals("speakerInterval 补丁生效", 1500, updated.speakerInterval)
        assertEquals("currentSpeakerIndex 补丁生效", 2, updated.currentSpeakerIndex)
        assertEquals("systemPrompt 补丁生效", "群规", updated.systemPrompt)
        assertEquals("lorebookIds 补丁生效", listOf("lb1"), updated.lorebookIds)
        assertEquals("presetId 显式 null = 取消绑定，不能被丢键吞掉", null, updated.presetId)
        assertEquals("defaultNarrativeMode 补丁生效", "omniscient", updated.defaultNarrativeMode)

        val badMode = runCatching { f.repository.patchGroup(id, mapOf("chatMode" to "nomination")) }.isFailure
        assertTrue("非法 chatMode 必须报错而不是静默纠正（枚举外值会让调度走错分支）", badMode)
        val unknownKey = runCatching { f.repository.patchGroup(id, mapOf("foo" to 1)) }.isFailure
        assertTrue("未知键必须报错而不是静默丢弃", unknownKey)
    }

    @Test
    fun memberEditsKeepOrderAndMemberIdsPatchReorders(): Unit = runBlocking {
        val f = fixture()
        f.repository.createGroup(name = "群", memberIds = listOf("c1", "c2"))
        val id = f.repository.listGroups().single().id

        f.repository.addGroupMembers(id, listOf("c3", "c1"))
        assertEquals("重复添加不得挪动既有成员位置", listOf("c1", "c2", "c3"), f.repository.listGroups().single().memberIds)

        f.repository.patchGroup(id, mapOf("memberIds" to listOf("c3", "c1", "c2")))
        assertEquals("memberIds 补丁 = 成员排序的统一入口", listOf("c3", "c1", "c2"), f.repository.listGroups().single().memberIds)

        f.repository.removeGroupMember(id, "c1")
        assertEquals("成员移除按 id 精确匹配", listOf("c3", "c2"), f.repository.listGroups().single().memberIds)
    }

    // ---------------------------------------------------------------- 群会话

    @Test
    fun groupSessionLifecycleAndDeleteCascade(): Unit = runBlocking {
        val f = fixture()
        f.repository.createGroup(name = "群", memberIds = listOf("c1"))
        val gid = f.repository.listGroups().single().id

        val session = f.repository.createGroupSession(gid, title = null)
        assertEquals("缺省会话名", "新对话", session.title)
        assertEquals("会话归属群", gid, session.groupId)
        assertEquals("新建会话无消息", 0, session.messageCount)

        f.repository.sendGroupMessage(gid, session.id, requestId = "req-1", content = "大家好")
        assertEquals("会话列表必须带真实消息数", 1, f.repository.listGroupSessions(gid).single().messageCount)

        f.repository.renameGroupSession(gid, session.id, "第一幕")
        f.repository.patchGroupSession(
            gid,
            session.id,
            mapOf("narrativeMode" to "omniscient", "memoryEnabled" to true, "autoMemoryInterval" to 5),
        )
        val updated = f.repository.listGroupSessions(gid).single()
        assertEquals("会话改名", "第一幕", updated.title)
        assertEquals("会话叙事模式补丁", "omniscient", updated.narrativeMode)
        assertEquals("会话记忆开关补丁", true, updated.memoryEnabled)
        assertEquals("自动记忆间隔补丁", 5, updated.autoMemoryInterval)

        val badPatch = runCatching {
            f.repository.patchGroupSession(gid, session.id, mapOf("memoryMode" to "sometimes"))
        }.isFailure
        assertTrue("非法 memoryMode 必须报错", badPatch)

        f.repository.deleteGroup(gid)
        assertTrue("群被删除", f.repository.listGroups().isEmpty())
        assertTrue("删除群必须级联删除其会话", f.repository.listGroupSessions(gid).isEmpty())
        assertTrue("删除群必须级联删除其消息", f.store.listGroupMessages(session.id).isEmpty())
    }

    // ---------------------------------------------------------------- 群消息

    @Test
    fun sendGroupMessageIsIdempotentAndSnapshotsIdentity(): Unit = runBlocking {
        val f = fixture()
        f.repository.createGroup(name = "群", memberIds = listOf("c1"))
        val gid = f.repository.listGroups().single().id
        val session = f.repository.createGroupSession(gid, title = "s")

        f.repository.sendGroupMessage(gid, session.id, requestId = "req-1", content = "第一句")
        // 幂等：同 requestId 重发不写第二条（弱网重发语义）
        f.repository.sendGroupMessage(gid, session.id, requestId = "req-1", content = "第一句")

        val messages = f.repository.listGroupMessages(gid, session.id)
        assertEquals("同一 requestId 重发必须幂等（不写第二条）", 1, messages.size)
        val message = messages.single()
        assertEquals("用户消息归属 __user__", "__user__", message.characterId)
        assertEquals("首轮 round=1（max(rounds,0)+1）", 1, message.round)
        assertEquals("用户消息发送状态 sent", "sent", message.status)
        assertEquals("用户消息生成来源 manual", "manual", message.generationKind)
        assertEquals("沉浸叙事下用户消息的显示身份是 persona", "persona", message.speakerKind)
        assertEquals("未设置叙事模式的会话按 immersive 快照（PC resolveNarrativeMode 单候选口径）", "immersive", message.narrativeMode)

        f.repository.patchGroupSession(gid, session.id, mapOf("narrativeMode" to "omniscient"))
        f.repository.sendGroupMessage(gid, session.id, requestId = "req-2", content = "第二句")
        val second = f.repository.listGroupMessages(gid, session.id).last()
        assertEquals("第二轮 round=2", 2, second.round)
        assertEquals("全局叙事下用户消息的显示身份是 narrator（与 PC withMessageIdentity 一致）", "narrator", second.speakerKind)
    }

    @Test
    fun editAndDeleteGroupMessageBumpHistoryRevision(): Unit = runBlocking {
        val f = fixture()
        f.repository.createGroup(name = "群", memberIds = listOf("c1"))
        val gid = f.repository.listGroups().single().id
        val session = f.repository.createGroupSession(gid, title = "s")
        f.repository.sendGroupMessage(gid, session.id, requestId = "req-1", content = "原文")
        // 先有派生记忆行，修订号从 0 起算
        f.store.putMemoryState(LocalMemoryStateEntity(id = "ms-1", sessionId = session.id, updatedAt = 0))

        f.repository.editGroupMessage(gid, session.id, "req-1", content = "改写后")
        val edited = f.repository.listGroupMessages(gid, session.id).single()
        assertEquals("编辑只改 content", "改写后", edited.content)
        assertEquals(
            "编辑历史必须推进修订号，使旧摘要过期",
            1L,
            f.store.getMemoryState(session.id)!!.historyRevision,
        )

        f.repository.deleteGroupMessage(gid, session.id, "req-1")
        assertTrue("删除后消息不再返回", f.repository.listGroupMessages(gid, session.id).isEmpty())
        assertEquals(
            "删除历史同样必须推进修订号",
            2L,
            f.store.getMemoryState(session.id)!!.historyRevision,
        )
    }

    @Test
    fun groupMessagesAreSortedByLogicalTimeThenId(): Unit = runBlocking {
        val f = fixture()
        f.repository.createGroup(name = "群", memberIds = listOf("c1"))
        val gid = f.repository.listGroups().single().id
        val session = f.repository.createGroupSession(gid, title = "s")
        // 故意乱序写入（seq 顺序 ≠ 展示顺序）
        f.store.appendGroupMessage(
            LocalGroupMessageEntity(
                id = "b", sessionId = session.id, groupId = gid, characterId = "__user__",
                content = "后到但时间早", round = 1, seq = -1, logicalTime = 200, createdAt = 0, updatedAt = 0,
            ),
        )
        f.store.appendGroupMessage(
            LocalGroupMessageEntity(
                id = "a", sessionId = session.id, groupId = gid, characterId = "__user__",
                content = "先到", round = 1, seq = -1, logicalTime = 100, createdAt = 0, updatedAt = 0,
            ),
        )
        f.store.appendGroupMessage(
            LocalGroupMessageEntity(
                id = "c", sessionId = session.id, groupId = gid, characterId = "__user__",
                content = "同刻", round = 1, seq = -1, logicalTime = 100, createdAt = 0, updatedAt = 0,
            ),
        )
        val ids = f.repository.listGroupMessages(gid, session.id).map { it.id }
        assertEquals("展示顺序 = (logicalTime, id) 稳定排序（总方案 §6.3）", listOf("a", "c", "b"), ids)
    }
}
