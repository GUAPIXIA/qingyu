package com.qingyu.companion.chatcore

import com.qingyu.companion.data.local.LocalChatRepository
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalConnectionProfileEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.testing.FakeLocalStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 v3：会话级字段的**读写闭环**。
 *
 * v3 迁移补了 6 个会话列，但「有列」不等于「有闭环」：
 * - 世界书**近因窗口**必须由生成路径在每轮结束后推进，否则 `ChatLorebookRuntime` 的
 *   recency 加权永远是 0（运行时早就支持该输入，只是没数据）；
 * - 会话级叙事模式必须能从列里读出来并进入请求。
 *
 * 本测试锁定这两条闭环，以及窗口长度与运行时口径一致（写入侧与读取侧漂移会让
 * 「最近几轮」的定义在两端不同）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class SessionRuntimeStatePersistenceTest {

    private fun store(): FakeLocalStore = runBlocking {
        val store = FakeLocalStore("session-runtime-state")
        store.putCharacter(LocalCharacterEntity(id = "c1", name = "苏晚", createdAt = 0, updatedAt = 0))
        store.putSession(LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0))
        store.upsertConnectionProfile(
            LocalConnectionProfileEntity(
                id = "profile-1",
                provider = "openai",
                baseUrl = "https://example.invalid/v1",
                model = "gpt-4o-mini",
                createdAt = 0,
                updatedAt = 0,
            ),
        )
        store
    }

    private fun repository(store: FakeLocalStore) = LocalChatRepository(
        store = store,
        generation = LocalChatGenerationUseCase(
            store = store,
            gateway = object : ModelGateway {
                override fun stream(
                    provider: com.qingyu.companion.network.models.ModelProvider,
                    profile: com.qingyu.companion.network.models.ConnectionProfilePublic,
                    request: com.qingyu.companion.network.models.ModelChatRequest,
                    apiKey: String?,
                ) = error("本测试不触发生成")
            },
            profileProvider = { null },
            apiKeyProvider = { null },
        ),
        scope = CoroutineScope(Dispatchers.Unconfined),
        requestIdFactory = { "r1" },
    )

    @Test
    fun recentTriggeredKeysAccumulateRoundByRound() = runBlocking {
        val store = store()
        val repository = repository(store)

        repository.appendSessionRecentTriggered("s1", listOf("lb1:e1", "lb1:e2"))
        assertEquals(
            "第一轮触发键必须落盘",
            listOf(listOf("lb1:e1", "lb1:e2")),
            parse(store.getSession("s1")!!.recentTriggeredIdsJson),
        )

        repository.appendSessionRecentTriggered("s1", listOf("lb1:e3"))
        assertEquals(
            "第二轮必须追加而不是覆盖（否则近因永远只看得到最后一轮）",
            listOf(listOf("lb1:e1", "lb1:e2"), listOf("lb1:e3")),
            parse(store.getSession("s1")!!.recentTriggeredIdsJson),
        )
    }

    @Test
    fun recentTriggeredWindowIsCappedLikeTheRuntime() = runBlocking {
        val store = store()
        val repository = repository(store)
        repeat(ChatLorebookScoring.RECENCY_WINDOW + 3) { round ->
            repository.appendSessionRecentTriggered("s1", listOf("lb1:e$round"))
        }
        val rounds = parse(store.getSession("s1")!!.recentTriggeredIdsJson)
        assertEquals(
            "窗口长度必须与运行时一致（写入更长会让读取侧丢弃、更短会丢历史）",
            ChatLorebookScoring.RECENCY_WINDOW,
            rounds.size,
        )
        assertEquals("保留的必须是最新若干轮", "lb1:e${ChatLorebookScoring.RECENCY_WINDOW + 2}", rounds.last().first())
    }

    @Test
    fun emptyKeysDoNotTouchTheSession() = runBlocking {
        val store = store()
        val repository = repository(store)
        val before = store.getSession("s1")!!.updatedAt
        repository.appendSessionRecentTriggered("s1", emptyList())
        assertEquals("本轮没有触发任何条目时不得改动会话行", before, store.getSession("s1")!!.updatedAt)
        assertEquals("[]", store.getSession("s1")!!.recentTriggeredIdsJson)
    }

    @Test
    fun corruptedRecencyJsonDegradesToEmptyWindow() = runBlocking {
        // 脏数据不得让整轮生成失败：退化为空窗口，重新累积
        val store = store()
        store.putSession(store.getSession("s1")!!.copy(recentTriggeredIdsJson = "{不是数组"))
        val repository = repository(store)
        repository.appendSessionRecentTriggered("s1", listOf("lb1:e1"))
        assertEquals(
            listOf(listOf("lb1:e1")),
            parse(store.getSession("s1")!!.recentTriggeredIdsJson),
        )
    }

    @Test
    fun sessionNarrativeModeReachesTheBuilder() {
        // v3 的叙事模式列必须真的进入装配器输入（否则「会话级叙事模式」仍是空转）
        val built = ChatContextBuilder.buildContextMessagesFromData(
            ChatContextBuilder.BuildData(
                character = ChatContextBuilder.CharacterSnapshot(name = "苏晚"),
                chat = ChatContextBuilder.ChatSnapshot(
                    messages = listOf(
                        ChatContextBuilder.MessageSnapshot(id = "m1", role = "user", content = "夜安。", timestamp = 1),
                    ),
                    sessions = listOf(
                        ChatContextBuilder.SessionSnapshot(id = "s1", characterId = "c1", narrativeMode = "omniscient"),
                    ),
                    currentSessionId = "s1",
                ),
                settings = ChatContextBuilder.SettingsSnapshot(userName = "旅人", activeModel = "gpt-4o-mini"),
                profile = ChatContextBuilder.ProfileSnapshot(model = "gpt-4o-mini", maxContext = 8192),
            ),
        )
        assertEquals("会话级叙事模式必须生效", "omniscient", built.narrativeMode)
    }

    @Test
    fun narrativeModeDefaultsToImmersiveWhenUnset() {
        val built = ChatContextBuilder.buildContextMessagesFromData(
            ChatContextBuilder.BuildData(
                character = ChatContextBuilder.CharacterSnapshot(name = "苏晚"),
                chat = ChatContextBuilder.ChatSnapshot(
                    messages = listOf(
                        ChatContextBuilder.MessageSnapshot(id = "m1", role = "user", content = "夜安。", timestamp = 1),
                    ),
                    sessions = listOf(ChatContextBuilder.SessionSnapshot(id = "s1", characterId = "c1")),
                    currentSessionId = "s1",
                ),
                settings = ChatContextBuilder.SettingsSnapshot(userName = "旅人", activeModel = "gpt-4o-mini"),
                profile = ChatContextBuilder.ProfileSnapshot(model = "gpt-4o-mini", maxContext = 8192),
            ),
        )
        assertEquals("未设置时必须回退到 immersive（PC 的三层回退终点）", "immersive", built.narrativeMode)
    }

    private fun parse(json: String): List<List<String>> {
        val rounds = org.json.JSONArray(json)
        return (0 until rounds.length()).map { index ->
            val round = rounds.getJSONArray(index)
            (0 until round.length()).map { round.getString(it) }
        }
    }
}
