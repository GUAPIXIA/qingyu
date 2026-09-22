package com.qingyu.companion.imagegen

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.net.URLEncoder

/**
 * ComfyUI 端点协议（PC `comfyuiGenerate` / `fetchComfyObjectInfo` / `testImageGenConnection` 等价）。
 *
 * 流程：`POST /prompt` 入队 → 轮询 `GET /history/{promptId}` → `GET /view` 下载图片。
 * 鉴权：同时兼容常见反向代理 Bearer 鉴权与 Comfy Cloud 的 `X-API-Key`（本地注入，不进日志）。
 *
 * 工作流构建见 [ComfyWorkflowOverrides.buildRunnableWorkflow]；分析见 [ComfyWorkflowAnalyzer]。
 */
object ComfyUiProtocol {

    const val QUEUE_TIMEOUT_MS: Long = 15_000
    const val HISTORY_TIMEOUT_MS: Long = 10_000
    const val VIEW_TIMEOUT_MS: Long = 30_000
    const val TEST_TIMEOUT_MS: Long = 10_000

    /** ComfyUI 历史输出的一张图片引用。 */
    data class ComfyOutputImage(
        val filename: String,
        val subfolder: String? = null,
        val type: String? = null,
    )

    /** 历史轮询的单次结果。 */
    sealed class HistoryState {
        /** 尚未完成，继续轮询。 */
        data object Pending : HistoryState()
        data class Completed(val images: List<ComfyOutputImage>) : HistoryState()
        data class Failed(val failure: ImageGenFailure) : HistoryState()
    }

    /** 入队响应解析结果。 */
    sealed class QueueState {
        data class Queued(val promptId: String) : QueueState()
        data class Failed(val failure: ImageGenFailure) : QueueState()
    }

    /** `/object_info` 拉取结果；失败不是错误路径，调用侧按 JS 类型降级渲染。 */
    data class ComfyObjectInfoResult(
        val success: Boolean,
        val objectInfo: Map<String, Any?>? = null,
        val failure: ImageGenFailure? = null,
    )

    /** ComfyUI 鉴权头：Bearer + X-API-Key 双头兼容反代与 Comfy Cloud。 */
    internal fun comfyAuth(apiKey: String): Map<String, String> {
        val key = apiKey.trim()
        return if (key.isEmpty()) {
            emptyMap()
        } else {
            mapOf("Authorization" to "Bearer $key", "X-API-Key" to key)
        }
    }

    /** 入队请求：`POST /prompt`，body `{"prompt": <工作流>, "client_id": <id>}`。 */
    fun buildQueueRequest(
        config: ImageGenConfig.ComfyUi,
        workflow: ComfyWorkflow,
        clientId: String,
    ): ImageGenHttpRequest {
        val baseUrl = requireBaseUrl(config.baseUrl)
        val body = """{"prompt":${ComfyWorkflowCodec.workflowToJson(workflow)},"client_id":"${escapeJson(clientId)}"}"""
        return ImageGenHttpRequest(
            method = "POST",
            url = "$baseUrl/prompt",
            headers = mapOf("Content-Type" to "application/json"),
            body = body,
            authHeaders = comfyAuth(config.apiKey),
            timeoutMs = QUEUE_TIMEOUT_MS,
        )
    }

    fun parseQueueResponse(response: ImageGenHttpResponse): QueueState {
        if (response.statusCode !in 200..299) {
            val snippet = response.text().take(300)
            return QueueState.Failed(
                classifyHttpStatus("COMFY", response.statusCode, "ComfyUI 入队失败 ${response.statusCode}: $snippet"),
            )
        }
        val root = try {
            parseJsonElement(response.text())
        } catch (err: Exception) {
            return QueueState.Failed(
                ImageGenFailure(ImageGenFailureKind.PROTOCOL, "MALFORMED_JSON", "ComfyUI 未返回 prompt_id", false),
            )
        }
        val obj = root as? JsonObject
        val promptId = (obj?.get("prompt_id") as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (promptId.isNullOrEmpty()) {
            val errorNode = obj?.get("error")
            val detail = when (errorNode) {
                is JsonPrimitive -> errorNode.content
                is JsonObject -> (errorNode["message"] as? JsonPrimitive)?.content
                else -> null
            }
            return QueueState.Failed(
                ImageGenFailure(
                    ImageGenFailureKind.PROTOCOL, "NO_PROMPT_ID",
                    "ComfyUI 未返回 prompt_id${if (detail != null) ": $detail" else ""}", false,
                ),
            )
        }
        return QueueState.Queued(promptId)
    }

    /** 历史查询请求：`GET /history/{promptId}`。 */
    fun buildHistoryRequest(config: ImageGenConfig.ComfyUi, promptId: String): ImageGenHttpRequest {
        val baseUrl = requireBaseUrl(config.baseUrl)
        val encoded = URLEncoder.encode(promptId, "UTF-8")
        return ImageGenHttpRequest(
            method = "GET",
            url = "$baseUrl/history/$encoded",
            authHeaders = comfyAuth(config.apiKey),
            timeoutMs = HISTORY_TIMEOUT_MS,
        )
    }

    /**
     * 历史解析（轮询体）。
     *
     * @param selectedOutputNodeIds 用户在歧义时选定的输出节点；非空时只收集其图片，其余输出忽略。
     */
    fun parseHistoryResponse(
        response: ImageGenHttpResponse,
        promptId: String,
        selectedOutputNodeIds: List<String> = emptyList(),
    ): HistoryState {
        if (response.statusCode !in 200..299) {
            return HistoryState.Failed(
                classifyHttpStatus("COMFY", response.statusCode, "ComfyUI 历史查询失败 ${response.statusCode}"),
            )
        }
        val root = try {
            parseJsonElement(response.text())
        } catch (err: Exception) {
            return HistoryState.Failed(
                ImageGenFailure(ImageGenFailureKind.PROTOCOL, "MALFORMED_JSON", "ComfyUI 历史查询返回格式异常", false),
            )
        }
        val entry = (root as? JsonObject)?.get(promptId) as? JsonObject ?: return HistoryState.Pending
        val status = entry["status"] as? JsonObject
        val statusStr = (status?.get("status_str") as? JsonPrimitive)?.content
        if (statusStr == "error") {
            return HistoryState.Failed(
                ImageGenFailure(
                    ImageGenFailureKind.PROTOCOL, "WORKFLOW_ERROR",
                    "ComfyUI 工作流执行失败，请检查节点和模型配置", false,
                ),
            )
        }
        val completed = (status?.get("completed") as? JsonPrimitive)?.content == "true"
        val outputs = entry["outputs"] as? JsonObject
        if (outputs != null) {
            val source = if (selectedOutputNodeIds.isEmpty()) {
                outputs.entries.toList()
            } else {
                outputs.entries.filter { it.key in selectedOutputNodeIds }
            }
            val images = source.flatMap { (_, output) ->
                ((output as? JsonObject)?.get("images") as? JsonArray).orEmpty().mapNotNull { item ->
                    val obj = item as? JsonObject ?: return@mapNotNull null
                    val filename = (obj["filename"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                        ?: return@mapNotNull null
                    ComfyOutputImage(
                        filename = filename,
                        subfolder = (obj["subfolder"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
                        type = (obj["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
                    )
                }
            }
            if (images.isNotEmpty()) return HistoryState.Completed(images)
            if (selectedOutputNodeIds.isNotEmpty() && completed) {
                return HistoryState.Failed(
                    ImageGenFailure(
                        ImageGenFailureKind.EMPTY_RESULT, "SELECTED_OUTPUT_EMPTY",
                        "ComfyUI 选定的输出节点（${selectedOutputNodeIds.joinToString(", ")}）未产生图片，请在工作流配置中重新选择",
                        false,
                    ),
                )
            }
        }
        if (completed) {
            return HistoryState.Failed(
                ImageGenFailure(
                    ImageGenFailureKind.EMPTY_RESULT, "NO_IMAGE_OUTPUT",
                    "ComfyUI 工作流已完成，但没有图片输出（SaveImage / PreviewImage / SaveImageAdvanced）", false,
                ),
            )
        }
        return HistoryState.Pending
    }

    /** 图片下载请求：`GET /view?filename=&subfolder=&type=`。 */
    fun buildViewRequest(config: ImageGenConfig.ComfyUi, image: ComfyOutputImage): ImageGenHttpRequest {
        val baseUrl = requireBaseUrl(config.baseUrl)
        val query = listOf(
            "filename" to image.filename,
            "subfolder" to (image.subfolder ?: ""),
            "type" to (image.type ?: "output"),
        ).joinToString("&") { (key, value) -> "$key=${URLEncoder.encode(value, "UTF-8")}" }
        return ImageGenHttpRequest(
            method = "GET",
            url = "$baseUrl/view?$query",
            authHeaders = comfyAuth(config.apiKey),
            timeoutMs = VIEW_TIMEOUT_MS,
        )
    }

    /** 图片下载响应解析：字节 + MIME（缺省 image/png）。 */
    fun parseViewImage(response: ImageGenHttpResponse): ParsedImages {
        if (response.statusCode !in 200..299) {
            return ParsedImages.Failure(
                classifyHttpStatus("COMFY", response.statusCode, "ComfyUI 图片下载失败 ${response.statusCode}"),
            )
        }
        if (response.body.isEmpty()) {
            return ParsedImages.Failure(
                ImageGenFailure(ImageGenFailureKind.EMPTY_RESULT, "EMPTY_IMAGE", "ComfyUI 图片下载失败：响应为空", false),
            )
        }
        return ParsedImages.Success(listOf(PlainImage(response.normalizedContentType() ?: "image/png", response.body)))
    }

    /** `/object_info` 请求（节点参数类型/范围/选项来源）。 */
    fun buildObjectInfoRequest(baseUrl: String, apiKey: String): ImageGenHttpRequest {
        val normalized = requireBaseUrl(baseUrl)
        return ImageGenHttpRequest(
            method = "GET",
            url = "$normalized/object_info",
            headers = mapOf("Content-Type" to "application/json"),
            authHeaders = comfyAuth(apiKey),
            timeoutMs = TEST_TIMEOUT_MS,
        )
    }

    fun parseObjectInfoResponse(response: ImageGenHttpResponse): ComfyObjectInfoResult {
        if (response.statusCode !in 200..299) {
            val snippet = response.text().take(100)
            return ComfyObjectInfoResult(
                success = false,
                failure = classifyHttpStatus("COMFY", response.statusCode, "HTTP ${response.statusCode}: $snippet"),
            )
        }
        val root = try {
            parseJsonElement(response.text())
        } catch (err: Exception) {
            return ComfyObjectInfoResult(
                success = false,
                failure = ImageGenFailure(ImageGenFailureKind.PROTOCOL, "MALFORMED_JSON", "/object_info 返回格式异常", false),
            )
        }
        if (root !is JsonObject) {
            return ComfyObjectInfoResult(
                success = false,
                failure = ImageGenFailure(ImageGenFailureKind.PROTOCOL, "MALFORMED_JSON", "/object_info 返回格式异常", false),
            )
        }
        return ComfyObjectInfoResult(success = true, objectInfo = jsonToValue(root) as Map<String, Any?>)
    }

    /** 连接测试：`GET /system_stats`。 */
    fun buildConnectionTestRequest(config: ImageGenConfig.ComfyUi): ImageGenHttpRequest {
        val baseUrl = requireBaseUrl(config.baseUrl)
        return ImageGenHttpRequest(
            method = "GET",
            url = "$baseUrl/system_stats",
            headers = mapOf("Content-Type" to "application/json"),
            authHeaders = comfyAuth(config.apiKey),
            timeoutMs = TEST_TIMEOUT_MS,
        )
    }

    fun parseConnectionTestResponse(response: ImageGenHttpResponse): ImageGenConnectionTestResult {
        if (response.statusCode !in 200..299) {
            val snippet = response.text().take(100)
            return ImageGenConnectionTestResult(
                success = false,
                failure = classifyHttpStatus("COMFY", response.statusCode, "HTTP ${response.statusCode}: $snippet"),
            )
        }
        return ImageGenConnectionTestResult(success = true, message = "连接成功，ComfyUI 服务可用")
    }
}
