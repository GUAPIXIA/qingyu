package com.qingyu.companion.chatcore

import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalGroupEntity
import com.qingyu.companion.local.db.LocalGroupMessageEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.testing.FakeLocalStore
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelChunk
import com.qingyu.companion.network.models.ModelError
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.network.models.ModelRequestHandle
import com.qingyu.companion.network.models.ModelStreamEvent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 阶段 6 S6-01(d)：群聊本地生成闭环的行为测试。
 *
 * 覆盖「关掉 PC 后群聊独立生成」的核心终局语义（阶段 6 §3 第二条）：
 * - 归属锁定：mention 单轮 / free 多角色拆分，消息归属与轮次正确；
 * - 中断与部分失败：user_cancel 保留已见正文 + 「已停止生成」；传输失败保留稳定部分 +
 *   generationError；无正文**不建空消息**；供应商空回复不建空消息；
 * - 提示字段绝不拼入 content；
 * - polling 接力链由状态机驱动（两轮后按 maxRounds 交还用户）。
 */
class LocalGroupGenerationUseCaseTest {

    private class ScriptedGateway(scripts: List<List<ModelStreamEvent>>) : ModelGateway {
        private val queue = ArrayDeque(scripts)
        val requests = mutableListOf<ModelChatRequest>()
        var callCount = 0
            private set

        override fun stream(
            provider: ModelProvider,
            profile: ConnectionProfilePublic,
            request: ModelChatRequest,
            apiKey: String?,
        ): Pair<Flow<ModelStreamEvent>, ModelRequestHandle> {
            requests += request
            callCount++
            val script = if (queue.isEmpty()) emptyList() else queue.removeFirst()
            val handle = object : ModelRequestHandle {
                override fun cancel() = Unit
                override val isCancelled: Boolean = false
            }
            return flow { script.forEach { emit(it) } } to handle
        }
    }

    private class Seq {
        private var n = 0
        fun next(): String = "m-${++n}"
    }

    private fun chunk(text: String) = ModelStreamEvent.Chunk(ModelChunk(deltaText = text))

    private fun finish(reason: String = "stop") =
        ModelStreamEvent.Chunk(ModelChunk(deltaText = "", finished = true, finishReason = reason))

    private fun profile() = ConnectionProfilePublic(
        id = "p1",
        provider = ModelProvider.OpenAI,
        baseUrl = "https://api.example.com/v1",
        model = "gpt-4o-mini",
        allowHttp = false,
    )

    private class Fixture(
        val store: FakeLocalStore,
        val useCase: LocalGroupGenerationUseCase,
        val gateway: ScriptedGateway,
    )

    /** 建 g1（配置可调）+ gs1 + 一条用户消息（round=1，与触发它的 AI 回复共用轮号）。 */
    private fun fixture(
        scripts: List<List<ModelStreamEvent>>,
        chatMode: String = "polling",
        autoMode: Boolean = true,
        maxRounds: Int = 5,
    ): Fixture {
        val store = runBlocking {
            FakeLocalStore("android-test").apply {
                putCharacter(
                    LocalCharacterEntity(
                        id = "char-a", name = "小A", description = "同伴", personality = "沉稳",
                        scenario = "同行", createdAt = 0, updatedAt = 0,
                    ),
                )
                putCharacter(
                    LocalCharacterEntity(
                        id = "char-b", name = "小B", description = "斥候", personality = "机敏",
                        createdAt = 0, updatedAt = 0,
                    ),
                )
                putGroup(
                    LocalGroupEntity(
                        id = "g1", name = "远征队",
                        characterIdsJson = "[\"char-a\",\"char-b\"]",
                        chatMode = chatMode, autoMode = autoMode, maxRounds = maxRounds,
                        speakerInterval = 500,
                        createdAt = 0, updatedAt = 0,
                    ),
                )
                putSession(LocalSessionEntity(id = "gs1", groupId = "g1", title = "s", createdAt = 0, updatedAt = 0))
                appendGroupMessage(
                    LocalGroupMessageEntity(
                        id = "u1", sessionId = "gs1", groupId = "g1", characterId = "__user__",
                        content = "出发吧", round = 1, status = "sent", narrativeMode = "immersive",
                        speakerKind = "persona", generationKind = "manual",
                        seq = -1, logicalTime = 100, createdAt = 0, updatedAt = 0,
                    ),
                )
            }
        }
        val seq = Seq()
        val gateway = ScriptedGateway(scripts)
        val useCase = LocalGroupGenerationUseCase(
            store = store,
            gateway = gateway,
            profileProvider = { profile() },
            apiKeyProvider = { "sk-test" },
            idFactory = { seq.next() },
            now = { 2_000L },
        )
        return Fixture(store, useCase, gateway)
    }

    // ---------------------------------------------------------------- 归属与落盘

    @Test
    fun mention单轮按锁定归属落盘且与用户消息共用轮号(): Unit = runBlocking {
        val f = fixture(listOf(listOf(chunk("（小A）跟上。"), finish())), chatMode = "mention", autoMode = false)
        val deltas = f.useCase.generate(
            groupId = "g1", sessionId = "gs1", requestId = "req-1",
            targetCharId = "char-b", chainEnabled = false,
        ).toList()

        val finished = deltas.filterIsInstance<LocalGroupGenerationUseCase.Delta.TurnFinished>().single()
        assertEquals("一轮只落一条", 1, finished.messageIds.size)
        val message = f.store.listGroupMessages("gs1").first { it.id == finished.messageIds[0] }
        assertEquals("归属锁定为排定发言者", "char-b", message.characterId)
        assertEquals("与用户消息共用同一轮", 1, message.round)
        assertEquals("正文不含提示字段", "（小A）跟上。", message.content)
        assertNull("正常完成无提示", message.generationNotice)
        assertNull("正常完成无错误", message.generationError)
        assertEquals("身份快照", "character", message.speakerKind)
        assertEquals("生成来源", "assistant_reply", message.generationKind)
        assertEquals("叙事模式快照", "immersive", message.narrativeMode)
        assertEquals("语义分块渲染", "blocks", message.contentRenderMode)
    }

    @Test
    fun free模式拆分多角色且归属逐条正确(): Unit = runBlocking {
        val f = fixture(listOf(listOf(chunk("【小A】一\n【小B】二"), finish())), chatMode = "free")
        val deltas = f.useCase.generate(
            groupId = "g1", sessionId = "gs1", requestId = "req-1", chainEnabled = false,
        ).toList()

        val finished = deltas.filterIsInstance<LocalGroupGenerationUseCase.Delta.TurnFinished>().single()
        val messages = f.store.listGroupMessages("gs1").filter { it.id != "u1" }
        assertEquals("free 拆两条", 2, messages.size)
        assertEquals("首条归属小A", "char-a", messages[0].characterId)
        assertEquals("首条正文", "一", messages[0].content)
        assertEquals("次条归属小B", "char-b", messages[1].characterId)
        assertEquals("次条正文", "二", messages[1].content)
        assertEquals("拆分结果与落盘一致", messages.map { it.id }, finished.messageIds)
    }

    // ---------------------------------------------------------------- 中断与部分失败终局

    @Test
    fun 用户中断保留已见正文并标记已停止生成(): Unit = runBlocking {
        val f = fixture(listOf(listOf(chunk("半截正文"), ModelStreamEvent.Failure(ModelError("CANCELLED", "已取消", false)))))
        val deltas = f.useCase.generate(
            groupId = "g1", sessionId = "gs1", requestId = "req-1",
            forcedSpeakerId = "char-a", chainEnabled = false,
        ).toList()

        val finished = deltas.filterIsInstance<LocalGroupGenerationUseCase.Delta.TurnFinished>().single()
        assertEquals("中断也保留已见正文", 1, finished.messageIds.size)
        val message = f.store.listGroupMessages("gs1").first { it.id == finished.messageIds[0] }
        assertEquals("正文只含可见部分", "半截正文", message.content)
        assertEquals("提示走 generationNotice", "已停止生成", message.generationNotice)
        assertNull("错误字段为空", message.generationError)
    }

    @Test
    fun 传输失败保留稳定句界且错误只进提示字段(): Unit = runBlocking {
        // 收尾管线只保留**稳定边界**内的部分正文（PC「稳定边界收束」语义）：
        // 句号后的残句被收束丢弃，稳定部分保留。
        val f = fixture(listOf(listOf(chunk("夜色渐深，队伍停下休息。还有半句"), ModelStreamEvent.Failure(ModelError("TIMEOUT", "超时", true)))))
        val deltas = f.useCase.generate(
            groupId = "g1", sessionId = "gs1", requestId = "req-1",
            forcedSpeakerId = "char-a", chainEnabled = false,
        ).toList()

        val finished = deltas.filterIsInstance<LocalGroupGenerationUseCase.Delta.TurnFinished>().single()
        val message = f.store.listGroupMessages("gs1").first { it.id == finished.messageIds[0] }
        assertTrue("稳定部分必须保留", message.content.contains("夜色渐深"))
        assertTrue("不稳定的残句被收尾管线收束", !message.content.contains("半句"))
        assertNotNull("失败提示走 generationError", message.generationError)
        assertNull("正常提示为空", message.generationNotice)
        assertTrue("错误文案绝不拼入 content", !message.content.contains("超时"))
    }

    @Test
    fun 无正文的失败不建空消息(): Unit = runBlocking {
        val f = fixture(listOf(listOf(ModelStreamEvent.Failure(ModelError("TIMEOUT", "超时", true)))))
        val deltas = f.useCase.generate(
            groupId = "g1", sessionId = "gs1", requestId = "req-1",
            forcedSpeakerId = "char-a", chainEnabled = false,
        ).toList()

        val finished = deltas.filterIsInstance<LocalGroupGenerationUseCase.Delta.TurnFinished>().single()
        assertTrue("无正文不得落盘", finished.messageIds.isEmpty())
        assertEquals("除用户消息外无新行", listOf("u1"), f.store.listGroupMessages("gs1").map { it.id })
    }

    @Test
    fun 供应商空回复不建空消息(): Unit = runBlocking {
        val f = fixture(listOf(listOf(finish())))
        val deltas = f.useCase.generate(
            groupId = "g1", sessionId = "gs1", requestId = "req-1",
            forcedSpeakerId = "char-a", chainEnabled = false,
        ).toList()

        val finished = deltas.filterIsInstance<LocalGroupGenerationUseCase.Delta.TurnFinished>().single()
        assertTrue("空回复不建空消息", finished.messageIds.isEmpty())
    }

    // ---------------------------------------------------------------- 接力链（状态机驱动）

    @Test
    fun polling接力链按序生成并在maxRounds交还用户(): Unit = runBlocking {
        val f = fixture(
            listOf(
                listOf(chunk("（小A）第一轮。"), finish()),
                listOf(chunk("（小B）第二轮。"), finish()),
            ),
            chatMode = "polling", autoMode = true, maxRounds = 2,
        )
        val deltas = f.useCase.generate(
            groupId = "g1", sessionId = "gs1", requestId = "req-1",
            chainEnabled = true, turnRound = 1,
        ).toList()

        val finished = deltas.filterIsInstance<LocalGroupGenerationUseCase.Delta.TurnFinished>()
        assertEquals("链共两轮", 2, finished.size)
        val waiting = deltas.filterIsInstance<LocalGroupGenerationUseCase.Delta.WaitingUser>().single()
        assertEquals("maxRounds 后交还用户", ChatGroupTurnMachine.REASON_MAX_ROUNDS, waiting.reason)

        val persisted = f.store.listGroupMessages("gs1").filter { it.id != "u1" }
        assertEquals("两轮各落一条", 2, persisted.size)
        assertEquals("首轮归属轮转首位", "char-a", persisted[0].characterId)
        assertEquals("首轮与用户共用轮号", 1, persisted[0].round)
        assertEquals("接力轮归属下一位", "char-b", persisted[1].characterId)
        assertEquals("接力轮开新轮", 2, persisted[1].round)
        assertEquals("两次模型调用", 2, f.gateway.callCount)
    }

    @Test
    fun 立即接话不经发言计划且一次性返回(): Unit = runBlocking {
        val f = fixture(listOf(listOf(chunk("（小B）接话。"), finish())), chatMode = "polling", autoMode = true)
        val deltas = f.useCase.generate(
            groupId = "g1", sessionId = "gs1", requestId = "req-1",
            forcedSpeakerId = "char-b", chainEnabled = true,
        ).toList()

        val finished = deltas.filterIsInstance<LocalGroupGenerationUseCase.Delta.TurnFinished>().single()
        val message = f.store.listGroupMessages("gs1").first { it.id == finished.messageIds[0] }
        assertEquals("归属锁定为指定成员", "char-b", message.characterId)
        assertEquals("立即接话开新轮", 2, message.round)
        assertTrue("一次性触发不接力", deltas.filterIsInstance<LocalGroupGenerationUseCase.Delta.TurnStarted>().size == 1)
    }

    // ---------------------------------------------------------------- 世界书接入（U-6-2 余项）

    @Test
    fun 世界书常驻条目注入上下文并更新近因窗口(): Unit = runBlocking {
        val f = fixture(listOf(listOf(chunk("好的。"), finish())), chatMode = "mention", autoMode = false)
        f.store.putLorebook(
            com.qingyu.companion.local.db.LocalLorebookEntity(
                id = "lb1", name = "世界书",
                canonicalJson = """{"entries":[{"id":"e1","content":"<世界书：山口伏击>","activation":{"mode":"constant"}}]}""",
                createdAt = 0, updatedAt = 0,
            ),
        )
        f.store.putGroup(f.store.getGroup("g1")!!.copy(lorebookIdsJson = """["lb1"]"""))

        f.useCase.generate(
            groupId = "g1", sessionId = "gs1", requestId = "req-1",
            targetCharId = "char-a", chainEnabled = false,
        ).toList()

        val systemPrompt = f.gateway.requests[0].messages.first().content
        assertTrue("群绑定世界书的常驻条目必须注入 system 提示", systemPrompt.contains("<世界书：山口伏击>"))
        val session = f.store.getSession("gs1")!!
        assertTrue(
            "触发键必须回写会话近因窗口，否则 recency 加权恒为 0",
            session.recentTriggeredIdsJson.contains("lb1:e1"),
        )
    }

    @Test
    fun 世界书扫描文本带成员名前缀与近因内容(): Unit = runBlocking {
        val f = fixture(listOf(listOf(chunk("好的。"), finish())), chatMode = "mention", autoMode = false)
        // 角色消息在扫描文本里带【成员名】前缀：以角色名为关键词的条目因此可触发
        f.store.appendGroupMessage(
            com.qingyu.companion.local.db.LocalGroupMessageEntity(
                id = "a0", sessionId = "gs1", groupId = "g1", characterId = "char-a",
                content = "我们到山口了。", round = 1, seq = -1, logicalTime = 150, createdAt = 0, updatedAt = 0,
            ),
        )
        f.store.putLorebook(
            com.qingyu.companion.local.db.LocalLorebookEntity(
                id = "lb2", name = "角色条目",
                canonicalJson = """{"entries":[
                    {"id":"e2","content":"<山口伏击情报>","activation":{"mode":"conditional","primaryKeys":["山口"]},"insertion":{"type":"prompt","anchor":"before_character"}},
                    {"id":"e3","content":"<小A的秘密>","activation":{"mode":"conditional","primaryKeys":["【小A】"],"regex":{"enabled":true,"flags":"g"},"wholeWords":false}}
                ]}""",
                createdAt = 0, updatedAt = 0,
            ),
        )
        f.store.putGroup(f.store.getGroup("g1")!!.copy(lorebookIdsJson = """["lb2"]"""))

        f.useCase.generate(
            groupId = "g1", sessionId = "gs1", requestId = "req-1",
            targetCharId = "char-a", chainEnabled = false,
        ).toList()

        val systemPrompt = f.gateway.requests[0].messages.first().content
        assertTrue("关键词「山口」在角色消息内容里命中必须注入", systemPrompt.contains("<山口伏击情报>"))
        assertTrue(
            "成员名前缀【小A】进扫描文本：以角色名为关键词的条目必须能触发",
            systemPrompt.contains("<小A的秘密>"),
        )
    }
}
