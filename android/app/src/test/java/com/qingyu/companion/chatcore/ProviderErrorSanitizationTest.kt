package com.qingyu.companion.chatcore

import com.qingyu.companion.local.db.LocalCharacterEntity
import com.qingyu.companion.local.db.LocalConnectionProfileEntity
import com.qingyu.companion.local.db.LocalSessionEntity
import com.qingyu.companion.local.testing.FakeLocalStore
import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelError
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.network.models.ModelRequestHandle
import com.qingyu.companion.network.models.ModelStreamEvent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-06：「错误提示显示可行动作，**不暴露供应商原始敏感响应**」。
 *
 * 为什么这条容易漏：`ChatDomainErrors.sanitizeErrorMessage` 早就实现且有 fixture 锁定，
 * 但**没有任何生产调用者**——也就是脱敏函数是对的，却没人用。
 * 而 `ModelError` 的 `PROVIDER_ERROR` 分支，message 直接来自供应商响应体
 * （适配器取 `json.take(200)`），`toUserMessage()` 对未知码原样返回它，
 * 于是供应商响应体会被原封不动显示给用户。
 *
 * 本测试锁定「展示边界确实调用了脱敏」：既验证脱敏效果，也防止再次退化成无人调用。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ProviderErrorSanitizationTest {

    private class FailingGateway(private val error: ModelError) : ModelGateway {
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
            return flow { emit(ModelStreamEvent.Failure(error)) } to handle
        }
    }

    private fun store(): FakeLocalStore = runBlocking {
        val store = FakeLocalStore("sanitize")
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

    private fun outcomeOf(error: ModelError): LocalChatGenerationUseCase.GenerationOutcome = runBlocking {
        val store = store()
        val useCase = LocalChatGenerationUseCase(
            store = store,
            gateway = FailingGateway(error),
            profileProvider = {
                ConnectionProfilePublic(
                    id = "profile-1",
                    provider = ModelProvider.OpenAI,
                    baseUrl = "https://example.invalid/v1",
                    model = "gpt-4o-mini",
                )
            },
            apiKeyProvider = { "sk-test" },
        )
        val finished = useCase.generate(sessionId = "s1", userText = "夜安。").toList()
            .filterIsInstance<LocalChatGenerationUseCase.Delta.Finished>()
            .last()
        finished.outcome
    }

    @Test
    fun providerBodyIsSanitizedBeforeReachingTheUser() {
        // 供应商响应体回显了请求内容：API Key + 本机绝对路径都不得出现在用户可见文案里
        val raw = """{"error":{"message":"invalid request for key sk-abcdefghijklmnop123 with file C:\\Users\\me\\secret.json"}}"""
        val outcome = outcomeOf(ModelError("PROVIDER_ERROR", raw, retryable = false))
        val text = outcome.noticeText.orEmpty()

        assertTrue("必须给出错误提示", text.isNotEmpty())
        assertFalse("不得暴露 API Key：$text", text.contains("sk-abcdefghijklmnop123"))
        assertFalse("不得暴露本机路径：$text", text.contains("C:\\Users\\me\\secret.json"))
        assertTrue("脱敏后仍应保留可读原因：$text", text.contains("invalid request"))
    }

    @Test
    fun knownErrorCodesKeepTheirActionableChineseText() {
        // 已知码有固定文案（可行动），脱敏不得把它们改坏
        val text = outcomeOf(ModelError("HTTP_401", "raw body sk-abcdefghijklmnop123", retryable = false)).noticeText.orEmpty()
        assertTrue("认证失败必须给出可行动提示：$text", text.contains("认证失败"))
        assertFalse("同样不得带出原文里的 Key", text.contains("sk-abcdefghijklmnop123"))
    }

    @Test
    fun rateLimitAndTimeoutStayActionable() {
        assertTrue(
            outcomeOf(ModelError("HTTP_429", "quota", retryable = true)).noticeText.orEmpty().contains("稍后重试"),
        )
        assertTrue(
            outcomeOf(ModelError("TIMEOUT", "timeout", retryable = true)).noticeText.orEmpty().contains("超时"),
        )
    }

    @Test
    fun sanitizerItselfStripsKeysAndPaths() {
        // 直接锁定脱敏函数的行为（生产调用点由下面的守卫保证）
        val sanitized = ChatDomainErrors.sanitizeErrorMessage(
            "key=sk-abcdefghijklmnop123 path=C:\\temp\\a.json log=/var/log/b.log",
        )
        assertFalse(sanitized.contains("sk-abcdefghijklmnop123"))
        assertFalse(sanitized.contains("C:\\temp\\a.json"))
        assertTrue(sanitized.contains("sk-***"))
    }

    @Test
    fun sanitizerIsActuallyCalledAtTheDisplayBoundary() {
        // 「实现存在但没有调用者」是本阶段反复出现的缺陷类型：
        // 用源码级守卫要求展示边界确实调用脱敏函数
        val useCase = sourceOf("chatcore/LocalChatGenerationUseCase.kt").readText()
        assertTrue(
            "生成失败的用户文案必须经过脱敏",
            useCase.contains("sanitizeErrorMessage(error.toUserMessage())"),
        )
        val profiles = sourceOf("ui/settings/connection/ConnectionProfilesScreen.kt").readText()
        assertTrue(
            "连接测试失败的用户文案必须经过脱敏",
            profiles.contains("sanitizeErrorMessage(message)"),
        )
    }

    private fun sourceOf(relative: String): java.io.File {
        val candidates = listOf(
            java.io.File("src/main/java/com/qingyu/companion/$relative"),
            java.io.File("app/src/main/java/com/qingyu/companion/$relative"),
        )
        return candidates.firstOrNull { it.exists() }
            ?: error("找不到源文件 $relative（工作目录=${java.io.File(".").absolutePath}）")
    }
}
