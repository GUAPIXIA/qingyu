package com.qingyu.companion.data.local

import com.qingyu.companion.chatcore.ChatTextMetrics
import com.qingyu.companion.chatcore.LocalChatGenerationUseCase
import com.qingyu.companion.chatcore.ModelGateway
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalConnectionProfileEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.testing.FakeLocalStore
import com.qingyu.companion.network.models.ChatMessageDto
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelChunk
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.network.models.ModelRequestHandle
import com.qingyu.companion.network.models.ModelStreamEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-04：用量诊断测试。
 *
 * 本轮修掉两处真实缺陷：
 * 1. **用量从未被写入**：`recordUsage` 没有任何生产调用者，用量表永远是空的，
 *    因此用量页必然显示 0——只实现读取是没用的；
 * 2. **汇总口径错误**：`today` 与 `total` 曾完全相同，`count` 用 `listUsage(1).size`
 *    计算（最多得 0 或 1）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class LocalUsageDiagnosticsTest {

    private class ScriptedGateway(private val scripts: MutableList<List<ModelStreamEvent>>) : ModelGateway {
        override fun stream(
            provider: ModelProvider,
            profile: ConnectionProfilePublic,
            request: ModelChatRequest,
            apiKey: String?,
        ): Pair<Flow<ModelStreamEvent>, ModelRequestHandle> {
            val script = if (scripts.isEmpty()) emptyList() else scripts.removeAt(0)
            val handle = object : ModelRequestHandle {
                override fun cancel() = Unit
                override val isCancelled: Boolean = false
            }
            return flow { script.forEach { emit(it) } } to handle
        }
    }

    private fun chunk(text: String) = ModelStreamEvent.Chunk(ModelChunk(text))
    private fun finish() = ModelStreamEvent.Completed("stop", null)

    private suspend fun seedStore(): FakeLocalStore {
        val store = FakeLocalStore("android-test")
        store.putCharacter(LocalCharacterEntity(id = "c1", name = "苏晚", createdAt = 0, updatedAt = 0))
        store.putSession(LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0))
        store.upsertConnectionProfile(
            LocalConnectionProfileEntity(
                id = "p1",
                provider = "openai",
                baseUrl = "https://api.example.com/v1",
                model = "gpt-4o-mini",
                createdAt = 0,
                updatedAt = 0,
            ),
        )
        return store
    }

    private fun build(store: FakeLocalStore, gateway: ScriptedGateway): LocalChatRepository {
        val generation = LocalChatGenerationUseCase(
            store = store,
            gateway = gateway,
            profileProvider = {
                ConnectionProfilePublic(
                    id = "p1",
                    provider = ModelProvider.OpenAI,
                    baseUrl = "https://api.example.com/v1",
                    model = "gpt-4o-mini",
                )
            },
            apiKeyProvider = { "sk-test" },
        )
        return LocalChatRepository(
            store = store,
            generation = generation,
            scope = CoroutineScope(Dispatchers.Unconfined),
            requestIdFactory = { "r1" },
        )
    }

    @Test
    fun successfulTurnIsRecordedWithRealCharCounts() = runBlocking {
        val store = seedStore()
        val gateway = ScriptedGateway(mutableListOf(listOf(chunk("夜安，要坐一会儿吗？"), finish())))
        val repository = build(store, gateway)

        repository.sendMessage("s1", "r1", "夜安。")

        val records = store.listUsage(10)
        assertEquals("完成一轮后必须留下用量记录", 1, records.size)
        val record = records[0]
        assertEquals("main", record.taskType)
        assertEquals("s1", record.sessionId)
        assertTrue("必须记录真实的输入字符数", record.inputChars > 0)
        assertTrue("必须记录真实的输出字符数", record.outputChars > 0)
        // 输出字符数应等于正文的可见字符数（不是 token、不是字节）
        assertEquals("夜安，要坐一会儿吗？".length, record.outputChars)
        assertTrue(
            "输入字符数应大于单条用户消息（含系统提示）",
            record.inputChars > "夜安。".length,
        )
    }

    @Test
    fun failedTurnDoesNotPolluteUsage() = runBlocking {
        val store = seedStore()
        val gateway = ScriptedGateway(mutableListOf(listOf(chunk("   "), finish())))
        val repository = build(store, gateway)

        repository.sendMessage("s1", "r1", "夜安。")

        assertEquals("没有产出的轮次不得写入用量", 0, store.listUsage(10).size)
    }

    @Test
    fun summarySeparatesTodayFromTotalAndCountsAllRows() = runBlocking {
        val store = seedStore()
        val gateway = ScriptedGateway(
            mutableListOf(
                listOf(chunk("第一轮回复。"), finish()),
                listOf(chunk("第二轮回复。"), finish()),
            ),
        )
        val repository = build(store, gateway)

        repository.sendMessage("s1", "r1", "第一问")
        repository.sendMessage("s1", "r2", "第二问")

        val summary = repository.usageSummary()
        // count 必须是真实的记录条数（此前用 listUsage(1).size，最多返回 1）
        assertEquals("total.count 必须是全部记录条数", 2, summary.total.count)
        assertTrue("total 必须累计字符数", summary.total.totalChars > 0)
        // 条数正确 + 字符 = 输入 + 输出
        assertEquals(
            "totalChars 必须等于输入+输出",
            summary.total.totalInput + summary.total.totalOutput,
            summary.total.totalChars,
        )
        // 今天写入的记录必然落在今日统计内
        assertEquals("今日统计应包含刚写入的记录", 2, summary.today.count)
        assertTrue("今日字符数必须与全量一致（数据都在今天写入）", summary.today.totalChars == summary.total.totalChars)
    }

    @Test
    fun recordsListIsOrderedAndCarriesResolvedCharacterId() = runBlocking {
        val store = seedStore()
        val gateway = ScriptedGateway(
            mutableListOf(
                listOf(chunk("第一轮。"), finish()),
                listOf(chunk("第二轮。"), finish()),
            ),
        )
        val repository = build(store, gateway)
        repository.sendMessage("s1", "r1", "一")
        repository.sendMessage("s1", "r2", "二")

        val records = repository.usageRecords(limit = 10)
        assertEquals(2, records.size)
        // 每条都必须能解析出角色（用量页要按角色展示）
        assertTrue("必须解析出 characterId", records.all { it.characterId == "c1" })
        assertTrue("必须带上会话 id", records.all { it.sessionId == "s1" })
        assertTrue("totalChars 必须等于输入+输出", records.all { it.totalChars == it.inputChars + it.outputChars })
        // 倒序：最新在前
        assertTrue("必须按时间倒序", records[0].timestamp >= records[1].timestamp)
        // limit 生效
        assertEquals(1, repository.usageRecords(limit = 1).size)
    }

    @Test
    fun auxTasksAreRecordedSeparatelyAndExcludedFromChatSummary() = runBlocking {
        // S4-05/S4-04：记忆总结与翻译走同一个模型端点，必须按**独立 task type** 记用量，
        // 且**不得混入聊天汇总**——否则「本会话聊了多少」会被整段对话的记忆输入污染。
        // PC 的用量只来自聊天流，因此聊天汇总保持只看 main 才与 PC 口径一致。
        val store = seedStore()
        val gateway = ScriptedGateway(mutableListOf(listOf(chunk("助手回复。"), finish())))
        val repository = build(store, gateway)
        repository.sendMessage("s1", "r1", "用户输入")

        val chatOnly = repository.usageSummary()
        assertEquals("聊天汇总只应统计 main", 1, chatOnly.total.count)

        // 直接写入两条辅助任务记录（记忆总结 / 翻译）
        store.recordUsage(
            com.qingyu.companion.local.db.LocalUsageRecordEntity(
                id = "memory-1",
                sessionId = "s1",
                messageId = null,
                provider = "",
                model = "gpt-4o-mini",
                promptTokens = 0,
                completionTokens = 0,
                createdAt = System.currentTimeMillis(),
                taskType = "memory",
                inputChars = 500,
                outputChars = 120,
            ),
        )
        store.recordUsage(
            com.qingyu.companion.local.db.LocalUsageRecordEntity(
                id = "translation-1",
                sessionId = "s1",
                messageId = null,
                provider = "",
                model = "gpt-4o-mini",
                promptTokens = 0,
                completionTokens = 0,
                createdAt = System.currentTimeMillis(),
                taskType = "translation",
                inputChars = 80,
                outputChars = 60,
            ),
        )

        val afterAux = repository.usageSummary()
        assertEquals("辅助任务不得进入聊天汇总", chatOnly.total.count, afterAux.total.count)
        assertEquals("辅助任务字符数不得进入聊天汇总", chatOnly.total.totalChars, afterAux.total.totalChars)

        val records = repository.usageRecords(limit = 10)
        val taskTypes = records.map { it.taskType }.toSet()
        assertTrue("记录列表必须暴露三种任务类型，否则记了也没人看得见", taskTypes.containsAll(listOf("main", "memory", "translation")))
        assertEquals("翻译记录必须带上输入字符数", 80, records.first { it.taskType == "translation" }.inputChars)
    }

    @Test
    fun charCountsUseCodePointsNotUtf16Units() {
        // 用量以「可见字符」为准，与上下文预算同一口径
        val text = "夜安😀。"
        assertEquals("UTF-16 单元数（含代理对）", 5, text.length)
        assertEquals("可见字符按码点计，emoji 记 1 个", 4, ChatTextMetrics.countVisibleCharacters(text))
    }
}
