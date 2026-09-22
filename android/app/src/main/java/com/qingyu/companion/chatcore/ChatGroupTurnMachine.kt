package com.qingyu.companion.chatcore

/**
 * 阶段 6 S6-01(d)：**群聊轮次调度器**——领域状态机（纯 Kotlin，零 UI/协程依赖）。
 *
 * 方案 §S6-01 硬约束：「群聊调度器是领域状态机，不得放在 Compose coroutine 或 UI 循环里」。
 * 本类只做**决策**（谁发言/何时接力/何时交还用户/何时终止），不做 IO、不起定时器：
 * 定时器、生成、落盘由持有者（LocalGroupGenerationUseCase）执行。
 *
 * 语义逐条镜像 PC（`useGroupChatStore.sendMessage` + `groupStreamController.checkPollingContinue`）：
 * - mention/polling 单角色轮（polling 忽略显式目标、按 currentSpeakerIndex 轮转）；free 一次生成；
 * - polling **且 autoMode** 才接力：按 [ChatGroupScheduling.planGroupPollingContinue] 排下一位，
 *   间隔 [ChatGroupScheduling.resolvePollingIntervalMs]；非 autoMode 轮转索引**不推进**（PC 现状）；
 * - 部分失败/中断**不回滚**其他成员已完成的轮次，且接力链继续（PC NEW-M12 的 onChainContinue）；
 * - 用户停止 / 切群切会话 / 群配置变更 → 停链（PC clearPollingTimer 语义）；
 * - 成员被移出、达 maxRounds、无下一位 → 停链交还用户。
 *
 * 消息归属由 [Turn] 在**轮次开始时锁定**：生成中删除成员/切换模式不影响已开轮次的归属
 * （阶段 6 §3 第二条「不会写错角色归属」）。
 *
 * 非线程安全：调用方负责串行化事件（与 [ChatGenerationTask.Machine] 同约定）。
 */
object ChatGroupTurnMachine {

    const val KIND_SINGLE = "single"
    const val KIND_FREE = "free"

    /** 群调度配置快照（对齐 PC `GroupChat` 调度字段）。 */
    data class Config(
        val chatMode: String,
        val autoMode: Boolean = false,
        val maxRounds: Long = 1,
        val memberIds: List<String> = emptyList(),
        val currentSpeakerIndex: Long = 0,
        val speakerIntervalMs: Int = 2000,
    )

    /** 轮次消息视图：直接复用 [ChatGroupScheduling.MessageRef]（characterId + round）。 */

    /** 一轮生成：归属在开始时锁定（free 无固定发言者）。 */
    data class Turn(
        val kind: String,
        val speakerId: String?,
        val round: Long,
    )

    /** 状态机决策（持有者按此执行副作用）。 */
    sealed interface Step {
        /** 执行本轮生成（归属见 [turn]）。 */
        data class RunTurn(val turn: Turn) : Step

        /** 已排定下一轮：持有者起一次性定时器，到期后调 [Machine.onChainTick]。 */
        data class ScheduleNext(val turn: Turn, val delayMs: Long) : Step

        /** 交还用户。 */
        data class WaitUser(val reason: String) : Step

        /** 已停止（用户停止 / 切换上下文 / 群配置变更）；终态。 */
        object Stopped : Step

        /** 本轮被拒绝（no_speaker / speaker_missing）；链未启动。 */
        data class Rejected(val reason: String) : Step
    }

    /** WaitUser 原因（与 fixture/日志共用的稳定词表）。 */
    const val REASON_TURN_DONE = "turn_done"
    const val REASON_MAX_ROUNDS = "max_rounds"
    const val REASON_NO_LAST_SPEAKER = "no_last_speaker"
    const val REASON_SPEAKER_NOT_MEMBER = "speaker_not_member"
    const val REASON_ONE_SHOT_DONE = "one_shot_done"

    /** 机器状态词表（终态不可再迁移）。 */
    const val STATE_IDLE = "idle"
    const val STATE_RUNNING = "running"
    const val STATE_CHAINING = "chaining"
    const val STATE_WAITING_USER = "waiting_user"
    const val STATE_STOPPED = "stopped"

    val TERMINAL_STATES = setOf(STATE_WAITING_USER, STATE_STOPPED)

    /** 机器快照（不可变；每次决策产出新实例，便于观测与测试）。 */
    data class Snapshot(
        val state: String,
        val activeTurn: Turn? = null,
        val turnsRun: Int = 0,
        val currentSpeakerIndex: Long = 0,
    ) {
        val isTerminal: Boolean get() = state in TERMINAL_STATES
    }

    /**
     * 一个实例 = **一条链**（一次用户触发 → 若干接力轮 → 交还用户/停止）；
     * 下一次用户触发另建实例。
     *
     * @param targetCharId mention 模式的回复目标（UI 选择；polling 忽略）
     * @param knownCharacterIds 角色库现存 id（成员被删除后的 speaker_missing 保护）
     */
    class Machine(
        private val config: Config,
        private val targetCharId: String? = null,
        private val knownCharacterIds: List<String>? = null,
    ) {
        private var state: String = STATE_IDLE
        private var activeTurn: Turn? = null
        private var turnsRun: Int = 0
        private var speakerIndex: Long = config.currentSpeakerIndex
        /** 本条链是否允许自动接力（begin 时锁定；立即接话 = false）。 */
        private var chainArmed: Boolean = false

        fun snapshot(): Snapshot = Snapshot(state, activeTurn, turnsRun, speakerIndex)

        /**
         * 用户触发一轮（sendMessage）。
         *
         * [turnRound]：**用户消息与其触发的 AI 回复共用的轮号**（PC 口径）——
         * 由持有者在写入用户消息时用 [ChatGroupScheduling.nextGroupRound] 分配，此处不再 +1。
         * [chainEnabled] = 本触发是否允许自动接力。
         */
        fun begin(
            messages: List<ChatGroupScheduling.MessageRef>,
            turnRound: Long,
            chainEnabled: Boolean = true,
        ): Step {
            if (state != STATE_IDLE) return Step.Stopped
            val plan = ChatGroupScheduling.resolveSpeakerPlan(
                chatMode = config.chatMode,
                memberIds = config.memberIds,
                currentSpeakerIndex = speakerIndex,
                targetCharId = targetCharId,
                knownCharacterIds = knownCharacterIds,
            )
            return when (plan) {
                is ChatGroupScheduling.SpeakerPlan.Error -> Step.Rejected(plan.reason)
                is ChatGroupScheduling.SpeakerPlan.Free -> startTurn(Turn(KIND_FREE, null, turnRound), chainEnabled)
                is ChatGroupScheduling.SpeakerPlan.Single ->
                    startTurn(Turn(KIND_SINGLE, plan.speakerId, turnRound), chainEnabled)
            }
        }

        /**
         * 立即接话（PC `triggerCharacterReply`）：**不经发言计划**、指定成员、开**新轮**、
         * 一次性（不接力、不推进轮转索引）。发言者不在成员表 → Rejected。
         */
        fun beginOneShot(speakerId: String, messages: List<ChatGroupScheduling.MessageRef>): Step {
            if (state != STATE_IDLE) return Step.Stopped
            if (speakerId !in config.memberIds) return Step.Rejected("speaker_missing")
            return startTurn(Turn(KIND_SINGLE, speakerId, nextRound(messages)), chainEnabled = false)
        }

        /**
         * 接力定时器到期：跑已排定的下一轮。
         * 轮次号在此刻按当前消息重算（PC `sendPollingRound` 在触发时才取 max+1）。
         */
        fun onChainTick(messages: List<ChatGroupScheduling.MessageRef>): Step {
            if (state != STATE_CHAINING) return Step.Stopped
            val planned = activeTurn ?: return Step.Stopped
            activeTurn = null
            return startTurn(planned.copy(round = nextRound(messages)), chainEnabled = true)
        }

        /**
         * 当前轮终局（成功或失败**同路**：PC NEW-M12 失败也继续链；
         * [persisted] 仅供观测——归属已在轮次开始时锁定，失败不回滚其他成员已完成轮次，
         * 也不会改写本轮归属）。
         *
         * [currentConfig]：续排决策使用的**新鲜**群配置（PC `checkPollingContinue` 读的是
         * 最新 currentGroup）。生成中删成员/切模式只影响**是否续排**，不影响已开轮归属。
         */
        fun onTurnFinished(
            messages: List<ChatGroupScheduling.MessageRef>,
            persisted: Boolean = true,
            currentConfig: Config? = null,
        ): Step {
            if (state != STATE_RUNNING) return Step.Stopped
            val turn = activeTurn ?: return Step.Stopped
            activeTurn = null
            val cfg = currentConfig ?: config

            // free 与非接力触发：一轮即交还用户（PC free onComplete 不做接力）
            if (turn.kind == KIND_FREE || !chainArmed) {
                state = STATE_WAITING_USER
                return Step.WaitUser(if (chainArmed) REASON_TURN_DONE else REASON_ONE_SHOT_DONE)
            }

            // polling 接力：非 autoMode 直接交还（PC 现状：轮转索引不推进）
            if (cfg.chatMode != "polling" || !cfg.autoMode) {
                state = STATE_WAITING_USER
                return Step.WaitUser(REASON_TURN_DONE)
            }

            val plan = ChatGroupScheduling.planPollingContinue(
                messages = messages,
                memberIds = cfg.memberIds,
                maxRounds = cfg.maxRounds,
            )
            if (plan is ChatGroupScheduling.PollingContinuePlan.Stop) {
                state = STATE_WAITING_USER
                return Step.WaitUser(plan.reason)
            }
            plan as ChatGroupScheduling.PollingContinuePlan.Continue
            // 轮转索引只在接力推进时更新（PC 现状：不持久化、非 autoMode 不推进）
            speakerIndex = plan.nextSpeakerIndex.toLong()
            val next = Turn(KIND_SINGLE, plan.nextCharId, round = 0)
            activeTurn = next
            state = STATE_CHAINING
            return Step.ScheduleNext(next, ChatGroupScheduling.resolvePollingIntervalMs(config.speakerIntervalMs.toLong()).toLong())
        }

        /** 用户停止（PC stopStreaming + clearPollingTimer）；对迟到终局事件幂等。 */
        fun cancel(): Step {
            if (state == STATE_STOPPED) return Step.Stopped
            activeTurn = null
            state = STATE_STOPPED
            return Step.Stopped
        }

        /** 切群/切会话/群配置变更：停链（PC selectGroup/switchSession/设置保存的保守口径）。 */
        fun onGroupChanged(): Step = cancel()

        private fun startTurn(turn: Turn, chainEnabled: Boolean): Step {
            chainArmed = chainEnabled
            activeTurn = turn
            turnsRun += 1
            state = STATE_RUNNING
            return Step.RunTurn(turn)
        }

        private fun nextRound(messages: List<ChatGroupScheduling.MessageRef>): Long =
            ChatGroupScheduling.nextGroupRound(messages.map { it.round })
    }
}
