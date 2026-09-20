package com.qingyu.companion.chatcore

import com.qingyu.companion.network.models.ModelChatRequest
import com.qingyu.companion.network.models.ModelClient
import com.qingyu.companion.network.models.ModelProvider
import com.qingyu.companion.network.models.ModelRequestHandle
import com.qingyu.companion.network.models.ModelStreamEvent
import com.qingyu.companion.network.models.adapterFor
import kotlinx.coroutines.flow.Flow
import com.qingyu.companion.network.models.ConnectionProfilePublic

/**
 * 阶段 4 S4-04：生成任务状态机使用的**模型调用抽象**。
 *
 * 为什么要这层抽象：
 * - 状态机与单聊用例必须能在**不发起真实网络请求**的前提下被完整测试
 *   （阶段 4 §3 要求覆盖空输出/只有 thought/取消/断网/供应商格式错误的相同终局分类）；
 * - 生产实现直接委托 [ModelClient]（同一 adapter、同一认证头构造）；
 * - 测试实现按脚本产出事件序列。
 *
 * 事件流向是**单向**的：调用方只消费 [ModelStreamEvent]，取消通过 [ModelRequestHandle]。
 */
interface ModelGateway {
    /** 返回事件流与可取消句柄。 */
    fun stream(
        provider: ModelProvider,
        profile: ConnectionProfilePublic,
        request: ModelChatRequest,
        apiKey: String?,
    ): Pair<Flow<ModelStreamEvent>, ModelRequestHandle>
}

/** 生产实现：委托 [ModelClient]（阶段 3 已交付的直连执行层）。 */
class ModelClientGateway(private val client: ModelClient = ModelClient()) : ModelGateway {
    override fun stream(
        provider: ModelProvider,
        profile: ConnectionProfilePublic,
        request: ModelChatRequest,
        apiKey: String?,
    ): Pair<Flow<ModelStreamEvent>, ModelRequestHandle> =
        client.streamWithHandle(adapterFor(provider, profile.allowHttp), profile, request, apiKey)
}

/**
 * 阶段 4 S4-04：模型错误 → 应用层终止原因的分类映射。
 *
 * 与 PC `observationTerminationCause` 同口径（[ChatGenerationTermination]）：
 * 供应商错误码只在这里翻译一次，状态机与 UI 都消费终止原因枚举。
 */
object ModelErrorClassifier {

    /** 把供应商错误映射为应用层终止原因。 */
    fun causeFor(error: com.qingyu.companion.network.models.ModelError): String = when (error.code) {
        ModelClientCodes.CANCELLED -> "user_cancel"
        "TIMEOUT" -> "idle_timeout"
        "DNS_FAILURE", "IO_ERROR" -> "transport_error"
        "MALFORMED_JSON", "EMPTY_RESPONSE", "PROVIDER_ERROR" -> "protocol_error"
        "CONTENT_BLOCKED" -> "provider_content_filter"
        else -> when {
            error.httpStatus == 408 -> "idle_timeout"
            error.httpStatus == 429 -> "transport_error"
            error.httpStatus != null && error.httpStatus >= 500 -> "transport_error"
            error.httpStatus != null && error.httpStatus in 400..499 -> "protocol_error"
            else -> "unknown"
        }
    }
}

/** `ModelClient` 使用的错误码字面量（集中一处，避免生产与分类器各写一份）。 */
object ModelClientCodes {
    /** 用户取消：流已结束、不发出业务错误事件，调用方用 handle.isCancelled 区分。 */
    const val CANCELLED = "CANCELLED"
}
