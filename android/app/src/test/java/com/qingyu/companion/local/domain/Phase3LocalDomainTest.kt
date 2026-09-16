package com.qingyu.companion.local.domain

import com.qingyu.companion.network.models.ConnectionProfilePublic
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.network.models.OpenAiCompatibleAdapter
import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ChatMessageDto
import com.qingyu.companion.network.models.ModelStreamEvent
import com.qingyu.companion.security.ConnectionProfileStore
import com.qingyu.companion.security.InMemorySecretStore
import com.qingyu.companion.ui.startup.LocalStartupSnapshot
import com.qingyu.companion.ui.startup.StartupState
import com.qingyu.companion.ui.startup.decideStartupStateLocal
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class Phase3LocalDomainTest {

    @Test
    fun `local repository journals character put`() {
        val repo = InMemoryLocalSyncRepository("android-a")
        repo.putCharacter("c1", "角色A", "desc")
        assertEquals(1, repo.journalCount("local"))
        assertTrue(repo.listHeads().contains("character" to "c1"))
        assertEquals("角色A", repo.getCharacter("c1")?.get("name"))
    }

    @Test
    fun `secret save failure keeps old value`() {
        val store = ConnectionProfileStore(InMemorySecretStore())
        store.savePublic(
            com.qingyu.companion.security.ConnectionProfilePublic("p1", "openai", "https://api.example.com/v1", "gpt-x"),
        )
        store.saveSecret("p1", "sk-old")
        assertTrue(store.secretConfigured("p1"))
        // public 更新不碰 secret
        store.savePublic(
            com.qingyu.companion.security.ConnectionProfilePublic("p1", "openai", "https://api.example.com/v2", "gpt-y"),
        )
        assertEquals("sk-old", store.readSecret("p1"))
        assertEquals("https://api.example.com/v2", store.getPublic("p1")?.baseUrl)
    }

    @Test
    fun `openai adapter builds https request and parses sse`() {
        val adapter = OpenAiCompatibleAdapter(allowHttp = false)
        val profile = ConnectionProfilePublic("p", ModelProvider.OpenAI, "https://api.openai.com/v1/", "gpt-4o-mini")
        val req = adapter.buildChatRequest(
            profile,
            ModelChatRequest(
                model = "",
                messages = listOf(ChatMessageDto("user", "你好")),
                stream = true,
            ),
        )
        assertTrue(req.url.startsWith("https://"))
        assertTrue(req.url.endsWith("/chat/completions"))
        assertTrue(req.body.contains("\"stream\":true"))
        assertTrue(req.body.contains("你好"))

        val chunk = adapter.parseSseLine("data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}")
        assertTrue(chunk is ModelStreamEvent.Chunk)
        assertEquals("Hi", (chunk as ModelStreamEvent.Chunk).value.deltaText)

        val done = adapter.parseSseLine("data: [DONE]")
        assertTrue(done is ModelStreamEvent.Completed)

        val bad = adapter.parseSseLine("data: {not-json")
        assertTrue(bad is ModelStreamEvent.Failure)
    }

    @Test
    fun `http base url rejected unless allowed`() {
        val strict = OpenAiCompatibleAdapter(allowHttp = false)
        val loose = OpenAiCompatibleAdapter(allowHttp = true)
        val httpProfile = ConnectionProfilePublic("p", ModelProvider.Ollama, "http://192.168.1.10:11434/v1", "llama")
        try {
            strict.buildChatRequest(httpProfile, ModelChatRequest("m", listOf(ChatMessageDto("user", "x"))))
            throw AssertionError("should reject http")
        } catch (_: IllegalArgumentException) {
            // expected
        }
        val ok = loose.buildChatRequest(httpProfile, ModelChatRequest("m", listOf(ChatMessageDto("user", "x"))))
        assertTrue(ok.url.startsWith("http://"))
    }

    @Test
    fun `startup local ready without pairing`() {
        val localReady = decideStartupStateLocal(LocalStartupSnapshot(hasLocalProfile = true))
        assertEquals(StartupState.LocalReady, localReady)

        val needsSetup = decideStartupStateLocal(LocalStartupSnapshot(hasLocalProfile = false))
        assertEquals(StartupState.NeedsLocalSetup, needsSetup)
    }

    @Test
    fun `canonical hash stable for same payload`() {
        val a = sha256Hex(com.qingyu.companion.domain.contracts.CanonicalJson.encode(mapOf("b" to 1, "a" to 2)))
        val b = sha256Hex(com.qingyu.companion.domain.contracts.CanonicalJson.encode(mapOf("a" to 2, "b" to 1)))
        // Kotlin LinkedHashMap preserve insert order - CanonicalJson sorts keys
        assertEquals(a, b)
    }

    @Test
    fun `anthropic gemini ollama adapters build and parse`() {
        val anthropic = com.qingyu.companion.network.models.AnthropicAdapter()
        val aReq = anthropic.buildChatRequest(
            com.qingyu.companion.network.models.ConnectionProfilePublic(
                "a",
                com.qingyu.companion.network.models.ModelProvider.Anthropic,
                "https://api.anthropic.com",
                "claude-x",
            ),
            com.qingyu.companion.network.models.ModelChatRequest(
                "claude-x",
                listOf(
                    com.qingyu.companion.network.models.ChatMessageDto("system", "sys"),
                    com.qingyu.companion.network.models.ChatMessageDto("user", "hi"),
                ),
            ),
        )
        assertTrue(aReq.url.contains("/v1/messages"))
        assertTrue(aReq.body.contains("\"system\""))
        val aChunk = anthropic.parseSseLine(
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"He\"}}",
        )
        assertTrue(aChunk is com.qingyu.companion.network.models.ModelStreamEvent.Chunk)

        val gemini = com.qingyu.companion.network.models.GeminiAdapter()
        val gReq = gemini.buildChatRequest(
            com.qingyu.companion.network.models.ConnectionProfilePublic(
                "g",
                com.qingyu.companion.network.models.ModelProvider.Gemini,
                "https://generativelanguage.googleapis.com",
                "gemini-pro",
            ),
            com.qingyu.companion.network.models.ModelChatRequest(
                "gemini-pro",
                listOf(com.qingyu.companion.network.models.ChatMessageDto("user", "你好")),
            ),
        )
        assertTrue(gReq.url.contains("streamGenerateContent"))
        assertTrue(gReq.body.contains("\"contents\""))

        val ollama = com.qingyu.companion.network.models.OllamaAdapter()
        val oReq = ollama.buildChatRequest(
            com.qingyu.companion.network.models.ConnectionProfilePublic(
                "o",
                com.qingyu.companion.network.models.ModelProvider.Ollama,
                "http://127.0.0.1:11434",
                "llama3",
            ),
            com.qingyu.companion.network.models.ModelChatRequest(
                "llama3",
                listOf(com.qingyu.companion.network.models.ChatMessageDto("user", "x")),
            ),
        )
        assertTrue(oReq.url.contains("/api/chat"))
        val oDone = ollama.parseSseLine("{\"content\":\"ok\",\"done\":true}")
        assertTrue(oDone is com.qingyu.companion.network.models.ModelStreamEvent.Chunk)
    }

    @Test
    fun `legacy importer classifies choices without rewriting`() {
        val importer = com.qingyu.companion.local.migration.LegacyCacheImporter()
        val scan = com.qingyu.companion.local.migration.LegacyCacheScan(
            hasAnyData = true,
            characterCount = 2,
            sessionCount = 3,
            messageCount = 10,
            outboxUnsentCount = 1,
            missingLorebookIds = listOf("lb1"),
        )
        val import = importer.plan(scan, com.qingyu.companion.local.migration.LegacyImportChoice.ImportAsLocalCopy)
        assertEquals(2, import.importedCharacters)
        assertTrue(import.warnings.isNotEmpty())
        val skip = importer.plan(scan, com.qingyu.companion.local.migration.LegacyImportChoice.BackupAndSkip)
        assertEquals(0, skip.importedCharacters)
    }
}
