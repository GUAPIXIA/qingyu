/**
 * V12-09 Bridge API v2（实施方案 §10）
 *
 * POST /api/v2/sessions/:sessionId/tasks  (Idempotency-Key: requestId)
 * GET  /api/v2/tasks/:taskId
 * GET  /api/v2/tasks/:taskId/events?afterSequence=&limit=
 * GET  /api/v2/sessions/:sessionId/tasks?state=active&limit=
 * POST /api/v2/tasks/:taskId/cancel
 * POST /api/v2/tasks/:taskId/retry
 */
import { Router, type Request, type Response } from 'express'
import { nanoid } from 'nanoid'
import { ChatOrchestrator } from '../chat/orchestrator'
import { chatMessagePort } from '../chat/messagePort'
import { contextService } from '../chat/contextService'
import { FakeModelPort } from '../chat/fakeModel'
import { findByRequestId, getTaskSnapshot, readEvents, listActiveTasks } from '../chat/taskStore'
import { createDomainError } from '../../shared/chat-core/errors'
import type { ChatCommand } from '../../shared/chat-core/commands'

function getOrchestrator(): ChatOrchestrator {
  // 复用 FakeModelPort 占位，后续接入真实 ModelPort
  return new ChatOrchestrator({
    messagePort: chatMessagePort,
    contextPort: contextService,
    modelPort: new FakeModelPort({ kind: 'success', chunks: ['（v2 占位回复）'] }),
  })
}

export function buildTaskRouter(): Router {
  const router = Router()

  // 创建任务
  router.post('/sessions/:sessionId/tasks', async (req: Request, res: Response) => {
    const sessionId = req.params.sessionId as string
    const idempotencyKey = (req.headers['idempotency-key'] as string) || (req.body?.requestId as string) || nanoid(8)
    const body = (req.body ?? {}) as { type?: string; characterId?: string; content?: string; images?: string[]; replyToId?: string }
    let { type = 'send', content = '', images, replyToId } = body
    let characterId = body.characterId
    // 若未传 characterId，回退为会话所属角色（避免 Orchestrator 用 'default' 导致空 character）
    if (!characterId) {
      try {
        const { findSessionById } = await import('../bridge/sessionsIndex')
        const s = await findSessionById(sessionId)
        if (s) characterId = s.characterId
      } catch {}
    }

    // 幂等：已存在直接返回同一任务
    const existing = findByRequestId(idempotencyKey)
    if (existing) {
      res.status(202).json({ task: { taskId: existing.taskId, state: existing.state, lastSequence: existing.lastSequence }, userMessage: { id: existing.userMessageId ?? null, requestId: idempotencyKey } })
      return
    }

    const command: ChatCommand = {
      type: type as ChatCommand['type'],
      requestId: idempotencyKey,
      sessionId,
      characterId,
      content,
      images,
      replyToId,
      client: { kind: 'android', clientId: (req as unknown as { deviceId?: string }).deviceId ?? 'android', protocolVersion: 2 },
    } as ChatCommand

    try {
      const orch = getOrchestrator()
      const task = await orch.handle(command)
      res.status(202).json({ task: { taskId: task.taskId, state: task.state, lastSequence: task.lastSequence }, userMessage: { id: task.userMessageId ?? null, requestId: idempotencyKey } })
    } catch (e) {
      const err = e as { code?: string; message?: string; safeDetails?: unknown }
      if (err.code === 'TASK_CONFLICT') {
        res.status(409).json({ error: { code: err.code, message: err.message, retryable: true, details: err.safeDetails } })
        return
      }
      res.status(500).json({ error: { code: err.code ?? 'UNKNOWN', message: err.message ?? String(e) } })
    }
  })

  // 查询任务
  router.get('/tasks/:taskId', (req, res) => {
    const snap = getTaskSnapshot(req.params.taskId)
    if (!snap) { res.status(404).json({ error: { code: 'TASK_NOT_FOUND' } }); return }
    res.json({ task: snap })
  })

  // 事件补拉
  router.get('/tasks/:taskId/events', (req, res) => {
    const after = Number(req.query.afterSequence ?? 0)
    const limit = Math.min(Number(req.query.limit ?? 200), 200)
    const snap = getTaskSnapshot(req.params.taskId)
    if (!snap) { res.status(404).json({ error: { code: 'TASK_NOT_FOUND' } }); return }
    const page = readEvents(req.params.taskId, after, limit)
    res.json(page)
  })

  // 会话任务列表
  router.get('/sessions/:sessionId/tasks', (req, res) => {
    const state = req.query.state as string | undefined
    const limit = Math.min(Number(req.query.limit ?? 20), 50)
    let tasks = listActiveTasks().filter((t) => t.sessionId === req.params.sessionId)
    if (state) tasks = tasks.filter((t) => t.state === state)
    res.json({ tasks: tasks.slice(0, limit) })
  })

  // 取消
  router.post('/tasks/:taskId/cancel', async (req, res) => {
    const snap = getTaskSnapshot(req.params.taskId)
    if (!snap) { res.status(404).json({ error: { code: 'TASK_NOT_FOUND' } }); return }
    const orch = getOrchestrator()
    try {
      const out = await orch.cancel(req.params.taskId)
      res.json({ task: out })
    } catch (e) {
      res.status(500).json({ error: { code: (e as { code?: string }).code ?? 'UNKNOWN', message: (e as Error).message } })
    }
  })

  // 重试（仅生成）
  router.post('/tasks/:taskId/retry', async (req, res) => {
    const snap = getTaskSnapshot(req.params.taskId)
    if (!snap) { res.status(404).json({ error: { code: 'TASK_NOT_FOUND' } }); return }
    const newRequestId = nanoid(8)
    const command: ChatCommand = {
      type: 'retry_generation',
      requestId: newRequestId,
      retryOfTaskId: snap.taskId,
      client: { kind: 'android', clientId: (req as unknown as { deviceId?: string }).deviceId ?? 'android', protocolVersion: 2 },
    }
    // 简化：直接复用原任务的 sessionId/characterId 重新走 send
    const retryCmd: ChatCommand = {
      type: 'send',
      requestId: newRequestId,
      sessionId: snap.sessionId,
      characterId: snap.characterId,
      content: snap.accumulatedText || 'retry',
      client: command.client,
    } as unknown as ChatCommand
    // 标记 retryOfTaskId
    ;(retryCmd as unknown as Record<string, unknown>).retryOfTaskId = snap.taskId
    const orch = getOrchestrator()
    try {
      const task = await orch.handle(retryCmd)
      res.status(202).json({ task: { taskId: task.taskId, state: task.state } })
    } catch (e) {
      res.status(500).json({ error: { code: (e as { code?: string }).code ?? 'UNKNOWN', message: (e as Error).message } })
    }
  })

  return router
}
