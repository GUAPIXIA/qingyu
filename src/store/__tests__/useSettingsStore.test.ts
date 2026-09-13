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
      saveStatus: 'idle',
      saveError: null,
      loadFailed: false,
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

  describe('loadSettings 旧数据兜底（B2：只读，不写盘）', () => {
    it('旧单字段迁移到内存后不触发 settings.save（持久化由主进程迁移链负责）', async () => {
      const saveSpy = vi.mocked(window.api.settings.save)
      saveSpy.mockClear()
      vi.mocked(window.api.settings.get).mockResolvedValue({
        ...getDefaultSettings(),
        ttsProvider: 'edge',
        ttsVoice: 'v1',
        ttsModel: 'tts-1',
        imageGenModel: 'dall-e-3',
        visionModel: 'gpt-4o-vision',
        authorNote: { enabled: true, text: '旧作者注释' },
      } as never)

      await useSettingsStore.getState().loadSettings()

      const { settings } = useSettingsStore.getState()
      expect(settings.ttsModels).toHaveLength(1)
      expect(settings.ttsModels[0].provider).toBe('system')
      // imageGenModels 是联合类型（comfyui 分支无 model 字段），此处断言迁移出的 openai 分支
      expect((settings.imageGenModels[0] as { model?: string } | undefined)?.model).toBe('dall-e-3')
      expect(settings.visionModels[0]?.model).toBe('gpt-4o-vision')
      const legacy = settings as unknown as Record<string, unknown>
      expect(legacy.ttsProvider).toBeUndefined()
      expect(legacy.imageGenModel).toBeUndefined()
      expect(legacy.authorNote).toBeUndefined()
      expect(saveSpy).not.toHaveBeenCalled()
      expect(useSettingsStore.getState().loaded).toBe(true)
    })

    it('旧 providers 配置在内存中兜底为连接档案，同样不写盘', async () => {
      const saveSpy = vi.mocked(window.api.settings.save)
      saveSpy.mockClear()
      vi.mocked(window.api.settings.get).mockResolvedValue({
        ...getDefaultSettings(),
        connectionProfiles: [],
        activeProfileId: null,
      } as never)

      await useSettingsStore.getState().loadSettings()

      const { settings } = useSettingsStore.getState()
      // 默认 providers 含 ollama：兜底路径会为它建一条档案（与迁移前行为一致，仅内存）
      expect(settings.connectionProfiles.length).toBeGreaterThan(0)
      expect(settings.activeProfileId).toBe(settings.connectionProfiles[0].id)
      expect(saveSpy).not.toHaveBeenCalled()
    })
  })

  describe('saveStatus（P1-02：由真实落盘结果驱动）', () => {
    it('成功 → saved；失败 → error 带原因；重试成功清除错误', async () => {
      const saveSpy = vi.mocked(window.api.settings.save)
      saveSpy.mockClear()

      saveSpy.mockResolvedValueOnce(undefined)
      await useSettingsStore.getState().saveSettings()
      expect(useSettingsStore.getState().saveStatus).toBe('saved')
      expect(useSettingsStore.getState().saveError).toBeNull()

      saveSpy.mockRejectedValueOnce(new Error('磁盘写入失败'))
      await useSettingsStore.getState().saveSettings()
      expect(useSettingsStore.getState().saveStatus).toBe('error')
      expect(useSettingsStore.getState().saveError).toBe('磁盘写入失败')

      saveSpy.mockResolvedValueOnce(undefined)
      await useSettingsStore.getState().saveSettings()
      expect(useSettingsStore.getState().saveStatus).toBe('saved')
      expect(useSettingsStore.getState().saveError).toBeNull()
    })

    it('防抖路径落盘同样驱动状态', async () => {
      const saveSpy = vi.mocked(window.api.settings.save)
      saveSpy.mockClear()
      saveSpy.mockResolvedValue(undefined)

      useSettingsStore.getState().updateSettings({ theme: 'light' })
      expect(useSettingsStore.getState().saveStatus).toBe('idle')

      await new Promise((resolve) => setTimeout(resolve, 350))
      expect(useSettingsStore.getState().saveStatus).toBe('saved')
    })

    it('flushSettings 落盘失败时进入 error 状态', () => {
      const saveSpy = vi.mocked(window.api.settings.save)
      saveSpy.mockClear()
      saveSpy.mockRejectedValueOnce(new Error('flush failed'))

      useSettingsStore.getState().updateSettings({ theme: 'light' })
      useSettingsStore.getState().flushSettings()

      return new Promise<void>((resolve) => setTimeout(resolve, 20)).then(() => {
        expect(useSettingsStore.getState().saveStatus).toBe('error')
        expect(useSettingsStore.getState().saveError).toBe('flush failed')
      })
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

  // 2026-09-13 数据事故回归：settings:get 抛错时，渲染层曾停留在默认值并继续自动落盘，
  // 把用户的连接档案整段覆盖。加载失败后必须拒绝一切写盘。
  describe('加载失败保护（不得用默认值覆盖用户设置）', () => {
    it('loadSettings 失败 → loadFailed 置位、loaded 保持 false、saveSettings 不落盘', async () => {
      const saveSpy = vi.mocked(window.api.settings.save)
      saveSpy.mockClear()
      vi.mocked(window.api.settings.get).mockRejectedValueOnce(
        new TypeError('value.startsWith is not a function'),
      )

      await useSettingsStore.getState().loadSettings()

      const state = useSettingsStore.getState()
      expect(state.loadFailed).toBe(true)
      expect(state.loaded).toBe(false)
      expect(state.saveError).toContain('设置加载失败')

      await state.saveSettings()
      expect(saveSpy).not.toHaveBeenCalled()
      expect(useSettingsStore.getState().saveStatus).toBe('error')
    })

    it('加载失败后 updateSettings 的防抖保存同样被拒绝', async () => {
      const saveSpy = vi.mocked(window.api.settings.save)
      saveSpy.mockClear()
      vi.mocked(window.api.settings.get).mockRejectedValueOnce(new Error('settings:get failed'))

      await useSettingsStore.getState().loadSettings()
      useSettingsStore.getState().updateSettings({ theme: 'light' })
      await new Promise((resolve) => setTimeout(resolve, 350))

      expect(saveSpy).not.toHaveBeenCalled()
    })

    it('加载成功后 loadFailed 归位，保存恢复正常', async () => {
      const saveSpy = vi.mocked(window.api.settings.save)
      saveSpy.mockClear()
      vi.mocked(window.api.settings.get).mockResolvedValueOnce(getDefaultSettings())

      await useSettingsStore.getState().loadSettings()
      expect(useSettingsStore.getState().loadFailed).toBe(false)
      await useSettingsStore.getState().saveSettings()
      expect(saveSpy).toHaveBeenCalledTimes(1)
    })
  })
})
