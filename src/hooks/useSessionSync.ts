/**
 * 阶段 0c：会话变更事件总线——渲染层消费端 hook。
 *
 * 订阅主进程广播的 session:updated（来自其他窗口/未来桥接层的会话变更），
 * 做 PC 双窗口同步：
 * - 刷新会话列表（标题/删除/新消息）；
 * - 若当前窗口正打开该会话且非流式中，刷新消息（避免覆盖流式内容）。
 *
 * 验收（方案 §7 0c）：一个窗口发消息，另一个窗口收到 session:updated 并同步刷新。
 */
import { useEffect } from 'react'
import { useSettingsStore } from '../store/useSettingsStore'
import { useCharacterStore } from '../store/useCharacterStore'
import { useChatStore } from '../store/useChatStore'
import { logError } from '../lib/logger'

export function useSessionSync(): void {
  useEffect(() => {
    let disposed = false

    const unbind = window.api.sessionSync.onUpdated(({ sessionId, change }) => {
      if (disposed) return
      const settings = useSettingsStore.getState().settings
      const charId = settings.activeCharacterId
      if (!charId) return

      const chatStore = useChatStore.getState()

      // 刷新会话列表（新消息/标题/删除/新建均需更新）
      chatStore.loadSessions(charId).catch((e) => logError('SessionSync:loadSessions', e))

      // 若当前窗口正打开该会话且未在生成 → 刷新消息（双窗口同步核心）
      if (chatStore.currentSessionId === sessionId && !chatStore.isStreaming) {
        const character = useCharacterStore.getState().characters.find((c) => c.id === charId)
        if (character) {
          chatStore.loadMessages(character).catch((e) => logError('SessionSync:loadMessages', e))
        }
      }
      void change
    })

    return () => {
      disposed = true
      unbind()
    }
  }, [])
}
