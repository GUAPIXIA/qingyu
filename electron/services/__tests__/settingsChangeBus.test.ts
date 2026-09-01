/**
 * 阶段 C-04：设置变更事件总线单测 + 桥接防回环判定。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  subscribeSettingsChanges,
  emitSettingsChanged,
  clearSettingsChangeListeners,
  type SettingsChanged,
} from '../../services/settingsChangeBus'
import { shouldBroadcastSettingsToWs } from '../../bridge/index'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-changebus-test' },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}))

describe('settingsChangeBus', () => {
  it('订阅者收到事件；取消订阅后不再收到', () => {
    const received: SettingsChanged[] = []
    const unsubscribe = subscribeSettingsChanges((e) => received.push(e))
    emitSettingsChanged({ revision: 'r1', changedFields: ['userName'], source: 'pc' })
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ revision: 'r1', changedFields: ['userName'], source: 'pc' })

    unsubscribe()
    emitSettingsChanged({ revision: 'r2', changedFields: ['streamOutput'], source: 'pc' })
    expect(received).toHaveLength(1)
    clearSettingsChangeListeners()
  })

  it('android: 来源事件照常分发（由订阅侧决定不回环）', () => {
    const received: SettingsChanged[] = []
    const unsubscribe = subscribeSettingsChanges((e) => received.push(e))
    emitSettingsChanged({ revision: 'r3', changedFields: ['userName'], source: 'android:dev-1' })
    expect(received[0].source).toBe('android:dev-1')
    unsubscribe()
    clearSettingsChangeListeners()
  })

  it('单个监听器异常不影响其他监听器', () => {
    const received: SettingsChanged[] = []
    const unsubBad = subscribeSettingsChanges(() => { throw new Error('boom') })
    const unsubGood = subscribeSettingsChanges((e) => received.push(e))
    expect(() => emitSettingsChanged({ revision: 'r4', changedFields: [], source: 'pc' })).not.toThrow()
    expect(received).toHaveLength(1)
    unsubBad()
    unsubGood()
    clearSettingsChangeListeners()
  })
})

describe('防回环判定（shouldBroadcastSettingsToWs）', () => {
  it("source='pc' 转发 WS；android:* 来源跳过（写一次、广播一次）", () => {
    expect(shouldBroadcastSettingsToWs('pc')).toBe(true)
    expect(shouldBroadcastSettingsToWs('android:dev-1')).toBe(false)
  })
})
