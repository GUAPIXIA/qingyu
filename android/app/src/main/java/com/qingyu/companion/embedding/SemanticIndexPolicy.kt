package com.qingyu.companion.embedding

import com.qingyu.companion.chatcore.ChatEmbeddingPolicy

/**
 * 阶段 6 S6-05：**索引失效键**——原文硬项
 * 「索引按 `model fingerprint + entity revision + chunk strategy version` 失效」。
 *
 * 三要素**任一**变化，旧索引都不可复用、必须重建（§3 测试硬项，`SemanticIndexPolicyTest` 钉死）：
 * - `modelFingerprint`：向量空间标识 + 本地模型权重指纹（模型/版本/权重变了，旧向量与新查询
 *   不在一个空间，余弦分数无意义）；
 * - `entityRevision`：被索引实体（世界书/记忆）的修订——正文变了旧向量就是错的；
 * - `chunkStrategyVersion`：切片与向量文档构造策略的版本——切法变了同一正文会切出不同片，
 *   旧向量不可比。
 *
 * **索引与模型包不同步**（总方案 §6.1「派生缓存/向量索引：不同步，由目标端重建」）：
 * [SemanticIndexSyncPolicy] 把这件事收成机器可读的口径，目标端收到同步数据后
 * 按 lorebook/memory 源数据重建索引，模型包按目录重新下载——都不作为同步实体传输。
 */

/** 索引失效键（记录级：每条被索引实体的向量都带着它）。 */
data class SemanticIndexKey(
    val modelFingerprint: String,
    val entityRevision: String,
    val chunkStrategyVersion: String,
)

enum class IndexKeyComponent {
    MODEL_FINGERPRINT,
    ENTITY_REVISION,
    CHUNK_STRATEGY_VERSION,
}

/** 复用判定：可复用 / 需重建（并指出是哪几要素变了）。 */
data class IndexReuseDecision(
    val reusable: Boolean,
    val changed: List<IndexKeyComponent>,
) {
    val rebuildRequired: Boolean get() = !reusable

    /** 面向调试/日志的一句话：为什么不能复用。 */
    fun explanation(): String {
        if (reusable) return "索引失效键一致，旧索引可复用"
        val names = changed.joinToString("、") {
            when (it) {
                IndexKeyComponent.MODEL_FINGERPRINT -> "模型指纹"
                IndexKeyComponent.ENTITY_REVISION -> "实体修订"
                IndexKeyComponent.CHUNK_STRATEGY_VERSION -> "切片策略版本"
            }
        }
        return "索引失效键变化（$names），旧索引不可复用，需重建"
    }
}

object SemanticIndexPolicy {

    /**
     * 切片策略版本。
     *
     * 该版本覆盖：`ChatLorebookEmbedding.buildEmbeddingDocument` 的文档构造、
     * `splitEmbeddingDocument` 的切片/重叠/尾片规则、`mergeChunkVectors` 的质心合并，
     * 以及 [LexicalFallbackChannel.analyzerVersion] 所代表的词法分析器。
     **改动以上任意一处语义都必须换这个字符串**（`SemanticIndexPolicyTest` 按字面钉死，
     * 防止有人「顺手改切片」而不触发索引重建——那会让用户拿着旧向量查新语料）。
     */
    const val CHUNK_STRATEGY_VERSION = "lorebook-embedding@doc-v1/split-char-overlap-0.15-max16-tail/centroid-l2-v1"

    /** 远程提供方的模型指纹（对齐 [ChatEmbeddingPolicy.vectorSpaceFromConfig] 的向量空间标识）。 */
    fun remoteModelFingerprint(config: ChatEmbeddingPolicy.Config): String {
        val space = ChatEmbeddingPolicy.vectorSpaceFromConfig(config)
        return buildString {
            append(space.provider).append(':').append(space.model)
            if (!space.modelId.isNullOrEmpty()) append("#id=").append(space.modelId)
            if (!space.modelVersion.isNullOrEmpty()) append("#ver=").append(space.modelVersion)
        }
    }

    /**
     * 本地模型指纹：向量空间标识 + **权重指纹**（各文件 sha256 汇总）。
     * 同名同版本但权重被替换（重打包）也必须让旧索引失效。
     */
    fun localModelFingerprint(config: ChatEmbeddingPolicy.Config, manifest: EmbeddingModelManifest): String =
        remoteModelFingerprint(config) + "#weights=" + manifest.weightsFingerprint()

    /** 构造失效键（chunk 策略版本取当前常量）。 */
    fun key(modelFingerprint: String, entityRevision: String): SemanticIndexKey =
        SemanticIndexKey(
            modelFingerprint = modelFingerprint,
            entityRevision = entityRevision,
            chunkStrategyVersion = CHUNK_STRATEGY_VERSION,
        )

    /** 三要素逐项比较：任一不同即需重建（并列出变化项）。 */
    fun canReuse(stored: SemanticIndexKey, current: SemanticIndexKey): IndexReuseDecision {
        val changed = mutableListOf<IndexKeyComponent>()
        if (stored.modelFingerprint != current.modelFingerprint) changed += IndexKeyComponent.MODEL_FINGERPRINT
        if (stored.entityRevision != current.entityRevision) changed += IndexKeyComponent.ENTITY_REVISION
        if (stored.chunkStrategyVersion != current.chunkStrategyVersion) changed += IndexKeyComponent.CHUNK_STRATEGY_VERSION
        return IndexReuseDecision(reusable = changed.isEmpty(), changed = changed)
    }
}

/** 索引/模型包的重建来源（同步目标端据此重建，而不是等对方传缓存）。 */
enum class SemanticRebuildSource {
    /** 世界书实体数据。 */
    LOREBOOK,

    /** 记忆/事实数据。 */
    MEMORY,

    /** 模型目录（模型包重新下载，不从对端拷贝）。 */
    MODEL_CATALOG,
}

/**
 * 索引与模型包的**同步边界**（总方案 §6.1/§6.2，机器可读口径）：
 * 两者都是本地派生缓存，**不进同步实体**；目标端按源数据重建。
 */
object SemanticIndexSyncPolicy {

    const val VECTOR_INDEX_SYNC_ELIGIBLE = false
    const val MODEL_PACKAGE_SYNC_ELIGIBLE = false

    enum class LocalOnlyArtifact { VECTOR_INDEX, MODEL_PACKAGE }

    /** 任何派生缓存都不可同步（防止有人把索引塞进 payload 造成跨端哈希漂移）。 */
    fun isSyncEligible(artifact: LocalOnlyArtifact): Boolean = false

    /** 目标端重建来源。 */
    fun rebuildSources(artifact: LocalOnlyArtifact): List<SemanticRebuildSource> = when (artifact) {
        LocalOnlyArtifact.VECTOR_INDEX -> listOf(SemanticRebuildSource.LOREBOOK, SemanticRebuildSource.MEMORY)
        LocalOnlyArtifact.MODEL_PACKAGE -> listOf(SemanticRebuildSource.MODEL_CATALOG)
    }

    /** 面向用户/文档的一句话口径。 */
    fun policyNote(): String =
        "语义索引与本地模型包均为本机派生缓存，不参与同步与备份主数据；" +
            "同步目标端根据世界书/记忆数据重建索引、按模型目录重新下载模型包。"
}
