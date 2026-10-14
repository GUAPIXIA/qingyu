/**
 * 阶段 C（C-04）：设置变更事件总线。
 *
 * 背景：settings:save IPC（统一保存出口）在设置真正变化后，需要让主进程内的其它
 * 消费者知道「哪些字段变了、当前 revision 是多少」。本模块提供主进程内的轻量发布订阅：
 *
 *   electron/ipc/settings.ts（统一保存出口） --emit--> settingsChangeBus --> 订阅方
 *
 * 2026-10-14（PC／安卓解绑）：随着桥接层（`electron/bridge/`）与同步中心一并移除，
 * 原先的 `source: 'android:<deviceId>'` 来源标记（用于桥接层跳过二次广播防回环）已删除，
 * 现在只有 PC 本地保存这一种来源。
 *
 * 不使用 fs.watch 作为正确性机制（合并/丢事件风险）。
 */
import { createLogger } from './logger'

const log = createLogger('settings-change-bus')

export interface SettingsChanged {
  revision: string
  changedFields: string[]
  source: 'pc'
}

export type SettingsChangeListener = (event: SettingsChanged) => void

const listeners = new Set<SettingsChangeListener>()

/** 订阅设置变更事件，返回取消订阅函数 */
export function subscribeSettingsChanges(listener: SettingsChangeListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 发布设置变更事件（统一保存出口调用）。
 * 监听器异常隔离：单个订阅者失败不影响其他订阅者与保存主流程。
 */
export function emitSettingsChanged(event: SettingsChanged): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (e) {
      log.warn('设置变更监听器异常', { error: (e as Error).message })
    }
  }
}

/** 测试钩子：清空全部订阅 */
export function clearSettingsChangeListeners(): void {
  listeners.clear()
}
