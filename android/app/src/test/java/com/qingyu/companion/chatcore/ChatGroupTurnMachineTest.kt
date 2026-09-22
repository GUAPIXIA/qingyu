package com.qingyu.companion.chatcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 阶段 6 S6-01(d)：群聊轮次调度器的表驱动状态机测试。
 *
 * 覆盖阶段 6 §3 第二条的核心语义：
 * 「生成中删除成员、切换模式、取消、部分失败不会写错角色归属」，
 * 以及 polling 接力链的全部终止条件（maxRounds / 无下一位 / 成员移出 / 用户停止 / 切换上下文）。
 *
 * 调度原语（发言计划/续排/间隔）另有跨语言 fixture（group-scheduling.json）钉住；
 * 本测试钉的是**链编排策略**（PC `sendMessage`/`sendPollingRound`/`checkPollingContinue` 胶水语义）。
 */
class ChatGroupTurnMachineTest {

    private val members = listOf("char-a", "char-b", "char-c")

    private fun config(
        chatMode: String,
        autoMode: Boolean = false,
        maxRounds: Long = 5,
        currentSpeakerIndex: Long = 0,
        speakerIntervalMs: Int = 2000,
    ) = ChatGroupTurnMachine.Config(
        chatMode = chatMode,
        autoMode = autoMode,
        maxRounds = maxRounds,
        memberIds = members,
        currentSpeakerIndex = currentSpeakerIndex,
        speakerIntervalMs = speakerIntervalMs,
    )

    private fun msg(id: String, round: Long) = ChatGroupScheduling.MessageRef(id, round)

    @Test
    fun mention模式单轮即交还用户() {
        val machine = ChatGroupTurnMachine.Machine(config("mention"), targetCharId = "char-b")
        val run = machine.begin(listOf(msg("__user__", 1)), turnRound = 1)
        assertTrue("mention 首步必须开轮", run is ChatGroupTurnMachine.Step.RunTurn)
        run as ChatGroupTurnMachine.Step.RunTurn
        assertEquals("归属锁定为目标角色", "char-b", run.turn.speakerId)
        assertEquals("AI 回复与用户消息共用同一轮（PC 口径）", 1L, run.turn.round)

        val done = machine.onTurnFinished(listOf(msg("__user__", 1), msg("char-b", 1)))
        assertTrue("单轮后必须交还用户", done is ChatGroupTurnMachine.Step.WaitUser)
        assertEquals("终局原因 turn_done", ChatGroupTurnMachine.REASON_TURN_DONE, (done as ChatGroupTurnMachine.Step.WaitUser).reason)
        assertTrue("机器进入终态", machine.snapshot().isTerminal)
    }

    @Test
    fun polling自动接力按成员顺序推进直到maxRounds() {
        val machine = ChatGroupTurnMachine.Machine(config("polling", autoMode = true, maxRounds = 3))
        val history = mutableListOf(msg("__user__", 1))

        val first = machine.begin(history, turnRound = 1)
        assertTrue(first is ChatGroupTurnMachine.Step.RunTurn)
        first as ChatGroupTurnMachine.Step.RunTurn
        assertEquals("polling 首轮按 currentSpeakerIndex 轮转", "char-a", first.turn.speakerId)
        assertEquals("与用户消息共用轮号", 1L, first.turn.round)
        // 落盘由持有者在 RunTurn 终局后执行
        history += msg("char-a", 1)

        // 第 1 次接力：a -> b
        val schedule1 = machine.onTurnFinished(history)
        assertTrue("autoMode 必须排定下一轮", schedule1 is ChatGroupTurnMachine.Step.ScheduleNext)
        schedule1 as ChatGroupTurnMachine.Step.ScheduleNext
        assertEquals("下一发言者按成员顺序", "char-b", schedule1.turn.speakerId)
        assertEquals("间隔取 max(500, x||2000)", 2000L, schedule1.delayMs)

        val tick1 = machine.onChainTick(history)
        assertTrue("定时器到期必须开轮", tick1 is ChatGroupTurnMachine.Step.RunTurn)
        tick1 as ChatGroupTurnMachine.Step.RunTurn
        assertEquals("归属锁定为排定的发言者（不因后续变化改写）", "char-b", tick1.turn.speakerId)
        assertEquals("接力轮在触发时开新轮（max+1）", 2L, tick1.turn.round)
        history += msg("char-b", 2)

        // 第 2 次接力：b -> c（轮转索引推进）
        val schedule2 = machine.onTurnFinished(history)
        schedule2 as ChatGroupTurnMachine.Step.ScheduleNext
        assertEquals("char-c", schedule2.turn.speakerId)
        assertEquals("轮转索引只随接力推进", 2L, machine.snapshot().currentSpeakerIndex)

        val tick2 = machine.onChainTick(history)
        tick2 as ChatGroupTurnMachine.Step.RunTurn
        assertEquals("char-c", tick2.turn.speakerId)
        assertEquals(3L, tick2.turn.round)
        history += msg("char-c", 3)

        // 第 3 轮后 distinct AI 轮数 = 3 = maxRounds → 停链交还用户
        val done = machine.onTurnFinished(history)
        assertTrue("达 maxRounds 必须交还用户", done is ChatGroupTurnMachine.Step.WaitUser)
        assertEquals(
            "终局原因 max_rounds 词表",
            ChatGroupTurnMachine.REASON_MAX_ROUNDS,
            (done as ChatGroupTurnMachine.Step.WaitUser).reason,
        )
        assertEquals("一条链共 3 轮", 3, machine.snapshot().turnsRun)
    }

    @Test
    fun polling非autoMode单轮且轮转索引不推进() {
        val machine = ChatGroupTurnMachine.Machine(config("polling", autoMode = false))
        val run = machine.begin(listOf(msg("__user__", 1)), turnRound = 1)
        run as ChatGroupTurnMachine.Step.RunTurn
        assertEquals("char-a", run.turn.speakerId)
        val done = machine.onTurnFinished(listOf(msg("__user__", 1), msg("char-a", 1)))
        assertTrue("非 autoMode 不接力", done is ChatGroupTurnMachine.Step.WaitUser)
        assertEquals("轮转索引不推进（PC 现状）", 0L, machine.snapshot().currentSpeakerIndex)
    }

    @Test
    fun free模式一次生成即交还用户() {
        val machine = ChatGroupTurnMachine.Machine(config("free", autoMode = true))
        val run = machine.begin(listOf(msg("__user__", 1)), turnRound = 1)
        run as ChatGroupTurnMachine.Step.RunTurn
        assertEquals("free 无固定发言者", null, run.turn.speakerId)
        assertEquals("free 轮 kind", ChatGroupTurnMachine.KIND_FREE, run.turn.kind)
        val done = machine.onTurnFinished(listOf(msg("__user__", 1), msg("__free__", 1)))
        assertTrue("free 即使 autoMode 也不接力", done is ChatGroupTurnMachine.Step.WaitUser)
    }

    @Test
    fun 立即接话是一次性触发不接力() {
        val machine = ChatGroupTurnMachine.Machine(config("polling", autoMode = true, maxRounds = 5))
        // 立即接话：不经发言计划、指定成员、开新轮（PC triggerCharacterReply）
        val run = machine.beginOneShot("char-c", listOf(msg("__user__", 1)))
        run as ChatGroupTurnMachine.Step.RunTurn
        assertEquals("char-c", run.turn.speakerId)
        assertEquals("立即接话开新轮（max+1）", 2L, run.turn.round)
        val done = machine.onTurnFinished(listOf(msg("__user__", 1), msg("char-c", 2)))
        done as ChatGroupTurnMachine.Step.WaitUser
        assertEquals("一次性触发终局 one_shot_done", ChatGroupTurnMachine.REASON_ONE_SHOT_DONE, done.reason)
    }

    @Test
    fun 立即接话的发言者必须是成员() {
        val machine = ChatGroupTurnMachine.Machine(config("free"))
        val step = machine.beginOneShot("char-gone", listOf(msg("__user__", 1)))
        step as ChatGroupTurnMachine.Step.Rejected
        assertEquals("非成员必须拒绝", "speaker_missing", step.reason)
    }

    @Test
    fun 部分失败不回滚归属且接力链继续() {
        val machine = ChatGroupTurnMachine.Machine(config("polling", autoMode = true, maxRounds = 5))
        val history = mutableListOf(msg("__user__", 1))
        machine.begin(history, turnRound = 1) as ChatGroupTurnMachine.Step.RunTurn
        history += msg("char-a", 1)

        // 首轮失败（persisted=false）：归属不变、链继续（PC NEW-M12 onChainContinue）
        val afterFailure = machine.onTurnFinished(history, persisted = false)
        assertTrue("失败后链必须继续", afterFailure is ChatGroupTurnMachine.Step.ScheduleNext)
        afterFailure as ChatGroupTurnMachine.Step.ScheduleNext
        assertEquals("失败轮的排定归属仍按成员顺序（不写错归属）", "char-b", afterFailure.turn.speakerId)
    }

    @Test
    fun 生成中删除成员不改写已开轮归属且接力在下一步停止() {
        val machine = ChatGroupTurnMachine.Machine(config("polling", autoMode = true, maxRounds = 5))
        val history = mutableListOf(msg("__user__", 1))
        val run = machine.begin(history, turnRound = 1)
        run as ChatGroupTurnMachine.Step.RunTurn
        assertEquals("char-a", run.turn.speakerId)
        // 模拟：char-a 生成中被移出成员表（消息仍归属 char-a——由持有者按锁定归属落盘）
        history += msg("char-a", 1)

        // 续排用**新鲜**成员表判定（PC checkPollingContinue 读最新 currentGroup）：
        // char-a 不在表中 → 停链；已开轮归属不受影响
        val afterRemoval = config("polling", autoMode = true, maxRounds = 5)
            .copy(memberIds = listOf("char-b", "char-c"))
        val done = machine.onTurnFinished(history, currentConfig = afterRemoval)
        assertTrue("发言者已不在成员表必须停链", done is ChatGroupTurnMachine.Step.WaitUser)
        assertEquals(
            "终局原因 speaker_not_member",
            ChatGroupTurnMachine.REASON_SPEAKER_NOT_MEMBER,
            (done as ChatGroupTurnMachine.Step.WaitUser).reason,
        )
        assertEquals("已开轮归属保持锁定", "char-a", run.turn.speakerId)
    }

    @Test
    fun 生成中切换模式在下一步停止接力() {
        val machine = ChatGroupTurnMachine.Machine(config("polling", autoMode = true, maxRounds = 5))
        val history = mutableListOf(msg("__user__", 1))
        machine.begin(history, turnRound = 1) as ChatGroupTurnMachine.Step.RunTurn
        history += msg("char-a", 1)

        // 模式切到 free：续排判定读新鲜配置 → 不接力（PC onComplete 用最新 chatMode）
        val switched = config("free", autoMode = true, maxRounds = 5)
        val done = machine.onTurnFinished(history, currentConfig = switched)
        assertTrue("切换模式后不得再接力", done is ChatGroupTurnMachine.Step.WaitUser)
    }

    @Test
    fun 取消与切换上下文停链且迟到终局幂等() {
        val machine = ChatGroupTurnMachine.Machine(config("polling", autoMode = true, maxRounds = 5))
        machine.begin(listOf(msg("__user__", 1)), turnRound = 1)

        // 用户取消：RUNNING 中也立即停链（持有者同时取消生成协程）
        assertTrue(machine.cancel() is ChatGroupTurnMachine.Step.Stopped)
        assertEquals(ChatGroupTurnMachine.STATE_STOPPED, machine.snapshot().state)
        // 迟到的终局/定时器事件一律幂等忽略（不二次落盘、不复活链）
        assertTrue(machine.onTurnFinished(listOf(msg("__user__", 1))) is ChatGroupTurnMachine.Step.Stopped)
        assertTrue(machine.onChainTick(listOf(msg("__user__", 1))) is ChatGroupTurnMachine.Step.Stopped)
        assertTrue(machine.cancel() is ChatGroupTurnMachine.Step.Stopped)
    }

    @Test
    fun 切换群或配置变更停链() {
        val machine = ChatGroupTurnMachine.Machine(config("polling", autoMode = true, maxRounds = 5))
        machine.begin(listOf(msg("__user__", 1)), turnRound = 1)
        assertTrue(machine.onGroupChanged() is ChatGroupTurnMachine.Step.Stopped)
        assertEquals("stopped", machine.snapshot().state)
    }

    @Test
    fun 发言计划被拒绝时不开轮() {
        val empty = ChatGroupTurnMachine.Machine(
            ChatGroupTurnMachine.Config(chatMode = "polling", memberIds = emptyList()),
        )
        val step = empty.begin(emptyList(), turnRound = 1)
        assertTrue("空成员表必须拒绝", step is ChatGroupTurnMachine.Step.Rejected)
        step as ChatGroupTurnMachine.Step.Rejected
        assertEquals("no_speaker", step.reason)
        assertEquals("链未启动", 0, empty.snapshot().turnsRun)

        val missing = ChatGroupTurnMachine.Machine(
            config("mention"),
            targetCharId = "char-gone",
            knownCharacterIds = members,
        )
        val step2 = missing.begin(listOf(msg("__user__", 1)), turnRound = 1)
        step2 as ChatGroupTurnMachine.Step.Rejected
        assertEquals("目标角色已删除必须报 speaker_missing", "speaker_missing", step2.reason)
    }

    @Test
    fun 同一条链不可二次begin() {
        val machine = ChatGroupTurnMachine.Machine(config("mention"), targetCharId = "char-a")
        machine.begin(listOf(msg("__user__", 1)), turnRound = 1)
        assertTrue("运行中的链拒绝二次 begin", machine.begin(listOf(msg("__user__", 1)), turnRound = 1) is ChatGroupTurnMachine.Step.Stopped)
    }
}
