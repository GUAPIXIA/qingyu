/**
 * settings 凭据剥离/回填单元测试（H1 修复）
 * 验证:settings.json 不落明文 apiKey——保存前剥离到 safeStorage,读取时回填,导出仅删除。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

// mock electron:safeStorage 加密可用 + userData 隔离到临时目录
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-settings-test' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8'),
  },
}))

import { stripSecrets, restoreSecrets } from '../settings'
import { getCredential } from '../../services/safeStorage'
import type { Settings } from '../../../shared/types'
import { getDefaultSettings } from '../../../shared/defaults'

function makeSettings(): Settings {
  const s = getDefaultSettings()
  return {
    ...s,
    connectionProfiles: [
      { id: 'p1', name: 'A', provider: 'openai', apiKey: 'sk-test-111', baseUrl: '', model: 'gpt-4o', maxContext: 8000 },
      { id: 'p2', name: 'B', provider: 'claude', apiKey: '', baseUrl: '', model: 'claude-3', maxContext: 8000 },
    ],
    ttsModels: [
      { id: 't1', name: 'T', provider: 'edge', model: 'x', apiKey: 'tts-key-222', order: 0, voice: 'v', baseUrl: '', proxy: '', enabled: true },
    ],
    imageGenModels: [
      { id: 'g1', name: 'G', provider: 'sd', model: 'm', apiKey: 'img-key-333', order: 0, baseUrl: '', size: '', steps: 20, cfgScale: 7, negativePrompt: '', quality: 'standard', enabled: true },
    ],
    visionModels: [
      { id: 'v1', name: 'V', provider: 'openai', model: 'gpt-4o-mini', apiKey: 'vision-key-444', enabled: true, order: 0 },
    ],
  }
}

beforeEach(() => {
  // 清理临时凭据文件（safeStorage 使用固定目录，测试间隔离）
  const { unlinkSync, existsSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const path = join('/tmp/qingyu-settings-test/data/config', 'credentials.json')
  if (existsSync(path)) unlinkSync(path)
})

describe('stripSecrets', () => {
  it('persist=true 时把 apiKey 写入 safeStorage 并从 settings 删除', () => {
    const s = makeSettings()
    stripSecrets(s, true)

    // settings 对象不再含明文
    expect(s.connectionProfiles[0].apiKey).toBeUndefined()
    expect(s.ttsModels[0].apiKey).toBeUndefined()
    expect(s.imageGenModels[0].apiKey).toBeUndefined()
    expect(s.visionModels[0].apiKey).toBeUndefined()

    // safeStorage 可读回
    expect(getCredential('profile-p1')).toBe('sk-test-111')
    expect(getCredential('tts-t1')).toBe('tts-key-222')
    expect(getCredential('imagegen-g1')).toBe('img-key-333')
    expect(getCredential('vision-v1')).toBe('vision-key-444')
    // 空 key 不落库
    expect(getCredential('profile-p2')).toBeNull()
  })

  it('persist=false（导出备份）时仅删除不落库', () => {
    const s = makeSettings()
    stripSecrets(s, false)

    expect(s.connectionProfiles[0].apiKey).toBeUndefined()
    expect(getCredential('profile-p1')).toBeNull()
  })
})

describe('restoreSecrets', () => {
  it('从 safeStorage 回填 apiKey', () => {
    const s = makeSettings()
    stripSecrets(s, true)

    // 模拟重新从磁盘读到的 settings（无 key，空字符串）
    const loaded = makeSettings()
    loaded.connectionProfiles.forEach((p) => { p.apiKey = '' })
    loaded.ttsModels.forEach((m) => { m.apiKey = '' })
    loaded.imageGenModels.forEach((m) => { m.apiKey = '' })
    loaded.visionModels.forEach((m) => { m.apiKey = '' })
    restoreSecrets(loaded)

    expect(loaded.connectionProfiles[0].apiKey).toBe('sk-test-111')
    expect(loaded.ttsModels[0].apiKey).toBe('tts-key-222')
    expect(loaded.imageGenModels[0].apiKey).toBe('img-key-333')
    expect(loaded.visionModels[0].apiKey).toBe('vision-key-444')
  })

  it('无凭据时保留 settings 中的旧明文（兼容）', () => {
    const s = makeSettings()
    // 不剥离,直接回填——明文保留
    restoreSecrets(s)
    expect(s.connectionProfiles[0].apiKey).toBe('sk-test-111')
  })
})
