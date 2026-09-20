package com.qingyu.companion.chatcore

/**
 * 阶段 4 S4-05：嵌入/语义检索的**判定层**（对齐 PC `electron/ipc/embedding.ts`）。
 *
 * 这一层不发起网络也不落盘，但它决定「索引能不能复用、阈值取多少、
 * 检索命中怎么映射回事实文本、什么配置才算可用」——判错一处，
 * 用户看到的就是「换了模型还在用旧索引」或「语义检索永远不命中」。
 *
 * 与[ChatVector]/[ChatLorebookEmbedding] 一样是纯函数，逐字节与 PC 对齐并 fixture 锁定。
 */
object ChatEmbeddingPolicy {

    /** 自动模式下的保守通用阈值（PC `DEFAULT_SIMILARITY_THRESHOLD`）。 */
    const val DEFAULT_SIMILARITY_THRESHOLD = 0.3

    /** 远端嵌入服务的索引切片字符数（PC `REMOTE_INDEX_CHUNK_CHARS`）。 */
    const val REMOTE_INDEX_CHUNK_CHARS = 4000

    /** 本地模型 id 形态：`name@1.2.3`（可带预发布后缀）。 */
    private val LOCAL_MODEL_ID = Regex("^[a-z0-9][a-z0-9._-]{1,63}@\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$")

    data class Config(
        /** local | openai | ollama（Android 目前只可能出现远端提供方） */
        val provider: String,
        val model: String,
        val baseUrl: String? = null,
        val apiKey: String? = null,
    )

    data class VectorSpace(
        val provider: String,
        val model: String,
        val modelId: String? = null,
        val modelVersion: String? = null,
    )

    data class FactHit(val text: String, val index: Int, val score: Double)

    /**
     * 检索命中 → 事实文本。
     *
     * 命中 id 是**字符串形式的下标**（对齐索引存储格式）；越界与非数字 id 一律丢弃，
     * 而不是抛出——旧索引在事实被裁剪后必然出现越界命中。
     */
    fun mapFactSearchHits(
        hits: List<Pair<String, Double>>,
        facts: List<String>,
    ): List<FactHit> = hits.mapNotNull { (id, score) ->
        val index = id.trim().toIntOrNull() ?: return@mapNotNull null
        // JS `facts[Number(id)]`：越界 → undefined → 被 filter(Boolean) 丢弃
        val text = facts.getOrNull(index)
        if (text.isNullOrEmpty()) null else FactHit(text = text, index = index, score = score)
    }

    /**
     * 条目是否参与**语义匹配**（索引侧判定）。
     *
     * 注意与 [ChatLorebookEmbedding.isSemanticEligible] 的差别，两者不是一回事：
     * 这条只看 `priority` 与 `matchMode`（PC 的 `isSemanticEligible`），
     * 另一条还要求条目启用且正文非空（PC 的 `isLoreEntrySemanticEligible`）。
     * 混用会让「该索引的没索引」或「不该索引的进了索引」，因此两端都保留，
     * 并由注释明确各自适用场景。
     */
    fun isSemanticEligible(priority: String?, matchMode: String?): Boolean {
        if (priority == "always") return false
        val mode = matchMode ?: "both"
        return mode == "semantic" || mode == "both"
    }

    /**
     * 由配置推导向量空间。查询向量与索引必须来自同一模型，
     * 否则维度即便碰巧一致，相似度也没有意义。
     *
     * **`provider = local` 且模型串里没有 `@` 时，PC 的行为是 JS 切片的产物**：
     * `lastIndexOf('@')` 返回 -1，于是 `slice(0, -1)` 丢掉最后一个字符、
     * `slice(0)` 取整串——即 `modelId = model.dropLast(1)`、`modelVersion = model`。
     * 这看起来很怪，但它是可观测行为，两端必须一致，故此处照搬并 fixture 锁定。
     */
    fun vectorSpaceFromConfig(config: Config): VectorSpace {
        if (config.provider != "local") {
            return VectorSpace(provider = config.provider, model = config.model)
        }
        val splitAt = config.model.lastIndexOf('@')
        val modelId = if (splitAt == -1) {
            config.model.dropLast(1)
        } else {
            config.model.substring(0, splitAt)
        }
        val modelVersion = if (splitAt == -1) config.model else config.model.substring(splitAt + 1)
        return VectorSpace(
            provider = "local",
            model = config.model,
            modelId = modelId,
            modelVersion = modelVersion,
        )
    }

    /**
     * 索引是否仍可用于当前配置。
     * 模型名必须一致；两边都给了 provider 时也必须一致；
     * local 还要比较 modelId/modelVersion（同一模型的不同版本向量不可混用）。
     */
    fun isVectorIndexCompatible(
        indexModel: String,
        indexProvider: String?,
        indexModelId: String?,
        indexModelVersion: String?,
        config: Config,
    ): Boolean {
        if (indexModel.trim() != config.model.trim()) return false
        if (!indexProvider.isNullOrEmpty() && !config.provider.isEmpty() && indexProvider != config.provider) return false
        if (config.provider == "local") {
            val space = vectorSpaceFromConfig(config)
            return indexModelId == space.modelId && indexModelVersion == space.modelVersion
        }
        return true
    }

    /**
     * 语义检索阈值：显式请求优先；本地模型按已评测的校准值，未知模型用保守通用值。
     */
    fun resolveSemanticThreshold(
        config: Config,
        requested: Double?,
        localProfiles: Map<String, Double> = emptyMap(),
    ): Double {
        if (requested != null && requested.isFinite()) return requested
        if (config.provider == "local") {
            return localProfiles[config.model] ?: DEFAULT_SIMILARITY_THRESHOLD
        }
        return DEFAULT_SIMILARITY_THRESHOLD
    }

    /** 嵌入服务是否已配置到可用（远端必须有 baseUrl；OpenAI 兼容还必须有 apiKey，Ollama 不需要）。 */
    fun isEmbeddingConfigured(config: Config): Boolean {
        if (config.model.trim().isEmpty()) return false
        if (config.provider == "local") return LOCAL_MODEL_ID.matches(config.model)
        if (config.baseUrl.isNullOrBlank()) return false
        if (config.provider == "openai" && config.apiKey.isNullOrBlank()) return false
        return true
    }

    /**
     * 索引切片字符数。
     * 远端固定 [REMOTE_INDEX_CHUNK_CHARS]；本地模型在 PC 上按 manifest 的 token 数推导，
     * Android 目前只接远端嵌入服务，因此本地分支由调用方显式传入（缺省抛错，避免静默取错值）。
     */
    fun resolveIndexChunkChars(config: Config, localChunkChars: Int? = null): Int {
        if (config.provider != "local") return REMOTE_INDEX_CHUNK_CHARS
        return localChunkChars
            ?: error("本地向量模型未接入：无法推导索引切片长度（Android 目前只支持远端嵌入服务）")
    }
}
