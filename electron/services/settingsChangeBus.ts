/**
 * 阶段 C（C-04）：设置变更事件总线。
 *
 * 背景：手机经 PATCH /settings/snapshot 可以直接 hub.broadcast，但 PC UI 自己保存
 * 设置（settings:save IPC）也必须通知手机端。本模块提供主进程内的轻量发布订阅：
 *
 *   electron/ipc/settings.ts（统一保存出口） --emit--> settingsChangeBus
 *     -> BridgeService 订阅 -> server.broadcast('settings:updated', payload)
 *
 * 防回环约定（写一次、广播一次）：
 * - `source: 'pc'` —— PC 本地保存触发，BridgeService 向 WS 广播；
 * - `source: 'android:<deviceId>'` —— 安卓 PATCH 已在桥接层广播过，BridgeService
 *   跳过再次 WS 广播，避免事件回显造成无限写循环/重复通知。
 *
 * 不使用 fs.watch 作为正确性机制（合并/丢事件风险）；对绕过统一出口的旧写路径，
 * 桥接层在 PATCH 时以磁盘当前内容重算 revision（content-addressed），天然兜底。
 */
import { createLogger } from './logger'

const log = createLogger('settings-change-bus')

export interface SettingsChanged {
  revision: string
  changedFields: string[]
  source: 'pc' | `android:${string}`
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
