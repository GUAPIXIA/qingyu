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
import { readJson, writeJson, listJsonFilesAsync, DIRS, withFileLock } from '../services/storage'
import { bridgeJournalPut, bridgeJournalDelete } from './bridgeJournal'
import { getCharacter } from '../services/charCard'
import { listLorebookViews } from '../services/lorebookDocumentStore'
import { chatData } from '../ipc/chat'
import { groupData } from '../ipc/group'
import { getBuiltinPresets } from '../ipc/preset'

import { getSummary, queryUsage } from '../services/usage'
import { fetchAnnouncementList, fetchVersionInfo } from '../ipc/announcement'
import { readStore as readQuickReplyStore } from '../ipc/quickReply'
import { restoreSecrets } from '../ipc/settings'
import {
  buildSettingsSnapshot,
  validateSettingsPatch,
  type MobileSafeSettings,
  type SettingsPatchRequest,
  type SettingsPatchResponse,
  type SettingsValidationContext,
} from './settingsSync'
import { emitSettingsChanged } from '../services/settingsChangeBus'
import { API_VERSION as PROTOCOL_API_VERSION } from './protocol'
import { chatWithRetry, getAdapter } from '../services/ai'
import { mainContextProvider } from '../context/mainContextProvider'
import { buildContextMessagesFromData } from '../../shared/chat-core/contextBuilder'
import { buildContinueContext, ensureUserPerspective } from '../../shared/chat-core/aiInputHelper'
import { stripThought, trimContinuationSeam } from '../../shared/chat-core/messagePostProcess'
import { getDefaultSettings } from '../../shared/defaults'
import { stripAllThinking } from '../../shared/thoughtMarkup'
import { DEFAULT_AUTO_MEMORY_INTERVAL } from '../../shared/defaultMemory'
import { normalizePreset } from '../../shared/preset'
import { nanoid } from 'nanoid'
import { replaceVariables } from '../../shared/chat-core/variables'
import {
  consumePairingCode,
  enqueuePendingPair,
  getPendingPair,
  registerDevice,
  settlePair,
  signToken,
  verifyAuthorizedToken,
  verifyToken,
  listDevices,
  revokeDevice,
  touchDevice,
} from './auth'
import { WsHub } from './ws'
import { BridgeChatService, type SessionChangedNotifier } from './chatService'
import { listAllSessions, findSessionByCharacterId, findSessionById } from './sessionsIndex'
import { handleGroupTts, handleTts } from './ttsHandler'
import { safeId } from '../utils/pathGuard'
import { sanitizeApiKey } from '../utils/pathGuard'
import { createLogger } from '../services/logger'
import type { Request, Response, NextFunction } from 'express'
import type { Message, Settings, Preset, ChatParams, ProviderType, GroupChat, MemoryFactRecord, Persona } from '../../shared/types'
import type { NarrativeMode } from '../../shared/types'
import { DEFAULT_OMNISCIENT_NARRATIVE_RULES, isNarrativeMode, resolveNarrativeMode } from '../../shared/narrativeMode'
import { resolveMessageGenerationKind, resolveMessageSpeakerKind } from '../../shared/messageIdentity'
import { DefaultMobileFacade, type MobileFacade } from './runtime/mobileFacade'
import { GenerationRegistry } from './runtime/generationRegistry'
import { buildGroupContextForBridge } from './groupContext'
import { resolveDialogueDirectionsEnabled } from '../../shared/dialogueDirections'
import { memorySummaryService } from '../services/memorySummaryService'

/** 会话 DTO 的方向开关字段：新字段 + 兼容期镜像旧字段，旧客户端也能正确显示与切换。 */
function dialogueDirectionFields(session?: Parameters<typeof resolveDialogueDirectionsEnabled>[0]): {
  dialogueDirectionsEnabled: boolean
  gameMasterMode: boolean
} {
  const enabled = resolveDialogueDirectionsEnabled(session)
  return { dialogueDirectionsEnabled: enabled, gameMasterMode: enabled }
}

const log = createLogger('bridge-routes')

/** 版本协商：与安卓端 SUPPORTED_API_VERSION 对齐（常量迁移至 protocol.ts，此处 re-export 保持兼容） */
export const API_VERSION = PROTOCOL_API_VERSION

/** 配对确认等待超时（安卓端 readTimeout 60s 内） */
const PAIR_WAIT_TIMEOUT_MS = 55_000

/**
 * 旧数据可能在不同角色下复用 default 会话 ID；移动端传 characterId 时必须优先精确定位。
 * 未传时保留旧协议的回退行为，保证旧客户端可继续使用。
 */
async function resolveSession(req: Request, sessionId: string) {
  const characterId = typeof req.query.characterId === 'string' ? safeId(req.query.characterId) : undefined
  return characterId
    ? findSessionByCharacterId(characterId, sessionId)
    : findSessionById(sessionId)
}

/** 历史文本发生改写后，撤销所有由旧历史推导出的记忆字段。 */
async function invalidateSessionMemory(characterId: string, sessionId: string): Promise<void> {
  await chatData.updateSession(characterId, sessionId, {
    memory: '',
    memoryCurrentState: '',
    memoryFacts: [],
    memoryFactHistory: [],
    memoryFactParseFailureCount: 0,
    memoryFactRetryAfterVersion: 0,
    factsVectors: [],
    memoryUpdatedAt: 0,
    memoryLastMessageId: null,
    memoryVersion: 0,
    factsVectorVersion: 0,
    compressedSummary: null,
    compressedRange: null,
  })
}

/** 校验 Bearer 令牌的中间件（JWT 校验 + 设备仍存在校验：吊销立即生效） */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const payload = verifyAuthorizedToken(token)
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
export function originGuard(req: Request, res: Response, next: NextFunction): void {
  const ua = (req.headers['user-agent'] ?? '').toLowerCase()
  const isBrowser = /mozilla|chrome|safari|firefox|edg/i.test(ua) && !ua.includes('qingyu-companion')
  const origin = req.headers.origin
  if (isBrowser) {
    // M-12 修复：此前 startsWith('http://127.0.0.1') 可被 http://127.0.0.1.evil.com 绕过——
    // 改为 URL 解析后精确校验 host（localhost / 127.0.0.1 / [::1]）
    const allowed = origin && (() => {
      try {
        const u = new URL(origin)
        return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]' || u.hostname === '::1'
      } catch {
        return false
      }
    })()
    if (origin && !allowed) {
      res.status(403).json({ error: 'origin rejected' })
      return
    }
    // 无 Origin 的浏览器请求（<img>/<script> 等 no-cors 标签或顶层导航）读取不到响应体
    // （CORS 限制），且 <img>/<script> 无法携带 Authorization 头——放行以保证 PC/安卓端
    // 图片能正常加载。能读到数据的跨站 fetch 必然携带 Origin，会被上面拦截。
  }
  next()
}

/** 构造路由（依赖注入 hub/chatService/notifySessionChanged/onPairRequest） */
export function buildBridgeRouter(
  hub: WsHub,
  chatService: BridgeChatService,
  notifySessionChanged: SessionChangedNotifier,
  onPairRequest: (requestId: string, deviceName: string) => void = () => {},
  facade: MobileFacade = new DefaultMobileFacade(chatService, new GenerationRegistry()),
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

  router.get('/server/info', async (_req, res) => {
    try { res.json(await facade.serverInfo()) } catch (e) { res.status(500).json({ error: (e as Error).message }) }
  })

  router.post('/auth/pair', pairLimiter, async (req, res) => {
    const { pairingCode, deviceName, deviceFingerprint } = (req.body ?? {}) as {
      pairingCode?: string
      deviceName?: string
      deviceFingerprint?: string
    }
    if (!deviceName || !deviceFingerprint) {
      res.status(400).json({ error: '缺少配对参数' })
      return
    }
    // fingerprint 仅作设备标识，首次与重新配对都必须消费一次性配对码。
    if (!pairingCode || !consumePairingCode(pairingCode)) {
      res.status(401).json({ error: '配对码无效或已过期' })
      return
    }

    // 始终挂起等待 PC 端人工确认，杜绝已知 fingerprint 续签旁路。
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
      res.json(await facade.listCharacters())
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
      exampleDialogMode: s.exampleDialogMode ?? 'always',
      lorebookRatio: s.lorebookRatio ?? 0.3,
      autoTitle: s.autoTitle ?? true,
      defaultNarrativeMode: resolveNarrativeMode(s.defaultNarrativeMode),
      omniscientNarrativeRules: s.omniscientNarrativeRules?.trim() || DEFAULT_OMNISCIENT_NARRATIVE_RULES,
      themeColor: s.themeColor,
      fontSize: s.fontSize,
      bubbleStyle: s.bubbleStyle,
      messageSpacing: s.messageSpacing,
      messageWidth: s.messageWidth,
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
    'htmlRendering', 'exampleDialogMode',
    'lorebookRatio', 'autoTitle', 'themeColor', 'fontSize', 'bubbleStyle',
    'messageSpacing', 'messageWidth', 'activeModel', 'activePresetId',
    'defaultNarrativeMode', 'omniscientNarrativeRules',
  ])

  router.patch('/settings', (req, res) => {
    try {
      const file = join(DIRS.config(), 'settings.json')
      const settings = readJson<Settings>(file, 'settings') ?? getDefaultSettings()
      const body = (req.body ?? {}) as Record<string, unknown>
      for (const key of Object.keys(body)) {
        if (!SETTINGS_WRITE_FIELDS.has(key)) continue
        if (key === 'defaultNarrativeMode' && !isNarrativeMode(body[key])) continue
        if (key === 'omniscientNarrativeRules' && typeof body[key] !== 'string') continue
        ;(settings as unknown as Record<string, unknown>)[key] = body[key]
      }
      writeJson(file, settings, 'settings')
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // ===== 设置同步 v2（阶段 C：快照端点 + revision 冲突检测；旧端点保持逐字节不变）=====

  const SETTINGS_FILE = () => join(DIRS.config(), 'settings.json')

  /**
   * activeModel 存在性校验上下文：
   * 优先使用当前 Profile 的模型列表缓存（listModels 成功后填充，见 /ai/models），
   * 无缓存/无 Profile/拉取失败时返回 null（跳过存在性校验，仅校验类型——
   * 避免离线 PC 让手机端的合法选择被误拒）。
   */
  const profileModelCache = new Map<string, { models: string[]; at: number }>()
  const PROFILE_MODEL_TTL_MS = 5 * 60_000

  async function buildValidationContext(settings: Settings): Promise<SettingsValidationContext> {
    const custom = await listJsonFilesAsync<{ id?: string }>(DIRS.presets())
    const knownPresetIds = [
      ...getBuiltinPresets().map((p) => p.id),
      ...custom.map((p) => p.id ?? '').filter(Boolean),
    ]
    const profile = settings.connectionProfiles?.find((p) => p.id === settings.activeProfileId)
    if (!profile) return { knownModelIds: null, knownPresetIds }
    const cached = profileModelCache.get(profile.id)
    if (cached && Date.now() - cached.at < PROFILE_MODEL_TTL_MS) {
      return { knownModelIds: cached.models, knownPresetIds }
    }
    return { knownModelIds: null, knownPresetIds }
  }

  /** GET /settings/snapshot：移动端安全子集快照（含 revision/capabilities；绝不含凭据） */
  router.get('/settings/snapshot', (_req, res) => {
    facade.settingsSnapshot().then((snapshot) => res.json(snapshot))
      .catch((e) => res.status(500).json({ error: (e as Error).message }))
  })

  /**
   * PATCH /settings/snapshot：baseRevision 乐观并发控制。
   * - 陈旧 revision -> 409 {error:'settings_conflict', current}（文件未写入）；
   * - 非法字段进 rejectedFields，合法字段照常应用；
   * - 成功后广播 WS settings:updated（sourceDeviceId = 请求设备）。
   * 防回环：本路径直接写文件、不经 settings:save IPC，写一次广播一次；
   * 同时经 change bus 发 android: 来源事件（BridgeService 订阅侧对 android: 不再转发 WS）。
   */
  router.patch('/settings/snapshot', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Partial<SettingsPatchRequest>
      const deviceId = (req as Request & { deviceId?: string }).deviceId ?? 'unknown'
      if (typeof body.baseRevision !== 'string' || !body.baseRevision) {
        res.status(400).json({ error: 'baseRevision_required' })
        return
      }
      if (typeof body.patch !== 'object' || body.patch === null || Array.isArray(body.patch)) {
        res.status(400).json({ error: 'patch_required' })
        return
      }

      const file = SETTINGS_FILE()
      const response = await withFileLock(file, async (): Promise<
        | { conflict: true; current: ReturnType<typeof buildSettingsSnapshot> }
        | { conflict: false; payload: SettingsPatchResponse }
      > => {
        const currentSettings = readJson<Settings>(file, 'settings') ?? getDefaultSettings()
        const current = buildSettingsSnapshot(currentSettings)
        if (body.baseRevision !== current.revision) {
          return { conflict: true, current }
        }
        const ctx = await buildValidationContext(currentSettings)
        const { accepted, rejected } = validateSettingsPatch(
          body.patch as Record<string, unknown>,
          ctx,
        )
        const appliedFields = Object.keys(accepted)
        if (appliedFields.length > 0) {
          const merged: Settings = {
            ...currentSettings,
            ...(accepted as Partial<MobileSafeSettings> as Partial<Settings>),
          }
          writeJson(file, merged, 'settings')
        }
        const next = buildSettingsSnapshot(readJson<Settings>(file, 'settings') ?? getDefaultSettings())
        const payload: SettingsPatchResponse = {
          ...next,
          appliedFields,
          rejectedFields: rejected,
        }
        return { conflict: false, payload }
      })

      if (response.conflict) {
        res.status(409).json({ error: 'settings_conflict', current: response.current })
        return
      }
      const { payload } = response
      if (payload.appliedFields.length > 0) {
        hub.broadcast('settings:updated', {
          revision: payload.revision,
          changedFields: payload.appliedFields,
          sourceDeviceId: deviceId,
        })
        emitSettingsChanged({
          revision: payload.revision,
          changedFields: payload.appliedFields,
          source: `android:${deviceId}`,
        })
      }
      res.json(payload)
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  /** 拉取模型列表：用 PC 端当前激活的 API Profile（provider/baseUrl/apiKey） */
  router.get('/ai/models', async (_req, res) => {
    try {
      const settings = readJson<Settings>(join(DIRS.config(), 'settings.json'), 'settings') ?? getDefaultSettings()
      // H-4 修复：settings.json 落盘时经 stripSecrets 剥离明文 apiKey，读取后必须回填，
      // 否则手机端拉模型列表恒 401（同文件其他端点均调用了 restoreSecrets）
      restoreSecrets(settings)
      const profile = settings.connectionProfiles?.find((p) => p.id === settings.activeProfileId)
      if (!profile) {
        res.status(400).json({ error: '未配置 API 连接' })
        return
      }
      const models = await getAdapter(profile.provider).listModels(profile.baseUrl, profile.apiKey)
      // 缓存本次 Profile 的模型列表（5 分钟 TTL），供 PATCH /settings/snapshot 的
      // activeModel 存在性校验使用；拉取失败不写缓存（校验降级为仅类型检查）。
      if (Array.isArray(models)) {
        profileModelCache.set(profile.id, {
          models: models.filter((m): m is string => typeof m === 'string'),
          at: Date.now(),
        })
      }
      res.json({ models })
    } catch (e) {
      res.status(500).json({ error: sanitizeApiKey((e as Error).message) })
    }
  })

  router.get('/lorebooks', async (_req, res) => {
    try {
      const lorebooks = await listLorebookViews(DIRS.lorebooks())
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
        enableThoughtFormat: p.enableThoughtFormat,
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
      updated = normalizePreset(updated)
      writeJson(join(DIRS.presets(), `${updated.id}.json`), updated)
      bridgeJournalPut({
        domain: 'preset',
        entityType: 'preset',
        entityId: updated.id,
        payload: {
          name: updated.name,
          temperature: updated.temperature,
          topP: updated.topP,
          maxTokens: updated.maxTokens,
          source: 'bridge',
        },
      })
      res.json({ ok: true, presetId: updated.id, createdCopy })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  router.get('/sessions/:sessionId/lorebooks', async (req, res) => {
    try {
      const session = await resolveSession(req, safeId(req.params.sessionId))
      if (!session) { res.status(404).json({ error: '会话不存在' }); return }
      res.json({ lorebookIds: session.lorebookIds ?? [] })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  router.patch('/sessions/:sessionId/lorebooks', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const session = await resolveSession(req, sessionId)
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
      res.json(await facade.listSessions())
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
      bridgeJournalPut({
        domain: 'session',
        entityType: 'session',
        entityId: session.id,
        parentId: character.id,
        payload: {
          characterId: session.characterId,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          source: 'bridge',
        },
      })
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
          // 作者开场白显式 markdown，避免 undefined 隐式分流
          contentRenderMode: 'markdown',
        }
        chatData.saveMessage(character.id, firstMsg)
        bridgeJournalPut({
          domain: 'message',
          entityType: 'message',
          entityId: firstMsg.id,
          parentId: session.id,
          payload: {
            sessionId: firstMsg.sessionId,
            characterId: firstMsg.characterId,
            role: firstMsg.role,
            content: firstMsg.content,
            timestamp: firstMsg.timestamp,
            source: 'bridge-greeting',
          },
        })
      }
      notifySessionChanged(session.id, 'created')
      res.json({
        id: session.id,
        characterId: session.characterId,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        personaId: session.personaId ?? null,
        narrativeMode: resolveNarrativeMode(session.narrativeMode),
        dialogueDirectionsEnabled: resolveDialogueDirectionsEnabled(session),
        memoryCurrentState: session.memoryCurrentState ?? '',
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
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100)
      const beforeId = typeof req.query.beforeId === 'string' ? req.query.beforeId : undefined
      const characterId = typeof req.query.characterId === 'string' ? safeId(req.query.characterId) : undefined
      res.json(await facade.listMessages({ sessionId, characterId, limit, beforeId }))
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  /** 从指定历史消息创建独立会话分支。 */
  router.post('/sessions/:sessionId/branch', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const rawMessageId = typeof req.query.messageId === 'string'
        ? req.query.messageId
        : (req.body as { messageId?: string } | undefined)?.messageId
      if (!rawMessageId) { res.status(400).json({ error: '缺少 messageId' }); return }
      const messageId = safeId(rawMessageId)
      const session = await resolveSession(req, sessionId)
      if (!session) { res.status(404).json({ error: '会话不存在' }); return }

      const sourceMessages = chatData.readMessages(session.characterId, sessionId)
      const branchIndex = sourceMessages.findIndex((message) => message.id === messageId)
      if (branchIndex < 0) { res.status(404).json({ error: '消息不存在' }); return }

      const branch = await chatData.createSession(
        session.characterId,
        `${session.title} · 分支`,
        session.personaId,
        session.lorebookIds,
      )
      bridgeJournalPut({
        domain: 'session',
        entityType: 'session',
        entityId: branch.id,
        parentId: session.characterId,
        payload: {
          characterId: branch.characterId,
          title: branch.title,
          createdAt: branch.createdAt,
          updatedAt: branch.updatedAt,
          source: 'bridge-branch',
        },
      })
      await chatData.updateSession(session.characterId, branch.id, {
        narrativeMode: resolveNarrativeMode(session.narrativeMode),
        dialogueDirectionsEnabled: resolveDialogueDirectionsEnabled(session),
        memoryCurrentState: session.memoryCurrentState ?? '',
      })
      const copied = sourceMessages.slice(0, branchIndex + 1)
      const idMap = new Map(copied.map((message) => [message.id, nanoid()]))
      for (const message of copied) {
        await chatData.saveMessage(session.characterId, {
          ...message,
          id: idMap.get(message.id)!,
          sessionId: branch.id,
          replyToId: message.replyToId ? idMap.get(message.replyToId) : undefined,
        })
      }
      notifySessionChanged(branch.id, 'created')
      res.json({
        id: branch.id,
        characterId: branch.characterId,
        characterName: getCharacter(branch.characterId)?.name ?? '',
        title: branch.title,
        createdAt: branch.createdAt,
        updatedAt: branch.updatedAt,
        narrativeMode: resolveNarrativeMode(session.narrativeMode),
        dialogueDirectionsEnabled: resolveDialogueDirectionsEnabled(session),
        memoryCurrentState: session.memoryCurrentState ?? '',
        messageCount: copied.length,
        lastMessage: copied.at(-1)?.content.slice(0, 50) ?? '',
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
      res.json(await facade.sendMessage(
        { sessionId, content: content.trim(), replyToId, images: safeImages },
        { requestId, sourceDeviceId: (req as Request & { deviceId?: string }).deviceId },
      ))
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  router.patch('/sessions/:sessionId', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const { title, narrativeMode, dialogueDirectionsEnabled, gameMasterMode, memoryCurrentState } = (req.body ?? {}) as {
        title?: string
        narrativeMode?: NarrativeMode
        dialogueDirectionsEnabled?: boolean
        /** 兼容期：旧客户端仍发送 gameMasterMode，映射到新字段。 */
        gameMasterMode?: boolean
        memoryCurrentState?: string
      }
      const directionsEnabled = dialogueDirectionsEnabled ?? gameMasterMode
      if (title === undefined && narrativeMode === undefined && directionsEnabled === undefined && memoryCurrentState === undefined) {
        res.status(400).json({ error: '缺少可更新字段' })
        return
      }
      if (title !== undefined && !title.trim()) { res.status(400).json({ error: '缺少标题' }); return }
      if (narrativeMode !== undefined && !isNarrativeMode(narrativeMode)) { res.status(400).json({ error: 'narrativeMode 无效' }); return }
      if (directionsEnabled !== undefined && typeof directionsEnabled !== 'boolean') { res.status(400).json({ error: 'dialogueDirectionsEnabled 无效' }); return }
      if (memoryCurrentState !== undefined && typeof memoryCurrentState !== 'string') { res.status(400).json({ error: 'memoryCurrentState 无效' }); return }
      const session = await findSessionById(sessionId)
      if (!session) {
        res.status(404).json({ error: '会话不存在' })
        return
      }
      if (title !== undefined) await chatData.renameSession(session.characterId, sessionId, title.trim())
      if (narrativeMode !== undefined || directionsEnabled !== undefined || memoryCurrentState !== undefined) {
        await chatData.updateSession(session.characterId, sessionId, {
          ...(narrativeMode !== undefined ? { narrativeMode } : {}),
          ...(directionsEnabled !== undefined ? { dialogueDirectionsEnabled: directionsEnabled } : {}),
          ...(memoryCurrentState !== undefined ? { memoryCurrentState: memoryCurrentState.slice(0, 6000) } : {}),
        })
      }
      notifySessionChanged(sessionId, title !== undefined ? 'title' : 'narrative')
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
      await invalidateSessionMemory(session.characterId, sessionId)
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
      await invalidateSessionMemory(session.characterId, sessionId)
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

      const completion = await chatWithRetry(
        getAdapter(params.provider),
        params,
        () => {},
        new AbortController().signal,
        1,
      )
      const full = completion.text
      // 续写需剥离角色视角（对齐渲染层 ensureUserPerspective）；两者都剥离 thought 块
      const cleaned = stripThought(full)
      let result = type === 'continue' ? ensureUserPerspective(cleaned, userName, charName) : cleaned
      // S4：有输入时去掉复述的接缝（与渲染层 trimContinuationSeam 同一策略）
      if (type === 'continue' && (content ?? '').trim()) {
        result = trimContinuationSeam(content ?? '', result)
      }
      res.json({ text: result })
    } catch (e) {
      res.status(500).json({ error: sanitizeApiKey((e as Error).message) })
    }
  })

  // ===== 长记忆管理 =====

  /** 读取会话记忆配置与内容（包含历史归档，只读不注入） */
  router.get('/sessions/:sessionId/memory', async (req, res) => {
    try {
      const session = await resolveSession(req, safeId(req.params.sessionId))
      if (!session) { res.status(404).json({ error: '会话不存在' }); return }
      res.json({
        memoryEnabled: session.memoryEnabled ?? false,
        memoryMode: session.memoryMode ?? 'manual',
        autoMemoryInterval: session.autoMemoryInterval ?? DEFAULT_AUTO_MEMORY_INTERVAL,
        memory: session.memory ?? '',
        memoryCurrentState: session.memoryCurrentState ?? '',
        memoryFacts: session.memoryFacts ?? [],
        memoryFactHistory: session.memoryFactHistory ?? [],
        memoryVersion: session.memoryVersion ?? 0,
        factsVectorVersion: session.factsVectorVersion ?? 0,
        memoryUpdatedAt: session.memoryUpdatedAt ?? 0,
        messageCount: session.messageCount ?? 0,
      })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  /** 归档历史查询（分页 + 状态过滤，只读） */
  router.get('/sessions/:sessionId/memory/history', async (req, res) => {
    try {
      const session = await resolveSession(req, safeId(req.params.sessionId))
      if (!session) { res.status(404).json({ error: '会话不存在' }); return }
      const status = typeof req.query.status === 'string' ? req.query.status : 'all'
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
      const offset = Math.max(Number(req.query.offset) || 0, 0)
      let history = session.memoryFactHistory ?? []
      if (status !== 'all') {
        history = history.filter((h) => h.status === status)
      }
      const total = history.length
      const sliced = history.slice(offset, offset + limit)
      res.json({ history: sliced, total, offset, limit })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  /** 修改会话记忆配置（开关/模式/间隔） */
  router.patch('/sessions/:sessionId/memory', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const session = await resolveSession(req, sessionId)
      if (!session) { res.status(404).json({ error: '会话不存在' }); return }
      const { memoryEnabled, memoryMode, autoMemoryInterval, memory, memoryCurrentState, memoryFacts } = (req.body ?? {}) as {
        memoryEnabled?: boolean
        memoryMode?: 'manual' | 'auto'
        autoMemoryInterval?: number
        memory?: string
        memoryCurrentState?: string
        memoryFacts?: MemoryFactRecord[]
      }
      const updates: Record<string, unknown> = {}
      if (typeof memoryEnabled === 'boolean') updates.memoryEnabled = memoryEnabled
      if (memoryMode === 'manual' || memoryMode === 'auto') updates.memoryMode = memoryMode
      if (typeof autoMemoryInterval === 'number') updates.autoMemoryInterval = autoMemoryInterval
      if (typeof memory === 'string') updates.memory = memory
      if (typeof memoryCurrentState === 'string') updates.memoryCurrentState = memoryCurrentState
      if (Array.isArray(memoryFacts)) updates.memoryFacts = memoryFacts
      await chatData.updateSession(session.characterId, sessionId, updates)
      notifySessionChanged(sessionId, 'message')
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  /** 触发长记忆总结（对齐渲染层：游标后的增量消息 + 有限衔接上下文）。 */
  router.post('/sessions/:sessionId/memory/summarize', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const session = await resolveSession(req, sessionId)
      if (!session) { res.status(404).json({ error: '会话不存在' }); return }
      const result = await memorySummaryService.summarize({
        characterId: session.characterId,
        sessionId,
        automatic: false,
      })
      if (result.status === 'skipped') {
        res.status(400).json({ error: result.reason === 'memory_disabled' ? '长记忆未开启' : '新增消息太少，暂不总结' })
        return
      }
      notifySessionChanged(sessionId, 'message')
      res.json({ ok: true, summary: result.summary, facts: result.facts })
    } catch (e) {
      res.status(500).json({ error: sanitizeApiKey((e as Error).message) })
    }
  })

  /** 上下文用量（对齐渲染层 P1-3：used/max/ratio，≥0.85 预警，≥1 危险） */
  router.get('/sessions/:sessionId/context-usage', async (req, res) => {
    try {
      const session = await resolveSession(req, safeId(req.params.sessionId))
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
      res.json(await facade.swipe(
        { sessionId, messageId, direction },
        { requestId: `swipe:${sessionId}:${messageId}`, sourceDeviceId: (req as Request & { deviceId?: string }).deviceId },
      ))
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  /** 重新生成指定消息的“下一步方向”（安卓端“换一批”） */
  router.post('/sessions/:sessionId/messages/:messageId/directions', async (req, res) => {
    try {
      const sessionId = safeId(req.params.sessionId)
      const messageId = safeId(req.params.messageId)
      const session = await resolveSession(req, sessionId)
      if (!session) { res.status(404).json({ error: '会话不存在' }); return }
      res.json(await facade.regenerateDirections({ sessionId, messageId }))
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
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
      const result = await facade.translate(
        { sessionId, messageId },
        { requestId: `translate:${sessionId}:${messageId}`, sourceDeviceId: (req as Request & { deviceId?: string }).deviceId },
      )
      res.json(result)
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // ===== 快捷回复 =====

  router.get('/quickReplies', async (_req, res) => {
    try {
      // H-9 修复：与 quickReply:list 同一数据源（data/config/quickReplies.json 单文件），
      // 此前误读 quickReplies 目录（从不被创建），手机端快捷回复恒为空列表
      const store = readQuickReplyStore()
      res.json({ global: store.global, byCharacter: store.byCharacter ?? {} })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  router.post('/quickReplies/:id/execute', async (req, res) => {
    try {
      const id = safeId(req.params.id)
      const store = readQuickReplyStore()
      const all = [...(store.global ?? []), ...Object.values(store.byCharacter ?? {}).flat()]
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
        defaultNarrativeMode: g.defaultNarrativeMode ?? null,
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
      const { name, memberIds, defaultNarrativeMode } = (req.body ?? {}) as {
        name?: string
        memberIds?: string[]
        defaultNarrativeMode?: NarrativeMode
      }
      if (!Array.isArray(memberIds) || memberIds.length === 0 || memberIds.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id))) {
        res.status(400).json({ error: 'memberIds 必须为角色 id 数组且至少 1 个' })
        return
      }
      if (defaultNarrativeMode !== undefined && !isNarrativeMode(defaultNarrativeMode)) {
        res.status(400).json({ error: 'defaultNarrativeMode 无效' })
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
        defaultNarrativeMode,
        maxRounds: 4,
        speakerInterval: 10,
        lorebookIds: [],
        presetId: null,
        systemPrompt: '',
        createdAt: now,
        updatedAt: now,
      }
      await groupData.saveGroup(group)
      bridgeJournalPut({
        domain: 'group',
        entityType: 'group',
        entityId: group.id,
        payload: { name: group.name, memberIds: group.memberIds ?? [], source: 'bridge' },
      })
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
      const { name, chatMode, autoMode, maxRounds, speakerInterval, themeColor, bubbleOpacity, systemPrompt, defaultNarrativeMode } = (req.body ?? {}) as {
        name?: string
        chatMode?: 'mention' | 'polling' | 'free'
        autoMode?: boolean
        maxRounds?: number
        speakerInterval?: number
        themeColor?: string
        bubbleOpacity?: number
        systemPrompt?: string
        defaultNarrativeMode?: NarrativeMode | null
      }
      const updated: GroupChat = { ...group }
      if (typeof name === 'string' && name.trim()) updated.name = name.trim()
      if (chatMode === 'mention' || chatMode === 'polling' || chatMode === 'free') updated.chatMode = chatMode
      if (defaultNarrativeMode === null) delete updated.defaultNarrativeMode
      else if (defaultNarrativeMode !== undefined) {
        if (!isNarrativeMode(defaultNarrativeMode)) {
          res.status(400).json({ error: 'defaultNarrativeMode 无效' })
          return
        }
        updated.defaultNarrativeMode = defaultNarrativeMode
      }
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
        narrativeMode: resolveNarrativeMode(s.narrativeMode),
        ...dialogueDirectionFields(s),
        personaId: s.personaId ?? null,
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
        narrativeMode: m.narrativeMode ?? null,
        speakerKind: resolveMessageSpeakerKind(m),
        generationKind: resolveMessageGenerationKind(m.generationKind, m),
        dialogueDirections: m.dialogueDirections ?? null,
      })))
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  router.get('/groups/:groupId/sessions/:sessionId/messages/:messageId/tts', handleGroupTts)

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
      const groupSession = (await groupData.listSessions(groupId)).find((item) => item.id === sessionId)
      if (!groupSession) { res.status(404).json({ error: '群聊会话不存在' }); return }
      const narrativeMode = resolveNarrativeMode(groupSession.narrativeMode)
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
        narrativeMode,
        speakerKind: narrativeMode === 'omniscient' ? 'narrator' as const : 'persona' as const,
        generationKind: 'manual' as const,
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
        narrativeMode: resolveNarrativeMode(session.narrativeMode),
        ...dialogueDirectionFields(session),
        personaId: session.personaId ?? null,
      })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  /** 更新群聊会话（标题/叙事模式） */
  router.patch('/groups/:groupId/sessions/:sessionId', async (req, res) => {
    try {
      const groupId = safeId(req.params.groupId)
      const sessionId = safeId(req.params.sessionId)
      const { title, narrativeMode, dialogueDirectionsEnabled, gameMasterMode, memoryCurrentState } = (req.body ?? {}) as {
        title?: string
        narrativeMode?: NarrativeMode
        dialogueDirectionsEnabled?: boolean
        /** 兼容期：旧客户端仍发送 gameMasterMode，映射到新字段。 */
        gameMasterMode?: boolean
        memoryCurrentState?: string
      }
      const directionsEnabled = dialogueDirectionsEnabled ?? gameMasterMode
      if (title === undefined && narrativeMode === undefined && directionsEnabled === undefined && memoryCurrentState === undefined) {
        res.status(400).json({ error: '缺少可更新字段' }); return
      }
      if (title !== undefined && !title.trim()) { res.status(400).json({ error: '缺少标题' }); return }
      if (narrativeMode !== undefined && !isNarrativeMode(narrativeMode)) {
        res.status(400).json({ error: 'narrativeMode 无效' }); return
      }
      if (directionsEnabled !== undefined && typeof directionsEnabled !== 'boolean') { res.status(400).json({ error: 'dialogueDirectionsEnabled 无效' }); return }
      if (memoryCurrentState !== undefined && typeof memoryCurrentState !== 'string') { res.status(400).json({ error: 'memoryCurrentState 无效' }); return }
      await groupData.updateSession(groupId, sessionId, {
        ...(title !== undefined ? { title: title.trim() } : {}),
        ...(narrativeMode !== undefined ? { narrativeMode } : {}),
        ...(directionsEnabled !== undefined ? { dialogueDirectionsEnabled: directionsEnabled } : {}),
        ...(memoryCurrentState !== undefined ? { memoryCurrentState: memoryCurrentState.slice(0, 6000) } : {}),
      })
      notifySessionChanged(sessionId, title !== undefined ? 'title' : 'narrative')
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

      const messages = groupData.readMessages(groupId, sessionId)
      const groupSession = (await groupData.listSessions(groupId)).find((item) => item.id === sessionId)
      if (!groupSession) { res.status(404).json({ error: '群聊会话不存在' }); return }
      const narrativeMode = resolveNarrativeMode(groupSession.narrativeMode)
      const effectivePersonaId = groupSession.personaId === undefined
        ? settings.defaultPersonaId
        : groupSession.personaId
      const personas = readJson<Persona[]>(join(DIRS.config(), 'personas.json')) ?? []
      const sessionPersona = effectivePersonaId
        ? personas.find((persona) => persona.id === effectivePersonaId)
        : undefined
      const userName = sessionPersona?.name
        || (effectivePersonaId && settings.activePersonaId === effectivePersonaId ? settings.userName : '')
        || '用户'
      const round = messages.reduce((mx, m) => Math.max(mx, m.round ?? 0), 0) + 1

      // 发言人：指定优先，否则按轮次轮转
      let speaker = speakerId ? (members.find((m) => m.id === speakerId) ?? null) : null
      if (!speaker) {
        speaker = members[(round - 1) % members.length]
      }
      if (!speaker) { res.status(500).json({ error: '发言人选择失败' }); return }

      const { systemContent, history } = buildGroupContextForBridge({
        group,
        members,
        messages,
        speaker,
        userName,
        narrativeMode,
        omniscientNarrativeRules: settings.omniscientNarrativeRules,
      })

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

      const completion = await chatWithRetry(getAdapter(params.provider), params, () => {}, new AbortController().signal, 1)
      const full = completion.text
      const clean = stripAllThinking(full)

      const aiMsg = {
        id: nanoid(),
        groupId,
        characterId: speaker.id,
        content: clean || '(无回复)',
        images: [],
        timestamp: Date.now(),
        round,
        narrativeMode,
        speakerKind: 'character' as const,
        generationKind: 'assistant_reply' as const,
      }
      groupData.appendMessage(groupId, sessionId, aiMsg)
      notifySessionChanged(sessionId, 'message')
      res.json({ message: aiMsg })
    } catch (e) {
      res.status(500).json({ error: sanitizeApiKey((e as Error).message) })
    }
  })

  /**
   * 翻译群聊消息（POST /groups/:groupId/sessions/:sessionId/translate?messageId=xxx）。
   * 与单聊 translate 共用 chatService 实现（同一 prompt、动态预算、可取消、推理隔离）；
   * 旧版此处是内联复制（硬编码预算、不可取消），已并入 chatService.translateGroup。
   */
  router.post('/groups/:groupId/sessions/:sessionId/translate', async (req, res) => {
    try {
      const groupId = safeId(req.params.groupId)
      const sessionId = safeId(req.params.sessionId)
      const messageId = typeof req.query.messageId === 'string' ? safeId(req.query.messageId) : undefined
      if (!messageId) { res.status(400).json({ error: '缺少 messageId' }); return }
      res.json(await chatService.translateGroup(groupId, sessionId, messageId))
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
    narrativeMode: message.narrativeMode ?? null,
    speakerKind: resolveMessageSpeakerKind(message),
    generationKind: resolveMessageGenerationKind(message.generationKind, message),
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
