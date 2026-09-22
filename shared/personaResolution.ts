import type { Persona, Settings } from './types'

export interface ResolvedPersonaFields {
  activePersonaId: string | null
  userName: string
  userDescription: string
  userPersona: string
}

type SessionPersonaBinding = { personaId?: string | null } | null | undefined

const EMPTY_PERSONA_FIELDS: ResolvedPersonaFields = {
  activePersonaId: null,
  userName: '用户',
  userDescription: '',
  userPersona: '',
}

/**
 * 解析单个会话实际使用的用户身份。
 * - personaId 为字符串：只使用该身份；已删除/无效时清空，禁止泄漏全局旧镜像。
 * - personaId 为 null：用户明确选择“不使用身份”。
 * - personaId 为 undefined：旧会话才回退默认身份；没有默认身份时兼容旧版全局字段。
 * - 无会话：预览/测试场景继续使用全局字段。
 */
export function resolveSessionPersonaFields(
  session: SessionPersonaBinding,
  settings: Settings,
  personas: Persona[],
): ResolvedPersonaFields {
  if (!session) {
    return {
      activePersonaId: settings.activePersonaId ?? null,
      userName: settings.userName || '用户',
      userDescription: settings.userDescription || '',
      userPersona: settings.userPersona || '',
    }
  }

  if (session.personaId === null) return { ...EMPTY_PERSONA_FIELDS }

  const effectivePersonaId = session.personaId ?? settings.defaultPersonaId
  if (!effectivePersonaId) {
    // 兼容尚未引入多身份前的旧会话：没有 personaId，也没有 defaultPersonaId。
    return {
      activePersonaId: settings.activePersonaId ?? null,
      userName: settings.userName || '用户',
      userDescription: settings.userDescription || '',
      userPersona: settings.userPersona || '',
    }
  }

  const persona = personas.find((candidate) => candidate.id === effectivePersonaId)
  if (!persona) return { ...EMPTY_PERSONA_FIELDS }

  return {
    activePersonaId: persona.id,
    userName: persona.name || '用户',
    userDescription: persona.description || '',
    userPersona: persona.persona || '',
  }
}

export function withResolvedSessionPersona(
  settings: Settings,
  session: SessionPersonaBinding,
  personas: Persona[],
): Settings {
  return { ...settings, ...resolveSessionPersonaFields(session, settings, personas) }
}
