/**
 * 阶段 C：settingsSync 纯函数单测。
 * - stableStringify：递归 key 排序、插入序无关；
 * - revision：内容寻址稳定性（相同安全子集同 revision；安全子集变化 revision 变化）；
 * - 白名单：不含 apiKey/connectionProfiles/provider 凭据与 PC 显示偏好；
 * - validateSettingsPatch：文档 §7 C-03 字段类型/范围验证表。
 */
import { describe, expect, it } from 'vitest'
import {
  stableStringify,
  computeRevision,
  toMobileSafeSettings,
  buildSettingsSnapshot,
  diffMobileSafeFields,
  validateSettingsPatch,
} from '../settingsSync'
import { getDefaultSettings } from '../../../shared/defaults'
import type { Settings } from '../../../shared/types'

function makeSettings(): Settings {
  const s = getDefaultSettings()
  return {
    ...s,
    connectionProfiles: [
      { id: 'p1', name: 'A', provider: 'openai', apiKey: 'sk-secret', baseUrl: '', model: 'gpt-4o', maxContext: 8000 },
    ],
    activeProfileId: 'p1',
    activeModel: 'gpt-4o',
    activePresetId: 'builtin-default',
    ttsModels: [{ id: 't1', name: 'T', provider: 'edge', model: 'x', apiKey: 'tts-secret', order: 0, voice: 'v', baseUrl: '', proxy: '', enabled: true }],
    imageGenModels: [{ id: 'g1', name: 'G', provider: 'sd-webui', model: 'm', apiKey: 'img-secret', order: 0, baseUrl: '', size: '512x512', steps: 20, cfgScale: 7, negativePrompt: '', enabled: true }],
    visionModels: [{ id: 'v1', name: 'V', provider: 'openai', model: 'gpt-4o-mini', apiKey: 'vision-secret', enabled: true, order: 0 }],
    providers: {
      ...s.providers,
      openai: { type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    },
  }
}

const EMPTY_CTX = { knownModelIds: null, knownPresetIds: ['builtin-default'] }

describe('stableStringify', () => {
  it('对象 key 插入顺序不影响输出', () => {
    const a = stableStringify({ b: 1, a: { d: 4, c: 3 } })
    const b = stableStringify({ a: { c: 3, d: 4 }, b: 1 })
    expect(a).toBe(b)
  })

  it('数组保持原序；嵌套递归排序', () => {
    expect(stableStringify([2, 1])).not.toBe(stableStringify([1, 2]))
    expect(stableStringify({ x: [{ b: 1, a: 2 }] })).toBe(stableStringify({ x: [{ a: 2, b: 1 }] }))
  })

  it('undefined/null 序列化为 null', () => {
    expect(stableStringify({ a: undefined, b: null })).toBe(stableStringify({ a: null, b: null }))
  })
})

describe('revision 稳定性', () => {
  it('相同安全设置 -> 相同 revision（key 顺序无关）', () => {
    const s1 = makeSettings()
    const s2 = makeSettings()
    // 模拟 JSON 反序列化后的不同 key 序
    const reordered = JSON.parse(JSON.stringify(s2, Object.keys(s2).sort())) as Settings
    expect(computeRevision(toMobileSafeSettings(s1))).toBe(computeRevision(toMobileSafeSettings(reordered)))
  })

  it('安全字段改变 -> revision 改变', () => {
    const a = toMobileSafeSettings(makeSettings())
    const b = { ...a, streamOutput: !a.streamOutput }
    expect(computeRevision(a)).not.toBe(computeRevision(b))
  })

  it('叙事默认值与全局规则进入移动端安全快照', () => {
    const snapshot = buildSettingsSnapshot({
      ...makeSettings(),
      defaultNarrativeMode: 'omniscient',
      omniscientNarrativeRules: '{{user}}观察，由{{char}}推进。',
    })
    expect(snapshot.values.defaultNarrativeMode).toBe('omniscient')
    expect(snapshot.values.omniscientNarrativeRules).toBe('{{user}}观察，由{{char}}推进。')
    expect(diffMobileSafeFields(makeSettings(), {
      ...makeSettings(), defaultNarrativeMode: 'omniscient',
    })).toContain('defaultNarrativeMode')
  })

  it('revision 为 64 位十六进制 sha256', () => {
    expect(computeRevision(toMobileSafeSettings(makeSettings()))).toMatch(/^[0-9a-f]{64}$/)
  })

  it('PC-only 显示偏好变化不影响快照 revision', () => {
    const s = makeSettings()
    const before = buildSettingsSnapshot(s)
    const after = buildSettingsSnapshot({ ...s, themeColor: 'rose', fontSize: 'compact', messageWidth: 640 })
    expect(before.revision).toBe(after.revision)
  })
})

describe('MobileSafeSettings 白名单（敏感字段排除）', () => {
  it('快照 JSON 不含 apiKey/connectionProfiles/provider/凭据与 PC 显示偏好', () => {
    const snapshot = buildSettingsSnapshot(makeSettings())
    const json = JSON.stringify(snapshot)
    expect(json).not.toContain('apiKey')
    expect(json).not.toContain('connectionProfiles')
    expect(json).not.toContain('sk-secret')
    expect(json).not.toContain('tts-secret')
    expect(json).not.toContain('img-secret')
    expect(json).not.toContain('vision-secret')
    expect(json).not.toContain('providers')
    expect(json).not.toContain('baseUrl')
    // PC 显示偏好已移出移动同步清单
    expect(json).not.toContain('themeColor')
    expect(json).not.toContain('fontSize')
    expect(json).not.toContain('bubbleStyle')
    expect(json).not.toContain('messageWidth')
    expect(json).not.toContain('messageSpacing')
    expect(snapshot.schemaVersion).toBe(4)
    expect(snapshot.capabilities).toContain('settings_snapshot_v2')
  })

  it('diffMobileSafeFields 只报告安全字段', () => {
    const s = makeSettings()
    expect(diffMobileSafeFields(s, { ...s, themeColor: 'ocean' })).toEqual([])
    expect(diffMobileSafeFields(s, { ...s, streamOutput: !s.streamOutput })).toEqual(['streamOutput'])
    expect(diffMobileSafeFields(s, { ...s, lorebookRatio: 0.7, userName: '新名' })).toEqual(
      expect.arrayContaining(['lorebookRatio', 'userName']),
    )
  })
})

describe('validateSettingsPatch（类型 + 范围验证表）', () => {
  it('translationTargetLang：trim 后 1~32 字符', () => {
    expect(validateSettingsPatch({ translationTargetLang: '  英语  ' }, EMPTY_CTX).accepted.translationTargetLang).toBe('英语')
    expect(validateSettingsPatch({ translationTargetLang: '   ' }, EMPTY_CTX).rejected[0].reason).toBe('invalid_length')
    expect(validateSettingsPatch({ translationTargetLang: 'a'.repeat(33) }, EMPTY_CTX).rejected[0].reason).toBe('invalid_length')
    expect(validateSettingsPatch({ translationTargetLang: 123 }, EMPTY_CTX).rejected[0].reason).toBe('invalid_type')
  })

  it('streamOutput / showTokenCount：boolean', () => {
    expect(validateSettingsPatch({ streamOutput: true }, EMPTY_CTX).accepted.streamOutput).toBe(true)
    expect(validateSettingsPatch({ showTokenCount: 'yes' }, EMPTY_CTX).rejected[0].reason).toBe('invalid_type')
  })

  it('activeModel：空值允许；有列表时必须存在', () => {
    expect(validateSettingsPatch({ activeModel: '' }, { ...EMPTY_CTX, knownModelIds: ['gpt-4o'] }).accepted.activeModel).toBe('')
    expect(validateSettingsPatch({ activeModel: 'gpt-4o' }, { ...EMPTY_CTX, knownModelIds: ['gpt-4o'] }).accepted.activeModel).toBe('gpt-4o')
    expect(validateSettingsPatch({ activeModel: 'ghost-model' }, { ...EMPTY_CTX, knownModelIds: ['gpt-4o'] }).rejected[0].reason).toBe('unknown_model')
    // 列表不可得（离线/无 Profile）：降级为仅类型校验
    expect(validateSettingsPatch({ activeModel: 'any-model' }, EMPTY_CTX).accepted.activeModel).toBe('any-model')
  })

  it('activePresetId：null 或真实 id', () => {
    expect(validateSettingsPatch({ activePresetId: null }, EMPTY_CTX).accepted.activePresetId).toBeNull()
    expect(validateSettingsPatch({ activePresetId: 'builtin-default' }, EMPTY_CTX).accepted.activePresetId).toBe('builtin-default')
    expect(validateSettingsPatch({ activePresetId: 'ghost-preset' }, EMPTY_CTX).rejected[0].reason).toBe('unknown_preset')
  })

  it('lorebookRatio：0~1', () => {
    expect(validateSettingsPatch({ lorebookRatio: 0 }, EMPTY_CTX).accepted.lorebookRatio).toBe(0)
    expect(validateSettingsPatch({ lorebookRatio: 1 }, EMPTY_CTX).accepted.lorebookRatio).toBe(1)
    expect(validateSettingsPatch({ lorebookRatio: 1.5 }, EMPTY_CTX).rejected[0].reason).toBe('out_of_range')
    expect(validateSettingsPatch({ lorebookRatio: '0.3' }, EMPTY_CTX).rejected[0].reason).toBe('invalid_type')
  })

  it('非白名单字段（凭据/PC-only）拒绝但不影响合法字段', () => {
    const result = validateSettingsPatch(
      { apiKey: 'sk-x', connectionProfiles: [], fontSize: 12, themeColor: 'rose', streamOutput: true, userName: 'A' },
      EMPTY_CTX,
    )
    expect(result.accepted).toEqual({ streamOutput: true, userName: 'A' })
    const fields = result.rejected.map((r) => r.field)
    expect(fields).toEqual(expect.arrayContaining(['apiKey', 'connectionProfiles', 'fontSize', 'themeColor']))
    expect(result.rejected.every((r) => r.reason === 'field_not_allowed')).toBe(true)
  })

  it('叙事设置严格校验枚举与规则文本', () => {
    const accepted = validateSettingsPatch({
      defaultNarrativeMode: 'omniscient',
      omniscientNarrativeRules: '{{user}}观察世界。',
    }, EMPTY_CTX)
    expect(accepted.accepted).toEqual({
      defaultNarrativeMode: 'omniscient',
      omniscientNarrativeRules: '{{user}}观察世界。',
    })
    expect(validateSettingsPatch({ defaultNarrativeMode: 'invalid' }, EMPTY_CTX).rejected[0].reason).toBe('invalid_enum')
    expect(validateSettingsPatch({ omniscientNarrativeRules: '   ' }, EMPTY_CTX).rejected[0].reason).toBe('empty_value')
  })
})
