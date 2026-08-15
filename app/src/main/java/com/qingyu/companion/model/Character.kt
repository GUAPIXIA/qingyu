package com.qingyu.companion.model

import kotlinx.serialization.Serializable

/**
 * 角色卡（浏览用子集）。
 * 对齐 shared/types.ts 的 Character；安卓端只做浏览与切换，
 * 深度编辑字段（正则/预设绑定等）不下发。
 * 头像/封面走桥接层白名单静态路由（tavern:// 协议安卓端不可达）。
 */
@Serializable
data class Character(
    val id: String,
    val name: String,
    /** 静态路由 URL（由桥接层返回），非 base64 */
    val avatarUrl: String? = null,
    val coverUrl: String? = null,
    val description: String = "",
    val personality: String = "",
    val scenario: String = "",
    val firstMessage: String = "",
    /** 备选开场白列表（新建对话时可选，对齐 PC 端 alternateGreetings） */
    val alternateGreetings: List<String> = emptyList(),
    val tags: List<String> = emptyList(),
    val pinned: Boolean = false,
    val creator: String = "",
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    /** 翻译内容：UI 显示优先使用 */
    val translatedContent: TranslatedContent? = null,
)

@Serializable
data class TranslatedContent(
    val name: String? = null,
    val description: String? = null,
    val personality: String? = null,
    val scenario: String? = null,
    val firstMessage: String? = null,
    /** 备选开场白译文（与 alternateGreetings 数组索引对齐） */
    val alternateGreetings: List<String>? = null,
)
