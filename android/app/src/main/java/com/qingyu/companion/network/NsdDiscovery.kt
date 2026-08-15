package com.qingyu.companion.network

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * mDNS/DNS-SD 局域网自动发现（方案 §5.1「锦上添花」）。
 *
 * 发现 `_qingyu._tcp` 服务（PC 桥接层开启「手机连接」时广播）。
 * 注意：部分 Android 设备省电模式下 mDNS 不可靠，主路径仍是扫码/手动输 IP，
 * 发现列表仅作便捷填充（点击填入主机/端口）。
 */
data class DiscoveredPc(
    /** PC 广播的服务名（可能为空） */
    val name: String,
    val host: String,
    val port: Int,
)

class NsdDiscovery(context: Context) {

    private val nsdManager = context.applicationContext
        .getSystemService(Context.NSD_SERVICE) as NsdManager

    private val _devices = MutableStateFlow<List<DiscoveredPc>>(emptyList())
    val devices: StateFlow<List<DiscoveredPc>> = _devices.asStateFlow()

    private var discoveryListener: NsdManager.DiscoveryListener? = null
    // M-33 修复：Android NsdManager 同一时刻仅允许一个 resolveService 在途（API<23 并发
    // 会以 FAILURE_ALREADY_ACTIVE 失败且静默不重试）——用队列串行化 resolve。
    private var resolving = false
    private val pendingResolve = ArrayDeque<NsdServiceInfo>()
    private var active = false

    fun start() {
        if (active) return
        active = true
        _devices.value = emptyList()
        discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                // L-35 修复：部分 ROM 回调的 serviceType 带尾点（_qingyu._tcp.），
                // 严格比较会整体失效——trimEnd('.') 后比较
                if (serviceInfo.serviceType.trimEnd('.') != SERVICE_TYPE) return
                resolve(serviceInfo)
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                _devices.value = _devices.value.filterNot {
                    it.name == serviceInfo.serviceName
                }
            }

            override fun onDiscoveryStopped(serviceType: String) = Unit

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                stop()
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
        }
        runCatching {
            nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
        }.onFailure { stop() }
    }

    fun stop() {
        if (!active) return
        active = false
        discoveryListener?.let { listener ->
            runCatching { nsdManager.stopServiceDiscovery(listener) }
        }
        discoveryListener = null
        _devices.value = emptyList()
    }

    /** 解析服务拿 host/port；失败则静默跳过（下轮广播仍会再发现） */
    private fun resolve(serviceInfo: NsdServiceInfo) {
        // M-33：入队 + 泵送，串行化 resolve（避免 API<23 并发 FAILURE_ALREADY_ACTIVE 丢设备）
        pendingResolve.addLast(serviceInfo)
        pumpResolve()
    }

    @Synchronized
    private fun pumpResolve() {
        if (resolving) return
        val next = pendingResolve.removeFirstOrNull() ?: return
        resolving = true
        val onSettled = {
            synchronized(this) { resolving = false }
            pumpResolve()
        }
        runCatching {
            nsdManager.resolveService(next, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = onSettled()

                override fun onServiceResolved(resolved: NsdServiceInfo) {
                    try {
                        val host = resolved.host?.hostAddress ?: return
                        val port = resolved.port
                        if (port <= 0) return
                        val pc = DiscoveredPc(
                            name = resolved.serviceName,
                            host = host,
                            port = port,
                        )
                        // 去重：同 host:port 只保留一个
                        _devices.value = (_devices.value.filterNot {
                            it.host == pc.host && it.port == pc.port
                        } + pc).sortedBy { it.name }
                    } finally {
                        onSettled()
                    }
                }
            })
        }.onFailure { onSettled() }
    }

    private companion object {
        const val SERVICE_TYPE = "_qingyu._tcp"
    }
}
