/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-require-imports, no-empty */
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
import type { TaskSnapshot, TaskEventEnvelope } from '../../shared/chat-core/events'
import { createDomainError, type DomainError } from '../../shared/chat-core/errors'
import { createTask, findByRequestId as findTaskByRequestId, getTaskSnapshot, updateTask, appendEvent } from './taskStore'
import { transitionTask, acquireSessionOrThrow, releaseSession } from './taskManager'
import type { MessagePort, ContextPort, ModelPort } from './ports'
import { authorizeTool } from './toolGate'

export interface OrchestratorDeps {
  messagePort: MessagePort
  contextPort: ContextPort
  modelPort: ModelPort
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

export class ChatOrchestrator {
  constructor(private deps: OrchestratorDeps) {}

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
      updateTask(taskId, (s) => ({ ...s, model: ctx.model, contextFingerprint: ctx.fingerprint, updatedAt: Date.now() }))

      appendEvent({
        protocolVersion: 2,
        eventId: makeEventId(),
        taskId,
        requestId: command.requestId,
        sessionId,
        sequence: getTaskSnapshot(taskId)!.lastSequence + 1,
        type: 'task:started',
        timestamp: Date.now(),
        payload: { model: ctx.model },
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

      let modelResult: { text: string } | null = null
      let streamError: unknown = null

      try {
        modelResult = await this.deps.modelPort.stream(
          { messages: ctx.messages, model: ctx.model.model, provider: ctx.model.provider },
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
        if (msg === 'Aborted' || (e as { code?: string }).code === 'TOOL_PERMISSION_DENIED') {
          flushChunk(true)
          const snapC = getTaskSnapshot(taskId)!
          // 保留非空部分
          const finalText = accumulated
          if (finalText) {
            // 落盘部分消息
            const assistantId = nanoid()
            await this.deps.messagePort.commitAssistantMessage({
              id: assistantId,
              sessionId,
              characterId,
              content: finalText,
              requestId: command.requestId + '-cancel',
              generationTaskId: taskId,
            })
            updateTask(taskId, (s) => ({ ...s, assistantMessageId: assistantId, accumulatedText: finalText, updatedAt: Date.now() }))
          }
          transitionTask(taskId, 'cancelled')
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
        const res = await this.deps.messagePort.appendSwipedCandidate(targetId, finalText)
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
        })
        updateTask(taskId, (s) => ({ ...s, assistantMessageId: assistantId, accumulatedText: finalText, updatedAt: Date.now() }))
      }

      // 17. completed
      transitionTask(taskId, 'completed')
      return getTaskSnapshot(taskId)!
    } finally {
      releaseSession(sessionId, taskId)
    }
  }

  async cancel(taskId: string): Promise<TaskSnapshot> {
    const snap = getTaskSnapshot(taskId)
    if (!snap) throw createDomainError('TASK_NOT_FOUND', '任务不存在')
    // 幂等：终态直接返回
    const { isTerminalState } = await import('../../shared/chat-core/events')
    if (isTerminalState(snap.state)) return snap
    const { cancelTask } = await import('./taskManager')
    return cancelTask(taskId)
  }
}

function mapProviderError(e: unknown): ReturnType<typeof createDomainError> {
  const msg = (e as Error).message ?? String(e)
  if (/timeout/i.test(msg)) return createDomainError('PROVIDER_TIMEOUT', msg)
  if (/rate/i.test(msg)) return createDomainError('PROVIDER_RATE_LIMITED', msg)
  if (/unavailable|network/i.test(msg)) return createDomainError('PROVIDER_UNAVAILABLE', msg)
  return createDomainError('PROVIDER_UNAVAILABLE', msg)
}
