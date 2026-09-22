import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../defaults'
import { resolveSessionPersonaFields } from '../personaResolution'
import type { Persona, SessionPreview } from '../types'

const PERSONA: Persona = {
  id: 'persona-session',
  name: '林舟',
  description: '来自北境的药师',
  persona: '谨慎、敏锐',
  avatar: '',
  createdAt: 1,
  updatedAt: 1,
}

function session(personaId?: string | null): SessionPreview {
  return {
    id: 'session-1',
    characterId: 'character-1',
    title: '会话',
    createdAt: 1,
    updatedAt: 1,
    ...(personaId !== undefined ? { personaId } : {}),
  } as SessionPreview
}

describe('resolveSessionPersonaFields', () => {
  it('以当前会话绑定身份为准，不使用全局镜像中的旧身份', () => {
    const settings = {
      ...getDefaultSettings(),
      activePersonaId: 'persona-old',
      userName: '旧身份',
      userDescription: '旧描述',
      userPersona: '旧性格',
    }

    expect(resolveSessionPersonaFields(session(PERSONA.id), settings, [PERSONA])).toEqual({
      activePersonaId: PERSONA.id,
      userName: PERSONA.name,
      userDescription: PERSONA.description,
      userPersona: PERSONA.persona,
    })
  })

  it('personaId=null 表示明确不使用身份，不回退默认或全局旧身份', () => {
    const settings = {
      ...getDefaultSettings(),
      defaultPersonaId: PERSONA.id,
      activePersonaId: PERSONA.id,
      userName: PERSONA.name,
      userDescription: PERSONA.description,
      userPersona: PERSONA.persona,
    }

    expect(resolveSessionPersonaFields(session(null), settings, [PERSONA])).toEqual({
      activePersonaId: null,
      userName: '用户',
      userDescription: '',
      userPersona: '',
    })
  })

  it('旧会话缺少 personaId 时才回退默认身份', () => {
    const settings = { ...getDefaultSettings(), defaultPersonaId: PERSONA.id }
    expect(resolveSessionPersonaFields(session(), settings, [PERSONA]).activePersonaId).toBe(PERSONA.id)
  })

  it('会话绑定的身份已删除时清空身份，不泄漏全局旧身份', () => {
    const settings = {
      ...getDefaultSettings(),
      activePersonaId: 'persona-old',
      userName: '旧身份',
      userDescription: '旧描述',
      userPersona: '旧性格',
    }
    expect(resolveSessionPersonaFields(session('missing'), settings, [])).toEqual({
      activePersonaId: null,
      userName: '用户',
      userDescription: '',
      userPersona: '',
    })
  })
})
