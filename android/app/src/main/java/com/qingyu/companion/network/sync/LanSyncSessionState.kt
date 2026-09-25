package com.qingyu.companion.network.sync

/**
 * LAN 授权结果的进程内登记（S7-05 → S7-07）。
 *
 * 授权完成后由 `SyncAuthViewModel` 写入；同步中心只读。
 * 不持久化 secret/会话密钥——密钥在 `LanSyncAuthClient` 会话生命周期内。
 */
object LanSyncSessionState {
    @Volatile
    var endpoint: SyncEndpoint? = null
        private set

    @Volatile
    var authorized: Boolean = false
        private set

    fun markAuthorized(endpoint: SyncEndpoint) {
        this.endpoint = endpoint
        this.authorized = true
    }

    fun clear() {
        endpoint = null
        authorized = false
    }
}
