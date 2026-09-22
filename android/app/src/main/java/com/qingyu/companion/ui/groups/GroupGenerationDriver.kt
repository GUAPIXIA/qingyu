package com.qingyu.companion.ui.groups

import com.qingyu.companion.chatcore.LocalGroupGenerationUseCase
import kotlinx.coroutines.flow.Flow

/**
 * 群生成流源（S6-01(f) 第 3 项：停止按钮 + 流式事件转发）。
 *
 * 驱动 `LocalGroupGenerationUseCase.generate` 的 `Flow<Delta>`（含 autoMode 接力链的连续
 * TurnStarted／Chunk／TurnFinished）。ViewModel 只依赖本接口（可注入、可测）；
 * 生产实现 [LocalGroupGenerationDriver] 包装真实 `LocalGroupGenerationUseCase`。
 *
 * 收集方取消 = 用户停止（保留已见正文），见 `generate` 文档。
 */
fun interface GroupGenerationDriver {
    fun generate(
        groupId: String,
        sessionId: String,
        requestId: String,
        targetCharId: String?,
        forcedSpeakerId: String?,
        chainEnabled: Boolean,
        turnRound: Long?,
    ): Flow<LocalGroupGenerationUseCase.Delta>
}

/** 生产实现：透传到 chatcore `LocalGroupGenerationUseCase.generate`（只读使用，不改 chatcore）。 */
class LocalGroupGenerationDriver(
    private val useCase: LocalGroupGenerationUseCase,
) : GroupGenerationDriver {
    override fun generate(
        groupId: String,
        sessionId: String,
        requestId: String,
        targetCharId: String?,
        forcedSpeakerId: String?,
        chainEnabled: Boolean,
        turnRound: Long?,
    ): Flow<LocalGroupGenerationUseCase.Delta> = useCase.generate(
        groupId = groupId,
        sessionId = sessionId,
        requestId = requestId,
        targetCharId = targetCharId,
        forcedSpeakerId = forcedSpeakerId,
        chainEnabled = chainEnabled,
        turnRound = turnRound,
    )
}
