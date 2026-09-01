package com.qingyu.companion.network.connection

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * 网络连通性事件（B-06）。语义由 [ConnectivityObserver] 产出，
 * coordinator 消费：
 * - [Available]：默认网络就绪 → 取消尚未开始的退避，立即触发一次受去重保护的探测；
 * - [Lost]：默认网络丢失 → Degraded(NoNetwork)，暂停无效重连循环；
 * - [Changed]：网络能力变化（Wi-Fi 切换/换蜂窝）→ 建立新 generation 重连。
 */
sealed interface ConnectivityEvent {
    data object Available : ConnectivityEvent
    data object Lost : ConnectivityEvent

    /** 同一网络内的能力变化（如 Wi-Fi 重关联、传输代际切换）。 */
    data class Changed(val networkId: Int) : ConnectivityEvent

    /** 网络接口发生更换（Wi-Fi ↔ 蜂窝、换 SSID）：必须建新 generation。 */
    data class Switched(val networkId: Int) : ConnectivityEvent
}

/** 抽象接口：JVM 单测用 fake 实现，真机用 [AndroidConnectivityObserver]。 */
interface ConnectivityObserver {
    val events: SharedFlow<ConnectivityEvent>
    /** 当前是否有默认可用网络（探测前置检查）。 */
    fun hasActiveNetwork(): Boolean
    fun start()
    fun stop()
}

/**
 * ConnectivityManager.registerDefaultNetworkCallback 实现（B-06）。
 * 生命周期由 Application（CompanionApp/AppContainer）管理：页面销毁不注销。
 *
 * 事件去抖：Available/Changed 在 [dedupeWindowMs] 窗口内合并（Wi-Fi 切换时系统会
 * 连发 onAvailable/onLost/onCapabilitiesChanged），避免风暴式重复探测。
 */
class AndroidConnectivityObserver(
    context: Context,
    private val dedupeWindowMs: Long = 250L,
    private val nowMs: () -> Long = System::currentTimeMillis,
) : ConnectivityObserver {

    private val connectivityManager =
        context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private val _events = MutableSharedFlow<ConnectivityEvent>(
        replay = 0,
        extraBufferCapacity = 16,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    override val events: SharedFlow<ConnectivityEvent> = _events.asSharedFlow()

    /** 最近一次“默认网络”的身份（hash of Network 对象即系统级连接标识）。 */
    @Volatile private var currentNetwork: Network? = null
    @Volatile private var lastEmittedAt = 0L

    @Volatile private var registered = false

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            val previous = currentNetwork
            currentNetwork = network
            // 已有网络时被新网络顶替（少见，default callback 语义上是"变为可用"）
            emit(ConnectivityEvent.Available, dedupe = previous != null)
        }

        override fun onLost(network: Network) {
            if (currentNetwork != network) return
            // 检查是否仍有其他默认网络（多网络并存时不误报 Lost）
            val remaining = runCatching { connectivityManager.activeNetwork }.getOrNull()
            if (remaining != null && remaining != network) {
                currentNetwork = remaining
                emit(ConnectivityEvent.Switched(remaining.hashCode()), dedupe = false)
            } else {
                currentNetwork = null
                _events.tryEmit(ConnectivityEvent.Lost)
                lastEmittedAt = nowMs()
            }
        }

        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            if (currentNetwork != null && currentNetwork != network) {
                // 默认网络易主（Wi-Fi ↔ 蜂窝）：新代次
                currentNetwork = network
                emit(ConnectivityEvent.Switched(network.hashCode()), dedupe = false)
                return
            }
            currentNetwork = network
            emit(ConnectivityEvent.Changed(network.hashCode()), dedupe = true)
        }
    }

    override fun start() {
        if (registered) return
        registered = true
        // 初始快照：若已有活跃网络，视为 Available（coordinator 启动时若错过事件可自查）
        runCatching {
            connectivityManager.activeNetwork?.also { currentNetwork = it }
        }
        runCatching {
            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            connectivityManager.registerDefaultNetworkCallback(callback)
        }.onFailure { registered = false }
    }

    override fun stop() {
        if (!registered) return
        registered = false
        runCatching { connectivityManager.unregisterNetworkCallback(callback) }
    }

    override fun hasActiveNetwork(): Boolean =
        runCatching { connectivityManager.activeNetwork != null }.getOrDefault(true)

    private fun emit(event: ConnectivityEvent, dedupe: Boolean) {
        val t = nowMs()
        if (dedupe && t - lastEmittedAt < dedupeWindowMs) return
        lastEmittedAt = t
        _events.tryEmit(event)
    }
}
