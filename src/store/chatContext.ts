import type { Character, NarrativeMode, Preset, ResponsePolicy } from '../../shared/types'
import type { ContextBuildData } from '../../shared/contextTypes'
import type { RequestBudget } from '../../shared/modelOutputProfile'
import { buildContextMessagesFromData, type BuildResult } from '../context/contextBuilder'
import { syncBuildData } from '../context/rendererContextProvider'
import { markPendingCompression } from './streamController'
import { appendRecentTriggeredIds, touchCompressionCache, upsertCompressionCache } from '../utils/lorebook'
import { compressLorebookOverflow } from './chatUtils'
import { useSettingsStore } from './useSettingsStore'
import { isLocalProvider, isLocalUrl } from '../utils/defaults'
import { LOREBOOK_RECENCY_WINDOW } from './chatConstants'
import type { ContextMessage, StoreGet, StoreSet } from './chatTypes'

/**
 * 阶段 0b：组装逻辑已抽离至 src/context/contextBuilder.ts（纯模块，两端共用）。
 *
 * 本文件退化为薄封装：
 * 1. rendererContextProvider.syncBuildData 从现有 Zustand store 同步构造数据快照；
 * 2. contextBuilder.buildContextMessagesFromData 完成全部组装（system prompt /
 *    世界书 / 正则管线 / 记忆注入 / 预算裁剪 / 深度注入）；
 * 3. lastContextUsage 与 pendingCompression 写回 store（副作用集中在此）。
 *
 * 行为与迁移前完全一致（防漂移快照测试锁定，src/context/__tests__/contextBuilder.test.ts）。
 */
/** 组装结果：历史消息 + 本轮请求预算（上下文预留与请求共用的同一次计算） */
export interface BuiltChatContext {
  messages: ContextMessage[]
  /** 本轮请求 max_tokens（来自 resolveChatRequestPlan，调用方不得二次推导） */
  requestMaxTokens: number
  /** 预算明细与风险标记，供发送入口在请求前校验。 */
  requestBudget: RequestBudget
  /** 本轮篇幅策略（阶段二提示注入复用） */
  responsePolicy: ResponsePolicy
  /** 阶段6灰度：本轮是否走旧链路 */
  pipelineLegacy: boolean
  /** S5：本轮识别出的用户篇幅要求（写入观测，便于核对误判） */
  responseIntent: ResponsePolicy['mode'] | null
  /** S5：自动模式场景系数（写入观测） */
  sceneFactor: number
}

export function buildChatContext(
  get: StoreGet,
  set: StoreSet,
  character: Character,
  preset: Preset | null,
  opts?: {
    continuation?: boolean
    narrativeMode?: NarrativeMode
    trackUsage?: boolean
    generationType?: 'normal' | 'continue' | 'impersonate' | 'swipe' | 'regenerate' | 'quiet'
    lorebookDiagnosticsMode?: 'live' | 'preview'
    /** 阶段8（§4.2）：本轮门控（调用方按开关/熔断解析后传入；缺省 = 不介入） */
    reasoningGate?: ContextBuildData['reasoningGate']
  },
): BuiltChatContext {
  const data = syncBuildData(character, preset, opts?.reasoningGate)
  const result = buildContextMessagesFromData(data, {
    ...opts,
    lorebookDiagnosticsMode: opts?.trackUsage === false ? opts.lorebookDiagnosticsMode : 'live',
  })
  // 记录上下文用量（P1-3：上限预警）
  // M-27 修复：trackUsage=false（ContextViewer 等只读查看场景）不写 lastContextUsage——
  // 渲染期调用此前会用 preset=null 口径覆盖真实发送路径的用量记录，导致 85% 预警误报/漏报
  if (opts?.trackUsage !== false) {
    set({
      lastContextUsage: result.lastContextUsage,
      lastLorebookDiagnostics: result.lorebookDiagnostics ?? null,
      lastLorebookDiagnosticsSessionId: get().currentSessionId,
    })
  }
  // 上下文溢出压缩任务：流式完成后异步执行（原 buildChatContext 内直接标记）
  if (opts?.trackUsage !== false && result.pendingCompression) {
    markPendingCompression(result.pendingCompression)
  }
  // 阶段二B：本轮触发的世界书条目 key 追加到会话 recency 窗口（环形缓冲 + 持久化）。
  // 阶段三：超限条目异步 AI 压缩（非阻塞，失败静默降级为直接裁剪）。
  // 两者均仅真实发送路径（trackUsage !== false）执行，只读查看不产生副作用。
  if (opts?.trackUsage !== false) {
    const sid = get().currentSessionId
    if (sid) {
      const cur = get().sessions.find(s => s.id === sid)
      const nextRecent = appendRecentTriggeredIds(
        cur?.recentTriggeredIds,
        result.lorebookTriggeredIds ?? [],
        LOREBOOK_RECENCY_WINDOW,
      )
      const nextCache = touchCompressionCache(
        cur?.lorebookCompressionCache,
        result.lorebookCompressionCacheHitKeys ?? [],
      )
      const patch = {
        recentTriggeredIds: nextRecent,
        ...(result.lorebookTimedEffects ? { lorebookTimedEffects: result.lorebookTimedEffects } : {}),
        ...(nextCache !== cur?.lorebookCompressionCache ? { lorebookCompressionCache: nextCache } : {}),
      }
      set(s => ({ sessions: s.sessions.map(ss => ss.id === sid ? { ...ss, ...patch } : ss) }))
      window.api.chat.updateSession(character.id, sid, patch).catch(() => { /* 忽略 */ })
      if (result.lorebookCompressions?.length) {
        fireLorebookCompression(get, set, character.id, sid, result.lorebookCompressions)
      }
    }
  }
  return {
    messages: result.messages,
    requestMaxTokens: result.requestMaxTokens,
    requestBudget: result.requestBudget,
    responsePolicy: result.responsePolicy,
    pipelineLegacy: result.pipelineLegacy,
    responseIntent: result.responseIntent,
    sceneFactor: result.sceneFactor,
  }
}

/** 只读上下文报告：供调试面板模拟当前状态，不写 store、不推进定时效果。 */
export function buildChatContextReport(
  character: Character,
  preset: Preset | null,
  opts?: {
    continuation?: boolean
    generationType?: 'normal' | 'continue' | 'impersonate' | 'swipe' | 'regenerate' | 'quiet'
  },
): BuildResult {
  return buildContextMessagesFromData(syncBuildData(character, preset), {
    ...opts,
    lorebookDiagnosticsMode: 'preview',
  })
}

/**
 * 世界书超限压缩（阶段三）：异步 AI 压缩被丢弃条目并写入会话缓存（内存 + 持久化）。
 * 下一轮同一集合再被丢弃时以缓存摘要注入；无 API 连接时静默跳过（降级为直接裁剪）。
 */
function fireLorebookCompression(
  get: StoreGet,
  set: StoreSet,
  characterId: string,
  sessionId: string,
  requests: NonNullable<ReturnType<typeof buildContextMessagesFromData>['lorebookCompressions']>,
): void {
  const settingsStore = useSettingsStore.getState()
  const profile = settingsStore.getActiveProfile()
  // 无 API 连接（且非本地服务）时不发起压缩：条目直接裁剪
  if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) return
  Promise.all(requests.map((request) => compressLorebookOverflow(request, {
    provider: profile.provider,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: settingsStore.settings.activeModel || profile.model,
  }))).then((results) => {
    const successful = results.filter((res): res is NonNullable<typeof res> => !!res)
    if (successful.length === 0) return
    const cur = get().sessions.find(s => s.id === sessionId)
    let nextCache = cur?.lorebookCompressionCache
    for (const res of successful) nextCache = upsertCompressionCache(nextCache, res.key, res.entry)
    set(s => ({ sessions: s.sessions.map(ss => ss.id === sessionId ? { ...ss, lorebookCompressionCache: nextCache } : ss) }))
    window.api.chat.updateSession(characterId, sessionId, { lorebookCompressionCache: nextCache }).catch(() => { /* 忽略 */ })
  }).catch(() => { /* 忽略 */ })
}
