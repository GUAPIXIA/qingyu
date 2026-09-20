package com.qingyu.companion.security

import com.qingyu.companion.local.domain.LocalStore
import com.qingyu.companion.local.settings.DeviceSettingKey
import com.qingyu.companion.local.settings.LocalSettingsRepository
import com.qingyu.companion.local.settings.PublicSettingKey
import com.qingyu.companion.local.testing.FakeLocalStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 阶段 3 S3-04 / S3-06：连接档案 public/secret 双事务与设置分区。
 *
 * 重点不变量：
 * - 只更新 public 字段**绝不**擦除已存在的 secret；
 * - secret 保存失败时旧 secret 保持可用；
 * - secret 为空时拒绝写入（不能把「未配置」写成空串覆盖旧值）；
 * - `PublicSettings` 进同步 envelope；`DeviceSettings` 不进。
 */
class ConnectionProfileAndSettingsTest {

    private fun newStore(): LocalStore = FakeLocalStore("android-device-a")

    @Test
    fun `public update never clears secret`() = runBlocking {
        val store = newStore()
        val secrets = InMemorySecretStore()
        val repository = ConnectionProfileRepository(store, secrets)

        repository.savePublic(
            id = "p1",
            displayName = "主力",
            provider = "openai",
            baseUrl = "https://api.example.com/v1",
            model = "gpt-x",
            enabled = true,
            sortIndex = 0,
        )
        repository.saveSecret("p1", "sk-old")
        assertTrue(repository.secretConfigured("p1"))
        assertEquals("sk-old", repository.readSecret("p1"))

        // 只更新 public（baseUrl/model/displayName）——secret 必须存活
        repository.savePublic(
            id = "p1",
            displayName = "备用",
            provider = "openai",
            baseUrl = "https://api.example.com/v2",
            model = "gpt-y",
            enabled = false,
            sortIndex = 3,
        )
        val profile = repository.getProfile("p1")!!
        assertEquals("https://api.example.com/v2", profile.baseUrl)
        assertEquals("gpt-y", profile.model)
        assertFalse(profile.enabled)
        assertEquals(3, profile.sortIndex)
        assertEquals("sk-old", repository.readSecret("p1"))
        assertTrue(repository.secretConfigured("p1"))
    }

    @Test
    fun `saving empty secret is rejected and keeps old value`() = runBlocking {
        val store = newStore()
        val secrets = InMemorySecretStore()
        val repository = ConnectionProfileRepository(store, secrets)

        repository.savePublic("p1", "P", "openai", "https://a.example/v1", "m")
        repository.saveSecret("p1", "sk-old")

        val rejected = runCatching { repository.saveSecret("p1", "") }.isFailure
        assertTrue("空 secret 必须被拒绝", rejected)
        assertEquals("sk-old", repository.readSecret("p1"))
    }

    @Test
    fun `secret store failure keeps public row usable`() = runBlocking {
        val store = newStore()
        val failing = object : SecretStore {
            override fun put(alias: String, plain: ByteArray): SecretRef =
                throw IllegalStateException("keystore unavailable")

            override fun get(ref: SecretRef): ByteArray? = null
            override fun delete(ref: SecretRef) = Unit
            override fun exists(ref: SecretRef): Boolean = false
        }
        val repository = ConnectionProfileRepository(store, failing)

        repository.savePublic("p1", "P", "openai", "https://a.example/v1", "m")
        val failed = runCatching { repository.saveSecret("p1", "sk-new") }.isFailure
        assertTrue("secret 保存失败必须向上抛出", failed)

        // public 行仍可用，且 secret 引用未被写成半成品
        val profile = repository.getProfile("p1")!!
        assertEquals("https://a.example/v1", profile.baseUrl)
        assertNull(profile.secretRef)
        assertFalse(repository.secretConfigured("p1"))
    }

    @Test
    fun `views expose only masked secret state`() = runBlocking {
        val store = newStore()
        val repository = ConnectionProfileRepository(store, InMemorySecretStore())
        repository.savePublic("p1", "主力", "openai", "https://a.example/v1", "gpt-x")
        repository.savePublic("p2", "备用", "ollama", "http://192.168.1.10:11434", "llama", sortIndex = 1)
        repository.saveSecret("p1", "sk-secret-value")

        val views = repository.listViews()
        assertEquals(listOf("p1", "p2"), views.map { it.id })
        assertEquals("已配置（••••）", views.first().maskedSecretHint())
        assertEquals("未配置", views.last().maskedSecretHint())

        // 视图对象的 toString 不得包含秘密
        val text = views.first().toString()
        assertFalse(text.contains("sk-secret-value"))
        // ConnectionProfileView 本身不携带明文字段
        assertFalse(views.first()::class.java.declaredFields.any { it.name == "apiKey" })
    }

    @Test
    fun `delete profile clears secret alias`() = runBlocking {
        val store = newStore()
        val secrets = InMemorySecretStore()
        val repository = ConnectionProfileRepository(store, secrets)
        repository.savePublic("p1", "P", "openai", "https://a.example/v1", "m")
        repository.saveSecret("p1", "sk-x")
        assertTrue(secrets.exists(SecretRef("conn.p1.apiKey")))

        repository.deleteProfile("p1")
        assertNull(repository.getProfile("p1"))
        assertFalse(secrets.exists(SecretRef("conn.p1.apiKey")))
    }

    @Test
    fun `reorder rewrites sort index without touching secrets`() = runBlocking {
        val store = newStore()
        val repository = ConnectionProfileRepository(store, InMemorySecretStore())
        repository.savePublic("a", "A", "openai", "https://a.example/v1", "m", sortIndex = 0)
        repository.savePublic("b", "B", "openai", "https://b.example/v1", "m", sortIndex = 1)
        repository.saveSecret("a", "sk-a")

        repository.reorder(listOf("b", "a"))
        assertEquals(listOf("b", "a"), repository.listProfiles().map { it.id })
        assertEquals("sk-a", repository.readSecret("a"))
    }

    @Test
    fun `public settings are journaled while device settings are not`() = runBlocking {
        val store = newStore()
        val settings = LocalSettingsRepository(store)

        settings.setPublicBool(PublicSettingKey.AutoMemory, true)
        settings.setPublicInt(PublicSettingKey.ContextBudget, 16384)
        settings.setPublicString(PublicSettingKey.HistoryFallback, "summarize")
        settings.setDeviceBool(DeviceSettingKey.NotificationsEnabled, false)
        settings.setDeviceString(DeviceSettingKey.DownloadDirectory, "/sdcard/Download/qingyu")

        assertEquals(3, store.journalChangeCount())
        val public = settings.publicSettings()
        assertTrue(public.bool(PublicSettingKey.AutoMemory))
        assertEquals(16384, public.int(PublicSettingKey.ContextBudget))
        assertEquals("summarize", public.string(PublicSettingKey.HistoryFallback))

        val device = settings.deviceSettings()
        assertFalse(device.bool(DeviceSettingKey.NotificationsEnabled))
        assertEquals("/sdcard/Download/qingyu", device.string(DeviceSettingKey.DownloadDirectory))

        // 默认值在未写入时也必须可读
        assertFalse(settings.publicSettings().bool(PublicSettingKey.ReasoningGate))
        assertEquals(8192, PublicSettingKey.ContextBudget.defaultJson.toInt())
    }

    @Test
    fun `unwritten public settings fall back to declared defaults`() = runBlocking {
        val store = newStore()
        val settings = LocalSettingsRepository(store)
        assertEquals(8192, settings.publicSettings().int(PublicSettingKey.ContextBudget))
        assertEquals("truncate", settings.publicSettings().string(PublicSettingKey.HistoryFallback))
        assertEquals(0, store.journalChangeCount())
    }

    @Test
    fun `unknown device setting key is rejected`() = runBlocking {
        val store = newStore()
        val settings = LocalSettingsRepository(store)
        val rejected = runCatching { settings.setDevice("desktopOnlyThing", "true") }.isFailure
        assertTrue(rejected)
        assertEquals(0, store.journalChangeCount())
    }

    @Test
    fun `settings toString never leaks values`() = runBlocking {
        val store = newStore()
        val settings = LocalSettingsRepository(store)
        settings.setPublicString(PublicSettingKey.HistoryFallback, "secret-ish-value")
        val public = store.observePublicSettings().first()
        assertTrue(public.isNotEmpty())
        // PublicSettings 的 toString 只输出键名，不输出值
        val snapshot = settings.publicSettings()
        assertFalse(snapshot.toString().contains("secret-ish-value"))
        assertTrue(snapshot.toString().startsWith("PublicSettings(keys="))
        // 原始行本身携带值（用于同步），但只有仓库层能读到
        assertEquals("\"secret-ish-value\"", public.first { it.key == "historyFallback" }.valueJson)
    }
}
