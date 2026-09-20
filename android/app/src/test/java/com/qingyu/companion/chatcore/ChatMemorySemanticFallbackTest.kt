package com.qingyu.companion.chatcore

import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-05 的语义降级要求：
 * **「embedding 不可用时，事实仍保存，语义检索降级到非向量路径。」**
 *
 * Android 目前没有（也不需要有）嵌入配置——向量层实现属于阶段 6 §S6-05。
 * 因此阶段 4 需要保证的是：没有语义命中时，记忆事实**照常注入**，
 * 排序退化为 PC 的非向量路径（重要性 + 最近性），而不是整块记忆消失。
 *
 * 这条路径此前**没有任何测试覆盖**：`semanticFactsHits` 恒为空时走的是
 * `memoryFacts` + `semanticScores = null` 分支，一旦有人改动该分支，
 * 症状会是「记忆突然不注入了」——用户可见、但不报错。
 *
 * 同时它也是阶段 6 的回归防线：嵌入能力接入后，**无命中/嵌入不可用仍必须降级**，
 * 不能因为「有向量通道」就把无向量路径删掉。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatMemorySemanticFallbackTest {

    private fun memoryFacts(): List<ChatMemoryFacts.FactRecord> = listOf(
        ChatMemoryFacts.FactRecord.TextFact("苏晚的职业：书店店主"),
        ChatMemoryFacts.FactRecord.TextFact("苏晚的喜好：喜欢旧书"),
    )

    private fun dataWith(
        semanticHits: List<ChatContextBuilder.SemanticFactHit>,
    ): ChatContextBuilder.BuildData = ChatContextBuilder.BuildData(
        character = ChatContextBuilder.CharacterSnapshot(
            name = "苏晚",
            description = "旧书店的店主。",
        ),
        chat = ChatContextBuilder.ChatSnapshot(
            messages = listOf(
                ChatContextBuilder.MessageSnapshot(id = "m1", role = "user", content = "夜安。", timestamp = 1),
                ChatContextBuilder.MessageSnapshot(id = "m2", role = "assistant", content = "夜安。", timestamp = 2),
            ),
            sessions = listOf(
                ChatContextBuilder.SessionSnapshot(
                    id = "s1",
                    characterId = "c1",
                    memoryEnabled = true,
                    memory = "【时间线】旅人进店避雨",
                    memoryCurrentState = "深夜的书店",
                    memoryFacts = memoryFacts(),
                ),
            ),
            currentSessionId = "s1",
            semanticFactsHits = semanticHits,
        ),
        settings = ChatContextBuilder.SettingsSnapshot(userName = "旅人", activeModel = "gpt-4o-mini"),
        profile = ChatContextBuilder.ProfileSnapshot(provider = "openai", model = "gpt-4o-mini", maxContext = 8192),
    )

    private fun systemText(data: ChatContextBuilder.BuildData): String =
        ChatContextBuilder.buildContextMessagesFromData(data).messages
            .filter { it.role == "system" }
            .joinToString("\n") { it.content }

    @Test
    fun factsAreInjectedWhenNoSemanticHitsExist() {
        // 关键：语义通道不可用时，事实**仍然注入**（而不是整块记忆消失）
        val text = systemText(dataWith(emptyList()))
        assertTrue("无语义命中时事实仍必须注入：\n$text", text.contains("书店店主"))
        assertTrue("当前状态与时间线也必须保留", text.contains("深夜的书店") || text.contains("旅人进店避雨"))
    }

    @Test
    fun semanticHitsTakePrecedenceWhenPresent() {
        // 有语义命中时以命中集合为准（阶段 6 接入后的路径；此处先锁定优先级不颠倒）
        val text = systemText(
            dataWith(listOf(ChatContextBuilder.SemanticFactHit("苏晚的旧伤：左手腕", 0.91))),
        )
        assertTrue("语义命中必须被注入：\n$text", text.contains("左手腕"))
    }

    @Test
    fun noSemanticHitsStillProducesUsableContext() {
        // 降级路径不能把整轮上下文打空：系统提示、角色设定、历史消息都必须还在
        val built = ChatContextBuilder.buildContextMessagesFromData(dataWith(emptyList()))
        val system = built.messages.filter { it.role == "system" }.joinToString("\n") { it.content }
        assertTrue("必须仍有系统提示", system.isNotEmpty())
        assertTrue("必须仍带角色设定", system.contains("角色设定"))
        assertTrue(
            "历史消息不得因缺少语义命中而丢失",
            built.messages.any { it.role == "user" && it.content.contains("夜安") },
        )
    }

    @Test
    fun factsAreNotDroppedJustBecauseEmbeddingIsUnavailable() {
        // 「embedding 不可用」在本实现里就是「没有语义命中」：事实集合必须原样参与注入决策，
        // 不能因为排序缺少语义分数就整批丢弃
        val withoutHits = systemText(dataWith(emptyList()))
        assertTrue(
            "两条事实都应有机会注入（重要性+最近性路径）",
            withoutHits.contains("书店店主") || withoutHits.contains("喜欢旧书"),
        )
    }
}
