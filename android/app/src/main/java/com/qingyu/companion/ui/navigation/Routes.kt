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

    /**
     * 阶段 3 S3-07：本地初始化/旧缓存迁移向导。
     * 首次启动或检测到旧伴侣缓存时进入，不再强制配对。
     */
    const val LOCAL_SETUP = "local_setup"

    /** 阶段 3 S3-06：模型连接档案管理（本地，不需要 PC） */
    const val CONNECTION_PROFILES = "connection_profiles"

    /** 会话列表（含连接状态栏入口） */
    const val SESSIONS = "sessions"

    /** 单聊对话页 */
    const val CHAT = "chat/{sessionId}?characterId={characterId}"

    /** 角色浏览 */
    const val CHARACTERS = "characters"

    /**
     * 阶段 5 S5-01：角色管理（新建/编辑/复制/删除/导入导出）。
     *
     * 单独一条路由而不是复用 `characters`：只读浏览页已经过实机走查，
     * 把编辑状态机塞进去会让那条已验收路径承担不必要的回归风险。
     */
    const val CHARACTER_MANAGER = "characters/manage"

    /** 角色历史会话（点击角色卡片进入） */
    const val CHARACTER_SESSIONS = "character/{characterId}/sessions?name={characterName}"

    /** 阶段 5：内容管理入口页 */
    const val CONTENT_HUB = "content/hub"

    /** 阶段 5 S5-03：预设 */
    const val PRESETS = "presets"

    /** 阶段 5 S5-04：人设 */
    const val PERSONAS = "personas"

    /** 阶段 5 S5-05：正则规则 */
    const val REGEX = "regex"

    /** 阶段 5 S5-02：世界书列表与 canonical v2 编辑器 */
    const val LOREBOOKS = "lorebooks"

    /** 阶段 5 S5-06：快捷回复（全局与角色级集合） */
    const val QUICK_REPLIES = "quick-replies"

    /**
     * 阶段 5 S5-07：用量分析（按模型/角色/日期/成败分类与清空）。
     * 与阶段 3 的只读 `USAGE` 分开：那一页是远端投影，这一页读本地权威库。
     */
    const val USAGE_INSIGHTS = "usage/insights"

    /** 阶段 5 S5-08：跨平台 Backup V3 导出/恢复 */
    const val BACKUP = "backup"

    /** 阶段 7 S7-07：同步中心（backlog / LAN / 服务器入口 / 手动同步） */
    const val SYNC_CENTER = "sync/center"

    /** 阶段 7 S7-05：局域网同步授权（扫码） */
    const val SYNC_AUTH = "sync/auth"

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
