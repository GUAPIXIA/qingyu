package com.qingyu.companion.mcp

/**
 * MCP 平台策略（阶段 6 §S6-06、总方案 §3.2、parity matrix `mcp.stdioOnly` = pc_only_confirmed）。
 *
 * - stdio MCP：**配置可见性保留**，但 `platformSupport=pc_only`，Android 绝不启动本地进程；
 * - 远程 Streamable HTTP / SSE：platformSupport=same，Android 正常连接。
 *
 * 注意：本文件及整个 mcp 包不允许出现任何进程启动 API（进程构建器、系统运行时的执行入口等），
 * `StdioNoProcessPathTest` 会对源码做守卫扫描（守卫按字面量扫，本注释也因此不用原名书写）。
 */
enum class PlatformSupport(val marker: String) {
    /** 平台等价（same）：Android 与 PC 同协议实现。 */
    SAME("same"),

    /** 仅 PC（pc_only）：阶段 0 已确认不进手机本机，UI 明确告知。 */
    PC_ONLY("pc_only"),
}

object McpPlatformPolicy {

    /** 配置条目的平台标记：stdio → pc_only，其余 → same。 */
    fun platformSupport(transport: McpTransportKind): PlatformSupport = when (transport) {
        McpTransportKind.STDIO -> PlatformSupport.PC_ONLY
        McpTransportKind.STREAMABLE_HTTP, McpTransportKind.SSE -> PlatformSupport.SAME
    }

    /** 配置可见性：stdio 条目在 Android 上依旧可见（不隐藏、不回写删除/禁用，方案 §0 兼容边界）。 */
    fun isConfigVisible(transport: McpTransportKind): Boolean = true

    /** 是否允许在 Android 上连接。stdio 恒为 false（架构禁令）。 */
    fun canConnectOnAndroid(transport: McpTransportKind): Boolean =
        platformSupport(transport) == PlatformSupport.SAME

    /** stdio 条目的 UI 说明文案（明确告知而不是静默失败）。 */
    fun visibilityNote(transport: McpTransportKind): String? = when (platformSupport(transport)) {
        PlatformSupport.PC_ONLY -> "仅 PC 可用：stdio MCP 在手机上保留配置可见性，不在手机本机启动（platformSupport=pc_only）"
        PlatformSupport.SAME -> null
    }
}
