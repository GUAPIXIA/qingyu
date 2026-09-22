package com.qingyu.companion.imagegen

import java.util.UUID

/**
 * 生图执行编排（S6-04 三类网络端点的统一流程）。
 *
 * 纯 JVM 可测：网络经 [ImageGenTransport] 注入，时钟/种子/客户端 ID 均可替换。
 * 生成结果统一走 [ImageResultVerifier] 下载校验，再由调用侧（主代理接线层）
 * 经 [GeneratedMediaEntityFactory] 落为 media entity 并按需绑定消息/角色。
 *
 * 安全闸门：
 * - `localhost`/`127.0.0.1` 等 loopback 端点直接阻断（[LocalhostEndpointPolicy]），提示用户改填可访问地址；
 * - 请求 URL 与 ComfyUI 图片下载 URL 必须通过 [ImageGenUrlPolicy]；
 * - 重定向安全由传输实现层按 [ImageGenUrlPolicy.checkRedirect] 拦截（见报告接线点）。
 */
class ImageGenClient(
    private val transport: ImageGenTransport,
    private val clock: ImageGenClock = SystemImageGenClock,
    private val seedProvider: () -> Long = { java.util.Random().let { it.nextLong() and 0x7fffffffL } },
    private val clientIdProvider: () -> String = { UUID.randomUUID().toString() },
) {

    /** ComfyUI 历史轮询总时限（PC 120 秒）。 */
    var historyDeadlineMs: Long = 120_000

    /** ComfyUI 历史轮询间隔（PC 500 毫秒）。 */
    var historyPollIntervalMs: Long = 500

    /** 主入口：按 provider 分派（提示词清洗规则与 PC 一致）。 */
    fun generate(
        config: ImageGenConfig,
        prompt: String,
        options: ImageGenRequestOptions = ImageGenRequestOptions(),
    ): ImageGenOutcome {
        val gate = LocalhostEndpointPolicy.evaluate(config.baseUrl)
        when (gate) {
            is LocalhostEndpointPolicy.EndpointDecision.BlockingLocalhostNotice -> {
                return ImageGenOutcome.Failure(
                    ImageGenFailure(
                        ImageGenFailureKind.CONFIG, "LOCALHOST_ENDPOINT", gate.message, false,
                    ),
                )
            }
            is LocalhostEndpointPolicy.EndpointDecision.Rejected -> {
                return ImageGenOutcome.Failure(
                    ImageGenFailure(ImageGenFailureKind.SECURITY, gate.code, gate.message, false),
                )
            }
            is LocalhostEndpointPolicy.EndpointDecision.Accepted -> Unit
        }
        return try {
            when (config) {
                is ImageGenConfig.OpenAi -> generateOpenAi(config, prompt, options)
                is ImageGenConfig.SdWebUi -> generateSdWebUi(config, prompt, options)
                is ImageGenConfig.ComfyUi -> generateComfyUi(config, prompt, options)
            }
        } catch (err: ImageGenConfigException) {
            ImageGenOutcome.Failure(
                ImageGenFailure(ImageGenFailureKind.CONFIG, "INVALID_CONFIG", err.message ?: "配置非法", false),
            )
        } catch (err: Exception) {
            ImageGenOutcome.Failure(classifyTransportException(err))
        }
    }

    /** 连接测试（与真实生成同一 adapter 与同一认证头构造）。 */
    fun testConnection(config: ImageGenConfig): ImageGenConnectionTestResult {
        return try {
            when (config) {
                is ImageGenConfig.OpenAi -> {
                    val request = OpenAiImagesProtocol.buildConnectionTestRequest(config)
                    OpenAiImagesProtocol.parseConnectionTestResponse(executeSafely(request))
                }
                is ImageGenConfig.SdWebUi -> {
                    val request = SdWebUiProtocol.buildConnectionTestRequest(config)
                    SdWebUiProtocol.parseConnectionTestResponse(executeSafely(request))
                }
                is ImageGenConfig.ComfyUi -> {
                    val request = ComfyUiProtocol.buildConnectionTestRequest(config)
                    ComfyUiProtocol.parseConnectionTestResponse(executeSafely(request))
                }
            }
        } catch (err: ImageGenConfigException) {
            ImageGenConnectionTestResult(
                success = false,
                failure = ImageGenFailure(ImageGenFailureKind.CONFIG, "INVALID_CONFIG", err.message ?: "配置非法", false),
            )
        } catch (err: Exception) {
            val failure = classifyTestException(err)
            ImageGenConnectionTestResult(success = false, failure = failure)
        }
    }

    /** 拉取 ComfyUI `/object_info`（失败不阻断配置编辑，调用侧降级渲染）。 */
    fun fetchComfyObjectInfo(baseUrl: String, apiKey: String = ""): ComfyUiProtocol.ComfyObjectInfoResult {
        return try {
            val request = ComfyUiProtocol.buildObjectInfoRequest(baseUrl, apiKey)
            ComfyUiProtocol.parseObjectInfoResponse(executeSafely(request))
        } catch (err: ImageGenConfigException) {
            ComfyUiProtocol.ComfyObjectInfoResult(
                success = false,
                failure = ImageGenFailure(ImageGenFailureKind.CONFIG, "INVALID_CONFIG", err.message ?: "配置非法", false),
            )
        } catch (err: Exception) {
            ComfyUiProtocol.ComfyObjectInfoResult(success = false, failure = classifyTransportException(err))
        }
    }

    // ===================== 各端点流程 =====================

    private fun generateOpenAi(
        config: ImageGenConfig.OpenAi,
        prompt: String,
        options: ImageGenRequestOptions,
    ): ImageGenOutcome {
        val cleaned = PromptSanitizer.sanitizeOpenAiPrompt(prompt)
        val (request, _) = OpenAiImagesProtocol.buildGenerateRequest(config, cleaned, options)
        val parsed = OpenAiImagesProtocol.parseGenerateResponse(executeSafely(request))
        return verifyImages(parsed)
    }

    private fun generateSdWebUi(
        config: ImageGenConfig.SdWebUi,
        prompt: String,
        options: ImageGenRequestOptions,
    ): ImageGenOutcome {
        val cleaned = PromptSanitizer.sanitizeSdPrompt(prompt)
        val request = SdWebUiProtocol.buildGenerateRequest(config, cleaned, options)
        val parsed = SdWebUiProtocol.parseGenerateResponse(executeSafely(request))
        return verifyImages(parsed)
    }

    private fun generateComfyUi(
        config: ImageGenConfig.ComfyUi,
        prompt: String,
        options: ImageGenRequestOptions,
    ): ImageGenOutcome {
        val cleaned = prompt.trim()
        val negativePrompt = ComfyWorkflowOverrides.resolveNegativePrompt(
            mode = config.negativePromptMode,
            preset = config.negativePromptPreset,
            requestNegative = options.negativePrompt,
        )
        val (width, height) = ImageGenSizes.parseSize(options.size ?: "512x512")
        val workflow = ComfyWorkflowOverrides.buildRunnableWorkflow(
            workflowJson = config.workflow,
            prompt = cleaned,
            negativePrompt = negativePrompt,
            bindings = config.bindings,
            overrides = config.overrides,
            width = width,
            height = height,
            seed = seedProvider(),
        )

        val queueRequest = ComfyUiProtocol.buildQueueRequest(config, workflow, clientIdProvider())
        val queued = ComfyUiProtocol.parseQueueResponse(executeSafely(queueRequest))
        val promptId = when (queued) {
            is ComfyUiProtocol.QueueState.Failed -> return ImageGenOutcome.Failure(queued.failure)
            is ComfyUiProtocol.QueueState.Queued -> queued.promptId
        }

        val selectedOutputs = config.bindings?.outputNodeIds ?: emptyList()
        val deadline = clock.nowMs() + historyDeadlineMs
        val images = mutableListOf<PlainImage>()
        while (clock.nowMs() < deadline) {
            val historyRequest = ComfyUiProtocol.buildHistoryRequest(config, promptId)
            val state = try {
                ComfyUiProtocol.parseHistoryResponse(executeSafely(historyRequest), promptId, selectedOutputs)
            } catch (err: Exception) {
                return ImageGenOutcome.Failure(classifyTransportException(err))
            }
            when (state) {
                is ComfyUiProtocol.HistoryState.Failed -> return ImageGenOutcome.Failure(state.failure)
                is ComfyUiProtocol.HistoryState.Completed -> {
                    for (image in state.images) {
                        val viewRequest = ComfyUiProtocol.buildViewRequest(config, image)
                        when (val parsed = ComfyUiProtocol.parseViewImage(executeSafely(viewRequest))) {
                            is ParsedImages.Failure -> return ImageGenOutcome.Failure(parsed.failure)
                            is ParsedImages.Success -> images.addAll(parsed.images)
                        }
                    }
                    break
                }
                is ComfyUiProtocol.HistoryState.Pending -> clock.sleepMs(historyPollIntervalMs)
            }
        }
        if (images.isEmpty()) {
            return ImageGenOutcome.Failure(
                ImageGenFailure(
                    ImageGenFailureKind.TIMEOUT, "COMFY_TIMEOUT", "ComfyUI 生图超时（120秒）", true,
                ),
            )
        }
        return verifyImages(ParsedImages.Success(images))
    }

    // ===================== 公共步骤 =====================

    /** 生成结果统一校验（大小/哈希/MIME），失败即拒绝保存。 */
    private fun verifyImages(parsed: ParsedImages): ImageGenOutcome {
        if (parsed is ParsedImages.Failure) return ImageGenOutcome.Failure(parsed.failure)
        parsed as ParsedImages.Success
        val verified = mutableListOf<VerifiedImage>()
        for (image in parsed.images) {
            when (val result = ImageResultVerifier.verify(image.bytes, image.mimeType)) {
                is ImageResultVerifier.Result.Rejected -> return ImageGenOutcome.Failure(result.failure)
                is ImageResultVerifier.Result.Ok -> verified.add(result.image)
            }
        }
        return ImageGenOutcome.Success(verified)
    }

    private fun executeSafely(request: ImageGenHttpRequest): ImageGenHttpResponse =
        transport.execute(request)

    private fun classifyTestException(err: Throwable): ImageGenFailure {
        val failure = classifyTransportException(err)
        return if (failure.code == "TIMEOUT") {
            ImageGenFailure(
                ImageGenFailureKind.TIMEOUT, "TIMEOUT",
                "连接超时（10秒），请检查地址是否正确及服务是否已启动", true,
            )
        } else {
            failure
        }
    }
}
