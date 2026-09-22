package com.qingyu.companion.ui.groups

/**
 * 群／群会话补丁键（S6-01(f) 第 2 项：模式切换 UI）。
 *
 * 纯函数构造 + 白名单校验，JVM 可测。**白名单逐键校验、越界键报错而不是静默丢弃**
 * （对齐 `LocalChatRepository.applyGroupPatch`／`patchGroupSession` 契约）。
 *
 * 键归属（避免把 group 级键误塞进 session 补丁）：
 * - 群级（`ChatRepository.patchGroup`）：`name` / `chatMode` / `autoMode` / `maxRounds` /
 *   `speakerInterval` / `currentSpeakerIndex` / `presetId` / `systemPrompt` / `lorebookIds` /
 *   `defaultNarrativeMode` / `memberIds`；
 * - 会话级（`ChatRepository.patchGroupSession`）：`title` / `personaId` / `narrativeMode` /
 *   `dialogueDirectionsEnabled` / `memoryEnabled` / `memoryMode` / `autoMemoryInterval`。
 *
 * 已知口径（S6-01 报告 §3.6，登记不猜测）：任务原文称「四种叙事模式」，但数据层
 * `requireNarrativeMode` 仅接受 `""`（跟随默认）／`immersive`／`omniscient`——故模式切换 UI
 * 只暴露这两值 + 跟随默认；强行下发第四值会被数据层 `IllegalArgumentException` 拒绝。
 */
object GroupSessionPatch {

    /** 发言调度模式（mention | polling | free）。 */
    enum class ChatMode(val wire: String) {
        MENTION("mention"),
        POLLING("polling"),
        FREE("free"),
        ;

        companion object {
            fun fromWire(value: String): ChatMode? = entries.firstOrNull { it.wire == value }
        }
    }

    /** 叙事模式真值（"" = 跟随群默认／全局默认）。 */
    const val NARRATIVE_FOLLOW_DEFAULT: String = ""
    const val NARRATIVE_IMMERSIVE: String = "immersive"
    const val NARRATIVE_OMNISCIENT: String = "omniscient"
    val NARRATIVE_MODES: List<String> = listOf(NARRATIVE_IMMERSIVE, NARRATIVE_OMNISCIENT)

    /** 会话叙事模式选项（含「跟随默认」）。 */
    val SESSION_NARRATIVE_OPTIONS: List<String> = listOf(NARRATIVE_FOLLOW_DEFAULT) + NARRATIVE_MODES

    /** 记忆模式真值。 */
    const val MEMORY_MANUAL: String = "manual"
    const val MEMORY_AUTO: String = "auto"
    val MEMORY_MODES: List<String> = listOf(MEMORY_MANUAL, MEMORY_AUTO)

    /** 群级补丁白名单键。 */
    val GROUP_KEYS: Set<String> = setOf(
        "name", "chatMode", "autoMode", "maxRounds", "speakerInterval",
        "currentSpeakerIndex", "presetId", "systemPrompt", "lorebookIds",
        "defaultNarrativeMode", "memberIds",
    )

    /** 会话级补丁白名单键。 */
    val SESSION_KEYS: Set<String> = setOf(
        "title", "personaId", "narrativeMode", "dialogueDirectionsEnabled",
        "memoryEnabled", "memoryMode", "autoMemoryInterval",
    )

    /** 白名单校验：任一越界键即报错（不静默丢弃）。 */
    fun requireWhitelisted(patch: Map<String, Any?>, allowed: Set<String>) {
        for (key in patch.keys) {
            require(key in allowed) { "未知的群聊设置键：${key}" }
        }
    }

    // ---------- 群级（模式切换 / 编辑 / 成员排序） ----------

    /** 模式切换：mention | polling | free。非法值报错。 */
    fun chatModePatch(mode: String): Map<String, Any?> {
        val parsed = ChatMode.fromWire(mode) ?: throw IllegalArgumentException("参数无效：chatMode")
        return mapOf("chatMode" to parsed.wire)
    }

    /** polling 自动接力开关。 */
    fun autoModePatch(enabled: Boolean): Map<String, Any?> = mapOf("autoMode" to enabled)

    /** 每成员发言间隔（毫秒，>= 0）。 */
    fun speakerIntervalPatch(millis: Int): Map<String, Any?> {
        require(millis >= 0) { "参数无效：speakerInterval" }
        return mapOf("speakerInterval" to millis)
    }

    /** 自动接力最大轮数（>= 1）。 */
    fun maxRoundsPatch(rounds: Int): Map<String, Any?> {
        require(rounds >= 1) { "参数无效：maxRounds" }
        return mapOf("maxRounds" to rounds)
    }

    /** 群默认叙事模式（""／immersive／omniscient）。 */
    fun defaultNarrativeModePatch(mode: String): Map<String, Any?> {
        require(mode in SESSION_NARRATIVE_OPTIONS) { "参数无效：defaultNarrativeMode" }
        return mapOf("defaultNarrativeMode" to mode)
    }

    /** 群改名。 */
    fun renamePatch(name: String): Map<String, Any?> = mapOf("name" to name)

    /** 成员排序（整表覆盖 characterIds 顺序；增删走专用接口）。 */
    fun memberOrderPatch(memberIds: List<String>): Map<String, Any?> = mapOf("memberIds" to memberIds)

    // ---------- 会话级 ----------

    /** 会话叙事模式（""／immersive／omniscient）。 */
    fun narrativeModePatch(mode: String): Map<String, Any?> {
        require(mode in SESSION_NARRATIVE_OPTIONS) { "参数无效：narrativeMode" }
        return mapOf("narrativeMode" to mode)
    }

    /** 会话记忆模式（manual / auto）。 */
    fun memoryModePatch(mode: String): Map<String, Any?> {
        require(mode in MEMORY_MODES) { "参数无效：memoryMode" }
        return mapOf("memoryMode" to mode)
    }

    /** 会话记忆开关 + 模式 + 自动间隔（一次下发，全部白名单内）。 */
    fun memoryPatch(enabled: Boolean?, mode: String?, autoInterval: Int?): Map<String, Any?> {
        val patch = mutableMapOf<String, Any?>()
        if (enabled != null) patch["memoryEnabled"] = enabled
        if (mode != null) patch["memoryMode"] = memoryModePatch(mode).getValue("memoryMode")
        if (autoInterval != null) {
            require(autoInterval >= 0) { "参数无效：autoMemoryInterval" }
            patch["autoMemoryInterval"] = autoInterval
        }
        requireWhitelisted(patch, SESSION_KEYS)
        return patch
    }
}
