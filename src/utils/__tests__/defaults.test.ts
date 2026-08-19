import { describe, it, expect } from 'vitest'
import { getDefaultSettings } from '../../../shared/defaults'
import {
  BUILTIN_FONTS,
  THEME_COLORS,
  PROVIDER_INFO,
  isConnectionConfigured,
  isLocalUrl,
  getDefaultSettings as reExportedGetDefaultSettings,
} from '../defaults'

describe('getDefaultSettings', () => {
  it('returns an object with fontFamily equal to "system"', () => {
    const settings = getDefaultSettings()
    expect(settings.fontFamily).toBe('system')
  })

  it('returns an object with customFontId equal to null', () => {
    const settings = getDefaultSettings()
    expect(settings.customFontId).toBeNull()
  })

  it('returns all required fields (theme, themeColor, fontSize, bubbleStyle, messageSpacing, messageWidth, streamOutput, autoScroll)', () => {
    const settings = getDefaultSettings()
    expect(settings).toHaveProperty('theme')
    expect(settings).toHaveProperty('themeColor')
    expect(settings).toHaveProperty('fontSize')
    expect(settings).toHaveProperty('bubbleStyle')
    expect(settings).toHaveProperty('messageSpacing')
    expect(settings).toHaveProperty('messageWidth')
    expect(settings).toHaveProperty('streamOutput')
    expect(settings).toHaveProperty('autoScroll')
  })

  it('returns sensible default values for the required fields', () => {
    const settings = getDefaultSettings()
    expect(typeof settings.theme).toBe('string')
    expect(typeof settings.themeColor).toBe('string')
    expect(typeof settings.fontSize).toBe('string')
    expect(typeof settings.bubbleStyle).toBe('string')
    expect(typeof settings.messageSpacing).toBe('number')
    expect(typeof settings.messageWidth).toBe('number')
    expect(typeof settings.streamOutput).toBe('boolean')
    expect(typeof settings.autoScroll).toBe('boolean')
  })

  it('returns a new object on each call (no shared mutable state)', () => {
    const a = getDefaultSettings()
    const b = getDefaultSettings()
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })

  it('is re-exported from src/utils/defaults pointing to the same function', () => {
    expect(reExportedGetDefaultSettings).toBe(getDefaultSettings)
  })
})

describe('BUILTIN_FONTS', () => {
  it('has exactly 6 entries', () => {
    expect(BUILTIN_FONTS).toHaveLength(6)
  })

  it('each entry has value, label, family, and preview properties', () => {
    for (const font of BUILTIN_FONTS) {
      expect(font).toHaveProperty('value')
      expect(font).toHaveProperty('label')
      expect(font).toHaveProperty('family')
      expect(font).toHaveProperty('preview')
      expect(typeof font.value).toBe('string')
      expect(typeof font.label).toBe('string')
      expect(typeof font.family).toBe('string')
      expect(typeof font.preview).toBe('string')
    }
  })

  it('includes system, arial, yahei, simsun, simhei, kaiti', () => {
    const values = BUILTIN_FONTS.map((f) => f.value)
    expect(values).toEqual(
      expect.arrayContaining(['system', 'arial', 'yahei', 'simsun', 'simhei', 'kaiti']),
    )
  })

  it('has unique values across all entries', () => {
    const values = BUILTIN_FONTS.map((f) => f.value)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('THEME_COLORS', () => {
  it('has 6 color entries (amber, emerald, ocean, rose, purple, cyan)', () => {
    const keys = Object.keys(THEME_COLORS)
    expect(keys).toHaveLength(6)
    expect(keys).toEqual(
      expect.arrayContaining(['amber', 'emerald', 'ocean', 'rose', 'purple', 'cyan']),
    )
  })

  it('each entry has name and color properties', () => {
    const entries = Object.values(THEME_COLORS)
    for (const entry of entries) {
      expect(entry).toHaveProperty('name')
      expect(entry).toHaveProperty('color')
      expect(typeof entry.name).toBe('string')
      expect(typeof entry.color).toBe('string')
      // color should be a hex color string
      expect(entry.color).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })
})

describe('PROVIDER_INFO', () => {
  it('defines the expected providers', () => {
    const keys = Object.keys(PROVIDER_INFO)
    expect(keys).toEqual(
      expect.arrayContaining(['openai', 'claude', 'gemini', 'ollama']),
    )
  })

  it('each provider has name, description, placeholder, and keyLabel', () => {
    for (const entry of Object.values(PROVIDER_INFO)) {
      expect(entry).toHaveProperty('name')
      expect(entry).toHaveProperty('description')
      expect(entry).toHaveProperty('placeholder')
      expect(entry).toHaveProperty('keyLabel')
    }
  })
})

describe('isLocalUrl', () => {
  it('识别 localhost 与回环地址', () => {
    expect(isLocalUrl('http://localhost:11434')).toBe(true)
    expect(isLocalUrl('http://localhost:8000/v1')).toBe(true)
    expect(isLocalUrl('http://127.0.0.1:5000/v1')).toBe(true)
    expect(isLocalUrl('http://0.0.0.0:8000')).toBe(true)
    expect(isLocalUrl('http://[::1]:8080')).toBe(true)
  })

  it('识别无协议前缀的本地地址', () => {
    expect(isLocalUrl('localhost:1234')).toBe(true)
    expect(isLocalUrl('127.0.0.1:11434')).toBe(true)
  })

  it('拒绝远程地址与空值', () => {
    expect(isLocalUrl('https://api.openai.com/v1')).toBe(false)
    expect(isLocalUrl('https://opencode.ai/zen/go/v1')).toBe(false)
    expect(isLocalUrl('https://localhost.evil.com')).toBe(false)
    expect(isLocalUrl('')).toBe(false)
    expect(isLocalUrl(null)).toBe(false)
    expect(isLocalUrl(undefined)).toBe(false)
  })
})

describe('isConnectionConfigured', () => {
  it('允许 OpenCode Go 端点在无 API Key 时使用', () => {
    expect(isConnectionConfigured({
      provider: 'openai',
      baseUrl: 'https://opencode.ai/zen/go/v1/',
      apiKey: '',
    })).toBe(true)
  })

  it('普通远程端点仍要求 API Key', () => {
    expect(isConnectionConfigured({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '' })).toBe(false)
    expect(isConnectionConfigured({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' })).toBe(true)
  })
})
