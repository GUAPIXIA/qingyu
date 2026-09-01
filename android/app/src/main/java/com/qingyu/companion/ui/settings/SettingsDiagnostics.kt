package com.qingyu.companion.ui.settings

import com.qingyu.companion.data.settings.FieldSyncState
import com.qingyu.companion.data.settings.SettingsSyncStatus
import com.qingyu.companion.network.connection.ConnectionDiagnostics
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 设置页「连接诊断」与「PC 拒绝字段」的纯投影函数（阶段 B-07 / C 行级反馈）。
 * 无 Android 依赖，JVM 单测覆盖：[SettingsDiagnosticsProjectionTest]。
 */

/** 重试倒计时（秒，向上取整；已到期返回 0）。输入均为 epoch millis。 */
fun retryCountdownSeconds(nextAttemptAt: Long, nowMs: Long): Int =
    (((nextAttemptAt - nowMs) + 999) / 1000).toInt().coerceAtLeast(0)

/** 指标层失败原因（FailureReason.name / "repair"）→ 稳定文案键（UI 再映射到 strings.xml） */
fun failureReasonKey(reason: String?): String = when (reason) {
    "NoNetwork" -> "no_network"
    "Dns" -> "dns"
    "Tcp" -> "tcp"
    "Tls" -> "tls"
    "Timeout" -> "timeout"
    "ServerStopped" -> "server_stopped"
    "WsClosed" -> "ws_closed"
    "repair" -> "repair"
    else -> "unknown"
}

/** 最近失败距今的稳定描述（复选用；age<0 视为无效） */
fun failureAgeSeconds(startedAt: Long, nowMs: Long): Long = (nowMs - startedAt) / 1000

/**
 * 「复制诊断信息」的脱敏文本（快照本身已无 token/配对码/正文/明文 host）。
 * 纯文本键值对，方便贴进 issue / 聊天窗口排查。
 */
fun formatConnectionDiagnosticsText(diagnostics: ConnectionDiagnostics, nowMs: Long): String {
    val fmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
    return buildString {
        appendLine("qingyu connection diagnostics")
        appendLine("state: ${diagnostics.stateLabel}")
        appendLine("endpointType: ${diagnostics.endpointType ?: "n/a"}")
        appendLine("securityMode: ${diagnostics.securityMode ?: "n/a"}")
        appendLine("serverId: ${diagnostics.serverId ?: "n/a"}")
        appendLine("apiVersion: ${diagnostics.apiVersion ?: "n/a"}")
        appendLine("pairingProtocolVersion: ${diagnostics.pairingProtocolVersion ?: "n/a"}")
        appendLine("lastRttMs: ${diagnostics.lastRttMs ?: "n/a"}")
        appendLine(
            "lastConnectedAt: ${diagnostics.lastConnectedAt?.let { fmt.format(Date(it)) } ?: "n/a"}",
        )
        appendLine(
            diagnostics.lastFailure?.let {
                val ageMin = failureAgeSeconds(it.startedAt, nowMs) / 60
                "lastFailure: ${it.reason} (${it.endpointType}, ${fmt.format(Date(it.startedAt))}, ${ageMin}min ago)"
            } ?: "lastFailure: none",
        )
        appendLine("recentAttempts: ${diagnostics.recentAttempts}")
        appendLine("recentResults: ${diagnostics.recentResults.joinToString(",")}")
    }
}

/**
 * rejectedFields 行级投影（阶段 C 轻量反馈）：
 * PC 在 v2 PATCH 响应里拒绝的字段，行级显示失败态并给出原因，
 * 优先级高于仓库状态（含 Synced——请求成功不代表字段被应用）。
 *
 * @param rejections 当前 PC 的 field → reason（来自 SettingsRejectionRegistry）
 * @return 该行应显示的失败原因；null = 无拒绝，走 [fieldSyncStateFor] 常规四态
 */
fun rejectionReasonFor(rejections: Map<String, String>, field: String): String? = rejections[field]

/** 综合 [fieldSyncStateFor] 与拒绝记录的行级状态（拒绝 → Failed，其余按仓库状态机） */
fun fieldSyncStateWithRejections(
    status: SettingsSyncStatus,
    field: String,
    rejections: Map<String, String>,
): FieldSyncState =
    if (rejectionReasonFor(rejections, field) != null) {
        FieldSyncState.Failed
    } else {
        com.qingyu.companion.data.settings.fieldSyncStateFor(status, field)
    }
