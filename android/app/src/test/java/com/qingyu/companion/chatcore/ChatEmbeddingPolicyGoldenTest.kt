package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-05：嵌入/语义检索判定层的跨语言一致性测试
 * （对齐 fixture `embedding-policy.json`，oracle 为 PC 的 `shared/chat-core/embeddingPolicy.ts`）。
 *
 * 这层判错一处的后果都不是崩溃，而是**静默的行为差异**：
 * 换了模型还在用旧索引、语义检索永远不命中、或事实命中被映射到别的条目上。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatEmbeddingPolicyGoldenTest {

    private val root = ChatCoreFixtures.root("embedding-policy")

    private fun configOf(map: Map<String, Any?>): ChatEmbeddingPolicy.Config =
        ChatEmbeddingPolicy.Config(
            provider = ChatCoreFixtures.str(map, "provider") ?: "",
            model = ChatCoreFixtures.str(map, "model") ?: "",
            baseUrl = ChatCoreFixtures.str(map, "baseUrl"),
            apiKey = ChatCoreFixtures.str(map, "apiKey"),
        )

    private fun localProfiles(): Map<String, Double> {
        val map = ChatCoreFixtures.mapOrNull(root, "localProfiles") ?: return emptyMap()
        return map.mapValues { (_, profile) ->
            @Suppress("UNCHECKED_CAST")
            val entry = profile as Map<String, Any?>
            (entry["similarityThreshold"] as Number).toDouble()
        }
    }

    @Test
    fun constantsMatchPc() {
        val constants = ChatCoreFixtures.mapOrNull(root, "constants")!!
        assertEquals(
            "defaultSimilarityThreshold",
            (constants["defaultSimilarityThreshold"] as Number).toDouble(),
            ChatEmbeddingPolicy.DEFAULT_SIMILARITY_THRESHOLD,
            1e-12,
        )
        assertEquals(
            "remoteIndexChunkChars",
            ChatCoreFixtures.intOrNull(constants, "remoteIndexChunkChars"),
            ChatEmbeddingPolicy.REMOTE_INDEX_CHUNK_CHARS,
        )
    }

    @Test
    fun factHitMappingMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "factHitCases") as? List<Map<String, Any?>>)
            ?: error("缺少 factHitCases")
        for ((index, case) in cases.withIndex()) {
            val hits = ((ChatCoreFixtures.listOrNull(case, "hits") as? List<Map<String, Any?>>) ?: emptyList())
                .map { (ChatCoreFixtures.str(it, "id") ?: "") to (it["score"] as Number).toDouble() }
            val facts = ((ChatCoreFixtures.listOrNull(case, "facts") as? List<*>)
                ?: emptyList<Any?>()).map { it.toString() }
            val expected = ((ChatCoreFixtures.listOrNull(case, "mapped") as? List<Map<String, Any?>>) ?: emptyList())
                .map { Triple(ChatCoreFixtures.str(it, "text"), ChatCoreFixtures.intOrNull(it, "index"), (it["score"] as Number).toDouble()) }
            val actual = ChatEmbeddingPolicy.mapFactSearchHits(hits, facts)
                .map { Triple(it.text, it.index, it.score) }
            assertEquals("factHits[$index]", expected, actual)
        }
    }

    @Test
    fun vectorSpaceMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "vectorSpaceCases") as? List<Map<String, Any?>>)
            ?: error("缺少 vectorSpaceCases")
        for (case in cases) {
            @Suppress("UNCHECKED_CAST")
            val config = configOf(case["config"] as Map<String, Any?>)
            @Suppress("UNCHECKED_CAST")
            val expected = case["space"] as Map<String, Any?>
            val actual = ChatEmbeddingPolicy.vectorSpaceFromConfig(config)
            val label = "vectorSpace(${config.provider}/${config.model})"
            assertEquals("$label.provider", ChatCoreFixtures.str(expected, "provider"), actual.provider)
            assertEquals("$label.model", ChatCoreFixtures.str(expected, "model"), actual.model)
            assertEquals("$label.modelId", ChatCoreFixtures.str(expected, "modelId"), actual.modelId)
            assertEquals("$label.modelVersion", ChatCoreFixtures.str(expected, "modelVersion"), actual.modelVersion)
        }
    }

    @Test
    fun indexCompatibilityMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "indexCompatCases") as? List<Map<String, Any?>>)
            ?: error("缺少 indexCompatCases")
        for ((index, case) in cases.withIndex()) {
            @Suppress("UNCHECKED_CAST")
            val indexMap = case["index"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val config = configOf(case["config"] as Map<String, Any?>)
            assertEquals(
                "indexCompat[$index]（模型/provider/版本三处任一不同都必须判定为不兼容）",
                ChatCoreFixtures.boolOrNull(case, "compatible"),
                ChatEmbeddingPolicy.isVectorIndexCompatible(
                    indexModel = ChatCoreFixtures.str(indexMap, "model") ?: "",
                    indexProvider = ChatCoreFixtures.str(indexMap, "provider"),
                    indexModelId = ChatCoreFixtures.str(indexMap, "modelId"),
                    indexModelVersion = ChatCoreFixtures.str(indexMap, "modelVersion"),
                    config = config,
                ),
            )
        }
    }

    @Test
    fun thresholdMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "thresholdCases") as? List<Map<String, Any?>>)
            ?: error("缺少 thresholdCases")
        val profiles = localProfiles()
        assertTrue("必须从夹具读到本地模型评测表，否则阈值用例空跑", profiles.isNotEmpty())
        for ((index, case) in cases.withIndex()) {
            @Suppress("UNCHECKED_CAST")
            val config = configOf(case["config"] as Map<String, Any?>)
            val requested = (case["requested"] as? Number)?.toDouble()
            assertEquals(
                "threshold[$index](${config.provider}/${config.model}, requested=$requested)",
                (case["threshold"] as Number).toDouble(),
                ChatEmbeddingPolicy.resolveSemanticThreshold(config, requested, profiles),
                1e-12,
            )
        }
    }

    @Test
    fun configuredMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "configuredCases") as? List<Map<String, Any?>>)
            ?: error("缺少 configuredCases")
        for ((index, case) in cases.withIndex()) {
            @Suppress("UNCHECKED_CAST")
            val config = configOf(case["config"] as Map<String, Any?>)
            assertEquals(
                "configured[$index](${config.provider}/'${config.model}'/baseUrl='${config.baseUrl}'/key='${config.apiKey}')",
                ChatCoreFixtures.boolOrNull(case, "configured"),
                ChatEmbeddingPolicy.isEmbeddingConfigured(config),
            )
        }
    }

    @Test
    fun semanticEligibilityMatchesPc() {
        @Suppress("UNCHECKED_CAST")
        val cases = (ChatCoreFixtures.listOrNull(root, "semanticEligibleCases") as? List<Map<String, Any?>>)
            ?: error("缺少 semanticEligibleCases")
        for ((index, case) in cases.withIndex()) {
            val priority = ChatCoreFixtures.str(case, "priority")
            val matchMode = ChatCoreFixtures.str(case, "matchMode")
            assertEquals(
                "semanticEligible[$index](priority=$priority, matchMode=$matchMode)",
                ChatCoreFixtures.boolOrNull(case, "eligible"),
                ChatEmbeddingPolicy.isSemanticEligible(priority, matchMode),
            )
        }
    }

    @Test
    fun localModelWithoutAtSignReproducesPcSliceQuirk() {
        // 这不是「合理设计」而是 JS 切片的产物：`lastIndexOf('@')` 为 -1 时
        // `slice(0, -1)` 丢掉最后一个字符。两端必须一致，否则同一配置会推出不同向量空间，
        // 导致索引被误判为不兼容而反复重建。
        val space = ChatEmbeddingPolicy.vectorSpaceFromConfig(
            ChatEmbeddingPolicy.Config(provider = "local", model = "weird"),
        )
        assertEquals("weir", space.modelId)
        assertEquals("weird", space.modelVersion)
    }

    @Test
    fun remoteProviderHasNoChunkOverrideAndLocalRequiresExplicitValue() {
        assertEquals(
            "远端嵌入固定 4000 字符切片",
            ChatEmbeddingPolicy.REMOTE_INDEX_CHUNK_CHARS,
            ChatEmbeddingPolicy.resolveIndexChunkChars(
                ChatEmbeddingPolicy.Config(provider = "openai", model = "text-embedding-3-small"),
            ),
        )
        // 本地模型在 Android 未接入：必须显式抛错，而不是静默取一个错值
        val failed = runCatching {
            ChatEmbeddingPolicy.resolveIndexChunkChars(
                ChatEmbeddingPolicy.Config(provider = "local", model = "bge-small-zh-v1.5@1.0.0"),
            )
        }.isFailure
        assertTrue("本地向量模型未接入时必须报错而不是静默取默认值", failed)
        assertFalse(
            "显式传入本地切片长度时应可用（供将来接入本地模型）",
            runCatching {
                ChatEmbeddingPolicy.resolveIndexChunkChars(
                    ChatEmbeddingPolicy.Config(provider = "local", model = "bge-small-zh-v1.5@1.0.0"),
                    localChunkChars = 512,
                )
            }.isFailure,
        )
    }
}
