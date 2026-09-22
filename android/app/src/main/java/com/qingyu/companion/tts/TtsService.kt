package com.qingyu.companion.tts

import android.content.Context
import kotlinx.coroutines.flow.StateFlow
import okhttp3.OkHttpClient
import java.io.File

/**
 * S6-03 TTS 服务装配与 UI 入口。
 *
 * 组合：系统 TTS（android.speech.tts.TextToSpeech）+ 网络 TTS（OpenAI TTS）+
 * 内容寻址音频缓存 + ExoPlayer 播放底座 + AudioFocusRequest 焦点管理，
 * 队列/状态机/焦点策略全部在 [TtsQueueController]（纯逻辑，JVM 单测覆盖）。
 *
 * 用户数据边界（与同步/备份对齐）：
 * - TTS 音频**默认只是缓存**（[TtsAudioScope.CACHE_ONLY]），不进 media manifest、不同步；
 * - 只有用户显式保存（[userSaveCandidate]）才产出 [TtsSavedAudio]，
 *   由调用方交给 media 层写入 media manifest（[TtsSavedAudio.entersMediaManifest]）。
 *
 * 凭据：网络 TTS 密钥只经 [TtsSecretSource]（本地 secret store）注入，不进日志（见 [SecretRedactor]）。
 */
class TtsService(
    private val systemBridge: SystemTtsBridge,
    private val systemEngine: SystemTtsEngine,
    private val networkEngine: TtsEngine,
    private val cache: TtsAudioCache,
    private val playback: TtsPlaybackPort,
    private val focus: AudioFocusPort,
) {

    val controller = TtsQueueController(
        engines = listOf(systemEngine, networkEngine),
        cache = cache,
        playback = playback,
        focus = focus,
    )

    /** 供 UI 收集（Compose collectAsState）。 */
    val snapshot: StateFlow<TtsControllerSnapshot> get() = controller.snapshot

    // ------------------------------------------------------------ 列表能力

    /** 语言/音色列表（系统 TTS 的语言维度 + 两引擎的音色维度）。 */
    fun voices(kind: TtsEngineKind? = null): List<TtsVoice> = when (kind) {
        TtsEngineKind.SYSTEM -> systemEngine.voices()
        TtsEngineKind.NETWORK -> networkEngine.voices()
        null -> systemEngine.voices() + networkEngine.voices()
    }

    fun languages(): List<TtsLanguage> = systemEngine.languages()

    /**
     * PC 音色配置（public metadata）解析：Windows-only 显示「不适用」，绝不按名字猜音色。
     * UI 用 [VoiceCompat.displayLabel] 取展示文案。
     */
    fun resolvePcVoice(meta: PcVoiceMetadata): VoiceResolution =
        VoiceCompat.resolve(meta, networkEngine.voices())

    // ------------------------------------------------------------ 播放控制

    fun speak(request: SpeakRequest, mode: EnqueueMode = EnqueueMode.APPEND) =
        controller.enqueue(request, mode)

    fun pause() = controller.pause()

    fun resume() = controller.resume()

    fun stop() = controller.stop()

    // ------------------------------------------------------------ 音频归属

    /**
     * 用户显式保存入口：返回缓存中该请求的音频文件。
     * 产物 [TtsSavedAudio] 的 scope 为 [TtsAudioScope.USER_SAVED]，
     * **只有这种产物才进 media manifest / 用户主数据同步**（manifest 写入由 media 层执行）。
     */
    fun userSaveCandidate(request: SpeakRequest): TtsSavedAudio? {
        val key = TtsCacheKeys.of(request)
        val path = cache.find(key) ?: return null
        return TtsSavedAudio(
            file = File(path),
            cacheKey = key,
            scope = TtsAudioPolicy.scopeFor(explicitUserSave = true),
        )
    }

    /** 默认归属：缓存音频不进 media manifest、不进用户主数据同步。 */
    fun defaultScope(): TtsAudioScope = TtsAudioPolicy.scopeFor(explicitUserSave = false)

    fun release() {
        controller.release()
        playback.stop()
        (systemBridge as? AndroidSystemTtsBridge)?.shutdown()
    }

    companion object {
        /**
         * 生产装配入口。[secretSource] 从本地 secret store 注入网络 TTS 密钥；
         * [http] 建议传 `NetworkModule.sharedStack.mediaClient()`。
         */
        fun create(
            context: Context,
            secretSource: TtsSecretSource,
            http: OkHttpClient,
            networkConfig: OpenAiTtsConfig = OpenAiTtsConfig(),
        ): TtsService {
            val bridge = AndroidSystemTtsBridge(context)
            return TtsService(
                systemBridge = bridge,
                systemEngine = SystemTtsEngine(bridge),
                networkEngine = OpenAiTtsEngine(http, secretSource, networkConfig),
                cache = FileTtsAudioCache(File(context.cacheDir, "tts")),
                playback = ExoPlayerTtsPlayback(context),
                focus = AndroidAudioFocusPort(context),
            )
        }
    }
}

/**
 * 用户显式保存的 TTS 音频（唯一允许进 media manifest 的 TTS 产物形态）。
 * toString 只输出缓存键与归属，不输出路径（诊断输出最小化）。
 */
data class TtsSavedAudio(
    val file: File,
    val cacheKey: TtsCacheKey,
    val scope: TtsAudioScope,
) {
    val entersMediaManifest: Boolean get() = TtsAudioPolicy.entersMediaManifest(scope)

    val participatesInUserSync: Boolean get() = TtsAudioPolicy.participatesInUserSync(scope)

    override fun toString(): String =
        "TtsSavedAudio(cacheKey=${cacheKey.hex.take(12)}, scope=$scope)"
}
