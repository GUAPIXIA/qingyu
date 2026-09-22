package com.qingyu.companion.tts

import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.File
import java.io.IOException

/**
 * 网络 TTS 引擎（OpenAI TTS 供应商协议，S6-03「网络 TTS：只实现当前公开供应商协议」）。
 *
 * 完整链路：请求构造（[OpenAiTtsRequestBuilder]，纯逻辑）→ 鉴权从本地 secret store 注入
 * （[TtsSecretSource]，只在内存中进请求头）→ OkHttp 异步 POST → 响应体**流式落盘**到缓存暂存
 * 文件 → 由 [TtsAudioCache.commit] 做完整性闸门 → ExoPlayer 播放落盘文件（复用播放底座）。
 *
 * 凭据纪律：apiKey 只允许出现在 `Authorization` 头；任何错误文案进 [SecretRedactor] 脱敏后
 * 才能成为 [TtsError.message]，`toString`/日志只能打印 [TtsError] 自身（不含 message）。
 */
class OpenAiTtsEngine(
    private val http: OkHttpClient,
    private val secretSource: TtsSecretSource,
    private val config: OpenAiTtsConfig = OpenAiTtsConfig(),
) : TtsEngine {

    override val kind: TtsEngineKind = TtsEngineKind.NETWORK

    override fun voices(): List<TtsVoice> = OpenAiTtsVoices.ALL

    override fun synthesize(request: SpeakRequest, targetPath: String, callback: SynthCallback) {
        // 凭据只从本地 secret store 注入；仅驻留本方法栈帧，不写任何日志字段
        val apiKey = secretSource.networkTtsApiKey()
        val built = try {
            OpenAiTtsRequestBuilder.build(config, request.text, request.voiceId, request.speed, apiKey)
        } catch (e: IllegalArgumentException) {
            callback.onResult(
                SynthResult.Failure(
                    TtsError("CONFIG", SecretRedactor.redact(e.message ?: "网络 TTS 配置非法", listOf(apiKey))),
                ),
            )
            return
        }
        val httpRequest = Request.Builder()
            .url(built.url)
            .method(built.method, built.body.toRequestBody(JSON))
            .apply { built.headers.forEach { (name, value) -> header(name, value) } }
            .build()

        http.newCall(httpRequest).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                callback.onResult(
                    SynthResult.Failure(
                        TtsError(
                            code = "NETWORK",
                            message = SecretRedactor.redact(e.message ?: "网络 TTS 请求失败", listOf(apiKey)),
                            retryable = true,
                        ),
                    ),
                )
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { resp ->
                    if (!resp.isSuccessful) {
                        val snippet = runCatching { resp.body?.string().orEmpty().take(200) }
                            .getOrDefault("")
                        val message = SecretRedactor.redact(
            snippet.ifBlank { "网络 TTS 返回 HTTP ${resp.code}" },
            listOf(apiKey),
        )
                        callback.onResult(
                            SynthResult.Failure(
                                TtsError(
                                    code = "HTTP_${resp.code}",
                                    message = message,
                                    retryable = resp.code in 500..599,
                                ),
                            ),
                        )
                        return
                    }
                    val body = resp.body
                    if (body == null) {
                        callback.onResult(
                            SynthResult.Failure(
                                TtsError("EMPTY_RESPONSE", "网络 TTS 返回空响应体", retryable = true),
                            ),
                        )
                        return
                    }
                    try {
                        // 流式落盘：边下边写，交给缓存入库闸门做完整性校验
                        File(targetPath).apply { parentFile?.mkdirs() }
                            .outputStream()
                            .use { out -> body.byteStream().copyTo(out) }
                        callback.onResult(SynthResult.Ok)
                    } catch (e: IOException) {
                        File(targetPath).delete()
                        callback.onResult(
                            SynthResult.Failure(
                                TtsError(
                                    code = "IO",
                                    message = SecretRedactor.redact(e.message ?: "音频写盘失败", listOf(apiKey)),
                                    retryable = true,
                                ),
                            ),
                        )
                    }
                }
            }
        })
    }

    private companion object {
        val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
