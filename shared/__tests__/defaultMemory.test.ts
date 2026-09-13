import { describe, expect, it } from 'vitest'
import { DEFAULT_AUTO_MEMORY_INTERVAL, resolveDefaultGroupMemoryConfig, resolveDefaultMemoryConfig } from '../defaultMemory'

describe('defaultMemory 唯一决策表', () => {
  it('角色卡启用时优先角色参数', () => {
    expect(resolveDefaultMemoryConfig(
      { defaultMemoryEnabled: false },
      { defaultMemoryEnabled: true, defaultMemoryMode: 'manual', defaultMemoryInterval: 20 },
    )).toEqual({ memoryEnabled: true, memoryMode: 'manual', autoMemoryInterval: 20 })
  })

  it('角色卡字段缺省时用默认值', () => {
    expect(resolveDefaultMemoryConfig(
      { defaultMemoryEnabled: false },
      { defaultMemoryEnabled: true },
    )).toEqual({ memoryEnabled: true, memoryMode: 'auto', autoMemoryInterval: DEFAULT_AUTO_MEMORY_INTERVAL })
  })

  it('角色未启用但全局启用 → auto + 默认间隔', () => {
    expect(resolveDefaultMemoryConfig({ defaultMemoryEnabled: true }, { defaultMemoryEnabled: false }))
      .toEqual({ memoryEnabled: true, memoryMode: 'auto', autoMemoryInterval: DEFAULT_AUTO_MEMORY_INTERVAL })
  })

  it('两者都未启用 → 禁用', () => {
    expect(resolveDefaultMemoryConfig({ defaultMemoryEnabled: false }, null))
      .toEqual({ memoryEnabled: false, memoryMode: 'manual', autoMemoryInterval: DEFAULT_AUTO_MEMORY_INTERVAL })
  })

  it('群聊只看全局开关', () => {
    expect(resolveDefaultGroupMemoryConfig({ defaultMemoryEnabled: true }))
      .toEqual({ memoryEnabled: true, memoryMode: 'auto', autoMemoryInterval: DEFAULT_AUTO_MEMORY_INTERVAL })
    expect(resolveDefaultGroupMemoryConfig({}).memoryEnabled).toBe(false)
  })
})
