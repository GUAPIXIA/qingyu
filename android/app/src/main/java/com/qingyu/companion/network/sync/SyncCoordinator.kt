package com.qingyu.companion.network.sync

/**
 * 阶段 7 S7-07 / 阶段 8 S8-04：同步协调器。
 *
 * 同步中心只依赖本接口；LAN / 服务器是两个实现。
 * **只有用户点击「开始同步」才调用 [run]**——禁止任何自动触发。
 */
interface SyncCoordinator {
    enum class Target { LAN, SERVER }

    /** 当前可用目标（已授权 LAN / 已配置服务器）；空表示未配置 */
    fun availableTargets(): Set<Target>

    /**
     * 跑完整同步流。挂起直到完成/失败/取消。
     * [onProgress] 回传 phase/sent/received；返回摘要。
     */
    suspend fun run(
        target: Target,
        onProgress: (phase: String, sent: Int, received: Int) -> Unit = { _, _, _ -> },
    ): SyncRunResult

    fun cancel()
}

data class SyncRunResult(
    val ok: Boolean,
    val uploaded: Int = 0,
    val downloaded: Int = 0,
    val error: String? = null,
    val retryable: Boolean = false,
)

/**
 * 默认协调器：委托 [lanRunner] / [serverRunner]；未授权/未配置时 fail-fast（不建 session）。
 */
class DefaultSyncCoordinator(
    private val lanAuthorized: () -> Boolean,
    private val serverConfigured: () -> Boolean,
    private val lanRunner: suspend (onProgress: (String, Int, Int) -> Unit) -> SyncRunResult,
    private val serverRunner: suspend (onProgress: (String, Int, Int) -> Unit) -> SyncRunResult,
) : SyncCoordinator {

    @Volatile
    private var cancelled = false

    override fun availableTargets(): Set<SyncCoordinator.Target> {
        val out = mutableSetOf<SyncCoordinator.Target>()
        if (lanAuthorized()) out += SyncCoordinator.Target.LAN
        if (serverConfigured()) out += SyncCoordinator.Target.SERVER
        return out
    }

    override suspend fun run(
        target: SyncCoordinator.Target,
        onProgress: (String, Int, Int) -> Unit,
    ): SyncRunResult {
        cancelled = false
        if (!availableTargets().contains(target)) {
            return SyncRunResult(ok = false, error = "目标未配置或未授权：$target", retryable = false)
        }
        return try {
            when (target) {
                SyncCoordinator.Target.LAN -> lanRunner { p, s, r ->
                    if (cancelled) throw SyncCancelledException()
                    onProgress(p, s, r)
                }
                SyncCoordinator.Target.SERVER -> serverRunner { p, s, r ->
                    if (cancelled) throw SyncCancelledException()
                    onProgress(p, s, r)
                }
            }
        } catch (_: SyncCancelledException) {
            SyncRunResult(ok = false, error = "cancelled", retryable = false)
        }
    }

    override fun cancel() {
        cancelled = true
    }
}

class SyncCancelledException : Exception("sync cancelled")
