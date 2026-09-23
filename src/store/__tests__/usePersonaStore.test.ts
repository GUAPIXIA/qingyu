/**
 * syncActivePersonaToSettings 单元测试（UEX-P1-30：人设「默认 vs 当前」双写语义统一）
 * settings 三字段是生成管线消费的快照，persona 存储是真源；只允许经此唯一入口写。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Persona } from '../../../shared/types'
import { getDefaultSettings } from '../../../shared/defaults'
import { syncActivePersonaToSettings } from '../usePersonaStore'
import { useSettingsStore } from '../useSettingsStore'

const persona: Persona = {
  id: 'persona-1',
  name: '旅行者',
  description: '来自远方',
  persona: '冷静',
  avatar: '',
  createdAt: 1,
  updatedAt: 1,
}

describe('syncActivePersonaToSettings', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        userName: '旧身份',
        userDescription: '旧描述',
        userPersona: '旧性格',
      },
      loaded: true,
      _saveTimer: null,
    })
  })

  it('激活身份：activePersonaId 与快照三字段一并同步', () => {
    syncActivePersonaToSettings(persona)
    const s = useSettingsStore.getState().settings
    expect(s.activePersonaId).toBe('persona-1')
    expect(s.userName).toBe('旅行者')
    expect(s.userDescription).toBe('来自远方')
    expect(s.userPersona).toBe('冷静')
  })

  it('空名/空描述回退默认文案，不写入空 userName', () => {
    syncActivePersonaToSettings({ ...persona, name: '', description: '', persona: '' })
    const s = useSettingsStore.getState().settings
    expect(s.userName).toBe('用户')
    expect(s.userDescription).toBe('')
    expect(s.userPersona).toBe('')
  })

  it('传 null 复位为空身份快照（清空双写残留）', () => {
    syncActivePersonaToSettings(null)
    const s = useSettingsStore.getState().settings
    expect(s.activePersonaId).toBeNull()
    expect(s.userName).toBe('用户')
    expect(s.userDescription).toBe('')
    expect(s.userPersona).toBe('')
  })

  it('不改字段结构：只写 activePersonaId + userName/userDescription/userPersona 四个既有字段', () => {
    const before = useSettingsStore.getState().settings
    syncActivePersonaToSettings(persona)
    const after = useSettingsStore.getState().settings
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
  })
})
