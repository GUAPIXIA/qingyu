import { create } from 'zustand'
import type { Persona } from '../../shared/types'
import { useSettingsStore } from './useSettingsStore'

interface PersonaState {
  personas: Persona[]
  loaded: boolean
  loadPersonas: () => Promise<void>
  getPersona: (id: string | null | undefined) => Persona | undefined
  savePersona: (persona: Persona) => Promise<Persona>
  deletePersona: (id: string) => Promise<void>
}

export const usePersonaStore = create<PersonaState>((set, get) => ({
  personas: [],
  loaded: false,

  loadPersonas: async () => {
    const list = await window.api.persona.list()
    set({ personas: list, loaded: true })
  },

  getPersona: (id) => {
    if (!id) return undefined
    return get().personas.find((p) => p.id === id)
  },

  savePersona: async (persona) => {
    persona.updatedAt = Date.now()
    const saved = await window.api.persona.save(persona)
    set((state) => {
      const idx = state.personas.findIndex((p) => p.id === saved.id)
      const personas = [...state.personas]
      if (idx >= 0) personas[idx] = saved
      else personas.push(saved)
      return { personas }
    })
    return saved
  },

  deletePersona: async (id) => {
    await window.api.persona.delete(id)
    set((state) => ({
      personas: state.personas.filter((p) => p.id !== id),
    }))
  },
}))

/**
 * 一致性（UEX-P1-30）：「激活身份 → 同步 settings 快照」的唯一写入口。
 * settings 的 userName / userDescription / userPersona 是生成管线消费的**快照**，
 * persona 存储（本 store）是真源；只允许经此入口写快照，
 * 禁止在别处直接 updateSettings({ userName, userDescription, userPersona }) 造成双源漂移。
 * - persona 非空：激活该身份（activePersonaId 与快照三字段一并写入）
 * - persona 为 null：无激活身份，快照复位为空身份（'用户' / 空描述 / 空性格）
 * 不改字段结构：生成管线仍按既有 Settings 字段读取，保持兼容。
 */
export function syncActivePersonaToSettings(persona: Persona | null): void {
  useSettingsStore.getState().updateSettings(
    persona
      ? {
          activePersonaId: persona.id,
          userName: persona.name || '用户',
          userDescription: persona.description || '',
          userPersona: persona.persona || '',
        }
      : {
          activePersonaId: null,
          userName: '用户',
          userDescription: '',
          userPersona: '',
        },
  )
}
