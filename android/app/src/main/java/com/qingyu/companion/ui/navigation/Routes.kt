package com.qingyu.companion.ui.navigation

import android.net.Uri

/**
 * 导航路由（对应方案 §3.1 功能范围）。
 * 未配对时落在 pairing；配对后默认进 sessions。
 */
object Routes {
    /** 启动决策页（A-03）：只读本地快照分发，已配对用户直达会话，不再闪现配对页 */
    const val STARTUP = "startup"

    /**
     * 主区容器（E-01 MainShell，§16.1 useMainShell）：内嵌 NavHost 承载
     * SESSIONS / CHARACTERS / GROUPS 三栏切换；聊天详情、设置等仍为全屏路由。
     * flag 关闭时回退旧路径：直接落 SESSIONS。
     */
    const val MAIN_SHELL = "main_shell"

    /** 扫码/手动输 IP 配对、多 PC 管理 */
    const val PAIRING = "pairing"

    /** 有已配对连接但无有效 active（或需修复连接）时的设备选择页（A-03） */
    const val CONNECTION_PICKER = "connection_picker"

    /** 会话列表（含连接状态栏入口） */
    const val SESSIONS = "sessions"

    /** 单聊对话页 */
    const val CHAT = "chat/{sessionId}?characterId={characterId}"

    /** 角色浏览 */
    const val CHARACTERS = "characters"

    /** 角色历史会话（点击角色卡片进入） */
    const val CHARACTER_SESSIONS = "character/{characterId}/sessions?name={characterName}"

    /** 设置页（退出时清除 / 清缓存 / 内网穿透指引 / 关于） */
    const val SETTINGS = "settings"

    /** 用量统计（阶段三只读） */
    const val USAGE = "usage"

    /** 公告（阶段三同步） */
    const val ANNOUNCEMENTS = "announcements"

    /** 群聊列表（阶段二） */
    const val GROUPS = "groups"

    /** 群聊消息页 */
    const val GROUP_CHAT = "group/{groupId}/chat/{sessionId}?name={groupName}"

    fun chat(sessionId: String, characterId: String): String =
        "chat/${Uri.encode(sessionId)}?characterId=${Uri.encode(characterId)}"

    fun characterSessions(characterId: String, characterName: String): String =
        "character/$characterId/sessions?name=$characterName"

    fun groupChat(groupId: String, groupName: String, sessionId: String): String =
        "group/$groupId/chat/$sessionId?name=$groupName"
}
