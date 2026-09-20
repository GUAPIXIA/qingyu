package com.qingyu.companion.phase4

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.qingyu.companion.chatcore.ChatSessionExport
import com.qingyu.companion.chatcore.LocalChatGenerationUseCase
import com.qingyu.companion.chatcore.LocalMemorySummaryService
import com.qingyu.companion.chatcore.ModelGateway
import com.qingyu.companion.data.local.LocalChatRepository
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalConnectionProfileEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.db.QingyuLocalDatabase
import com.qingyu.companion.local.domain.RoomLocalSyncRepository
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelChunk
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.network.models.ModelRequestHandle
import com.qingyu.companion.network.models.ModelStreamEvent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * 阶段 4 完成定义（§5）的**端到端验收**：
 * 关闭 PC 与 Relay 后，Android 能从创建会话到连续多轮聊天、编辑、重生成、记忆和导出完整运行。
 *
 * 为什么单独成一个类：此前的实机走查发生在多轮改动**之前**，
 * 而之后接入的上下文装配、记忆闭环、翻译、方向、用量都可能破坏这条链路。
 * 完成定义要求的是「这条链路整体可用」，不是「每个模块各自有单测」。
 *
 * 与其它仪表测试的分工：本类只串**用户可见的连续动作**，
 * 逐模块的边界条件由各自的测试覆盖。
 *
 * 模型调用由脚本化网关替代（真机无外网依赖），其余全部是生产实现：
 * 真实 Room 库、真实文件、真实装配器、真实 CAS 与导出。
 */
@RunWith(AndroidJUnit4::class)
class Phase4AcceptanceWalkthroughInstrumentedTest {

    private lateinit var database: QingyuLocalDatabase
    private lateinit var store: RoomLocalSyncRepository

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        // 必须用 deleteDatabase：它连同 `-wal`/`-shm` 旁路文件一起删除。
        // 只删主文件会留下残留 WAL，新连接读到空主库 + 旧 WAL →
        // "no such table: local_messages"（曾在本机真机门禁上造成偶发失败）。
        context.deleteDatabase(QingyuLocalDatabase.NAME)
        database = Room.databaseBuilder(context, QingyuLocalDatabase::class.java, QingyuLocalDatabase.NAME)
            .addMigrations(*QingyuLocalDatabase.MIGRATIONS)
            .addCallback(QingyuLocalDatabase.FOREIGN_KEYS_CALLBACK)
            .build()
        store = RoomLocalSyncRepository(database, "phase4-acceptance")
    }

    @After
    fun tearDown() {
        runCatching { database.close() }
    }

    /**
     * **按提示词分派**的网关。
     *
     * 不用固定脚本队列的原因：自动记忆总结、翻译等辅助任务会与主对话竞争同一个网关，
     * 队列顺序会随触发时机漂移，测试因此变得脆弱且难以解释。
     * 按 system 提示词的特征内容分派既稳定，也更接近「不同任务发不同请求」的真实情形。
     */
    private class PromptAwareGateway(
        private val chatReplies: List<String>,
        private val summaryReply: String,
        private val translationReply: String,
    ) : ModelGateway {
        var chatCalls = 0
            private set
        var summaryCalls = 0
            private set
        var translationCalls = 0
            private set

        val totalCalls: Int get() = chatCalls + summaryCalls + translationCalls

        override fun stream(
            provider: ModelProvider,
            profile: ConnectionProfilePublic,
            request: ModelChatRequest,
            apiKey: String?,
        ): Pair<Flow<ModelStreamEvent>, ModelRequestHandle> {
            val prompt = request.messages.joinToString("\n") { it.content }
            val reply = when {
                prompt.contains("对话总结助手") -> {
                    summaryCalls++
                    summaryReply
                }
                prompt.contains("翻译助手") -> {
                    translationCalls++
                    translationReply
                }
                else -> {
                    val index = chatCalls
                    chatCalls++
                    chatReplies.getOrElse(index) { "第${index + 1}轮回复。" }
                }
            }
            val handle = object : ModelRequestHandle {
                override fun cancel() = Unit
                override val isCancelled: Boolean = false
            }
            return flow { emit(chunk(reply)); emit(finish()) } to handle
        }
    }

    /** 供嵌套网关使用：companion 内的方法对嵌套类可见。 */
    private companion object {
        fun chunk(text: String) = ModelStreamEvent.Chunk(ModelChunk(deltaText = text))

        fun finish(reason: String = "stop") =
            ModelStreamEvent.Chunk(ModelChunk(deltaText = "", finished = true, finishReason = reason))
    }

    private class Seq {
        private var n = 0
        fun next(): String = "acc-${++n}"
    }

    /**
     * 装配与生产一致的对象图：仓库 + 生成用例 + 记忆总结（共享同一网关）。
     * 记忆总结必须接线，否则「记忆」这一环在验收里是空的——
     * 这正是本轮要验证的东西。
     */
    private fun harness(
        chatReplies: List<String>,
        summaryReply: String,
    ): Pair<LocalChatRepository, PromptAwareGateway> {
        val gateway = PromptAwareGateway(
            chatReplies = chatReplies,
            summaryReply = summaryReply,
            translationReply = "Good evening.",
        )
        val ids = Seq()
        val profile = ConnectionProfilePublic(
            id = "p1",
            provider = ModelProvider.OpenAI,
            baseUrl = "https://example.invalid/v1",
            model = "gpt-4o-mini",
        )
        val generation = LocalChatGenerationUseCase(
            store = store,
            gateway = gateway,
            profileProvider = { profile },
            apiKeyProvider = { "sk-acceptance" },
            idFactory = { ids.next() },
        )
        val repository = LocalChatRepository(
            store = store,
            generation = generation,
            scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined),
            memorySummary = LocalMemorySummaryService(store = store, gateway = gateway, now = { 1_000L }),
            activeProfileAndKey = { profile to "sk-acceptance" },
            auxGateway = gateway,
            requestIdFactory = { ids.next() },
        )
        return repository to gateway
    }

    private suspend fun seed() {
        // 预置一行记忆状态：编辑/删除必须能推进其历史修订号（没有行时 UPDATE 无处可改，
        // 而自动总结是异步的，靠它先落地会让断言变成竞态）。
        // **必须在对话开始前建**：中途再插一行会产生同会话双行，读取可能命中旧行。
        store.putMemoryState(
            com.qingyu.companion.local.db.LocalMemoryStateEntity(
                id = "ms-s1-seed",
                sessionId = "s1",
                summary = "",
                updatedAt = System.currentTimeMillis(),
            ),
        )
        store.putCharacter(
            LocalCharacterEntity(id = "c1", name = "苏晚", createdAt = 0, updatedAt = 0),
        )
        // 会话在验收里是「创建」出来的：记忆开关随之打开（面板可开关）
        store.putSession(
            LocalSessionEntity(
                id = "s1",
                characterId = "c1",
                title = "深夜的书店",
                createdAt = 0,
                updatedAt = 0,
                memoryEnabled = true,
                memoryMode = "auto",
                autoMemoryInterval = 2,
            ),
        )
        store.upsertConnectionProfile(
            LocalConnectionProfileEntity(
                id = "p1",
                provider = "openai",
                baseUrl = "https://example.invalid/v1",
                model = "gpt-4o-mini",
                createdAt = 0,
                updatedAt = 0,
            ),
        )
    }

    /**
     * 等待生成落盘：生成在仓库自有的作用域里跑，Room 的 DAO 调用是挂起点，
     * 因此 `sendMessage` 返回时助手消息通常还没写完——必须轮询而不是立即断言。
     */
    private suspend fun awaitAssistantCount(sessionId: String, expected: Int, timeoutMs: Long = 10_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (store.listMessages(sessionId).count { it.role == "assistant" } >= expected) return
            kotlinx.coroutines.delay(50)
        }
        assertEquals(
            "等待 assistant 消息超时（期望 $expected 条）",
            expected,
            store.listMessages(sessionId).count { it.role == "assistant" },
        )
    }

    /**
     * 等待某条消息的候选落盘。
     *
     * 注意：重生成**不新建消息**（与 PC 的候选语义一致），
     * 因此不能用「助手消息数 +1」来等待——那是本轮修正掉的错误语义。
     */
    private suspend fun awaitCandidate(messageId: String, expected: Int, timeoutMs: Long = 10_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val target = store.listMessages("s1").firstOrNull { it.id == messageId }
            val swipes = com.qingyu.companion.chatcore.ChatJsonCodec.decodeStringArray(target?.swipesJson)
            if ((swipes?.size ?: 0) >= expected) return
            kotlinx.coroutines.delay(50)
        }
        val target = store.listMessages("s1").firstOrNull { it.id == messageId }
        val swipes = com.qingyu.companion.chatcore.ChatJsonCodec.decodeStringArray(target?.swipesJson)
        assertEquals("等待候选超时（期望 $expected 个）", expected, swipes?.size ?: 0)
    }

    /**
     * 等待记忆版本达到下限（自动总结是后台任务，必须轮询而不是立即断言）。
     *
     * 失败信息必须自带诊断证据：否则每次偶发都要重新跑一遍才能知道
     * 「是根本没调用总结模型」还是「调用了但结果被丢弃」。
     */
    private suspend fun awaitMemoryVersion(
        sessionId: String,
        expectedAtLeast: Long,
        timeoutMs: Long = 10_000,
        diagnostics: suspend () -> String = { "" },
    ) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if ((store.getMemoryState(sessionId)?.memoryVersion ?: 0L) >= expectedAtLeast) return
            kotlinx.coroutines.delay(50)
        }
        assertEquals(
            "等待自动记忆总结超时（${diagnostics()}）",
            expectedAtLeast,
            store.getMemoryState(sessionId)?.memoryVersion ?: 0L,
        )
    }

    @Test
    fun fullWalkthroughRunsEntirelyOnLocalDatabase() = runBlocking {
        seed()
        val summaryReply = """
            【当前状态】
            深夜的书店里，苏晚刚送走最后一位客人。
            【时间线】
            1. 旅人进店避雨。
            2. 苏晚端上热茶。
        """.trimIndent()
        val (repository, gateway) = harness(
            chatReplies = listOf(
                "夜安，要坐一会儿吗？",
                "茶还热着，慢慢喝。",
                "雨大概要下一整夜。",
                // 重生成的新候选
                "那就别急着走了。",
            ),
            summaryReply = summaryReply,
        )

        // ---- 连续多轮 ----
        repository.sendMessage("s1", "r1", "夜安。")
        repository.sendMessage("s1", "r2", "谢谢。")
        repository.sendMessage("s1", "r3", "外面雨很大。")
        awaitAssistantCount("s1", expected = 3)
        val afterChat = store.listMessages("s1")
        assertEquals("三轮对话应有 6 条消息", 6, afterChat.size)
        assertTrue("回复必须落盘", afterChat.any { it.role == "assistant" && it.content.contains("夜安") })

        // ---- 编辑：必须推进历史修订号（派生记忆随之失效）----
        val firstUser = afterChat.first { it.role == "user" }
        // 记忆行由 seed() 在对话开始前预置（见该函数注释）——此处**不得再建一行**：
        // 表上没有 session 唯一约束，中途插入第二行会让读取取到旧版本，症状是「记忆卡住」。
        val revisionBefore = store.getMemoryState("s1")?.historyRevision ?: 0L
        repository.editMessage("s1", firstUser.id, "夜安，我来了。")
        assertEquals(
            "编辑历史必须使派生记忆失效",
            revisionBefore + 1,
            store.getMemoryState("s1")?.historyRevision ?: 0L,
        )
        assertEquals("夜安，我来了。", store.listMessages("s1").first { it.id == firstUser.id }.content)

        // ---- 重生成：候选追加到同一条消息，不新建消息 ----
        val lastAssistant = store.listMessages("s1").last { it.role == "assistant" }
        val originalContent = lastAssistant.content
        repository.swipe("s1", lastAssistant.id, 0)
        awaitCandidate(lastAssistant.id, expected = 2)
        val regenerated = store.listMessages("s1").first { it.id == lastAssistant.id }
        val candidates = com.qingyu.companion.chatcore.ChatJsonCodec.decodeStringArray(regenerated.swipesJson)!!
        assertEquals("必须留下两个候选", 2, candidates.size)
        assertEquals("第一个候选是原内容", originalContent, candidates[0])
        assertEquals("当前索引指向新候选", 1, regenerated.swipeIndex)
        assertEquals("重生成不得新建消息", 6, store.listMessages("s1").size)

        // ---- 切换候选：纯本地，不再调用模型 ----
        val callsBeforeSwitch = gateway.totalCalls
        repository.swipe("s1", lastAssistant.id, -1)
        val switched = store.listMessages("s1").first { it.id == lastAssistant.id }
        assertEquals("切换候选必须回到第一个", originalContent, switched.content)
        assertEquals("切换候选不得调用模型", callsBeforeSwitch, gateway.totalCalls)

        // ---- 记忆（自动）：助手消息落盘后由后台触发，无需用户操作 ----
        // 会话配置为 auto + 间隔 2，因此上面三轮对话期间应已触发过总结。
        awaitMemoryVersion("s1", expectedAtLeast = 1L) {
            "summaryCalls=${gateway.summaryCalls} chatCalls=${gateway.chatCalls} state=${store.getMemoryState("s1")} session=${store.getSession("s1")?.memoryMode}/${store.getSession("s1")?.autoMemoryInterval}"
        }
        val autoState = store.getMemoryState("s1")
        assertNotNull("自动触发必须创建记忆状态行", autoState)
        assertTrue("自动摘要（时间线）必须落库", autoState!!.summary.contains("旅人进店避雨"))
        assertTrue("当前状态必须落库", autoState.currentState.contains("深夜的书店"))
        assertNotNull("自动总结必须推进游标", autoState.memoryLastMessageId)
        assertTrue("自动触发必须真的调用过总结模型", gateway.summaryCalls >= 1)

        // ---- 记忆（手动）：再补几轮产生新的待总结内容，手动入口必须可用 ----
        // 只把自动间隔调大（保持开关打开）：这样后台自动任务会以「未达间隔」跳过，
        // 而手动请求按 PC 语义应在自动跳过之后**重跑一次**——
        // 这正是「刚结束一轮就点立即总结」的真实路径。
        // （若把开关关掉，自动任务会以 memory_disabled 跳过，而 PC 的重跑条件不含该原因，
        //  手动请求就会继承这个跳过结果。）
        store.putSession(store.getSession("s1")!!.copy(autoMemoryInterval = 10))
        repository.sendMessage("s1", "r4", "再来一杯。")
        repository.sendMessage("s1", "r5", "谢谢，我该走了。")
        awaitAssistantCount("s1", expected = 5)
        val versionBeforeManual = store.getMemoryState("s1")!!.memoryVersion
        val (summary, facts) = repository.summarizeMemory("s1", "c1")
        assertTrue("手动总结必须产出摘要正文", summary.isNotEmpty())
        assertTrue(
            "手动总结必须推进版本",
            store.getMemoryState("s1")!!.memoryVersion > versionBeforeManual,
        )
        assertTrue("事实列表类型正确", facts.isEmpty() || facts.all { it.subject.isNotEmpty() })

        // ---- 导出：在真实数据上产出 Markdown 与 JSON ----
        val exportMessages = store.listMessages("s1").map {
            ChatSessionExport.ExportMessage(
                role = it.role,
                content = it.content,
                timestamp = it.logicalTime,
                images = null,
            )
        }
        val markdown = ChatSessionExport.exportSessionMarkdown(exportMessages)
        assertTrue("Markdown 必须带标题", markdown.startsWith("# 对话记录"))
        assertTrue("Markdown 必须包含全部对话", markdown.contains("夜安，我来了。"))
        assertTrue("Markdown 必须包含角色标签", markdown.contains("🎭 AI"))
        val json = ChatSessionExport.exportSessionJson(
            store.listMessages("s1").map { ChatSessionExport.toJsonMap(
                ChatSessionExport.ExportMessage(it.role, it.content, it.logicalTime),
                extra = mapOf("id" to it.id),
            ) },
        )
        val parsed = org.json.JSONArray(json)
        assertEquals("JSON 必须包含全部消息", store.listMessages("s1").size, parsed.length())
        assertTrue("JSON 不得转义斜杠", !json.contains("\\/"))

        // ---- 用量：必须留下记录 ----
        val usage = store.listUsage(10)
        assertTrue("对话必须留下用量记录", usage.isNotEmpty())
        assertTrue("用量必须带真实字符数", usage.all { it.inputChars > 0 && it.outputChars > 0 })
        // 任务类型必须区分：聊天汇总只算 main，记忆/翻译按各自的 task type 单独记录。
        // （此前断言「只存在 main」，随辅助任务用量落地而失效——现在改为断言分离语义。）
        assertEquals("必须存在主对话用量", true, usage.any { it.taskType == "main" })
        val summaryAfterChat = repository.usageSummary()
        assertTrue("聊天汇总必须统计到主对话轮次", summaryAfterChat.total.count >= 1)

        // ---- 翻译 ----
        val translation = repository.translate("s1", firstUser.id)
        assertEquals("Good evening.", translation.translation)

        // 自动记忆总结必须真的被触发过（而不是只在手动路径可用）
        assertTrue("自动长记忆总结必须被触发", gateway.summaryCalls >= 1)
        assertEquals("翻译必须走辅助任务", 1, gateway.translationCalls)

        // 辅助任务必须落成独立 task type，且**不得进入聊天汇总**
        val auxUsage = store.listUsage(50)
        assertTrue("翻译必须留下独立用量记录", auxUsage.any { it.taskType == "translation" })
        assertTrue("记忆总结必须留下独立用量记录", auxUsage.any { it.taskType == "memory" })
        val summaryAfterAux = repository.usageSummary()
        assertEquals(
            "辅助任务不得改变聊天汇总的条数",
            summaryAfterChat.total.count,
            summaryAfterAux.total.count,
        )
    }
}
