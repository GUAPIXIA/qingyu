package com.qingyu.companion.data.settings

import com.qingyu.companion.data.CompanionError
import com.qingyu.companion.data.isRetryable
import com.qingyu.companion.model.CompanionEvent
import com.qingyu.companion.model.SettingsDto
import com.qingyu.companion.network.NetworkModule
import java.io.File
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * SettingsSyncRepository 行为测试（方案 §7 C 阶段 Android 验收）：
 * - capability 存在走 v2、不存在走 legacy；
 * - 409 进入 Conflict 且保留 remote.current；
 * - 切换 deviceId 清内存旧 snapshot（不串台）+ 缓存按设备隔离；
 * - WS settings:updated revision 相同跳过 refresh（去重）；
 * - 断线不排队：api 不可用直接 Failed 可重试。
 */
class SettingsSyncRepositoryTest {

    private lateinit var server: MockWebServer
    private lateinit var cacheDir: File
    private val events = MutableSharedFlow<CompanionEvent>(extraBufferCapacity = 16)

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        cacheDir = File(System.getProperty("java.io.tmpdir"), "qy-settings-test-${System.nanoTime()}")
    }

    @After
    fun tearDown() {
        runCatching { server.shutdown() }
        runCatching { cacheDir.listFiles()?.forEach { it.delete() }; cacheDir.delete() }
    }

    private fun repository(
        capabilities: Set<String>,
        offline: Boolean = false,
    ): OnlineSettingsSyncRepository {
        val client = OkHttpClient.Builder().build()
        val api = NetworkModule.createApi(client, server.url("/").toString())
        return OnlineSettingsSyncRepository(
            apiProvider = { if (offline) null else api },
            deviceIdProvider = { "dev-1" },
            capabilitiesProvider = { if (offline) throw IllegalStateException("离线") else capabilities },
            settingsEvents = events,
            cacheStore = SettingsCacheStore(cacheDir),
        )
    }

    private fun snapshotBody(revision: String, model: String, extra: String = ""): MockResponse =
        MockResponse().setResponseCode(200).setBody(
            """{"schemaVersion":2,"revision":"$revision","updatedAt":1000,
               "values":{"activeModel":"$model"$extra},"capabilities":["settings_snapshot_v2"]}""",
        )

    // ---------- capability 门控 ----------

    @Test
    fun `capability 含 settings_snapshot_v2 走 v2 快照端点`() = runTest {
        server.enqueue(snapshotBody("r1", "gpt-4o"))
        val repo = repository(setOf("settings_snapshot_v2"))
        repo.bind("dev-1")
        assertEquals(SettingsProtocol.SNAPSHOT_V2, repo.protocol.value)
        assertEquals("r1", repo.snapshot.value?.revision)
        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertTrue(req.path!!.endsWith("/api/v1/settings/snapshot"))
    }

    @Test
    fun `capability 缺失走 legacy 旧 settings 端点`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setBody("""{"activeModel":"claude","streamOutput":true,"translationTargetLang":"英语"}"""),
        )
        val repo = repository(emptySet())
        repo.bind("dev-1")
        assertEquals(SettingsProtocol.LEGACY, repo.protocol.value)
        assertEquals("claude", repo.snapshot.value?.values?.activeModel)
        assertEquals("", repo.snapshot.value?.revision)
        val req = server.takeRequest()
        assertTrue(req.path!!.endsWith("/api/v1/settings"))
    }

    @Test
    fun `legacy patch 直接 PATCH 旧端点且本地合并视图`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setBody("""{"activeModel":"claude","streamOutput":true,"translationTargetLang":"英语"}"""),
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        val repo = repository(emptySet())
        repo.bind("dev-1")
        repo.patch(SettingsChange(mapOf("streamOutput" to false)))
        val status = repo.status.value
        assertTrue("期望 Synced，实际 $status", status is SettingsSyncStatus.Synced)
        // 本地合并：乐观视图含新值
        assertEquals(false, repo.snapshot.value?.values?.streamOutput)
        assertEquals("claude", repo.snapshot.value?.values?.activeModel)
        // 请求 1 GET 旧端点、请求 2 PATCH 旧端点
        val get = server.takeRequest()
        assertEquals("GET", get.method)
        assertTrue(get.path!!.endsWith("/api/v1/settings"))
        val patch = server.takeRequest()
        assertEquals("PATCH", patch.method)
        assertTrue(patch.path!!.endsWith("/api/v1/settings"))
        assertTrue(patch.body.readUtf8().contains("\"streamOutput\":false"))
        repo.close()
    }

    // ---------- 冲突 ----------

    @Test
    fun `409 进入 Conflict 且保留 remote 快照`() = runTest {
        server.enqueue(snapshotBody("r1", "gpt-4o"))
        server.enqueue(
            MockResponse().setResponseCode(409).setBody(
                """{"error":"settings_conflict","current":
                   {"schemaVersion":2,"revision":"r2","updatedAt":2000,
                    "values":{"activeModel":"claude"},"capabilities":["settings_snapshot_v2"]}}""",
            ),
        )
        val repo = repository(setOf("settings_snapshot_v2"))
        repo.bind("dev-1")
        repo.patch(SettingsChange(mapOf("activeModel" to "deepseek")))
        val status = repo.status.value
        assertTrue("期望 Conflict，实际 $status", status is SettingsSyncStatus.Conflict)
        val conflict = status as SettingsSyncStatus.Conflict
        assertEquals("r2", conflict.remote.revision)
        assertEquals("claude", conflict.remote.values.activeModel)
        assertEquals("deepseek", conflict.local.values["activeModel"])
        // UI 不显示已保存：状态非 Synced
        assertFalse(repo.status.value is SettingsSyncStatus.Synced)

        // KeepLocalUseRemote：采纳远端
        repo.resolveConflict(ConflictStrategy.KeepLocalUseRemote)
        assertTrue(repo.status.value is SettingsSyncStatus.Synced)
        assertEquals("claude", repo.snapshot.value?.values?.activeModel)
    }

    @Test
    fun `ApplyLocalAgain 以远端新 revision 为 base 重新 PATCH`() = runTest {
        server.enqueue(snapshotBody("r1", "gpt-4o"))
        server.enqueue(
            MockResponse().setResponseCode(409).setBody(
                """{"error":"settings_conflict","current":
                   {"schemaVersion":2,"revision":"r2","updatedAt":2000,
                    "values":{"activeModel":"claude"},"capabilities":["settings_snapshot_v2"]}}""",
            ),
        )
        server.enqueue(snapshotBody("r3", "deepseek"))
        val repo = repository(setOf("settings_snapshot_v2"))
        repo.bind("dev-1")
        repo.patch(SettingsChange(mapOf("activeModel" to "deepseek")))
        assertTrue(repo.status.value is SettingsSyncStatus.Conflict)
        repo.resolveConflict(ConflictStrategy.ApplyLocalAgain)
        assertTrue(repo.status.value is SettingsSyncStatus.Synced)
        assertEquals("r3", repo.snapshot.value?.revision)
        // 重放的 PATCH 请求 baseRevision 应为冲突体里的 r2
        server.takeRequest() // GET snapshot
        val first = server.takeRequest() // 409 PATCH
        assertTrue(first.body.readUtf8().contains("\"baseRevision\":\"r1\""))
        val replay = server.takeRequest()
        assertTrue(replay.body.readUtf8().contains("\"baseRevision\":\"r2\""))
    }

    @Test
    fun `非 conflict 的 409 不误判`() {
        val err = CompanionError.settingsConflictFrom(409, """{"error":"other_conflict"}""")
        assertNull(err)
        val conflict = CompanionError.settingsConflictFrom(409, """{"error":"settings_conflict"}""")
        assertNotNull(conflict)
        assertNull(conflict?.current) // 无 current → UI 走重新拉取降级
        val parsed = CompanionError.settingsConflictFrom(
            409,
            """{"error":"settings_conflict","current":{"schemaVersion":2,"revision":"rx","updatedAt":1,"values":{}}}""",
        )
        assertEquals("rx", parsed?.current?.revision)
        assertNull(CompanionError.settingsConflictFrom(400, """{"error":"settings_conflict"}"""))
    }

    // ---------- 切换设备隔离 ----------

    @Test
    fun `切换 deviceId 清空内存旧快照并加载目标缓存`() = runTest {
        // A 有在线快照（GET r1）并落盘缓存
        server.enqueue(snapshotBody("revA", "modelA"))
        val repoA = repository(setOf("settings_snapshot_v2"))
        repoA.bind("devA")
        assertEquals("revA", repoA.snapshot.value?.revision)
        repoA.close()

        // 仅为 B 准备 B 的缓存（验证文件名按 deviceId 哈希隔离）
        SettingsCacheStore(cacheDir).save(
            "devB",
            SettingsSnapshot(revision = "revB", updatedAt = 9, values = SettingsDto(activeModel = "modelB")),
        )

        // 同一仓库实例：先绑 A（内存 revA），再切 B
        val repoB = repository(setOf("settings_snapshot_v2"), offline = true)
        repoB.bind("devA")
        assertEquals("revA", repoB.snapshot.value?.revision) // A 的磁盘缓存可回看
        // 切到 B：内存旧 snapshot 必须清空，再加载 B 缓存——绝不把 A 的 activeModel PATCH 到 B
        repoB.bind("devB")
        assertEquals("revB", repoB.snapshot.value?.revision)
        assertEquals("modelB", repoB.snapshot.value?.values?.activeModel)
        // 切到无缓存设备：snapshot 清空 + 断线直接 Failed（不排队）
        repoB.bind("devC")
        assertNull(repoB.snapshot.value)
        assertTrue(repoB.status.value is SettingsSyncStatus.Failed)
        repoB.close()
    }

    // ---------- WS 去重 ----------

    @Test
    fun `revision 相同跳过 refresh`() = runTest {
        server.enqueue(snapshotBody("r1", "m"))
        val repo = repository(setOf("settings_snapshot_v2"))
        repo.bind("dev-1")
        assertEquals(1, server.requestCount)
        // 收集器在 IO 线程异步订阅：留真实时间窗口（runTest 虚拟 delay 不适用）
        Thread.sleep(250)
        // 回声事件（自身 PATCH 广播）：revision 相同 → 不发请求
        events.emit(CompanionEvent.SettingsUpdated(revision = "r1", sourceDeviceId = "dev-1"))
        Thread.sleep(400)
        assertEquals(1, server.requestCount)
        // 新 revision：触发 refresh
        server.enqueue(snapshotBody("r9", "m9"))
        events.emit(CompanionEvent.SettingsUpdated(revision = "r9", changedFields = listOf("activeModel")))
        var attempts = 0
        while (repo.snapshot.value?.revision != "r9" && attempts++ < 80) Thread.sleep(50)
        assertEquals("r9", repo.snapshot.value?.revision)
        assertEquals(2, server.requestCount)
        repo.close()
    }

    @Test
    fun `shouldRefreshOnSettingsEvent 纯函数决策`() {
        assertTrue(shouldRefreshOnSettingsEvent(null, "r1")) // 未加载过
        assertFalse(shouldRefreshOnSettingsEvent("r1", "r1")) // 相同跳过
        assertTrue(shouldRefreshOnSettingsEvent("r1", "r2")) // 不同刷新
        assertFalse(shouldRefreshOnSettingsEvent("r1", "r2", busy = true)) // 保存中不打扰
        assertTrue(shouldRefreshOnSettingsEvent("r1", "r1", force = true)) // 强制
        assertFalse(shouldRefreshOnSettingsEvent("r1", "r1", force = true, busy = true)) // 强制也不打扰
    }

    // ---------- 断线语义 ----------

    @Test
    fun `断线 patch 直接 Failed 不排队`() = runTest {
        val repo = repository(setOf("settings_snapshot_v2"), offline = true)
        repo.bind("dev-offline") // refresh 失败 → Failed
        assertTrue(repo.status.value is SettingsSyncStatus.Failed)
        repo.patch(SettingsChange(mapOf("activeModel" to "x")))
        val status = repo.status.value
        assertTrue(status is SettingsSyncStatus.Failed)
        status as SettingsSyncStatus.Failed
        assertEquals("activeModel", status.change?.fields?.single())
        assertTrue(status.error is CompanionError.Offline)
        assertTrue(status.error.isRetryable())
        repo.close()
    }

    @Test
    fun `本机权威项被白名单过滤不进 PATCH`() = runTest {
        val patch = buildSettingsPatch(
            mapOf(
                "themeColor" to "amber", // PC 显示偏好（v2 已移出安全子集）→ 拒发
                "fontSize" to "large",
                "messageWidth" to 768,
                "activeModel" to "gpt-4o",
            ),
        )
        assertEquals(setOf("activeModel"), patch.keys)
    }

    @Test
    fun `叙事设置属于 PC 同步白名单`() {
        val patch = buildSettingsPatch(
            mapOf(
                "defaultNarrativeMode" to "omniscient",
                "omniscientNarrativeRules" to "{{user}}观察，由{{char}}推进。",
            ),
        )
        assertEquals(setOf("defaultNarrativeMode", "omniscientNarrativeRules"), patch.keys)
        val dto = SettingsDto(
            defaultNarrativeMode = "omniscient",
            omniscientNarrativeRules = "全局规则",
        )
        assertEquals("omniscient", settingsFieldValue(dto, "defaultNarrativeMode"))
        assertEquals("全局规则", settingsFieldValue(dto, "omniscientNarrativeRules"))
    }

    @Test
    fun `debounce 合并纯函数 同字段后值覆盖`() {
        val merged = mergeSettingsChanges(
            SettingsChange(mapOf("lorebookRatio" to 0.2, "streamOutput" to true)),
            SettingsChange(mapOf("lorebookRatio" to 0.45)),
        )
        assertEquals(0.45, merged.values["lorebookRatio"])
        assertEquals(true, merged.values["streamOutput"]) // 未动字段保留
        assertEquals(2, merged.values.size)
        // 首次为 null 直接返回 second
        assertEquals(
            mapOf("a" to 1),
            mergeSettingsChanges(null, SettingsChange(mapOf("a" to 1))).values,
        )
    }

    @Test
    fun `行级状态投影 四态`() {
        assertEquals(
            FieldSyncState.Editing,
            fieldSyncStateFor(SettingsSyncStatus.Saving(setOf("activeModel")), "activeModel"),
        )
        assertEquals(
            FieldSyncState.Idle,
            fieldSyncStateFor(SettingsSyncStatus.Saving(setOf("activeModel")), "streamOutput"),
        )
        assertEquals(
            FieldSyncState.Synced,
            fieldSyncStateFor(SettingsSyncStatus.Synced("r", 1, setOf("activeModel")), "activeModel"),
        )
        assertEquals(
            FieldSyncState.Failed,
            fieldSyncStateFor(
                SettingsSyncStatus.Failed(SettingsChange(mapOf("activeModel" to "x")), CompanionError.Offline()),
                "activeModel",
            ),
        )
        // 冲突：行上不重复标红（全局面板承载）
        val remote = SettingsSnapshot("r", 0, SettingsDto())
        assertEquals(
            FieldSyncState.Idle,
            fieldSyncStateFor(SettingsSyncStatus.Conflict(SettingsChange(mapOf("activeModel" to "x")), remote), "activeModel"),
        )
    }

    // ---------- rejectedFields 语义：patch 成功但字段被拒 ----------

    @Test
    fun `patch 成功响应携带 rejected 字段仍算同步完成`() = runTest {
        server.enqueue(snapshotBody("r1", "m"))
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"schemaVersion":2,"revision":"r2","updatedAt":2,"values":{"activeModel":"m"},
                   "appliedFields":["translationTargetLang"],
                   "rejectedFields":[{"field":"activeModel","reason":"unknown_model"}]}""",
            ),
        )
        val repo = repository(setOf("settings_snapshot_v2"))
        repo.bind("dev-1")
        repo.patch(SettingsChange(mapOf("activeModel" to "nope")))
        // 服务端已接受请求（200）：状态 Synced；rejected 明细保留在快照 revision
        assertTrue(repo.status.value is SettingsSyncStatus.Synced)
        assertEquals("r2", repo.snapshot.value?.revision)
        repo.close()
    }
}
