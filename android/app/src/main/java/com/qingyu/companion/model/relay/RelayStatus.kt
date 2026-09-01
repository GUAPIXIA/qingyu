package com.qingyu.companion.model.relay

sealed interface RelayStatus {
    data object Disconnected : RelayStatus
    data object Connecting : RelayStatus
    data class Live(val pcOnline: Boolean = true) : RelayStatus
    data class UsingCache(val cacheAgeMs: Long, val pcOnline: Boolean = false) : RelayStatus
    data object CacheExpired : RelayStatus
    data object TokenInvalidated : RelayStatus
}
