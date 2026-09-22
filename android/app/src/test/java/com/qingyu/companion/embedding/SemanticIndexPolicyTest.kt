package com.qingyu.companion.embedding

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-05 硬项：**索引失效键 = model fingerprint + entity revision + chunk strategy version**，
 * 三者任一变化旧索引不可复用（§3 测试硬项）；索引/模型包**不同步**、目标端重建（总方案 §6.1）。
 */
class SemanticIndexPolicyTest {

    private val base = SemanticIndexKey(
        modelFingerprint = "openai:text-embedding-3-small",
        entityRevision = "rev-1",
        chunkStrategyVersion = SemanticIndexPolicy.CHUNK_STRATEGY_VERSION,
    )

    // ---------- 三要素任一变化即重建（§3 硬项） ----------

    @Test
    fun identicalKeysAreReusable() {
        val decision = SemanticIndexPolicy.canReuse(base, base.copy())
        assertTrue("三要素全同必须可复用，否则用户每次打开都要重建索引", decision.reusable)
        assertTrue("可复用时不该列出变化项", decision.changed.isEmpty())
    }

    @Test
    fun modelFingerprintChangeAloneInvalidatesIndex() {
        val changed = base.copy(modelFingerprint = "openai:text-embedding-3-large")
        val decision = SemanticIndexPolicy.canReuse(base, changed)
        assertFalse("换模型后旧索引必须作废（§3 硬项）：旧向量与新查询不是一个空间", decision.reusable)
        assertEquals(
            "变化项要指名模型指纹（界面/日志据此说「换了模型，索引将重建」）",
            listOf(IndexKeyComponent.MODEL_FINGERPRINT),
            decision.changed,
        )
    }

    @Test
    fun entityRevisionChangeAloneInvalidatesIndex() {
        val changed = base.copy(entityRevision = "rev-2")
        val decision = SemanticIndexPolicy.canReuse(base, changed)
        assertFalse("正文修订变了旧索引必须作废：旧向量描述的是旧正文", decision.reusable)
        assertEquals(listOf(IndexKeyComponent.ENTITY_REVISION), decision.changed)
    }

    @Test
    fun chunkStrategyVersionChangeAloneInvalidatesIndex() {
        val changed = base.copy(chunkStrategyVersion = base.chunkStrategyVersion + "-hotfix")
        val decision = SemanticIndexPolicy.canReuse(base, changed)
        assertFalse("切片策略变了旧索引必须作废：同一正文会切出不同的片", decision.reusable)
        assertEquals(listOf(IndexKeyComponent.CHUNK_STRATEGY_VERSION), decision.changed)
    }

    @Test
    fun multipleChangesReportEveryChangedComponent() {
        val changed = SemanticIndexKey("local:bge-m3", "rev-9", "other-strategy")
        val decision = SemanticIndexPolicy.canReuse(base, changed)
        assertFalse("三要素全变必须重建", decision.reusable)
        assertEquals(
            "每个变化项都要报出来（缺一个就会有人只修一半）",
            listOf(IndexKeyComponent.MODEL_FINGERPRINT, IndexKeyComponent.ENTITY_REVISION, IndexKeyComponent.CHUNK_STRATEGY_VERSION),
            decision.changed,
        )
        assertTrue("判定结论要说人话：${decision.explanation()}", decision.explanation().contains("不可复用"))
    }

    @Test
    fun chunkStrategyVersionIsPinnedToALiteral() {
        // 切片/文档构造/质心合并/分词器的语义变了必须换版本号——这条断言就是「防顺手改」的闸。
        // 改了实现却不动这个字符串 = 拿着旧向量查新语料，且没有任何测试会红。
        assertEquals(
            "切片策略版本被字面钉死：改动 ChatLorebookEmbedding 切片/文档/合并语义或词法分词器时必须同步换版本",
            "lorebook-embedding@doc-v1/split-char-overlap-0.15-max16-tail/centroid-l2-v1",
            SemanticIndexPolicy.CHUNK_STRATEGY_VERSION,
        )
    }

    // ---------- 指纹 ----------

    @Test
    fun localModelFingerprintIncludesWeightsSoRepackagedModelInvalidates() {
        val config = com.qingyu.companion.chatcore.ChatEmbeddingPolicy.Config(provider = "local", model = "bge-m3@1.0.0")
        val manifestA = EmbeddingModelManifest.parse(manifestFields(mapOf("model.onnx" to "甲".toByteArray())))
        val manifestB = EmbeddingModelManifest.parse(manifestFields(mapOf("model.onnx" to "乙".toByteArray())))
        val fingerprintA = SemanticIndexPolicy.localModelFingerprint(config, manifestA)
        val fingerprintB = SemanticIndexPolicy.localModelFingerprint(config, manifestB)
        assertTrue(
            "同名同版本但权重不同的模型指纹必须不同（重打包不换版本号也不该复用旧索引）",
            fingerprintA != fingerprintB,
        )
        assertEquals("同权重指纹必须稳定", fingerprintA, SemanticIndexPolicy.localModelFingerprint(config, manifestA))
    }

    @Test
    fun remoteModelFingerprintTracksProviderAndModel() {
        val config = com.qingyu.companion.chatcore.ChatEmbeddingPolicy.Config(provider = "ollama", model = "nomic-embed-text", baseUrl = "http://x")
        assertEquals(
            "远程指纹要含提供方与模型名（换提供方=换向量空间）",
            "ollama:nomic-embed-text",
            SemanticIndexPolicy.remoteModelFingerprint(config),
        )
    }

    // ---------- 不同步、目标端重建（总方案 §6.1） ----------

    @Test
    fun vectorIndexAndModelPackageAreNeverSynced() {
        assertFalse("向量索引绝不能进同步实体（两端哈希会漂移、且目标端本就要重建）", SemanticIndexSyncPolicy.VECTOR_INDEX_SYNC_ELIGIBLE)
        assertFalse("模型包绝不能进同步实体（体积与来源安全都不可接受）", SemanticIndexSyncPolicy.MODEL_PACKAGE_SYNC_ELIGIBLE)
        assertFalse(
            "isSyncEligible 必须对任何派生缓存都返回 false",
            SemanticIndexSyncPolicy.isSyncEligible(SemanticIndexSyncPolicy.LocalOnlyArtifact.VECTOR_INDEX),
        )
        assertFalse(
            "模型包同样不可同步",
            SemanticIndexSyncPolicy.isSyncEligible(SemanticIndexSyncPolicy.LocalOnlyArtifact.MODEL_PACKAGE),
        )
    }

    @Test
    fun targetRebuildsFromLorebookAndMemorySources() {
        assertEquals(
            "目标端必须从世界书/记忆数据重建索引（而不是等对方传缓存）",
            listOf(SemanticRebuildSource.LOREBOOK, SemanticRebuildSource.MEMORY),
            SemanticIndexSyncPolicy.rebuildSources(SemanticIndexSyncPolicy.LocalOnlyArtifact.VECTOR_INDEX),
        )
        assertEquals(
            "模型包按模型目录重新下载",
            listOf(SemanticRebuildSource.MODEL_CATALOG),
            SemanticIndexSyncPolicy.rebuildSources(SemanticIndexSyncPolicy.LocalOnlyArtifact.MODEL_PACKAGE),
        )
        val note = SemanticIndexSyncPolicy.policyNote()
        assertTrue("口径要能直接进界面/文档：$note", note.contains("不参与同步"))
        assertTrue("要写明重建来源：$note", note.contains("重建"))
    }
}
