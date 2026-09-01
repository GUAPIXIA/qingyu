package com.qingyu.companion.network.relay

import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

class RelayTokenProvider(initial: String? = null) {
    private val access = AtomicReference(initial)
    private val generationValue = AtomicLong(0)
    val generation: Long get() = generationValue.get()
    fun accessToken(): String? = access.get()
    fun update(value: String): Long { access.set(value); return generationValue.incrementAndGet() }
    fun invalidate() { access.set(null); generationValue.incrementAndGet() }
}
