package com.qingyu.companion.tts

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * S6-03 朗读队列 + 播放状态机 + 音频焦点策略（领域状态机，纯 Kotlin，JVM 单测直测）。
 *
 * 状态机（[TtsPlayState]）：
 * ```
 * IDLE --enqueue--> LOADING --音频就绪--> PLAYING --pause--> PAUSED --resume--> PLAYING
 *                     |                    |                  |
 *                     +--合成/校验失败---> 继续下一项或 IDLE   +--stop--> IDLE
 * ```
 * - **队列顺序**：APPEND 入队尾，当前项完成后自动推进；
 * - **打断**：INTERRUPT 清空待播队列并立即替换当前项；
 * - **缓存**：合成前先查 [TtsAudioCache]，命中直接播放（不重复合成）；
 * - **损坏音频拦截**：合成/下载产物必须过 [AudioIntegrity] 入库闸门，不过就丢弃且不播放；
 * - **音频焦点**：被抢（TRANSIENT / CAN_DUCK）→ 暂停，焦点回归 → 自动恢复；
 *   永久被抢（LOSS）→ 停止整队并**放弃恢复**，之后焦点回归也不再自动播放；
 *   用户手动暂停优先于焦点回归（不会被自动恢复覆盖）。
 *
 * 线程契约：所有公开方法与回调都 `@Synchronized`；合成/播放回调可来自任意线程，
 * 过期回调（runSeq 不匹配）一律丢弃——打断/停止后迟到的合成结果不会污染新状态。
 */
class TtsQueueController(
    engines: List<TtsEngine>,
    private val cache: TtsAudioCache,
    private val playback: TtsPlaybackPort,
    private val focus: AudioFocusPort,
) : AudioFocusListener {

    private val enginesByKind: Map<TtsEngineKind, TtsEngine> = engines.associateBy { it.kind }

    private val _snapshot = MutableStateFlow(
        TtsControllerSnapshot(TtsPlayState.IDLE, null, emptyList(), null),
    )
    val snapshot: StateFlow<TtsControllerSnapshot> = _snapshot.asStateFlow()

    private var runSeq = 0L
    private var state: TtsPlayState = TtsPlayState.IDLE
    private var current: SpeakRequest? = null
    private val pending = ArrayDeque<SpeakRequest>()
    private var loadedPath: String? = null
    private var loaded = false
    private var playbackStarted = false
    private var focusHeld = false
    private var pausedByUser = false
    private var resumeOnRegain = false
    private var lastError: TtsError? = null

    init {
        focus.setListener(this)
    }

    // ------------------------------------------------------------ 对外操作

    /** 入队朗读请求。[EnqueueMode.INTERRUPT] 打断：清空待播并立即替换当前项。 */
    @Synchronized
    fun enqueue(request: SpeakRequest, mode: EnqueueMode = EnqueueMode.APPEND) {
        when (mode) {
            EnqueueMode.INTERRUPT -> {
                pending.clear()
                dropCurrent()
                pending.addLast(request)
                startNext()
            }

            EnqueueMode.APPEND -> {
                pending.addLast(request)
                if (current == null) {
                    startNext()
                } else {
                    publish()
                }
            }
        }
    }

    /** 暂停（PLAYING / LOADING 可暂停；加载中暂停则音频就绪后也不自动播放）。 */
    @Synchronized
    fun pause() {
        if (state != TtsPlayState.PLAYING && state != TtsPlayState.LOADING) return
        pausedByUser = true
        if (state == TtsPlayState.PLAYING && playbackStarted) {
            playback.pause()
        }
        state = TtsPlayState.PAUSED
        publish()
    }

    /** 从暂停处继续。 */
    @Synchronized
    fun resume() {
        if (state != TtsPlayState.PAUSED) return
        pausedByUser = false
        resumeOnRegain = false
        resumePlayback()
    }

    /** 停止：清空队列与当前项、停播、放弃音频焦点，回到 IDLE。 */
    @Synchronized
    fun stop() {
        runSeq++
        pending.clear()
        dropCurrentInternal()
        pausedByUser = false
        resumeOnRegain = false
        lastError = null
        playback.stop()
        releaseFocusIfHeld()
        state = TtsPlayState.IDLE
        publish()
    }

    /** 释放：停止并解除焦点监听。 */
    @Synchronized
    fun release() {
        stop()
        focus.setListener(null)
    }

    // ------------------------------------------------------------ 音频焦点

    @Synchronized
    override fun onFocusChange(event: FocusEvent) {
        when (event) {
            FocusEvent.LOST_TRANSIENT, FocusEvent.LOST_CAN_DUCK -> {
                if (state == TtsPlayState.IDLE) return
                // 被抢焦点 → 暂停，等待回归恢复（鸭音也按被抢处理，避免与抢占方音频叠加）
                resumeOnRegain = true
                if (state == TtsPlayState.PLAYING && playbackStarted) {
                    playback.pause()
                }
                state = TtsPlayState.PAUSED
                publish()
            }

            FocusEvent.GAINED -> {
                if (resumeOnRegain && !pausedByUser && state == TtsPlayState.PAUSED) {
                    resumePlayback()
                }
                resumeOnRegain = false
            }

            FocusEvent.LOST_PERMANENT -> {
                // 永久被抢占：放弃恢复——整队终止，之后焦点回归也不自动续播
                resumeOnRegain = false
                if (state != TtsPlayState.IDLE) {
                    stop()
                }
            }
        }
    }

    // ------------------------------------------------------------ 内部迁移

    private fun startNext() {
        val request = pending.removeFirstOrNull()
        if (request == null) {
            dropCurrentInternal()
            releaseFocusIfHeld()
            state = TtsPlayState.IDLE
            publish()
            return
        }
        val run = ++runSeq
        current = request
        loaded = false
        loadedPath = null
        playbackStarted = false
        // lastError 保留到 stop()：单项失败后仍要能向 UI/诊断展示失败原因
        state = TtsPlayState.LOADING
        publish()
        if (!focusHeld) {
            focusHeld = focus.requestFocus()
        }

        val key = TtsCacheKeys.of(request)
        val cached = cache.find(key)
        if (cached != null) {
            // 缓存命中：不重复合成，直接进入播放路径
            onAudioReady(run, request, cached)
            return
        }
        val engine = enginesByKind[request.engine]
        if (engine == null) {
            failCurrent(run, TtsError("NO_ENGINE", "未配置 ${request.engine.wire} TTS 引擎"))
            return
        }
        val staging = cache.stagingPathFor(key)
        engine.synthesize(request, staging, object : SynthCallback {
            override fun onResult(result: SynthResult) {
                handleSynthResult(run, request, key, staging, result)
            }
        })
    }

    @Synchronized
    private fun handleSynthResult(
        run: Long,
        request: SpeakRequest,
        key: TtsCacheKey,
        staging: String,
        result: SynthResult,
    ) {
        // 过期回调（已被打断/停止）：丢弃，避免污染新一轮状态
        if (run != runSeq || current !== request) return
        when (result) {
            is SynthResult.Ok -> {
                val committed = cache.commit(key, staging)
                if (committed == null) {
                    failCurrent(
                        run,
                        TtsError("AUDIO_CORRUPT", "合成音频未通过完整性校验（损坏音频），已拦截丢弃"),
                    )
                } else {
                    onAudioReady(run, request, committed)
                }
            }

            is SynthResult.Failure -> failCurrent(run, result.error)
        }
    }

    private fun onAudioReady(run: Long, request: SpeakRequest, path: String) {
        if (run != runSeq || current !== request) return
        loaded = true
        loadedPath = path
        if (state == TtsPlayState.PAUSED) {
            // 加载期间被暂停（用户暂停或被抢焦点）：就绪但不自动播放
            publish()
            return
        }
        startPlayback(path, run)
    }

    private fun startPlayback(path: String, run: Long) {
        playback.play(path, object : TtsPlaybackListener {
            override fun onPlaybackCompleted() = handlePlaybackCompleted(run)

            override fun onPlaybackError(code: String) = handlePlaybackError(run, code)
        })
        playbackStarted = true
        state = TtsPlayState.PLAYING
        publish()
    }

    @Synchronized
    private fun handlePlaybackCompleted(run: Long) {
        if (run != runSeq) return
        dropCurrentInternal()
        startNext()
    }

    @Synchronized
    private fun handlePlaybackError(run: Long, code: String) {
        if (run != runSeq) return
        failCurrent(run, TtsError("PLAYBACK_ERROR", "音频播放失败（$code）"))
    }

    /** 单项失败不拖垮整队：记录错误并推进下一项。 */
    private fun failCurrent(run: Long, error: TtsError) {
        if (run != runSeq) return
        lastError = error
        dropCurrentInternal()
        startNext()
    }

    private fun resumePlayback() {
        when {
            playbackStarted && loaded -> {
                playback.resume()
                state = TtsPlayState.PLAYING
            }

            loaded && loadedPath != null -> startPlayback(loadedPath!!, runSeq)

            // 音频尚未就绪：回到 LOADING，就绪后自然开播
            else -> state = TtsPlayState.LOADING
        }
        publish()
    }

    private fun dropCurrent() {
        if (current != null) {
            runSeq++
            playback.stop()
        }
        dropCurrentInternal()
    }

    private fun dropCurrentInternal() {
        current = null
        loaded = false
        loadedPath = null
        playbackStarted = false
    }

    private fun releaseFocusIfHeld() {
        if (focusHeld) {
            focus.abandonFocus()
            focusHeld = false
        }
    }

    private fun publish() {
        _snapshot.value = TtsControllerSnapshot(state, current, pending.toList(), lastError)
    }
}
