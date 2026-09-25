package com.qingyu.companion.network.sync

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * QR 注入通道（联调/自动化用）。
 *
 * 生产路径是扫码；自动化用 `adb shell am start --es sync_qr '<json>'` 经
 * MainActivity 写入本总线，SyncAuth 页消费后走与扫码完全相同的 [onQrScanned] 路径。
 * 仅内存，不落盘、不记 secret。
 */
object SyncQrInject {
    private val _pending = MutableStateFlow<String?>(null)
    val pending: StateFlow<String?> = _pending.asStateFlow()

    fun submit(rawQr: String) {
        if (rawQr.isNotBlank()) _pending.value = rawQr.trim()
    }

    /** 取走并清空（一次性） */
    fun consume(): String? {
        val v = _pending.value
        _pending.value = null
        return v
    }
}
