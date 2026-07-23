import { create } from 'zustand'
import type { Persona } from '../../shared/types'

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
