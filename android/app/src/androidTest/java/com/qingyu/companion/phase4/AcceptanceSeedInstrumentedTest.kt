package com.qingyu.companion.phase4

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalConnectionProfileEntity
import com.qingyu.companion.local.db.QingyuLocalDatabase
import com.qingyu.companion.local.domain.RoomLocalSyncRepository
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 阶段 4 实机验收**播种器**（不是断言型测试，是脚手架）。
 *
 * 为什么需要它：阶段 5 S5-01 才负责「角色管理（创建/编辑/导入）」，阶段 4 不含该能力。
 * 因此要在阶段 4 验证完成定义「关闭 PC 后从创建会话到连续多轮聊天」，
 * 必须先让设备上存在一个角色与一份可直连的连接档案。
 *
 * 与 `LocalChatFlowInstrumentedTest` 的关键区别：**本类不清库**，
 * 播种后数据保留在 `qingyu-local.db`，供随后的人工/脚本 UI 走查使用。
 * 仅在验收流程中手动运行；不参与常规门禁（无 @Test 之外的状态依赖，可重复执行）。
 */
@RunWith(AndroidJUnit4::class)
class AcceptanceSeedInstrumentedTest {

    private lateinit var database: QingyuLocalDatabase
    private lateinit var store: RoomLocalSyncRepository

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        database = Room.databaseBuilder(context, QingyuLocalDatabase::class.java, QingyuLocalDatabase.NAME)
            .addCallback(QingyuLocalDatabase.FOREIGN_KEYS_CALLBACK)
            .build()
        store = RoomLocalSyncRepository(database, "phase4-acceptance-seed")
    }

    @After
    fun tearDown() {
        runCatching { database.close() }
    }

    @Test
    fun seedCharacterAndLocalModelProfileForAcceptanceWalkthrough() = runBlocking {
        // 角色：阶段 5 的能力，这里直接播种（见类注释）
        store.putCharacter(
            LocalCharacterEntity(
                id = ACCEPTANCE_CHARACTER_ID,
                name = "苏晚",
                description = "夜班的旧书店店主，说话简短克制。",
                personality = "冷静、寡言、观察力强",
                scenario = "深夜的旧书店，只剩一盏灯",
                firstMessage = "（她把书推过来）夜安。要坐一会儿吗？",
                createdAt = 0,
                updatedAt = 0,
            ),
        )

        // 连接档案：指向宿主机的 mock OpenAI 兼容服务。
        // 10.0.2.2 是模拟器访问宿主的固定地址，属私网 IPv4，
        // 与应用层 EndpointPolicy「仅私网/loopback 允许 http」一致，故 allowHttp = true。
        store.upsertConnectionProfile(
            LocalConnectionProfileEntity(
                id = ACCEPTANCE_PROFILE_ID,
                provider = "openai",
                baseUrl = ACCEPTANCE_BASE_URL,
                model = ACCEPTANCE_MODEL,
                displayName = "本地验收模型",
                enabled = true,
                sortIndex = 0,
                allowHttp = true,
                capabilitiesJson = "{}",
                secretRef = null,
                createdAt = 0,
                updatedAt = 0,
            ),
        )

        // 断言播种结果，避免「以为播种成功、实际 UI 仍是空」
        val character = store.getCharacter(ACCEPTANCE_CHARACTER_ID)
        assertNotNull("角色必须已写入本地库", character)
        assertEquals("苏晚", character!!.name)
        val profile = store.listConnectionProfiles().firstOrNull { it.id == ACCEPTANCE_PROFILE_ID }
        assertNotNull("连接档案必须已写入本地库", profile)
        assertEquals(ACCEPTANCE_BASE_URL, profile!!.baseUrl)
        assertTrue("模拟器访问宿主需走明文 http，故必须允许明文", profile.allowHttp)
    }

    companion object {
        const val ACCEPTANCE_CHARACTER_ID = "acceptance-character-1"
        const val ACCEPTANCE_PROFILE_ID = "acceptance-profile-1"
        const val ACCEPTANCE_MODEL = "mock-model"

        /** 模拟器访问宿主机（macOS/Windows/Linux 通用）。 */
        const val ACCEPTANCE_BASE_URL = "http://10.0.2.2:8099/v1"
    }
}
