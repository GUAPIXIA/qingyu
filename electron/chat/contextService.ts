/**
 * V12-07 ContextService：统一上下文组装（实施方案 §5.2 ContextPort）
 *
 * 复用 src/context/contextBuilder 的纯函数，但数据经 mainContextProvider 拉取，
 * 桌面与 Bridge 同走此服务，消除双链路漂移。
 * 语义检索（向量 RAG）在本服务内完成，失败回退纯关键词（与 streamController 对齐）。
 */
import { mainContextProvider } from '../context/mainContextProvider'
import { buildContextMessagesFromData } from '../../src/context/contextBuilder'
import { createHash } from 'node:crypto'
import type { ContextPort, BuildContextInput, PreparedContext } from './ports'

function fingerprintOf(messages: PreparedContext['messages']): string {
  const h = createHash('sha256')
  for (const m of messages) h.update(`${m.role}:${m.content}\n`)
  return h.digest('hex').slice(0, 16)
}

export const contextService: ContextPort = {
  async build(input: BuildContextInput): Promise<PreparedContext> {
    const data = await mainContextProvider.fetchBuildData(input.characterId, input.sessionId)
    if (!data.character) throw new Error(`角色不存在: ${input.characterId}`)

    const { messages } = buildContextMessagesFromData(data)

    const profile = data.settings.profile
    const model = {
      provider: profile?.provider ?? 'openai',
      model: profile?.model ?? data.settings.settings.activeModel ?? 'gpt-4o-mini',
      profileId: profile ? data.settings.settings.activeProfileId ?? undefined : undefined,
    }

    return {
      messages,
      fingerprint: fingerprintOf(messages),
      model,
    }
  },
}
