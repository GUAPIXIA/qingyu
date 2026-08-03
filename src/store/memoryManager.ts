import type { Character } from '../../shared/types'
import { useSettingsStore } from './useSettingsStore'
import { isLocalProvider, isLocalUrl } from '../utils/defaults'
import { resolveEffectiveTemplate } from '../utils/chatTemplates'
import { parseMemoryResult } from '../utils/memory'
import { MEMORY_SUMMARY_RECENT, MEMORY_SUMMARY_MIN } from './chatConstants'
import { friendlyError } from './chatUtils'
import { vectorizeSessionFacts } from './streamController'
import type { StoreGet, StoreSet } from './chatTypes'

/**
 * 长记忆摘要生成（手动触发 / 自动触发共用）：
 * 对最近对话调用 AI 总结，解析【摘要】+【事实】并持久化到会话。
 * 从 useChatStore.triggerMemorySummary 抽出，依赖通过 set/get 注入。
 */
export async function runMemorySummary(
  get: StoreGet,
  set: StoreSet,
  character: Character,
): Promise<string | null> {
  const { currentSessionId, messages, sessions } = get()
  const session = sessions.find(s => s.id === currentSessionId)
  if (!currentSessionId || !session?.memoryEnabled) return null

  const profile = useSettingsStore.getState().getActiveProfile()
  if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) return null

  const settings = useSettingsStore.getState().settings
  const userName = settings.userName || '用户'

  // 取最近消息进行总结（基于 token 预算，限制最大 20 条）
  const recentMessages = messages.filter(m => m.role !== 'system').slice(-MEMORY_SUMMARY_RECENT)
  if (recentMessages.length < MEMORY_SUMMARY_MIN) return null

  const messagesText = recentMessages
    .map(m => `${m.role === 'user' ? userName : character.name}: ${m.content}`)
    .join('\n')

  const previousMemory = session.memory || '无'
  // 之前的关键事实（供模型合并更新）
  const previousFacts = session.memoryFacts ?? []
  const previousFactsText = previousFacts.length > 0
    ? previousFacts.map((f, i) => `${i + 1}. ${f}`).join('\n')
    : '无'

  const requestId = `memory-summary-${Date.now()}`
  let result = ''
  let errored = false
  let errMsg = ''

  // 构建 instruct 模板（摘要无预设，跟随 profile 开关）
  const instructTemplate = profile.useInstructTemplate
    ? resolveEffectiveTemplate(undefined, profile.provider, settings.activeModel || profile.model, true)
    : undefined

  return new Promise((resolve) => {
    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      result += data.text
    })
    const unbindDone = window.api.ai.onDone(async (doneId) => {
      if (doneId !== requestId) return
      unbindChunk(); unbindDone(); unbindError()
      const parsed = parseMemoryResult(result)
      if (parsed.summary) {
        try {
          await window.api.chat.updateMemory(character.id, currentSessionId, parsed.summary)
          // 保存关键事实（会话字段，经 updateSession 持久化）
          if (parsed.facts.length > 0) {
            await window.api.chat.updateSession(character.id, currentSessionId, { memoryFacts: parsed.facts })
            // P0-2：事实向量化（异步，供语义检索注入）
            vectorizeSessionFacts(character.id, currentSessionId, parsed.facts)
          }
          // NEW-M11：摘要写入归属发起时会话（数据正确）；仅当用户仍停留在同一会话时刷新 UI，
          // 避免覆盖已切换到其他会话的列表
          if (get().currentSessionId === currentSessionId) {
            const refreshedSessions = await window.api.chat.listSessions(character.id)
            set({ sessions: refreshedSessions })
          }
        } catch { /* ignore */ }
      }
      resolve(parsed.summary || null)
    })
    const unbindError = window.api.ai.onError((data) => {
      if (data.requestId !== requestId) return
      unbindChunk(); unbindDone(); unbindError()
      errored = true
      errMsg = friendlyError(data.error)
      // 错误反馈到 store，UI 可见
      set({ error: `长记忆总结失败：${errMsg}` })
      resolve(null)
    })

    window.api.ai.chat({
      requestId,
      messages: [
        {
          role: 'system',
          content: `你是一个角色扮演对话总结助手。请总结以下${character.name}与${userName}之间的对话，并抽取关键事实。

输出格式（严格按此格式）：
【摘要】
2-4 句简洁摘要，覆盖：主要事件、情节进展、角色关系演变、当前未解决的问题。

【事实】
1. 具体事实
2. 具体事实

要求：
- 事实必须是对话中确立的、对未来有参考价值的持久信息（人名、身份、地点、物品、目标、约定、关系等），不要写临时情绪或过场细节。
- 合并之前的事实：保留仍有效的事实，更新已变化的事实，删除已被推翻的事实，补充新事实。
- 只输出上述格式内容，不要添加任何解释或评价。

之前的摘要：
${previousMemory}

之前的事实：
${previousFactsText}`,
        },
        { role: 'user', content: `新对话内容：\n${messagesText}` },
      ],
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: settings.activeModel || profile.model,
      temperature: 0.3,
      topP: 0.9,
      maxTokens: 2048,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: true,
      instructTemplate,
    }).catch(() => {
      unbindChunk(); unbindDone(); unbindError()
      if (!errored) {
        set({ error: '长记忆总结请求失败' })
      }
      resolve(null)
    })
  })
}
