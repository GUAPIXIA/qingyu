package com.qingyu.companion.chatcore

import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalGroupEntity
import com.qingyu.companion.local.db.LocalGroupMessageEntity
import com.qingyu.companion.local.db.LocalMemoryStateEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.local.testing.FakeLocalStore
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelChunk
import com.qingyu.companion.network.models.ModelError
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
 * 阶段 6 S6-01(e)：群长记忆摘要服务的行为测试（对齐 PC `groupMemoryManager.ts`）。
 *
 * 覆盖：CAS 提交（stale 丢弃）、事实提案归一化（scope=group:{gid} + entityId 回退链）、
 * 解析失败指数退避、缺【时间线】保留旧时间线、最小条数约束、提示词含群名/成员名。
 */
class LocalGroupMemoryServiceTest {

    private class ScriptedGateway(private val scripts: List<List<ModelStreamEvent>>) : ModelGateway {
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

    private fun reply(text: String) = listOf(
        ModelStreamEvent.Chunk(ModelChunk(deltaText = text)),
        ModelStreamEvent.Completed("stop", null),
    )

    private fun profile() = ConnectionProfilePublic(
        id = "p1", provider = ModelProvider.OpenAI,
        baseUrl = "https://api.example.com/v1", model = "gpt-4o-mini", allowHttp = false,
    )

    private fun seed(store: FakeLocalStore, messageCount: Int = 5) = runBlocking {
        store.putCharacter(LocalCharacterEntity(id = "char-a", name = "小A", createdAt = 0, updatedAt = 0))
        store.putGroup(
            LocalGroupEntity(
                id = "g1", name = "远征队", characterIdsJson = """["char-a"]""",
                chatMode = "polling", createdAt = 0, updatedAt = 0,
            ),
        )
        store.putSession(LocalSessionEntity(id = "gs1", groupId = "g1", title = "s", createdAt = 0, updatedAt = 0))
        repeat(messageCount) { index ->
            store.appendGroupMessage(
                LocalGroupMessageEntity(
                    id = "m${index + 1}", sessionId = "gs1", groupId = "g1",
                    characterId = if (index % 2 == 0) "__user__" else "char-a",
                    content = "第${index + 1}句：我们讨论山口的伏击。", round = 1,
                    seq = -1, logicalTime = (100 + index).toLong(), createdAt = 0, updatedAt = 0,
                ),
            )
        }
    }

    private fun service(store: LocalStore, scripts: List<List<ModelStreamEvent>>): LocalGroupMemoryService {
        val gateway = ScriptedGateway(scripts)
        return LocalGroupMemoryService(store = store, gateway = gateway, now = { 5_000L })
    }

    @Test
    fun 提交走CAS且stale版本丢弃本次摘要(): Unit = runBlocking {
        // 包装 store：提交前先推进磁盘版本，模拟「生成期间用户编辑了历史」
        val real = FakeLocalStore("android-test").also { seed(it) }
        val staleStore = object : LocalStore by real {
            override suspend fun applyMemoryStateIfVersion(
                sessionId: String,
                expectedVersion: Long,
                entity: LocalMemoryStateEntity,
            ): com.qingyu.companion.local.domain.MemoryCasResult {
                real.putMemoryState(
                    (real.getMemoryState(sessionId) ?: entity).copy(memoryVersion = expectedVersion + 1),
                )
                return real.applyMemoryStateIfVersion(sessionId, expectedVersion, entity)
            }
        }
        val svc = service(staleStore, listOf(reply("【当前状态】\n夜行军。\n\n【时间线】\n1. 出发。\n\n【事实提案】\n```json\n[]\n```")))
        val outcome = svc.summarize(
            scope = CoroutineScope(kotlinx.coroutines.SupervisorJob()),
            groupId = "g1", sessionId = "gs1", automatic = false,
            profile = profile(), apiKey = "sk", model = "gpt-4o-mini", userName = "旅人",
        )
        assertTrue("stale 版本必须失败而不是覆盖", outcome is LocalGroupMemoryService.Outcome.Failed)
        outcome as LocalGroupMemoryService.Outcome.Failed
        assertTrue(
            "失败文案必须说明旧摘要未写入（PC 字面量）",
            outcome.message.contains("本次旧摘要未写入"),
        )
    }

    @Test
    fun 事实提案归一化为群作用域并按回退链解析身份(): Unit = runBlocking {
        val store = FakeLocalStore("android-test").also { seed(it) }
        val svc = service(
            store,
            listOf(
                reply(
                    "【当前状态】\n山口对峙。\n\n【时间线】\n1. 抵达山口。\n\n【事实提案】\n```json\n" +
                        "[{\"subject\":\"小A\",\"predicate\":\"持有\",\"value\":\"地图\",\"changeType\":\"set\"}," +
                        "{\"subject\":\"旅人\",\"predicate\":\"目标\",\"value\":\"过山\",\"changeType\":\"set\"}," +
                        "{\"subject\":\"神秘人\",\"predicate\":\"身份\",\"value\":\"不明\",\"changeType\":\"set\",\"entityId\":\"npc-1\"}]\n```",
                ),
            ),
        )
        val outcome = svc.summarize(
            scope = CoroutineScope(kotlinx.coroutines.SupervisorJob()),
            groupId = "g1", sessionId = "gs1", automatic = false,
            profile = profile(), apiKey = "sk", model = "gpt-4o-mini", userName = "旅人",
        )
        assertTrue("可解析输出必须提交", outcome is LocalGroupMemoryService.Outcome.Summarized)
        val factsJson = store.getMemoryState("gs1")!!.factsJson
        assertTrue("作用域必须归一化为 group:g1（服务端职责）", factsJson.contains("group:g1"))
        assertTrue("同名成员回退链解析到成员 id", factsJson.contains("char-a"))
        assertTrue("subject=用户名回退到 __user__", factsJson.contains("__user__"))
        assertTrue("显式 entityId 优先保留", factsJson.contains("npc-1"))
    }

    @Test
    fun 缺时间线保留旧时间线且推进游标(): Unit = runBlocking {
        val store = FakeLocalStore("android-test").apply { seed(this) }
        store.putMemoryState(
            LocalMemoryStateEntity(
                id = "ms1", sessionId = "gs1", summary = "旧时间线", memoryVersion = 2,
                updatedAt = 0,
            ),
        )
        val svc = service(
            store,
            listOf(reply("【当前状态】\n新状态。\n\n【事实提案】\n```json\n[]\n```")),
        )
        val outcome = svc.summarize(
            scope = CoroutineScope(kotlinx.coroutines.SupervisorJob()),
            groupId = "g1", sessionId = "gs1", automatic = false,
            profile = profile(), apiKey = "sk", model = "gpt-4o-mini", userName = "旅人",
        )
        outcome as LocalGroupMemoryService.Outcome.Summarized
        assertEquals("缺【时间线】必须保留旧时间线（PC 语义）", "旧时间线", outcome.summary)
        assertEquals("当前状态照常更新", "新状态。", outcome.currentState)
        assertEquals("版本 CAS 递增", 3L, outcome.memoryVersion)
        assertTrue("游标推进到总结位置", outcome.cursorMessageId != null)
    }

    @Test
    fun 提案解析失败保留旧事实并指数退避(): Unit = runBlocking {
        val store = FakeLocalStore("android-test").apply { seed(this) }
        store.putMemoryState(
            LocalMemoryStateEntity(
                id = "ms1", sessionId = "gs1", summary = "旧", memoryVersion = 1,
                factsJson = """[{"kind":"text","text":"旧事实"}]""", updatedAt = 0,
            ),
        )
        // 提案段存在但 JSON 损坏：保留旧事实、退避计数递增、retryAfter = nextVersion（n=1<3）
        val svc = service(
            store,
            listOf(reply("【当前状态】\n状态。\n\n【事实提案】\n```json\n[{broken\n```")),
        )
        val outcome = svc.summarize(
            scope = CoroutineScope(kotlinx.coroutines.SupervisorJob()),
            groupId = "g1", sessionId = "gs1", automatic = false,
            profile = profile(), apiKey = "sk", model = "gpt-4o-mini", userName = "旅人",
        )
        assertTrue("解析失败不应吞掉整轮", outcome is LocalGroupMemoryService.Outcome.Summarized)
        val state = store.getMemoryState("gs1")!!
        assertTrue("旧事实必须保留", state.factsJson.contains("旧事实"))
        assertEquals("退避计数递增", 1, state.factParseFailureCount)
        assertEquals("n=1 时 retryAfter = 下一版本", 2L, state.factRetryAfterVersion)
    }

    @Test
    fun 不足最小条数跳过且不调模型(): Unit = runBlocking {
        val store = FakeLocalStore("android-test")
        seed(store, messageCount = 3)
        val svc = service(store, listOf(reply("不该被调用")))
        val outcome = svc.summarize(
            scope = CoroutineScope(kotlinx.coroutines.SupervisorJob()),
            groupId = "g1", sessionId = "gs1", automatic = false,
            profile = profile(), apiKey = "sk", model = "gpt-4o-mini", userName = "旅人",
        )
        assertTrue("不足 4 条必须跳过", outcome is LocalGroupMemoryService.Outcome.Skipped)
    }

    @Test
    fun 系统提示含群名成员名与群协议文案(): Unit = runBlocking {
        val store = FakeLocalStore("android-test").apply { seed(this) }
        val gateway = ScriptedGateway(
            listOf(reply("【当前状态】\n无。\n\n【时间线】\n1. 无。\n\n【事实提案】\n```json\n[]\n```")),
        )
        val svc = LocalGroupMemoryService(store = store, gateway = gateway, now = { 5_000L })
        svc.summarize(
            scope = CoroutineScope(kotlinx.coroutines.SupervisorJob()),
            groupId = "g1", sessionId = "gs1", automatic = false,
            profile = profile(), apiKey = "sk", model = "gpt-4o-mini", userName = "旅人",
        )
        val systemPrompt = gateway.requests[0].messages.first().content
        assertTrue("提示词必须含群名（PC groupMemoryManager 口径）", systemPrompt.contains("群聊「远征队」"))
        assertTrue("提示词必须含成员名列表", systemPrompt.contains("成员：小A"))
        assertTrue("服务端归一化文案必须逐字（PC 口径）", systemPrompt.contains("服务端负责规范化群聊范围和角色身份"))
        assertTrue("退避时不得出现错误断言", systemPrompt.contains("【事实提案】"))
    }
}
