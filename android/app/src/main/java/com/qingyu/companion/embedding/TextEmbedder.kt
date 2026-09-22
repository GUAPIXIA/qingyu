package com.qingyu.companion.embedding

/**
 * 阶段 6 S6-05：嵌入提供方的**统一抽象**。
 *
 * 远程（OpenAI-compatible / Ollama）与设备本地移动模型都实现 [TextEmbedder]，
 * 上层（索引构建、语义检索、事实向量检索）只面对这一个入口，
 * 因此「换了提供方 → 索引必须重建」这类规则可以集中在失效键里判定
 * （见 [SemanticIndexPolicy]），而不是散落在各调用点。
 *
 * 纯 JVM 可测：网络与文件系统全部走接口（[EmbeddingHttpTransport] /
 * [ModelPackageStore]），测试用替身，不依赖真机与外网。
 */

/** 嵌入输入的用途：查询保留最新尾部、索引文档保留开头（对齐 PC `truncateEmbeddingInput`）。 */
enum class EmbeddingInputKind {
    QUERY,
    PASSAGE,
    ;

    /** PC `inputKind` 的协议取值（'query' | 'passage'）。 */
    val protocolValue: String
        get() = when (this) {
            QUERY -> "query"
            PASSAGE -> "passage"
        }
}

/** 把一批文本变成同维度向量（顺序一一对应）。 */
interface TextEmbedder {
    /**
     * 批量嵌入。返回值必须与 [texts] 等长且顺序一致；
     * 单条失败按 [EmbeddingException] 抛出（任一批失败即整体失败，对齐 PC `embedTexts`）。
     */
    fun embed(texts: List<String>, inputKind: EmbeddingInputKind): List<List<Double>>
}

/**
 * 嵌入失败分类（远程/本地共用）。
 *
 * 分类的目的不是日志好看，而是**降级判定要知道该不该换通道**：
 * 鉴权失败换模型包也救不了，限流/网络抖动却可能下一轮就恢复——
 * 两者在 [EmbeddingTierPolicy] 里的解释文案与建议动作不同。
 */
enum class EmbeddingFailureKind(val label: String) {
    /** 嵌入服务未配置到可用（缺模型名 / baseUrl / OpenAI 兼容还缺 apiKey）。 */
    NOT_CONFIGURED("嵌入服务未配置"),

    /** 401/403：鉴权失败（key 无效或无权限）。 */
    AUTH_FAILED("鉴权失败"),

    /** 429：限流。 */
    RATE_LIMITED("请求被限流"),

    /** 传输超时（含 408/504）。 */
    TIMEOUT("请求超时"),

    /** 连接失败 / DNS / 拒绝等传输层错误。 */
    NETWORK("网络不可达"),

    /** 其余非 2xx HTTP 状态。 */
    HTTP_ERROR("嵌入服务返回错误"),

    /** 2xx 但响应体不是预期 JSON（或结构不可解析）。 */
    INVALID_RESPONSE("嵌入服务响应格式不合法"),

    /** 提供方类型与调用路径不匹配（如 local 提供方走了远程客户端）。 */
    MISCONFIGURED("嵌入服务配置错误"),
}

/** 带分类的嵌入请求失败。[detail] 面向用户/日志，**绝不包含 apiKey**。 */
class EmbeddingException(
    val kind: EmbeddingFailureKind,
    val detail: String,
    cause: Throwable? = null,
) : Exception("${kind.label}：$detail", cause)
