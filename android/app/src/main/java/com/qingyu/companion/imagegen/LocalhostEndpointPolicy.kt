package com.qingyu.companion.imagegen

/**
 * `localhost` 配置迁移提示判定（阶段 6 S6-04；纯 JVM 可测）。
 *
 * 产品要求（重构总方案 §3.2）：ComfyUI/SD WebUI 本机地址在手机上必须换成
 * **用户配置的网络地址**——`localhost`/`127.0.0.1` 在手机上指向**手机本机**而不是电脑。
 * 因此检测到 loopback 时返回**阻断式提示**（[EndpointDecision.BlockingLocalhostNotice]），
 * 要求用户填写手机可访问的地址；**不得静默改写**成任何其它地址。
 */
object LocalhostEndpointPolicy {

    const val BLOCKING_MESSAGE_PREFIX =
        "localhost/127.0.0.1 在手机上指向手机本机（而不是电脑），无法访问电脑上的生图服务。请填写手机可访问的局域网或公网地址"

    sealed class EndpointDecision {
        /**
         * 命中 loopback：UI 必须弹阻断式提示并要求用户填写可访问地址，
         * 在用户改好之前不得保存/发起请求。判定结果不携带任何“替用户改写”的地址。
         */
        data class BlockingLocalhostNotice(
            val host: String,
            val message: String = "$BLOCKING_MESSAGE_PREFIX（当前配置：$host）",
        ) : EndpointDecision()

        /** 地址可用：返回归一化（去尾斜杠）后的 base URL。 */
        data class Accepted(val normalizedBaseUrl: String) : EndpointDecision()

        /** 地址非法（非 http(s)、userinfo、元数据地址等）：直接拒绝。 */
        data class Rejected(val code: String, val message: String) : EndpointDecision()
    }

    /** 配置保存/迁移入口调用的判定。 */
    fun evaluate(rawBaseUrl: String): EndpointDecision {
        val urlDecision = ImageGenUrlPolicy.checkBaseUrl(rawBaseUrl)
        if (urlDecision is ImageGenUrlPolicy.UrlDecision.Blocked) {
            return EndpointDecision.Rejected(urlDecision.code, urlDecision.reason)
        }
        val normalized = (urlDecision as ImageGenUrlPolicy.UrlDecision.Allowed).normalizedUrl
        val host = ImageGenUrlPolicy.splitSchemeHost(normalized)?.host ?: ""
        if (ImageGenHosts.isLoopback(host)) {
            return EndpointDecision.BlockingLocalhostNotice(host = host.ifEmpty { rawBaseUrl.trim() })
        }
        return EndpointDecision.Accepted(normalized)
    }
}
