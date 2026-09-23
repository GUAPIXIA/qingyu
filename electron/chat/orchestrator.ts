/* eslint-disable @typescript-eslint/no-unused-vars, no-empty */
/**
 * V12-06 ChatOrchestrator 核心（实施方案 §13.1 send 流程 1-19）
 *
 * 设计：
 * - 不直接依赖 React/Zustand/DOM/window.api（仅依赖 Port）
 * - 状态转换经 TaskManager 校验（taskManager.transitionTask）
 * - 幂等：requestId -> TaskStore + Message.requestId 双重
 * - 事件：sequence 递增，chunk batching 由 ModelPort 回调聚合后 flush
 */
import { nanoid } from 'nanoid'
import type { ChatCommand } from '../../shared/chat-core/commands'
import { validateChatCommand } from '../../shared/chat-core/commands'
import { isTerminalState, type TaskSnapshot, type TaskEventEnvelope } from '../../shared/chat-core/events'
import { createDomainError, type DomainError } from '../../shared/chat-core/errors'
import { createTask, findByRequestId as findTaskByRequestId, getTaskSnapshot, updateTask, appendEvent } from './taskStore'
import { transitionTask, acquireSessionOrThrow, releaseSession, cancelTask, registerTaskAbort, clearTaskAbort, getTaskAbort } from './taskManager'
import type { MessagePort, ContextPort, ModelPort, MemorySchedulerPort, UsageRecorderPort } from './ports'
import { toPublicModelDescriptor } from './ports'
import { authorizeTool } from './toolGate'

export interface OrchestratorDeps {
  messagePort: MessagePort
  contextPort: ContextPort
  modelPort: ModelPort
  memoryScheduler?: MemorySchedulerPort
  usageRecorder?: UsageRecorderPort
  // 可选：chunk batching 参数
  chunkFlushMs?: number
  chunkFlushBytes?: number
}

function makeTaskId(): string {
  return `task-${nanoid(8)}`
}

function makeEventId(): string {
  return nanoid(8)
}

/**
 * cancel-abort：cancel() 等待模型流收口的兜底时限。
 * 正常收口（abort 拒绝 + 部分正文 commit）在毫秒级完成；超时兜底防
 * waiting_approval 等非 abort 感知阶段把 IPC 应答挂住（终态已由 cancelTask 同步保证）。
 */
const CANCEL_SETTLE_WAIT_MS = 1500

export class ChatOrchestrator {
  constructor(private deps: OrchestratorDeps) {}

  /**
   * 接受任务后立即返回快照，完整生成在后台继续。
   *
   * `handle()` 在第一个 await 之前会同步完成校验、幂等检查、任务落盘与会话加锁，
   * 因此这里可以安全取回 accepted 快照，而不必让 IPC/HTTP 请求阻塞到模型结束。
   */
  start(command: ChatCommand): TaskSnapshot {
    const validationError = validateChatCommand(command)
    if (validationError) throw createDomainError('INVALID_COMMAND', validationError)

    const existing = findTaskByRequestId(command.requestId)
    if (existing) return existing

    const completion = this.handle(command)
    // 后台失败已由 handle 写入任务终态；此处必须吸收 rejection，
    // 否则会变成 Electron 主进程的 unhandled rejection。
    void completion.catch(() => {})

    const accepted = findTaskByRequestId(command.requestId)
    if (!accepted) {
      throw createDomainError('PERSISTENCE_FAILED', '任务接受后未能读回快照')
    }
    if (accepted.state === 'failed') {
      throw accepted.error ?? createDomainError('UNKNOWN', '任务启动失败')
    }
    return accepted
  }

  async handle(command: ChatCommand): Promise<TaskSnapshot> {
    // 1. validate
    const err = validateChatCommand(command)
    if (err) throw createDomainError('INVALID_COMMAND', err)

    // 2. 持久幂等：已存在直接返回
    const existing = findTaskByRequestId(command.requestId)
    if (existing) return existing

    // 3. create queued task（retry 需先解析原任务以确定 session/character）
    const now = Date.now()
    const taskId = makeTaskId()
    let sessionId = (command as { sessionId?: string }).sessionId ?? ''
    let characterId = (command as { characterId?: string }).characterId ?? 'default'
    let retryOfTask: TaskSnapshot | null = null
    if (command.type === 'retry_generation') {
      retryOfTask = getTaskSnapshot((command as { retryOfTaskId: string }).retryOfTaskId) ?? null
      if (!retryOfTask) throw createDomainError('TASK_NOT_FOUND', '重试目标不存在')
      sessionId = retryOfTask.sessionId
      characterId = retryOfTask.characterId
    }

    const snapshot: TaskSnapshot = {
      schemaVersion: 1,
      taskId,
      requestId: command.requestId,
      type: command.type,
      state: 'queued',
      sessionId,
      characterId,
      client: command.client,
      accumulatedText: '',
      lastSequence: 1,
      createdAt: now,
      updatedAt: now,
      ...(retryOfTask ? { retryOfTaskId: retryOfTask.taskId } : {}),
    }

    createTask(snapshot)
    appendEvent({
      protocolVersion: 2,
      eventId: makeEventId(),
      taskId,
      requestId: command.requestId,
      sessionId,
      sequence: 1,
      type: 'task:accepted',
      timestamp: now,
      payload: { taskId },
    })

    // 4. acquire session lock
    try {
      acquireSessionOrThrow(sessionId, taskId)
    } catch (e) {
      // 锁失败：标记 failed 并抛
      const domain = (e as DomainError).code ? (e as DomainError) : createDomainError('TASK_CONFLICT', (e as Error).message ?? '会话冲突')
      transitionTask(taskId, 'failed', { error: domain })
      throw e
    }

    // cancel-abort：模型流收口通知——cancel() 等它 resolve 再应答，
    // 保证渲染层读到的终态快照已带 assistantMessageId（幂等落盘判定依据）。
    let notifySettled: () => void = () => {}
    const settled = new Promise<void>((resolve) => { notifySettled = resolve })

    try {
      // 5. resolve session + character（由 MessagePort.findSession 校验存在性）
      const session = await this.deps.messagePort.findSession(sessionId, characterId)
      if (!session) {
        transitionTask(taskId, 'failed', { error: createDomainError('SESSION_NOT_FOUND', '会话不存在') })
        throw createDomainError('SESSION_NOT_FOUND', '会话不存在')
      }

      // 6-7. 用户消息处理（按类型分支）
      let userMessageId: string | undefined
      if (command.type === 'send') {
        const persisted = await this.deps.messagePort.findByRequestId(sessionId, command.requestId)
        if (!persisted) {
          const um = await this.deps.messagePort.appendUserMessage({
            id: nanoid(),
            sessionId,
            characterId,
            content: command.content,
            images: command.images ?? [],
            replyToId: command.replyToId,
            requestId: command.requestId,
            narrativeMode: session.narrativeMode,
            speakerKind: session.narrativeMode === 'omniscient' ? 'narrator' : 'persona',
            generationKind: command.generationKind ?? 'manual',
          })
          userMessageId = um.id
        } else {
          userMessageId = persisted.id
        }
        updateTask(taskId, (s) => ({ ...s, userMessageId, updatedAt: Date.now() }))
      } else if (command.type === 'retry_generation') {
        // 仅重试 AI，不重复用户消息
        userMessageId = retryOfTask?.userMessageId
        if (userMessageId) updateTask(taskId, (s) => ({ ...s, userMessageId, updatedAt: Date.now() }))
      } else if (command.type === 'regenerate') {
        const targetId = (command as { messageId: string }).messageId
        const target = await this.deps.messagePort.findMessage(sessionId, targetId)
        if (!target || target.role !== 'assistant') {
          transitionTask(taskId, 'failed', { error: createDomainError('INVALID_COMMAND', '目标消息不存在或不可重生成') })
          throw createDomainError('INVALID_COMMAND', '目标消息不存在或不可重生成')
        }
        // 不创建用户消息，记录 target 供后续 swipes 追加
        updateTask(taskId, (s) => ({ ...s, userMessageId: undefined, updatedAt: Date.now() }))
      } else if (command.type === 'continue') {
        // 不重复用户消息
        updateTask(taskId, (s) => ({ ...s, userMessageId: undefined, updatedAt: Date.now() }))
      }

      // 8-10. build context + select model
      transitionTask(taskId, 'preparing')
      const buildContent = (command as { content?: string }).content ?? ''
      const ctx = await this.deps.contextPort.build({ sessionId, characterId, content: buildContent })
      transitionTask(taskId, 'streaming')
      // 落盘/外发一律用剥离凭据的描述（apiKey 只留在进程内，供 modelPort 调用）
      const publicModel = toPublicModelDescriptor(ctx.model)
      updateTask(taskId, (s) => ({ ...s, model: publicModel, contextFingerprint: ctx.fingerprint, updatedAt: Date.now() }))

      appendEvent({
        protocolVersion: 2,
        eventId: makeEventId(),
        taskId,
        requestId: command.requestId,
        sessionId,
        sequence: getTaskSnapshot(taskId)!.lastSequence + 1,
        type: 'task:started',
        timestamp: Date.now(),
        payload: { model: publicModel },
      })
      updateTask(taskId, (s) => ({ ...s, lastSequence: s.lastSequence + 1, startedAt: s.startedAt ?? Date.now(), updatedAt: Date.now() }))

      // 11-13. stream + accumulate + chunk events
      const controller = new AbortController()
      let accumulated = ''
      let lastFlush = Date.now()
      let pendingDelta = ''

      const flushChunk = (force = false) => {
        if (!pendingDelta) return
        const now2 = Date.now()
        const due = force || now2 - lastFlush >= (this.deps.chunkFlushMs ?? 80) || pendingDelta.length >= (this.deps.chunkFlushBytes ?? 4096)
        if (!due) return
        const snap2 = getTaskSnapshot(taskId)
        if (!snap2 || snap2.state !== 'streaming') return
        const seq = snap2.lastSequence + 1
        appendEvent({
          protocolVersion: 2,
          eventId: makeEventId(),
          taskId,
          requestId: command.requestId,
          sessionId,
          sequence: seq,
          type: 'task:chunk',
          timestamp: now2,
          payload: { delta: pendingDelta, accumulatedLength: accumulated.length },
        })
        updateTask(taskId, (s) => ({ ...s, accumulatedText: accumulated, lastSequence: seq, updatedAt: now2 }))
        pendingDelta = ''
        lastFlush = now2
      }

      // cancel-abort：登记 AbortController + 收口通知 + 冲刷回调，cancelTask 可真 abort 本流；
      // 登记与 controller 创建同处一个同步块（中间无 await），不存在取消 interleaving 缝隙。
      registerTaskAbort(taskId, { controller, settled, flush: () => flushChunk(true) })

      let modelResult: { text: string } | null = null
      let streamError: unknown = null

      try {
        modelResult = await this.deps.modelPort.stream(
          { messages: ctx.messages, model: ctx.model.model, provider: ctx.model.provider, maxTokens: ctx.requestMaxTokens, apiKey: ctx.model.apiKey, baseUrl: ctx.model.baseUrl },
          {
            onChunk: (delta) => {
              accumulated += delta
              pendingDelta += delta
              flushChunk(false)
            },
            onUsage: (usage) => {
              const snapU = getTaskSnapshot(taskId)
              if (!snapU) return
              const seq = snapU.lastSequence + 1
              appendEvent({
                protocolVersion: 2,
                eventId: makeEventId(),
                taskId,
                requestId: command.requestId,
                sessionId,
                sequence: seq,
                type: 'task:usage',
                timestamp: Date.now(),
                payload: usage,
              })
              updateTask(taskId, (s) => ({ ...s, usage, lastSequence: seq, updatedAt: Date.now() }))
            },
          },
          controller.signal,
        )
        // 最终 flush
        if (pendingDelta) {
          // 将剩余 pending 合并到 accumulated（已在 onChunk 累加）
        }
        // 确保 accumulated 与 modelResult 一致（FakeModel 可能已通过 onChunk 累加）
        if (modelResult && modelResult.text && accumulated !== modelResult.text) {
          accumulated = modelResult.text
        }
      } catch (e) {
        streamError = e
        // 若是用户取消（Abort），走 cancelled 分支；否则 failed
        const msg = (e as Error).message ?? ''
        // cancel-abort：真 abort 后底层以 AbortError（fetch/undici）或 'Aborted'
        // （fakeModel / ai.chatWithRetry 预检）抛出，且取消竞态下任意错误都可能带着
        // 已 abort 的 signal 到达——统一按用户取消识别，避免把取消误落 failed 分支。
        const isUserAbort = controller.signal.aborted || msg === 'Aborted' || (e as Error).name === 'AbortError'
        if (isUserAbort || (e as { code?: string }).code === 'TOOL_PERMISSION_DENIED') {
          flushChunk(true)
          const snapC = getTaskSnapshot(taskId)!
          // 保留非空部分
          const finalText = accumulated
          // cancel-abort：若收尾竞态中已有 commit（自然完成收尾先落盘），以已 commit 为准，绝不重复落盘
          if (finalText && !snapC.assistantMessageId) {
            // 落盘部分消息
            const assistantId = nanoid()
            await this.deps.messagePort.commitAssistantMessage({
              id: assistantId,
              sessionId,
              characterId,
              content: finalText,
              requestId: command.requestId + '-cancel',
              generationTaskId: taskId,
              narrativeMode: session.narrativeMode,
              speakerKind: 'character',
              generationKind: command.type === 'continue' ? 'message_continue' : 'assistant_reply',
              contentRenderMode: 'blocks',
            })
            updateTask(taskId, (s) => ({ ...s, assistantMessageId: assistantId, accumulatedText: finalText, updatedAt: Date.now() }))
          }
          // cancel-abort：cancelTask 可能已抢先转 cancelled（终态不可再转，直接 transition 会抛
          // TASK_CONFLICT 穿透收口）；仅未终态时补转，保证任务终态唯一 + 事件流恰一个终局事件。
          const snapFinal = getTaskSnapshot(taskId)!
          if (!isTerminalState(snapFinal.state)) transitionTask(taskId, 'cancelled')
          return getTaskSnapshot(taskId)!
        }
        // 其他失败
        flushChunk(true)
        const domain = mapProviderError(e)
        transitionTask(taskId, 'failed', { error: domain })
        throw domain
      }

      // 12. 工具调用授权（waiting_approval）
      // 检测 [TOOL_CALL:json] 标记，若命中则逐个授权（L0 自动，L1+ 需确认）
      if (accumulated.includes('[TOOL_CALL:')) {
        const m = accumulated.match(/\[TOOL_CALL:(.*)\]\s*$/)
        if (m) {
          try {
            const calls = JSON.parse(m[1])
            const list: Array<{ id: string; function?: { name: string; arguments: string }; name?: string; args?: unknown }> = Array.isArray(calls) ? calls : [calls]
            for (const tc of list) {
              const name = tc.function?.name ?? tc.name ?? ''
              const argsStr = tc.function?.arguments ?? JSON.stringify(tc.args ?? {})
              let args: Record<string, unknown> = {}
              try { args = JSON.parse(argsStr) } catch {}
              // 进入等待授权
              transitionTask(taskId, 'waiting_approval')
              const snapW = getTaskSnapshot(taskId)!
              const seqReq = snapW.lastSequence + 1
              appendEvent({
                protocolVersion: 2,
                eventId: makeEventId(),
                taskId,
                requestId: command.requestId,
                sessionId,
                sequence: seqReq,
                type: 'task:approval_required',
                timestamp: Date.now(),
                payload: { tool: name, argsPreview: JSON.stringify(args).slice(0, 500) },
              })
              updateTask(taskId, (s) => ({ ...s, lastSequence: seqReq, updatedAt: Date.now() }))
              const snapForGate = getTaskSnapshot(taskId)!
              const decision = await authorizeTool({ serverName: 'mcp', toolName: name, args }, snapForGate)
              const seqRes = getTaskSnapshot(taskId)!.lastSequence + 1
              appendEvent({
                protocolVersion: 2,
                eventId: makeEventId(),
                taskId,
                requestId: command.requestId,
                sessionId,
                sequence: seqRes,
                type: 'task:approval_resolved',
                timestamp: Date.now(),
                payload: { tool: name, decision },
              })
              updateTask(taskId, (s) => ({ ...s, lastSequence: seqRes, updatedAt: Date.now() }))
              if (decision !== 'allow') {
                throw createDomainError('TOOL_PERMISSION_DENIED', `工具 ${name} 被拒绝`, { safeDetails: { tool: name } })
              }
              // 恢复 streaming
              transitionTask(taskId, 'streaming')
            }
            // 授权通过后，移除 TOOL_CALL 标记，继续后续流程（本版不执行真实工具，仅演示授权链路）
            accumulated = accumulated.replace(/\[TOOL_CALL:.*\]\s*$/, '').trim()
          } catch (e) {
            if ((e as DomainError).code === 'TOOL_PERMISSION_DENIED') throw e
            // 解析失败视为普通文本，忽略工具流程
          }
        }
      }

      // 14-15. postprocess（简化：直接用 accumulated，实际应走 PostProcessor）
      flushChunk(true)
      const finalText = accumulated

      // 16. finalizing -> 落盘（regenerate 追加 swipe，其余新建）
      transitionTask(taskId, 'finalizing')
      if (command.type === 'regenerate') {
        const targetId = (command as { messageId: string }).messageId
        if (!finalText) {
          transitionTask(taskId, 'failed', { error: createDomainError('INVALID_MODEL_RESPONSE', '空回复') })
          throw createDomainError('INVALID_MODEL_RESPONSE', '空回复')
        }
        const res = await this.deps.messagePort.appendSwipedCandidate(targetId, finalText, 'regenerate')
        updateTask(taskId, (s) => ({ ...s, assistantMessageId: res.id, accumulatedText: finalText, updatedAt: Date.now() }))
      } else {
        const assistantId = nanoid()
        await this.deps.messagePort.commitAssistantMessage({
          id: assistantId,
          sessionId,
          characterId,
          content: finalText,
          requestId: command.requestId,
          generationTaskId: taskId,
          narrativeMode: session.narrativeMode,
          speakerKind: 'character',
          generationKind: command.type === 'continue' ? 'message_continue' : 'assistant_reply',
          contentRenderMode: 'blocks',
        })
        updateTask(taskId, (s) => ({ ...s, assistantMessageId: assistantId, accumulatedText: finalText, updatedAt: Date.now() }))
      }

      // 新版聊天引擎的用量必须在主进程完成点记录：渲染层可能切页或断开，
      // 不能承担记账。Array.from 按 Unicode 字符计数，与页面现有 countChars 口径一致。
      const inputChars = command.type === 'send' ? Array.from(command.content).length : 0
      const outputChars = Array.from(finalText).length
      try {
        await this.deps.usageRecorder?.record({
          timestamp: Date.now(),
          characterId,
          sessionId,
          model: ctx.model.model,
          inputChars,
          outputChars,
          totalChars: inputChars + outputChars,
        })
      } catch {
        // 统计是辅助数据，失败不得反转已经落盘的主对话终态。
      }
      // 17. completed：先等记账尝试收口，保证终态观察者刷新时能读到最新统计。
      transitionTask(taskId, 'completed')
      // 自动长记忆由主进程统一调度；调度器必须异步执行，不能阻塞主回复完成。
      try {
        this.deps.memoryScheduler?.schedule({ sessionId, characterId })
      } catch {
        // 后台辅助任务失败不反转已经落盘的主对话终态。
      }
      return getTaskSnapshot(taskId)!
    } catch (e) {
      // stream 以外的异常（例如上下文构建/配置读取）也必须收口为终态，
      // 否则后台执行时客户端会永久看到 preparing/streaming。
      const current = getTaskSnapshot(taskId)
      if (current && !isTerminalState(current.state)) {
        const domain = (e as DomainError)?.code
          ? e as DomainError
          : mapProviderError(e)
        transitionTask(taskId, 'failed', { error: domain })
      }
      throw e
    } finally {
      // cancel-abort：先清登记再通知收口（同一同步块，cancel 不会观察到中间态）；
      // 收口通知 resolve 时部分正文 commit 已完成，cancel 应答快照必带 assistantMessageId。
      clearTaskAbort(taskId)
      notifySettled()
      releaseSession(sessionId, taskId)
    }
  }

  /**
   * 取消（cancel-abort）：真 abort 后台模型流，并等待模型流收口后再应答。
   *
   * 应答前等收口是渲染层幂等收口（persistV2StoppedMessage 读终态 assistantMessageId）的
   * 判定依据：cancel 响应快照已带 assistantMessageId 时渲染层并入已落盘消息、跳过兜底落盘，
   * 未提交才由渲染层兜底保存已见正文——两条路径互斥，磁盘不会出现重复消息。
   */
  async cancel(taskId: string): Promise<TaskSnapshot> {
    const snap = getTaskSnapshot(taskId)
    if (!snap) throw createDomainError('TASK_NOT_FOUND', '任务不存在')
    const inflight = getTaskAbort(taskId)
    if (!isTerminalState(snap.state)) {
      // cancel-abort：cancelTask 内部冲刷已见正文 + abort 模型流 + 转 cancelled（幂等）
      cancelTask(taskId)
    } else if (!inflight) {
      // 幂等：已终态且无在途收口（自然完成先到先得），原样返回不翻转终态
      return snap
    }
    if (inflight) {
      // 等 'Aborted' 收口（部分正文 commit / 终态收尾）完成；超时兜底防非 abort
      // 感知阶段（如 waiting_approval）把应答挂住——终态已由 cancelTask 同步保证。
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CANCEL_SETTLE_WAIT_MS)
        timer.unref?.()
        inflight.settled.then(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    return getTaskSnapshot(taskId) ?? snap
  }
}

function mapProviderError(e: unknown): ReturnType<typeof createDomainError> {
  const msg = (e as Error).message ?? String(e)
  if (/timeout/i.test(msg)) return createDomainError('PROVIDER_TIMEOUT', msg)
  if (/rate/i.test(msg)) return createDomainError('PROVIDER_RATE_LIMITED', msg)
  if (/unavailable|network/i.test(msg)) return createDomainError('PROVIDER_UNAVAILABLE', msg)
  return createDomainError('PROVIDER_UNAVAILABLE', msg)
}
