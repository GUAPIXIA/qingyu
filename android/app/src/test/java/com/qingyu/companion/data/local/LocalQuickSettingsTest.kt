package com.qingyu.companion.data.local

import com.qingyu.companion.chatcore.LocalChatGenerationUseCase
import com.qingyu.companion.chatcore.ModelGateway
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.local.db.LocalLorebookEntity
import com.qingyu.companion.local.db.LocalPresetEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.testing.FakeLocalStore
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelRequestHandle
import com.qingyu.companion.network.models.ModelStreamEvent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-06：快捷设置面板的**本地读写**测试。
 *
 * 此前这些方法一律走 `notMigrated`：面板在本地模式下显示为空、保存必然失败——
 * 「界面在、功能不在」。本文件锁定修复后的行为：
 * - 世界书/预设列表来自本地表；
 * - 会话级绑定写入 `local_sessions`（并可读回）；
 * - 全局设置只写本地公共设置行。
 *
 * 「只写本地」在 `LocalChatRepository` 里由**结构**保证：该类的依赖只有
 * `LocalStore` + 生成用例，不存在任何远程客户端，因此不可能外发；
 * 测试通过断言「本地存储确实被改动」来取证。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class LocalQuickSettingsTest {

    private class NoopGateway : ModelGateway {
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

    private fun build(store: FakeLocalStore): LocalChatRepository = LocalChatRepository(
        store = store,
        generation = LocalChatGenerationUseCase(
            store = store,
            gateway = NoopGateway(),
            profileProvider = { null },
        ),
        requestIdFactory = { "r1" },
    )

    private suspend fun seedStore(): FakeLocalStore {
        val store = FakeLocalStore("android-test")
        store.putSession(LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0))
        store.putLorebook(
            LocalLorebookEntity(
                id = "lb1",
                name = "城市设定",
                canonicalJson = """{"entries":[{"id":"e1"},{"id":"e2"}]}""",
                scanDepth = 4,
                createdAt = 0,
                updatedAt = 0,
            ),
        )
        store.putPreset(
            LocalPresetEntity(
                id = "ps1",
                name = "默认预设",
                createdAt = 0,
                updatedAt = 0,
            ),
        )
        return store
    }

    @Test
    fun lorebookAndPresetListsComeFromLocalTables() = runBlocking {
        val store = seedStore()
        val repository = build(store)

        val lorebooks = repository.listLorebooks()
        assertEquals(1, lorebooks.size)
        assertEquals("城市设定", lorebooks[0].name)
        assertEquals("条目数应来自 canonical 文档", 2, lorebooks[0].entryCount)
        assertEquals(4, lorebooks[0].scanDepth)

        val presets = repository.listPresets()
        assertEquals(1, presets.size)
        assertEquals("默认预设", presets[0].name)
    }

    @Test
    fun sessionLorebookBindingIsPersistedLocally() = runBlocking {
        val store = seedStore()
        val repository = build(store)

        assertEquals("初始无绑定", emptyList<String>(), repository.getSessionLorebooks("s1"))

        repository.setSessionLorebooks("s1", listOf("lb1", "lb2"))

        assertEquals(listOf("lb1", "lb2"), repository.getSessionLorebooks("s1"))
        // 取证：确实写进了会话行，而不是只存在于内存
        assertEquals(
            """["lb1","lb2"]""",
            store.getSession("s1")!!.lorebookIdsJson,
        )
    }

    @Test
    fun sessionPresetSwitchIsPersistedLocally() = runBlocking {
        val store = seedStore()
        val repository = build(store)

        assertNull("初始未绑定预设", repository.getSessionPreset("s1"))

        repository.setSessionPreset("s1", "ps1")
        assertEquals("ps1", repository.getSessionPreset("s1"))
        assertEquals("ps1", store.getSession("s1")!!.presetId)

        // 取消绑定
        repository.setSessionPreset("s1", null)
        assertNull(repository.getSessionPreset("s1"))
    }

    @Test
    fun missingSessionIsNoOpInsteadOfCrash() = runBlocking {
        val store = seedStore()
        val repository = build(store)
        // 会话不存在时应安静返回，而不是抛异常（面板可能持有过期 sessionId）
        repository.setSessionLorebooks("missing", listOf("lb1"))
        repository.setSessionPreset("missing", "ps1")
        assertEquals(emptyList<String>(), repository.getSessionLorebooks("missing"))
        assertNull(repository.getSessionPreset("missing"))
    }

    @Test
    fun settingsRoundTripStaysLocal() = runBlocking {
        val store = seedStore()
        val repository = build(store)

        val patch: Map<String, Any?> = mapOf(
            "userName" to "旅人",
            "userPersona" to "寡言",
            "defaultNarrativeMode" to "omniscient",
        )
        repository.updateSettings(patch)

        val settings = repository.getSettings()
        assertEquals("旅人", settings.userName)
        assertEquals("寡言", settings.userPersona)
        assertEquals("omniscient", settings.defaultNarrativeMode)

        // 取证：落到本地公共设置行，而不是远程
        val sections = store.listPublicSettings().map { row -> row.section }.toSet()
        assertTrue("用户名必须落在 user 段", sections.contains("user"))
        assertTrue("叙事模式必须落在 chat 段", sections.contains("chat"))
        // 键名映射正确（userName → user.name）
        val userKeys = store.listPublicSettings().filter { row -> row.section == "user" }.map { row -> row.key }.toSet()
        assertTrue("userName 应映射为 name", userKeys.contains("name"))
        assertTrue("userPersona 应映射为 persona", userKeys.contains("persona"))
    }

    @Test
    fun malformedBindingJsonDoesNotBreakThePanel() = runBlocking {
        val store = seedStore()
        // 坏数据（历史遗留或手工改库）不得让整个面板崩溃
        store.putSession(
            LocalSessionEntity(
                id = "s1",
                characterId = "c1",
                lorebookIdsJson = "not-json",
                createdAt = 0,
                updatedAt = 0,
            ),
        )
        val repository = build(store)
        assertEquals(emptyList<String>(), repository.getSessionLorebooks("s1"))
    }
}
