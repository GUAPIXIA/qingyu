package com.qingyu.companion.local.domain

import android.content.Context
import androidx.room.Room
import androidx.test.platform.app.InstrumentationRegistry
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalGroupEntity
import com.qingyu.companion.local.db.LocalLorebookEntity
import com.qingyu.companion.local.db.LocalMessageEntity
import com.qingyu.companion.local.db.LocalPersonaEntity
import com.qingyu.companion.local.db.LocalPresetEntity
import com.qingyu.companion.local.db.LocalQuickReplySetEntity
import com.qingyu.companion.local.db.LocalRegexRuleEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.db.LocalUsageRecordEntity
import com.qingyu.companion.local.db.QingyuLocalDatabase
import com.qingyu.companion.local.testing.FakeLocalStore
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 3 S3-03：Repository 契约测试。
 *
 * **同一行为表**分别跑 `FakeLocalStore`（内存）与 `RoomLocalSyncRepository`（Room + Robolectric），
 * 保证「业务行 + entity_heads + change_log 同事务」「counter 十进制字符串」「删除写 tombstone」
 * 等不变量在两个实现上一致 —— 后续阶段 7 的同步核心只依赖这些不变量。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class LocalRepositoryContractTest {

    private val roomDatabases = mutableListOf<QingyuLocalDatabase>()

    @After
    fun tearDown() {
        roomDatabases.forEach { runCatching { it.close() } }
        roomDatabases.clear()
    }

    /** 契约行为表：每个实现都必须满足。 */
    private fun runContract(name: String, createStore: () -> LocalStore) {
        runBlocking {
            // ---- 行为 1：本地写同时落 business 行 + head + journal ----
            run {
                val store = createStore()
                store.putCharacter(LocalCharacterEntity(id = "c1", name = "A", createdAt = 0, updatedAt = 0))
                assertEquals("$name/journals-local-write", 1, store.journalCount("local"))
                assertNotNull("$name/head-exists", store.getHead("character", "c1"))
                assertEquals("$name/head-not-deleted", false, store.getHead("character", "c1")!!.deleted)
                assertEquals("$name/change-count", 1, store.journalChangeCount())
            }

            // ---- 行为 2：counter 单调递增且为十进制字符串 ----
            run {
                val store = createStore()
                store.putCharacter(LocalCharacterEntity(id = "c1", name = "A", createdAt = 0, updatedAt = 0))
                store.putPersona(LocalPersonaEntity(id = "p1", name = "P", createdAt = 0, updatedAt = 0))
                val v1 = store.getHead("character", "c1")!!.versionJson
                val v2 = store.getHead("persona", "p1")!!.versionJson
                assertTrue("$name/counter-is-decimal-string", v1.contains("\"1\""))
                assertTrue("$name/counter-increments", v2.contains("\"2\""))
            }

            // ---- 行为 3：删除写 tombstone 且保留 journal 历史 ----
            run {
                val store = createStore()
                store.putCharacter(LocalCharacterEntity(id = "c1", name = "A", createdAt = 0, updatedAt = 0))
                store.deleteCharacter("c1")
                assertTrue("$name/tombstoned", store.isTombstoned("character", "c1"))
                assertEquals("$name/journal-kept", 2, store.journalChangeCount())
                assertTrue("$name/tombstone-listed", store.listTombstones().any { it.entityId == "c1" })
            }

            // ---- 行为 4：用量记录按事件 ID 去重 ----
            run {
                val store = createStore()
                val record = LocalUsageRecordEntity(
                    id = "u1",
                    provider = "openai",
                    model = "m",
                    promptTokens = 1,
                    completionTokens = 2,
                    createdAt = 5,
                )
                assertTrue("$name/usage-first-insert", store.recordUsage(record))
                assertFalse("$name/usage-dedup", store.recordUsage(record))
                assertEquals("$name/usage-journal-once", 1, store.journalChangeCount())
            }

            // ---- 行为 5：settings_public 进 journal，device setting 不进 ----
            run {
                val store = createStore()
                store.putPublicSetting("memory", "autoMemory", "true")
                store.putDeviceSetting("themeMode", "\"dark\"")
                assertEquals("$name/public-setting-journaled", 1, store.journalChangeCount())
                assertEquals("$name/device-setting-stored", 1, store.listDeviceSettings().size)
            }

            // ---- 行为 6：远端应用 origin=remote 且不推进本机 dot ----
            run {
                val store = createStore()
                store.initDeviceState()
                store.applyRemote(
                    entityType = "character",
                    entityId = "c-remote",
                    payload = { mapOf("name" to "remote") },
                    business = { store.importCharacter(LocalCharacterEntity(id = "c-remote", name = "remote", createdAt = 0, updatedAt = 0)) },
                )
                assertEquals("$name/remote-origin", 1, store.journalCount("remote"))
                assertEquals("$name/remote-no-local-journal", 0, store.journalCount("local"))
                assertEquals("$name/remote-business-row", 1, store.listCharacters().size)
                assertFalse("$name/remote-head-not-tombstone", store.getHead("character", "c-remote")!!.deleted)
                // 远端应用不得消耗本机 counter：紧随其后的本地写应拿到 "1"
                store.putPersona(LocalPersonaEntity(id = "p-after-remote", name = "P", createdAt = 0, updatedAt = 0))
                assertTrue(
                    "$name/local-counter-not-consumed-by-remote",
                    store.getHead("persona", "p-after-remote")!!.versionJson.contains("\"1\""),
                )
            }

            // ---- 行为 7：父实体删除后拒绝写入子实体，且无半提交 ----
            run {
                val store = createStore()
                store.putCharacter(LocalCharacterEntity(id = "c1", name = "A", createdAt = 0, updatedAt = 0))
                store.deleteCharacter("c1")
                val rejected = runCatching {
                    store.putSession(LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0))
                }.isFailure
                assertTrue("$name/child-under-tombstone-rejected", rejected)
                assertEquals("$name/no-half-commit", 0, store.listSessions().size)
                assertEquals("$name/no-head-for-rejected", null, store.getHead("session", "s1"))
            }

            // ---- 行为 8：会话内消息 seq 从 0 单调递增 ----
            run {
                val store = createStore()
                store.putCharacter(LocalCharacterEntity(id = "c1", name = "A", createdAt = 0, updatedAt = 0))
                store.putSession(LocalSessionEntity(id = "s1", characterId = "c1", createdAt = 0, updatedAt = 0))
                store.appendMessage(
                    LocalMessageEntity(id = "m1", sessionId = "s1", role = "user", content = "a", seq = -1, logicalTime = 0, createdAt = 0, updatedAt = 0),
                )
                store.appendMessage(
                    LocalMessageEntity(id = "m2", sessionId = "s1", role = "assistant", content = "b", seq = -1, logicalTime = 0, createdAt = 0, updatedAt = 0),
                )
                assertEquals("$name/seq-stable-order", listOf(0L, 1L), store.listMessages("s1").map { it.seq })
            }

            // ---- 行为 9：连接档案 public 更新不清空 secret 引用 ----
            run {
                val store = createStore()
                store.upsertConnectionProfile(
                    com.qingyu.companion.local.db.LocalConnectionProfileEntity(
                        id = "p1",
                        provider = "openai",
                        baseUrl = "https://a.example/v1",
                        model = "m1",
                        createdAt = 0,
                        updatedAt = 0,
                    ),
                )
                store.setConnectionSecret("p1", "conn.p1.apiKey")
                store.upsertConnectionProfile(
                    com.qingyu.companion.local.db.LocalConnectionProfileEntity(
                        id = "p1",
                        provider = "openai",
                        baseUrl = "https://b.example/v1",
                        model = "m2",
                        secretRef = null,
                        createdAt = 0,
                        updatedAt = 0,
                    ),
                )
                val stored = store.getConnectionProfile("p1")!!
                assertEquals("$name/public-updated", "https://b.example/v1", stored.baseUrl)
                assertEquals("$name/secret-preserved", "conn.p1.apiKey", stored.secretRef)
            }

            // ---- 行为 10：非用量实体（lorebook/preset/regex/quickReply/group）都能写并记 journal ----
            run {
                val store = createStore()
                store.putLorebook(LocalLorebookEntity(id = "lb1", name = "LB", createdAt = 0, updatedAt = 0))
                store.putPreset(LocalPresetEntity(id = "pr1", name = "PR", createdAt = 0, updatedAt = 0))
                store.putRegexRule(
                    LocalRegexRuleEntity(id = "rx1", name = "RX", pattern = "a", createdAt = 0, updatedAt = 0),
                )
                store.putQuickReplySet(
                    LocalQuickReplySetEntity(id = "qr1", name = "QR", createdAt = 0, updatedAt = 0),
                )
                store.putGroup(LocalGroupEntity(id = "g1", name = "G", createdAt = 0, updatedAt = 0))
                assertEquals("$name/all-entity-journals", 5, store.journalChangeCount())
                assertEquals("$name/heads", 5, store.headCount())
            }
        }
    }

    @Test
    fun `fake local store satisfies repository contract`() {
        runContract("fake") { FakeLocalStore("android-device-a") }
    }

    @Test
    fun `room local store satisfies repository contract`() {
        runContract("room") { newRoomStore() }
    }

    private fun newRoomStore(): LocalStore {
        val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
        val database = Room.inMemoryDatabaseBuilder(context, QingyuLocalDatabase::class.java)
            .allowMainThreadQueries()
            .addCallback(QingyuLocalDatabase.FOREIGN_KEYS_CALLBACK)
            .build()
        roomDatabases += database
        return RoomLocalSyncRepository(database, "android-device-a")
    }
}
