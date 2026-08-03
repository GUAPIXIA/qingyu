import type { Character } from '../../shared/types'
import { useSettingsStore } from './useSettingsStore'
import { useCharacterStore } from './useCharacterStore'
import { parseMemoryResult } from '../utils/memory'
import { vectorizeGroupSessionFacts } from './groupStreamController'
import type { GroupStoreGet, GroupStoreSet } from './groupChatTypes'

/**
 * 群聊长记忆摘要生成：对最近对话调用 AI 总结，更新【摘要】+【事实】。
 * 从 useGroupChatStore.triggerMemorySummary 抽出，依赖通过 set/get 注入。
 */
export async function runGroupMemorySummary(get: GroupStoreGet, set: GroupStoreSet): Promise<void> {
  const state = get()
  const { currentGroup, currentSessionId, messages } = state
  if (!currentGroup || !currentSessionId) return

  const settingsStore = useSettingsStore.getState()
  const profile = settingsStore.getActiveProfile()
  if (!profile) return

  const charStore = useCharacterStore.getState()
  const members = currentGroup.memberIds
    .map(id => charStore.characters.find(c => c.id === id))
    .filter(Boolean) as Character[]
  const memberNames = members.map(m => m.name).join('、')

  // 取最近消息（最多 20 条）
  const recent = messages.slice(-20)
  if (recent.length < 4) return

  const currentSession = state.sessions.find(s => s.id === currentSessionId)
  const prevMemory = currentSession?.memory || ''
  const prevFacts = currentSession?.memoryFacts ?? []
  const prevFactsText = prevFacts.length > 0
    ? prevFacts.map((f, i) => `${i + 1}. ${f}`).join('\n')
    : '无'

  const systemPrompt = `你是一个对话摘要助手。请根据以下群聊「${currentGroup.name}」的最近对话（成员：${memberNames}），更新对话历史摘要并抽取关键事实。

输出格式（严格按此格式）：
【摘要】
2-4 句简洁摘要：主要事件、情节进展、角色关系变化、未解决的冲突或悬念。

【事实】
1. 具体事实
2. 具体事实

要求：
- 事实必须是持久有效的信息（人名、身份、地点、目标、约定、关系等），不要写临时情绪。
- 合并之前的事实：保留仍有效的事实，更新已变化的，删除已被推翻的，补充新事实。
- 只输出上述格式内容。

${prevMemory ? '【之前的摘要】\n' + prevMemory + '\n' : ''}【之前的事实】\n${prevFactsText}`

  const conversationText = recent.map(m => {
    const char = members.find(c => c.id === m.characterId)
    const speaker = m.characterId === '__user__'
      ? (settingsStore.settings.userName || '用户')
      : (char?.name || '未知')
    return `${speaker}: ${m.content}`
  }).join('\n')

  try {
    const requestId = `group-memory-${Date.now()}`
    let result = ''

    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      result += data.text
    })

    const unbindDone = window.api.ai.onDone((doneId) => {
      if (doneId !== requestId) return
      unbindChunk(); unbindDone(); unbindError()
      const parsed = parseMemoryResult(result || '')
      if (parsed.summary) {
        window.api.group.updateMemory(currentGroup.id, currentSessionId, parsed.summary)
        if (parsed.facts.length > 0) {
          window.api.group.updateSession(currentGroup.id, currentSessionId, { memoryFacts: parsed.facts })
          // P0-2：事实向量化（异步）
          vectorizeGroupSessionFacts(currentGroup.id, currentSessionId, parsed.facts)
        }
        // NEW-M11：摘要写入归属发起时群聊会话（数据正确）；仅当用户仍停留在同一群聊会话时更新 UI
        const s = get()
        if (s.currentGroup?.id === currentGroup.id && s.currentSessionId === currentSessionId) {
          const sessions = s.sessions.map(sess =>
            sess.id === currentSessionId ? { ...sess, memory: parsed.summary, memoryUpdatedAt: Date.now(), memoryFacts: parsed.facts.length > 0 ? parsed.facts : sess.memoryFacts } : sess
          )
          set({ sessions })
        }
      }
    })

    const unbindError = window.api.ai.onError((data: { requestId: string }) => {
      if (data.requestId !== requestId) return
      unbindChunk(); unbindDone(); unbindError()
    })

    await window.api.ai.chat({
      requestId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: conversationText },
      ],
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: profile.model,
      temperature: 0.3,
      topP: 1,
      maxTokens: 1024,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: false,
    })
  } catch {
    // 摘要失败静默处理，不影响主流程
  }
}
