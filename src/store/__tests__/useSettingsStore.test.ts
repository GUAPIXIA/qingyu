import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useSettingsStore } from '../useSettingsStore'
import { getDefaultSettings } from '../../../shared/defaults'
import type { ConnectionProfile } from '../../../shared/types'

// 辅助函数：创建测试 profile
function createProfile(id: string, overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id,
    name: `Profile-${id}`,
    provider: 'openai',
    baseUrl: '',
    model: 'gpt-4o',
    apiKey: '',
    maxContext: 0,
    ...overrides,
  }
}

describe('useSettingsStore', () => {
  beforeEach(() => {
    // 清除所有挂起的定时器（防止前一个测试的 debounce timer 干扰）
    vi.clearAllTimers()
    // 重置 store 到默认状态
    useSettingsStore.setState({
      settings: getDefaultSettings(),
      credentials: {},
      loaded: false,
      _saveTimer: null,
    })
    // 确保 window.api.settings.save 返回 Promise
    vi.mocked(window.api.settings.save).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.clearAllTimers()
  })

  describe('initial state', () => {
    it('has loaded: false initially', () => {
      expect(useSettingsStore.getState().loaded).toBe(false)
    })

    it('has default settings', () => {
      const { settings } = useSettingsStore.getState()
      expect(settings.theme).toBe('dark')
      expect(settings.themeColor).toBe('amber')
      expect(settings.fontSize).toBe('comfortable')
      expect(settings.fontFamily).toBe('system')
      expect(settings.customFontId).toBeNull()
    })
  })

  describe('updateSettings', () => {
    it('merges partial settings into existing settings', () => {
      useSettingsStore.getState().updateSettings({ theme: 'light' })
      expect(useSettingsStore.getState().settings.theme).toBe('light')
      expect(useSettingsStore.getState().settings.themeColor).toBe('amber')
    })

    it('updates fontFamily', () => {
      useSettingsStore.getState().updateSettings({ fontFamily: 'arial' })
      expect(useSettingsStore.getState().settings.fontFamily).toBe('arial')
    })

    it('updates customFontId', () => {
      useSettingsStore.getState().updateSettings({ customFontId: 'test-font-id' })
      expect(useSettingsStore.getState().settings.customFontId).toBe('test-font-id')
    })

    it('triggers a debounced save (calls window.api.settings.save after 300ms)', async () => {
      const saveSpy = vi.mocked(window.api.settings.save)
      saveSpy.mockClear()
      useSettingsStore.getState().updateSettings({ theme: 'light' })
      expect(saveSpy).not.toHaveBeenCalled()
      await new Promise(resolve => setTimeout(resolve, 350))
      expect(saveSpy).toHaveBeenCalled()
    })
  })

  describe('flushSettings', () => {
    it('immediately saves bypassing debounce', () => {
      const saveSpy = vi.mocked(window.api.settings.save)
      useSettingsStore.getState().updateSettings({ theme: 'light' })
      useSettingsStore.getState().flushSettings()
      expect(saveSpy).toHaveBeenCalledTimes(1)
    })

    it('clears the save timer after flush', () => {
      useSettingsStore.getState().updateSettings({ theme: 'light' })
      useSettingsStore.getState().flushSettings()
      expect(useSettingsStore.getState()._saveTimer).toBeNull()
    })
  })

  describe('getActiveProfile', () => {
    it('returns null when no activeProfileId', () => {
      expect(useSettingsStore.getState().getActiveProfile()).toBeNull()
    })

    it('returns null when activeProfileId does not match any profile', () => {
      useSettingsStore.setState({
        settings: {
          ...getDefaultSettings(),
          activeProfileId: 'non-existent',
          connectionProfiles: [],
        },
      })
      expect(useSettingsStore.getState().getActiveProfile()).toBeNull()
    })

    it('returns profile data when activeProfileId is set', () => {
      const profile = createProfile('p1', { name: 'Test Profile', model: 'gpt-4o', apiKey: 'sk-test' })
      useSettingsStore.setState({
        settings: {
          ...getDefaultSettings(),
          activeProfileId: 'p1',
          connectionProfiles: [profile],
        },
      })
      const result = useSettingsStore.getState().getActiveProfile()
      expect(result).not.toBeNull()
      expect(result!.name).toBe('Test Profile')
      expect(result!.provider).toBe('openai')
      expect(result!.model).toBe('gpt-4o')
    })

    it('returns maxContext as 0 when profile maxContext is 0 (follow model)', () => {
      const profile = createProfile('p1', { maxContext: 0 })
      useSettingsStore.setState({
        settings: {
          ...getDefaultSettings(),
          activeProfileId: 'p1',
          connectionProfiles: [profile],
        },
      })
      expect(useSettingsStore.getState().getActiveProfile()!.maxContext).toBe(0)
    })
  })

  describe('addProfile', () => {
    it('adds a new profile to the list', () => {
      useSettingsStore.getState().addProfile({
        name: 'New Profile',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        apiKey: 'sk-test',
        maxContext: 128000,
      })
      expect(useSettingsStore.getState().settings.connectionProfiles).toHaveLength(1)
    })

    it('auto-sets new profile as active when it is the first', () => {
      useSettingsStore.getState().addProfile({
        name: 'First Profile',
        provider: 'openai',
        baseUrl: '',
        model: 'gpt-4o',
        apiKey: '',
        maxContext: 0,
      })
      const { settings } = useSettingsStore.getState()
      expect(settings.activeProfileId).toBeTruthy()
      expect(settings.connectionProfiles[0].id).toBe(settings.activeProfileId)
    })
  })

  describe('deleteProfile', () => {
    it('removes the profile from the list', () => {
      const p1 = createProfile('p1', { name: 'P1' })
      const p2 = createProfile('p2', { name: 'P2' })
      useSettingsStore.setState({
        settings: {
          ...getDefaultSettings(),
          connectionProfiles: [p1, p2],
          activeProfileId: 'p1',
        },
      })
      useSettingsStore.getState().deleteProfile('p1')
      expect(useSettingsStore.getState().settings.connectionProfiles).toHaveLength(1)
      expect(useSettingsStore.getState().settings.connectionProfiles[0].name).toBe('P2')
    })

    it('updates activeProfileId to first remaining when deleting active', () => {
      const p1 = createProfile('p1', { name: 'P1' })
      const p2 = createProfile('p2', { name: 'P2' })
      useSettingsStore.setState({
        settings: {
          ...getDefaultSettings(),
          connectionProfiles: [p1, p2],
          activeProfileId: 'p1',
        },
      })
      useSettingsStore.getState().deleteProfile('p1')
      const newSettings = useSettingsStore.getState().settings
      expect(newSettings.connectionProfiles).toHaveLength(1)
      expect(newSettings.activeProfileId).toBe('p2')
    })

    it('sets activeProfileId to null when deleting the only profile', () => {
      const p1 = createProfile('p1', { name: 'P1' })
      useSettingsStore.setState({
        settings: {
          ...getDefaultSettings(),
          connectionProfiles: [p1],
          activeProfileId: 'p1',
        },
      })
      useSettingsStore.getState().deleteProfile('p1')
      expect(useSettingsStore.getState().settings.connectionProfiles).toHaveLength(0)
      expect(useSettingsStore.getState().settings.activeProfileId).toBeNull()
    })
  })

  describe('setActiveProfileId', () => {
    it('sets the active profile id and updates activeModel', () => {
      const p1 = createProfile('p1', { name: 'P1', model: 'gpt-4o' })
      const p2 = createProfile('p2', { name: 'P2', model: 'claude-3' })
      useSettingsStore.setState({
        settings: {
          ...getDefaultSettings(),
          connectionProfiles: [p1, p2],
          activeProfileId: 'p1',
        },
      })
      useSettingsStore.getState().setActiveProfileId('p2')
      expect(useSettingsStore.getState().settings.activeProfileId).toBe('p2')
      expect(useSettingsStore.getState().settings.activeModel).toBe('claude-3')
    })

    it('does nothing when id does not exist', () => {
      const p1 = createProfile('p1', { name: 'P1' })
      useSettingsStore.setState({
        settings: {
          ...getDefaultSettings(),
          connectionProfiles: [p1],
          activeProfileId: 'p1',
        },
      })
      useSettingsStore.getState().setActiveProfileId('non-existent')
      expect(useSettingsStore.getState().settings.activeProfileId).toBe('p1')
    })
  })

  describe('font settings', () => {
    it('can update fontFamily and customFontId together', () => {
      useSettingsStore.getState().updateSettings({ fontFamily: 'custom-font', customFontId: 'font-123' })
      const { settings } = useSettingsStore.getState()
      expect(settings.fontFamily).toBe('custom-font')
      expect(settings.customFontId).toBe('font-123')
    })

    it('can reset fontFamily to system default', () => {
      useSettingsStore.getState().updateSettings({ fontFamily: 'arial', customFontId: null })
      useSettingsStore.getState().updateSettings({ fontFamily: 'system', customFontId: null })
      const { settings } = useSettingsStore.getState()
      expect(settings.fontFamily).toBe('system')
      expect(settings.customFontId).toBeNull()
    })
  })
})
