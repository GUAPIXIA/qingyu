package com.qingyu.companion.data

import com.qingyu.companion.model.ServerConnection

/**
 * 启动决策快照（A-03）：纯本地只读结果，供导航状态机使用。
 * - [connections]：已配对连接列表（可能含 token 解密失败的占位项）
 * - [activeConnection]：DataStore 记录的上次活跃连接；active id 丢失/指向已删除设备时为 null
 * - [corruptedDeviceIds]：token 解密失败的连接（EncryptedPrefs 缺失，token 仍为 ENC: 占位）；
 *   只作诊断展示"需要修复连接"，绝不删数据（方案 A-03 边界）
 */
data class StartupSnapshot(
    val connections: List<ServerConnection> = emptyList(),
    val activeConnection: ServerConnection? = null,
    val corruptedDeviceIds: Set<String> = emptySet(),
)

/**
 * 启动只读快照仓库（A-03）：仅读 DataStore（[ConnectionStore.loadAll] + [ConnectionStore.getActive]），
 * 绝不等待 DNS / REST / WS——网络恢复仍由 AppContainer.start() 的异步 restore() 负责，两条路径互不阻塞。
 */
interface StartupRepository {
    suspend fun loadStartupSnapshot(): StartupSnapshot
}

class StartupRepositoryImpl(
    private val connectionStore: ConnectionStore,
) : StartupRepository {

    override suspend fun loadStartupSnapshot(): StartupSnapshot {
        val connections = connectionStore.loadAll()
        val active = connectionStore.getActive()
        // 解密失败诊断：loadAll 已尝试从 EncryptedPrefs 还原明文，仍为 ENC: 前缀即解密失败/密文丢失
        val corrupted = connections
            .filter { it.token.startsWith(ENCRYPTED_PLACEHOLDER_PREFIX) }
            .map { it.deviceId }
            .toSet()
        return StartupSnapshot(
            connections = connections,
            activeConnection = active,
            corruptedDeviceIds = corrupted,
        )
    }

    private companion object {
        const val ENCRYPTED_PLACEHOLDER_PREFIX = "ENC:"
    }
}
