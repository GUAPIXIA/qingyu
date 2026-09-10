package com.qingyu.companion.model

/**
 * 消息显示身份的跨端兼容规则。显式合法 speakerKind 优先；旧消息或未知值安全回退。
 * role/characterId 继续只负责消息方向与操作权限。
 */
object MessageIdentity {
    const val PERSONA = "persona"
    const val NARRATOR = "narrator"
    const val CHARACTER = "character"
    const val SYSTEM = "system"

    private val validSpeakerKinds = setOf(PERSONA, NARRATOR, CHARACTER, SYSTEM)

    fun resolveSpeakerKind(
        speakerKind: String?,
        role: Role? = null,
        characterId: String? = null,
        narrativeMode: String? = null,
    ): String {
        if (speakerKind in validSpeakerKinds) return speakerKind!!
        if (role == Role.system) return SYSTEM
        val isUser = role == Role.user || characterId == "__user__"
        if (isUser) return if (narrativeMode == "omniscient") NARRATOR else PERSONA
        return CHARACTER
    }
}
