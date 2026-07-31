import { create } from 'zustand'
import type { Settings, ProviderType, ConnectionProfile, TTSModelConfig, ImageGenModelConfig, VisionModelConfig } from '../../shared/types'
import { getDefaultSettings } from '../utils/defaults'
import { nanoid } from 'nanoid'
import { logError } from '../lib/logger'

export interface ActiveProfile {
  name: string
  provider: ProviderType
  apiKey: string
  baseUrl: string
  model: string
  maxContext: number
  useInstructTemplate?: boolean
}

export interface ActiveTTSProfile {
  name: string
  provider: TTSModelConfig['provider']
  model: string
  voice: string
  apiKey: string
  baseUrl: string
  proxy?: string
}

export interface ActiveImageGenProfile {
  name: string
  provider: string
  model: string
  apiKey: string
  baseUrl: string
  size: string
  quality: string
}

interface SettingsState {
  settings: Settings
  credentials: Record<string, string>
  loaded: boolean
  _saveTimer: ReturnType<typeof setTimeout> | null
  loadSettings: () => Promise<void>
  saveSettings: () => Promise<void>
  /** 立即刷新待保存的设置到磁盘（绕过防抖） */
  flushSettings: () => void
  updateSettings: (partial: Partial<Settings>) => void
  setActiveProvider: (provider: ProviderType) => void
  saveCredential: (provider: string, key: string) => Promise<void>
  getCredential: (provider: string) => Promise<string | null>
  // Profile 系统
  getActiveProfile: () => ActiveProfile | null
  addProfile: (profile: Omit<ConnectionProfile, 'id'>) => void
  updateProfile: (id: string, patch: Partial<ConnectionProfile>) => void
  deleteProfile: (id: string) => void
  setActiveProfileId: (id: string) => void
  // TTS 模型管理
  getActiveTTS: () => ActiveTTSProfile | null
  addTTSModel: (model: Omit<TTSModelConfig, 'id' | 'order'>) => void
  updateTTSModel: (id: string, patch: Partial<TTSModelConfig>) => void
  deleteTTSModel: (id: string) => void
  setActiveTTSModelId: (id: string) => void
  reorderTTSModels: (ids: string[]) => void
  // 生图模型管理
  getActiveImageGen: () => ActiveImageGenProfile | null
  addImageGenModel: (model: Omit<ImageGenModelConfig, 'id' | 'order'>) => void
  updateImageGenModel: (id: string, patch: Partial<ImageGenModelConfig>) => void
  deleteImageGenModel: (id: string) => void
  setActiveImageGenModelId: (id: string) => void
  reorderImageGenModels: (ids: string[]) => void
  // 识图模型管理
  getActiveVision: () => VisionModelConfig | null
  addVisionModel: (model: Omit<VisionModelConfig, 'id' | 'order'>) => void
  updateVisionModel: (id: string, patch: Partial<VisionModelConfig>) => void
  deleteVisionModel: (id: string) => void
  setActiveVisionModelId: (id: string) => void
  reorderVisionModels: (ids: string[]) => void
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: getDefaultSettings(),
  credentials: {},
  loaded: false,
  _saveTimer: null,

  loadSettings: async () => {
    const settings = await window.api.settings.get()

    // 加载旧版凭据
    const credentials: Record<string, string> = {}
    for (const provider of ['openai', 'claude', 'gemini', 'ollama']) {
      const key = await window.api.settings.getAPICredential(provider)
      if (key) credentials[provider] = key
    }

    // 旧数据迁移：如果 profiles 为空但有旧版 provider 配置，自动创建 profile
    const profiles = settings.connectionProfiles || []
    if (profiles.length === 0 && settings.providers) {
      const defaultProviders: ProviderType[] = ['openai', 'claude', 'gemini', 'ollama']
      const defaultMaxContext: Record<string, number> = {
        openai: 131072, claude: 200000, gemini: 1048576, ollama: 8192,
      }
      for (const p of defaultProviders) {
        const key = credentials[p] || ''
        if (key || p === 'ollama') {
          const pCfg = settings.providers[p]
          const names: Record<string, string> = { openai: 'OpenAI', claude: 'Claude', gemini: 'Gemini', ollama: 'Ollama' }
          profiles.push({
            id: nanoid(),
            name: names[p] || p,
            provider: p,
            baseUrl: pCfg.baseUrl,
            model: pCfg.model,
            apiKey: key,
            maxContext: defaultMaxContext[p] || 8192,
          })
        }
      }
      if (profiles.length > 0 && !settings.activeProfileId) {
        settings.activeProfileId = profiles[0].id
      }
      settings.connectionProfiles = profiles
      await window.api.settings.save(settings)
    }

    // 旧 TTS/生图/识图 数据迁移：将单字段迁移为模型数组
    const legacySettings = settings as Settings & {
      ttsProvider?: string
      ttsVoice?: string
      ttsModel?: string
      visionModel?: string
      imageGenModel?: string
    }

    // TTS 迁移
    if (!settings.ttsModels || settings.ttsModels.length === 0) {
      if (legacySettings.ttsModel || legacySettings.ttsProvider) {
        settings.ttsModels = [{
          id: nanoid(),
          name: '默认 TTS',
          // 旧值 edge 迁移为 system（3.2-A：系统语音引擎）
          provider: ((legacySettings.ttsProvider as 'edge' | 'openai') === 'openai' ? 'openai' : 'system') as TTSModelConfig['provider'],
          model: legacySettings.ttsModel || 'tts-1',
          voice: legacySettings.ttsVoice || '',
          apiKey: '',
          baseUrl: 'https://api.openai.com/v1',
          enabled: true,
          order: 0,
        }]
        settings.activeTTSModelId = settings.ttsModels[0].id
      } else {
        settings.ttsModels = []
      }
    } else {
      // 存量 'edge' 值统一迁移为 'system'
      for (const m of settings.ttsModels) {
        if (m.provider === 'edge') m.provider = 'system'
      }
    }

    // 生图迁移
    if (!settings.imageGenModels || settings.imageGenModels.length === 0) {
      if (legacySettings.imageGenModel) {
        settings.imageGenModels = [{
          id: nanoid(),
          name: '默认生图',
          provider: 'openai',
          model: legacySettings.imageGenModel,
          apiKey: '',
          baseUrl: '',
          size: '1024x1024',
          quality: 'standard',
          enabled: true,
          order: 0,
        }]
        settings.activeImageGenModelId = settings.imageGenModels[0].id
      } else {
        settings.imageGenModels = []
      }
    }

    // 识图迁移
    if (!settings.visionModels || settings.visionModels.length === 0) {
      if (legacySettings.visionModel) {
        settings.visionModels = [{
          id: nanoid(),
          name: '默认识图',
          model: legacySettings.visionModel,
          enabled: true,
          order: 0,
        }]
        settings.activeVisionModelId = settings.visionModels[0].id
      } else {
        settings.visionModels = []
      }
    }

    // 清理旧字段，保存迁移结果
    if (legacySettings.ttsProvider !== undefined || legacySettings.ttsVoice !== undefined ||
        legacySettings.ttsModel !== undefined || legacySettings.visionModel !== undefined ||
        legacySettings.imageGenModel !== undefined) {
      const cleaned = settings as unknown as Record<string, unknown>
      delete cleaned.ttsProvider
      delete cleaned.ttsVoice
      delete cleaned.ttsModel
      delete cleaned.visionModel
      delete cleaned.imageGenModel
      await window.api.settings.save(settings)
    }

    set({ settings, credentials, loaded: true })
  },

  saveSettings: async () => {
    try {
      await window.api.settings.save(get().settings)
    } catch (err) {
      logError('SettingsStore:save', err)
    }
  },

  /** 立即刷新待保存的设置到磁盘（绕过防抖），用于 app 退出前 */
  flushSettings: () => {
    const self = get()
    if (self._saveTimer) {
      clearTimeout(self._saveTimer)
      set({ _saveTimer: null })
    }
    window.api.settings.save(get().settings).catch((e) => logError('SettingsStore:flush', e))
  },

  updateSettings: (partial) => {
    set((state) => ({
      settings: { ...state.settings, ...partial },
    }))
    const self = get()
    if (self._saveTimer) clearTimeout(self._saveTimer)
    const timer = setTimeout(() => {
      set({ _saveTimer: null })
      window.api.settings.save(get().settings).catch((e) => logError('SettingsStore:update', e))
    }, 300)
    set({ _saveTimer: timer })
  },

  setActiveProvider: (provider) => {
    set((state) => ({
      settings: {
        ...state.settings,
        activeProvider: provider,
        activeModel: state.settings.providers[provider].model,
      },
    }))
    void get().saveSettings()
  },

  saveCredential: async (provider, key) => {
    await window.api.settings.saveAPICredential(provider, key)
    set((state) => ({
      credentials: { ...state.credentials, [provider]: key },
    }))
  },

  getCredential: async (provider) => {
    return get().credentials[provider] ?? null
  },

  // ========== Profile 系统 ==========

  getActiveProfile: () => {
    const { settings } = get()
    if (!settings.activeProfileId) return null
    const profile = settings.connectionProfiles.find((p) => p.id === settings.activeProfileId)
    if (!profile) return null
    return {
      name: profile.name,
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: profile.model,
      maxContext: profile.maxContext || 0, // 0 表示跟随模型默认
      useInstructTemplate: profile.useInstructTemplate,
    }
  },

  addProfile: (input) => {
    const newProfile = { ...input, id: nanoid() }
    set((state) => {
      const profiles = [...state.settings.connectionProfiles, newProfile]
      // 如果是第一个 profile，自动设为 active
      const isFirst = state.settings.connectionProfiles.length === 0 && !state.settings.activeProfileId
      return {
        settings: {
          ...state.settings,
          connectionProfiles: profiles,
          activeProfileId: isFirst ? newProfile.id : state.settings.activeProfileId,
        },
      }
    })
    void get().saveSettings()
  },

  updateProfile: (id, patch) => {
    set((state) => ({
      settings: {
        ...state.settings,
        connectionProfiles: state.settings.connectionProfiles.map((p) =>
          p.id === id ? { ...p, ...patch } : p
        ),
      },
    }))
    void get().saveSettings()
  },

  deleteProfile: (id) => {
    set((state) => {
      const profiles = state.settings.connectionProfiles.filter((p) => p.id !== id)
      const newActiveId = state.settings.activeProfileId === id
        ? (profiles[0]?.id ?? null)
        : state.settings.activeProfileId
      return {
        settings: {
          ...state.settings,
          connectionProfiles: profiles,
          activeProfileId: newActiveId,
        },
      }
    })
    void get().saveSettings()
  },

  setActiveProfileId: (id) => {
    const profile = get().settings.connectionProfiles.find((p) => p.id === id)
    if (!profile) return
    set((state) => ({
      settings: {
        ...state.settings,
        activeProfileId: id,
        activeModel: profile.model,
      },
    }))
    void get().saveSettings()
  },

  // ========== TTS 模型管理 ==========

  getActiveTTS: () => {
    const { settings } = get()
    if (!settings.activeTTSModelId) return null
    const m = settings.ttsModels.find((t) => t.id === settings.activeTTSModelId)
    if (!m) return null
    return {
      name: m.name,
      provider: m.provider,
      model: m.model,
      voice: m.voice,
      apiKey: m.apiKey,
      baseUrl: m.baseUrl,
      proxy: m.proxy,
    }
  },

  addTTSModel: (input) => {
    const order = get().settings.ttsModels.length
    const newModel: TTSModelConfig = { ...input, id: nanoid(), order }
    set((state) => {
      const models = [...state.settings.ttsModels, newModel]
      return {
        settings: {
          ...state.settings,
          ttsModels: models,
          activeTTSModelId: state.settings.activeTTSModelId ?? newModel.id,
        },
      }
    })
    void get().saveSettings()
  },

  updateTTSModel: (id, patch) => {
    set((state) => ({
      settings: {
        ...state.settings,
        ttsModels: state.settings.ttsModels.map((m) =>
          m.id === id ? { ...m, ...patch } : m
        ),
      },
    }))
    void get().saveSettings()
  },

  deleteTTSModel: (id) => {
    set((state) => {
      const models = state.settings.ttsModels.filter((m) => m.id !== id)
      const newActiveId = state.settings.activeTTSModelId === id
        ? (models[0]?.id ?? null)
        : state.settings.activeTTSModelId
      return {
        settings: { ...state.settings, ttsModels: models, activeTTSModelId: newActiveId },
      }
    })
    void get().saveSettings()
  },

  setActiveTTSModelId: (id) => {
    set((state) => ({
      settings: { ...state.settings, activeTTSModelId: id },
    }))
    void get().saveSettings()
  },

  reorderTTSModels: (ids) => {
    set((state) => {
      const models = ids
        .map((id, i) => {
          const m = state.settings.ttsModels.find((t) => t.id === id)
          return m ? { ...m, order: i } : null
        })
        .filter(Boolean) as TTSModelConfig[]
      return {
        settings: { ...state.settings, ttsModels: models },
      }
    })
    void get().saveSettings()
  },

  // ========== 生图模型管理 ==========

  getActiveImageGen: () => {
    const { settings } = get()
    if (!settings.activeImageGenModelId) return null
    const m = settings.imageGenModels.find((t) => t.id === settings.activeImageGenModelId)
    if (!m) return null
    return {
      name: m.name,
      provider: m.provider,
      model: m.model,
      apiKey: m.apiKey,
      baseUrl: m.baseUrl,
      size: m.size,
      quality: m.quality,
    }
  },

  addImageGenModel: (input) => {
    const order = get().settings.imageGenModels.length
    const newModel: ImageGenModelConfig = { ...input, id: nanoid(), order }
    set((state) => {
      const models = [...state.settings.imageGenModels, newModel]
      return {
        settings: {
          ...state.settings,
          imageGenModels: models,
          activeImageGenModelId: state.settings.activeImageGenModelId ?? newModel.id,
        },
      }
    })
    void get().saveSettings()
  },

  updateImageGenModel: (id, patch) => {
    set((state) => ({
      settings: {
        ...state.settings,
        imageGenModels: state.settings.imageGenModels.map((m) =>
          m.id === id ? { ...m, ...patch } : m
        ),
      },
    }))
    void get().saveSettings()
  },

  deleteImageGenModel: (id) => {
    set((state) => {
      const models = state.settings.imageGenModels.filter((m) => m.id !== id)
      const newActiveId = state.settings.activeImageGenModelId === id
        ? (models[0]?.id ?? null)
        : state.settings.activeImageGenModelId
      return {
        settings: { ...state.settings, imageGenModels: models, activeImageGenModelId: newActiveId },
      }
    })
    void get().saveSettings()
  },

  setActiveImageGenModelId: (id) => {
    set((state) => ({
      settings: { ...state.settings, activeImageGenModelId: id },
    }))
    void get().saveSettings()
  },

  reorderImageGenModels: (ids) => {
    set((state) => {
      const models = ids
        .map((id, i) => {
          const m = state.settings.imageGenModels.find((t) => t.id === id)
          return m ? { ...m, order: i } : null
        })
        .filter(Boolean) as ImageGenModelConfig[]
      return {
        settings: { ...state.settings, imageGenModels: models },
      }
    })
    void get().saveSettings()
  },

  // ========== 识图模型管理 ==========

  getActiveVision: () => {
    const { settings } = get()
    if (!settings.activeVisionModelId) return null
    return settings.visionModels.find((m) => m.id === settings.activeVisionModelId) ?? null
  },

  addVisionModel: (input) => {
    const order = get().settings.visionModels.length
    const newModel: VisionModelConfig = { ...input, id: nanoid(), order }
    set((state) => {
      const models = [...state.settings.visionModels, newModel]
      return {
        settings: {
          ...state.settings,
          visionModels: models,
          activeVisionModelId: state.settings.activeVisionModelId ?? newModel.id,
        },
      }
    })
    void get().saveSettings()
  },

  updateVisionModel: (id, patch) => {
    set((state) => ({
      settings: {
        ...state.settings,
        visionModels: state.settings.visionModels.map((m) =>
          m.id === id ? { ...m, ...patch } : m
        ),
      },
    }))
    void get().saveSettings()
  },

  deleteVisionModel: (id) => {
    set((state) => {
      const models = state.settings.visionModels.filter((m) => m.id !== id)
      const newActiveId = state.settings.activeVisionModelId === id
        ? (models[0]?.id ?? null)
        : state.settings.activeVisionModelId
      return {
        settings: { ...state.settings, visionModels: models, activeVisionModelId: newActiveId },
      }
    })
    void get().saveSettings()
  },

  setActiveVisionModelId: (id) => {
    set((state) => ({
      settings: { ...state.settings, activeVisionModelId: id },
    }))
    void get().saveSettings()
  },

  reorderVisionModels: (ids) => {
    set((state) => {
      const models = ids
        .map((id, i) => {
          const m = state.settings.visionModels.find((t) => t.id === id)
          return m ? { ...m, order: i } : null
        })
        .filter(Boolean) as VisionModelConfig[]
      return {
        settings: { ...state.settings, visionModels: models },
      }
    })
    void get().saveSettings()
  },
}))
