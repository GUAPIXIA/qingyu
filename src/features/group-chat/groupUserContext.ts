/**
 * 群聊用户上下文解析（唯一来源）。
 *
 * 口径与 `src/store/groupChatContext.ts` 一致：会话人设 → 默认人设 → 全局用户名；
 * 供 AI 生成、开场白/旁白插入与历史消息显示兜底复用，避免“消息里旧名字、上下文新名字”。
 */
import type { GroupSession, Persona, Settings } from '../../../shared/types'

export interface GroupUserContext {
  userName: string
  userDescription?: string
  userPersona?: string
}

export function resolveGroupUserContext(input: {
  settings: Settings
  session?: GroupSession | null
  getPersona: (id: string | null | undefined) => Persona | undefined
}): GroupUserContext {
  const rawPersonaId = input.session?.personaId
  const sessionPersonaId = rawPersonaId === undefined ? input.settings.defaultPersonaId : rawPersonaId
  const sessionPersona = sessionPersonaId ? input.getPersona(sessionPersonaId) : undefined
  const canUseGlobalPersonaFields = !!sessionPersonaId && input.settings.activePersonaId === sessionPersonaId
  return {
    userName: (sessionPersona?.name ?? (canUseGlobalPersonaFields ? input.settings.userName : '')) || '用户',
    userDescription: sessionPersona?.description ?? (canUseGlobalPersonaFields ? input.settings.userDescription : ''),
    userPersona: sessionPersona?.persona ?? (canUseGlobalPersonaFields ? input.settings.userPersona : ''),
  }
}
