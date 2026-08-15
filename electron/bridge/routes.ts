/**
 * 桥接层 REST 路由（方案 §4.3 协议设计 + 安卓端协议假设）。
 *
 * 鉴权：除 server/info 与 auth/pair 外均校验 Authorization: Bearer <JWT>（§6.2）。
 * 端点清单（/api/v1 前缀）：
 *   GET  /server/info                    版本协商
 *   POST /auth/pair                      配对（配对码 + PC 端人工确认）
 *   GET  /characters                     角色列表
 *   GET  /sessions                       会话列表（跨角色）
 *   GET  /sessions/:id/messages          消息（cursor 分页 limit/beforeId）
 *   POST /sessions/:id/messages          发消息（requestId 幂等）
 *   PATCH /sessions/:id                  重命名
 *   PATCH /sessions/:id/messages/:mid    编辑消息
 *   DELETE /sessions/:id/messages/:mid   删除消息
 *   POST /sessions/:id/swipe             swipe 切换（direction=0 重新生成）
 *   POST /sessions/:id/translate         翻译
 *   GET  /quickReplies                   快捷回复
 *   POST /quickReplies/:id/execute       执行快捷回复（协议假设）
 *   POST /characters/:id/activate        设为当前角色（协议假设）
 *   GET  /sessions/:id/messages/:mid/tts TTS 音频流（协议假设）
 */
import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { join } from 'node:path'
import { readJson, writeJson, listJsonFilesAsync, DIRS } from '../services/storage'
import { getCharacter, listCharacters } from '../services/charCard'
import { chatData } from '../ipc/chat'
import { groupData } from '../ipc/group'
import { getBuiltinPresets } from '../ipc/preset'
import { readRules } from '../ipc/regex'
import { getSummary, queryUsage } from '../services/usage'
import { fetchAnnouncementList, fetchVersionInfo } from '../ipc/announcement'
import { restoreSecrets } from '../ipc/settings'
import { chatWithRetry, getAdapter } from '../services/ai'
import { mainContextProvider } from '../context/mainContextProvider'
import { buildContextMessagesFromData } from '../../src/context/contextBuilder'
import { buildContinueContext, ensureUserPerspective } from '../../src/components/chat/aiInputHelper'
import { stripThought } from '../../src/utils/messagePostProcess'
import { parseMemoryResult } from '../../src/utils/memory'
import { replaceVariables as replaceVars } from '../../src/utils/variables'
import { getDefaultSettings } from '../../shared/defaults'
import { nanoid } from 'nanoid'
import { replaceVariables } from '../../src/utils/variables'
import {
  consumePairingCode,
  enqueuePendingPair,
  getPendingPair,
  registerDevice,
  settlePair,
  signToken,
  verifyToken,
  listDevices,
  revokeDevice,
  touchDevice,
} from './auth'
import { WsHub } from './ws'
import { BridgeChatService, type SessionChangedNotifier } from './chatService'
import { listAllSessions, findSessionById } from './sessionsIndex'
import { handleTts } from './ttsHandler'
import { safeId } from '../utils/pathGuard'
import { sanitizeApiKey } from '../utils/pathGuard'
import { createLogger } from '../services/logger'
import type { Request, Response, NextFunction } from 'express'
import type { Message, QuickReply, Settings, Lorebook, Preset, ChatParams, ProviderType, GroupChat } from '../../shared/types'

const log = createLogger('bridge-routes')

/** 版本协商：与安卓端 SUPPORTED_API_VERSION 对齐 */
export const API_VERSION = 1

/** 配对确认等待超时（安卓端 readTimeout 60s 内） */
const PAIR_WAIT_TIMEOUT_MS = 55_000

/** 校验 Bearer 令牌的中间件（JWT 校验 + 设备仍存在校验：吊销立即生效） */
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const payload = verifyToken(token)
  if (!payload) {
    log.warn('鉴权失败：令牌无效或已过期', { path: req.path })
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  // 设备被吊销（devices.json 已移除）后令牌立即失效
  if (!listDevices().some((d) => d.deviceId === payload.deviceId)) {
    log.warn('鉴权失败：设备已被吊销', { deviceId: payload.deviceId })
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  touchDevice(payload.deviceId)
  ;(req as Request & { deviceId?: string }).deviceId = payload.deviceId
  next()
}

/** 非浏览器 UA 放行 + 浏览器 Origin 校验（§6.3：防局域网恶意网页借浏览器发请求） */
function originGuard(req: Request, res: Response, next: NextFunction): void {
  const ua = (req.headers['user-agent'] ?? '').toLowerCase()
  const isBrowser = /mozilla|chrome|safari|firefox|edg/i.test(ua) && !ua.includes('qingyu-companion')
  const origin = req.headers.origin
  if (isBrowser) {
    if (origin && !origin.startsWith('http://127.0.0.1') && !origin.startsWith('http://localhost')) {
      res.status(403).json({ error: 'origin rejected' })
      return
    }
  }
  next()
}

/** 构造路由（依赖注入 hub/chatService/notifySessionChanged/onPairRequest） */
export function buildBridgeRouter(
  hub: WsHub,
  chatService: BridgeChatService,
  notifySessionChanged: SessionChangedNotifier,
  onPairRequest: (requestId: string, deviceName: string) => void = () => {},
): Router {
  const router = Router()
  router.use(originGuard)

  // ===== 配对（限流 + 无鉴权）=====

  const pairLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
  })

  router.get('/server/info', (_req, res) => {
    res.json({ apiVersion: API_VERSION, appVersion: '0.11.23' })
  })

  router.post('/auth/pair', pairLimiter, async (req, res) => {
    const { pairingCode, deviceName, deviceFingerprint } = (req.body ?? {}) as {
      pairingCode?: string
      deviceName?: string
      deviceFingerprint?: string
    }
    if (!pairingCode || !deviceName || !deviceFingerprint) {
      res.status(400).json({ error: '缺少配对参数' })
      return
    }
    // 配对码校验（一次性 + 5 分钟）
    if (!consumePairingCode(pairingCode)) {
      res.status(401).json({ error: '配对码无效或已过期' })
      return
    }
    // 已登记的受信任设备直接续签
    const existing = await import('./auth').then((m) => m.findDevice(deviceFingerprint))
    if (existing) {
      res.json({ token: signToken(existing.deviceId), deviceId: existing.deviceId })
      return
    }

    // 未登记：挂起等待 PC 端人工确认（§5.1 防局域网抢扫）
    const pair = enqueuePendingPair(deviceName, deviceFingerprint, pairingCode)
    onPairRequest(pair.requestId, deviceName)
    const approved = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), PAIR_WAIT_TIMEOUT_MS)
      pair.resolve = (ok) => {
        clearTimeout(timer)
        resolve(ok)
      }
    })
    if (!approved) {
      log.warn('配对超时/被拒绝', { deviceName })
      res.status(408).json({ error: '配对确认超时或已被拒绝' })
      return
    }
    const device = registerDevice(deviceName, deviceFingerprint)
    log.info('配对成功', { deviceId: device.deviceId, deviceName })
    res.json({ token: signToken(device.deviceId), deviceId: device.deviceId })
  })

  // ===== 鉴权中间件之后的端点 =====
  router.use(requireAuth)

  router.get('/characters', async (_req, res) => {
    try {
      const chars = await listCharacters()
      // 下发给安卓端的角色子集：封面转静态路由 URL（§4.2，tavern:// 不可达）
      // 注意：listCharacters 不含图片 base64，avatar 需经 getCharacter 按需读文件判断
      res.json(chars.map((c) => {
        const full = getCharacter(c.id)
        return {
          id: c.id,
          name: c.name,
          avatarUrl: full?.avatar ? `/static/avatars/${c.id}` : null,
          coverUrl: full?.cover ? `/static/covers/${c.id}` : null,
          description: c.description,
          personality: c.personality,
          scenario: c.scenario,
          firstMessage: c.firstMessage,
          alternateGreetings: c.alternateGreetings ?? [],
          tags: c.tags ?? [],
          pinned: c.pinned ?? false,
          creator: c.creator ?? '',
          createdAt: c.createdAt ?? 0,
          updatedAt: c.updatedAt ?? 0,
          translatedContent: c.translatedContent ?? undefined,
        }
      }))
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // ===== 设置 / 世界书 / 预设（安卓端快捷设置面板数据源） =====

  /** 下发设置的精简子集（剔除 apiKey/连接配置等敏感字段） */
  function toApiSettings(s: Settings): Record<string, unknown> {
    return {
      userName: s.userName,
      userDescription: s.userDescription,
      userPersona: s.userPersona,
      activePresetId: s.activePresetId ?? null,
      activeModel: s.activeModel ?? '',
      translationTargetLang: s.translationTargetLang ?? '中文',
      streamOutput: s.streamOutput,
      autoScroll: s.autoScroll,
      showTokenCount: s.showTokenCount,
      htmlRendering: s.htmlRendering,
      imageGenAutoEnabled: s.imageGenAutoEnabled ?? false,
      imageGenSize: s.imageGenSize ?? '1024x1024',
      exampleDialogMode: s.exampleDialogMode ?? 'always',
      lorebookRatio: s.lorebookRatio ?? 0.3,
      autoTitle: s.autoTitle ?? true,
      themeColor: s.themeColor,
      fontSize: s.fontSize,
      bubbleStyle: s.bubbleStyle,
      messageSpacing: s.messageSpacing,
      messageWidth: s.messageWidth,
      authorNote: s.authorNote ?? null,
    }
  }

  router.get('/settings', (_req, res) => {
    try {
      const settings = readJson<Settings>(join(DIRS.config(), 'settings.json'), 'settings') ?? getDefaultSettings()
      res.json(toApiSettings(settings))
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  /** 安卓端可修改的设置白名单（排除敏感/连接字段） */
  const SETTINGS_WRITE_FIELDS = new Set([
    'userName', 'userDescription', 'userPersona',
    'translationTargetLang', 'streamOutput', 'autoScroll', 'showTokenCount',
    'htmlRendering', 'imageGenAutoEnabled', 'imageGenSize', 'exampleDialogMode',
    'lorebookRatio', 'autoTitle', 'themeColor', 'fontSize', 'bubbleStyle',
    'messageSpacing', 'messageWidth', 'activeModel', 'activePresetId',
  ])

  router.patch('/settings', (req, res) => {
    try {
      const file = join(DIRS.config(), 'settings.json')
      const settings = readJson<Settings>(file, 'settings') ?? getDefaultSettings()
      const body = (req.body ?? {}) as Record<string, unknown>
      for (const key of Object.keys(body)) {
        if (!SETTINGS_WRITE_FIELDS.has(key)) continue
        ;(settings as unknown as Record<string, unknown>)[key] = body[key]
      }
      writeJson(file, settings, 'settings')
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  /** 拉取模型列表：用 PC 端当前激活的 API Profile（provider/baseUrl/apiKey） */
  router.get('/ai/models', async (_req, res) => {
    try {
      const settings = readJson<Settings>(join(DIRS.config(), 'settings.json'), 'settings') ?? getDefaultSettings()
      const profile = settings.connectionProfiles?.find((p) => p.id === settings.activeProfileId)
      if (!profile) {
        res.status(400).json({ error: '未配置 API 连接' })
        return
      }
      const models = await getAdapter(profile.provider).listModels(profile.baseUrl, profile.apiKey)
      res.json({ models })
    } catch (e) {
      res.status(500).json({ error: sanitizeApiKey((e as Error).message) })
    }
  })

  router.get('/lorebooks', async (_req, res) => {
    try {
      const lorebooks = await listJsonFilesAsync<Lorebook>(DIRS.lorebooks())
      res.json(lorebooks.map((l) => ({
        id: l.id,
        name: l.name,
        description: l.description ?? '',
        enabled: l.enabled ?? true,
        scanDepth: l.scanDepth ?? 0,
        entryCount: (l.entries ?? []).length,
      })))
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  router.get('/presets', async (_req, res) => {
    try {
      const custom = await listJsonFilesAsync<Preset>(DIRS.presets())
      const builtin = getBuiltinPresets()
      res.json([...builtin, ...custom].map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? '',
        isBuiltin: p.isBuiltin ?? false,
        group: p.group ?? '',
        temperature: p.temperature,
        topP: p.topP,
        maxTokens: p.maxTokens,
        maxContext: p.maxContext,
        contextTemplate: p.contextTemplate ?? '',
      })))
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  /** 修改预设采样参数（温度/TopP/MaxToken）；内置预设保存为副本（对齐 preset:save IPC） */
  router.patch('/presets/:presetId', async (req, res) => {
    try {
      const presetId = safeId(req.params.presetId)
      const all = [...getBuiltinPresets(), ...(await listJsonFilesAsync<Preset>(DIRS.presets()))]
      const preset = all.find((p) => p.id === presetId)
      if (!preset) { res.status(404).json({ error: '预设不存在' }); return }
      const { temperature, topP, maxTokens } = (req.body ?? {}) as {
        temperature?: number
        topP?: number
        maxTokens?: number
      }
      let updated: Preset = { ...preset }
      if (typeof temperature === 'number') updated.temperature = temperature
      if (typeof topP === 'number') updated.topP = topP
      if (typeof maxTokens === 'number') updated.maxTokens = maxTokens
      let createdCopy = false
      if (updated.isBuiltin) {
        updated = { ...updated, id: nanoid(), name: `${updated.name} (副本)`, isBuiltin: false }
        createdCopy = true
      }
      writeJson(join(DIRS.presets(), `${updated.id}.json`), updated)
      res.json({ ok: true, presetId: updated.id, createdCopy })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  router.get('/sessions/:sessionId/lorebooks', async (req, res) => {
    try {
      const session = await findSessionById(safeId(req.params.sessionId))
      if (!session) { res.status(404).json({ error: '会话不存在' }); return }
      res.json({ lorebookIds: session.lorebookIds ?? [] })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  router.patch('/sessions/:sessionId/lorebooks', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const session = await findSessionById(sessionId)
      if (!session) { res.status(404).json({ error: '会话不存在' }); return }
      const { lorebookIds } = (req.body ?? {}) as { lorebookIds?: string[] }
      if (!Array.isArray(lorebookIds)) { res.status(400).json({ error: '缺少 lorebookIds' }); return }
      const updated = await chatData.updateSession(session.characterId, sessionId, { lorebookIds })
      notifySessionChanged(sessionId, 'message')
      res.json({ ok: true, lorebookIds: updated.lorebookIds ?? [] })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  router.get('/sessions/:sessionId/preset', async (req, res) => {
    try {
      const session = await findSessionById(safeId(req.params.sessionId))
      if (!session) { res.status(404).json({ error: '会话不存在' }); return }
      const character = getCharacter(session.characterId)
      const settings = readJson<Settings>(join(DIRS.config(), 'settings.json'), 'settings') ?? getDefaultSettings()
      // 优先级：角色绑定预设 > 全局 activePresetId
      const presetId = character?.boundPresetId ?? settings.activePresetId ?? null
      res.json({ presetId })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  router.patch('/sessions/:sessionId/preset', async (req, res) => {
    try {
      const session = await findSessionById(safeId(req.params.sessionId))
      if (!session) { res.status(404).json({ error: '会话不存在' }); return }
      const { presetId } = (req.body ?? {}) as { presetId?: string | null }
      const file = join(DIRS.config(), 'settings.json')
      const settings = readJson<Settings>(file, 'settings') ?? getDefaultSettings()
      settings.activePresetId = presetId ?? null
      writeJson(file, settings, 'settings')
      res.json({ ok: true, presetId: settings.activePresetId })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  router.get('/sessions', async (_req, res) => {
    try {
      const sessions = await listAllSessions()
      const chars = await listCharacters()
      const nameById = new Map(chars.map((c) => [c.id, c.name]))
      res.json(sessions.map((s) => ({
        id: s.id,
        characterId: s.characterId,
        characterName: nameById.get(s.characterId) ?? '',
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messageCount,
        lastMessage: s.lastMessage,
      })))
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  /** 新建对话（P0 功能：安卓端「+」新建会话） */
  router.post('/sessions', async (req, res) => {
    try {
      const { characterId, title, greeting } = (req.body ?? {}) as { characterId?: string; title?: string; greeting?: string }
      if (!characterId) {
        res.status(400).json({ error: '缺少 characterId' })
        return
      }
      const character = getCharacter(safeId(characterId))
      if (!character) {
        res.status(404).json({ error: '角色不存在' })
        return
      }
      const session = await chatData.createSession(
        character.id,
        title && title.trim() ? title.trim() : undefined,
      )
      // 新建会话可选插入开场白（首条消息）：对齐 PC 端 insertGreetingMessage
      let firstMessageContent = ''
      if (typeof greeting === 'string' && greeting.trim()) {
        const settings = readJson<Settings>(join(DIRS.config(), 'settings.json'), 'settings') ?? getDefaultSettings()
        firstMessageContent = replaceVariables(greeting.trim(), settings.userName, character.name)
        const firstMsg: Message = {
          id: nanoid(),
          sessionId: session.id,
          characterId: character.id,
          role: 'assistant',
          content: firstMessageContent,
          images: [],
          isEditing: false,
          timestamp: Date.now(),
        }
        chatData.saveMessage(character.id, firstMsg)
      }
      notifySessionChanged(session.id, 'created')
      res.json({
        id: session.id,
        characterId: session.characterId,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: firstMessageContent ? 1 : 0,
        lastMessage: firstMessageContent.slice(0, 50),
      })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // ===== 会话与消息 =====

  router.get('/sessions/:sessionId/messages', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const session = await findSessionById(sessionId)
      if (!session) {
        res.status(404).json({ error: '会话不存在' })
        return
      }
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100)
      const beforeId = typeof req.query.beforeId === 'string' ? req.query.beforeId : undefined
      const all = chatData.readMessages(session.characterId, sessionId)
      // 时间降序（最新在前），cursor 分页
      const sorted = [...all].sort((a, b) => b.timestamp - a.timestamp)
      const startIndex = beforeId
        ? sorted.findIndex((m) => m.id === beforeId)
        : -1
      const sliceStart = startIndex >= 0 ? startIndex + 1 : 0
      const page = sorted.slice(sliceStart, sliceStart + limit)
      const nextCursor = sliceStart + limit < sorted.length
        ? sorted[sliceStart + limit - 1]?.id
        : null
      res.json({
        messages: page.map(toApiMessage),
        nextCursor,
      })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  router.post('/sessions/:sessionId/messages', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const { requestId, content, replyToId, images } = (req.body ?? {}) as {
        requestId?: string
        content?: string
        replyToId?: string
        images?: string[]
      }
      if (!requestId || typeof content !== 'string' || !content.trim()) {
        res.status(400).json({ error: '缺少 requestId 或 content' })
        return
      }
      // 图片：base64 数组（安卓端选图后压缩上传），数量与大小校验
      const safeImages = Array.isArray(images)
        ? images.filter((i): i is string => typeof i === 'string' && i.length > 0).slice(0, 8)
        : []
      // 流式响应标记：客户端通过 WS 接收 chunk，REST 仅返回用户消息
      const userMessage = await chatService.sendMessage(sessionId, requestId, content.trim(), replyToId, safeImages)
      res.json(toApiMessage(userMessage))
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  router.patch('/sessions/:sessionId', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const { title } = (req.body ?? {}) as { title?: string }
      if (!title || !title.trim()) {
        res.status(400).json({ error: '缺少标题' })
        return
      }
      const session = await findSessionById(sessionId)
      if (!session) {
        res.status(404).json({ error: '会话不存在' })
        return
      }
      await chatData.renameSession(session.characterId, sessionId, title.trim())
      notifySessionChanged(sessionId, 'title')
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  router.patch('/sessions/:sessionId/messages/:messageId', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const messageId = safeId(req.params.messageId)
      const session = await findSessionById(sessionId)
      if (!session) {
        res.status(404).json({ error: '会话不存在' })
        return
      }
      const messages = chatData.readMessages(session.characterId, sessionId)
      const target = messages.find((m) => m.id === messageId)
      if (!target) {
        res.status(404).json({ error: '消息不存在' })
        return
      }
      const { content } = (req.body ?? {}) as { content?: string }
      if (typeof content !== 'string') {
        res.status(400).json({ error: '缺少 content' })
        return
      }
      const updated: Message = { ...target, content }
      chatData.saveMessage(session.characterId, updated)
      notifySessionChanged(sessionId, 'message')
      res.json(toApiMessage(updated))
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  router.delete('/sessions/:sessionId/messages/:messageId', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const messageId = safeId(req.params.messageId)
      const session = await findSessionById(sessionId)
      if (!session) {
        res.status(404).json({ error: '会话不存在' })
        return
      }
      await chatData.deleteMessage(session.characterId, messageId, sessionId)
      notifySessionChanged(sessionId, 'message')
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  /** 清空对话（DELETE /sessions/:id/messages，对齐 PC 端 chat:clearChat） */
  router.delete('/sessions/:sessionId/messages', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const session = await findSessionById(sessionId)
      if (!session) { res.status(404).json({ error: '会话不存在' }); return }
      await chatData.clearChat(session.characterId, sessionId)
      notifySessionChanged(sessionId, 'message')
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  /** 删除整个会话（DELETE /sessions/:sessionId?characterId=xxx；多角色共用 sessionId 时用 characterId 精确定位） */
  router.delete('/sessions/:sessionId', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const characterId = typeof req.query.characterId === 'string' ? safeId(req.query.characterId) : undefined
      let session = null
      if (characterId) {
        const sessions = await chatData.listSessions(characterId)
        session = sessions.find((s) => s.id === sessionId) ?? null
      }
      if (!session) {
        session = await findSessionById(sessionId)
      }
      if (!session) { res.status(404).json({ error: '会话不存在' }); return }
      await chatData.deleteSession(session.characterId, sessionId)
      notifySessionChanged(sessionId, 'deleted')
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: sanitizeApiKey((e as Error).message) })
    }
  })

  /** AI 输入辅助（续写/润色，对齐渲染层 aiInputHelper） */
  router.post('/sessions/:sessionId/ai-assist', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const { type, content } = (req.body ?? {}) as { type?: string; content?: string }
      if (type !== 'continue' && type !== 'polish') {
        res.status(400).json({ error: 'type 必须为 continue 或 polish' })
        return
      }
      const session = await findSessionById(sessionId)
      if (!session) { res.status(404).json({ error: '会话不存在' }); return }
      const data = await mainContextProvider.fetchBuildData(session.characterId, sessionId)
      if (!data.character) { res.status(404).json({ error: '角色不存在' }); return }
      const profile = data.settings.profile
      if (!profile) { res.status(400).json({ error: '未配置 API 连接' }); return }
      const settings = data.settings.settings
      const charName = data.character.name
      const userName = settings.userName || '用户'
      const preset = data.preset
      const model = settings.activeModel || profile.model

      // 最近 6 条消息（与渲染层 slice(-6) 一致）
      const recent = chatData.readMessages(session.characterId, sessionId).slice(-6)

      let systemPrompt: string
      let userContent: string
      let temperature: number
      let maxTokens: number

      if (type === 'continue') {
        const hasInput = (content ?? '').trim().length > 0
        const ctx = buildContinueContext({
          character: data.character,
          userName,
          charName,
          recentMessages: recent,
          originalInput: content ?? '',
          hasInput,
        })
        systemPrompt = ctx[0].content
        userContent = ctx[ctx.length - 1].content
        temperature = 0.7
        maxTokens = 300
      } else {
        systemPrompt = '你是一个文字润色助手。请润色以下文本，修正语法、改善表达、使其更加流畅自然，但保持原意和语气不变。只输出润色后的文本，不要添加任何解释或额外内容。'
        userContent = content ?? ''
        temperature = 0.3
        maxTokens = 800
      }

      const params: ChatParams = {
        requestId: `ai-assist-${Date.now()}-${nanoid(4)}`,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        provider: profile.provider as ProviderType,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        model,
        temperature,
        topP: preset?.topP ?? 0.9,
        maxTokens,
        frequencyPenalty: preset?.frequencyPenalty ?? 0,
        presencePenalty: preset?.presencePenalty ?? 0,
        stream: false,
      }

      const full = await chatWithRetry(
        getAdapter(params.provider),
        params,
        () => {},
        new AbortController().signal,
        1,
      )
      // 续写需剥离角色视角（对齐渲染层 ensureUserPerspective）；两者都剥离 thought 块
      const cleaned = stripThought(full)
      const result = type === 'continue' ? ensureUserPerspective(cleaned, userName, charName) : cleaned
      res.json({ text: result })
    } catch (e) {
      res.status(500).json({ error: sanitizeApiKey((e as Error).message) })
    }
  })

  // ===== 长记忆管理 =====

  /** 读取会话记忆配置与内容 */
  router.get('/sessions/:sessionId/memory', async (req, res) => {
    try {
      const session = await findSessionById(safeId(req.params.sessionId))
      if (!session) { res.status(404).json({ error: '会话不存在' }); return }
      res.json({
        memoryEnabled: session.memoryEnabled ?? false,
        memoryMode: session.memoryMode ?? 'manual',
        autoMemoryInterval: session.autoMemoryInterval ?? 10,
        memory: session.memory ?? '',
        memoryFacts: session.memoryFacts ?? [],
        memoryUpdatedAt: session.memoryUpdatedAt ?? 0,
        messageCount: session.messageCount ?? 0,
      })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  /** 修改会话记忆配置（开关/模式/间隔） */
  router.patch('/sessions/:sessionId/memory', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const session = await findSessionById(sessionId)
      if (!session) { res.status(404).json({ error: '会话不存在' }); return }
      const { memoryEnabled, memoryMode, autoMemoryInterval, memory, memoryFacts } = (req.body ?? {}) as {
        memoryEnabled?: boolean
        memoryMode?: 'manual' | 'auto'
        autoMemoryInterval?: number
        memory?: string
        memoryFacts?: string[]
      }
      const updates: Record<string, unknown> = {}
      if (typeof memoryEnabled === 'boolean') updates.memoryEnabled = memoryEnabled
      if (memoryMode === 'manual' || memoryMode === 'auto') updates.memoryMode = memoryMode
      if (typeof autoMemoryInterval === 'number') updates.autoMemoryInterval = autoMemoryInterval
      if (typeof memory === 'string') updates.memory = memory
      if (Array.isArray(memoryFacts)) updates.memoryFacts = memoryFacts
      await chatData.updateSession(session.characterId, sessionId, updates)
      notifySessionChanged(sessionId, 'message')
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  /** 触发长记忆总结（对齐渲染层 runMemorySummary：最近 20 条非 system 消息 + 前次摘要/事实合并） */
  router.post('/sessions/:sessionId/memory/summarize', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const session = await findSessionById(sessionId)
      if (!session) { res.status(404).json({ error: '会话不存在' }); return }
      if (!session.memoryEnabled) { res.status(400).json({ error: '长记忆未开启' }); return }
      const data = await mainContextProvider.fetchBuildData(session.characterId, sessionId)
      if (!data.character) { res.status(404).json({ error: '角色不存在' }); return }
      const profile = data.settings.profile
      if (!profile) { res.status(400).json({ error: '未配置 API 连接' }); return }
      const settings = data.settings.settings
      const userName = settings.userName || '用户'
      const charName = data.character.name

      const recent = chatData.readMessages(session.characterId, sessionId)
        .filter((m) => m.role !== 'system')
        .slice(-20)
      if (recent.length < 4) { res.status(400).json({ error: '消息太少，暂不总结' }); return }

      const messagesText = recent
        .map((m) => `${m.role === 'user' ? userName : charName}: ${m.content}`)
        .join('\n')
      const previousMemory = session.memory || '无'
      const previousFactsText = (session.memoryFacts ?? []).length > 0
        ? (session.memoryFacts ?? []).map((f, i) => `${i + 1}. ${f}`).join('\n')
        : '无'

      const systemPrompt = `你是一个角色扮演对话总结助手。请总结以下${charName}与${userName}之间的对话，并抽取关键事实。\n\n输出格式（严格按此格式）：\n【摘要】\n2-4 句简洁摘要，覆盖：主要事件、情节进展、角色关系演变、当前未解决的问题。\n\n【事实】\n1. 具体事实\n2. 具体事实\n\n要求：\n- 事实必须是对话中确立的、对未来有参考价值的持久信息（人名、身份、地点、物品、目标、约定、关系等），不要写临时情绪或过场细节。\n- 合并之前的事实：保留仍有效的事实，更新已变化的事实，删除已被推翻的事实，补充新事实。\n- 只输出上述格式内容，不要添加任何解释或评价。\n\n之前的摘要：\n${previousMemory}\n\n之前的事实：\n${previousFactsText}`

      const params: ChatParams = {
        requestId: `memory-summary-${Date.now()}`,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `新对话内容：\n${messagesText}` },
        ],
        provider: profile.provider as ProviderType,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        model: settings.activeModel || profile.model,
        temperature: 0.3,
        topP: 0.9,
        maxTokens: 2048,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stream: false,
      }

      const full = await chatWithRetry(getAdapter(params.provider), params, () => {}, new AbortController().signal, 1)
      const parsed = parseMemoryResult(full)
      if (parsed.summary) {
        await chatData.updateMemory(session.characterId, sessionId, parsed.summary)
        if (parsed.facts.length > 0) {
          await chatData.updateSession(session.characterId, sessionId, { memoryFacts: parsed.facts })
        }
        notifySessionChanged(sessionId, 'message')
      }
      res.json({ ok: true, summary: parsed.summary, facts: parsed.facts })
    } catch (e) {
      res.status(500).json({ error: sanitizeApiKey((e as Error).message) })
    }
  })

  /** 上下文用量（对齐渲染层 P1-3：used/max/ratio，≥0.85 预警，≥1 危险） */
  router.get('/sessions/:sessionId/context-usage', async (req, res) => {
    try {
      const session = await findSessionById(safeId(req.params.sessionId))
      if (!session) { res.status(404).json({ error: '会话不存在' }); return }
      const data = await mainContextProvider.fetchBuildData(session.characterId, session.id)
      if (!data.character) { res.status(404).json({ error: '角色不存在' }); return }
      const { lastContextUsage } = buildContextMessagesFromData(data)
      if (!lastContextUsage || lastContextUsage.max <= 0) {
        res.json({ used: 0, max: 0, ratio: 0, pct: 0 })
        return
      }
      const ratio = lastContextUsage.used / lastContextUsage.max
      res.json({
        used: lastContextUsage.used,
        max: lastContextUsage.max,
        ratio,
        pct: Math.min(999, Math.round(ratio * 100)),
      })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  router.post('/sessions/:sessionId/swipe', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const messageId = typeof req.query.messageId === 'string' ? safeId(req.query.messageId) : undefined
      const direction = Number(req.query.direction) || 0
      if (!messageId) {
        res.status(400).json({ error: '缺少 messageId' })
        return
      }
      const message = await chatService.swipe(sessionId, messageId, direction)
      res.json(toApiMessage(message))
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  router.post('/sessions/:sessionId/translate', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const messageId = typeof req.query.messageId === 'string' ? safeId(req.query.messageId) : undefined
      if (!messageId) {
        res.status(400).json({ error: '缺少 messageId' })
        return
      }
      const result = await chatService.translate(sessionId, messageId)
      res.json(result)
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // ===== 快捷回复 =====

  router.get('/quickReplies', async (_req, res) => {
    try {
      // 与 quickReply:list 同一数据源：全局 + 按角色文件
      const globalDir = join(DIRS.config(), 'quickReplies')
      const global = await listJsonFilesAsync<QuickReply>(globalDir)
      res.json({ global, byCharacter: [] })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  router.post('/quickReplies/:id/execute', async (req, res) => {
    try {
      const id = safeId(req.params.id)
      const all = await listJsonFilesAsync<QuickReply>(join(DIRS.config(), 'quickReplies'))
      const qr = all.find((q) => q.id === id)
      if (!qr) {
        res.status(404).json({ error: '快捷回复不存在' })
        return
      }
      if (qr.action === 'text') {
        // 需要目标会话：由 query 指定；缺省回退最近会话
        const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined
        const sessions = await listAllSessions()
        const target = sessionId
          ? sessions.find((s) => s.id === sessionId) ?? null
          : sessions[0] ?? null
        if (!target) {
          res.status(400).json({ error: '无可用会话' })
          return
        }
        const requestId = `qr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const userMessage = await chatService.sendMessage(target.id, requestId, qr.content)
        res.json({ ok: true, message: toApiMessage(userMessage) })
        return
      }
      // preset/command 类型需渲染层执行上下文，桥接层不支持（安卓端会提示）
      res.status(501).json({ error: '该类型快捷回复需 PC 端执行' })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // ===== 角色激活（协议假设）=====

  router.post('/characters/:characterId/activate', async (req, res) => {
    try {
      const characterId = safeId(req.params.characterId)
      const character = getCharacter(characterId)
      if (!character) {
        res.status(404).json({ error: '角色不存在' })
        return
      }
      // 更新 settings.activeCharacterId + 创建新会话（对齐"设为当前角色"语义）
      const settingsFile = join(DIRS.config(), 'settings.json')
      const settings = readJson<Settings>(settingsFile, 'settings') ?? getDefaultSettings()
      settings.activeCharacterId = characterId
      writeJson(settingsFile, settings, 'settings')
      const session = await chatData.createSession(characterId)
      notifySessionChanged(session.id, 'created')
      res.json({ ok: true, sessionId: session.id })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // ===== TTS 音频流（方案 §3.3：PC 中转，Edge/OpenAI 合成，支持 Range） =====

  router.get('/sessions/:sessionId/messages/:messageId/tts', handleTts)

  // ===== 用量统计（阶段三：安卓端只读） =====

  router.get('/usage/summary', (_req, res) => {
    try {
      const now = new Date()
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      const today = getSummary({ startTs: todayStart })
      const total = getSummary()
      res.json({ today, total })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  router.get('/usage/records', (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)
      const records = queryUsage({})
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit)
      res.json(records)
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // ===== 公告（阶段三：安卓端同步，走 PC 侧公告服务器 + 缓存回退） =====

  router.get('/announcements', async (req, res) => {
    try {
      const page = Number(req.query.page) || 1
      const pageSize = Number(req.query.pageSize) || 20
      const data = await fetchAnnouncementList(page, pageSize)
      res.json(data)
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // ===== 版本检查（阶段三：安卓端从公告服务器获取最新版本号） =====

  router.get('/version', async (_req, res) => {
    try {
      const data = await fetchVersionInfo()
      res.json(data)
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // ===== 群聊（阶段二：查看与发言；AI 群聊回复依赖渲染层引擎，二期） =====

  router.get('/groups', (_req, res) => {
    try {
      const groups = groupData.listGroups()
      res.json(groups.map((g) => ({
        id: g.id,
        name: g.name,
        memberIds: g.memberIds,
        chatMode: g.chatMode,
        autoMode: g.autoMode,
        maxRounds: g.maxRounds,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
      })))
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  /** 新建群聊（POST /groups；memberIds 至少 1 个角色） */
  router.post('/groups', async (req, res) => {
    try {
      const { name, memberIds } = (req.body ?? {}) as { name?: string; memberIds?: string[] }
      if (!Array.isArray(memberIds) || memberIds.length === 0 || memberIds.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id))) {
        res.status(400).json({ error: 'memberIds 必须为角色 id 数组且至少 1 个' })
        return
      }
      const now = Date.now()
      const group: GroupChat = {
        id: nanoid(),
        name: (name ?? '').trim() || '新群聊',
        memberIds: [...new Set(memberIds)],
        currentSpeakerIndex: 0,
        autoMode: true,
        chatMode: 'polling',
        maxRounds: 4,
        speakerInterval: 10,
        lorebookIds: [],
        presetId: null,
        systemPrompt: '',
        createdAt: now,
        updatedAt: now,
      }
      await groupData.saveGroup(group)
      res.json({ id: group.id, name: group.name, memberIds: group.memberIds })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  /** 修改群聊设置（PATCH /groups/:groupId：模式/轮次/自动/主题色/气泡透明度/名字） */
  router.patch('/groups/:groupId', async (req, res) => {
    try {
      const groupId = safeId(req.params.groupId)
      const group = groupData.listGroups().find((g) => g.id === groupId)
      if (!group) { res.status(404).json({ error: '群聊不存在' }); return }
      const { name, chatMode, autoMode, maxRounds, speakerInterval, themeColor, bubbleOpacity, systemPrompt } = (req.body ?? {}) as {
        name?: string
        chatMode?: 'mention' | 'polling' | 'free'
        autoMode?: boolean
        maxRounds?: number
        speakerInterval?: number
        themeColor?: string
        bubbleOpacity?: number
        systemPrompt?: string
      }
      const updated: GroupChat = { ...group }
      if (typeof name === 'string' && name.trim()) updated.name = name.trim()
      if (chatMode === 'mention' || chatMode === 'polling' || chatMode === 'free') updated.chatMode = chatMode
      if (typeof autoMode === 'boolean') updated.autoMode = autoMode
      if (typeof maxRounds === 'number') updated.maxRounds = maxRounds
      if (typeof speakerInterval === 'number') updated.speakerInterval = speakerInterval
      if (typeof themeColor === 'string') updated.themeColor = themeColor
      if (typeof bubbleOpacity === 'number') updated.bubbleOpacity = bubbleOpacity
      if (typeof systemPrompt === 'string') updated.systemPrompt = systemPrompt
      await groupData.saveGroup(updated)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  /** 添加群聊成员（POST /groups/:groupId/members） */
  router.post('/groups/:groupId/members', async (req, res) => {
    try {
      const groupId = safeId(req.params.groupId)
      const group = groupData.listGroups().find((g) => g.id === groupId)
      if (!group) { res.status(404).json({ error: '群聊不存在' }); return }
      const { characterIds } = (req.body ?? {}) as { characterIds?: string[] }
      if (!Array.isArray(characterIds)) { res.status(400).json({ error: '缺少 characterIds' }); return }
      const safeIds = characterIds.filter((id) => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id))
      await groupData.saveGroup({ ...group, memberIds: [...new Set([...group.memberIds, ...safeIds])] })
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  /** 删除群聊成员（DELETE /groups/:groupId/members/:charId） */
  router.delete('/groups/:groupId/members/:charId', async (req, res) => {
    try {
      const groupId = safeId(req.params.groupId)
      const charId = safeId(req.params.charId)
      const group = groupData.listGroups().find((g) => g.id === groupId)
      if (!group) { res.status(404).json({ error: '群聊不存在' }); return }
      await groupData.saveGroup({ ...group, memberIds: group.memberIds.filter((id) => id !== charId) })
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  router.get('/groups/:groupId/sessions', async (req, res) => {
    try {
      const sessions = await groupData.listSessions(safeId(req.params.groupId))
      res.json(sessions.map((s) => ({
        id: s.id,
        groupId: s.groupId,
        title: s.title,
        messageCount: s.messageCount,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })))
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  router.get('/groups/:groupId/sessions/:sessionId/messages', (req, res) => {
    try {
      const groupId = safeId(req.params.groupId)
      const sessionId = safeId(req.params.sessionId)
      const messages = groupData.readMessages(groupId, sessionId)
      res.json(messages.map((m) => ({
        id: m.id,
        groupId: m.groupId,
        characterId: m.characterId,
        content: m.content,
        images: (m.images ?? []).map((img, i) =>
          img.startsWith('http') ? img : `/static/group-messages/${groupId}/${sessionId}/${m.id}/${i}`
        ),
        timestamp: m.timestamp,
        round: m.round,
        translation: m.translation ?? null,
        replyToId: m.replyToId ?? null,
      })))
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  /** 群聊发言：用户消息落盘（characterId='__user__'） */
  router.post('/groups/:groupId/sessions/:sessionId/messages', async (req, res) => {
    try {
      const groupId = safeId(req.params.groupId)
      const sessionId = safeId(req.params.sessionId)
      const { content, requestId, images, mentionedCharacterIds } = (req.body ?? {}) as {
        content?: string
        requestId?: string
        images?: string[]
        mentionedCharacterIds?: string[]
      }
      if (typeof content !== 'string' || !content.trim()) {
        res.status(400).json({ error: '缺少 content' })
        return
      }
      const message = {
        id: requestId && typeof requestId === 'string' && requestId.length > 0
          ? safeId(requestId)
          : `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        groupId,
        characterId: '__user__',
        content: content.trim(),
        images: Array.isArray(images) ? images.slice(0, 8) : [],
        timestamp: Date.now(),
        round: 0,
        mentionedCharacterIds: Array.isArray(mentionedCharacterIds)
          ? mentionedCharacterIds
          : undefined,
      }
      groupData.appendMessage(groupId, sessionId, message)
      notifySessionChanged(sessionId, 'message')
      res.json({ ok: true, messageId: message.id })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  /** 新建群聊会话（POST /groups/:groupId/sessions） */
  router.post('/groups/:groupId/sessions', async (req, res) => {
    try {
      const groupId = safeId(req.params.groupId)
      if (!groupData.listGroups().some((g) => g.id === groupId)) {
        res.status(404).json({ error: '群聊不存在' }); return
      }
      const session = await groupData.createSession(groupId)
      notifySessionChanged(session.id, 'created')
      res.json({
        id: session.id,
        groupId: session.groupId,
        title: session.title,
        messageCount: 0,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  /** 重命名群聊会话（PATCH /groups/:groupId/sessions/:sessionId） */
  router.patch('/groups/:groupId/sessions/:sessionId', async (req, res) => {
    try {
      const groupId = safeId(req.params.groupId)
      const sessionId = safeId(req.params.sessionId)
      const { title } = (req.body ?? {}) as { title?: string }
      if (!title || !title.trim()) { res.status(400).json({ error: '缺少标题' }); return }
      await groupData.renameSession(groupId, sessionId, title.trim())
      notifySessionChanged(sessionId, 'title')
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  /** 编辑群聊消息（PATCH /groups/:groupId/sessions/:sessionId/messages/:messageId） */
  router.patch('/groups/:groupId/sessions/:sessionId/messages/:messageId', async (req, res) => {
    try {
      const groupId = safeId(req.params.groupId)
      const sessionId = safeId(req.params.sessionId)
      const messageId = safeId(req.params.messageId)
      const { content } = (req.body ?? {}) as { content?: string }
      if (typeof content !== 'string') { res.status(400).json({ error: '缺少 content' }); return }
      const messages = groupData.readMessages(groupId, sessionId)
      const target = messages.find((m) => m.id === messageId)
      if (!target) { res.status(404).json({ error: '消息不存在' }); return }
      groupData.updateMessage(groupId, sessionId, { ...target, content })
      notifySessionChanged(sessionId, 'message')
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  /** 删除群聊消息（DELETE /groups/:groupId/sessions/:sessionId/messages/:messageId） */
  router.delete('/groups/:groupId/sessions/:sessionId/messages/:messageId', async (req, res) => {
    try {
      const groupId = safeId(req.params.groupId)
      const sessionId = safeId(req.params.sessionId)
      const messageId = safeId(req.params.messageId)
      await groupData.deleteMessage(groupId, sessionId, messageId)
      notifySessionChanged(sessionId, 'message')
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  /** 群聊上下文构建（桥接层简化版，对齐 buildGroupChatContext 核心：Overview + 模式规则 + 角色设定 + 历史） */
  function buildGroupContextForBridge(
    group: { name: string; chatMode: 'mention' | 'polling' | 'free'; systemPrompt?: string },
    members: Array<{ id: string; name: string; description?: string; personality?: string; scenario?: string; systemPrompt?: string }>,
    messages: Array<{ characterId: string; content: string }>,
    speaker: { id: string; name: string } | null,
    userName: string,
  ): { systemContent: string; history: { role: 'user' | 'assistant'; content: string }[] } {
    const targetName = speaker?.name || members.map((m) => m.name).join('、')
    let systemContent = `你正在参与一个群聊「${group.name}」。本群聊中共有 ${members.length} 个角色参与对话：\n`
    members.forEach((m, i) => {
      const desc = m.description ? ' - ' + m.description.slice(0, 80) : ''
      systemContent += `${i + 1}. 【${m.name}】${desc}\n`
    })
    systemContent += `\n用户「${userName}」也在群聊中。\n`

    switch (group.chatMode) {
      case 'mention':
        systemContent += '\n【对话规则】用户通过 @角色名 指定回复对象。只有被点名的角色才需要回复。回复时请以该角色的第一人称视角发言，不要替其他角色说话。\n'
        break
      case 'polling':
        systemContent += '\n【对话规则】当前采用自动轮询模式。每次只轮到一位角色发言。请以该角色的第一人称视角回复，不要替其他角色或用户发言。\n'
        break
      default:
        systemContent += '\n【对话规则】自由模式。请以角色的身份自然地参与对话。\n'
    }

    if (group.systemPrompt) {
      systemContent += '\n' + replaceVars(group.systemPrompt, userName, targetName) + '\n'
    }

    if (speaker) {
      const t = members.find((m) => m.id === speaker.id)
      systemContent += `\n\n【当前发言角色：${speaker.name}】\n`
      if (t?.description) systemContent += `描述：${replaceVars(t.description, userName, speaker.name)}\n`
      if (t?.personality) systemContent += `性格：${replaceVars(t.personality, userName, speaker.name)}\n`
      if (t?.scenario) systemContent += `场景：${replaceVars(t.scenario, userName, speaker.name)}\n`
      if (t?.systemPrompt) systemContent += `\n${replaceVars(t.systemPrompt, userName, speaker.name)}\n`
    }

    // 历史消息（最近 30 条，角色名标注）
    const history = messages.slice(-30).map((m) => {
      const role = m.characterId === '__user__' ? 'user' as const : 'assistant' as const
      const name = m.characterId === '__user__'
        ? userName
        : (members.find((mm) => mm.id === m.characterId)?.name ?? '未知角色')
      return { role, content: `【${name}】${m.content}` }
    })
    return { systemContent, history }
  }

  /** 群聊 AI 回复（对齐渲染层 streamGroupAI：构建上下文 -> AI 生成 -> 落盘） */
  router.post('/groups/:groupId/sessions/:sessionId/ai-reply', async (req, res) => {
    try {
      const groupId = safeId(req.params.groupId)
      const sessionId = safeId(req.params.sessionId)
      const { speakerId } = (req.body ?? {}) as { speakerId?: string }

      const group = groupData.listGroups().find((g) => g.id === groupId)
      if (!group) { res.status(404).json({ error: '群聊不存在' }); return }
      const members = group.memberIds.map((id) => getCharacter(id)).filter((c): c is NonNullable<typeof c> => !!c)
      if (members.length === 0) { res.status(400).json({ error: '群聊无成员' }); return }

      const settings = readJson<Settings>(join(DIRS.config(), 'settings.json'), 'settings') ?? getDefaultSettings()
      restoreSecrets(settings)
      const profile = settings.connectionProfiles?.find((p) => p.id === settings.activeProfileId)
      if (!profile) { res.status(400).json({ error: '未配置 API 连接' }); return }
      const userName = settings.userName || '用户'

      const messages = groupData.readMessages(groupId, sessionId)
      const round = messages.reduce((mx, m) => Math.max(mx, m.round ?? 0), 0) + 1

      // 发言人：指定优先，否则按轮次轮转
      let speaker = speakerId ? (members.find((m) => m.id === speakerId) ?? null) : null
      if (!speaker) {
        speaker = members[(round - 1) % members.length]
      }
      if (!speaker) { res.status(500).json({ error: '发言人选择失败' }); return }

      const { systemContent, history } = buildGroupContextForBridge(
        group,
        members,
        messages,
        speaker,
        userName,
      )

      const params: ChatParams = {
        requestId: `group-ai-${Date.now()}-${nanoid(4)}`,
        messages: [
          { role: 'system', content: systemContent },
          ...history,
        ],
        provider: profile.provider as ProviderType,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        model: settings.activeModel || profile.model,
        temperature: 0.8,
        topP: 0.95,
        maxTokens: 2048,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stream: false,
      }

      const full = await chatWithRetry(getAdapter(params.provider), params, () => {}, new AbortController().signal, 1)
      const clean = full.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()

      const aiMsg = {
        id: nanoid(),
        groupId,
        characterId: speaker.id,
        content: clean || '(无回复)',
        images: [],
        timestamp: Date.now(),
        round,
      }
      groupData.appendMessage(groupId, sessionId, aiMsg)
      notifySessionChanged(sessionId, 'message')
      res.json({ message: aiMsg })
    } catch (e) {
      res.status(500).json({ error: sanitizeApiKey((e as Error).message) })
    }
  })

  /** 翻译群聊消息（POST /groups/:groupId/sessions/:sessionId/translate?messageId=xxx，对齐单聊 translate 的 prompt 与参数） */
  router.post('/groups/:groupId/sessions/:sessionId/translate', async (req, res) => {
    try {
      const groupId = safeId(req.params.groupId)
      const sessionId = safeId(req.params.sessionId)
      const messageId = typeof req.query.messageId === 'string' ? safeId(req.query.messageId) : undefined
      if (!messageId) { res.status(400).json({ error: '缺少 messageId' }); return }
      const messages = groupData.readMessages(groupId, sessionId)
      const target = messages.find((m) => m.id === messageId)
      if (!target) { res.status(404).json({ error: '目标消息不存在' }); return }

      const settings = readJson<Settings>(join(DIRS.config(), 'settings.json'), 'settings') ?? getDefaultSettings()
      restoreSecrets(settings)
      const profile = settings.connectionProfiles?.find((p) => p.id === settings.activeProfileId)
      if (!profile) { res.status(400).json({ error: '未配置 API 连接' }); return }
      const targetLang = settings.translationTargetLang || '中文'
      const provider = (profile.provider || 'openai') as ProviderType

      const translation = await chatWithRetry(
        getAdapter(provider),
        {
          requestId: `translate-${messageId}-${Date.now()}`,
          messages: [
            { role: 'system', content: `你是一个翻译助手。请将以下文本翻译成${targetLang}。只输出翻译结果，不要添加任何解释或额外内容。保留原文中的 Markdown 格式、HTML 标签和特殊符号不变。` },
            { role: 'user', content: target.content },
          ],
          provider,
          apiKey: profile.apiKey,
          baseUrl: profile.baseUrl,
          model: settings.activeModel || profile.model,
          temperature: 0.3,
          topP: 0.9,
          maxTokens: Math.max(256, Math.min(target.content.length, 4000)),
          frequencyPenalty: 0,
          presencePenalty: 0,
          stream: true,
        },
        () => {},
        new AbortController().signal,
        0,
      )
      // 落盘 translation（对齐群聊渲染层：同 id 覆盖式写回）
      groupData.updateMessage(groupId, sessionId, { ...target, translation })
      res.json({ messageId, translation })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // ===== 设备管理（供 PC 端设置页）=====

  router.get('/devices', (_req, res) => {
    res.json(listDevices())
  })

  router.delete('/devices/:deviceId', (req, res) => {
    try {
      const ok = revokeDevice(safeId(req.params.deviceId))
      res.json({ ok })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  return router
}

/** 消息转安卓端 DTO：images base64 转静态路由 URL（避免分页响应过大，§4.3） */
export function toApiMessage(message: Message): Record<string, unknown> {
  return {
    id: message.id,
    sessionId: message.sessionId,
    characterId: message.characterId,
    role: message.role,
    content: message.content,
    images: (message.images ?? []).map((img, i) => imageToUrl(message.characterId, message.sessionId, message.id, i, img)),
    timestamp: message.timestamp,
    translation: message.translation ?? null,
    swipes: message.swipes ?? null,
    swipeIndex: message.swipeIndex ?? null,
    replyToId: message.replyToId ?? null,
    usage: message.charUsage
      ? {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        }
      : null,
  }
}

/** 图片：base64 转白名单静态路由（无对应路由时保留原样） */
function imageToUrl(characterId: string, sessionId: string, messageId: string, index: number, image: string): string {
  if (image.startsWith('http://') || image.startsWith('https://')) return image
  return `/static/messages/${characterId}/${sessionId}/${messageId}/${index}`
}

export { getPendingPair, settlePair, verifyToken }
