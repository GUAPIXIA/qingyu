package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 4 S4-05：长记忆总结的**触发决策**与**请求构造**的单元测试。
 *
 * 这一层没有 IO，但决定「要不要花一次模型调用」以及「这次调用发了什么」：
 * 判定顺序错一次，两端就会在同一会话上产生不同的记忆版本；
 * 提示词文本不一致，两端会从同一段对话得出不同摘要。
 *
 * 跨语言文本一致性由 fixture `memory-summary` 锁定；本文件负责**语义边界**：
 * 判定顺序、退避公式、证据定位、超长消息裁剪。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ChatMemorySummaryPolicyTest {

    private fun input(
        memoryEnabled: Boolean = true,
        memoryMode: String = "auto",
        interval: Int = 10,
        automatic: Boolean = true,
        messageCount: Int = 20,
        cursorIndex: Int? = null,
        memoryVersion: Long = 0,
        retryAfter: Long? = null,
    ): ChatMemorySummaryPolicy.Input {
        val ids = (0 until messageCount).map { "m$it" }
        return ChatMemorySummaryPolicy.Input(
            memoryEnabled = memoryEnabled,
            memoryMode = memoryMode,
            autoMemoryInterval = interval,
            automatic = automatic,
            messageIds = ids,
            cursorMessageId = cursorIndex?.let { ids[it] },
            memoryVersion = memoryVersion,
            factRetryAfterVersion = retryAfter,
        )
    }

    @Test
    fun disabledMemoryWinsOverEveryOtherReason() {
        // 判定顺序：记忆关闭必须优先于「手动模式」与「条数不足」
        val decision = ChatMemorySummaryPolicy.decideBeforeWindow(
            input(memoryEnabled = false, memoryMode = "manual", messageCount = 1),
        )
        assertFalse(decision.shouldSummarize)
        assertEquals(ChatMemorySummaryPolicy.REASON_MEMORY_DISABLED, decision.reason)
    }

    @Test
    fun manualModeSkipsAutomaticButAllowsManual() {
        val auto = ChatMemorySummaryPolicy.decideBeforeWindow(input(memoryMode = "manual", automatic = true))
        assertFalse(auto.shouldSummarize)
        assertEquals(ChatMemorySummaryPolicy.REASON_MANUAL_MODE, auto.reason)

        // 手动触发不受模式限制，只受最小条数约束
        val manual = ChatMemorySummaryPolicy.decideBeforeWindow(
            input(memoryMode = "manual", automatic = false, messageCount = 10),
        )
        assertTrue(manual.shouldSummarize)
    }

    @Test
    fun thresholdUsesIntervalForAutomaticAndMinimumForManual() {
        // 自动：间隔 10，待总结 9 → 未达
        val auto9 = ChatMemorySummaryPolicy.decideBeforeWindow(input(interval = 10, messageCount = 9))
        assertFalse(auto9.shouldSummarize)
        assertEquals(ChatMemorySummaryPolicy.REASON_INTERVAL_NOT_REACHED, auto9.reason)
        assertEquals(10, auto9.threshold)

        // 自动：间隔 10，待总结 10 → 触发
        assertTrue(ChatMemorySummaryPolicy.decideBeforeWindow(input(interval = 10, messageCount = 10)).shouldSummarize)

        // 手动：最小 4 条，3 条 → 不足
        val manual3 = ChatMemorySummaryPolicy.decideBeforeWindow(
            input(automatic = false, messageCount = 3),
        )
        assertFalse(manual3.shouldSummarize)
        assertEquals(ChatMemorySummaryPolicy.REASON_INSUFFICIENT_MESSAGES, manual3.reason)
        assertEquals(ChatMemorySummaryPolicy.MEMORY_SUMMARY_MIN, manual3.threshold)

        // 自动：间隔配置为 0 → 回退默认 10（而不是「每次都触发」）
        val zeroInterval = ChatMemorySummaryPolicy.decideBeforeWindow(input(interval = 0, messageCount = 5))
        assertFalse(zeroInterval.shouldSummarize)
        assertEquals(ChatMemorySummaryPolicy.DEFAULT_AUTO_MEMORY_INTERVAL, zeroInterval.threshold)
    }

    @Test
    fun cursorNarrowsPendingCount() {
        // 未总结 6 条：游标在第 3 条上
        val withCursor = ChatMemorySummaryPolicy.decideBeforeWindow(input(interval = 5, messageCount = 10, cursorIndex = 3))
        assertEquals("待总结条数 = 总数 - 游标位置 - 1", 6, withCursor.pendingCount)
        assertTrue(withCursor.shouldSummarize)

        // 游标在最后一条 → 无待总结内容
        val atEnd = ChatMemorySummaryPolicy.decideBeforeWindow(input(interval = 5, messageCount = 10, cursorIndex = 9))
        assertEquals(0, atEnd.pendingCount)
        assertFalse(atEnd.shouldSummarize)

        // 游标 id 已不存在（历史被编辑/删除）→ 视为全部未总结，而不是静默跳过
        val missing = ChatMemorySummaryPolicy.Input(
            memoryEnabled = true,
            memoryMode = "auto",
            autoMemoryInterval = 5,
            automatic = true,
            messageIds = listOf("a", "b", "c", "d", "e", "f"),
            cursorMessageId = "已被删除的消息",
            memoryVersion = 3,
            factRetryAfterVersion = null,
        )
        assertEquals(6, ChatMemorySummaryPolicy.decideBeforeWindow(missing).pendingCount)
    }

    @Test
    fun factProposalBackoffFollowsPcFormula() {
        // 前两次失败不做退避
        assertTrue(ChatMemorySummaryPolicy.shouldAttemptFactProposal(5, null))
        assertTrue(ChatMemorySummaryPolicy.shouldAttemptFactProposal(5, 5))
        assertFalse("重试版本未到则不再尝试", ChatMemorySummaryPolicy.shouldAttemptFactProposal(5, 6))

        assertEquals(1 to 10L, ChatMemorySummaryPolicy.factFailureState(null, 10))
        assertEquals(2 to 10L, ChatMemorySummaryPolicy.factFailureState(1, 10))
        // 第 3 次失败起指数退避：nextVersion + 2^(n-2)，n = 失败计数
        assertEquals(3 to 12L, ChatMemorySummaryPolicy.factFailureState(2, 10))
        assertEquals(4 to 14L, ChatMemorySummaryPolicy.factFailureState(3, 10))
        assertEquals(5 to 18L, ChatMemorySummaryPolicy.factFailureState(4, 10))
        assertEquals(6 to 26L, ChatMemorySummaryPolicy.factFailureState(5, 10))
    }

    @Test
    fun systemPromptSwitchesProposalSectionOnBackoff() {
        val attempt = ChatMemorySummaryPolicy.buildSystemPrompt(
            ChatMemorySummaryPolicy.PromptInput(
                characterName = "苏晚",
                userName = "旅人",
                previousState = "深夜的书店",
                previousMemory = "她送走最后一位客人。",
                previousFacts = "苏晚的职业：书店店主",
                shouldAttemptFactProposal = true,
            ),
        )
        assertTrue("必须给出提案 JSON 格式", attempt.contains("【事实提案】"))
        assertTrue(attempt.contains("\"changeType\":\"set\""))
        assertTrue("必须包含角色与用户名", attempt.contains("苏晚") && attempt.contains("旅人"))
        assertTrue("必须注入旧状态与旧事实", attempt.contains("深夜的书店") && attempt.contains("书店店主"))

        val backoff = ChatMemorySummaryPolicy.buildSystemPrompt(
            ChatMemorySummaryPolicy.PromptInput(
                characterName = "苏晚",
                userName = "旅人",
                previousState = "",
                previousMemory = "",
                previousFacts = "",
                shouldAttemptFactProposal = false,
            ),
        )
        assertTrue("退避期必须明确禁止输出提案", backoff.contains("不要输出【事实提案】"))
        assertFalse("退避期不得再给格式", backoff.contains("\"changeType\""))
        assertTrue("空旧值必须显示为「无」", backoff.contains("无"))
    }

    @Test
    fun userContentSeparatesOverlapFromNewDialogue() {
        val withOverlap = ChatMemorySummaryPolicy.buildUserContent(
            overlapTexts = listOf("旅人: 旧一", "苏晚: 旧二"),
            selectedTexts = listOf("旅人: 新一"),
        )
        assertTrue(withOverlap.startsWith("【已总结内容，仅作衔接】"))
        assertTrue(withOverlap.contains("【待总结的新对话】\n旅人: 新一"))

        // 无重叠时不产生空的衔接段（否则会误导模型把空段当已总结内容）
        val noOverlap = ChatMemorySummaryPolicy.buildUserContent(
            overlapTexts = emptyList(),
            selectedTexts = listOf("旅人: 新一"),
        )
        assertFalse(noOverlap.contains("【已总结内容，仅作衔接】"))
        assertTrue(noOverlap.startsWith("【待总结的新对话】"))
    }

    @Test
    fun singleOversizedMessageIsTrimmedToBudget() {
        val long = "很长的一句话。".repeat(200)
        val trimmed = ChatMemorySummaryPolicy.buildUserContent(
            overlapTexts = emptyList(),
            selectedTexts = listOf(long),
            singleMessageBudget = 50,
            estimateTokens = { ChatTokenCounter.estimateTokens(it, "gpt-4o-mini") },
        )
        assertTrue("超长单条消息必须被裁剪", trimmed.length < long.length)
        assertTrue(trimmed.contains(ChatMemoryWindow.OVERSIZED_MARKER))

        // 多条时不裁剪单条（窗口构建已保证整体在预算内）
        val multi = ChatMemorySummaryPolicy.buildUserContent(
            overlapTexts = emptyList(),
            selectedTexts = listOf(long, "短句"),
            singleMessageBudget = 50,
            estimateTokens = { ChatTokenCounter.estimateTokens(it, "gpt-4o-mini") },
        )
        assertTrue(multi.contains(long))
    }

    @Test
    fun evidenceSearchPrefersLatestMatchingMessage() {
        val proposal = ChatMemoryFacts.FactProposal(
            subject = "苏晚",
            predicate = "职业",
            value = "书店店主",
            changeType = "set",
        )
        val found = ChatMemorySummaryPolicy.findEvidenceMessageId(
            proposal = proposal,
            selectedContentsReversed = listOf(
                "m9" to "她说自己是书店店主。",
                "m3" to "苏晚：书店店主。",
            ),
            fallbackMessageId = "m5",
        )
        assertEquals("从后往前第一条命中的消息", "m9", found)

        val notFound = ChatMemorySummaryPolicy.findEvidenceMessageId(
            proposal = proposal,
            selectedContentsReversed = listOf("m9" to "无关内容"),
            fallbackMessageId = "m5",
        )
        assertEquals("找不到证据时退回游标", "m5", notFound)

        // 过短的检索词（<2 字）不参与匹配，避免「苏」这种单字到处命中
        val shortNeedle = ChatMemoryFacts.FactProposal(
            subject = "苏",
            predicate = "p",
            value = "好",
            changeType = "set",
        )
        assertEquals(
            "m5",
            ChatMemorySummaryPolicy.findEvidenceMessageId(
                proposal = shortNeedle,
                selectedContentsReversed = listOf("m9" to "苏好"),
                fallbackMessageId = "m5",
            ),
        )
    }

    @Test
    fun proposalScopeIsFilledFromSubjectIdentity() {
        val sessionId = "s1"
        val asCharacter = ChatMemorySummaryPolicy.scopeProposal(
            proposal = ChatMemoryFacts.FactProposal("苏晚", "职业", "书店店主", "set"),
            sessionId = sessionId,
            characterId = "c1",
            characterName = "苏晚",
            userName = "旅人",
        )
        assertEquals("session:s1", asCharacter.scope)
        assertEquals("c1", asCharacter.entityId)

        val asUser = ChatMemorySummaryPolicy.scopeProposal(
            proposal = ChatMemoryFacts.FactProposal("旅人", "身份", "常客", "set"),
            sessionId = sessionId,
            characterId = "c1",
            characterName = "苏晚",
            userName = "旅人",
        )
        assertEquals("__user__", asUser.entityId)

        // 大小写与空白不敏感；第三方主体不指定实体
        val thirdParty = ChatMemorySummaryPolicy.scopeProposal(
            proposal = ChatMemoryFacts.FactProposal(" 陌生商人 ", "身份", "货郎", "set"),
            sessionId = sessionId,
            characterId = "c1",
            characterName = "苏晚",
            userName = "旅人",
        )
        assertEquals(null, thirdParty.entityId)
        assertEquals("session:s1", thirdParty.scope)
    }
}
