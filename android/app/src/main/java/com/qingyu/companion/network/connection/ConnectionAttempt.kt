package com.qingyu.companion.network.connection

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.atomic.AtomicLong

/**
 * 连接租约（B-05）：一次 connect/switch/disconnect 对应一个单调递增的 generation。
 * 所有异步回调（REST 探测、WS 重连计时、Coil/TTS token 提供）完成时校验
 * [ConnectionGenerators.isCurrent]，旧代次的结果不得修改新连接状态。
 */
data class ConnectionLease(
    val generation: Long,
    val deviceId: String,
    val endpoint: ConnectionEndpoint,
)

/**
 * 代次仲裁者：connect / switch / disconnectAll / remove(active) 时 [advance]，
 * 探测胜出换端点时 [restamp]（同代次内更新已验证端点）。
 *
 * 语义判断（generation + deviceId）取代此前散落的 `connection === target`
 * 对象引用比较——数据类从存储重新加载后引用不同但语义相同，引用比较会误判为"换了设备"。
 */
class ConnectionGenerators(initial: Long = 0L) {

    private val counter = AtomicLong(initial)
    private val _current = MutableStateFlow<ConnectionLease?>(null)

    /** 当前租约快照（null = 无活跃连接）。 */
    val current: StateFlow<ConnectionLease?> = _current.asStateFlow()

    /** 当前代次号；disconnect/remove 也会递增（让所有旧回调立即失效）。 */
    fun generation(): Long = counter.get()

    /**
     * 建立新代次（connect/switch/断开后重建）。返回新租约。
     * [deviceId] 可为空串（disconnectAll 场景仅用于递增计数，见 [retire]）。
     */
    fun advance(deviceId: String, endpoint: ConnectionEndpoint): ConnectionLease {
        val next = counter.incrementAndGet()
        return ConnectionLease(next, deviceId, endpoint).also { _current.value = it }
    }

    /**
     * 主动退役当前连接（disconnectAll / remove 活跃设备）：
     * 递增代次并清空租约，使一切在途回调（探测胜出、WS 重连定时器）失效。
     */
    fun retire(): Long {
        val next = counter.incrementAndGet()
        _current.value = null
        return next
    }

    /** 同代次内换端点（探测竞速胜出/回填 lastSuccessfulEndpoint），代次不变。 */
    fun restamp(lease: ConnectionLease, endpoint: ConnectionEndpoint): ConnectionLease {
        val updated = lease.copy(endpoint = endpoint)
        // 仅当代次仍是 lease.generation 时生效，避免与并发的 advance 竞争
        while (true) {
            val cur = _current.value
            if (cur == null || cur.generation != lease.generation) return updated
            if (_current.compareAndSet(cur, updated)) return updated
        }
    }

    /** 回调完成时的守卫：租约代次是否仍为当前代次。null 恒为 false。 */
    fun isCurrent(lease: ConnectionLease?): Boolean =
        lease != null && counter.get() == lease.generation && _current.value?.generation == lease.generation

    /** 语义一致性检查：当前租约是否仍指向同一设备（用于旧回调判定"我已被取代"）。 */
    fun isCurrentDevice(lease: ConnectionLease?): Boolean =
        isCurrent(lease) && _current.value?.deviceId == lease?.deviceId
}
