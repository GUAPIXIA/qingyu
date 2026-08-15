/**
 * 阶段 0c：会话变更事件总线 middleware（方案「安卓伴侣端方案」§7 阶段 0c）。
 *
 * 设计决策：middleware 拦截而非手动 `ipcRenderer.send()`——
 * 手动方式容易遗漏新增调用点；middleware 在 store 层统一拦截，保证全覆盖。
 *
 * 拦截列表：sendMessage / editMessage / deleteMessage / renameSession /
 * swipeMessage / addStandaloneMessage / clearChat / deleteCurrentSession / deleteSession
 * （含 deleteMessage 经由会话删除的级联路径）。
 *
 * 上报通道：window.api.sessionSync.changed({ sessionId, change })
 * -> 主进程广播 session:updated（所有窗口）-> 桥接层转推 WS（阶段一）。
 */
import type { StateCreator } from 'zustand'
import type { ChatState } from './chatTypes'
import type { SessionChangePayload } from '../../shared/ipc-api'

/** 被拦截并上报的 action 清单 */
type WatchedAction = {
  key: keyof ChatState
  change: SessionChangePayload['change']
  /** 从 action 参数/返回值解析 sessionId；缺省回退 currentSessionId */
  sessionIdOf?: (...args: never[]) => string | null | undefined
}

const WATCHED: WatchedAction[] = [
  { key: 'sendMessage', change: 'message' },
  { key: 'editMessage', change: 'message' },
  { key: 'deleteMessage', change: 'message' },
  { key: 'swipeMessage', change: 'swiped' },
  { key: 'addStandaloneMessage', change: 'message' },
  { key: 'clearChat', change: 'message' },
  {
    key: 'renameSession',
    change: 'title',
    // renameSession(characterId, sessionId, title)
    sessionIdOf: ((...args: never[]) => args[1] as string | undefined),
  },
  {
    key: 'deleteSession',
    change: 'deleted',
    // deleteSession(characterId, sessionId)
    sessionIdOf: ((...args: never[]) => args[1] as string | undefined),
  },
  {
    key: 'deleteCurrentSession',
    change: 'deleted',
    sessionIdOf: (() => null), // 由 get().currentSessionId 兜底
  },
]

/** 上报（IPC 缺失/异常静默，不干扰主流程） */
function report(payload: SessionChangePayload): void {
  try {
    window.api.sessionSync.changed(payload)
  } catch {
    // 忽略：非 Electron 环境（测试）或 IPC 未就绪
  }
}

/**
 * 包装指定 action：执行原逻辑后上报会话变更。
 * 上报使用调用时点的 currentSessionId（对 sendMessage/deleteMessage 等无显式 sessionId 的 action）。
 */
export const sessionEventReporter = (
  config: StateCreator<ChatState>,
): StateCreator<ChatState> => (set, get, api) => {
  const state = config(set, get, api)

  for (const watched of WATCHED) {
    const original = state[watched.key]
    if (typeof original !== 'function') continue

    // 泛型包装：保留原签名，返回原返回值（Promise 场景由 async action 天然透传）
    ;(state as unknown as Record<string, unknown>)[watched.key] = (...args: unknown[]) => {
      const result = (original as (...a: unknown[]) => unknown).apply(state, args)
      const sessionId =
        watched.sessionIdOf?.(...(args as never[])) ?? get().currentSessionId ?? ''
      if (sessionId) {
        report({ sessionId, change: watched.change })
      }
      return result
    }
  }

  return state
}

export default sessionEventReporter
